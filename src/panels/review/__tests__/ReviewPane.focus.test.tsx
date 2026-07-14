// @vitest-environment jsdom
/**
 * ReviewPane — self-registered focus target (#11109).
 *
 * Review is the one built-in kind that renders no ContentPanel, so it does not
 * inherit ContentPanel's panel-root registration and has to register its own
 * container. Without this, macro-grid Enter stays dead on review panes even
 * after every other kind is fixed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

const worktrees = new Map<string, { path: string }>([["w-1", { path: "/tmp/worktree" }]]);

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, { path: string }> }) => unknown) =>
    selector({ worktrees }),
}));

const keyboardScopes: (HTMLElement | undefined)[] = [];

vi.mock("@/components/Worktree/ReviewHub/ReviewHubContent", () => ({
  ReviewHubContent: ({ keyboardScope }: { keyboardScope?: HTMLElement }) => {
    keyboardScopes.push(keyboardScope);
    return <div data-testid="review-hub" />;
  },
}));

import { ReviewPane } from "../ReviewPane";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";

describe("ReviewPane focus target (#11109)", () => {
  afterEach(() => {
    keyboardScopes.length = 0;
    cleanup();
  });

  it("moves focus to its container and confirms the handoff", () => {
    const { container } = render(<ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} />);
    const root = container.firstElementChild;

    let accepted = false;
    act(() => {
      accepted = focusPanelInput("r-1");
    });

    expect(accepted).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("accepts focus in the worktree-unavailable branch too", () => {
    // Both return branches render a container; only wiring the happy path
    // would leave Enter dead on a review pane whose worktree went away.
    const { container } = render(<ReviewPane id="r-1" onClose={vi.fn()} />);
    const root = container.firstElementChild;

    let accepted = false;
    act(() => {
      accepted = focusPanelInput("r-1");
    });

    expect(accepted).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("still hands its container to ReviewHubContent as the keyboard scope", () => {
    // The container doubles as ReviewHubContent's Escape scope; a document-wide
    // fallback would swallow Escape across the whole app.
    const { container } = render(<ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} />);

    expect(keyboardScopes.at(-1)).toBe(container.firstElementChild);
  });

  it("releases the registry entry on unmount", () => {
    const { unmount } = render(<ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} />);
    unmount();

    expect(focusPanelInput("r-1")).toBe(false);
  });
});

/**
 * Registration alone only answers macro-grid Enter. Arrow navigation, Cmd+1..9
 * and the rest just write `focusedId`, so the pane has to claim DOM focus when
 * it becomes focused or the keyboard stays behind (#11133).
 */
describe("ReviewPane reactive focus (#11133)", () => {
  afterEach(() => {
    keyboardScopes.length = 0;
    cleanup();
  });

  it("claims DOM focus when it becomes the focused pane", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const { container, rerender } = render(
      <ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} />
    );
    expect(document.activeElement).toBe(outside);

    act(() => {
      rerender(<ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} isFocused />);
    });

    expect(document.activeElement).toBe(container.firstElementChild);
    outside.remove();
  });

  it("leaves focus alone when it already sits inside the pane", () => {
    const { container } = render(
      <ReviewPane id="r-1" worktreeId="w-1" onClose={vi.fn()} isFocused />
    );
    const hub = container.querySelector<HTMLElement>('[data-testid="review-hub"]')!;
    hub.tabIndex = -1;
    act(() => hub.focus());

    act(() => {
      expect(focusPanelInput("r-1")).toBe(true);
    });

    expect(document.activeElement).toBe(hub);
  });
});
