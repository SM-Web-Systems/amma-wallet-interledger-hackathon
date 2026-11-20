import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const lock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./lib/stellar-autolock", () => ({ startStellarAutoLock: () => { lock.start(); return lock.stop; } }));

import App from "./App";
import { useAuthStore } from "./store/auth";

describe("App", () => {
  it("runs the Stellar auto-lock while mounted and stops it on unmount", async () => {
    useAuthStore.setState({ loadProfile: async () => {} } as never);
    const { unmount } = render(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);
    await waitFor(() => expect(lock.start).toHaveBeenCalledTimes(1));
    unmount();
    expect(lock.stop).toHaveBeenCalledTimes(1);
  });
});
