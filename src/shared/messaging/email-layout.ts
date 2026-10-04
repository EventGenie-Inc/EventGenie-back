import { escapeHtml } from '../utils/html.util.js';
import { frontendUrl } from '../utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  THE ONE EMAIL LAYOUT
//
//  Every email this backend sends (invitations, reminders, sign-in codes,
//  password resets) is rendered here, so they read as one family. A message
//  builder describes its content as a list of blocks of PLAIN TEXT; this
//  file turns the same blocks into both the HTML part and the plain-text
//  part, so the two can never say different things.
//
//  ESCAPING lives here, not in the builders: every text and every URL a
//  block carries goes through escapeHtml on its way into the HTML (attribute
//  values included). A builder never passes markup, so a builder can't
//  forget to escape an organiser's or guest's words either.
//
//  Built for email clients, not browsers: table layout, inline styles, a
//  600px column, system font stacks (no web fonts), no SVG. The <style>
//  block only ADDS dark-mode and narrow-screen overrides for the clients
//  that read it (Apple Mail, iOS Mail, Outlook.com); everything still
//  reads correctly in a client that strips it. The logo and seal PNGs are
//  transparent and drawn only in colours that read on both light and dark
//  backgrounds (STEERING "Brand"), so they need no dark variant.
//
//  Colours are the brand tokens (STEERING "Brand": blue #3452E1 for the
//  single button, ink #14161F for text) plus the email-only neutrals below.
// ─────────────────────────────────────────

const BRAND_BLUE = '#3452E1';
const INK = '#14161F';
const PAPER = '#FFFFFF';
// Email-only neutrals: the soft off-white page, secondary text, hairlines and
// the code panel. Muted text is 5.6:1 on white.
const PAGE = '#F6F5F2';
const MUTED = '#5C6070';
const RULE = '#E6E4DF';
const PANEL = '#F6F5F2';
// Dark-mode overrides (only where a client honours the media query).
const DARK_PAGE = '#121318';
const DARK_CARD = '#1C1E26';
const DARK_INK = '#ECEDF2';
const DARK_MUTED = '#A9ACB9';
const DARK_RULE = '#30333E';
const DARK_PANEL = '#262833';

const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

export const EMAIL_LOGO_PATH = '/brand/e-velope-logo-email.png';
export const EMAIL_SEAL_PATH = '/brand/e-velope-seal-email.png';

// Marks the root of every email rendered here; tests use it to prove a
// message went through this layout.
export const EMAIL_LAYOUT_MARKER = 'data-eg-email-layout="1"';

export const EMAIL_FOOTER_LINE = 'Sent with e-velope · e-velope.co.za';

export type EmailBlock =
  // The wax seal: invitation emails only.
  | { kind: 'seal' }
  // A small line above the title ("You've received an e-velope").
  | { kind: 'eyebrow'; text: string }
  // The large serif heading (an event name, "Your sign-in code").
  | { kind: 'title'; text: string }
  | { kind: 'paragraph'; text: string; muted?: boolean }
  // Full-bleed image across the 600px card. `width`/`height` are the
  // source's own dimensions, used only for the aspect ratio.
  | { kind: 'image'; src: string; alt: string; width: number | null; height: number | null }
  // Labelled groups of lines (one per invited day).
  | { kind: 'details'; groups: { heading: string | null; lines: string[] }[] }
  // A one-time code, large and spaced.
  | { kind: 'code'; text: string }
  // The single call to action.
  | { kind: 'button'; label: string; href: string };

