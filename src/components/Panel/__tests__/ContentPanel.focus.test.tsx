// @vitest-environment jsdom
/**
 * ContentPanel — panel-root focus target for non-PTY kinds (#11109).
 *
 * Macro-grid Enter used to reach xterm only, so it silently no-opped on
 * browser/dev-preview/file panels. ContentPanel now registers its root as the
 * focus target for every non-PTY kind. PTY kinds are deliberately excluded:
 * TerminalPane owns their registry entry and routes focus to xterm or the
 * hybrid input bar.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
import { act, render, cleanup } from "@testing-library/react";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    agentId: undefined,
    iconId: undefined,
    runtimeKind: "shell",
    isAgent: false,
  }),
}));

vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalHeaderContent", () => ({
  TerminalHeaderContent: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ContentPanel } from "../ContentPanel";
import { focusPanelInput } from "../panelFocusRegistry";

type PanelKind = "terminal" | "browser" | "dev-preview" | "review" | "file";

interface RenderExtras {
  tabIndex?: number;
  ref?: React.Ref<HTMLDivElement>;
  isFocused?: boolean;
  children?: React.ReactNode;
}

function panelElement(id: string, kind: PanelKind, extra?: RenderExtras) {
  return (
    <ContentPanel
      id={id}
      title={`Panel ${id}`}
      kind={kind}
      isFocused={extra?.isFocused ?? false}
      onFocus={() => {}}
      onClose={() => {}}
      tabIndex={extra?.tabIndex}
      ref={extra?.ref}
    >
      {extra?.children ?? <div data-testid="panel-body" />}
    </ContentPanel>
  );
}

function renderPanel(id: string, kind: PanelKind = "browser", extra?: RenderExtras) {
  const view = render(panelElement(id, kind, extra));
  return {
    ...view,
    focus: (isFocused: boolean) =>
      act(() => {
        view.rerender(panelElement(id, kind, { ...extra, isFocused }));
      }),
  };
}

function panelRoot(container: HTMLElement, id: string): HTMLElement {
  const root = container.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  if (!root) throw new Error(`panel root ${id} not rendered`);
  return root;
}

describe("ContentPanel focus target (#11109)", () => {
  afterEach(cleanup);

  it.each<PanelKind>(["browser", "dev-preview", "review", "file"])(
    "moves focus to the panel root and confirms the handoff for %s panels",
    (kind) => {
      const { container } = renderPanel("p-1", kind);
      const root = panelRoot(container, "p-1");

      let accepted = false;
      act(() => {
        accepted = focusPanelInput("p-1");
      });

      expect(accepted).toBe(true);
      expect(document.activeElement).toBe(root);
    }
  );

  it("does not claim the registry entry for PTY kinds", () => {
    // TerminalPane registers the handler for terminals — a second owner here
    // would race it for the same panel id and could strand focus on the
    // container instead of xterm or the hybrid input bar.
    renderPanel("t-1", "terminal");

    expect(focusPanelInput("t-1")).toBe(false);
  });

  it("keeps an explicit tabIndex so TerminalPane stays in the Tab sequence", () => {
    const { container } = renderPanel("t-1", "terminal", { tabIndex: 0 });

    expect(panelRoot(container, "t-1").getAttribute("tabindex")).toBe("0");
  });

  it("keeps the panel root out of the Tab sequence when no tabIndex is given", () => {
    const { container } = renderPanel("p-1", "browser");

    // Negative, not specifically -1: the invariant is "script-focusable but not
    // Tab-reachable". The focus-handoff tests above prove the focusability half.
    expect(panelRoot(container, "p-1").tabIndex).toBeLessThan(0);
  });

  it("still forwards the root element to a caller's ref", () => {
    // TerminalPane forwards a ref here and observes the same node for resize
    // and visibility — composing the internal focus ref must not displace it.
    const ref = createRef<HTMLDivElement>();
    const { container } = renderPanel("p-1", "browser", { ref });

    expect(ref.current).toBe(panelRoot(container, "p-1"));
  });

  it("runs a callback ref's React 19 cleanup on unmount", () => {
    // React skips the usual `null` call when a ref callback returns a cleanup,
    // so a composed ref that swallows the cleanup leaks the caller's teardown.
    const teardown = vi.fn<() => void>();
    const { container, unmount } = renderPanel("p-1", "browser", {
      ref: (node) => (node ? teardown : undefined),
    });

    expect(panelRoot(container, "p-1")).toBeTruthy();
    expect(teardown).not.toHaveBeenCalled();

    unmount();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("releases the registry entry on unmount", () => {
    const { unmount } = renderPanel("p-1", "browser");
    unmount();

    expect(focusPanelInput("p-1")).toBe(false);
  });
});

/**
 * The registry alone only covers macro-grid Enter and in-group tab switches.
 * Arrow navigation, Cmd+1..9, focusNext/Previous and agent-state cycling all
 * just write `focusedId` — so becoming the focused pane has to move DOM focus
 * on its own, or the pane paints as selected while keystrokes keep landing in
 * whatever held the keyboard before.
 */
describe("ContentPanel reactive focus (#11133)", () => {
  afterEach(cleanup);

  it.each<PanelKind>(["browser", "dev-preview", "review", "file"])(
    "claims DOM focus for a %s panel that becomes focused without the registry",
    (kind) => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();

      const { container, focus } = renderPanel("p-1", kind);
      expect(document.activeElement).toBe(outside);

      focus(true);

      expect(document.activeElement).toBe(panelRoot(container, "p-1"));
      outside.remove();
    }
  );

  it("leaves focus on the panel's own input rather than yanking it to the root", () => {
    // FilePane's search box lives inside the root. Becoming the focused pane
    // must not pull the caret out of the field the user is typing in.
    const { container, focus } = renderPanel("p-1", "file", {
      children: <input data-testid="search" />,
    });
    const search = container.querySelector<HTMLInputElement>('[data-testid="search"]')!;
    act(() => search.focus());

    focus(true);

    expect(document.activeElement).toBe(search);
  });

  it("reports a handoff as accepted when the panel already owns the keyboard", () => {
    const { container } = renderPanel("p-1", "file", {
      children: <input data-testid="search" />,
    });
    const search = container.querySelector<HTMLInputElement>('[data-testid="search"]')!;
    act(() => search.focus());

    let accepted = false;
    act(() => {
      accepted = focusPanelInput("p-1");
    });

    // The pane has focus — that is the outcome the caller asked for, so the
    // handoff completed even though nothing moved.
    expect(accepted).toBe(true);
    expect(document.activeElement).toBe(search);
  });

  it("does not reactively claim focus for PTY kinds", () => {
    // TerminalPane routes PTY focus to xterm or the hybrid input bar. A second
    // claimant here would land focus on the container instead.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const { focus } = renderPanel("t-1", "terminal");
    focus(true);

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
