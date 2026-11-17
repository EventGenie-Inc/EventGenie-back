// ─────────────────────────────────────────
//  SMS SEGMENT MATH AND GSM TEXT
//
//  Carriers bill per SEGMENT (SMSPortal: "parts"), not per message. A
//  message using only the GSM 03.38 alphabet fits 160 characters in one
//  segment (153 per segment once it spans more than one); a single
//  character outside it — an emoji, a curly apostrophe pasted from a phone
//  keyboard — switches the WHOLE message to UCS-2, which fits only 70 (67
//  per segment once multipart). So the difference between one bill and
//  three can be one apostrophe.
//
//  Every text we send is made of GSM characters only (toGsmText), and its
//  length is measured in septets (gsmLength: an extension character such as
//  € or [ costs two), so "fits in 160" is what the carrier counts.
//
//  Pure functions, no domain concepts — sits beside the engines.
// ─────────────────────────────────────────

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// Reachable only through an escape septet, so each costs two.
const GSM_EXTENDED = '\f^{}\\[~]|€';

// One SMS: 160 GSM septets.
export const SMS_SINGLE_PART_LIMIT = 160;

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

// Swaps the typographic punctuation phone keyboards and word processors
// insert for its plain equivalent: quotes and apostrophes (curly, low,
// primes), dashes and hyphens of every width, the ellipsis, bullets and
// the odd spaces. Lossless in meaning, and it is the most common reason an
// otherwise-ordinary English message balloons into UCS-2.
export const normalizeSmsPunctuation = (text: string): string =>
  text
    .replace(/[‘’‚‛′‵ʼ`´]/g, "'")
    .replace(/[“”„‟″‶«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/[  -   　]/g, ' ')
    .replace(/[​-‍⁠﻿]/g, '');

const isGsmChar = (char: string): boolean => GSM_BASIC.includes(char) || GSM_EXTENDED.includes(char);

// Text an SMS can carry in GSM-7, whatever was typed: typographic
// punctuation made plain, a letter outside GSM written without its accent
// where that gives a GSM letter (ç, ô, ã → c, o, a), and anything else
// (emoji, symbols, other scripts) left out. Runs of spaces become one, line
// breaks become spaces (a name never needs one), and the ends are trimmed.
export const toGsmText = (text: string): string => {
  let out = '';
  for (const char of normalizeSmsPunctuation(text)) {
    if (char === '\n' || char === '\r' || char === '\t') {
      out += ' ';
    } else if (isGsmChar(char)) {
      out += char;
    } else {
      const folded = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (folded && [...folded].every(isGsmChar)) out += folded;
    }
  }
  return out.replace(/ {2,}/g, ' ').trim();
};

// The length a carrier counts for GSM text: septets, two for an extension
// character. Only meaningful for text toGsmText has made GSM.
export const gsmLength = (text: string): number => {
  let septets = 0;
  for (const char of text) septets += GSM_EXTENDED.includes(char) ? 2 : 1;
  return septets;
};

// GSM text cut to at most `max` septets, ending in "..." when cut (never
// mid-way through an extension character's two septets).
export const truncateGsm = (text: string, max: number): string => {
  if (gsmLength(text) <= max) return text;
  if (max <= 0) return '';
  if (max <= 3) return '...'.slice(0, max);
  let out = '';
  let used = 0;
  for (const char of text) {
    const cost = GSM_EXTENDED.includes(char) ? 2 : 1;
    if (used + cost > max - 3) break;
    out += char;
    used += cost;
  }
  return `${out.trimEnd()}...`;
};
