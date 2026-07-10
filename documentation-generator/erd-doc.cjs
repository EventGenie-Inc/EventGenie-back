const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  LevelFormat, PageBreak
} = require('docx');
const fs = require('fs');

const C = {
  dark: '1A1A2E', mid: '2D2D44', muted: '6B6B80', gold: 'C6A43A',
  green: '4A6741', white: 'FFFFFF', light: 'F7F5F0', red: 'C0392B',
  blue: '2471A3', orange: 'D35400', teal: '148F77', purple: '7D3C98',
  border: 'E0DDD6'
};

const spacer = (n = 1) => new Paragraph({ children: [new TextRun('')], spacing: { after: 60 * n } });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

const h1 = (text) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 52, font: 'Arial', color: C.dark })],
  spacing: { before: 480, after: 200 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: C.gold, space: 2 } }
});

const h2 = (text) => new Paragraph({
  children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 24, font: 'Arial', color: C.gold, characterSpacing: 60 })],
  spacing: { before: 400, after: 160 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.gold, space: 1 } }
});

const h3 = (text, color = C.dark) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 26, font: 'Arial', color })],
  spacing: { before: 280, after: 100 }
});

const body = (text, opts = {}) => new Paragraph({
  children: [new TextRun({ text, size: 20, font: 'Arial', color: opts.color || C.mid, bold: opts.bold || false, italics: opts.italic || false })],
  spacing: { after: opts.after || 100 }
});

const tableHeader = (cols, widths) => new TableRow({
  tableHeader: true,
  children: cols.map((col, i) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: C.dark },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: col, bold: true, size: 19, font: 'Arial', color: C.white })] })]
  }))
});

const entityTable = (entity, color, fields) => {
  const widths = [2200, 1800, 900, 4460];
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      // Entity name header
      new TableRow({
        children: [new TableCell({
          columnSpan: 4,
          shading: { type: ShadingType.CLEAR, fill: color },
          margins: { top: 120, bottom: 120, left: 200, right: 200 },
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: entity, bold: true, size: 26, font: 'Arial', color: C.white })]
          })]
        })]
      }),
      // Column headers
      tableHeader(['Field', 'Type', 'Nullable', 'Notes'], widths),
      // Field rows
      ...fields.map(([field, type, nullable, notes], idx) => new TableRow({
        children: [
          new TableCell({ width: { size: widths[0], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: field, size: 18, font: 'Courier New', color: field === 'id' ? C.red : field.endsWith('Id') ? C.orange : C.green })] })] }),
          new TableCell({ width: { size: widths[1], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: type, size: 18, font: 'Arial', color: C.blue })] })] }),
          new TableCell({ width: { size: widths[2], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: nullable, size: 18, font: 'Arial', color: nullable === 'Yes' ? C.muted : C.red })] })] }),
          new TableCell({ width: { size: widths[3], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: notes, size: 18, font: 'Arial', color: C.mid })] })] })
        ]
      }))
    ]
  });
};

