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
    onOpenLogs: vi.fn(),
    onOpenInstallerPage: vi.fn(),
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

  it("shows Open settings for both MCP failure kinds and only those", () => {
    const kindsWithSettings: LaunchErrorKind[] = ["mcp-server-not-started", "mcp-probe-failed"];
    for (const kind of kindsWithSettings) {
      const { queryByText, unmount } = render(
        <HelpPanelBanners {...baseProps()} launchError={{ agentId: "claude", kind }} />
      );
      expect(queryByText("Open settings")).toBeTruthy();
      unmount();
    }

    const kindsWithoutSettings: LaunchErrorKind[] = ["spawn-failed", "folder-unavailable"];
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
