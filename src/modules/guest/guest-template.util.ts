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
export const buildImportTemplateWorkbook = async (
  event: TemplateEvent,
  eventDays: TemplateEventDay[]
): Promise<{ buffer: Buffer; filename: string }> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Guests');

  sheet.columns = [
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Surname', key: 'surname', width: 20 },
    { header: 'Contact', key: 'contact', width: 32 },
    { header: 'Day', key: 'day', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };

  const singleDayLabel = eventDays.length === 1 ? eventDays[0]!.label : undefined;
  const exampleDay = (preferred: string | undefined): string => singleDayLabel ?? preferred ?? '';

  const exampleRows: { firstName: string; surname: string; contact: string; day: string }[] = [
    { firstName: 'John', surname: 'Smith', contact: 'john.smith@example.com', day: exampleDay(eventDays[0]?.label) },
    { firstName: 'Jane', surname: 'Doe', contact: '+27821234567', day: exampleDay(eventDays[1]?.label ?? eventDays[0]?.label) },
    { firstName: '', surname: '', contact: '+27831234567', day: exampleDay(eventDays[0]?.label) },
  ];

  for (const example of exampleRows) {
    const row = sheet.addRow(example);
    row.font = { italic: true, color: { argb: 'FF808080' } };
  }

  sheet.getCell('C1').note =
    'Enter one email OR one phone number (E.164, e.g. +27821234567) per guest — not both. ' +
    'First Name and Surname may be left blank; the guest can supply their name later when they RSVP.';

  if (eventDays.length >= 2) {
    sheet.getCell('D1').note = "Must match one of this event's day labels exactly — see the \"Valid Days\" sheet.";

    const daysSheet = workbook.addWorksheet('Valid Days');
    daysSheet.columns = [
      { header: 'Day Label', key: 'label', width: 25 },
      { header: 'Date', key: 'date', width: 15 },
    ];
    daysSheet.getRow(1).font = { bold: true };
    for (const day of eventDays) {
      daysSheet.addRow({ label: day.label, date: day.date.toISOString().slice(0, 10) });
    }
  } else if (singleDayLabel) {
    sheet.getCell('D1').note = `This event has only one day ("${singleDayLabel}") — you may leave this column blank.`;
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  const filename = `guest-import-template-${slugify(event.name) || event.id}.xlsx`;

  return { buffer, filename };
};
