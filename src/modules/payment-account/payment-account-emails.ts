import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, sendEmail, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { paymentAlertRecipient } from '../payment-alert/payment-alert.service.js';
import { paymentAccountRepository } from './payment-account.repository.js';

// ─────────────────────────────────────────
//  PAYOUT ACCOUNT EMAILS
//
//  To the organisation's Tenant Admins and to e-velope's payments address
//  (PAYMENTS_ALERT_EMAIL, the super admin's), for every step: the first
//  account set up, a change asked for (with the cancel link, to the
//  organisation's admins only), a change switched to, cancelled or failed.
//
//  The bank, the last 4 digits and the holder's name: never the account
//  number. Sent after the change is saved and never failing it: an email
//  that can't be sent is logged, and the change stands (the app shows it).
// ─────────────────────────────────────────

export interface PayoutEmailChange {
  id: string;
  tenantId: string;
  bankName: string;
  accountNumberLast4: string;
  accountHolderName: string;
  effectiveAt: Date;
}

const PAYOUT_SETTINGS_PATH = '/settings/payouts';

// An instant (not an event's date), so in South African time, date and time.
const formatWhen = (date: Date): string => {
  const zone = { timeZone: 'Africa/Johannesburg' } as const;
  const day = date.toLocaleDateString('en-ZA', { ...zone, year: 'numeric', month: 'long', day: 'numeric' });
  const time = date.toLocaleTimeString('en-ZA', { ...zone, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${time} (South African time)`;
};

const accountLines = (c: PayoutEmailChange): string[] => [
  `Bank: ${c.bankName}`,
  `Account ending: ${c.accountNumberLast4}`,
  `Account holder: ${c.accountHolderName}`,
];

interface PayoutEmailContent {
  subject: string;
  title: string;
  lines: string[];
  facts: string[];
  // The organisation's admins only: the cancel link.
  cancelUrl?: string;
}

const build = (to: string, content: PayoutEmailContent, forAdmins: boolean): OutgoingEmail => {
  const { html, text } = renderEmail({
    subject: content.subject,
    preheader: content.lines[0] ?? content.title,
    blocks: [
      { kind: 'eyebrow', text: 'Payout account' },
      { kind: 'title', text: content.title },
      ...content.lines.map((line) => ({ kind: 'paragraph' as const, text: line })),
      { kind: 'details', groups: [{ heading: null, lines: content.facts }] },
      ...(forAdmins && content.cancelUrl
        ? [
            { kind: 'button' as const, label: 'Cancel this change', href: content.cancelUrl },
            { kind: 'paragraph' as const, text: "The link works once, until the change takes effect. You don't need to sign in to use it.", muted: true },
          ]
        : [{ kind: 'button' as const, label: 'Open payout settings', href: frontendUrl(PAYOUT_SETTINGS_PATH) }]),
    ],
    reason: forAdmins
      ? "You received this because you're an admin of an organisation that sells tickets with e-velope."
      : 'You received this because this address receives e-velope payment alerts.',
  });
  return { to, from: formatFromHeader('e-velope payments', eventSenderAddress()), subject: content.subject, html, text };
};

// Sends to the organisation's admins (with the cancel link, if any) and to
// the payments address (without it). Never throws.
const sendToAll = async (tenantId: string, content: PayoutEmailContent, organisationName: string): Promise<void> => {
  try {
    const admins = await paymentAccountRepository.findTenantAdminEmails(tenantId);
    const emails = [
      ...admins.map((to) => build(to, content, true)),
      build(paymentAlertRecipient(), { ...content, lines: [`Organisation: ${organisationName} (${tenantId}).`, ...content.lines] }, false),
    ];
    for (const email of emails) {
      const result = await sendEmail(email);
      if (!result.ok) console.error(`[payment-account] email "${content.subject}" not sent: ${result.reason}`);
    }
  } catch (err) {
    console.error(`[payment-account] email "${content.subject}" not sent:`, err instanceof Error ? err.message : err);
  }
};

export const payoutEmails = {
  setUp: (change: PayoutEmailChange, organisationName: string) =>
    sendToAll(
      change.tenantId,
      {
        subject: 'Your payout account is set up',
        title: 'Your payout account is set up',
        lines: ['Ticket sales are now paid into this account.', "If you didn't set this up, contact us at admin@e-velope.co.za straight away."],
        facts: accountLines(change),
      },
      organisationName
    ),

  changeRequested: (change: PayoutEmailChange, organisationName: string, cancelToken: string) =>
    sendToAll(
      change.tenantId,
      {
        subject: 'Your payout account is changing in 24 hours',
        title: 'Your payout account is changing',
        lines: [
          `From ${formatWhen(change.effectiveAt)}, ticket sales will be paid into the account below. Until then they're paid into your current account.`,
          "If you didn't ask for this, cancel it now and contact us at admin@e-velope.co.za.",
        ],
        facts: [...accountLines(change), `Takes effect: ${formatWhen(change.effectiveAt)}`],
        // The token is in the fragment, never the path or the query: a
        // fragment isn't sent to any server, so it stays out of every log.
        cancelUrl: frontendUrl(`/payout-account/cancel-change#token=${cancelToken}`),
      },
      organisationName
    ),

  changeApplied: (change: PayoutEmailChange, organisationName: string) =>
    sendToAll(
      change.tenantId,
      {
        subject: 'Your new payout account is now in use',
        title: 'Your new payout account is now in use',
        lines: ['Ticket sales are now paid into the account below.'],
        facts: accountLines(change),
      },
      organisationName
    ),

  changeCancelled: (change: PayoutEmailChange, organisationName: string, via: 'APP' | 'EMAIL_LINK') =>
    sendToAll(
      change.tenantId,
      {
        subject: 'Your payout account change was cancelled',
        title: 'The payout account change was cancelled',
        lines: [
          via === 'EMAIL_LINK' ? 'It was cancelled with the link in our email.' : 'It was cancelled in e-velope.',
          'Ticket sales keep being paid into your current account.',
        ],
        facts: accountLines(change),
      },
      organisationName
    ),

  changeFailed: (change: PayoutEmailChange, organisationName: string) =>
    sendToAll(
      change.tenantId,
      {
        subject: "Your payout account change didn't go through",
        title: "The payout account change didn't go through",
        lines: [
          "We couldn't confirm the new account with our payment provider, so nothing changed: ticket sales keep being paid into your current account.",
          'If you still want to change it, enter the new bank details again.',
        ],
        facts: accountLines(change),
      },
      organisationName
    ),
};
