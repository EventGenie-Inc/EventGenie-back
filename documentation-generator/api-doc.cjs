const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  LevelFormat, HeadingLevel, PageBreak
} = require('docx');
const fs = require('fs');
const path = require('path');

const C = {
  dark: '1A1A2E', mid: '2D2D44', muted: '6B6B80', gold: 'C6A43A',
  green: '4A6741', white: 'FFFFFF', light: 'F7F5F0', red: 'C0392B',
  blue: '2471A3', orange: 'D35400', purple: '7D3C98', teal: '148F77',
  border: 'E0DDD6', rowAlt: 'FAFAF8'
};

const METHOD_COLORS = { GET: C.green, POST: C.blue, PUT: C.orange, DELETE: C.red, PATCH: C.purple };

const spacer = (n = 1) => new Paragraph({ children: [new TextRun('')], spacing: { after: 60 * n } });

const rule = () => new Paragraph({
  children: [new TextRun('')],
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 } },
  spacing: { after: 160 }
});

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

const h3 = (text) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 26, font: 'Arial', color: C.dark })],
  spacing: { before: 280, after: 100 }
});

const body = (text, opts = {}) => new Paragraph({
  children: [new TextRun({ text, size: 20, font: 'Arial', color: opts.color || C.mid, bold: opts.bold || false, italics: opts.italic || false })],
  spacing: { after: opts.after || 100 }
});

// Uses the document's 'bullets' numbering (configured on the Document below).
const bullet = (text) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text, size: 20, font: 'Arial', color: C.mid })],
  spacing: { after: 60 }
});

const code = (text) => new Paragraph({
  children: [new TextRun({ text, size: 18, font: 'Courier New', color: C.green })],
  spacing: { after: 80 },
  shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' }
});

const methodBadge = (method, endpoint) => new Paragraph({
  spacing: { before: 200, after: 100 },
  children: [
    new TextRun({ text: ` ${method} `, bold: true, size: 20, font: 'Arial', color: C.white, highlight: undefined }),
    new TextRun({ text: '  ', size: 20 }),
    new TextRun({ text: endpoint, size: 20, font: 'Courier New', color: C.mid, bold: true })
  ]
});

const inlineMethod = (method) => new TextRun({
  text: ` ${method} `,
  bold: true,
  size: 19,
  font: 'Arial',
  color: C.white,
  shading: { type: ShadingType.CLEAR, fill: METHOD_COLORS[method] || C.mid }
});

const endpointRow = (method, path, description, auth) => new TableRow({
  children: [
    new TableCell({
      width: { size: 1200, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: METHOD_COLORS[method] || C.mid },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: method, bold: true, size: 18, font: 'Arial', color: C.white })] })]
    }),
    new TableCell({
      width: { size: 3200, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: path, size: 18, font: 'Courier New', color: C.dark })] })]
    }),
    new TableCell({
      width: { size: 3500, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: description, size: 18, font: 'Arial', color: C.mid })] })]
    }),
    new TableCell({
      width: { size: 1500, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: auth, size: 17, font: 'Arial', color: C.muted, italics: true })] })]
    })
  ]
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

const fieldRow = (field, type, required, description) => new TableRow({
  children: [
    new TableCell({ width: { size: 2000, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: field, size: 18, font: 'Courier New', color: C.green })] })] }),
    new TableCell({ width: { size: 1400, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: type, size: 18, font: 'Arial', color: C.blue })] })] }),
    new TableCell({ width: { size: 1000, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: required, size: 18, font: 'Arial', color: required === 'Yes' ? C.red : C.muted })] })] }),
    new TableCell({ width: { size: 5000, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: description, size: 18, font: 'Arial', color: C.mid })] })] })
  ]
});

const fieldTable = (rows) => new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [2000, 1400, 1000, 5000],
  rows: [tableHeader(['Field', 'Type', 'Required', 'Description'], [2000, 1400, 1000, 5000]), ...rows]
});

const endpointTable = (rows) => new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [1200, 3200, 3500, 1500],
  rows: [tableHeader(['Method', 'Endpoint', 'Description', 'Auth'], [1200, 3200, 3500, 1500]), ...rows]
});

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

// ── DOCUMENT ──────────────────────────────────────────────────

