// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpPanelBanners } from "../HelpPanelBanners";
import type { LaunchErrorKind } from "@/controllers/HelpSessionController";

function baseProps() {
  return {
    showResumeBanner: false,
    tierMismatch: null,
    launchError: null,
    sessionRevoked: null,
    isApprovingTier: false,
    activeGrant: null,
    grantEnded: null,
    isRevokingGrant: false,
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

  it("shows Open settings for both MCP failure kinds and only those", () => {
    const kindsWithSettings: LaunchErrorKind[] = ["mcp-server-not-started", "mcp-probe-failed"];
    for (const kind of kindsWithSettings) {
      const { queryByText, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      expect(queryByText("Open settings")).toBeTruthy();
      unmount();
    }

    const kindsWithoutSettings: LaunchErrorKind[] = [
      "skills-sync-failed",
      "spawn-failed",
      "folder-unavailable",
    ];
    for (const kind of kindsWithoutSettings) {
      const { queryByText, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      expect(queryByText("Open settings")).toBeNull();
      unmount();
    }
  });

  it("omits Retry for folder-unavailable and offers Open logs + Open installer page", () => {
    const { queryByText, getByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "folder-unavailable" }}
      />
    );
    expect(queryByText("Retry")).toBeNull();
    expect(getByText("Open logs")).toBeTruthy();
    expect(getByText("Open installer page")).toBeTruthy();
    const text =
      getByText("Open logs").closest('[data-testid="help-launch-error-banner"]')?.textContent ?? "";
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

  it("renders the exact CTA matrix per kind (label + variant + order)", () => {
    const cases: { kind: LaunchErrorKind; labels: string[] }[] = [
      { kind: "mcp-server-not-started", labels: ["Retry", "Open settings"] },
      { kind: "mcp-probe-failed", labels: ["Retry", "Open settings"] },
      { kind: "skills-sync-failed", labels: ["Retry", "Open logs"] },
      { kind: "spawn-failed", labels: ["Retry"] },
      { kind: "folder-unavailable", labels: ["Open logs", "Open installer page"] },
    ];
    for (const { kind, labels } of cases) {
      const { getByTestId, queryAllByRole, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      const banner = getByTestId("help-launch-error-banner");
      const actionRow = banner.querySelector(".flex.items-center.gap-2.flex-wrap.pl-5");
      expect(actionRow).not.toBeNull();
      const buttons = Array.from(actionRow!.querySelectorAll("button"));
      const actualLabels = buttons.map((b) => b.textContent?.trim() ?? "");
      expect(actualLabels).toEqual(labels);
      // folder-unavailable: "Open installer page" is the primary CTA, so it
      // carries the bg-daintree-text/10 fill — keep the visual rank honest.
      if (kind === "folder-unavailable") {
        const primary = buttons.find((b) => b.textContent?.trim() === "Open installer page");
        expect(primary?.className).toMatch(/font-medium/);
        expect(primary?.className).toMatch(/bg-daintree-text\/10/);
        const secondary = buttons.find((b) => b.textContent?.trim() === "Open logs");
        expect(secondary?.className).not.toMatch(/font-medium/);
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

  it("gives skills-sync-failed an escape hatch beyond Retry via Open logs", () => {
    const onOpenLogs = vi.fn();
    const onRetryLaunch = vi.fn();
    const { getByText } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "skills-sync-failed" }}
        onRetryLaunch={onRetryLaunch}
        onOpenLogs={onOpenLogs}
      />
    );
    fireEvent.click(getByText("Open logs"));
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
    expect(onRetryLaunch).not.toHaveBeenCalled();
    fireEvent.click(getByText("Retry"));
    expect(onRetryLaunch).toHaveBeenCalledTimes(1);
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
    expect(getByText("Resumed your previous session.")).toBeTruthy();
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
  it("renders nothing for the grant slot when activeGrant is null", () => {
    const { queryByTestId } = render(<HelpPanelBanners {...baseProps()} />);
    expect(queryByTestId("help-grant-active-banner")).toBeNull();
  });

  it("renders the tool id and a mm:ss countdown derived from expiresAt", () => {
    // 2 min 5 s out — ceil keeps it at 2:0x even with a few ms of render lag.
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrant={{
          sessionId: "s1",
          toolId: "search_docs",
          ttlMs: 900_000,
          expiresAt: Date.now() + 125_000,
        }}
      />
    );
    const banner = getByTestId("help-grant-active-banner");
    expect(banner.getAttribute("role")).toBe("status");
    const text = banner.textContent ?? "";
    expect(text).toContain("search_docs");
    // The displayed remaining time is derived, not a hardcoded literal.
    expect(text).toMatch(/2:0\d/);
  });

  it("shows a smaller remaining time for a nearer expiry (countdown is computed)", () => {
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrant={{
          sessionId: "s1",
          toolId: "t1",
          ttlMs: 900_000,
          expiresAt: Date.now() + 5_000,
        }}
      />
    );
    const text = getByTestId("help-grant-active-banner").textContent ?? "";
    expect(text).toMatch(/0:0[45]/);
  });

  it("clamps a past expiry to 0:00 rather than rendering a negative timer", () => {
    const { getByTestId } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrant={{
          sessionId: "s1",
          toolId: "t1",
          ttlMs: 900_000,
          expiresAt: Date.now() - 10_000,
        }}
      />
    );
    expect(getByTestId("help-grant-active-banner").textContent).toContain("0:00");
  });

  it("ticks the countdown down over time and stops after unmount (no leak)", () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const { getByTestId, unmount } = render(
        <HelpPanelBanners
          {...baseProps()}
          activeGrant={{ sessionId: "s1", toolId: "t1", ttlMs: 900_000, expiresAt: base + 5_000 }}
        />
      );
      expect(getByTestId("help-grant-active-banner").textContent).toContain("0:05");
      // Advance both wall-clock and the interval so the derived value updates.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(getByTestId("help-grant-active-banner").textContent).toContain("0:03");
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

  it("wires Revoke access to onRevokeGrant and disables it while revoking", () => {
    const onRevokeGrant = vi.fn();
    const { getByText, rerender } = render(
      <HelpPanelBanners
        {...baseProps()}
        activeGrant={{
          sessionId: "s1",
          toolId: "t1",
          ttlMs: 900_000,
          expiresAt: Date.now() + 60_000,
        }}
        onRevokeGrant={onRevokeGrant}
      />
    );
    const button = getByText("Revoke access");
    fireEvent.click(button);
    expect(onRevokeGrant).toHaveBeenCalledTimes(1);

    rerender(
      <HelpPanelBanners
        {...baseProps()}
        activeGrant={{
          sessionId: "s1",
          toolId: "t1",
          ttlMs: 900_000,
          expiresAt: Date.now() + 60_000,
        }}
        isRevokingGrant={true}
        onRevokeGrant={onRevokeGrant}
      />
    );
    expect((getByText("Revoke access") as HTMLButtonElement).disabled).toBe(true);
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
