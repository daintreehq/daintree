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
import type { ReEntrySummaryState, SummaryRow } from "@/hooks/useReEntrySummary";
import { navigateToNotificationSource } from "@/components/Notifications/notificationNavigation";
import { useUIStore } from "@/store/uiStore";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import type { ReactNode } from "react";

// The app root supplies the TooltipProvider. The trigger renders its child
// as-is; the content is dropped so tooltip text can't collide with queries.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Notifications/notificationNavigation", () => ({
  navigateToNotificationSource: vi.fn(),
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

function makeRow(
  overrides: Partial<Omit<SummaryRow, "highlight">> & {
    type?: NotificationHistoryEntry["type"];
    highlight?: Partial<NotificationHistoryEntry>;
  } = {}
): SummaryRow {
  const { type = "error", highlight, ...rest } = overrides;
  return {
    key: "worktree:wt-1",
    label: "feature-test",
    highlightTitle: "Build failed",
    entryCount: 2,
    ...rest,
    highlight: makeEntry({ type, context: { worktreeId: "wt-1" }, ...highlight }),
  };
}

function makeState(overrides: Partial<ReEntrySummaryState> = {}): ReEntrySummaryState {
  return {
    visible: true,
    entries: [],
    rows: [],
    overflowCount: 0,
    shownAt: Date.now(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("ReEntrySummary", () => {
  const realOpenNotificationCenter = useUIStore.getState().openNotificationCenter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(navigateToNotificationSource).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    useUIStore.setState({ openNotificationCenter: realOpenNotificationCenter });
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
          key: "worktree:wt-1",
          label: "feature-foo",
          type: "error",
          highlightTitle: "Build failed",
        }),
        makeRow({
          key: "worktree:wt-2",
          label: "feature-bar",
          type: "warning",
          highlightTitle: "Tests flaky",
          highlight: { context: { worktreeId: "wt-2" } },
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

  it("dismiss button calls dismiss", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  // The card's edge carries severity; the action beside it stays neutral, as
  // on the toast, and is marked for the forced-colors primary border.
  it("keeps its primary action neutral and marked for forced colours", () => {
    render(<ReEntrySummary state={makeState({ rows: [makeRow({ type: "error" })] })} />);
    const open = screen.getByRole("button", { name: "Open notifications" });
    expect(open.className).not.toMatch(/(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring)-status-/);
    expect(open.getAttribute("data-notification-action")).toBe("primary");
  });

  it("Open notifications button calls openNotificationCenter", () => {
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByText("Open notifications"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("clicking a row dismisses, then goes to that row's highlighted entry", async () => {
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });
    const dismiss = vi.fn();
    let dismissedBeforeNavigating = false;
    vi.mocked(navigateToNotificationSource).mockImplementation(() => {
      dismissedBeforeNavigating = dismiss.mock.calls.length === 1;
      return Promise.resolve(true);
    });

    const context = { worktreeId: "wt-42", panelId: "panel-7" };
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [
            makeRow({ key: "worktree:wt-1", label: "feature-test" }),
            makeRow({ key: "worktree:wt-42", label: "fix-bug", highlight: { context } }),
          ],
        })}
      />
    );
    fireEvent.click(screen.getByText("fix-bug"));
    await act(async () => {});

    expect(dismissedBeforeNavigating).toBe(true);
    expect(navigateToNotificationSource).toHaveBeenCalledOnce();
    expect(navigateToNotificationSource).toHaveBeenCalledWith(context);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the inbox when a row has nowhere live to land", async () => {
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });
    vi.mocked(navigateToNotificationSource).mockResolvedValue(false);

    const dismiss = vi.fn();
    const context = { worktreeId: "wt-removed" };
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [
            makeRow({ key: "worktree:wt-removed", label: "wt-removed", highlight: { context } }),
          ],
        })}
      />
    );
    fireEvent.click(screen.getByText("wt-removed"));
    await act(async () => {});

    expect(navigateToNotificationSource).toHaveBeenCalledWith(context);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledOnce();
  });

  it("opens the inbox when navigation throws", async () => {
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });
    vi.mocked(navigateToNotificationSource).mockRejectedValue(new Error("refused"));

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ label: "fix-bug", highlight: { context: { panelId: "panel-7" } } })],
        })}
      />
    );
    fireEvent.click(screen.getByText("fix-bug"));
    await act(async () => {});

    expect(dismiss).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledOnce();
  });

  it("shows when the highlighted entry happened, with the exact time on hover", () => {
    vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 0));
    const at = new Date(2026, 9, 26, 11, 55, 0).getTime();
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ label: "feature-foo", highlight: { timestamp: at } })],
        })}
      />
    );
    const time = () => screen.getByRole("status").querySelector("time");
    expect(time()?.textContent).toBe("5m ago");
    expect(time()?.getAttribute("dateTime")).toBe(new Date(at).toISOString());
    expect(time()?.getAttribute("title")).toBe(new Date(at).toLocaleString());

    // Static inside a live region: the label must not tick on its own.
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(time()?.textContent).toBe("5m ago");
  });

  it("overflow row opens notification center", () => {
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
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
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
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
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
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
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
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
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
          rows: [makeRow({ key: "worktree:wt-1", highlightTitle: "First" })],
        })}
      />
    );

    fireEvent.click(screen.getByLabelText("Pin summary"));
    expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("true");

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
          rows: [makeRow({ key: "worktree:wt-2", highlightTitle: "Second" })],
        })}
      />
    );

    expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not steal focus", () => {
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ type: "success", highlightTitle: "Done" })],
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
      // What the hook returns once dismissed: its EMPTY state, clock and all.
      makeState({ visible: false, dismiss, rows: [], overflowCount: 0, shownAt: 0 });

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
      const shownAt = Date.now();
      const { rerender } = render(
        <ReEntrySummary
          state={makeState({
            dismiss,
            shownAt,
            rows: [
              makeRow({
                label: "feature-foo",
                highlightTitle: "Build failed",
                highlight: { timestamp: shownAt - 5 * 60_000 },
              }),
            ],
            overflowCount: 2,
          })}
        />
      );
      flushEntry();

      rerender(<ReEntrySummary state={dismissedState(dismiss)} />);

      expect(screen.getByText("feature-foo")).toBeTruthy();
      expect(screen.getByText("Build failed")).toBeTruthy();
      expect(screen.getByText("+2 more")).toBeTruthy();
      // The age keeps the summary's own clock, not the EMPTY state's zero.
      expect(screen.getByRole("status").querySelector("time")?.textContent).toBe("5m ago");
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
            rows: [makeRow({ key: "worktree:wt-1" })],
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
            rows: [makeRow({ key: "worktree:wt-2" })],
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
            rows: [makeRow({ key: "worktree:wt-1", highlightTitle: "First" })],
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
            rows: [makeRow({ key: "worktree:wt-1", highlightTitle: "Second" })],
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
            rows: [makeRow({ key: "worktree:wt-1" })],
          })}
        />
      );
      flushEntry();

      fireEvent.click(screen.getByLabelText("Pin summary"));
      expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("true");

      rerender(
        <ReEntrySummary
          state={makeState({
            dismiss,
            entries: [makeEntry({ id: "b" })],
            rows: [makeRow({ key: "worktree:wt-1" })],
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
            rows: [makeRow({ key: "worktree:wt-1", label: "first-wt" })],
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
            rows: [makeRow({ key: "worktree:wt-2", label: "second-wt" })],
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

describe("re-entry summary drag-region opt-out (issue #12347)", () => {
  it("opts the card out of the drag region, not its pointer-events-none wrapper", () => {
    // top-3 plus the wrapper's p-4 puts the card's header at y≈28px — inside
    // the toolbar's 48px drag band with no banner needed — so Pin and Dismiss
    // are swallowed as window drags. The wrapper is full-width and always
    // mounted, so the opt-out must sit on the card instead.
    render(<ReEntrySummary state={makeState({ rows: [makeRow()] })} />);

    const dismiss = screen.getByRole("button", { name: "Dismiss summary" });
    const stamped = dismiss.closest(".app-no-drag");
    if (!(stamped instanceof HTMLElement)) throw new Error("no opt-out above the dismiss control");

    // Located independently of the stamp, so moving the opt-out up onto the
    // wrapper fails here rather than quietly satisfying a relative lookup.
    // Deliberately not a pointer-events check: the card itself carries
    // `pointer-events-none` until its entry animation runs.
    const wrapper = document.querySelector(".fixed.top-3");
    if (!(wrapper instanceof HTMLElement)) throw new Error("summary wrapper not rendered");
    expect(wrapper.className).toContain("pointer-events-none");
    expect(wrapper.className.split(/\s+/)).not.toContain("app-no-drag");
    expect(wrapper.contains(stamped)).toBe(true);
    expect(stamped).not.toBe(wrapper);
  });
});
