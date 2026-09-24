// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => null;
  AppDialog.Footer = ({
    hint,
    primaryAction,
    secondaryAction,
  }: {
    hint?: ReactNode;
    primaryAction?: { label: string; onClick: () => void };
    secondaryAction?: { label: string; onClick: () => void };
  }) => (
    <div>
      <span data-testid="hint">{hint}</span>
      {secondaryAction && (
        <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>
      )}
      {primaryAction && <button onClick={primaryAction.onClick}>{primaryAction.label}</button>}
    </div>
  );
  return { AppDialog };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

class SilentAudio {
  src: string;
  preload = "";
  currentTime = 0;
  muted = false;
  constructor(src: string) {
    this.src = src;
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  addEventListener() {}
  removeEventListener() {}
}

import { TOUR_CHAPTERS } from "../tourChapters";
import { TourDialog, type TourDialogProps } from "../TourDialog";
import type { TourPlayer } from "../TourPlayer";

function renderDialog(overrides: Partial<TourDialogProps> = {}) {
  const props: TourDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    initialChapter: 0,
    initialMuted: false,
    onChapterReached: vi.fn(),
    onCompleted: vi.fn(),
    onMutedChange: vi.fn(),
    ...overrides,
  };
  const result = render(<TourDialog {...props} />);
  return { ...result, props };
}

describe("TourDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", SilentAudio);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("steps forward and back through chapters and reports each one reached", () => {
    const { props } = renderDialog();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[0]!.title);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[1]!.title);
    expect(props.onChapterReached).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[0]!.title);
  });

  it("resumes on the chapter it was opened at", () => {
    renderDialog({ initialChapter: 3 });
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[3]!.title);
    expect(screen.getByTestId("tour-chapter-count").textContent).toBe(
      `Chapter 4 of ${TOUR_CHAPTERS.length}`
    );
  });

  it("finishes from the last chapter: completes, closes, and hands over to Getting Started", () => {
    const { props } = renderDialog({ initialChapter: TOUR_CHAPTERS.length - 1 });
    const gettingStarted = vi.fn();
    window.addEventListener("daintree:show-getting-started", gettingStarted);
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    window.removeEventListener("daintree:show-getting-started", gettingStarted);
    expect(props.onCompleted).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    expect(gettingStarted).toHaveBeenCalledTimes(1);
  });

  it("jumps straight to a chapter from the progress track", () => {
    renderDialog();
    const target = TOUR_CHAPTERS[4]!;
    fireEvent.click(screen.getByRole("button", { name: `Chapter 5: ${target.title}` }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(target.title);
  });

  it("mutes from the button and the M key, persisting each change", () => {
    const { props } = renderDialog();
    const mute = screen.getByRole("button", { name: "Mute narration" });
    fireEvent.click(mute);
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(props.onMutedChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "m" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(props.onMutedChange).toHaveBeenLastCalledWith(false);
  });

  it("stops the narration when closed", () => {
    const pause = vi.spyOn(SilentAudio.prototype, "pause");
    const { rerender, props } = renderDialog();
    act(() => {
      rerender(<TourDialog {...props} isOpen={false} />);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Every chapter's narration was preloaded on open; each is released.
    expect(pause).toHaveBeenCalled();
  });

  describe("chapter endings", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function renderAt(chapter: number) {
      let player: TourPlayer | null = null;
      const view = renderDialog({ initialChapter: chapter, onPlayer: (p) => (player = p) });
      const end = () => {
        act(() => {
          player!.seek(player!.timing.duration - 0.05);
          // Past the narration hold, then far enough for the timeline to finish.
          vi.advanceTimersByTime(2000);
        });
        expect(player!.getState().status).toBe("ended");
      };
      return { ...view, player: () => player!, end };
    }

    it("hands focus back to the stage when the end card leaves", () => {
      const { end, player } = renderAt(1);
      end();
      // The card's own Replay, not the player bar's.
      const replay = screen
        .getAllByRole("button", { name: "Replay" })
        .find((b) => b.textContent === "Replay")!;
      replay.focus();
      act(() => {
        fireEvent.click(replay);
      });
      expect(player().getState().status).toBe("playing");
      expect(document.activeElement).toBe(screen.getByTestId("tour-stage-toggle"));
    });

    it("moves focus from a covered stage onto the end card", () => {
      const { end } = renderAt(1);
      screen.getByTestId("tour-stage-toggle").focus();
      end();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        `Next: ${TOUR_CHAPTERS[2]!.title}`
      );
    });

    it("says the next chapter starts on its own, and that it stopped once held", () => {
      const { end } = renderAt(1);
      end();
      expect(screen.getByRole("status").textContent).toMatch(/starts in 3 seconds/);
      fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
      expect(screen.getByRole("status").textContent).toBe("Auto-advance paused");
    });

    it("keeps focus on the track when a focused slider's chapter advances", () => {
      const { end } = renderAt(1);
      screen.getByRole("slider").focus();
      end();
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(screen.getByTestId("tour-chapter-count").textContent).toMatch(/^Chapter 3 of/);
      expect(document.activeElement).toBe(screen.getByRole("slider"));
    });

    it("counts down afresh after a held chapter plays again", () => {
      const { end, player } = renderAt(1);
      end();
      fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
      expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();

      act(() => {
        player().play();
      });
      end();
      expect(screen.queryByRole("button", { name: "Stay here" })).not.toBeNull();
    });
  });

  it("starts another chapter from its beginning, wherever its segment is clicked", () => {
    let player: TourPlayer | null = null;
    renderDialog({ onPlayer: (p) => (player = p) });
    const segment = screen.getByRole("button", { name: `Chapter 3: ${TOUR_CHAPTERS[2]!.title}` });
    segment.getBoundingClientRect = () => new DOMRect(0, 0, 100, 24);
    fireEvent.click(segment, { detail: 1, clientX: 80 });
    expect(player!.getState().chapterIndex).toBe(2);
    expect(player!.getTime()).toBe(0);
  });

  it("keeps keyboard focus on the track when a chapter is chosen from it", () => {
    renderDialog();
    const segment = screen.getByRole("button", { name: `Chapter 3: ${TOUR_CHAPTERS[2]!.title}` });
    segment.focus();
    fireEvent.click(segment, { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole("slider"));
  });

  it("exposes the playing chapter as a slider with spoken time", () => {
    let player: TourPlayer | null = null;
    renderDialog({ onPlayer: (p) => (player = p) });
    act(() => {
      player!.pause();
      player!.seek(7);
    });
    const slider = screen.getByRole("slider", { name: "Chapter position" });
    expect(slider.getAttribute("aria-valuenow")).toBe("7");
    expect(slider.getAttribute("aria-valuetext")).toMatch(/^7 seconds of \d+ seconds$/);
  });
});