export interface EmailContent {
  subject: string;
  // The hidden preview line inbox lists show after the subject.
  preheader: string;
  blocks: EmailBlock[];
  // Why the reader got this email, shown under the footer line.
  reason: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const CARD_WIDTH = 600;
const SIDE = 40;

const row = (inner: string, padding = `0 ${SIDE}px`): string =>
  `<tr><td class="eg-pad" style="padding:${padding};">${inner}</td></tr>`;

const blockHtml = (block: EmailBlock): string => {
  switch (block.kind) {
    case 'seal':
      return row(
        `<img src="${escapeHtml(frontendUrl(EMAIL_SEAL_PATH))}" width="64" height="64" alt="" ` +
          `style="display:block;margin:0 auto;border:0;outline:none;width:64px;height:64px;">`,
        `0 ${SIDE}px 20px`
      );
    case 'eyebrow':
      return row(
        `<p class="eg-muted" style="margin:0;font-family:${SANS};font-size:15px;line-height:1.5;color:${MUTED};text-align:center;">${escapeHtml(block.text)}</p>`,
        `0 ${SIDE}px 8px`
      );
    case 'title':
      return row(
        `<h1 class="eg-ink" style="margin:0;font-family:${SERIF};font-size:32px;line-height:1.25;font-weight:normal;color:${INK};text-align:center;">${escapeHtml(block.text)}</h1>`,
        `0 ${SIDE}px 24px`
      );
    case 'paragraph':
      return row(
        `<p class="${block.muted ? 'eg-muted' : 'eg-ink'}" style="margin:0;font-family:${SANS};font-size:${block.muted ? 14 : 16}px;line-height:1.6;color:${block.muted ? MUTED : INK};text-align:center;">${escapeHtml(block.text)}</p>`,
        `0 ${SIDE}px 20px`
      );
    case 'image': {
      const height = block.width && block.height ? Math.round((CARD_WIDTH * block.height) / block.width) : null;
      return row(
        `<img src="${escapeHtml(block.src)}" width="${CARD_WIDTH}"${height ? ` height="${height}"` : ''} alt="${escapeHtml(block.alt)}" ` +
          `style="display:block;border:0;outline:none;width:100%;max-width:${CARD_WIDTH}px;height:auto;">`,
        '0 0 28px'
      );
    }
    case 'details': {
      const groups = block.groups.map((group, i) => {
        const heading = group.heading
          ? `<p class="eg-ink" style="margin:0 0 4px;font-family:${SANS};font-size:15px;line-height:1.5;font-weight:bold;color:${INK};">${escapeHtml(group.heading)}</p>`
          : '';
        const lines = group.lines
          .map((line) => `<p class="eg-ink" style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(line)}</p>`)
          .join('');
        const border = i > 0 ? `border-top:1px solid ${RULE};` : '';
        return `<tr><td class="eg-rule" style="padding:${i > 0 ? 16 : 0}px 0 ${i < block.groups.length - 1 ? 16 : 0}px;${border}text-align:center;">${heading}${lines}</td></tr>`;
      });
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${groups.join('')}</table>`,
        `0 ${SIDE}px 28px`
      );
    }
    case 'code':
      return row(
        `<p class="eg-panel eg-ink" style="margin:0;padding:20px 12px;background-color:${PANEL};border-radius:8px;font-family:${MONO};font-size:34px;line-height:1;font-weight:bold;letter-spacing:10px;color:${INK};text-align:center;">${escapeHtml(block.text)}</p>`,
        `0 ${SIDE}px 20px`
      );
    case 'button':
      return row(
        `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">` +
          `<tr><td align="center" bgcolor="${BRAND_BLUE}" style="border-radius:8px;background-color:${BRAND_BLUE};">` +
          `<a href="${escapeHtml(block.href)}" target="_blank" class="eg-button" style="display:inline-block;padding:15px 34px;font-family:${SANS};font-size:16px;line-height:1.2;font-weight:bold;color:${PAPER};text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a>` +
          `</td></tr></table>`,
        `4px ${SIDE}px 28px`
      );
  }
};

const blockText = (block: EmailBlock): string | null => {
  switch (block.kind) {
    case 'seal':
      return null;
    case 'eyebrow':
    case 'title':
    case 'paragraph':
    case 'code':
      return block.text;
    case 'image':
      return block.alt ? `[${block.alt}]` : null;
    case 'details':
      return block.groups.map((g) => [g.heading, ...g.lines].filter((l): l is string => !!l).join('\n')).join('\n\n');
    case 'button':
      return `${block.label}:\n${block.href}`;
  }
};

// Hidden preview text, padded with zero-width spaces so the inbox preview
// doesn't run on into the first words of the body.
const preheaderHtml = (text: string): string =>
  `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};opacity:0;">` +
  `${escapeHtml(text)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`;

const DARK_STYLES = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .eg-page { background-color: ${DARK_PAGE} !important; }
    .eg-card { background-color: ${DARK_CARD} !important; }
    .eg-ink { color: ${DARK_INK} !important; }
    .eg-muted { color: ${DARK_MUTED} !important; }
    .eg-rule { border-color: ${DARK_RULE} !important; }
    .eg-panel { background-color: ${DARK_PANEL} !important; }
    .eg-button { color: ${PAPER} !important; }
  }
  [data-ogsc] .eg-ink { color: ${DARK_INK} !important; }
  [data-ogsc] .eg-muted { color: ${DARK_MUTED} !important; }
  [data-ogsb] .eg-page { background-color: ${DARK_PAGE} !important; }
  [data-ogsb] .eg-card { background-color: ${DARK_CARD} !important; }
  [data-ogsb] .eg-panel { background-color: ${DARK_PANEL} !important; }
  @media only screen and (max-width: 620px) {
    .eg-pad { padding-left: 24px !important; padding-right: 24px !important; }
  }
`;

export const renderEmail = (content: EmailContent): RenderedEmail => {
  const logo = frontendUrl(EMAIL_LOGO_PATH);

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.subject)}</title>
<style>${DARK_STYLES}</style>
</head>
<body class="eg-page" style="margin:0;padding:0;background-color:${PAGE};">
${preheaderHtml(content.preheader)}
<table role="presentation" class="eg-page" ${EMAIL_LAYOUT_MARKER} width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE};">
<tr><td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${CARD_WIDTH}px;">
<tr><td align="center" style="padding:0 0 24px;">
<img src="${escapeHtml(logo)}" width="200" height="45" alt="e-velope" style="display:block;margin:0 auto;border:0;outline:none;width:200px;height:auto;font-family:${SANS};font-size:20px;color:${BRAND_BLUE};">
</td></tr>
<tr><td class="eg-card" style="background-color:${PAPER};border-radius:12px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:44px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
${content.blocks.map(blockHtml).join('\n')}
<tr><td style="padding:0 0 16px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
</td></tr>
<tr><td align="center" class="eg-pad" style="padding:24px ${SIDE}px 0;">
<p class="eg-muted" style="margin:0 0 4px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">${escapeHtml(EMAIL_FOOTER_LINE)}</p>
<p class="eg-muted" style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">${escapeHtml(content.reason)}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  const text = [
    'e-velope',
    ...content.blocks.map(blockText).filter((t): t is string => t !== null),
    `--\n${EMAIL_FOOTER_LINE}\n${content.reason}`,
  ].join('\n\n') + '\n';

  return { html, text };
};
