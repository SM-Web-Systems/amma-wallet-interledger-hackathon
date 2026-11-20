import { expect, test } from "@playwright/test";
import { mockApi, signIn, signedOut } from "./mock-api";

// Audit TODO C13: login, dashboard, send, XRP and Ethereum, in both themes.
const PAGES = [
  { name: "login", path: "/login", signedIn: false, shows: /sign in|log in|welcome/i },
  { name: "dashboard", path: "/dashboard", signedIn: true, shows: /total xlm balance|dashboard/i },
  { name: "send", path: "/send", signedIn: true, shows: /send/i },
  { name: "xrp", path: "/xrpl", signedIn: true, shows: /xrp/i },
  { name: "ethereum", path: "/ethereum-sepolia", signedIn: true, shows: /ethereum|sepolia/i },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const p of PAGES) {
    test(`${p.name} renders in ${theme}`, async ({ context, page, baseURL }, info) => {
      await mockApi(context, new URL(baseURL!).origin, { signedIn: p.signedIn });
      await (p.signedIn ? signIn(context, theme) : signedOut(context, theme));
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));

      await page.goto(p.path);
      await page.waitForLoadState("networkidle");

      // Landed where we asked (no redirect to login or dashboard) and in the right theme.
      expect(new URL(page.url()).pathname).toBe(p.path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: p.shows }).first()).toBeVisible();

      // Phone layouts must not scroll sideways.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);

      expect(errors).toEqual([]);
      await page.screenshot({ path: `test-results/visual/${info.project.name}-${theme}-${p.name}.png`, fullPage: true });
    });
  }
}
