// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpPanelBanners } from "../HelpPanelBanners";
import type { ActiveGrantState, LaunchErrorKind } from "@/controllers/HelpSessionController";

function grant(
  toolId: string,
  fields: Omit<Partial<ActiveGrantState>, "toolId"> & { expiresAt: number }
): ActiveGrantState {
  return { key: `tool:s1:${toolId}`, sessionId: "s1", toolId, ttlMs: 900_000, ...fields };
}

function baseProps() {
  return {
    showResumeBanner: false,
    tierMismatch: null,
    launchError: null,
    sessionRevoked: null,
    isApprovingTier: false,
    activeGrants: [] as ActiveGrantState[],
    grantEnded: null,
    revokingGrantKeys: [] as string[],
    onDismissResume: vi.fn(),
    onDismissTierMismatch: vi.fn(),
    onApproveOnce: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onRevokeGrant: vi.fn(),
    onDismissGrantEnded: vi.fn(),
    onRetryLaunch: vi.fn(),
    onDismissLaunchError: vi.fn(),
    onOpenAssistantSettings: vi.fn(),
    onOpenLogs: vi.fn(),
    onOpenInstallerPage: vi.fn(),
    onStartNewSession: vi.fn(),
    onDismissSessionRevoked: vi.fn(),
  };
}

describe("HelpPanelBanners — launch error", () => {
  it("renders an alert with a verb-led title and a Retry button", () => {
    const { getByTestId, getByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "spawn-failed" }}
      />
    );

    const banner = getByTestId("help-launch-error-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(getByText("Assistant couldn't start")).toBeTruthy();
    expect(getByText("Retry")).toBeTruthy();
  });

  it("keeps every kind's copy free of MCP / token / bearer jargon", () => {
    const kinds: LaunchErrorKind[] = [
      "mcp-server-not-started",
      "mcp-probe-failed",
      "skills-sync-failed",
      "spawn-failed",
      "mixed-agent-lanes",
      "folder-unavailable",
    ];
    for (const kind of kinds) {
      const { getByTestId, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      const text = getByTestId("help-launch-error-banner").textContent ?? "";
      expect(text).not.toMatch(/\bMCP\b/i);
      expect(text).not.toMatch(/\btoken\b/i);
      expect(text).not.toMatch(/\bbearer\b/i);
      unmount();
    }
  });

  it("offers no CTA for mixed-agent-lanes and names the sibling session as the fix", () => {
    const { getByTestId, queryAllByRole, queryByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "mixed-agent-lanes" }}
      />
    );
    expect(queryByText("Retry")).toBeNull();
    // Only the dismiss × — every CTA this banner can render would be a lie.
    expect(queryAllByRole("button").length).toBe(1);
    const text = getByTestId("help-launch-error-banner").textContent ?? "";
    expect(text).toMatch(/running a different agent/);
    expect(text).toMatch(/stop that session first/);
    expect(text).not.toMatch(/Try again/i);
  });

  it("wires Retry and dismiss to their handlers", () => {
    const onRetryLaunch = vi.fn();
    const onDismissLaunchError = vi.fn();
    const { getByText, getByLabelText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "spawn-failed" }}
        onRetryLaunch={onRetryLaunch}
        onDismissLaunchError={onDismissLaunchError}
      />
    );

    fireEvent.click(getByText("Retry"));
    expect(onRetryLaunch).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText("Dismiss launch error"));
    expect(onDismissLaunchError).toHaveBeenCalledTimes(1);
  });

  it("wires the mcp-probe-failed Open settings button to its handler", () => {
    const onOpenAssistantSettings = vi.fn();
    const { getByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "mcp-probe-failed" }}
        onOpenAssistantSettings={onOpenAssistantSettings}
      />
    );
    fireEvent.click(getByText("Open settings"));
    expect(onOpenAssistantSettings).toHaveBeenCalledTimes(1);
  });

  it("renders the exact CTA matrix per kind (label + rank + order)", () => {
    // Primary recovery first, then at most one demoted affordance.
    const cases: { kind: LaunchErrorKind; labels: string[] }[] = [
      { kind: "mcp-server-not-started", labels: ["Retry", "Open settings"] },
      { kind: "mcp-probe-failed", labels: ["Retry", "Open settings"] },
      { kind: "skills-sync-failed", labels: ["Retry", "Open logs"] },
      { kind: "spawn-failed", labels: ["Retry"] },
      { kind: "mixed-agent-lanes", labels: [] },
      { kind: "folder-unavailable", labels: ["Open installer page", "Open logs"] },
    ];
    for (const { kind, labels } of cases) {
      const { getByTestId, queryAllByRole, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      const banner = getByTestId("help-launch-error-banner");
      const actionRow = banner.querySelector("[data-banner-controls]");
      // A kind with no CTAs drops the row entirely rather than rendering an
      // empty one that pads the banner with a phantom action row.
      expect(actionRow === null).toBe(labels.length === 0);
      const buttons = actionRow ? Array.from(actionRow.querySelectorAll("button")) : [];
      const actualLabels = buttons.map((b) => b.textContent?.trim() ?? "");
      expect(actualLabels).toEqual(labels);
      // The primary is visibly ranked above the demoted affordance.
      if (buttons.length === 2) {
        expect(buttons[0]!.getAttribute("data-variant")).not.toBe(
          buttons[1]!.getAttribute("data-variant")
        );
      }
      // Sanity: no orphaned buttons beyond the dismiss × and the CTAs above.
      const allButtons = queryAllByRole("button");
      expect(allButtons.length).toBe(labels.length + 1);
      unmount();
    }
  });

  it("wires the folder-unavailable Open logs and Open installer page buttons", () => {
    const onOpenLogs = vi.fn();
    const onOpenInstallerPage = vi.fn();
    const onRetryLaunch = vi.fn();
    const { getByText, queryByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "folder-unavailable" }}
        onRetryLaunch={onRetryLaunch}
        onOpenLogs={onOpenLogs}
        onOpenInstallerPage={onOpenInstallerPage}
      />
    );
    expect(queryByText("Retry")).toBeNull();
    fireEvent.click(getByText("Open logs"));
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("Open installer page"));
    expect(onOpenInstallerPage).toHaveBeenCalledTimes(1);
    expect(onRetryLaunch).not.toHaveBeenCalled();
  });

  it("renders nothing for the launch-error slot when launchError is null", () => {
    const { queryByTestId } = render(<HelpPanelBanners {...baseProps()} />);
    expect(queryByTestId("help-launch-error-banner")).toBeNull();
  });
});

