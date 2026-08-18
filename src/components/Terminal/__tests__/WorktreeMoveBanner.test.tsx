// @vitest-environment jsdom
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorktreeMoveBanner } from "../WorktreeMoveBanner";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// jsdom ships no `matchMedia`, and `InlineStatusBanner` reads it through
// `useTitleBarSurface`. Same stub the sibling banner suite installs.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderBanner(destinationPath: string | undefined) {
  const onTell = vi.fn();
  const onDismiss = vi.fn();
  const result = render(
    <WindowControlsInsetProvider>
      <WorktreeMoveBanner destinationPath={destinationPath} onTell={onTell} onDismiss={onDismiss} />
    </WindowControlsInsetProvider>
  );
  return { ...result, onTell, onDismiss };
}

const PATH = "/repo/wt-b";
const TELL = "Tell the agent";
const DISMISS = "Dismiss worktree move notice";

describe("WorktreeMoveBanner", () => {
  it("names the destination it would send the agent to", () => {
    renderBanner(PATH);

    expect(screen.getByText("Agent may still be in the original worktree")).not.toBeNull();
    expect(screen.getByText("Tell it to continue in /repo/wt-b")).not.toBeNull();
  });

  it("offers exactly two outcomes", () => {
    // One action plus the built-in close. A third control for two outcomes is
    // what made the #11840 dialog feel like an interrogation.
    renderBanner(PATH);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: TELL })).not.toBeNull();
    expect(screen.getByRole("button", { name: DISMISS })).not.toBeNull();
  });

  it("is a polite status, not an alert", () => {
    // It reports a condition the user created; it must not interrupt them.
    const { container } = renderBanner(PATH);

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("reports the click through to tell", () => {
    const { onTell, onDismiss } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: TELL }));

    expect(onTell).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("reports the close through to dismiss", () => {
    const { onTell, onDismiss } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onTell).not.toHaveBeenCalled();
  });

  it("says so and disables the tell when the destination is gone", () => {
    // No fallback path is offered — guessing one is how a destructive default
    // ships (#7880).
    const { onTell } = renderBanner(undefined);

    expect(screen.getByText("The destination worktree is no longer available")).not.toBeNull();
    const tell = screen.getByRole("button", { name: TELL });
    expect(tell.hasAttribute("disabled")).toBe(true);

    fireEvent.click(tell);
    expect(onTell).not.toHaveBeenCalled();
  });

  it("keeps the dismiss available when the destination is gone", () => {
    // Losing the worktree must not trap the bar on the pane.
    const { onDismiss } = renderBanner(undefined);

    const dismiss = screen.getByRole("button", { name: DISMISS });
    expect(dismiss.hasAttribute("disabled")).toBe(false);

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
