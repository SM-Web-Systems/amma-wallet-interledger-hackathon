import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../test/msw-server";
import BusinessAccount from "./BusinessAccount";

// Self-serve business page: a business enters its API key (kept in memory only) and sees its credits, how to deposit,
// its deposits (credited or held), fees and bundle purchases.
const ADDR = "GBUSINESSWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OVERVIEW = {
  network: "testnet", depositAddress: ADDR, memo: null, firstDeposit: false, accountActive: true,
  credits: { annualCredits: 2, monthlyCredits: 98, fundingXlm: "107.8000000", managementXlm: "30.0000000", registrationFeeWaived: true },
  bundles: [{ slug: "monthly-100", name: "Monthly 100", plan: "monthly", users: 100, sendXlm: "340.0000000" }],
  deposits: [
    { id: 2, receivedAt: "2026-11-18T09:00:00.000Z", amountXlm: "12.5000000", state: "held", heldReason: "no_bundle_matches_amount", bundleSlug: null, plan: null, users: null, feeDueXlm: "0.0000000", txHash: "b".repeat(64) },
    { id: 1, receivedAt: "2026-11-18T08:00:00.000Z", amountXlm: "341.0000000", state: "credited", heldReason: null, bundleSlug: "monthly-100", plan: "monthly", users: 100, feeDueXlm: "200.0000000", txHash: "a".repeat(64) },
  ],
  fees: { onDepositsXlm: "200.0000000", managementXlm: "0.4000000", chargedXlm: "200.4000000", paidXlm: "150.0000000", pendingXlm: "50.0000000", failedXlm: "0.4000000" },
  purchases: [{ id: 1, purchasedAt: "2026-11-18T08:00:01.000Z", bundleSlug: "monthly-100", bundleName: "Monthly 100", amountXlm: "341.0000000", users: 100 }],
};
const seen: (string | null)[] = [];
const respond = (status: number, body: unknown = OVERVIEW) =>
  server.use(http.get("/api/v1/tenant/business/overview", ({ request }) => { seen.push(request.headers.get("x-api-key")); return HttpResponse.json(body, { status }); }));
const renderPage = () => render(<MemoryRouter><BusinessAccount /></MemoryRouter>);
async function open(user: ReturnType<typeof userEvent.setup>, key = "biz-key-123") {
  await user.type(screen.getByLabelText(/business api key/i), key);
  await user.click(screen.getByRole("button", { name: /show my account/i }));
}

beforeEach(() => { seen.length = 0; sessionStorage.clear(); localStorage.clear(); });

describe("Business account page", () => {
  it("asks for the API key and sends it only as the x-api-key header, never storing it", async () => {
    respond(200);
    const user = userEvent.setup();
    renderPage();
    await open(user);
    expect(await screen.findByText(ADDR)).toBeInTheDocument();
    expect(seen).toEqual(["biz-key-123"]);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("biz-key-123");
  });

  it("shows credits, deposit instructions with exact amounts, deposits, fees and purchases", async () => {
    respond(200);
    const user = userEvent.setup();
    renderPage();
    await open(user);
    await screen.findByText(ADDR);
    expect(screen.getByText(/no memo needed/i)).toBeInTheDocument();
    const instructions = screen.getByRole("region", { name: /how to deposit/i });
    expect(within(instructions).getByText("340.0000000")).toBeInTheDocument();
    expect(within(instructions).getByText(/any other amount is held/i)).toBeInTheDocument();
    const credits = screen.getByRole("region", { name: /credits/i });
    expect(within(credits).getByText("98")).toBeInTheDocument();
    expect(within(credits).getByText("107.8000000")).toBeInTheDocument();
    const deposits = screen.getByRole("region", { name: /deposits/i });
    expect(within(deposits).getByText(/^held$/i)).toBeInTheDocument();
    expect(within(deposits).getByText(/does not match a bundle/i)).toBeInTheDocument();
    expect(within(deposits).getByText(/^credited: monthly-100$/i)).toBeInTheDocument();
    const fees = screen.getByRole("region", { name: /fees/i });
    expect(within(fees).getByText("200.4000000")).toBeInTheDocument();
    expect(within(fees).getByText("50.0000000")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /bundle purchases/i })).getByText("Monthly 100 (100 users)")).toBeInTheDocument();
  });

  it("on a first deposit, says the amounts include the one-time extras", async () => {
    respond(200, { ...OVERVIEW, firstDeposit: true, deposits: [], purchases: [] });
    const user = userEvent.setup();
    renderPage();
    await open(user);
    expect(await screen.findByText(/first deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/wait until it shows as credited/i)).toBeInTheDocument();
    expect(screen.getByText(/no deposits yet/i)).toBeInTheDocument();
  });

  it("says plainly when the wallet is not set up yet", async () => {
    respond(200, { ...OVERVIEW, depositAddress: null });
    const user = userEvent.setup();
    renderPage();
    await open(user);
    expect(await screen.findByText(/deposit wallet is not set up yet/i)).toBeInTheDocument();
  });

  it("a suspended business sees no address or amounts, and a resolved deposit is not called held", async () => {
    respond(200, { ...OVERVIEW, accountActive: false, depositAddress: null, bundles: [],
      deposits: [{ ...OVERVIEW.deposits[0], state: "resolved" }] });
    const user = userEvent.setup();
    renderPage();
    await open(user);
    expect(await screen.findByText(/account is suspended/i)).toBeInTheDocument();
    expect(screen.queryByText(/send exactly/i)).toBeNull();
    expect(screen.getByText(/reviewed and settled/i)).toBeInTheDocument();
    expect(screen.queryByText(/we will be in touch/i)).toBeNull();
  });

  it("explains a refused key, and a page that is switched off", async () => {
    respond(403, { error: "Scope funding:read required" });
    const user = userEvent.setup();
    renderPage();
    await open(user, "bad");
    expect(await screen.findByText(/key was not accepted/i)).toBeInTheDocument();
    respond(404, { error: "Not Found" });
    await user.click(screen.getByRole("button", { name: /show my account/i }));
    expect(await screen.findByText(/not available here/i)).toBeInTheDocument();
  });

  it("forgets the key on sign out", async () => {
    respond(200);
    const user = userEvent.setup();
    renderPage();
    await open(user);
    await screen.findByText(ADDR);
    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(screen.queryByText(ADDR)).toBeNull();
    expect(screen.getByLabelText(/business api key/i)).toHaveValue("");
  });
});
