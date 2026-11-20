import { useState } from "react";

interface PinModalProps {
  title: string;
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
  /** Ask for the Amma account password (Amma-held wallets) instead of the wallet passphrase or PIN. */
  accountPassword?: boolean;
}

export default function PinModal({ title, onSubmit, onCancel, accountPassword = false }: PinModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Older wallets still unlock with their 6+ character PIN; new ones use a 12+ character passphrase.
    if (accountPassword ? pin.length < 1 : pin.length < 6) {
      setError(accountPassword ? "Enter your Amma password" : "Enter your wallet passphrase");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onSubmit(pin);
    } catch (err: any) {
      setError(err.message || "Incorrect wallet passphrase");
    } finally {
      if (accountPassword) setPin("");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="bg-stellar-card border border-stellar-border rounded-2xl p-8 w-full max-w-sm space-y-4"
      >
        <h2 className="text-lg font-semibold text-stellar-text">{title}</h2>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder={accountPassword ? "Your Amma password" : "Wallet passphrase"}
          aria-label={accountPassword ? "Your Amma password" : "Wallet passphrase"}
          aria-describedby={error ? "pin-error" : accountPassword ? undefined : "passphrase-hint"}
          aria-invalid={error ? true : undefined}
          autoComplete="current-password"
          autoFocus
          className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
        />
        {!accountPassword && <p id="passphrase-hint" className="text-xs text-stellar-muted">This is your wallet passphrase, not your sign-in password.</p>}
        {error && <p id="pin-error" role="alert" className="text-sm text-stellar-danger-text">{error}</p>}
        {!accountPassword && <a href="/recover" className="block text-center text-xs text-stellar-muted underline">Forgot your passphrase?</a>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50"
          >
            {loading ? "..." : "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}
