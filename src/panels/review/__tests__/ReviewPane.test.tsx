// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #11116: ReviewPane dropped the grid-supplied `onClose` and handed
// ReviewHubContent a literal no-op, leaving the pane's own Close button and its
// Escape fallthrough dead. Both controls funnel through that single prop, so
// stub the (very heavy) child to capture what the pane forwards and assert the
// seam directly.
//
// The stub wires its close button as `onClick={props.onClose}` — bare, exactly
// like the real ReviewHubContent. That matters: React hands a MouseEvent to a
// bare handler, so a naive `onClose={onClose}` pass-through would deliver a
// truthy object as `force` and route the panel handler to permanent removal
// (removePanel) instead of the recoverable trash (trashPanelGroup, the source
// of Reopen Last Closed). Reproducing the bare wiring is what lets this test
// catch that.
//
// The pane's other seam with this child — handing it the container as its
// Escape `keyboardScope` — is covered in ReviewPane.focus.test.tsx.
interface CapturedReviewHubProps {
  isOpen: boolean;
  worktreePath: string;
  onClose: () => void;
}

const reviewHubContentProps: CapturedReviewHubProps[] = [];

vi.mock("@/components/Worktree/ReviewHub/ReviewHubContent", () => ({
  ReviewHubContent: (props: CapturedReviewHubProps) => {
    reviewHubContentProps.push(props);
    // The real child renders nothing when closed. Honour that here too, so a
    // regression that stops opening the pane can't leave these tests green.
    if (!props.isOpen) return null;
    return (
      <button data-testid="review-hub-close" onClick={props.onClose}>
        Close
      </button>
    );
  },
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) =>
    selector({ worktrees: new Map([["wt-1", { path: "/repo/wt-1" }]]) }),
}));

import { ReviewPane } from "../ReviewPane";

function lastReviewHubContentProps(): CapturedReviewHubProps {
  const props = reviewHubContentProps.at(-1);
  if (!props) throw new Error("ReviewHubContent was not rendered");
  return props;
}

afterEach(() => {
  reviewHubContentProps.length = 0;
});

describe("ReviewPane close wiring", () => {
  it("closes the panel — recoverably, not forcibly — when the Close button is clicked", () => {
    const onClose = vi.fn<(force?: boolean) => void>();
    render(<ReviewPane id="review-1" worktreeId="wt-1" onClose={onClose} />);

    // Pin the click as the cause: a pane that closed itself on mount would
    // otherwise land on the same call count.
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("review-hub-close"));

    // The call itself is what the no-op regression killed. The argument is the
    // subtler half: usePanelHandlers branches on `if (force)`, and a truthy
    // value skips the optimistic trash to delete the panel outright, so Reopen
    // Last Closed can't bring it back. The click's MouseEvent must not land
    // there — assert both, or a no-op child would satisfy the arg check
    // vacuously.
    expect(onClose).toHaveBeenCalledTimes(1);
    const [force] = onClose.mock.calls[0] ?? [];
    expect(force).toBeFalsy();
  });

  it("forwards a callback that closes the panel when invoked with no argument", () => {
    const onClose = vi.fn<(force?: boolean) => void>();
    render(<ReviewPane id="review-1" worktreeId="wt-1" onClose={onClose} />);

    // This is the shape ReviewHubContent's Escape handler uses: after clearing
    // any selected file or path, its last resort is a bare `onClose()`. Driving
    // real Escape would mean mounting the child for real (a ~25-mock IPC
    // surface) to retest key handling this fix doesn't touch and the ReviewHub
    // suites already cover — so assert the seam, not the child.
    lastReviewHubContentProps().onClose();

    expect(onClose).toHaveBeenCalledTimes(1);
    const [force] = onClose.mock.calls[0] ?? [];
    expect(force).toBeFalsy();
  });
});

// ContentPanel is the only other writer of `data-panel-id`/`data-panel-location`,
// and review is the one built-in kind that renders no ContentPanel — so this pane
// owns that identity contract itself. Six production consumers resolve a panel by
// walking the DOM up from a descendant (useGlobalKeybindings' Cmd+W grid/dock
// gate, useGridNavigation, useTypeAnywhere/typeAnywhere, optimisticPanelClose),
// so these assert the lookup the way those consumers perform it. Checking the
// attributes in isolation would pass even if they landed on an inner node that
// no `closest()` walk from real content can reach.
describe("ReviewPane panel DOM contract", () => {
  // Verbatim from lib/typeAnywhere.ts and useGlobalKeybindings.ts respectively —
  // if either consumer's selector drifts, these stop describing production.
  const PANEL_ROOT = "[data-panel-id]";
  const GRID_OR_DOCK = "[data-panel-location='grid'],[data-panel-location='dock']";

  it.each(["grid", "dialog"] as const)(
    "reports the pane's own id and its %s location to a descendant walking up",
    (location) => {
      // Derive the id from the case so a hardcoded attribute can't satisfy this.
      const id = `review-${location}-panel`;
      render(
        <ReviewPane id={id} worktreeId="wt-1" onClose={vi.fn()} location={location} />
      );

      const root = screen.getByTestId("review-hub-close").closest(PANEL_ROOT);

      expect(root).not.toBeNull();
      expect(root?.getAttribute("data-panel-id")).toBe(id);
      expect(root?.getAttribute("data-panel-location")).toBe(location);
    }
  );

  it("answers the grid/dock gate for a grid pane but not a dialog-hosted one", () => {
    // The consequence that matters: Cmd+W closes a focused grid panel, while a
    // dialog-hosted review must fall through to the escape stack (AppDialog owns
    // that layer). Both come from the same prop, so a hardcoded "grid" would
    // pass the case above and still break the dialog by trashing the panel.
    const grid = render(
      <ReviewPane id="review-grid" worktreeId="wt-1" onClose={vi.fn()} location="grid" />
    );
    expect(grid.container.querySelector(PANEL_ROOT)?.matches(GRID_OR_DOCK)).toBe(true);
    grid.unmount();

    const dialog = render(
      <ReviewPane id="review-grid" worktreeId="wt-1" onClose={vi.fn()} location="dialog" />
    );
    expect(dialog.container.querySelector(PANEL_ROOT)?.matches(GRID_OR_DOCK)).toBe(false);
  });

  it("stays identifiable when the worktree path has not resolved", () => {
    // The empty-state branch is a separate root. A panel that lost its identity
    // whenever its worktree was briefly unavailable would drop out of optimistic
    // close and grid navigation mid-flight, and would make grid counts flicker
    // across the empty-to-loaded transition.
    const { container } = render(<ReviewPane id="review-empty" onClose={vi.fn()} />);

    const roots = container.querySelectorAll(PANEL_ROOT);

    // Exactly one: a future wrapper that re-tags the pane would nest a second
    // root, and `closest()` would then resolve consumers to the wrong element.
    expect(roots).toHaveLength(1);
    expect(roots[0]?.getAttribute("data-panel-id")).toBe("review-empty");
    expect(roots[0]?.matches(GRID_OR_DOCK)).toBe(true);
  });
});
