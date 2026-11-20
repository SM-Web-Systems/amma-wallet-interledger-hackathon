// The phone tab bar (Layout) shows four shortcuts. On a chain page (XRP,
// Ethereum) Send and Receive must act on that chain, not on Stellar, so the
// tabs are derived from the current path.

export type QuickTabKey = "home" | "send" | "receive" | "swap" | "stellar";

export interface QuickTab {
  key: QuickTabKey;
  to: { pathname: string; hash?: string };
  isActive: (pathname: string, hash: string) => boolean;
}

/** Chain pages that have their own send and receive sections (`#send`, `#receive`). */
export const CHAIN_PAGES = ["/xrpl", "/ethereum-sepolia"] as const;

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

function chainFor(pathname: string): string | undefined {
  const path = trim(pathname);
  return CHAIN_PAGES.find((page) => path === page || path.startsWith(`${page}/`));
}

export function quickTabsFor(pathname: string): QuickTab[] {
  const chain = chainFor(pathname);
  if (!chain) {
    const route = (key: QuickTabKey, to: string): QuickTab => ({
      key,
      to: { pathname: to },
      isActive: (p) => trim(p) === to || trim(p).startsWith(`${to}/`),
    });
    return [route("home", "/dashboard"), route("send", "/send"), route("receive", "/receive"), route("swap", "/swap")];
  }
  const onChain = (p: string) => chainFor(p) === chain;
  const section = (key: "send" | "receive"): QuickTab => ({
    key,
    to: { pathname: chain, hash: key },
    isActive: (p, h) => onChain(p) && h === `#${key}`,
  });
  return [
    { key: "home", to: { pathname: chain }, isActive: (p, h) => onChain(p) && h !== "#send" && h !== "#receive" },
    section("send"),
    section("receive"),
    { key: "stellar", to: { pathname: "/dashboard" }, isActive: (p) => trim(p) === "/dashboard" },
  ];
}
