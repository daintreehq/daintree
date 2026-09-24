// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOUR_SCENES } from "../TourStage";
import { TOUR_CHAPTERS } from "../tourChapters";
import { TourPlayer, type TourAudio } from "../TourPlayer";
import { resolveChapterTiming } from "../tourTiming";
import { TourPlayerContext } from "../useTourPlayer";

class SilentAudio implements TourAudio {
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

/** Every moment a scene changes: each cue, and a beat after it once its reveals have landed. */
function momentsOf(cues: Record<string, number>): number[] {
  return [...new Set(Object.values(cues).flatMap((at) => [at + 0.05, at + 1, at + 2.5]))].sort(
    (a, b) => a - b
  );
}

/** Mount a chapter's scene frozen at `t` and return the rendered canvas. */
function sceneAt(chapterId: string, t: number): HTMLElement {
  const chapter = TOUR_CHAPTERS.find((c) => c.id === chapterId)!;
  const player = new TourPlayer([resolveChapterTiming(chapter)], {
    createAudio: (url) => new SilentAudio(url),
    now: () => 0,
    requestFrame: () => 0,
    cancelFrame: () => {},
  });
  player.seek(t);
  const Scene = TOUR_SCENES[chapterId]!;
  const { container } = render(
    <TourPlayerContext.Provider value={player}>
      <div data-tour-canvas="">
        <Scene />
      </div>
    </TourPlayerContext.Provider>
  );
  return container;
}

const APP_CHAPTERS = TOUR_CHAPTERS.map((c) => c.id).filter((id) => id !== "outro");

function worktreeNames(canvas: HTMLElement): string[] {
  return [...canvas.querySelectorAll<HTMLElement>('[data-tour-anchor^="worktree-"]')]
    .map((el) => el.dataset.tourAnchor ?? "")
    .filter((name) => /^worktree-/.test(name) && !/-(branch|list)$/.test(name))
    .map((name) => name.replace(/^worktree-/, ""));
}

afterEach(cleanup);

describe("tour scenes", () => {
  // A spotlight inside a dimmed region can't give its target back the
  // brightness the region took: the highlighted text is the least readable
  // thing in the frame.
  it.each(APP_CHAPTERS)("%s: a spotlight never lands in a dimmed region", (id) => {
    const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
    for (const t of momentsOf(resolveChapterTiming(chapter).cues)) {
      const canvas = sceneAt(id, t);
      const spot = canvas.querySelector<SVGElement>("[data-tour-spotlight]");
      const targets = spot?.dataset.tourSpotlight?.split("|").filter(Boolean) ?? [];
      for (const target of targets) {
        const el = canvas.querySelector(`[data-tour-anchor="${target}"]`);
        expect(el, `${id}@${t.toFixed(2)}: spotlight target "${target}" exists`).not.toBeNull();
        expect(
          el!.closest("[data-tour-receded]"),
          `${id}@${t.toFixed(2)}: "${target}" sits in a dimmed region`
        ).toBeNull();
      }
      cleanup();
    }
  });

  // The toolbar's project pill names the selected worktree's branch; a frame
  // where they disagree teaches the wrong model of what a worktree is.
  it.each(APP_CHAPTERS)("%s: the toolbar branch is the selected worktree's branch", (id) => {
    const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
    for (const t of momentsOf(resolveChapterTiming(chapter).cues)) {
      const canvas = sceneAt(id, t);
      const selected = canvas.querySelector<HTMLElement>("[data-tour-selected]");
      if (selected) {
        const name = selected.dataset.tourAnchor!.replace(/^worktree-/, "");
        const branch = canvas.querySelector(`[data-tour-anchor="worktree-${name}-branch"]`);
        const pill = canvas.querySelector('[data-tour-anchor="project"]');
        expect(pill?.textContent, `${id}@${t.toFixed(2)}`).toContain(branch!.textContent);
      }
      cleanup();
    }
  });

  // One workspace for the whole tour: the worktrees a chapter shows keep the
  // order they had when the viewer first met them.
  it("keeps every chapter's sidebar in one order", () => {
    const orders = APP_CHAPTERS.map((id) => {
      const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
      const canvas = sceneAt(id, resolveChapterTiming(chapter).duration);
      const names = worktreeNames(canvas);
      cleanup();
      return [id, names] as const;
    });
    const canonical: string[] = [];
    for (const [, names] of orders) {
      for (const name of names) if (!canonical.includes(name)) canonical.push(name);
    }
    for (const [id, names] of orders) {
      const expected = canonical.filter((name) => names.includes(name));
      expect(names, id).toEqual(expected);
    }
  });
});
