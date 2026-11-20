import { useState } from "react";

interface PinModalProps {
  title: string;
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
  /** Amma holds the wallet: ask for the Amma login password instead of the wallet passphrase. */
  accountPassword?: boolean;
}

export default function PinModal({ title, onSubmit, onCancel, accountPassword = false }: PinModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (accountPassword ? pin.length < 1 : pin.length < 6) {
      setError(accountPassword ? "Enter your Amma login password" : "Enter your wallet passphrase");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onSubmit(pin);
    } catch (err: any) {
      setError(err.message || (accountPassword ? "That password is not correct" : "Incorrect wallet passphrase"));
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
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder={accountPassword ? "Amma login password" : "Wallet passphrase"}
          aria-label={accountPassword ? "Amma login password" : "Wallet passphrase"}
          autoComplete={accountPassword ? "current-password" : "off"}
          aria-describedby="passphrase-hint"
          autoFocus
          className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-white placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
        />
        <p id="passphrase-hint" className="text-xs text-stellar-muted">{accountPassword ? "Amma holds this wallet. Your sign-in password approves it." : "This is your wallet passphrase, not your sign-in password."}</p>
        {error && <p className="text-sm text-stellar-danger">{error}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg border border-stellar-border text-stellar-muted hover:text-white transition-colors"
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
