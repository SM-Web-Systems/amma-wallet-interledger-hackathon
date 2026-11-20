import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../test/msw-server";

// The admin sign-in shows the Cloudflare check only when the API says it is on, with the site key the API gives,
// and sends the token with the sign-in. A failed sign-in asks for a fresh check (tokens are single-use).
type WidgetProps = { siteKey: string; action?: string; onVerify: (t: string) => void };
const widget = vi.hoisted(() => ({ props: [] as WidgetProps[] }));
vi.mock("../components/Turnstile", () => ({
  Turnstile: (p: WidgetProps) => {
    widget.props.push(p);
    return <button type="button" onClick={() => p.onVerify("tok-" + widget.props.length)}>Complete verification</button>;
  },
}));
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({ ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")), useNavigate: () => mockNavigate }));

import AdminLogin from "./AdminLogin";

const on = () => server.use(http.get("/api/v1/internal/auth/config", () => HttpResponse.json({ turnstile: { enabled: true, siteKey: "0xADMINSITE" } })));
const sent: unknown[] = [];
const capture = (status = 200) =>
  server.use(http.post("/api/v1/internal/auth/login", async ({ request }) => {
    sent.push(await request.json());
    return status === 200
      ? HttpResponse.json({ token: "jwt", expiresIn: 3600, admin: { id: 1, email: "admin@test.com", name: "A", role: "super_admin" } })
      : HttpResponse.json({ error: "Invalid credentials" }, { status });
  }));
const renderLogin = () => render(<MemoryRouter><AdminLogin /></MemoryRouter>);
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/admin email/i), "admin@test.com");
  await user.type(screen.getByLabelText(/^password$/i), "correctPassword");
}

beforeEach(() => { widget.props = []; sent.length = 0; mockNavigate.mockClear(); sessionStorage.clear(); });

describe("AdminLogin with the Cloudflare check", () => {
  it("off: no widget, and the sign-in carries no token", async () => {
    capture();
    const user = userEvent.setup();
    renderLogin();
    await fill(user);
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/admin"));
    expect(screen.queryByRole("button", { name: /complete verification/i })).toBeNull();
    expect(sent[0]).toEqual({ email: "admin@test.com", password: "correctPassword" });
  });

  it("on: shows the widget with the API's site key and the admin-login action", async () => {
    on();
    renderLogin();
    expect(await screen.findByRole("button", { name: /complete verification/i })).toBeInTheDocument();
    expect(widget.props.at(-1)).toMatchObject({ siteKey: "0xADMINSITE", action: "admin-login" });
  });

  it("on: will not send until the check is done, then sends the token", async () => {
    on(); capture();
    const user = userEvent.setup();
    renderLogin();
    await fill(user);
    await screen.findByRole("button", { name: /complete verification/i });
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByText(/complete the verification/i)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /complete verification/i }));
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/admin"));
    expect(sent[0]).toMatchObject({ email: "admin@test.com", turnstileToken: expect.stringMatching(/^tok-/) });
  });

  it("on: after a failed sign-in the old token is dropped and a fresh check is needed", async () => {
    on(); capture(401);
    const user = userEvent.setup();
    renderLogin();
    await fill(user);
    await user.click(await screen.findByRole("button", { name: /complete verification/i }));
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByText(/complete the verification/i)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
  });

  it("a 400 while no widget shows reloads the config and then shows the widget", async () => {
    let calls = 0;
    server.use(http.get("/api/v1/internal/auth/config", () => (++calls === 1
      ? HttpResponse.json({ turnstile: { enabled: false, siteKey: null } })
      : HttpResponse.json({ turnstile: { enabled: true, siteKey: "0xADMINSITE" } }))));
    server.use(http.post("/api/v1/internal/auth/login", () => HttpResponse.json({ error: "Human verification required. Please complete the check." }, { status: 400 })));
    const user = userEvent.setup();
    renderLogin();
    await fill(user);
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("button", { name: /complete verification/i })).toBeInTheDocument();
  });

  it("config unreachable: still shows the form (the server decides)", async () => {
    server.use(http.get("/api/v1/internal/auth/config", () => HttpResponse.error()));
    capture();
    const user = userEvent.setup();
    renderLogin();
    await fill(user);
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
  });
});
