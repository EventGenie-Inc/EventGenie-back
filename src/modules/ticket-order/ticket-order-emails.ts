import prisma from '../../shared/prisma/prisma.client.js';
import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, sendEmail, sendEmailAttempt } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate, formatGuestTime } from '../../shared/utils/guest-date.util.js';
import { buildOrderToken } from '../check-in-pass/check-in-pass-token.util.js';
import { paymentAccountRepository } from '../payment-account/payment-account.repository.js';
import { paymentAlertRecipient } from '../payment-alert/payment-alert.service.js';
import { ticketOrderRepository, type OrderRow } from './ticket-order.repository.js';
import { admittedDaysOf, ticketLabel, ticketPayloadOf } from './ticket-order-view.js';
import { buildTicketsPdf } from './ticket-pdf.util.js';

// ─────────────────────────────────────────
//  TICKET ORDER EMAILS (ticket sales Round B)
//
//  To the buyer: their tickets once the order is confirmed (one email, a PDF
//  with a page per ticket, a link to the order with its token in the
//  fragment), and a cancellation notice. To the organisation's Tenant
//  Admins (and e-velope's payments address): an oversell, a refund, a
//  chargeback. Sent after the database work has committed and never
//  failing it. Never the order token in a log, never a QR payload.
// ─────────────────────────────────────────

const loadEvent = (eventId: string) =>
  prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { id: true, name: true, hostName: true, tenantId: true, eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' } } },
  });

type EventRow = Awaited<ReturnType<typeof loadEvent>>;

const fromHeader = (event: EventRow): string => formatFromHeader(event.hostName ?? event.name, eventSenderAddress());

const whenText = (d: { date: Date; startTime: Date | null; endTime: Date | null }): string => {
  const start = d.startTime ? formatGuestTime(d.startTime) : null;
  const end = d.endTime ? formatGuestTime(d.endTime) : null;
  const time = start && end ? `${start} to ${end}` : start;
  return time ? `${formatGuestDate(d.date)} · ${time}` : formatGuestDate(d.date);
};

// The order link: the token in the fragment, which no server ever receives.
export const orderLink = (orderId: string): string => frontendUrl(`/tickets/order#token=${buildOrderToken(orderId)}`);

const organisationAdmins = async (tenantId: string): Promise<string[]> => paymentAccountRepository.findTenantAdminEmails(tenantId);

const sendQuietly = async (label: string, email: Parameters<typeof sendEmail>[0]): Promise<boolean> => {
  try {
    const result = await sendEmail(email);
    if (!result.ok) console.error(`[ticket-order] email "${label}" not sent: ${result.reason}`);
    return result.ok;
  } catch (err) {
    console.error(`[ticket-order] email "${label}" not sent:`, err instanceof Error ? err.message : err);
    return false;
  }
};

// To the organisation's admins, and (when asked) e-velope's payments address.
const notifyOrganisation = async (
  event: EventRow,
  input: { subject: string; title: string; lines: string[]; facts: string[]; alsoPayments?: boolean }
): Promise<void> => {
  const recipients = [...(await organisationAdmins(event.tenantId)), ...(input.alsoPayments ? [paymentAlertRecipient()] : [])];
  const { html, text } = renderEmail({
    subject: input.subject,
    preheader: input.lines[0] ?? input.title,
    blocks: [
      { kind: 'eyebrow', text: 'Ticket sales' },
      { kind: 'title', text: input.title },
      ...input.lines.map((line) => ({ kind: 'paragraph' as const, text: line })),
      { kind: 'details', groups: [{ heading: null, lines: input.facts }] },
      { kind: 'button', label: 'Open ticket sales', href: frontendUrl(`/events/${event.id}/tickets`) },
    ],
    reason: "You received this because you're an admin of an organisation that sells tickets with e-velope.",
  });
  for (const to of recipients) {
    await sendQuietly(input.subject, { to, from: formatFromHeader('e-velope ticket sales', eventSenderAddress()), subject: input.subject, html, text });
  }
};

