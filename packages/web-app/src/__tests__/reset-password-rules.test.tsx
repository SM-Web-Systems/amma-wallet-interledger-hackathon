// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../i18n/locales/en.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as string,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import ResetPasswordPage from '../pages/ResetPassword';

afterEach(cleanup);

function renderPage() {
  render(<MemoryRouter initialEntries={['/reset-password?token=abc']}><ResetPasswordPage /></MemoryRouter>);
}

describe('Reset password rules', () => {
  it('shows all rules as not met, with crosses and no ticks, while the fields are empty', () => {
    renderPage();
    expect(screen.getAllByText(/^, not met$/i).length).toBe(5);
    expect(document.querySelectorAll('li .lucide-check').length).toBe(0);
    expect(document.querySelectorAll('li .lucide-x').length).toBe(5);
  });

  it('does not accept a password without a lowercase letter', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Enter new password'), { target: { value: 'ABCDEFG1' } });
    expect(screen.getByText('One lowercase letter').closest('li')!.textContent).toContain(', not met');
  });

  it('ticks a rule only once it is met', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Enter new password'), { target: { value: 'Abcdefg1' } });
    expect(screen.getAllByText(/^, met$/i).length).toBe(4);
    expect(screen.getAllByText(/^, not met$/i).length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), { target: { value: 'Abcdefg1' } });
    expect(screen.queryAllByText(/^, not met$/i).length).toBe(0);
  });
});
