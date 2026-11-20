// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import en from '../i18n/locales/en.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as string,
  }),
}));

import PasswordRules from './PasswordRules';

afterEach(cleanup);

describe('PasswordRules', () => {
  it('shows an unmet rule as not met, with a cross and no tick', () => {
    const { container } = render(<PasswordRules rules={[{ label: 'One number', valid: false }]} />);
    const li = screen.getByText('One number').closest('li')!;
    expect(li.textContent).toContain('not met');
    expect(li.querySelector('.lucide-x')).not.toBeNull();
    expect(container.querySelector('.lucide-check')).toBeNull();
  });

  it('shows a met rule with a tick and the text met', () => {
    const { container } = render(<PasswordRules rules={[{ label: 'One number', valid: true }]} />);
    const li = screen.getByText('One number').closest('li')!;
    expect(li.textContent).toMatch(/met$/);
    expect(li.textContent).not.toContain('not met');
    expect(container.querySelector('.lucide-check')).not.toBeNull();
    expect(container.querySelector('.lucide-x')).toBeNull();
  });
});
