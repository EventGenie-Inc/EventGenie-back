import ExcelJS from 'exceljs';

interface TemplateEvent {
  id: string;
  name: string;
}

interface ExportEventDay {
  id: string;
  label: string;
}

interface ExportRsvpField {
  id: string;
  label: string;
}

interface ExportInvite {
  status: string;
  inviteEventDay: { eventDay: { id: string; label: string } }[];
  attendances: { eventDayId: string }[];
  rsvpResponses: { rsvpFieldId: string; value: string }[];
}

export interface ExportGuest {
  id: string;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  hostGuestId: string | null;
  hostGuest: { firstName: string | null; surname: string | null } | null;
  invites: ExportInvite[];
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const displayName = (guest: { firstName: string | null; surname: string | null }): string =>
  [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';

// Guests come back in one flat, non-archived list (primaries and their
// plus-ones interleaved by creation time). For an export a caterer scans
// for seating, a plus-one belongs directly under the host they're
// attached to, not wherever they happen to fall by timestamp — so this
// re-groups into [primary, primary's plus-ones..., primary, ...] before
// any row is built.
const groupByHost = (guests: ExportGuest[]): ExportGuest[] => {
  const primaries = guests.filter((g) => !g.hostGuestId);
  const plusOnesByHost = new Map<string, ExportGuest[]>();
  for (const guest of guests) {
    if (!guest.hostGuestId) continue;
    const list = plusOnesByHost.get(guest.hostGuestId) ?? [];
    list.push(guest);
    plusOnesByHost.set(guest.hostGuestId, list);
  }
  return primaries.flatMap((host) => [host, ...(plusOnesByHost.get(host.id) ?? [])]);
};

// Generates the guest-list export as a downloadable .xlsx, event-specific
// like the import template: one column per this event's OWN days, and
// one per this event's OWN custom RSVP fields — built fresh per call
// since both can change between exports.
export const buildGuestExportWorkbook = async (
  event: TemplateEvent,
  eventDays: ExportEventDay[],
  rsvpFields: ExportRsvpField[],
  guests: ExportGuest[]
): Promise<{ buffer: Buffer; filename: string }> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Guests');

  const dayColumns = eventDays.map((day) => ({ header: day.label, key: `day_${day.id}`, width: 16 }));
  const fieldColumns = rsvpFields.map((field) => ({ header: field.label, key: `field_${field.id}`, width: 24 }));

  sheet.columns = [
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Surname', key: 'surname', width: 20 },
    { header: 'Contact', key: 'contact', width: 32 },
    { header: 'Invited Days', key: 'invitedDays', width: 28 },
    { header: 'Invite Status', key: 'inviteStatus', width: 16 },
    ...dayColumns,
    ...fieldColumns,
    { header: 'Plus-One Of', key: 'plusOneOf', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };

  // Known limitation, called out where an organiser will actually see it:
  // plus-ones have no custom RSVP field answers of their own (v1 captures
  // name only), so every field column is blank on their rows — this is
  // expected, not a fallback to invent.
  const lastFieldColumnLetter = fieldColumns.length > 0
    ? sheet.getColumn(fieldColumns[fieldColumns.length - 1]!.key).letter
    : null;
  if (lastFieldColumnLetter) {
    sheet.getCell(`${lastFieldColumnLetter}1`).note =
      "Plus-ones have no answers of their own for these fields — v1 captures their name only. " +
      "The organiser handles anything field-specific (e.g. dietary) by asking directly.";
  }

  for (const guest of groupByHost(guests)) {
    const invite = guest.invites[0] ?? null;
    const attendedDayIds = new Set((invite?.attendances ?? []).map((a) => a.eventDayId));
    const invitedDayLabels = (invite?.inviteEventDay ?? []).map((d) => d.eventDay.label);
    const responseByField = new Map((invite?.rsvpResponses ?? []).map((r) => [r.rsvpFieldId, r.value]));

    const row: Record<string, string> = {
      firstName: guest.firstName ?? '',
      surname: guest.surname ?? '',
      contact: guest.email ?? guest.phoneNumber ?? '',
      invitedDays: invitedDayLabels.join(', '),
      inviteStatus: invite?.status ?? '',
      plusOneOf: guest.hostGuest ? displayName(guest.hostGuest) : '',
    };
    for (const day of eventDays) {
      row[`day_${day.id}`] = attendedDayIds.has(day.id) ? 'Yes' : '';
    }
    for (const field of rsvpFields) {
      row[`field_${field.id}`] = responseByField.get(field.id) ?? '';
    }

    sheet.addRow(row);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  const filename = `guest-export-${slugify(event.name) || event.id}.xlsx`;

  return { buffer, filename };
};
