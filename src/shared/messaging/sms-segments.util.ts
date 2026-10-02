// ─────────────────────────────────────────
//  SMS SEGMENT MATH
//
//  Carriers bill per SEGMENT, not per message. A message using only the
//  GSM 03.38 alphabet fits 160 characters in one segment (153 per segment
//  once it spans more than one); a single character outside it — an emoji,
//  a curly apostrophe pasted from a phone keyboard — switches the WHOLE
//  message to UCS-2, which fits only 70 (67 per segment once multipart).
//  So the difference between one bill and three can be one apostrophe.
//
//  Pure functions, no domain concepts — sits beside the engines.
// ─────────────────────────────────────────

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// Reachable only through an escape septet, so each costs two.
const GSM_EXTENDED = '\f^{}\\[~]|€';

export interface SmsSegmentCount {
  encoding: 'GSM-7' | 'UCS-2';
  // Characters for GSM-7 (extended characters count double); UTF-16 code
  // units for UCS-2 — the units a carrier actually counts against the limit.
  units: number;
  segments: number;
}

export const countSmsSegments = (text: string): SmsSegmentCount => {
  let septets = 0;
  let gsmOnly = true;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) septets += 1;
    else if (GSM_EXTENDED.includes(char)) septets += 2;
    else {
      gsmOnly = false;
      break;
    }
  }

  if (gsmOnly) {
    return { encoding: 'GSM-7', units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  const units = text.length;
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
};

// Swaps the typographic punctuation phone keyboards insert automatically
// for its plain ASCII equivalent. Lossless in meaning, and it is the most
// common reason an otherwise-ordinary English message balloons into UCS-2.
export const normalizeSmsPunctuation = (text: string): string =>
  text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
