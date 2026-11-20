import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { mockApi, signIn, signedOut } from "./mock-api";

// G-17: automated accessibility floor. axe-core (WCAG 2 A and AA, plus best practice) must find nothing on the
// pages people use most, in both themes and on desktop and phone. This is a floor, not a pass against WCAG:
// a keyboard and screen reader review is still needed.
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const PAGES = [
  ["login", false], ["register", false], ["forgot-password", false],
  ["dashboard", true], ["tokens", true], ["send", true], ["receive", true], ["swap", true], ["history", true],
  ["settings", true], ["buy-sell", true], ["help", true], ["contacts", true], ["api-keys", true], ["portfolio", true],
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const [name, signedInPage] of PAGES) {
    test(`${name} has no axe violations in ${theme}`, async ({ context, page, baseURL }) => {
      await mockApi(context, new URL(baseURL!).origin, { signedIn: signedInPage });
      await (signedInPage ? signIn(context, theme) : signedOut(context, theme));
      await page.goto(`/${name}`);
      await page.waitForLoadState("networkidle");
      // The scan must be of the page we meant: a redirect to /login would otherwise pass for the wrong page.
      expect(new URL(page.url()).pathname).toBe(`/${name}`);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.evaluate(AXE);
      const violations = await page.evaluate(async () => {
        // @ts-expect-error axe is injected above
        const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] });
        return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      });
      expect(violations).toEqual([]);
    });
  }
}

// Touch targets: on a phone, the shared header and form controls are at least 44 px.
test("phone header and sign-in controls are at least 44 px", async ({ context, page, baseURL }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await mockApi(context, new URL(baseURL!).origin, { signedIn: true });
  await signIn(context, "dark");
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("main")).toHaveCount(1);
  for (const name of ["Open menu", "Notifications"]) {
    const box = await page.getByRole("button", { name }).first().boundingBox();
    expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  const toggle = await page.getByRole("button", { name: /switch to (dark|light) mode/i }).first().boundingBox();
  expect(toggle?.height).toBeGreaterThanOrEqual(44);
});

// The phone touch-target rule must not stretch controls whose shape is the point: a switch stays a switch.
test("phone: the backup switch keeps its shape", async ({ context, page, baseURL }, info) => {
  test.skip(info.project.name !== "phone");
  await mockApi(context, new URL(baseURL!).origin, { signedIn: true });
  await signIn(context, "light");
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("main")).toHaveCount(1);
  const sw = page.getByRole("switch").first();
  await expect(sw).toBeVisible();
  const box = await sw.boundingBox();
  expect(box?.height).toBeLessThan(30);
  expect(box?.width).toBeGreaterThan(40);
});
