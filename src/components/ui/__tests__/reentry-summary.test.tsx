// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { ReEntrySummary, AUTO_DISMISS_MS } from "../ReEntrySummary";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import type { ReEntrySummaryState, WorktreeRow } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: vi.fn(),
}));

// No requestAnimationFrame stub: `vi.useFakeTimers()` fakes rAF itself, so any
// stub here is dead — the fake clock's rAF is what actually runs, and it fires
// on a 16ms frame (see FRAME_MS below).

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: "e1",
    type: "info",
    message: "test",
    timestamp: 1,
    seenAsToast: false,
    summarized: false,
    countable: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    worktreeId: "wt-1",
    worktreeName: "feature-test",
    worstType: "error" as NotificationHistoryEntry["type"],
    highlightTitle: "Build failed",
    entryCount: 2,
    ...overrides,
  };
}

function makeState(overrides: Partial<ReEntrySummaryState> = {}): ReEntrySummaryState {
  return {
    visible: true,
    entries: [],
    rows: [],
    overflowCount: 0,
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("ReEntrySummary", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
      getState: () => ({
        worktrees: new Map([
          [
            "wt-1",
            {
              id: "wt-1",
              path: "/tmp/wt-1",
              name: "feature-test",
              isCurrent: false,
              worktreeId: "wt-1",
            },
          ],
          [
            "wt-2",
            {
              id: "wt-2",
              path: "/tmp/wt-2",
              name: "feature-other",
              isCurrent: false,
              worktreeId: "wt-2",
            },
          ],
          [
            "wt-42",
            {
              id: "wt-42",
              path: "/tmp/wt-42",
              name: "fix-bug",
              isCurrent: false,
              worktreeId: "wt-42",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.body.dataset.performanceMode;
  });

  // The entrance is RAF-deferred, so the card mounts hidden and only reaches its
  // visible state a frame later. `vi.useFakeTimers()` fakes requestAnimationFrame
  // itself, and its rAF fires on a 16ms frame — so the clock has to advance a
  // full frame, not 0ms.
  const FRAME_MS = 16;
  const flushEntry = () =>
    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
    });

  it("renders nothing when state.visible is false", () => {
    // The card portals into document.body, so assert against the screen — the
    // RTL container is empty either way.
    render(<ReEntrySummary state={makeState({ visible: false })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders worktree rows with severity icon, name, and title", () => {
    const state = makeState({
      rows: [
        makeRow({
          worktreeId: "wt-1",
          worktreeName: "feature-foo",
          worstType: "error",
          highlightTitle: "Build failed",
        }),
        makeRow({
          worktreeId: "wt-2",
          worktreeName: "feature-bar",
          worstType: "warning",
          highlightTitle: "Tests flaky",
        }),
      ],
    });
    render(<ReEntrySummary state={state} />);
    expect(screen.getByText("While you were away")).toBeTruthy();
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.getByText("feature-bar")).toBeTruthy();
    expect(screen.getByText("Tests flaky")).toBeTruthy();
  });

  it("has role=status", () => {
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("dismiss button calls dismiss", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("Open Notifications button calls openNotificationCenter", async () => {
    const { useUIStore } = await import("@/store/uiStore");
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByText("Open Notifications"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("clicking a worktree row calls selectWorktree and dismiss", async () => {
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    const selectSpy = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree: selectSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worktreeId: "wt-42", worktreeName: "fix-bug" })],
        })}
      />
    );
    fireEvent.click(screen.getByText("fix-bug"));
    expect(selectSpy).toHaveBeenCalledWith("wt-42");
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("renders +N more overflow row when overflowCount > 0", () => {
    const state = makeState({
      rows: [
        makeRow({ worktreeId: "wt-1", worktreeName: "a" }),
        makeRow({ worktreeId: "wt-2", worktreeName: "b" }),
        makeRow({ worktreeId: "wt-3", worktreeName: "c" }),
      ],
      overflowCount: 2,
    });
    render(<ReEntrySummary state={state} />);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("overflow row opens notification center", async () => {
    const { useUIStore } = await import("@/store/uiStore");
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow()],
          overflowCount: 3,
        })}
      />
    );
    fireEvent.click(screen.getByText("+3 more"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("auto-dismisses after 8 seconds", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    expect(dismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("pauses auto-dismiss on mouse enter and resumes on mouse leave", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    const card = screen.getByRole("status");

    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS + 2000);
    });
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("pin button toggles aria-pressed and prevents auto-dismiss", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );

    const pinButton = screen.getByLabelText("Pin summary");
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("unpin resumes auto-dismiss behavior", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );

    const pinButton = screen.getByLabelText("Pin summary");
    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("resets pin state when summary goes invisible then reappears", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ReEntrySummary
        state={makeState({
          visible: true,
          dismiss,
          rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "First" })],
        })}
      />
    );

    fireEvent.click(screen.getByLabelText("Pin summary"));
    expect(screen.getByLabelText("Unpin summary").getAttribute("aria-pressed")).toBe("true");

    rerender(
      <ReEntrySummary
        state={makeState({
          visible: false,
          dismiss,
          rows: [],
        })}
      />
    );

    rerender(
      <ReEntrySummary
        state={makeState({
          visible: true,
          dismiss,
          rows: [makeRow({ worktreeId: "wt-2", highlightTitle: "Second" })],
        })}
      />
    );

    expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("false");
  });

  it("restarts auto-dismiss timer when rows change but entryCount stays the same", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          entries: [makeEntry({ id: "a", message: "x" })],
          rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "First" })],
        })}
      />
    );

    act(() => {
      vi.advanceTimersByTime(7000);
    });

    rerender(
      <ReEntrySummary
        state={makeState({
          dismiss,
          entries: [makeEntry({ id: "b", message: "y" })],
          rows: [makeRow({ worktreeId: "wt-2", highlightTitle: "Second" })],
        })}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not steal focus", () => {
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    const card = screen.getByRole("status");
    expect(document.activeElement).not.toBe(card);
  });

  describe("exit animation (#11163)", () => {
    // `useReEntrySummary` returns EMPTY content the instant `visible` flips
    // false, so a dismissed card arrives here with no rows at all. These tests
    // drive the real `useAnimatedPresence` rather than mocking it — the whole
    // point of the fix is how long the card stays mounted.
    const dismissedState = (dismiss: () => void) =>
      makeState({ visible: false, dismiss, rows: [], overflowCount: 0 });

    it("keeps the card mounted for the exit window, then unmounts it", () => {
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary state={makeState({ dismiss, rows: [makeRow()] })} />
      );
      flushEntry();
      expect(screen.getByRole("status")).toBeTruthy();

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);
      expect(screen.getByRole("status")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(UI_EXIT_DURATION - 1);
      });
      expect(screen.queryByRole("status")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("keeps rendering the dismissed summary's rows while it slides out", () => {
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            rows: [makeRow({ worktreeName: "feature-foo", highlightTitle: "Build failed" })],
            overflowCount: 2,
          })}
        />
      );
      flushEntry();

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);

      expect(screen.getByText("feature-foo")).toBeTruthy();
      expect(screen.getByText("Build failed")).toBeTruthy();
      expect(screen.getByText("+2 more")).toBeTruthy();
    });

    it("makes the exiting card inert rather than aria-hidden", () => {
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary state={makeState({ dismiss, rows: [makeRow()] })} />
      );
      flushEntry();
      expect(screen.getByRole("status").hasAttribute("inert")).toBe(false);

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);

      const card = screen.getByRole("status");
      // `inert` blocks pointer AND keyboard activation on the fading card and
      // blurs the focused dismiss button. aria-hidden would do neither, and
      // Chromium blocks it over a focused element.
      expect(card.hasAttribute("inert")).toBe(true);
      expect(card.getAttribute("aria-hidden")).toBeNull();
    });

    it("clears a stuck hover pause when the card is dismissed while hovered", () => {
      // onMouseLeave never fires for a node pulled out from under the pointer,
      // and this component never unmounts — so a leaked `isPaused` would
      // disable auto-dismiss for every later summary.
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "a" })],
            rows: [makeRow({ worktreeId: "wt-1" })],
          })}
        />
      );
      flushEntry();

      fireEvent.mouseEnter(screen.getByRole("status"));
      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);
      act(() => {
        vi.advanceTimersByTime(UI_EXIT_DURATION);
      });
      expect(screen.queryByRole("status")).toBeNull();

      rerender(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "b" })],
            rows: [makeRow({ worktreeId: "wt-2" })],
          })}
        />
      );
      flushEntry();
      dismiss.mockClear();

      act(() => {
        vi.advanceTimersByTime(AUTO_DISMISS_MS);
      });
      expect(dismiss).toHaveBeenCalledOnce();
    });

    it("restarts the auto-dismiss timer for a replacement summary on the same worktrees", () => {
      // Same worktree ids and same entry count as the outgoing summary: keyed on
      // either of those alone, the replacement would inherit the old, nearly
      // expired timer and be dismissed almost immediately.
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "a" })],
            rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "First" })],
          })}
        />
      );
      flushEntry();

      act(() => {
        vi.advanceTimersByTime(AUTO_DISMISS_MS - 500);
      });
      expect(dismiss).not.toHaveBeenCalled();

      rerender(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "b" })],
            rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "Second" })],
          })}
        />
      );

      // The old timer would have fired here; the replacement gets a full window.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(dismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(AUTO_DISMISS_MS);
      });
      expect(dismiss).toHaveBeenCalledOnce();
    });

    it("resets the pin for a replacement summary on the same worktrees", () => {
      // The pin half of the same collision: a replacement summary must not
      // silently inherit the outgoing summary's pin.
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "a" })],
            rows: [makeRow({ worktreeId: "wt-1" })],
          })}
        />
      );
      flushEntry();

      fireEvent.click(screen.getByLabelText("Pin summary"));
      expect(screen.getByLabelText("Unpin summary").getAttribute("aria-pressed")).toBe("true");

      rerender(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "b" })],
            rows: [makeRow({ worktreeId: "wt-1" })],
          })}
        />
      );

      expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("false");
    });

    it("cancels the pending exit and swaps in new content when a summary arrives mid-exit", () => {
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            rows: [makeRow({ worktreeId: "wt-1", worktreeName: "first-wt" })],
          })}
        />
      );
      flushEntry();

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);
      act(() => {
        vi.advanceTimersByTime(Math.floor(UI_EXIT_DURATION / 2));
      });
      expect(screen.getByText("first-wt")).toBeTruthy();

      rerender(
        <ReEntrySummary
          state={makeState({
            visible: true,
            dismiss,
            rows: [makeRow({ worktreeId: "wt-2", worktreeName: "second-wt" })],
          })}
        />
      );
      flushEntry();

      expect(screen.getByText("second-wt")).toBeTruthy();
      expect(screen.queryByText("first-wt")).toBeNull();

      // The superseded close timer must not fire and tear down the new card.
      act(() => {
        vi.advanceTimersByTime(UI_EXIT_DURATION);
      });
      expect(screen.getByText("second-wt")).toBeTruthy();
    });

    it("switches from the enter tier to the exit tier on dismiss", () => {
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary state={makeState({ dismiss, rows: [makeRow()] })} />
      );
      flushEntry();

      const card = screen.getByRole("status");
      expect(card.style.transitionDuration).toBe(`${UI_ENTER_DURATION}ms`);
      expect(card.style.transitionTimingFunction).toBe(UI_ENTER_EASING);

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);

      expect(card.style.transitionDuration).toBe(`${UI_EXIT_DURATION}ms`);
      expect(card.style.transitionTimingFunction).toBe(UI_EXIT_EASING);
    });

    it("unmounts without an exit delay in performance mode", () => {
      document.body.dataset.performanceMode = "true";
      const dismiss = vi.fn();
      const { rerender } = render(
        <ReEntrySummary state={makeState({ dismiss, rows: [makeRow()] })} />
      );
      flushEntry();
      expect(screen.getByRole("status")).toBeTruthy();

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);

      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
