import { describe, it, expect } from 'vitest';
import { normalizePhoneToE164, resolvePhoneCountry } from '../../src/modules/guest/guest-validation.util.js';
import { validateImportRows } from '../../src/modules/guest/guest-import.engine.js';
import { smsDestinationFor } from '../../src/shared/messaging/sms-number.util.js';

// ─────────────────────────────────────────
//  PHONE NUMBERS — every number saved in international form (+27…): a
//  number without a country code is read in the selected country
//  (phoneCountry), South Africa by default; one with a country code keeps
//  it. An invalid one is refused with a code. Spreadsheet imports follow the
//  same rule. A text goes only to a South African mobile number.
// ─────────────────────────────────────────

const refusedWith = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toMatchObject({ code });
    return;
  }
  throw new Error(`expected a refusal with ${code}`);
};

describe('normalising a phone number', () => {
  it('a South African number however it is written becomes +27…', () => {
    for (const raw of ['0821234567', '082 123 4567', '082-123-4567', '27821234567', '0027 82 123 4567', '+27 82 123 4567', '+27 (0)82 123 4567', '+270821234567']) {
      expect(normalizePhoneToE164(raw), raw).toBe('+27821234567');
    }
  });

  it('a number without a country code is read in the selected country', () => {
    expect(normalizePhoneToE164('07911 123456', resolvePhoneCountry('gb'))).toBe('+447911123456');
    // ZA by default: the same digits aren't a South African number.
    refusedWith(() => normalizePhoneToE164('07911 123456'), 'CONTACT_PHONE_INVALID');
  });

  it('a number with a country code keeps it, whatever is selected', () => {
    expect(normalizePhoneToE164('+44 7911 123456')).toBe('+447911123456');
    expect(normalizePhoneToE164('0044 7911 123456')).toBe('+447911123456');
    expect(normalizePhoneToE164('+27 82 123 4567', resolvePhoneCountry('GB'))).toBe('+27821234567');
  });

  it('an invalid number or country is refused with a code', () => {
    refusedWith(() => normalizePhoneToE164('082555'), 'CONTACT_PHONE_INVALID');
    refusedWith(() => normalizePhoneToE164('call me'), 'CONTACT_PHONE_INVALID');
    refusedWith(() => normalizePhoneToE164('+27 82 555'), 'CONTACT_PHONE_INVALID');
    refusedWith(() => resolvePhoneCountry('XX'), 'CONTACT_PHONE_COUNTRY_INVALID');
    refusedWith(() => resolvePhoneCountry(27), 'CONTACT_PHONE_COUNTRY_INVALID');
    expect(resolvePhoneCountry(undefined)).toBe('ZA');
    expect(resolvePhoneCountry('')).toBe('ZA');
  });
});

describe('spreadsheet import', () => {
  const day = { id: 'day-1', label: 'Day 1' };
  const row = (rowNumber: number, contactRaw: string) => ({
    rowNumber, firstNameRaw: 'A', surnameRaw: 'B', contactRaw, dayRaw: '', plusOnesAllowedRaw: '',
  });

  it('local South African numbers are imported as +27…; invalid ones are refused with a code', () => {
    const result = validateImportRows([row(2, '082 123 4567'), row(3, '27731234567'), row(4, '082555')], [day], []);
    expect(result.validRows.map((r) => r.phoneNumber)).toEqual(['+27821234567', '+27731234567']);
    expect(result.failures).toEqual([{ row: 4, contact: '082555', reason: "'082555' is not a valid phone number", code: 'CONTACT_PHONE_INVALID' }]);
  });

  it('the upload’s country applies to numbers without a country code', () => {
    const result = validateImportRows([row(2, '07911 123456'), row(3, '+27 82 123 4567')], [day], [], { phoneCountry: 'GB' });
    expect(result.validRows.map((r) => r.phoneNumber)).toEqual(['+447911123456', '+27821234567']);
  });
});

describe('who can be texted', () => {
  it('a South African mobile number, normalised', () => {
    expect(smsDestinationFor('+27825551234')).toEqual({ ok: true, e164: '+27825551234' });
    expect(smsDestinationFor('082 555 1234')).toEqual({ ok: true, e164: '+27825551234' });
  });

  it('anything else is refused with a code', () => {
    expect(smsDestinationFor('+27215551234')).toMatchObject({ ok: false, code: 'SMS_NUMBER_NOT_MOBILE' });
    expect(smsDestinationFor('+447911123456')).toMatchObject({ ok: false, code: 'SMS_NUMBER_NOT_SOUTH_AFRICAN' });
    expect(smsDestinationFor('12345')).toMatchObject({ ok: false, code: 'SMS_NUMBER_INVALID' });
    expect(smsDestinationFor(null)).toMatchObject({ ok: false, code: 'SMS_NUMBER_INVALID' });
  });
});
