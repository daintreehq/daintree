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

// jsdom ships no `matchMedia`, and `InlineStatusBanner` reads it directly while
// rendering to resolve `prefers-reduced-motion`. Same stub the sibling banner
// suite installs.
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
  // Stands in for TerminalPane, which focuses the pane from a React `onClick`
  // on the shell wrapping every banner slot. A control inside the bar has to
  // stop the click before it reaches that handler.
  const onPaneClick = vi.fn();
  const result = render(
    <WindowControlsInsetProvider>
      <div onClick={onPaneClick}>
        <WorktreeMoveBanner
          destinationPath={destinationPath}
          onTell={onTell}
          onDismiss={onDismiss}
        />
      </div>
    </WindowControlsInsetProvider>
  );
  return { ...result, onTell, onDismiss, onPaneClick };
}

const PATH = "/repo/wt-b";
const TELL = `Tell it to continue in ${PATH}`;
const DISMISS = "Dismiss worktree move notice";

describe("WorktreeMoveBanner", () => {
  it("names the destination it would send the agent to", () => {
    renderBanner(PATH);

    expect(screen.getByText("Agent may still be in the original worktree")).not.toBeNull();
    expect(screen.getByRole("button", { name: TELL })).not.toBeNull();
  });

  it("offers exactly two outcomes while the destination resolves", () => {
    // One action plus the built-in close. A third control for two outcomes is
    // what made the #11840 dialog feel like an interrogation.
    renderBanner(PATH);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: TELL })).not.toBeNull();
    expect(screen.getByRole("button", { name: DISMISS })).not.toBeNull();
  });

  it("carries the whole sentence as the control, in the text column", () => {
    // #11868: the action *is* the sentence, not a boxed button beside it. A
    // banner action lives in the controls row, a sibling of the text column, so
    // it would only meet the title at the banner root — restoring the
    // indistinct fill this fix removed while still passing every other test
    // here. Walking up rather than indexing fixed levels keeps this honest
    // without pinning InlineStatusBanner's exact nesting.
    const { container } = renderBanner(PATH);

    const banner = container.querySelector('[role="status"]');
    const title = screen.getByText("Agent may still be in the original worktree");
    const tell = screen.getByRole("button", { name: TELL });

    let shared = title.parentElement;
    while (shared && !shared.contains(tell)) shared = shared.parentElement;

    expect(shared).not.toBeNull();
    expect(shared).not.toBe(banner);
    // Nesting it in the description would be invalid `<p>` markup and would
    // flatten the control away in the live region's announcement.
    expect(tell.closest("p")).toBeNull();
    // A native button, not a `role="button"` stand-in: Enter/Space activation
    // comes free, and TerminalPane's keydown handler passes over events whose
    // target is a BUTTON — a span would leak them to the pane.
    expect(tell).toBeInstanceOf(HTMLButtonElement);
  });

  it("is a polite status, not an alert", () => {
    // It reports a condition the user created; it must not interrupt them.
    const { container } = renderBanner(PATH);

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("reports the click through to tell without reaching the pane", () => {
    const { onTell, onDismiss, onPaneClick } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: TELL }));

    expect(onTell).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("reports the close through to dismiss without reaching the pane", () => {
    const { onTell, onDismiss, onPaneClick } = renderBanner(PATH);

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onTell).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("says so and offers no tell at all when the destination is gone", () => {
    // No fallback path is offered — guessing one is how a destructive default
    // ships (#7880) — and no dead disabled control either: there is nothing to
    // tell, so the sentence explains itself and the X is the only way out.
    renderBanner(undefined);

    expect(screen.getByText("The destination worktree is no longer available")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Tell it to continue in / })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
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