const relRow = (from, rel, to, notes) => new TableRow({
  children: [
    new TableCell({ width: { size: 2200, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: from, size: 18, font: 'Courier New', color: C.dark, bold: true })] })] }),
    new TableCell({ width: { size: 1800, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: rel, size: 18, font: 'Arial', color: C.purple, bold: true })] })] }),
    new TableCell({ width: { size: 2200, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: to, size: 18, font: 'Courier New', color: C.dark, bold: true })] })] }),
    new TableCell({ width: { size: 3160, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: notes, size: 18, font: 'Arial', color: C.muted })] })] })
  ]
});

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
    children: [

      // ── COVER ──
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1440, after: 120 }, children: [new TextRun({ text: 'EventGenie', bold: true, size: 80, font: 'Arial', color: C.dark })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Entity Relationship Documentation', size: 30, font: 'Arial', color: C.gold, italics: true })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Database: PostgreSQL via Neon  ·  ORM: Prisma  ·  Version 1.0', size: 20, font: 'Arial', color: C.muted })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 480 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.gold, space: 1 } }, children: [new TextRun('')] }),

      // ── OVERVIEW ──
      h1('Overview'),
      body('EventGenie uses a relational PostgreSQL database managed through Prisma ORM. All entities use CUID primary keys. Soft deletion is implemented via an isArchived flag on all deletable entities — records are never physically removed from the database.'),
      spacer(),
      body('The database is hosted on Neon (neon.tech) with two databases:'),
      spacer(),
      body('  eventgenie_dev   — Development environment', { color: C.blue }),
      body('  eventgenie_prod  — Production environment', { color: C.green }),
      spacer(2),

      // ── KEY CONVENTIONS ──
      h2('Conventions'),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2500, 6860],
        rows: [
          tableHeader(['Convention', 'Description'], [2500, 6860]),
          ...[
            ['Primary Key', 'All entities use CUID (@default(cuid())) — collision-resistant, URL-safe, sortable'],
            ['Soft Delete', 'isArchived: Boolean — set to true instead of deleting. All queries filter isArchived = false'],
            ['Audit Fields', 'createdBy, updatedBy store the User ID of who made the change (on applicable entities)'],
            ['Timestamps', 'createdAt: DateTime @default(now())   updatedAt: DateTime @updatedAt'],
            ['Optional Fields', 'Nullable fields use String? or Decimal? — frontend should handle null values'],
            ['Enums', 'All enums are defined at the database level via Prisma enums'],
            ['Tenant Scoping', 'All tenant-owned data includes a tenantId foreign key for data isolation'],
          ].map(([conv, desc], idx) => new TableRow({
            children: [
              new TableCell({ width: { size: 2500, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: conv, size: 18, font: 'Arial', color: C.dark, bold: true })] })] }),
              new TableCell({ width: { size: 6860, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: desc, size: 18, font: 'Arial', color: C.mid })] })] })
            ]
          }))
        ]
      }),
      spacer(2),

      // ── ENUMS ──
      h2('Enums'),
      body('The following enums are defined at the database level:'),
      spacer(),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3000, 6360],
        rows: [
          tableHeader(['Enum', 'Values'], [3000, 6360]),
          ...[
            ['SubscriptionTier', 'SPARK  |  CELEBRATE  |  ELEVATE'],
            ['SubscriptionStatus', 'ACTIVE  |  SUSPENDED  |  CANCELLED'],
            ['PlatformRole', 'SUPER_ADMIN  |  TENANT_ADMIN  |  EVENT_ADMIN'],
            ['EventStatus', 'DRAFT  |  PUBLISHED  |  COMPLETED  |  CANCELLED'],
            ['InviteStatus', 'PENDING  |  ACCEPTED  |  DECLINED'],
            ['DeliveryMethod', 'EMAIL  |  SMS'],
            ['MediaType', 'IMAGE  |  VIDEO'],
            ['VendorCategory', 'CATERING  |  DECOR  |  FURNITURE  |  PHOTOGRAPHY  |  ENTERTAINMENT  |  FLORISTRY  |  OTHER'],
            ['VendorRole', 'VENDOR_OWNER  |  VENDOR_STAFF'],
          ].map(([name, values], idx) => new TableRow({
            children: [
              new TableCell({ width: { size: 3000, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: name, size: 18, font: 'Courier New', color: C.purple })] })] }),
              new TableCell({ width: { size: 6360, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: values, size: 18, font: 'Arial', color: C.mid })] })] })
            ]
          }))
        ]
      }),
      spacer(2),

      // ── RELATIONSHIP MAP ──
      pageBreak(),
      h1('Relationship Map'),
      spacer(),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2200, 1800, 2200, 3160],
        rows: [
          tableHeader(['From', 'Relationship', 'To', 'Notes'], [2200, 1800, 2200, 3160]),
          relRow('Tenant', 'ONE → MANY', 'User', 'A tenant has many platform users'),
          relRow('Tenant', 'ONE → MANY', 'Event', 'A tenant owns many events'),
          relRow('Tenant', 'ONE → MANY', 'VendorSpace', 'A tenant can own vendor profiles (optional)'),
          relRow('User', 'ONE → MANY', 'Event', 'A user creates many events (createdByUserId)'),
          relRow('User', 'ONE → MANY', 'MemoryItem', 'A user can upload memory items'),
          relRow('User', 'ONE → MANY', 'OtpRecord', 'A user can have multiple OTP records'),
          relRow('Event', 'ONE → MANY', 'EventDay', 'An event has one or more days'),
          relRow('Event', 'ONE → MANY', 'Invite', 'An event has many invites'),
          relRow('Event', 'ONE → ONE', 'MemoryHub', 'Each event has exactly one Memory Hub'),
          relRow('Guest', 'ONE → MANY', 'Invite', 'A guest can have invites across events'),
          relRow('Guest', 'ONE → MANY', 'MemoryItem', 'A guest can upload memory items'),
          relRow('Invite', 'ONE → MANY', 'InviteEventDay', 'An invite references specific event days (junction)'),
          relRow('Invite', 'ONE → MANY', 'Attendance', 'An invite records confirmed attendance days'),
          relRow('EventDay', 'ONE → MANY', 'InviteEventDay', 'A day can appear on many invites'),
          relRow('EventDay', 'ONE → MANY', 'Attendance', 'A day can have many attendance confirmations'),
          relRow('MemoryHub', 'ONE → MANY', 'MemoryItem', 'A hub contains many media items'),
          relRow('VendorSpace', 'ONE → MANY', 'VendorUser', 'A vendor space has managing users'),
          relRow('VendorSpace', 'ONE → MANY', 'VendorService', 'A vendor space offers many services'),
          relRow('VendorService', 'ONE → MANY', 'Product', 'A service contains many products'),
        ]
      }),
      spacer(2),

      // ── ENTITY TABLES ──
      pageBreak(),
      h1('Entity Definitions'),
      body('Field colours:  Red = Primary Key  ·  Orange = Foreign Key  ·  Green = Regular field', { color: C.muted, italic: true }),
      spacer(2),

      // TENANT
      h2('Core Platform Entities'),
      entityTable('Tenant', C.dark, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['name', 'String', 'No', 'Organisation name'],
        ['slug', 'String (unique)', 'No', 'URL-safe unique identifier e.g. "levy-events"'],
        ['email', 'String (unique)', 'No', 'Primary contact email'],
        ['subscriptionTier', 'SubscriptionTier', 'No', 'SPARK | CELEBRATE | ELEVATE  —  default: SPARK'],
        ['subscriptionStatus', 'SubscriptionStatus', 'No', 'ACTIVE | SUSPENDED | CANCELLED  —  default: ACTIVE'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag  —  default: false'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
      ]),
      spacer(2),

      entityTable('User', C.blue, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['tenantId', 'String (FK → Tenant)', 'Yes', 'Null for SUPER_ADMIN only'],
        ['firebaseUid', 'String (unique)', 'No', 'Firebase Authentication UID'],
        ['email', 'String (unique)', 'No', 'User email address'],
        ['username', 'String', 'No', 'Display name'],
        ['role', 'PlatformRole', 'No', 'SUPER_ADMIN | TENANT_ADMIN | EVENT_ADMIN'],
        ['isActive', 'Boolean', 'No', 'Account active status  —  default: true'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag  —  default: false'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
      ]),
      spacer(2),

      entityTable('OtpRecord', C.purple, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['userId', 'String (FK → User)', 'No', 'The user this OTP belongs to'],
        ['otp', 'String', 'No', '6-digit verification code'],
        ['expiresAt', 'DateTime', 'No', 'OTP expiry — set to 10 minutes from creation'],
        ['usedAt', 'DateTime', 'Yes', 'Null until the OTP is consumed. Retained for audit.'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
      ]),
      spacer(2),

      pageBreak(),
      h2('Event Entities'),

      entityTable('Event', C.green, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['tenantId', 'String (FK → Tenant)', 'No', 'Owning tenant'],
        ['createdByUserId', 'String (FK → User)', 'No', 'User who created the event'],
        ['name', 'String', 'No', 'Event name'],
        ['description', 'String', 'Yes', 'Optional event description'],
        ['location', 'String', 'No', 'Venue name'],
        ['address', 'String', 'Yes', 'Full street address'],
        ['latitude', 'Decimal(10,7)', 'Yes', 'Used for vendor proximity search'],
        ['longitude', 'Decimal(10,7)', 'Yes', 'Used for vendor proximity search'],
        ['coverImageUrl', 'String', 'Yes', 'Cloudinary URL for event cover image'],
        ['status', 'EventStatus', 'No', 'DRAFT | PUBLISHED | COMPLETED | CANCELLED  —  default: DRAFT'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag  —  default: false'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'User ID of creator — audit field'],
        ['updatedBy', 'String', 'No', 'User ID of last modifier — audit field'],
      ]),
      spacer(2),

      entityTable('EventDay', C.teal, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['eventId', 'String (FK → Event)', 'No', 'Parent event'],
        ['label', 'String', 'No', 'Human-readable label e.g. "Day 1 – Ceremony"'],
        ['date', 'DateTime (Date)', 'No', 'Calendar date of this day'],
        ['startTime', 'DateTime', 'Yes', 'Start time for the day'],
        ['endTime', 'DateTime', 'Yes', 'End time for the day'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      pageBreak(),
      h2('Guest and Invite Entities'),

      entityTable('Guest', C.orange, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['firstName', 'String', 'No', 'Guest first name'],
        ['surname', 'String', 'No', 'Guest surname'],
        ['email', 'String', 'Yes', 'Required if delivery method is EMAIL'],
        ['phoneNumber', 'String', 'Yes', 'Required if delivery method is SMS'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
      ]),
      spacer(2),

      entityTable('Invite', C.red, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['eventId', 'String (FK → Event)', 'No', 'The event this invite belongs to'],
        ['guestId', 'String (FK → Guest)', 'No', 'The guest being invited'],
        ['token', 'String (unique)', 'No', 'Auto-generated unique RSVP token — 32 random bytes hex'],
        ['status', 'InviteStatus', 'No', 'PENDING | ACCEPTED | DECLINED  —  default: PENDING'],
        ['used', 'Boolean', 'No', 'Whether the RSVP link has been used  —  default: false'],
        ['usedAt', 'DateTime', 'Yes', 'Timestamp when the link was first used'],
        ['expiresAt', 'DateTime', 'Yes', 'Optional expiry for the invite link'],
        ['editToken', 'String (unique)', 'Yes', 'Allows guest to amend their RSVP without re-auth'],
        ['editTokenExpiresAt', 'DateTime', 'Yes', 'Expiry for the edit token'],
        ['deliveryMethod', 'DeliveryMethod', 'No', 'EMAIL | SMS'],
        ['deliveredAt', 'DateTime', 'Yes', 'When the invitation was sent'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      entityTable('InviteEventDay  (Junction)', '4A6741', [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['inviteId', 'String (FK → Invite)', 'No', 'The invite'],
        ['eventDayId', 'String (FK → EventDay)', 'No', 'The day the guest is invited for'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['', 'Unique constraint', '', '@@unique([inviteId, eventDayId]) — no duplicate day per invite'],
      ]),
      spacer(2),

      entityTable('Attendance  (Junction / Fact)', '7D3C98', [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['inviteId', 'String (FK → Invite)', 'No', 'The invite that confirmed attendance'],
        ['eventDayId', 'String (FK → EventDay)', 'No', 'The day being confirmed'],
        ['confirmedAt', 'DateTime', 'No', 'When the guest confirmed — auto-set'],
        ['', 'Unique constraint', '', '@@unique([inviteId, eventDayId]) — one confirmation per day per guest'],
      ]),
      spacer(2),

      pageBreak(),
      h2('Memory Hub Entities'),

      entityTable('MemoryHub', C.teal, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['eventId', 'String (FK → Event, unique)', 'No', 'One hub per event — unique constraint'],
        ['title', 'String', 'Yes', 'Hub display title'],
        ['description', 'String', 'Yes', 'Hub description'],
        ['isPublic', 'Boolean', 'No', 'Whether the hub has a public shareable link  —  default: false'],
        ['shareToken', 'String (unique)', 'Yes', 'Auto-generated when isPublic is set to true'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      entityTable('MemoryItem', C.purple, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['memoryHubId', 'String (FK → MemoryHub)', 'No', 'Parent memory hub'],
        ['uploadedByGuestId', 'String (FK → Guest)', 'Yes', 'Set when uploaded by a guest. Null if uploaded by organiser.'],
        ['uploadedByUserId', 'String (FK → User)', 'Yes', 'Set when uploaded by a user. Null if uploaded by guest.'],
        ['mediaUrl', 'String', 'No', 'Cloudinary URL of the uploaded media'],
        ['mediaType', 'MediaType', 'No', 'IMAGE | VIDEO'],
        ['caption', 'String', 'Yes', 'Optional caption'],
        ['isApproved', 'Boolean', 'No', 'Organiser approval flag  —  default: false'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      pageBreak(),
      h2('Vendor Entities'),

      entityTable('VendorSpace', C.orange, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['tenantId', 'String (FK → Tenant)', 'Yes', 'Optional link to an owning tenant'],
        ['name', 'String', 'No', 'Vendor business name'],
        ['description', 'String', 'Yes', 'About the vendor'],
        ['email', 'String', 'No', 'Contact email'],
        ['phoneNumber', 'String', 'Yes', 'Contact phone'],
        ['website', 'String', 'Yes', 'Website URL'],
        ['address', 'String', 'Yes', 'Street address'],
        ['latitude', 'Decimal(10,7)', 'No', 'Required — used for proximity search'],
        ['longitude', 'Decimal(10,7)', 'No', 'Required — used for proximity search'],
        ['isVerified', 'Boolean', 'No', 'Platform-verified vendor badge  —  default: false'],
        ['isActive', 'Boolean', 'No', 'Whether the vendor is currently active  —  default: true'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      entityTable('VendorUser', C.blue, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['vendorSpaceId', 'String (FK → VendorSpace)', 'No', 'Parent vendor space'],
        ['firebaseUid', 'String (unique)', 'No', 'Firebase UID of the vendor user'],
        ['email', 'String (unique)', 'No', 'Vendor user email'],
        ['name', 'String', 'No', 'Display name'],
        ['role', 'VendorRole', 'No', 'VENDOR_OWNER | VENDOR_STAFF  —  default: VENDOR_OWNER'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
      ]),
      spacer(2),

      entityTable('VendorService', C.green, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['vendorSpaceId', 'String (FK → VendorSpace)', 'No', 'Parent vendor space'],
        ['name', 'String', 'No', 'Service name e.g. "Buffet Catering"'],
        ['category', 'VendorCategory', 'No', 'CATERING | DECOR | FURNITURE | PHOTOGRAPHY | ENTERTAINMENT | FLORISTRY | OTHER'],
        ['description', 'String', 'Yes', 'Service description'],
        ['operatingDays', 'String', 'Yes', 'e.g. "Monday to Sunday"'],
        ['operatingHours', 'String', 'Yes', 'e.g. "08:00 – 22:00"'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      entityTable('Product', C.teal, [
        ['id', 'String (CUID)', 'No', 'Primary key'],
        ['vendorServiceId', 'String (FK → VendorService)', 'No', 'Parent vendor service'],
        ['name', 'String', 'No', 'Product name'],
        ['description', 'String', 'Yes', 'Product description'],
        ['price', 'Decimal(10,2)', 'Yes', 'Price in specified currency'],
        ['currency', 'String', 'No', 'Currency code  —  default: ZAR'],
        ['imageUrls', 'String[]', 'No', 'Array of Cloudinary image URLs'],
        ['isAvailable', 'Boolean', 'No', 'Product availability  —  default: true'],
        ['isArchived', 'Boolean', 'No', 'Soft delete flag'],
        ['createdAt', 'DateTime', 'No', 'Auto-set on creation'],
        ['updatedAt', 'DateTime', 'No', 'Auto-updated on every change'],
        ['createdBy', 'String', 'No', 'Audit field'],
        ['updatedBy', 'String', 'No', 'Audit field'],
      ]),
      spacer(2),

      pageBreak(),
      h2('Platform Configuration'),

      entityTable('SubscriptionTierConfig', C.dark, [
        ['tier', 'SubscriptionTier (PK)', 'No', 'Primary key — SPARK | CELEBRATE | ELEVATE'],
        ['maxEvents', 'Int', 'Yes', 'Max active events allowed. Null = unlimited.'],
        ['maxGuestsPerEvent', 'Int', 'Yes', 'Max guests per event. Null = unlimited.'],
        ['maxSmsPerMonth', 'Int', 'Yes', 'Max SMS per billing period. Null = unlimited.'],
        ['emailEnabled', 'Boolean', 'No', 'Whether email invitations are available on this tier'],
        ['smsEnabled', 'Boolean', 'No', 'Whether SMS invitations are available on this tier'],
        ['vendorMarketplace', 'Boolean', 'No', 'Whether vendor marketplace is accessible'],
        ['memoryHubEnabled', 'Boolean', 'No', 'Whether Memory Hub is accessible'],
        ['dragDropBuilder', 'Boolean', 'No', 'Whether drag-and-drop RSVP builder is accessible'],
      ]),
      spacer(2),

      body('Seeded values:', { bold: true }),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [1600, 1400, 1800, 1600, 900, 900, 1000, 1160],
        rows: [
          tableHeader(['Tier', 'Max Events', 'Max Guests/Event', 'Max SMS/Month', 'Email', 'SMS', 'Vendors', 'Memory Hub'], [1600, 1400, 1800, 1600, 900, 900, 1000, 1160]),
          ...[
            ['SPARK', '1', '50', 'None', '✓', '✗', '✗', '✗'],
            ['CELEBRATE', '5', '300', '100', '✓', '✓', '✓', '✓'],
            ['ELEVATE', 'Unlimited', 'Unlimited', 'Unlimited', '✓', '✓', '✓', '✓'],
          ].map(([tier, events, guests, sms, email, smsE, vendors, memory], idx) => new TableRow({
            children: [tier, events, guests, sms, email, smsE, vendors, memory].map((val, ci) => new TableCell({
              width: { size: [1600, 1400, 1800, 1600, 900, 900, 1000, 1160][ci], type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? 'FAFAF8' : C.white },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: val, size: 18, font: 'Arial', color: val === '✓' ? C.green : val === '✗' ? C.red : C.mid })] })]
            }))
          }))
        ]
      }),
      spacer(2),

      // ── FOOTER ──
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 } },
        spacing: { before: 480, after: 120 },
        children: [new TextRun({ text: 'EventGenie ERD Documentation  ·  v1.0  ·  Confidential  ·  2025', size: 18, font: 'Arial', color: C.muted, italics: true })]
      })
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('/Users/levymashilo/EventGenie-back/documentation-generator/EventGenie_ERD_Documentation.docx', buf);
  console.log('ERD doc done');
});