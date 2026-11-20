// South African numbers are usually typed as 0 + 9 digits (082 123 4567).
// The server only accepts +27..., so turn that form into +27 + the 9 digits.
// A leading 00 (international prefix) becomes +. Anything else (already +,
// other lengths, other countries) is returned unchanged.
export function localZaToE164(input: string): string {
  const compact = input.replace(/[\s\-().]/g, "");
  const intl = /^00(\d+)$/.exec(compact);
  if (intl) return `+${intl[1]}`;
  const m = /^0(\d{9})$/.exec(compact);
  return m ? `+27${m[1]}` : input;
}
