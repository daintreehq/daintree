// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpPanelBanners } from "../HelpPanelBanners";
import type { LaunchErrorKind } from "@/controllers/HelpSessionController";

function baseProps() {
  return {
    showResumeBanner: false,
    preflightSnapshot: null,
    tierMismatch: null,
    launchError: null,
    isApprovingTier: false,
    onDismissResume: vi.fn(),
    onDismissSnapshot: vi.fn(),
    onDismissTierMismatch: vi.fn(),
    onApproveOnce: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onRetryLaunch: vi.fn(),
    onDismissLaunchError: vi.fn(),
    onOpenAssistantSettings: vi.fn(),
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

  it("shows the settings shortcut only for the server-not-started kind", () => {
    const { queryByText, rerender } = render(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "mcp-server-not-started" }}
      />
    );
    expect(queryByText("Open settings")).toBeTruthy();

    rerender(
      <HelpPanelBanners
        {...baseProps()}
        launchError={{ agentId: "claude", kind: "spawn-failed" }}
      />
    );
    expect(queryByText("Open settings")).toBeNull();
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
