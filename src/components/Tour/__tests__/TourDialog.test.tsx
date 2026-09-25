// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        <button data-confirm-role="cancel" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
      {primaryAction && (
        <button data-confirm-role="confirm" onClick={primaryAction.onClick}>
          {primaryAction.label}
        </button>
      )}
    </div>
  );
  return { AppDialog };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The scene boundary reports what it catches; keep that local to the test.
vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
  getRendererSentryConsent: vi.fn(() => ({ level: "off", hasSeenPrompt: false })),
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

import { DAINTREE_TOUR } from "../daintreeTour";
import { TOUR_CHAPTERS } from "../tourChapters";
import type { TourDefinition } from "../tourDefinition";
import { TourDialog, type TourDialogProps } from "../TourDialog";
import type { TourChapterTiming, TourPlayer } from "@daintreehq/tour";

function renderDialog(overrides: Partial<TourDialogProps> = {}) {
  const props: TourDialogProps = {
    isOpen: true,
    tour: DAINTREE_TOUR,
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
    vi.restoreAllMocks();
  });

  it("steps forward and back through chapters and reports each one reached", () => {
    const { props } = renderDialog();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[0]!.title);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[1]!.title);
    expect(props.onChapterReached).toHaveBeenLastCalledWith(1);

    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    fireEvent.click(back);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(TOUR_CHAPTERS[0]!.title);
    // Back goes with the first chapter; the focus it held moves to Next.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
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
      expect(screen.getByRole("status").textContent).toMatch(/starts in 1.5 seconds/);
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

    it("keeps focus on the card when K holds it from the Stay here button", () => {
      const { end } = renderAt(1);
      end();
      const stay = screen.getByRole("button", { name: "Stay here" });
      stay.focus();
      fireEvent.keyDown(stay, { key: "k" });
      expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        `Next: ${TOUR_CHAPTERS[2]!.title}`
      );
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

  it("answers player keys from the header as well as the body", () => {
    renderDialog();
    const mute = screen.getByRole("button", { name: "Mute narration" });
    fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "m" });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
  });

  it("announces a new chapter by position and title, leaving the words to the narration", () => {
    renderDialog({ initialChapter: 2 });
    const announcement = document.querySelector("[aria-live='polite']")!.textContent;
    expect(announcement).toBe(`Chapter 3 of ${TOUR_CHAPTERS.length}: ${TOUR_CHAPTERS[2]!.title}`);
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

  describe("any tour", () => {
    const timing = (text: string): TourChapterTiming => ({
      duration: 4,
      cues: {},
      captions: [{ text, start: 0, end: 4 }],
      audioUrl: null,
    });
    const Plain = () => <div data-testid="plain-scene" />;
    const Broken = (): never => {
      throw new Error("scene exploded");
    };

    function tourWith(overrides: Partial<TourDefinition> = {}): TourDefinition {
      return {
        id: "plugin:acme.tools/welcome",
        title: "Acme Tour",
        chapters: [
          { id: "one", title: "First steps", scene: Plain },
          { id: "two", title: "Next steps", scene: Plain },
        ],
        resolveTimings: () => [timing("Hello from Acme"), timing("Onwards")],
        ...overrides,
      };
    }

    it("plays from its own definition: title, chapters, scenes and captions", () => {
      renderDialog({ tour: tourWith() });
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Acme Tour");
      expect(screen.getByTestId("tour-chapter-count").textContent).toBe("Chapter 1 of 2");
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("First steps");
      expect(screen.getByTestId("plain-scene")).toBeTruthy();
      expect(screen.getByText("Hello from Acme")).toBeTruthy();
    });

    it("finishes without handing over to Getting Started unless it asks to", () => {
      const run = vi.fn();
      const gettingStarted = vi.fn();
      window.addEventListener("daintree:show-getting-started", gettingStarted);
      const { props } = renderDialog({ tour: tourWith(), initialChapter: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      expect(props.onCompleted).toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalled();
      expect(gettingStarted).not.toHaveBeenCalled();

      cleanup();
      renderDialog({ tour: tourWith({ finish: { hint: "Then build", run } }), initialChapter: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      window.removeEventListener("daintree:show-getting-started", gettingStarted);
      expect(run).toHaveBeenCalledTimes(1);
      expect(gettingStarted).not.toHaveBeenCalled();
    });

    it("fails only the chapter whose scene throws", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let player: TourPlayer | null = null;
      renderDialog({
        tour: tourWith({
          chapters: [
            { id: "one", title: "First steps", scene: Broken },
            { id: "two", title: "Next steps", scene: Plain },
          ],
        }),
        onPlayer: (p) => (player = p),
      });
      // The dialog, its controls and navigation survive; the stage shows the fallback.
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("First steps");
      expect(screen.getByText(/First steps stopped working/)).toBeTruthy();
      // Nothing to narrate over a broken scene.
      expect(player!.getState().status).toBe("paused");

      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Next steps");
      expect(screen.getByTestId("plain-scene")).toBeTruthy();
      expect(screen.queryByText(/stopped working/)).toBeNull();
      expect(player!.getState().status).toBe("playing");
    });
  });
});
