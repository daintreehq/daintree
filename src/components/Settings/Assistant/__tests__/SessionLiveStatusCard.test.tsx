// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpSessionActiveGrant, HelpSessionLiveStatus } from "@shared/types";

const { liveStatus, activeSessionId, revokeGrant, revokeNativeGrant } = vi.hoisted(() => ({
  liveStatus: { current: null as HelpSessionLiveStatus | null },
  activeSessionId: { current: "help-1" },
  revokeGrant: vi.fn(),
  revokeNativeGrant: vi.fn(),
}));

vi.mock("@/hooks", () => ({
  useHelpSessionLiveStatus: () => liveStatus.current,
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (s: unknown) => unknown) => selector({}),
  selectActiveSlot: () => ({ sessionId: activeSessionId.current }),
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { SessionLiveStatusCard } from "../SessionLiveStatusCard";

function perTool(toolId: string): HelpSessionActiveGrant {
  return {
    sessionId: "transport-1",
    toolId,
    expiresAt: Date.now() + 600_000,
    ttlMs: 900_000,
    kind: "per-tool",
  };
}

const AUTOMATION: HelpSessionActiveGrant = {
  sessionId: "transport-1",
  toolId: "*",
  expiresAt: Date.now() + 600_000,
  ttlMs: 900_000,
  kind: "native",
  grantId: "g1",
  allowedTools: ["recipe.run"],
  maxUses: 5,
  remainingUses: 5,
};

beforeEach(() => {
  activeSessionId.current = "help-1";
  revokeGrant.mockReset();
  revokeNativeGrant.mockReset();
  liveStatus.current = {
    connected: true,
    tier: "core",
    activeGrants: [perTool("terminal.kill"), perTool("project.runCheck"), AUTOMATION],
  };
  Object.defineProperty(window, "electron", {
    value: { mcpServer: { revokeGrant, revokeNativeGrant, issueNativeGrant: vi.fn() } },
    writable: true,
    configurable: true,
  });
});

describe("SessionLiveStatusCard per-tool revoke (#14975)", () => {
  it("ends one per-tool grant by its transport session and leaves the rest alone", async () => {
    let settle: (() => void) | undefined;
    revokeGrant.mockReturnValue(
      new Promise((resolve) => {
        settle = () =>
          resolve({ sessionId: "transport-1", toolId: "project.runCheck", revoked: true });
      })
    );
    const { getByRole } = render(<SessionLiveStatusCard configuredTier="core" />);
    const target = () => getByRole("button", { name: "Revoke project.runCheck" });
    const sibling = () => getByRole("button", { name: "Revoke terminal.kill" });

    fireEvent.click(target());

    expect(revokeGrant).toHaveBeenCalledTimes(1);
    expect(revokeGrant).toHaveBeenCalledWith({
      sessionId: "transport-1",
      toolId: "project.runCheck",
    });
    expect(revokeNativeGrant).not.toHaveBeenCalled();
    expect(target().getAttribute("aria-busy")).toBe("true");
    expect(sibling().getAttribute("aria-busy")).toBeNull();

    settle?.();
    await waitFor(() => expect(target().getAttribute("aria-busy")).toBeNull());
    expect(sibling()).toBeTruthy();
  });

  it("keeps the row and says why when the revoke fails", async () => {
    revokeGrant.mockRejectedValue(new Error("Caller is not the pinned renderer"));
    const { getByRole, findByRole } = render(<SessionLiveStatusCard configuredTier="core" />);

    fireEvent.click(getByRole("button", { name: "Revoke terminal.kill" }));

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Caller is not the pinned renderer");
    expect(getByRole("button", { name: "Revoke terminal.kill" })).toBeTruthy();
  });

  it("drops a pending revoke and its error when the active session changes", async () => {
    revokeGrant.mockRejectedValue(new Error("Caller is not the pinned renderer"));
    const { getByRole, findByRole, queryByRole, rerender } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );
    fireEvent.click(getByRole("button", { name: "Revoke terminal.kill" }));
    await findByRole("alert");

    activeSessionId.current = "help-2";
    liveStatus.current = {
      connected: true,
      tier: "core",
      activeGrants: [{ ...perTool("terminal.kill"), sessionId: "transport-2" }],
    };
    rerender(<SessionLiveStatusCard configuredTier="core" />);

    expect(queryByRole("alert")).toBeNull();
  });
});
