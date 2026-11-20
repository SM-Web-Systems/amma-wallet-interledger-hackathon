/** G-19: Send form checks that name the field at fault, and the server's wrong-passphrase answer. */
export type SendErrors = { destination?: string; amount?: string };
type Translate = (key: string, fallback: string) => string;

export function validateSend(
  input: { destination: string; amount: string },
  isValidAddress: (address: string) => boolean,
  t: Translate,
): SendErrors {
  const errors: SendErrors = {};
  if (!input.destination.trim()) errors.destination = t("send.destinationRequired", "Enter the address you are sending to.");
  else if (!isValidAddress(input.destination.trim())) errors.destination = t("send.invalidAddress", "Invalid Stellar address");

  if (!input.amount.trim()) errors.amount = t("send.amountRequired", "Enter an amount.");
  else if (!(Number(input.amount) > 0)) errors.amount = t("send.amountPositive", "Enter an amount greater than zero.");
  return errors;
}

/** The sign-and-submit route answers a failed unlock with one fixed sentence; older servers said "Invalid PIN". */
export function isWrongPassphrase(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return /incorrect wallet passphrase|wallet passphrase is not correct|invalid pin/i.test(message);
}
