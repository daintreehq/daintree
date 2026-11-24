// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// Discloses only when the caller says so: the real component falls back to its own
// measurement of the child, which would hide a caller that dropped `isTruncated`.
vi.mock("@/components/ui/TruncatedTooltip", () => ({
  TruncatedTooltip: ({
    children,
    content,
    isTruncated,
  }: {
    children: React.ReactNode;
    content: React.ReactNode;
    isTruncated?: boolean;
  }) => (
    <>
      {children}
      {isTruncated === true && <div data-testid="tooltip-content">{content}</div>}
    </>
  ),
}));

const truncation = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useTruncationDetection", () => ({
  useTruncationDetection: () => ({ ref: () => {}, isTruncated: truncation.value }),
}));

import { ScopeChip } from "../SettingsDialog";
import { HostNameText } from "../Hosts/SettingsMachinePicker";
import { DraftPreview } from "../RunHistorySettingsTab";
import { InvitationUrl } from "../Decisions/DecisionsPairingDialog";

const LONG_HOST = "build-runner-eu-west-07.ci.internal";

function setClamp(clamped: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => (clamped ? 120 : 20),
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 20,
  });
}

describe("Settings disclosure tooltips", () => {
  beforeEach(() => {
    truncation.value = false;
    setClamp(false);
  });
  afterEach(() => {
    cleanup();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  });

  it("ScopeChip tells a cross-scope result where it switches to, and only then", () => {
    const { unmount } = render(<ScopeChip scope="project" projectLabel="Helios" crossScope />);
    expect(screen.getByTestId("tooltip-content").textContent).toBe(
      "Switches to project settings for Helios"
    );
    unmount();

    render(<ScopeChip scope="project" projectLabel="Helios" />);
    expect(screen.queryByTestId("tooltip-content")).toBeNull();
  });

  it.each([LONG_HOST, "studio-01"])(
    "HostNameText %s discloses its full name only when cut",
    (name) => {
      const { unmount } = render(<HostNameText name={name} />);
      expect(screen.queryByTestId("tooltip-content")).toBeNull();
      unmount();

      truncation.value = true;
      render(<HostNameText name={name} />);
      expect(screen.getByTestId("tooltip-content").textContent).toBe(name);
    }
  );

  it("DraftPreview discloses the whole draft only when the clamp hides lines", () => {
    const { unmount } = render(<DraftPreview text="short draft" />);
    expect(screen.queryByTestId("tooltip-content")).toBeNull();
    unmount();

    setClamp(true);
    render(<DraftPreview text="a long draft" />);
    expect(screen.getByTestId("tooltip-content").textContent).toBe("a long draft");
  });

  it("InvitationUrl discloses the whole link only when the clamp hides lines", () => {
    const url = "https://relay.example/pair#payload";
    const { unmount } = render(<InvitationUrl url={url} />);
    expect(screen.queryByTestId("tooltip-content")).toBeNull();
    unmount();

    setClamp(true);
    render(<InvitationUrl url={url} />);
    expect(screen.getByTestId("tooltip-content").textContent).toBe(url);
  });
});
