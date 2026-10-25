import ExcelJS from 'exceljs';

interface TemplateEvent {
  id: string;
  name: string;
}

interface TemplateEventDay {
  id: string;
  label: string;
  date: Date;
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// Generates a downloadable .xlsx import template specific to one event —
// the Day column's valid values are that event's actual EventDay labels,
// not a generic placeholder. For a single-day event, the Day column is
// pre-filled in the examples and the "Valid Days" reference sheet is
// omitted (redundant with one value).
//
// emailOnly is set while the sms feature is off: import then refuses
// phone-only rows (guest-import.engine.ts), so the template asks for an
// email for every guest and its examples use only email addresses. A
// phone example left in would be a row the import refuses.
export const buildImportTemplateWorkbook = async (
  event: TemplateEvent,
  eventDays: TemplateEventDay[],
  options: { emailOnly?: boolean } = {}
): Promise<{ buffer: Buffer; filename: string }> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Guests');

  sheet.columns = [
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Surname', key: 'surname', width: 20 },
    { header: 'Contact', key: 'contact', width: 32 },
    { header: 'Day', key: 'day', width: 20 },
    { header: 'Plus-Ones Allowed', key: 'plusOnesAllowed', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  const singleDayLabel = eventDays.length === 1 ? eventDays[0]!.label : undefined;
  const exampleDay = (preferred: string | undefined): string => singleDayLabel ?? preferred ?? '';

  const emailOnly = options.emailOnly === true;
  const exampleRows: { firstName: string; surname: string; contact: string; day: string; plusOnesAllowed: number }[] = [
    { firstName: 'John', surname: 'Smith', contact: 'john.smith@example.com', day: exampleDay(eventDays[0]?.label), plusOnesAllowed: 1 },
    { firstName: 'Jane', surname: 'Doe', contact: emailOnly ? 'jane.doe@example.com' : '+27821234567', day: exampleDay(eventDays[1]?.label ?? eventDays[0]?.label), plusOnesAllowed: 0 },
    { firstName: '', surname: '', contact: emailOnly ? 'guest@example.com' : '+27831234567', day: exampleDay(eventDays[0]?.label), plusOnesAllowed: 0 },
  ];

  for (const example of exampleRows) {
    const row = sheet.addRow(example);
    row.font = { italic: true, color: { argb: 'FF808080' } };
  }

  // The notes go on their own sheet, never in cell comments: a comment
  // re-saved by another spreadsheet app can come back in a layout exceljs
  // can't load (guest-import.engine.ts strips them for that reason), and a
  // notes row under the header would be imported as a guest. The import
  // reads only the first sheet, so this one is never read.
  const instructions = workbook.addWorksheet('Instructions');
  instructions.columns = [
    { header: 'Column', key: 'column', width: 20 },
    { header: 'What to enter', key: 'note', width: 100 },
  ];
  instructions.getRow(1).font = { bold: true };
  const columnNotes: { column: string; note: string }[] = [
    {
      column: 'First Name, Surname',
      note: 'May be left blank; the guest can supply their name later when they RSVP.',
    },
    {
      column: 'Contact',
      note: emailOnly
        ? "Enter one email address per guest. Every guest needs an email address: text messages aren't available yet."
        : 'Enter one email OR one phone number (e.g. +27 82 123 4567) per guest, not both.',
    },
    {
      column: 'Day',
      note:
        eventDays.length >= 2
          ? "Must match one of this event's day labels exactly. See the \"Valid Days\" sheet."
          : singleDayLabel
            ? `This event has only one day ("${singleDayLabel}"), so you may leave this column blank.`
            : '',
    },
    {
      column: 'Plus-Ones Allowed',
      note:
        'Optional: leave blank for 0. The number of extra guests (plus-ones) this person may bring, ' +
        'declared by name when they RSVP.',
    },
    {
      column: '',
      note: 'Fill in the "Guests" sheet only, replacing the grey example rows. Only that sheet is imported.',
    },
  ];
  for (const n of columnNotes.filter((c) => c.note)) {
    instructions.addRow(n).alignment = { wrapText: true, vertical: 'top' };
  }

  if (eventDays.length >= 2) {
    const daysSheet = workbook.addWorksheet('Valid Days');
    daysSheet.columns = [
      { header: 'Day Label', key: 'label', width: 25 },
      { header: 'Date', key: 'date', width: 15 },
    ];
    daysSheet.getRow(1).font = { bold: true };
    for (const day of eventDays) {
      daysSheet.addRow({ label: day.label, date: day.date.toISOString().slice(0, 10) });
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  const filename = `guest-import-template-${slugify(event.name) || event.id}.xlsx`;

  return { buffer, filename };
};
