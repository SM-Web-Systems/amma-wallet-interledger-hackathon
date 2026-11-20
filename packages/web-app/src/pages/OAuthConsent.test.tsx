import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), getAccessToken: () => "tok" }));
import "../i18n";
import OAuthConsent from "./OAuthConsent";

const REDIRECT = "https://crm.example.com/callback";
const EVIL = "https://evil.example/amma-login";
const CONSENT = { action: "consent_required", client_name: "CRM", client_id: "crm", scopes: "openid", redirect_uri: REDIRECT, state: "s1", code_challenge: "", code_challenge_method: "" };
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let authorize: () => unknown;
const fetchMock = vi.fn(async (url: string) => {
  if (new URL(url, "http://amma.test").pathname === "/api/v1/oauth/authorize") return authorize();
  throw new Error(`unexpected fetch ${url}`);
});
let assign: ReturnType<typeof vi.fn>;
const original = window.location;

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { search: "", assign } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: original });
});

// The browser query deliberately names a different redirect_uri than the one the server validated.
const open = () =>
  render(
    <MemoryRouter initialEntries={[`/oauth/authorize?client_id=crm&response_type=code&state=s1&redirect_uri=${encodeURIComponent(EVIL)}`]}>
      <Routes>
        <Route path="/oauth/authorize" element={<OAuthConsent />} />
        <Route path="/dashboard" element={<p>Dashboard page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe("OAuth consent page", () => {
  it("Deny follows the redirect_uri the server validated, never the one in the page query", async () => {
    authorize = () => reply(200, CONSENT);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=s1`));
    expect(assign.mock.calls.flat().join(" ")).not.toContain("evil.example");
  });

  it("Deny without a server-validated app goes to the dashboard and does not follow the query", async () => {
    authorize = () => reply(400, { error: "invalid_request", error_description: "redirect_uri does not match any registered URI" });
    open();
    await screen.findByText("This sign-in link is not valid. Go back to the app and try again.");
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Return to Dashboard" }));
    expect(await screen.findByText("Dashboard page")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a plain message and no raw error code when the app is unknown", async () => {
    authorize = () => reply(400, { error: "invalid_client", error_description: "Unknown client_id" });
    open();
    expect(await screen.findByText("This app is not registered with Amma.")).toBeInTheDocument();
    expect(screen.queryByText(/invalid_client|Unknown client_id|Error 400/)).toBeNull();
  });

  it.each([
    [reply(400, { error: "invalid_scope", error_description: "Unknown scope: evil-text" }), "This app asked for access that Amma does not allow."],
    [reply(401, { error: "invalid_token" }), "Your Amma session has ended. Sign in again, then retry from the app."],
    [reply(500, { error: "server_error", error_description: "db down" }), "Something went wrong while connecting this app. Try again from the app."],
  ])("maps a server error to its plain sentence", async (response, sentence) => {
    authorize = () => response;
    open();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(/invalid_|server_error|db down|evil-text|Error \d{3}/)).toBeNull();
  });

  it("shows a plain message when the server cannot be reached", async () => {
    authorize = () => { throw new Error("Failed to fetch"); };
    open();
    expect(await screen.findByText("Amma could not be reached. Check your connection and try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it("labels known scopes in plain words and never hides an unknown one", async () => {
    authorize = () => reply(200, { ...CONSENT, scopes: "openid profile email wallet:read mystery:thing" });
    open();
    expect(await screen.findByText("Verify your identity")).toBeInTheDocument();
    expect(screen.getByText("Other account access (wallet:read)")).toBeInTheDocument();
    expect(screen.getByText("Other account access (mystery:thing)")).toBeInTheDocument();
  });

  it("does not promise a settings screen that does not exist", async () => {
    authorize = () => reply(200, CONSENT);
    open();
    await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByText(/account settings/i)).toBeNull();
    expect(screen.getByText("To stop sharing, contact CRM or Amma support.")).toBeInTheDocument();
  });

  it("falls back to 'the app' in the footer when the app has no name", async () => {
    authorize = () => reply(200, { ...CONSENT, client_name: "" });
    open();
    await screen.findByRole("button", { name: "Approve" });
    expect(screen.getByText("To stop sharing, contact the app or Amma support.")).toBeInTheDocument();
  });

  it("gives the error page a real h1", async () => {
    authorize = () => reply(400, { error: "invalid_client" });
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "This sign-in request did not work" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This app is not registered with Amma.");
  });
});