describe("HelpPanelBanners — resume banner (#10057)", () => {
  it("renders nothing when showResumeBanner is false", () => {
    const { queryByTestId } = render(
      <HelpPanelBanners {...baseProps()} showResumeBanner={false} />
    );
    expect(queryByTestId("help-resume-banner")).toBeNull();
  });

  it("renders the resume banner with its specific-session claim when showResumeBanner is true", () => {
    const { getByTestId, getByText } = render(
      <HelpPanelBanners {...baseProps()} showResumeBanner={true} />
    );
    expect(getByTestId("help-resume-banner").getAttribute("role")).toBe("status");
    expect(getByText("Resumed your previous session")).toBeTruthy();
  });

  it("wires the resume banner's dismiss button to onDismissResume", () => {
    const onDismissResume = vi.fn();
    const { getByLabelText } = render(
      <HelpPanelBanners
        {...baseProps()}
        showResumeBanner={true}
        onDismissResume={onDismissResume}
      />
    );
    fireEvent.click(getByLabelText("Dismiss resume notice"));
    expect(onDismissResume).toHaveBeenCalledTimes(1);
  });
});

describe("HelpPanelBanners — session revoked", () => {
  it("renders an alert with a recovery action when a session is revoked", () => {
    const { getByTestId, getByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        sessionRevoked={{ sessionId: "sess-1", denialKind: "tierMismatch" }}
      />
    );

    const banner = getByTestId("help-session-revoked-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(getByText("Start new session")).toBeTruthy();
  });

  it("keeps the copy free of MCP / token / bearer jargon and the raw denial kind", () => {
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        sessionRevoked={{ sessionId: "sess-1", denialKind: "auth401" }}
      />
    );
    const text = getByTestId("help-session-revoked-banner").textContent ?? "";
    expect(text).not.toMatch(/\bMCP\b/i);
    expect(text).not.toMatch(/\btoken\b/i);
    expect(text).not.toMatch(/\bbearer\b/i);
    expect(text).not.toMatch(/auth401/i);
  });

  it("wires the recovery and dismiss buttons to their handlers", () => {
    const onStartNewSession = vi.fn();
    const onDismissSessionRevoked = vi.fn();
    const { getByText, getByLabelText } = render(
      <HelpPanelBanners
        {...baseProps()}
        sessionRevoked={{ sessionId: "sess-1", denialKind: "tierMismatch" }}
        onStartNewSession={onStartNewSession}
        onDismissSessionRevoked={onDismissSessionRevoked}
      />
    );

    fireEvent.click(getByText("Start new session"));
    expect(onStartNewSession).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText("Dismiss session ended notice"));
    expect(onDismissSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for the revoked slot when sessionRevoked is null", () => {
    const { queryByTestId } = render(<HelpPanelBanners {...baseProps()} />);
    expect(queryByTestId("help-session-revoked-banner")).toBeNull();
  });
});