const ticketsFor = (order: OrderRow, event: EventRow) =>
  order.tickets.map((t) => {
    const item = order.items.find((i) => i.id === t.orderItemId)!;
    const days = admittedDaysOf(item, event.eventDays);
    return { ticket: t, item, days, payload: ticketPayloadOf(t, days), label: ticketLabel(t.indexInOrder, order.tickets.length) };
  });

export const ticketOrderEmails = {
  // The buyer's tickets, once per order: claimed before it is sent (a
  // conditional update), and sent with Resend's idempotency key, so a
  // webhook and a verify arriving together, or a retry, send it once.
  sendConfirmation: async (orderId: string, now: Date = new Date()): Promise<boolean> => {
    if (!(await ticketOrderRepository.claimConfirmationEmail(orderId, now))) return false;
    try {
      const order = (await ticketOrderRepository.findById(orderId))!;
      const event = await loadEvent(order.eventId);
      const tickets = ticketsFor(order, event).filter((t) => t.ticket.status === 'VALID');
      const admitted = event.eventDays.filter((d) => tickets.some((t) => t.days.some((a) => a.id === d.id)));
      const pdf = await buildTicketsPdf({
        eventName: event.name,
        hostName: event.hostName,
        buyerName: order.buyerName,
        tickets: tickets.map((t) => ({
          number: t.ticket.number,
          typeName: t.item.typeName,
          label: t.label,
          payload: t.payload,
          days: t.days.map((d) => ({
            label: d.label,
            date: d.date,
            startTime: d.startTime,
            endTime: d.endTime,
            online: d.locationType === 'ONLINE',
            location: d.location,
            address: d.address,
          })),
        })),
      });
      const subject = `Your tickets for ${event.name}`;
      const { html, text } = renderEmail({
        subject,
        preheader: `${tickets.length} ${tickets.length === 1 ? 'ticket' : 'tickets'}, attached as a PDF.`,
        blocks: [
          { kind: 'eyebrow', text: 'Your tickets' },
          { kind: 'title', text: event.name },
          {
            kind: 'paragraph',
            text: `Thanks, ${order.buyerName}. Your ${tickets.length === 1 ? 'ticket is' : `${tickets.length} tickets are`} attached as a PDF, one page each with its own code. Forward a ticket to whoever will use it: each code admits one person.`,
          },
          {
            kind: 'details',
            groups: admitted.map((d) => ({
              heading: admitted.length > 1 ? d.label : null,
              lines: [
                whenText(d),
                ...(d.locationType === 'ONLINE' ? ['Online', d.onlineUrl ?? ''] : [d.location ?? '', d.address ?? '']),
              ].filter((l) => l),
            })),
          },
          { kind: 'details', groups: [{ heading: 'Tickets', lines: tickets.map((t) => `${t.ticket.number} · ${t.item.typeName} · ${t.label}`) }] },
          { kind: 'button', label: 'View your order', href: orderLink(order.id) },
        ],
        reason: 'You received this because you bought tickets with this email address.',
      });
      const result = await sendEmailAttempt(
        {
          to: order.buyerEmail,
          from: fromHeader(event),
          subject,
          html,
          text,
          attachments: [{ filename: 'tickets.pdf', contentType: 'application/pdf', content: pdf }],
        },
        `ticket-order/${order.id}`
      );
      await ticketOrderRepository.markConfirmationEmail(orderId, result.ok);
      if (!result.ok) console.error(`[ticket-order] confirmation for order ${orderId} not sent: ${result.reason}`);
      return result.ok;
    } catch (err) {
      console.error(`[ticket-order] confirmation for order ${orderId} not sent:`, err instanceof Error ? err.message : err);
      await ticketOrderRepository.markConfirmationEmail(orderId, false).catch(() => undefined);
      return false;
    }
  },

  // The organiser cancelled some of the buyer's tickets: which, and why, and
  // that the organiser handles any refund.
  cancelled: async (orderId: string, ticketIds: string[], reason: string): Promise<boolean> => {
    const order = (await ticketOrderRepository.findById(orderId))!;
    const event = await loadEvent(order.eventId);
    const cancelled = ticketsFor(order, event).filter((t) => ticketIds.includes(t.ticket.id));
    const subject = `${cancelled.length === 1 ? 'A ticket' : 'Tickets'} for ${event.name} cancelled`;
    const { html, text } = renderEmail({
      subject,
      preheader: 'The organiser cancelled these tickets.',
      blocks: [
        { kind: 'eyebrow', text: 'Tickets cancelled' },
        { kind: 'title', text: event.name },
        { kind: 'paragraph', text: `The organiser cancelled ${cancelled.length === 1 ? 'this ticket' : 'these tickets'}, so ${cancelled.length === 1 ? 'its code no longer works' : 'their codes no longer work'}:` },
        { kind: 'details', groups: [{ heading: null, lines: cancelled.map((t) => `${t.ticket.number} · ${t.item.typeName} · ${t.label}`) }] },
        { kind: 'message', text: reason },
        { kind: 'paragraph', text: 'Any refund is handled by the organiser: contact them about it. e-velope does not refund tickets.' },
      ],
      reason: 'You received this because you bought tickets with this email address.',
    });
    return sendQuietly(subject, { to: order.buyerEmail, from: fromHeader(event), subject, html, text });
  },

  // `daysOver`: the labels of the days the order took past their venue
  // capacity (empty when only a type's quantity was oversold).
  oversold: async (orderId: string, daysOver: string[] = []): Promise<void> => {
    const order = (await ticketOrderRepository.findById(orderId))!;
    const event = await loadEvent(order.eventId);
    await notifyOrganisation(event, {
      subject: `More tickets sold than available for ${event.name}`,
      title: 'An order was paid after its tickets had sold out',
      lines: [
        "A buyer paid after their 30-minute hold had run out, and the tickets had sold out meanwhile. They have paid, so their tickets were issued: more tickets are now sold than you made available.",
        ...(daysOver.length > 0 ? [`More people now have places on ${daysOver.join(', ')} than the venue holds.`] : []),
        'Make room for them, or cancel the tickets and refund the buyer yourself.',
      ],
      facts: [`Buyer: ${order.buyerName}`, ...order.items.map((i) => `${i.quantity} × ${i.typeName}`)],
      alsoPayments: true,
    });
  },

  // A refund or a chargeback on an order: the organisation is told what
  // happened to the tickets.
  organisationNotice: async (orderId: string, kind: 'REFUNDED_FULL' | 'REFUNDED_PARTIAL' | 'DISPUTE_OPENED' | 'DISPUTE_LOST' | 'DISPUTE_WON'): Promise<void> => {
    const order = (await ticketOrderRepository.findById(orderId))!;
    const event = await loadEvent(order.eventId);
    const facts = [`Buyer: ${order.buyerName}`, ...order.items.map((i) => `${i.quantity} × ${i.typeName}`), ...order.tickets.map((t) => `${t.number}: ${t.status.toLowerCase()}`)];
    const copy: Record<typeof kind, { subject: string; title: string; lines: string[] }> = {
      REFUNDED_FULL: {
        subject: `Tickets refunded for ${event.name}`,
        title: 'An order was refunded in full',
        lines: ['The payment was refunded through our payment provider, so its tickets were cancelled and their places freed.'],
      },
      REFUNDED_PARTIAL: {
        subject: `Part of a ticket order refunded for ${event.name}`,
        title: 'Part of an order was refunded',
        lines: ["Part of the payment was refunded. No tickets were cancelled automatically: e-velope's team will cancel the right ones."],
      },
      DISPUTE_OPENED: {
        subject: `A chargeback on a ticket order for ${event.name}`,
        title: "A buyer's bank disputed a ticket payment",
        lines: [
          'The tickets stay valid for now. Under the Terms of Service you are responsible for responding to a chargeback on your tickets.',
          "e-velope's team will contact you for the proof needed.",
        ],
      },
      DISPUTE_LOST: {
        subject: `A chargeback was lost on a ticket order for ${event.name}`,
        title: 'A chargeback was lost',
        lines: ["The buyer's bank decided against the payment, so its tickets were cancelled and their places freed."],
      },
      DISPUTE_WON: {
        subject: `A chargeback was won on a ticket order for ${event.name}`,
        title: 'A chargeback was won',
        lines: ['The bank decided in your favour. The tickets stay valid.'],
      },
    };
    await notifyOrganisation(event, { ...copy[kind], facts });
  },
};
