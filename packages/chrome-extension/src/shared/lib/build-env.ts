// G-09: a build must say which API it talks to. No silent fallback to the production host.
export function requireApiUrl(value: string | undefined): string {
  const url = (value ?? "").trim();
  if (!url) {
    throw new Error(
      "VITE_API_URL is required to build the extension. Set it to the API this build should use (for a test build, the testnet API)."
    );
  }
  return url;
}
