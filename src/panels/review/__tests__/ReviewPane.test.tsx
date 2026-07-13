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
interface CapturedReviewHubProps {
  isOpen: boolean;
  worktreePath: string;
  onClose: () => void;
  keyboardScope?: Document | HTMLElement | null;
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

  it("scopes the child's Escape listener to the pane's own root element", () => {
    const onClose = vi.fn<(force?: boolean) => void>();
    const { container } = render(<ReviewPane id="review-1" worktreeId="wt-1" onClose={onClose} />);

    // A missing scope makes ReviewHubContent fall back to a document-wide
    // capture listener that swallows Escape across the whole app.
    expect(lastReviewHubContentProps().keyboardScope).toBe(container.firstChild);
  });
});
