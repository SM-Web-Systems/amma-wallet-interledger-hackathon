import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { server, mockBilling } from "../test/msw-server";
import { http, HttpResponse } from "msw";
import AdminTenantDetail from "./AdminTenantDetail";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function setAuth() {
  sessionStorage.setItem("aw_admin_token", "mock-jwt");
  sessionStorage.setItem("aw_admin_info", JSON.stringify({
    id: 1, email: "admin@test.com", name: "Test Admin", role: "super_admin",
  }));
}

function renderDetail(tenantId = "1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/tenants/${tenantId}`]}>
      <Routes>
        <Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminTenantDetail", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it("redirects to login when no token", () => {
    renderDetail();
    expect(mockNavigate).toHaveBeenCalledWith("/admin/login");
  });

  it("shows loading state then renders billing data", async () => {
    setAuth();
    renderDetail();

    expect(screen.getByText("Loading billing data…")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("ACME Corp")).toBeInTheDocument();
    });
    expect(screen.getByText("500.0000")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("displays policy details", async () => {
    setAuth();
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText("ACME Corp")).toBeInTheDocument();
    });

    expect(screen.getByText("-100.0000000 XLM")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument(); // acquisitionMode
    expect(screen.getByText("30d")).toBeInTheDocument(); // gracePeriod
  });

  it("renders billing events", async () => {
    setAuth();
    renderDetail();

    await waitFor(() => {
      // "Manual top-up" appears both as event label and dropdown option
      const matches = screen.getAllByText("Manual top-up");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("+100.0000 XLM")).toBeInTheDocument();
    expect(screen.getByText("Initial credit")).toBeInTheDocument();
  });

  it("shows empty state when no events", async () => {
    setAuth();
    server.use(
      http.get("/api/v1/internal/tenants/:id/billing", () => {
        return HttpResponse.json({ ...mockBilling, recentEvents: [], eventsHasMore: false });
      }),
    );
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText("No billing events yet.")).toBeInTheDocument();
    });
  });

  // Credit posting tests
  describe("credit posting", () => {
    it("validates empty amount", async () => {
      setAuth();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      // Post credit button should be disabled when no amount
      const postBtn = screen.getByRole("button", { name: /post credit/i });
      expect(postBtn).toBeDisabled();
    });

    it("validates negative amount shows error", async () => {
      setAuth();
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      const amountInput = screen.getByPlaceholderText("e.g. 50");
      await user.type(amountInput, "-5");
      await user.click(screen.getByRole("button", { name: /post credit/i }));

      expect(screen.getByText("Amount must be a positive number (up to 7 decimal places).")).toBeInTheDocument();
    });

    it("opens confirmation dialog before posting", async () => {
      setAuth();
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      const amountInput = screen.getByPlaceholderText("e.g. 50");
      await user.type(amountInput, "100");
      // The form's Post credit button (outside dialog)
      const postBtns = screen.getAllByRole("button", { name: /post credit/i });
      await user.click(postBtns[0]);

      // Confirm dialog should appear
      const dialog = screen.getByRole("dialog", { name: /confirm credit/i });
      expect(within(dialog).getByText(/100\.0000 XLM/)).toBeInTheDocument();
      expect(within(dialog).getByText(/irreversible/i)).toBeInTheDocument();
    });

    it("posts credit after confirmation", async () => {
      setAuth();
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText("e.g. 50"), "100");
      // Click the form's Post credit button to open dialog
      const formPostBtns = screen.getAllByRole("button", { name: /post credit/i });
      await user.click(formPostBtns[0]);

      // Now click the confirm button inside the dialog
      const dialog = screen.getByRole("dialog", { name: /confirm credit/i });
      const dialogPostBtn = within(dialog).getByRole("button", { name: /post credit/i });
      await user.click(dialogPostBtn);

      await waitFor(() => {
        expect(screen.getByText(/XLM posted/)).toBeInTheDocument();
      });
    });

    it("cancels credit confirmation without posting", async () => {
      setAuth();
      let creditCalled = false;
      server.use(
        http.post("/api/v1/internal/tenants/:id/credit", () => {
          creditCalled = true;
          return HttpResponse.json({});
        }),
      );

      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText("e.g. 50"), "100");
      await user.click(screen.getByRole("button", { name: /post credit/i }));

      // Cancel
      await user.click(screen.getByText("Cancel"));

      expect(screen.queryByText("Confirm credit")).not.toBeInTheDocument();
      expect(creditCalled).toBe(false);
    });
  });

  // Suspend/unsuspend tests
  describe("credit retry safety", () => {
    type CreditBody = { amount_xlm: string; notes?: string; idempotency_key: string; type: string };

    async function postCredit(user: ReturnType<typeof userEvent.setup>, amount?: string, notes?: string) {
      await waitFor(() => expect(screen.getByText("ACME Corp")).toBeInTheDocument());
      if (amount !== undefined) await user.type(screen.getByPlaceholderText("e.g. 50"), amount);
      if (notes !== undefined) await user.type(screen.getByPlaceholderText("Reference or reason"), notes);
      await user.click(screen.getAllByRole("button", { name: /post credit/i })[0]);
      const dialog = screen.getByRole("dialog", { name: /confirm credit/i });
      await user.click(within(dialog).getByRole("button", { name: /post credit/i }));
    }

    function captureCredits(responses: Array<"network" | number>) {
      const bodies: CreditBody[] = [];
      server.use(
        http.post("/api/v1/internal/tenants/:id/credit", async ({ request }) => {
          const body = (await request.json()) as CreditBody;
          bodies.push(body);
          const next = responses.shift() ?? 200;
          if (next === "network") return HttpResponse.error();
          if (next === 200) {
            return HttpResponse.json({ success: true, amountCredited: body.amount_xlm, newBalance: "600.0000000" });
          }
          return HttpResponse.json({ error: `status ${next}` }, { status: next });
        }),
      );
      return bodies;
    }

    it("after a network error, locks the form and retries with the same key and payload", async () => {
      setAuth();
      const bodies = captureCredits(["network", 200]);
      const user = userEvent.setup();
      renderDetail();

      await postCredit(user, "100", "ref-1");
      await waitFor(() => expect(screen.getByText(/may not have been posted/i)).toBeInTheDocument());
      expect(screen.getByRole("status")).toHaveTextContent(/sent but not confirmed/i);
      expect(screen.getByPlaceholderText("e.g. 50")).toBeDisabled();
      expect(screen.getByPlaceholderText("Reference or reason")).toBeDisabled();
      expect(screen.queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();

      await postCredit(user);
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({ amount_xlm: "100", notes: "ref-1" });
      expect(sessionStorage.getItem("aw_pending_credit_1")).toBeNull();
      expect(screen.getByPlaceholderText("e.g. 50")).not.toBeDisabled();
    });

    it("treats a 5xx as unconfirmed and keeps the key", async () => {
      setAuth();
      const bodies = captureCredits([503, 200]);
      const user = userEvent.setup();
      renderDetail();

      await postCredit(user, "25");
      await waitFor(() => expect(screen.getByText(/did not confirm this credit/i)).toBeInTheDocument());
      expect(screen.getByPlaceholderText("e.g. 50")).toBeDisabled();
      expect(JSON.parse(sessionStorage.getItem("aw_pending_credit_1")!).key).toBe(bodies[0].idempotency_key);

      await postCredit(user);
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
    });

    it("restores an unconfirmed credit after a reload, locked, and retries with its key", async () => {
      setAuth();
      const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      sessionStorage.setItem("aw_pending_credit_1", JSON.stringify({ key, type: "manual_topup", amount: "7.5", notes: "lost reply" }));
      const bodies = captureCredits([200]);
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/sent but not confirmed/i));
      expect(screen.getByPlaceholderText("e.g. 50")).toHaveValue(7.5);
      expect(screen.getByPlaceholderText("e.g. 50")).toBeDisabled();
      expect(screen.getByPlaceholderText("Reference or reason")).toHaveValue("lost reply");

      await postCredit(user);
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies[0]).toMatchObject({ idempotency_key: key, amount_xlm: "7.5", notes: "lost reply" });
    });

    it("on 409 (key already used with other details) clears the key and posts nothing new", async () => {
      setAuth();
      const key = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      sessionStorage.setItem("aw_pending_credit_1", JSON.stringify({ key, type: "manual_topup", amount: "10", notes: "" }));
      const bodies = captureCredits([409]);
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
      await postCredit(user);
      await waitFor(() => expect(screen.getByText(/already posted with different details/i)).toBeInTheDocument());
      expect(bodies).toHaveLength(1);
      expect(sessionStorage.getItem("aw_pending_credit_1")).toBeNull();
      expect(screen.getByPlaceholderText("e.g. 50")).not.toBeDisabled();
    });

    it("on a 400 rejection unlocks the form and the next credit uses a new key", async () => {
      setAuth();
      const bodies = captureCredits([400, 200]);
      const user = userEvent.setup();
      renderDetail();

      await postCredit(user, "5");
      await waitFor(() => expect(screen.getByText(/status 400/)).toBeInTheDocument());
      expect(screen.getByPlaceholderText("e.g. 50")).not.toBeDisabled();
      expect(sessionStorage.getItem("aw_pending_credit_1")).toBeNull();

      await user.clear(screen.getByPlaceholderText("e.g. 50"));
      await postCredit(user, "6");
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
    });

    it("does not carry a pending credit from one tenant to another", async () => {
      setAuth();
      sessionStorage.setItem("aw_pending_credit_1", JSON.stringify({
        key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "manual_topup", amount: "99", notes: "tenant one",
      }));
      const bodies = captureCredits([200]);
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={["/admin/tenants/1"]}>
          <Link to="/admin/tenants/2">go to tenant 2</Link>
          <Routes>
            <Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
          </Routes>
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/sent but not confirmed/i));
      await user.click(screen.getByText("go to tenant 2"));

      await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
      expect(screen.getByPlaceholderText("e.g. 50")).toHaveValue(null);
      expect(screen.getByPlaceholderText("e.g. 50")).not.toBeDisabled();

      await postCredit(user, "3");
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies[0].idempotency_key).not.toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      expect(sessionStorage.getItem("aw_pending_credit_1")).not.toBeNull();
    });

    it("editing the amount before anything is sent starts a new operation", async () => {
      setAuth();
      const bodies = captureCredits([200]);
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => expect(screen.getByText("ACME Corp")).toBeInTheDocument());
      await user.type(screen.getByPlaceholderText("e.g. 50"), "100");
      await user.click(screen.getAllByRole("button", { name: /post credit/i })[0]);
      await user.click(screen.getByText("Cancel"));
      expect(sessionStorage.getItem("aw_pending_credit_1")).toBeNull();

      await user.clear(screen.getByPlaceholderText("e.g. 50"));
      await postCredit(user, "40");
      await waitFor(() => expect(screen.getByText(/XLM posted/)).toBeInTheDocument());
      expect(bodies).toHaveLength(1);
      expect(bodies[0].amount_xlm).toBe("40");
    });
  });

  describe("suspend/unsuspend", () => {
    it("shows suspend button for active tenant", async () => {
      setAuth();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Active")).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: /suspend/i })).toBeInTheDocument();
    });

    it("opens suspend modal with hard/soft options", async () => {
      setAuth();
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /suspend/i }));

      expect(screen.getByText(/hard suspend tenant\?/i)).toBeInTheDocument();
      expect(screen.getByText("Hard suspend")).toBeInTheDocument();
      expect(screen.getByText("Soft suspend")).toBeInTheDocument();
    });

    it("submits hard suspend", async () => {
      setAuth();
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("ACME Corp")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /^suspend$/i }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Default is hard suspend — click confirm
      const confirmBtn = screen.getByRole("button", { name: /hard suspend tenant/i });
      await user.click(confirmBtn);

      // Should reload data after suspend
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("shows unsuspend button for suspended tenant", async () => {
      setAuth();
      server.use(
        http.get("/api/v1/internal/tenants/:id/billing", () => {
          return HttpResponse.json({
            ...mockBilling,
            isActive: false,
            suspendedAt: "2026-10-20T00:00:00Z",
            suspensionReason: "manual",
          });
        }),
      );
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Suspended")).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: /unsuspend/i })).toBeInTheDocument();
    });

    it("submits unsuspend", async () => {
      setAuth();
      server.use(
        http.get("/api/v1/internal/tenants/:id/billing", () => {
          return HttpResponse.json({
            ...mockBilling,
            isActive: false,
            suspendedAt: "2026-10-20T00:00:00Z",
            suspensionReason: "manual",
          });
        }),
      );
      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Suspended")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /unsuspend/i }));
      await user.click(screen.getByRole("button", { name: /unsuspend tenant/i }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("shows soft-suspended status", async () => {
      setAuth();
      server.use(
        http.get("/api/v1/internal/tenants/:id/billing", () => {
          return HttpResponse.json({
            ...mockBilling,
            isActive: true,
            suspendedAt: "2026-10-20T00:00:00Z",
            suspensionReason: "manual",
          });
        }),
      );
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Soft-suspended")).toBeInTheDocument();
      });
    });
  });

  // Pagination tests
  describe("billing event pagination", () => {
    it("shows Load older button when hasMore is true", async () => {
      setAuth();
      server.use(
        http.get("/api/v1/internal/tenants/:id/billing", () => {
          return HttpResponse.json({
            ...mockBilling,
            eventsHasMore: true,
            eventsNextCursor: 5,
          });
        }),
      );
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Load older")).toBeInTheDocument();
      });
    });

    it("loads older events on click", async () => {
      setAuth();
      server.use(
        http.get("/api/v1/internal/tenants/:id/billing", () => {
          return HttpResponse.json({
            ...mockBilling,
            eventsHasMore: true,
            eventsNextCursor: 5,
          });
        }),
        http.get("/api/v1/internal/tenants/:id/events", () => {
          return HttpResponse.json({
            events: [
              { id: 3, eventType: "wallet_funding", amountXlm: "-1.5000000", billingPeriod: null, userId: 42, createdAt: "2026-10-10T10:00:00Z", notes: null },
            ],
            hasMore: false,
            nextCursor: null,
          });
        }),
      );

      const user = userEvent.setup();
      renderDetail();

      await waitFor(() => {
        expect(screen.getByText("Load older")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Load older"));

      await waitFor(() => {
        expect(screen.getByText("Wallet funding")).toBeInTheDocument();
      });
      expect(screen.getByText("-1.5000 XLM")).toBeInTheDocument();
    });
  });

  // Auth / error handling
  it("handles 401 by logging out", async () => {
    setAuth();
    server.use(
      http.get("/api/v1/internal/tenants/:id/billing", () => {
        return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
      }),
    );
    renderDetail();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/login");
    });
  });

  it("shows server error", async () => {
    setAuth();
    server.use(
      http.get("/api/v1/internal/tenants/:id/billing", () => {
        return HttpResponse.json({ error: "Tenant not found" }, { status: 404 });
      }),
    );
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText("Tenant not found")).toBeInTheDocument();
    });
  });

  it("shows network error", async () => {
    setAuth();
    server.use(
      http.get("/api/v1/internal/tenants/:id/billing", () => {
        return HttpResponse.error();
      }),
    );
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });
  });

  it("has breadcrumb link back to all tenants", async () => {
    setAuth();
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText("ACME Corp")).toBeInTheDocument();
    });

    const backLink = screen.getByText("All tenants");
    expect(backLink.closest("a")).toHaveAttribute("href", "/admin");
  });
});
