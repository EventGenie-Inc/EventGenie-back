import { CANVAS_PATH_MAX_BYTES } from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  PATH DATA — what a path element may draw with, in the document and in
//  the SVG alike (STEERING "Invitation designs").
//
//  Only the standard SVG path commands, either case:
//    M L T (2 numbers each)  H V (1)  C (6)  S Q (4)  A (7)  Z (none)
//  and numbers (an optional sign, digits, an optional decimal part and
//  exponent). Nothing else: no other letters, no brackets, quotes, colons
//  or semicolons, so no url(), no javascript: and no CSS can ride on it.
// ─────────────────────────────────────────

const ARGS: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };

const isCommand = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 1 && Object.prototype.hasOwnProperty.call(ARGS, value.toUpperCase());

// The document's form, Fabric's own: [["M", 20, 0], ["C", 31, 0, 40, 9, 40, 20], ["Z"]].
// One command per segment, with exactly its numbers (Fabric writes it so).
export const isFabricPathData = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (segment) =>
      Array.isArray(segment) &&
      isCommand(segment[0]) &&
      segment.length === 1 + ARGS[(segment[0] as string).toUpperCase()]! &&
      segment.slice(1).every((n) => typeof n === 'number' && Number.isFinite(n))
  );

// The SVG's form, a `d` string: "M 20 0 C 31 0 40 9 40 20 Z". Commands and
// numbers separated by spaces or commas (or nothing, as SVG allows between
// a command and a number, and before a sign or a point).
const TOKEN = /\s*,?\s*([MLHVCSQTAZmlhvcsqtaz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

export const isSvgPathData = (value: string): boolean => {
  if (Buffer.byteLength(value, 'utf8') > CANVAS_PATH_MAX_BYTES) return false;
  const text = value.trim();
  if (text.length === 0) return false;
  TOKEN.lastIndex = 0;
  let tokens = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match) return false;
    tokens += 1;
    if (tokens === 1 && !isCommand(match[1])) return false;
  }
  return /^[\s,]*$/.test(text.slice(TOKEN.lastIndex));
};
