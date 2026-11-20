import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const en = readFileSync(resolve(__dirname, '../i18n/locales/en.json'), 'utf-8');
const help = readFileSync(resolve(__dirname, '../pages/Help.tsx'), 'utf-8');

describe('sign-up copy (WA-06)', () => {
  it('never tells users to fund their wallet or use friendbot', () => {
    for (const text of [en, help]) {
      expect(text).not.toMatch(/fund your (wallet|account)/i);
      expect(text).not.toMatch(/friendbot/i);
      expect(text).not.toMatch(/creating & funding/i);
    }
  });
  it('tells an empty Amma wallet to finish a partner task', () => {
    expect(JSON.parse(en).dashboard.notActivated).toBe('Your wallet is not active yet. Finish your first task with the partner that sent you here, for example a course in the LMS. We then switch it on.');
  });
});
