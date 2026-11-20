import { describe, expect, it } from 'vitest';
import { localZaToE164 } from './za-phone';

describe('localZaToE164', () => {
  it.each([
    ['0821234567', '+27821234567'],
    ['082 123 4567', '+27821234567'],
    ['082-123-4567', '+27821234567'],
    ['(082) 123 4567', '+27821234567'],
    ['082.123.4567', '+27821234567'],
    ['00 27 82 123 4567', '+27821234567'],
    ['0027821234567', '+27821234567'],
    ['  082 123 4567  ', '+27821234567'],
  ])('converts %s', (input, expected) => {
    expect(localZaToE164(input)).toBe(expected);
  });

  it('leaves numbers that already start with + untouched', () => {
    expect(localZaToE164('+27 82 123 4567')).toBe('+27 82 123 4567');
    expect(localZaToE164('+44 7700 900123')).toBe('+44 7700 900123');
  });

  it.each(['082123456', '08212345678', '0821234abc', '27821234567', '821234567', '', 'a@b.com'])(
    'leaves %j unchanged',
    (input) => {
      expect(localZaToE164(input)).toBe(input);
    },
  );
});
