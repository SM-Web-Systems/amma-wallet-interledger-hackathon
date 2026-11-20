-- Run only through migrate-key-escrow.ts, in one transaction.
-- Sealed (encrypted) recovery phrases and keys that Amma can open through its master key.
-- Nothing here is readable without the master key; the table holds no plaintext.
CREATE TABLE IF NOT EXISTS wallet_key_escrow (
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('phrase','stellar-secret')),
 sealed text NOT NULL CHECK (length(sealed) BETWEEN 40 AND 4096),
 provider text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, kind)
);