describe("HelpPanelBanners — active grant countdown (#10042)", () => {
  it("renders nothing for the grant slot when no grant is live", () => {
    const { queryByTestId } = render(<HelpPanelBanners {...baseProps()} />);
    expect(queryByTestId("help-grant-active-banner")).toBeNull();
  });

  it("renders the tool id and a unit countdown derived from expiresAt", () => {
    // 2 min 5 s out — ceil keeps it at 2m 0-5s even with a few ms of render lag.
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrants={[grant("search_docs", { expiresAt: Date.now() + 125_000 })]}
      />
    );
    const banner = getByTestId("help-grant-active-banner");
    expect(banner.getAttribute("role")).toBe("status");
    const text = banner.textContent ?? "";
    expect(text).toContain("search_docs");
    // The displayed remaining time is derived, not a hardcoded literal.
    expect(text).toMatch(/2m( [1-5]s)? left/);
  });

  it("clamps a past expiry to 0s rather than rendering a negative timer", () => {
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrants={[grant("t1", { expiresAt: Date.now() - 10_000 })]}
      />
    );
    expect(getByTestId("help-grant-active-banner").textContent).toContain("0s left");
  });

  it("ticks the countdown down over time and stops after unmount (no leak)", () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const { getByTestId, unmount } = render(
        <HelpPanelBanners
          {...baseProps()}
          activeGrants={[grant("t1", { expiresAt: base + 5_000 })]}
        />
      );
      expect(getByTestId("help-grant-active-banner").textContent).toContain("5s left");
      // Advance both wall-clock and the interval so the derived value updates.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(getByTestId("help-grant-active-banner").textContent).toContain("3s left");
      // Unmount must clear the interval — advancing further is a no-op, not a
      // post-unmount state update.
      unmount();
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(5_000);
        })
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the new expiry when a use slides the grant (#14998)", () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const slid = (expiresAt: number) => [
        grant("t1", { expiresAt, maxExpiresAt: base + 1_800_000 }),
      ];
      const { getByTestId, rerender } = render(
        <HelpPanelBanners {...baseProps()} activeGrants={slid(base + 5_000)} />
      );
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(getByTestId("help-grant-active-banner").textContent).toContain("0s left");

      rerender(<HelpPanelBanners {...baseProps()} activeGrants={slid(base + 605_000)} />);
      const text = getByTestId("help-grant-active-banner").textContent ?? "";
      expect(text).toContain("10m left");
      expect(text).not.toContain("limit");
      // The tick keeps counting from the new expiry, not the one it mounted with.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(getByTestId("help-grant-active-banner").textContent).toContain("9m left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts to the 30-minute ceiling and names it when that ends the grant first (#14998)", () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const capped = (maxExpiresAt: number) => [
        grant("t1", { expiresAt: base + 900_000, maxExpiresAt }),
      ];
      const { getByTestId, rerender } = render(
        <HelpPanelBanners {...baseProps()} activeGrants={capped(base + 1_800_000)} />
      );
      expect(getByTestId("help-grant-active-banner").textContent).toContain("15m left");

      // Only the ceiling changes: the countdown must re-target it.
      rerender(<HelpPanelBanners {...baseProps()} activeGrants={capped(base + 120_000)} />);
      expect(getByTestId("help-grant-active-banner").textContent).toContain(
        "2m left · 30-minute limit"
      );
      // The tick stops at the ceiling rather than running on to the sliding expiry.
      act(() => {
        vi.advanceTimersByTime(180_000);
      });
      expect(getByTestId("help-grant-active-banner").textContent).toContain(
        "0s left · 30-minute limit"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires Revoke access to onRevokeGrant and disables it while revoking", () => {
    const onRevokeGrant = vi.fn();
    const live = [grant("t1", { expiresAt: Date.now() + 60_000 })];
    const { getByText, rerender } = render(
      <HelpPanelBanners {...baseProps()} activeGrants={live} onRevokeGrant={onRevokeGrant} />
    );
    const button = getByText("Revoke access");
    fireEvent.click(button);
    expect(onRevokeGrant).toHaveBeenCalledWith(live[0]!.key);

    rerender(
      <HelpPanelBanners
        {...baseProps()}
        activeGrants={live}
        revokingGrantKeys={[live[0]!.key]}
        onRevokeGrant={onRevokeGrant}
      />
    );
    // Busy, not natively disabled: the button keeps focus while it spins.
    const busy = getByText("Revoke access").closest("button")!;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("HelpPanelBanners — several live approvals (#14975)", () => {
  function twoGrants() {
    const now = Date.now();
    return [
      grant("terminal.kill", { expiresAt: now + 125_000 }),
      grant("project.runCheck", { expiresAt: now + 605_000 }),
    ];
  }

  function automationGrant(): ActiveGrantState {
    return {
      key: "native:s1:g1",
      sessionId: "s1",
      toolId: "*",
      ttlMs: 900_000,
      expiresAt: Date.now() + 60_000,
      grantId: "g1",
      allowedTools: ["recipe.run", "worktree.deleteOwned"],
    };
  }

  it("names every approval with its own countdown and says how many there are", () => {
    const { getByTestId } = render(
      <HelpPanelBanners {...baseProps()} activeGrants={twoGrants()} />
    );
    const banner = getByTestId("help-grant-active-banner");
    const text = banner.textContent ?? "";
    expect(text).toContain("2 approvals active");
    const rows = Array.from(banner.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("terminal.kill");
    expect(rows[0]).toMatch(/2m( [1-5]s)? left/);
    expect(rows[1]).toContain("project.runCheck");
    expect(rows[1]).toMatch(/10m( [1-5]s)? left/);
  });

  it("revokes only the approval whose button was pressed, with no clear-all control", () => {
    const onRevokeGrant = vi.fn();
    const grants = [...twoGrants(), automationGrant()];
    const { getByRole, queryByText } = render(
      <HelpPanelBanners {...baseProps()} activeGrants={grants} onRevokeGrant={onRevokeGrant} />
    );
    fireEvent.click(getByRole("button", { name: "Revoke access to project.runCheck" }));
    fireEvent.click(
      getByRole("button", { name: "Revoke access to recipe.run, worktree.deleteOwned" })
    );
    fireEvent.click(getByRole("button", { name: "Revoke access to terminal.kill" }));
    expect(onRevokeGrant.mock.calls).toEqual([
      [grants[1]!.key],
      [grants[2]!.key],
      [grants[0]!.key],
    ]);
    expect(queryByText("Revoke access")).toBeNull();
  });

  it("spins only the approval being revoked", () => {
    const grants = twoGrants();
    const { getByRole } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrants={grants}
        revokingGrantKeys={[grants[0]!.key]}
      />
    );
    const busy = getByRole("button", { name: "Revoke access to terminal.kill" });
    const idle = getByRole("button", { name: "Revoke access to project.runCheck" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(idle.getAttribute("aria-busy")).toBeNull();
  });

  it("names an automation grant by the tools it covers and counts it", () => {
    const { getByTestId, getByRole } = render(
      <HelpPanelBanners {...baseProps()} activeGrants={[...twoGrants(), automationGrant()]} />
    );
    const text = getByTestId("help-grant-active-banner").textContent ?? "";
    expect(text).toContain("3 approvals active");
    expect(text).not.toContain("*");
    expect(
      getByRole("button", { name: "Revoke access to recipe.run, worktree.deleteOwned" })
    ).toBeTruthy();
  });

  it("keeps ticking every countdown on one timer and clears it on unmount", () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const timersBefore = vi.getTimerCount();
      const { getByTestId, unmount } = render(
        <HelpPanelBanners
          {...baseProps()}
          activeGrants={[
            grant("t1", { expiresAt: base + 5_000 }),
            grant("t2", { expiresAt: base + 9_000 }),
          ]}
        />
      );
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      const rows = Array.from(getByTestId("help-grant-active-banner").querySelectorAll("li")).map(
        (li) => li.textContent ?? ""
      );
      expect(rows[0]).toContain("3s left");
      expect(rows[1]).toContain("7s left");
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      unmount();
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HelpPanelBanners — grant ended notice (#10042)", () => {
  it("renders nothing for the grant-ended slot when grantEnded is null", () => {
    const { queryByTestId } = render(<HelpPanelBanners {...baseProps()} />);
    expect(queryByTestId("help-grant-ended-banner")).toBeNull();
  });

  it("distinguishes a passive expiry from the 30-minute ceiling in its copy", () => {
    const { getByTestId, rerender } = render(
      <HelpPanelBanners {...baseProps()} grantEnded={{ toolId: "t1", reason: "expired" }} />
    );
    const expiredText = getByTestId("help-grant-ended-banner").textContent ?? "";
    expect(expiredText).toContain("t1");
    expect(expiredText).not.toContain("30-minute");

    rerender(
      <HelpPanelBanners {...baseProps()} grantEnded={{ toolId: "t1", reason: "grant-ceiling" }} />
    );
    expect(getByTestId("help-grant-ended-banner").textContent).toContain("30-minute");
  });

  it("keeps the notice free of MCP / grant / tier jargon", () => {
    const { getByTestId } = render(
      <HelpPanelBanners {...baseProps()} grantEnded={{ toolId: "t1", reason: "grant-ceiling" }} />
    );
    const text = getByTestId("help-grant-ended-banner").textContent ?? "";
    expect(text).not.toMatch(/\bMCP\b/i);
    expect(text).not.toMatch(/\bgrant\b/i);
    expect(text).not.toMatch(/\btier\b/i);
  });

  it("wires its dismiss button to onDismissGrantEnded", () => {
    const onDismissGrantEnded = vi.fn();
    const { getByLabelText } = render(
      <HelpPanelBanners
        {...baseProps()}
        grantEnded={{ toolId: "t1", reason: "expired" }}
        onDismissGrantEnded={onDismissGrantEnded}
      />
    );
    fireEvent.click(getByLabelText("Dismiss approval notice"));
    expect(onDismissGrantEnded).toHaveBeenCalledTimes(1);
  });
});

// #12119: the two affordances shipped as "Approve once" / "Always allow for
// this project" and neither matched its mechanism — the first mints a reusable
// per-tool grant; the second persists a project default AND lifts the running
// help session for 30 minutes.
// Both labels overstated the grant, which is the wrong direction to be wrong in
// for a control that widens an agent's authority, so the copy is pinned here.
describe("HelpPanelBanners — tier mismatch (#12119)", () => {
  const tierMismatch = {
    sessionId: "sess-1",
    toolId: "terminal.new",
    tier: "core",
    targetTier: "full" as const,
    projectId: "proj-1",
  };

  it("renders the exact action row (label + order) for an actionable denial", () => {
    const { getByTestId } = render(
      <HelpPanelBanners {...baseProps()} tierMismatch={tierMismatch} />
    );

    const banner = getByTestId("help-tier-mismatch-banner");
    expect(banner.getAttribute("role")).toBe("status");

    const actionRow = banner.querySelector("[data-banner-controls]");
    expect(actionRow).not.toBeNull();
    const labels = Array.from(actionRow!.querySelectorAll("button")).map(
      (b) => b.textContent?.trim() ?? ""
    );
    expect(labels).toEqual(["Allow this tool", "Set project default"]);
  });

  it("never claims the grant is one call or the elevation permanent", () => {
    const { getByTestId } = render(
      <HelpPanelBanners {...baseProps()} tierMismatch={tierMismatch} />
    );
    const text = getByTestId("help-tier-mismatch-banner").textContent ?? "";
    expect(text).not.toMatch(/\bonce\b/i);
    expect(text).not.toMatch(/\balways\b/i);
  });

  it("discloses both bounded windows in the body", () => {
    const { getByTestId } = render(
      <HelpPanelBanners {...baseProps()} tierMismatch={tierMismatch} />
    );
    const text = getByTestId("help-tier-mismatch-banner").textContent ?? "";
    expect(text).toContain("terminal.new needs the full tool set.");
    // The grant is reusable on a 15-minute sliding window under a 30-minute
    // ceiling — stating only the ceiling would overstate an idle grant's life.
    expect(text).toContain("repeat calls for 15 minutes after the last one, 30 at most");
    // The project write feeds agents launched in the project. Every launchMcp
    // agent reads it, not only Claude Code, and there are no Assistant panes
    // left to name (#13502).
    expect(text).toContain(
      "gives the full tool set to agents launched in this project that support Daintree tools"
    );
    expect(text).not.toMatch(/Daintree Assistant panes|Claude Code/);
    // Deliberately broad: nothing in a denied-tool banner has any business
    // promising "new sessions" anything, and that promise was the bug.
    expect(text).not.toContain("new sessions");
    // The session lift is the half that lapses.
    expect(text).toContain("raises this session for 30 minutes");
    // New help sessions provision from the global tool set, never the project
    // default (HelpSessionService.doProvision), so the banner says where the
    // next conversation's tool set comes from (#14993).
    expect(text).toContain("New assistant sessions use the tool set in Assistant settings.");
  });

  it("opens Assistant settings from the new-session note", () => {
    const onOpenAssistantSettings = vi.fn();
    const { getByRole } = render(
      <HelpPanelBanners
        {...baseProps()}
        tierMismatch={tierMismatch}
        onOpenAssistantSettings={onOpenAssistantSettings}
      />
    );
    fireEvent.click(getByRole("button", { name: "Assistant settings" }));
    expect(onOpenAssistantSettings).toHaveBeenCalledTimes(1);
  });

  it("routes each button to its own handler", () => {
    const onApproveOnce = vi.fn();
    const onAlwaysAllow = vi.fn();
    const onDismissTierMismatch = vi.fn();
    const { getByText, getByLabelText } = render(
      <HelpPanelBanners
        {...baseProps()}
        tierMismatch={tierMismatch}
        onApproveOnce={onApproveOnce}
        onAlwaysAllow={onAlwaysAllow}
        onDismissTierMismatch={onDismissTierMismatch}
      />
    );

    fireEvent.click(getByText("Allow this tool"));
    fireEvent.click(getByText("Set project default"));
    fireEvent.click(getByLabelText("Dismiss tier mismatch notice"));

    expect(onApproveOnce).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    expect(onDismissTierMismatch).toHaveBeenCalledTimes(1);
  });

  it("makes every approval control inert while an approval is in flight, and spins only the one clicked", () => {
    const props = { ...baseProps(), tierMismatch };
    const { getByTestId, getByText, getByLabelText, getByRole, rerender } = render(
      <HelpPanelBanners {...props} />
    );
    fireEvent.click(getByText("Set project default"));
    rerender(<HelpPanelBanners {...props} isApprovingTier />);

    const banner = getByTestId("help-tier-mismatch-banner");
    // The inline Assistant settings link stays live: it neither dismisses the
    // banner nor touches the approval.
    const settingsLink = getByRole("button", { name: "Assistant settings" });
    const buttons = Array.from(banner.querySelectorAll("button")).filter((b) => b !== settingsLink);
    expect(buttons.length).toBe(3);
    // The × is inert too: dismissing mid-flight would strand the in-flight
    // grant with no banner to report its outcome.
    expect(buttons.every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(settingsLink.hasAttribute("disabled")).toBe(false);
    expect(settingsLink.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(settingsLink);
    expect(props.onOpenAssistantSettings).toHaveBeenCalledTimes(1);
    const busy = buttons.filter((b) => b.getAttribute("aria-busy") === "true");
    expect(busy.map((b) => b.textContent?.trim())).toEqual(["Set project default"]);

    fireEvent.click(getByLabelText("Dismiss tier mismatch notice"));
    expect(props.onDismissTierMismatch).not.toHaveBeenCalled();
  });

  // `targetTier: null` means neither tool set permits the tool, so neither
  // affordance can help — an unknown id, never a full-set tool like
  // `terminal.new`.
  it("withholds the actions and the window copy when no tool set would permit the tool", () => {
    const { getByTestId, queryByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        tierMismatch={{ ...tierMismatch, toolId: "unknown.tool", targetTier: null }}
      />
    );
    const banner = getByTestId("help-tier-mismatch-banner");
    expect(banner.textContent).toContain("unknown.tool isn't in either tool set.");
    // Nothing to grant, so the details paragraph must not render at all —
    // asserting on its semantic openings rather than one duration phrase, so a
    // reworded body can't leak back into this branch unnoticed.
    expect(banner.textContent).not.toContain("Allowing the tool");
    expect(banner.textContent).not.toContain("The project default");
    expect(banner.textContent).not.toContain("New assistant sessions");
    expect(queryByText("Allow this tool")).toBeNull();
    expect(queryByText("Set project default")).toBeNull();
  });
});

describe("HelpPanelBanners — the stack", () => {
  const everything = () => ({
    ...baseProps(),
    showResumeBanner: true,
    activeGrants: [grant("t1", { expiresAt: Date.now() + 60_000 })],
    grantEnded: { toolId: "t2", reason: "expired" as const },
    tierMismatch: {
      sessionId: "s1",
      toolId: "terminal.new",
      tier: "core",
      targetTier: "full" as const,
      projectId: "p1",
    },
    launchError: { agentId: "claude", kind: "mcp-server-not-started" as const },
    sessionRevoked: { sessionId: "s1", denialKind: "tierMismatch" },
  });

  it("puts every blocking alert above every advisory status", () => {
    const { container } = render(<HelpPanelBanners {...everything()} />);
    const roles = Array.from(container.querySelectorAll("[data-testid^='help-']")).map((el) =>
      el.getAttribute("role")
    );
    expect(roles.length).toBe(5);
    expect(roles.lastIndexOf("alert")).toBeLessThan(roles.indexOf("status"));
  });

  it("reaches each banner's recovery before its dismiss in tab order", () => {
    const { container } = render(<HelpPanelBanners {...everything()} />);
    const banners = Array.from(container.querySelectorAll("[data-testid^='help-']"));
    // Every banner but the live grant carries a dismiss, and it is always last.
    const withDismiss = banners.filter((banner) => {
      const buttons = Array.from(banner.querySelectorAll("button"));
      const dismiss = buttons.findIndex((b) => b.getAttribute("aria-label")?.startsWith("Dismiss"));
      if (dismiss === -1) return false;
      expect(dismiss).toBe(buttons.length - 1);
      return true;
    });
    expect(withDismiss.map((b) => b.getAttribute("data-testid"))).toEqual(
      banners
        .map((b) => b.getAttribute("data-testid"))
        .filter((id) => id !== "help-grant-active-banner")
    );
  });

  it("builds every control from the Button primitive, dismiss included", () => {
    const { container } = render(<HelpPanelBanners {...everything()} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(6);
    for (const button of buttons) expect(button.hasAttribute("data-variant")).toBe(true);
  });

  it("holds the resume advisory back while anything is blocking, and shows it after", () => {
    const blockers = [
      { tierMismatch: everything().tierMismatch },
      { launchError: everything().launchError },
      { sessionRevoked: everything().sessionRevoked },
    ];
    for (const blocker of blockers) {
      const { queryByTestId, rerender, unmount } = render(
        <HelpPanelBanners {...baseProps()} showResumeBanner {...blocker} />
      );
      expect(queryByTestId("help-resume-banner")).toBeNull();
      rerender(<HelpPanelBanners {...baseProps()} showResumeBanner />);
      expect(queryByTestId("help-resume-banner")).not.toBeNull();
      unmount();
    }
  });
});