const doc = new Document({
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 240 } }, run: { color: C.gold, font: 'Arial' } } }] }] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
    children: [

      // ── COVER ──────────────────────────────
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1440, after: 120 }, children: [new TextRun({ text: 'EventGenie', bold: true, size: 80, font: 'Arial', color: C.dark })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'API Reference Documentation', size: 30, font: 'Arial', color: C.gold, italics: true })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Version 1.0  ·  Internal Team Reference', size: 20, font: 'Arial', color: C.muted })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 480 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.gold, space: 1 } }, children: [new TextRun('')] }),

      // ── OVERVIEW ──────────────────────────────
      h1('Overview'),
      body('EventGenie is a multi-tenant event management platform. This document describes all available API endpoints, their request formats, expected responses, and authentication requirements.'),
      spacer(),
      h2('Base URL'),
      code('Development:   http://localhost:5000'),
      code('Production:    https://api.eventgenie.com  (to be configured)'),
      spacer(),

      h2('Authentication Model'),
      body('All protected endpoints require TWO headers on every request:', { bold: true }),
      spacer(),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3000, 6360],
        rows: [
          tableHeader(['Header', 'Value'], [3000, 6360]),
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Authorization', size: 18, font: 'Courier New', color: C.green })] })] }),
            new TableCell({ width: { size: 6360, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Bearer <firebase_id_token>  —  Proves Firebase identity', size: 18, font: 'Arial', color: C.mid })] })] })
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'X-Session-Token', size: 18, font: 'Courier New', color: C.green })] })] }),
            new TableCell({ width: { size: 6360, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: '<session_jwt>  —  Proves 2FA was completed (issued by verify-otp)', size: 18, font: 'Arial', color: C.mid })] })] })
          ]})
        ]
      }),
      spacer(2),
      body('Auth endpoints (register, request-otp, verify-otp, refresh-session) only require the Authorization header.', { italic: true, color: C.muted }),
      spacer(),

      h2('Role Hierarchy'),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2500, 3000, 3860],
        rows: [
          tableHeader(['Role', 'Scope', 'Access Level'], [2500, 3000, 3860]),
          new TableRow({ children: [
            new TableCell({ width: { size: 2500, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'SUPER_ADMIN', size: 18, font: 'Courier New', color: C.red })] })] }),
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Platform-wide', size: 18, font: 'Arial', color: C.mid })] })] }),
            new TableCell({ width: { size: 3860, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'All endpoints, all tenants', size: 18, font: 'Arial', color: C.mid })] })] })
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 2500, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'TENANT_ADMIN', size: 18, font: 'Courier New', color: C.orange })] })] }),
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Own tenant only', size: 18, font: 'Arial', color: C.mid })] })] }),
            new TableCell({ width: { size: 3860, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'All event, guest, vendor, memory operations', size: 18, font: 'Arial', color: C.mid })] })] })
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 2500, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'EVENT_ADMIN', size: 18, font: 'Courier New', color: C.blue })] })] }),
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Own tenant only', size: 18, font: 'Arial', color: C.mid })] })] }),
            new TableCell({ width: { size: 3860, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Read events, manage guests and invites', size: 18, font: 'Arial', color: C.mid })] })] })
          ]})
        ]
      }),
      spacer(2),

      h2('Standard Response Format'),
      body('All responses follow this structure:'),
      spacer(),
      code('{'),
      code('  "status": "ok" | "error",'),
      code('  "data": { ... },        // present on success'),
      code('  "message": "..."        // present on error'),
      code('}'),
      spacer(2),

      // ── AUTH ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Auth Endpoints'),
      body('Base path: /api/auth', { bold: true }),
      body('These endpoints manage registration, 2FA, and session tokens.'),
      spacer(),

      endpointTable([
        endpointRow('POST', '/api/auth/register', 'Register a new tenant + admin in one transaction', 'Firebase token only'),
        endpointRow('POST', '/api/auth/request-otp', 'Send 6-digit OTP to user email (2FA step 1)', 'Firebase token only'),
        endpointRow('POST', '/api/auth/verify-otp', 'Verify OTP and receive session JWT (2FA step 2)', 'Firebase token only'),
        endpointRow('POST', '/api/auth/refresh-session', 'Refresh an expiring session JWT (15min validity)', 'Firebase + Session'),
      ]),
      spacer(2),

      h3('POST /api/auth/register'),
      body('Creates a Tenant and a TENANT_ADMIN user in a single atomic transaction. Blocked if the Firebase user already has an account.'),
      spacer(),
      body('Request Body:', { bold: true }),
      fieldTable([
        fieldRow('username', 'string', 'Yes', 'Display name for the admin user'),
        fieldRow('tenantName', 'string', 'Yes', 'Name of the tenant organisation'),
        fieldRow('tenantSlug', 'string', 'Yes', 'URL-safe unique identifier (e.g. "levy-events")'),
      ]),
      spacer(),
      body('Success Response — 201 Created:', { bold: true }),
      code('{ "status": "ok", "data": {'),
      code('    "user": { "id", "email", "username", "role", "tenantId" },'),
      code('    "tenant": { "id", "name", "slug", "subscriptionTier" }'),
      code('}}'),
      body('The email (the Firebase account\'s) is stored lowercase and trimmed, for the user and the tenant alike.'),
      body('Errors:', { bold: true }),
      bullet('401 — the Firebase token is missing, expired, revoked or malformed: "Your sign-in has expired or isn\'t valid. Please sign in again, then finish creating your account." (A Firebase outage is a 500, not a 401.)'),
      bullet('409 — an account already exists for this Firebase user or email, or the tenant slug is taken (also when two registrations race).'),
      spacer(2),

      h3('POST /api/auth/request-otp'),
      body('Generates a 6-digit OTP, stores it with a 10-minute expiry, and sends it to the user\'s registered email via Resend.'),
      body('No request body required. The user is identified by their Firebase token.'),
      spacer(),
      body('Success Response — 200 OK:', { bold: true }),
      code('{ "status": "ok", "data": { "message": "Verification code sent to your email." } }'),
      spacer(2),

      h3('POST /api/auth/verify-otp'),
      body('Validates the OTP against the stored record, marks it as used, and issues a signed 15-minute session JWT.'),
      spacer(),
      body('Request Body:', { bold: true }),
      fieldTable([
        fieldRow('otp', 'string', 'Yes', '6-digit code received in the email'),
      ]),
      spacer(),
      body('Success Response — 200 OK:', { bold: true }),
      code('{ "status": "ok", "data": {'),
      code('    "sessionToken": "eyJ...",'),
      code('    "expiresIn": "15m",'),
      code('    "user": { "id", "email", "username", "role", "tenantId" }'),
      code('}}'),
      spacer(2),

      h3('POST /api/auth/refresh-session'),
      body('Issues a fresh 15-minute session JWT. Call this when the frontend detects the token is near expiry and the user is still active.'),
      spacer(),
      body('Additional Header Required:', { bold: true }),
      code('X-Session-Token: <current_session_jwt>'),
      spacer(),
      body('Success Response — 200 OK:', { bold: true }),
      code('{ "status": "ok", "data": { "sessionToken": "eyJ...", "expiresIn": "15m" } }'),
      spacer(2),

      // ── TENANT ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Tenant Endpoints'),
      body('Base path: /api/tenants', { bold: true }),
      body('SUPER_ADMIN only. Manages the top-level workspace for each event organiser.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/tenants', 'Get all tenants on the platform', 'SUPER_ADMIN'),
        endpointRow('GET', '/api/tenants/:id', 'Get a single tenant by ID', 'SUPER_ADMIN'),
        endpointRow('POST', '/api/tenants', 'Create a tenant manually', 'SUPER_ADMIN'),
        endpointRow('PUT', '/api/tenants/:id', 'Update tenant details or subscription', 'SUPER_ADMIN'),
        endpointRow('DELETE', '/api/tenants/:id', 'Archive a tenant (soft delete)', 'SUPER_ADMIN'),
      ]),
      spacer(2),

      h3('POST /api/tenants — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'Yes', 'Tenant organisation name'),
        fieldRow('slug', 'string', 'Yes', 'Unique URL-safe identifier'),
        fieldRow('email', 'string', 'Yes', 'Primary contact email for tenant'),
        fieldRow('subscriptionTier', 'SPARK | CELEBRATE | ELEVATE', 'No', 'Defaults to SPARK'),
      ]),
      spacer(2),

      h3('PUT /api/tenants/:id — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'No', 'Updated organisation name'),
        fieldRow('email', 'string', 'No', 'Updated contact email'),
        fieldRow('subscriptionTier', 'SPARK | CELEBRATE | ELEVATE', 'No', 'Change subscription tier'),
        fieldRow('subscriptionStatus', 'ACTIVE | SUSPENDED | CANCELLED', 'No', 'Change subscription status'),
      ]),
      spacer(2),

      // ── USER ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('User and Team Endpoints'),
      body('Base path: /api/users', { bold: true }),
      body('Behind the teamMembers feature flag (off: every route here is a 404). TENANT_ADMIN and above, tenant-scoped: another tenant\'s user is a 404. A tenant always keeps one active TENANT_ADMIN; nobody can suspend themselves or change their own role. Emails are stored and compared lowercase and trimmed.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/users', 'List the tenant\'s members, suspended ones included, each with status and assignments', 'TENANT_ADMIN+'),
        endpointRow('GET', '/api/users/:id', 'Get a single user by ID', 'TENANT_ADMIN+'),
        endpointRow('POST', '/api/users', 'Create a user for an existing Firebase account', 'TENANT_ADMIN+'),
        endpointRow('PUT', '/api/users/:id', 'Change a user\'s name or role', 'TENANT_ADMIN+'),
        endpointRow('PUT', '/api/users/:id/assignments', 'Set an event admin\'s event assignments (the whole list)', 'TENANT_ADMIN'),
        endpointRow('DELETE', '/api/users/:id', 'Suspend a user (same as /suspend)', 'TENANT_ADMIN+'),
        endpointRow('POST', '/api/users/:id/suspend', 'Suspend a user: signs them out and revokes every trusted device', 'TENANT_ADMIN+'),
        endpointRow('POST', '/api/users/:id/reactivate', 'Reactivate a suspended user', 'TENANT_ADMIN+'),
        endpointRow('GET', '/api/users/invites', 'List open invitations (pending or expired)', 'TENANT_ADMIN'),
        endpointRow('POST', '/api/users/invites', 'Invite someone by email', 'TENANT_ADMIN'),
        endpointRow('POST', '/api/users/invites/:inviteId/resend', 'Resend: a new link and a new 7-day expiry', 'TENANT_ADMIN'),
        endpointRow('POST', '/api/users/invites/:inviteId/revoke', 'Revoke an open invitation', 'TENANT_ADMIN'),
      ]),
      spacer(2),

      h2('Roles and the assignment lock'),
      bullet('TENANT_ADMIN manages the team, billing and every event. Never locked by assignments.'),
      bullet('EVENT_ADMIN works on events. With no assignments they see every event in the tenant; with any, only their assigned events. Any other event, and everything under it (days, program, guests, invites, RSVP fields and responses, check-in, Memory Hub, Event Pass, tickets, invitation design, uploads), is a 404, the same as another tenant\'s. A locked member who creates an event is assigned to it.'),
      spacer(2),

      h3('GET /api/users — Success Response (TENANT_ADMIN)'),
      body('Each user row as before, plus:'),
      code('{ ..., "status": "ACTIVE" | "SUSPENDED",'),
      code('  "assignments": [ { "eventId", "eventName", "eventIsArchived" } ] }'),
      body('An empty assignments list means the member sees every event. A SUPER_ADMIN gets every user on the platform, unchanged.'),
      spacer(2),

      h3('POST /api/users — Request Body'),
      fieldTable([
        fieldRow('firebaseUid', 'string', 'Yes', 'The user\'s Firebase UID — create in Firebase first'),
        fieldRow('email', 'string', 'Yes', 'User email address; stored lowercase and trimmed'),
        fieldRow('username', 'string', 'Yes', 'Display name'),
        fieldRow('role', 'TENANT_ADMIN | EVENT_ADMIN | EVENT_VENDOR', 'Yes', 'EVENT_VENDOR is 422 while the vendors feature is off'),
        fieldRow('tenantId', 'string', 'No', 'SUPER_ADMIN only; a TENANT_ADMIN always creates in their own tenant'),
      ]),
      body('409 USER_EMAIL_TAKEN — the email (in any case) already has an account, including when two creations race.'),
      spacer(2),

      h3('PUT /api/users/:id — Request Body'),
      body('Only these two fields are written; anything else in the body is ignored.'),
      fieldTable([
        fieldRow('username', 'string', 'No', 'Display name'),
        fieldRow('role', 'TENANT_ADMIN | EVENT_ADMIN | EVENT_VENDOR', 'No', 'Changing someone to EVENT_VENDOR is 422 while vendors are off. A change to any role but EVENT_ADMIN clears their assignments.'),
      ]),
      body('Errors: 403 changing your own role; 409 demoting the tenant\'s only active TENANT_ADMIN.'),
      spacer(2),

      h3('PUT /api/users/:id/assignments — Request Body'),
      fieldTable([
        fieldRow('eventIds', 'string[]', 'Yes', 'The member\'s complete list of assigned events (may be empty). Each must be a live event of this tenant, or one already assigned.'),
        fieldRow('confirmWidening', 'true', 'No', 'Required to remove the LAST assignment, which gives the member every event'),
      ]),
      body('Success — 200: the member row (as in the list).', { bold: true }),
      body('Errors: 404 an event that isn\'t this tenant\'s; 422 the user isn\'t an EVENT_ADMIN; 409 ASSIGNMENT_LOCK_RELEASE removing the last assignment without confirmWidening.'),
      spacer(2),

      h3('POST /api/users/:id/suspend'),
      body('Suspends the user (they can\'t sign in) and revokes every trusted device. 403 suspending yourself; 409 suspending the tenant\'s only active TENANT_ADMIN. DELETE /api/users/:id does the same.'),
      spacer(2),

      h3('POST /api/users/invites — Request Body'),
      fieldTable([
        fieldRow('email', 'string', 'Yes', 'Stored lowercase and trimmed'),
        fieldRow('role', 'TENANT_ADMIN | EVENT_ADMIN', 'Yes', 'EVENT_VENDOR is 422'),
        fieldRow('eventIds', 'string[]', 'No', 'EVENT_ADMIN only: events to assign on acceptance (empty = every event). 422 for a TENANT_ADMIN.'),
      ]),
      body('Success Response — 201 Created:', { bold: true }),
      code('{ "status": "ok", "data": { "emailSent": true, "invite": {'),
      code('    "id", "email", "role", "status": "PENDING" | "EXPIRED",'),
      code('    "assignments": [ { "eventId", "eventName" } ],'),
      code('    "expiresAt", "lastSentAt", "createdAt", "invitedBy": { "id", "name" } } } }'),
      body('Emails "You\'ve been invited to join <company> on e-velope" with an "Accept invitation" button to <FRONTEND_BASE_URL>/join?token=…. The token is valid 7 days, single use, and never stored or returned (only its hash is kept). emailSent false: the invitation exists but the email failed; resend it.'),
      body('Errors: 409 USER_EMAIL_TAKEN — the address already has an account; 409 TEAM_INVITE_PENDING — an open invitation already exists (resend it). Rate limit: 20 invitations or resends per hour per admin.'),
      spacer(2),

      h3('Resend and revoke'),
      body('POST /api/users/invites/:inviteId/resend — 200 { invite, emailSent }. Mints a new token: the previous link stops working. 409 if accepted or revoked; 409 USER_EMAIL_TAKEN if the address has since got an account.'),
      body('POST /api/users/invites/:inviteId/revoke — 200, the invite. The link stops working. Idempotent; 409 if already accepted (suspend the member instead).'),
      spacer(2),

      // ── TEAM INVITE (PUBLIC) ENDPOINTS ──────────────────────────────
      h1('Team Invitation Endpoints (public)'),
      body('Base path: /api/team-invites', { bold: true }),
      body('No session: the invitee has no account yet. The invite token from the email link is the credential. Behind the teamMembers flag. Rate-limited per token and per IP.'),
      spacer(),

      endpointTable([
        endpointRow('POST', '/api/team-invites/lookup', 'What the /join page shows: the invited email and company', 'Invite token'),
        endpointRow('POST', '/api/team-invites/accept', 'Create the account in the inviting tenant', 'Invite token + Firebase token'),
      ]),
      spacer(2),

      h3('POST /api/team-invites/lookup'),
      fieldTable([ fieldRow('token', 'string', 'Yes', 'The token from the invitation link') ]),
      body('Success — 200:', { bold: true }),
      code('{ "status": "ok", "data": { "email", "companyName", "role", "expiresAt" } }'),
      spacer(2),

      h3('POST /api/team-invites/accept'),
      body('Header: Authorization: Bearer <Firebase ID token> — the account the frontend just created for the invited email.'),
      fieldTable([
        fieldRow('token', 'string', 'Yes', 'The token from the invitation link'),
        fieldRow('username', 'string', 'Yes', 'The person\'s name, up to 100 characters'),
      ]),
      body('Success Response — 201 Created:', { bold: true }),
      code('{ "status": "ok", "data": {'),
      code('    "user": { "id", "email", "username", "role", "tenantId" },'),
      code('    "tenant": { "id", "name" } } }'),
      body('The usual device code step follows on first sign-in.'),
      body('Errors (lookup and accept):', { bold: true }),
      bullet('404 TEAM_INVITE_INVALID — unknown or revoked link, or the workspace is suspended'),
      bullet('422 TEAM_INVITE_EXPIRED — past its 7 days'),
      bullet('409 TEAM_INVITE_USED — already accepted'),
      bullet('409 USER_EMAIL_TAKEN — the address already has an account (accounts belong to one workspace)'),
      bullet('403 — signed in with a different email than the invitation\'s'),
      bullet('401 — the Firebase token is missing, expired or invalid'),
      bullet('422 — a blank name, or every event the invitation named has since been archived'),
      spacer(2),

      // ── EVENT ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Event Endpoints'),
      body('Base path: /api/events', { bold: true }),
      body('A locked EVENT_ADMIN (one with event assignments — see User and Team Endpoints) sees and edits only their assigned events: GET /api/events lists only those, and any other event id, here or under any event sub-resource, is a 404. Creating an event while locked assigns it to the creator.'),
      body('EVENT_ADMIN and above. All events are scoped to the requesting user\'s tenant.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/events', 'Get all events for the tenant', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/events/:id', 'Get a single event with its days and memory hub', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events', 'Create a new event', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/events/:id', 'Update event details or status', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/events/:id', 'Archive an event (soft delete)', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/events — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'Yes', 'Event name'),
        fieldRow('description', 'string', 'No', 'Event description'),
        fieldRow('location', 'string', 'Yes', 'Venue name'),
        fieldRow('address', 'string', 'No', 'Full street address'),
        fieldRow('latitude', 'number', 'No', 'Used for vendor proximity matching'),
        fieldRow('longitude', 'number', 'No', 'Used for vendor proximity matching'),
        fieldRow('coverImageUrl', 'string', 'No', 'Cloudinary URL for event cover image'),
      ]),
      spacer(2),

      h3('PUT /api/events/:id — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'No', 'Updated event name'),
        fieldRow('description', 'string', 'No', 'Updated description'),
        fieldRow('location', 'string', 'No', 'Updated venue name'),
        fieldRow('address', 'string', 'No', 'Updated address'),
        fieldRow('latitude', 'number', 'No', 'Updated coordinates'),
        fieldRow('longitude', 'number', 'No', 'Updated coordinates'),
        fieldRow('coverImageUrl', 'string', 'No', 'Updated cover image URL'),
        fieldRow('status', 'DRAFT | PUBLISHED | COMPLETED | CANCELLED', 'No', 'Updated event status'),
      ]),
      spacer(2),

      // ── EVENT DAY ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Event Day Endpoints'),
      body('Base path: /api/events/:eventId/days', { bold: true }),
      body('EVENT_ADMIN and above. Event days define the individual days of a multi-day event. Invites reference specific days.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/events/:eventId/days', 'Get all days for an event', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/events/:eventId/days/:id', 'Get a single event day', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events/:eventId/days', 'Add a day to an event', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/events/:eventId/days/:id', 'Update a day\'s details', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/events/:eventId/days/:id', 'Archive a day (soft delete)', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/events/:eventId/days — Request Body'),
      fieldTable([
        fieldRow('label', 'string', 'Yes', 'Human-readable label e.g. "Day 1 – Ceremony"'),
        fieldRow('date', 'string (ISO date)', 'Yes', 'Date of this day e.g. "2025-08-01"'),
        fieldRow('startTime', 'string (ISO datetime)', 'No', 'Start time e.g. "2025-08-01T18:00:00.000Z"'),
        fieldRow('endTime', 'string (ISO datetime)', 'No', 'End time e.g. "2025-08-01T23:00:00.000Z"'),
      ]),
      spacer(2),

      // ── GUEST ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Guest Endpoints'),
      body('Base path: /api/guests', { bold: true }),
      body('EVENT_ADMIN and above. Guests are not platform users. They interact only through invite links.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/guests', 'Get all guests', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/guests/:id', 'Get a single guest', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/guests', 'Create a guest record', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/guests/:id', 'Update guest details', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/guests/:id', 'Archive a guest (soft delete)', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/guests — Request Body'),
      fieldTable([
        fieldRow('firstName', 'string', 'Yes', 'Guest first name'),
        fieldRow('surname', 'string', 'Yes', 'Guest surname'),
        fieldRow('email', 'string', 'No', 'Guest email — used for EMAIL delivery method'),
        fieldRow('phoneNumber', 'string', 'No', 'Guest phone — used for SMS delivery method'),
      ]),
      spacer(2),

      // ── INVITE ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Invite Endpoints'),
      body('Base path: /api/events/:eventId/invites', { bold: true }),
      body('EVENT_ADMIN and above. Creating an invite generates a unique token automatically and links the guest to specific event days.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/events/:eventId/invites', 'Get all invites for an event', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/events/:eventId/invites/:id', 'Get a single invite with guest and day details', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events/:eventId/invites', 'Create an invite for a guest', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/events/:eventId/invites/:id', 'Update invite status or delivery method', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/events/:eventId/invites/:id', 'Archive an invite (soft delete)', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/events/:eventId/invites — Request Body'),
      fieldTable([
        fieldRow('guestId', 'string', 'Yes', 'ID of the guest to invite'),
        fieldRow('deliveryMethod', 'EMAIL | SMS', 'Yes', 'How the invite link will be sent'),
        fieldRow('invitedDayIds', 'string[]', 'Yes', 'Array of EventDay IDs this guest is invited to'),
        fieldRow('expiresAt', 'string (ISO datetime)', 'No', 'When the invite token expires'),
      ]),
      spacer(),
      body('Note: The invite token is generated automatically and returned in the response. Use this token to construct the RSVP link: https://eventgenie.com/rsvp?token={token}', { italic: true, color: C.muted }),
      spacer(2),

      // ── ATTENDANCE ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Attendance Endpoints'),
      body('Base path: /api/attendance', { bold: true }),
      body('EVENT_ADMIN and above. Records which event days a guest has confirmed attendance for.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/attendance/invite/:inviteId', 'Get all attendance records for an invite', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/attendance/:id', 'Get a single attendance record', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/attendance', 'Record attendance for a guest on a specific day', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/attendance/:id', 'Remove an attendance record (hard delete)', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/attendance — Request Body'),
      fieldTable([
        fieldRow('inviteId', 'string', 'Yes', 'ID of the invite'),
        fieldRow('eventDayId', 'string', 'Yes', 'ID of the event day being confirmed'),
      ]),
      spacer(2),

      // ── MEMORY HUB ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Memory Hub Endpoints'),
      body('Base path: /api/events/:eventId/memory-hub', { bold: true }),
      body('EVENT_ADMIN and above. One Memory Hub exists per event. It collects photos and videos from attendees after the event.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/events/:eventId/memory-hub', 'Get the memory hub for an event', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events/:eventId/memory-hub', 'Create the memory hub for an event', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/events/:eventId/memory-hub/:id', 'Update hub title or description', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events/:eventId/memory-hub/:id/make-public', 'Generate a public shareable link', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/events/:eventId/memory-hub/:id', 'Archive the memory hub', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/events/:eventId/memory-hub/:hubId/items', 'Get all media items in a hub', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/events/:eventId/memory-hub/:hubId/items/:id', 'Get a single media item', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/events/:eventId/memory-hub/:hubId/items', 'Upload a media item', 'EVENT_ADMIN+'),
        endpointRow('PUT', '/api/events/:eventId/memory-hub/:hubId/items/:id', 'Update caption or approval status', 'EVENT_ADMIN+'),
        endpointRow('DELETE', '/api/events/:eventId/memory-hub/:hubId/items/:id', 'Archive a media item', 'EVENT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/events/:eventId/memory-hub — Request Body'),
      fieldTable([
        fieldRow('title', 'string', 'No', 'Hub title e.g. "Amapiano Saturdays Memories"'),
        fieldRow('description', 'string', 'No', 'Short description of the memory collection'),
      ]),
      spacer(2),

      h3('POST .../:hubId/items — Request Body'),
      fieldTable([
        fieldRow('mediaUrl', 'string', 'Yes', 'Cloudinary URL of the uploaded media'),
        fieldRow('mediaType', 'IMAGE | VIDEO', 'Yes', 'Type of media'),
        fieldRow('caption', 'string', 'No', 'Optional caption for the item'),
        fieldRow('uploadedByGuestId', 'string', 'No', 'Guest ID if uploaded by a guest'),
        fieldRow('uploadedByUserId', 'string', 'No', 'User ID if uploaded by an organiser'),
      ]),
      spacer(2),

      // ── VENDOR ENDPOINTS ──────────────────────────────
      pageBreak(),
      h1('Vendor Endpoints'),
      body('Base path: /api/vendors', { bold: true }),
      body('The Vendor Marketplace connects event organizers with nearby service providers.'),
      spacer(),

      h2('Vendor Space'),
      endpointTable([
        endpointRow('GET', '/api/vendors', 'Get all vendor spaces (tenant-scoped)', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/vendors/nearby', 'Find vendors near a location (proximity search)', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/vendors/:id', 'Get a single vendor space with services', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/vendors', 'Create a vendor space', 'TENANT_ADMIN+'),
        endpointRow('PUT', '/api/vendors/:id', 'Update vendor space details', 'TENANT_ADMIN+'),
        endpointRow('DELETE', '/api/vendors/:id', 'Archive a vendor space', 'TENANT_ADMIN+'),
      ]),
      spacer(2),

      h3('GET /api/vendors/nearby — Query Parameters'),
      fieldTable([
        fieldRow('latitude', 'number', 'Yes', 'Latitude of the event location'),
        fieldRow('longitude', 'number', 'Yes', 'Longitude of the event location'),
        fieldRow('radius', 'number', 'No', 'Search radius in km (default: 50)'),
      ]),
      spacer(2),

      h3('POST /api/vendors — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'Yes', 'Vendor business name'),
        fieldRow('description', 'string', 'No', 'About the vendor'),
        fieldRow('email', 'string', 'Yes', 'Contact email'),
        fieldRow('phoneNumber', 'string', 'No', 'Contact phone'),
        fieldRow('website', 'string', 'No', 'Website URL'),
        fieldRow('address', 'string', 'No', 'Street address'),
        fieldRow('latitude', 'number', 'Yes', 'Vendor location latitude (required for proximity search)'),
        fieldRow('longitude', 'number', 'Yes', 'Vendor location longitude (required for proximity search)'),
      ]),
      spacer(2),

      h2('Vendor Services'),
      endpointTable([
        endpointRow('GET', '/api/vendors/:vendorSpaceId/services', 'Get all services for a vendor', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/vendors/:vendorSpaceId/services/:id', 'Get a single service', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/vendors/:vendorSpaceId/services', 'Add a service to a vendor', 'TENANT_ADMIN+'),
        endpointRow('PUT', '/api/vendors/:vendorSpaceId/services/:id', 'Update a service', 'TENANT_ADMIN+'),
        endpointRow('DELETE', '/api/vendors/:vendorSpaceId/services/:id', 'Archive a service', 'TENANT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST /api/vendors/:vendorSpaceId/services — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'Yes', 'Service name e.g. "Buffet Catering"'),
        fieldRow('category', 'CATERING | DECOR | FURNITURE | PHOTOGRAPHY | ENTERTAINMENT | FLORISTRY | OTHER', 'Yes', 'Service category'),
        fieldRow('description', 'string', 'No', 'Service description'),
        fieldRow('operatingDays', 'string', 'No', 'e.g. "Monday to Sunday"'),
        fieldRow('operatingHours', 'string', 'No', 'e.g. "08:00 - 22:00"'),
      ]),
      spacer(2),

      h2('Products'),
      endpointTable([
        endpointRow('GET', '/api/vendors/:vendorSpaceId/services/:serviceId/products', 'Get all products for a service', 'EVENT_ADMIN+'),
        endpointRow('GET', '/api/vendors/:vendorSpaceId/services/:serviceId/products/:id', 'Get a single product', 'EVENT_ADMIN+'),
        endpointRow('POST', '/api/vendors/:vendorSpaceId/services/:serviceId/products', 'Add a product to a service', 'TENANT_ADMIN+'),
        endpointRow('PUT', '/api/vendors/:vendorSpaceId/services/:serviceId/products/:id', 'Update a product', 'TENANT_ADMIN+'),
        endpointRow('DELETE', '/api/vendors/:vendorSpaceId/services/:serviceId/products/:id', 'Archive a product', 'TENANT_ADMIN+'),
      ]),
      spacer(2),

      h3('POST .../products — Request Body'),
      fieldTable([
        fieldRow('name', 'string', 'Yes', 'Product name'),
        fieldRow('description', 'string', 'No', 'Product description'),
        fieldRow('price', 'number', 'No', 'Price in the specified currency'),
        fieldRow('currency', 'string', 'No', 'Currency code (default: ZAR)'),
        fieldRow('imageUrls', 'string[]', 'No', 'Array of Cloudinary image URLs'),
      ]),
      spacer(2),

      // ── SUBSCRIPTION TIER CONFIG ──────────────────────────────
      pageBreak(),
      h1('Subscription Tier Config Endpoints'),
      body('Base path: /api/subscription-tiers', { bold: true }),
      body('SUPER_ADMIN only. Manages the feature limits for each subscription tier.'),
      spacer(),

      endpointTable([
        endpointRow('GET', '/api/subscription-tiers', 'Get all tier configurations', 'SUPER_ADMIN'),
        endpointRow('GET', '/api/subscription-tiers/:tier', 'Get config for SPARK, CELEBRATE, or ELEVATE', 'SUPER_ADMIN'),
        endpointRow('POST', '/api/subscription-tiers', 'Create a tier config (initial setup)', 'SUPER_ADMIN'),
        endpointRow('PUT', '/api/subscription-tiers/:tier', 'Update limits or feature flags for a tier', 'SUPER_ADMIN'),
      ]),
      spacer(2),

      h3('POST /api/subscription-tiers — Request Body'),
      fieldTable([
        fieldRow('tier', 'SPARK | CELEBRATE | ELEVATE', 'Yes', 'The tier being configured'),
        fieldRow('maxEvents', 'number | null', 'No', 'Max active events (null = unlimited)'),
        fieldRow('maxGuestsPerEvent', 'number | null', 'No', 'Max guests per event (null = unlimited)'),
        fieldRow('maxSmsPerMonth', 'number | null', 'No', 'Max SMS per billing period (null = unlimited)'),
        fieldRow('emailEnabled', 'boolean', 'Yes', 'Whether email invitations are enabled'),
        fieldRow('smsEnabled', 'boolean', 'Yes', 'Whether SMS invitations are enabled'),
        fieldRow('vendorMarketplace', 'boolean', 'Yes', 'Whether vendor marketplace is accessible'),
        fieldRow('memoryHubEnabled', 'boolean', 'Yes', 'Whether Memory Hub is accessible'),
        fieldRow('dragDropBuilder', 'boolean', 'Yes', 'Whether drag-and-drop RSVP builder is accessible'),
      ]),
      spacer(2),

      // ── ERROR CODES ──────────────────────────────
      pageBreak(),
      h1('Error Reference'),
      spacer(),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [1400, 2500, 5460],
        rows: [
          tableHeader(['HTTP Status', 'Meaning', 'Common Causes'], [1400, 2500, 5460]),
          ...[
            ['400', 'Bad Request', 'Missing required fields, invalid body format'],
            ['401', 'Unauthorized', 'Missing Authorization header, invalid Firebase token, missing or expired X-Session-Token'],
            ['403', 'Forbidden', 'Valid token but insufficient role for this endpoint'],
            ['404', 'Not Found', 'Route does not exist, or a record in another tenant (or an event a locked member isn\'t assigned to) — deliberately the same'],
            ['409', 'Conflict', 'Duplicate (an email that already has an account), or a state conflict (the last tenant admin, an invitation already accepted)'],
            ['422', 'Unprocessable', 'Valid shape, unmet precondition (a vendor role while vendors are off, an expired invitation)'],
            ['500', 'Server Error', 'Unexpected error — check server logs'],
          ].map(([status, meaning, causes]) => new TableRow({
            children: [
              new TableCell({ width: { size: 1400, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: status, size: 18, font: 'Arial', color: status === '401' || status === '403' ? C.red : status === '400' ? C.orange : C.mid, bold: true })] })] }),
              new TableCell({ width: { size: 2500, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: meaning, size: 18, font: 'Arial', color: C.mid })] })] }),
              new TableCell({ width: { size: 5460, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: causes, size: 18, font: 'Arial', color: C.muted })] })] })
            ]
          }))
        ]
      }),
      spacer(2),

      h3('Machine-readable codes (team members)'),
      body('Errors carry { "status": "error", "message", "code"? }. The code is present only where a client must tell two same-status failures apart.'),
      bullet('USER_EMAIL_TAKEN (409) — POST /api/users, invitation create/resend/accept'),
      bullet('ASSIGNMENT_LOCK_RELEASE (409) — PUT /api/users/:id/assignments'),
      bullet('TEAM_INVITE_PENDING (409) — POST /api/users/invites'),
      bullet('TEAM_INVITE_INVALID (404), TEAM_INVITE_EXPIRED (422), TEAM_INVITE_USED (409) — /api/team-invites'),
      bullet('GUEST_EMAIL_REQUIRED (422) — POST /api/rsvp/submit, removing an email while SMS is off'),
      spacer(2),

      // ── FOOTER ──────────────────────────────
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 } },
        spacing: { before: 480, after: 120 },
        children: [new TextRun({ text: 'EventGenie API Documentation  ·  v1.0  ·  Confidential  ·  2025', size: 18, font: 'Arial', color: C.muted, italics: true })]
      })
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  // The tracked copy lives in docs/ (this used to write one level up, to an
  // absolute path on one machine, beside the file it was meant to replace).
  fs.writeFileSync(path.join(__dirname, 'docs', 'EventGenie_API_Documentation.docx'), buf);
  console.log('API doc done');
});