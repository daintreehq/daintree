// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOUR_SCENES } from "../TourStage";
import { DAINTREE_MOCK_KIT } from "../daintreeMockKit";
import { MockKitContext } from "../mockup/MockKitContext";
import type { CursorStep } from "../mockup/TourMock";
import { CURSOR as AGENTS_CURSOR } from "../scenes/AgentsScene";
import { CURSOR as ASSISTANT_CURSOR } from "../scenes/AssistantScene";
import { CURSOR as CONTEXT_CURSOR } from "../scenes/ContextScene";
import { CURSOR as FILES_CURSOR } from "../scenes/FilesScene";
import { CURSOR as FLEET_CURSOR } from "../scenes/FleetScene";
import { CURSOR as GITHUB_CURSOR } from "../scenes/GitHubScene";
import { CURSOR as PREVIEW_CURSOR } from "../scenes/PreviewScene";
import { CURSOR as REVIEW_CURSOR } from "../scenes/ReviewScene";
import { CURSOR as STATE_CURSOR } from "../scenes/StateScene";
import { CURSOR as WORKTREES_CURSOR } from "../scenes/WorktreesScene";
import { TOUR_CHAPTERS } from "../tourChapters";
import { TourPlayer, type TourAudio } from "@daintreehq/tour";
import { TourPlayerContext } from "@daintreehq/tour/react";
import { TourKeyboardContext } from "../tourKeyboardContext";
import type { TourKeyboard } from "../tourKeys";
import { resolveChapterTiming } from "../tourTiming";

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
function sceneAt(chapterId: string, t: number, keyboard: TourKeyboard = "mac"): HTMLElement {
  const chapter = TOUR_CHAPTERS.find((c) => c.id === chapterId)!;
  const player = new TourPlayer([resolveChapterTiming(chapter, keyboard)], {
    createAudio: (url) => new SilentAudio(url),
    now: () => 0,
    requestFrame: () => 0,
    cancelFrame: () => {},
  });
  player.seek(t);
  const Scene = TOUR_SCENES[chapterId]!;
  const { container } = render(
    <MockKitContext.Provider value={DAINTREE_MOCK_KIT}>
      <TourPlayerContext.Provider value={player}>
        <TourKeyboardContext.Provider value={keyboard}>
          <div data-tour-canvas="">
            <Scene />
          </div>
        </TourKeyboardContext.Provider>
      </TourPlayerContext.Provider>
    </MockKitContext.Provider>
  );
  return container;
}

const SCENE_CURSORS: Record<string, readonly CursorStep[]> = {
  agents: AGENTS_CURSOR,
  assistant: ASSISTANT_CURSOR,
  context: CONTEXT_CURSOR,
  files: FILES_CURSOR,
  fleet: FLEET_CURSOR,
  github: GITHUB_CURSOR,
  preview: PREVIEW_CURSOR,
  review: REVIEW_CURSOR,
  state: STATE_CURSOR,
  worktrees: WORKTREES_CURSOR,
};

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
    for (const t of momentsOf(resolveChapterTiming(chapter, "mac").cues)) {
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

  // The pointer is placed by measuring the anchor it names, so a step whose
  // anchor isn't rendered at that moment leaves the pointer somewhere else.
  it.each(Object.keys(SCENE_CURSORS))("%s: every cursor anchor is rendered at its step", (id) => {
    const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
    const cues = resolveChapterTiming(chapter).cues;
    const steps = SCENE_CURSORS[id]!;
    const startOf = (step: CursorStep) => {
      const cue = cues[step.cue];
      expect(cue, `${id}: cue "${step.cue}"`).toBeDefined();
      return cue! + (step.offset ?? 0);
    };
    for (const step of steps) {
      if (!("anchor" in step.at)) continue;
      // A moment inside the step: before whichever step takes over next.
      const start = startOf(step);
      const next = Math.min(...steps.map(startOf).filter((at) => at > start), start + 0.02);
      expect(start, `${id}: "${step.cue}" step starts inside the chapter`).toBeGreaterThanOrEqual(
        0
      );
      const t = (start + next) / 2;
      const canvas = sceneAt(id, t);
      const matches = canvas.querySelectorAll(`[data-tour-anchor="${step.at.anchor}"]`);
      expect(matches.length, `${id}@${t.toFixed(2)}: "${step.at.anchor}" rendered once`).toBe(1);
      expect(canvas.querySelector("[data-tour-cursor]")?.getAttribute("data-tour-cursor")).toBe(
        step.at.anchor
      );
      cleanup();
    }
  });

  // The toolbar's project pill names the selected worktree's branch; a frame
  // where they disagree teaches the wrong model of what a worktree is.
  it.each(APP_CHAPTERS)("%s: the toolbar branch is the selected worktree's branch", (id) => {
    const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
    for (const t of momentsOf(resolveChapterTiming(chapter, "mac").cues)) {
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
      const canvas = sceneAt(id, resolveChapterTiming(chapter, "mac").duration);
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

describe("tour scenes on each keyboard", () => {
  const keycapsAt = (id: string, cue: string, keyboard: TourKeyboard) => {
    const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
    const canvas = sceneAt(id, resolveChapterTiming(chapter, keyboard).cues[cue]! + 0.05, keyboard);
    // The scene's first keycap group is the one this cue shows.
    const group = canvas.querySelector("kbd")?.parentElement;
    const caps = [...(group?.querySelectorAll("kbd") ?? [])].map((kbd) => kbd.textContent);
    cleanup();
    return caps;
  };

  it("draws the keys the narration names", () => {
    expect(keycapsAt("palette", "palette", "mac")).toEqual(["⌘", "⇧", "P"]);
    expect(keycapsAt("palette", "palette", "pc")).toEqual(["Ctrl", "Shift", "P"]);
    expect(keycapsAt("pilot", "open", "mac")).toEqual(["⌘", "⌥", "O"]);
    expect(keycapsAt("pilot", "open", "pc")).toEqual(["Ctrl", "Alt", "O"]);
  });

  it("draws the park keys the narration names, on the keycaps and the footer", () => {
    for (const [keyboard, caps, footer] of [
      ["mac", ["⌥", "↵"], "⌥↵ Park"],
      ["pc", ["Alt", "↵"], "Alt+↵ Park"],
    ] as const) {
      const chapter = TOUR_CHAPTERS.find((c) => c.id === "pilot")!;
      const at = resolveChapterTiming(chapter, keyboard).cues.park! + 0.3;
      const canvas = sceneAt("pilot", at, keyboard);
      const groups = [...canvas.querySelectorAll("kbd")]
        .map((kbd) => kbd.parentElement!)
        .filter((group, i, all) => all.indexOf(group) === i)
        .map((group) => [...group.querySelectorAll("kbd")].map((kbd) => kbd.textContent));
      expect(groups, keyboard).toContainEqual([...caps]);
      const hint = canvas.querySelector('[data-tour-anchor="pilot-park"]');
      expect(hint?.textContent?.replace(/\s+/g, " ").trim(), keyboard).toBe(footer);
      cleanup();
    }
  });

  it.each(TOUR_CHAPTERS.map((c) => c.id))(
    "%s: shows no Mac key glyph on Windows or Linux",
    (id) => {
      const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
      for (const t of momentsOf(resolveChapterTiming(chapter, "pc").cues)) {
        const canvas = sceneAt(id, t, "pc");
        expect(canvas.textContent, `${id}@${t.toFixed(2)}`).not.toMatch(/[⌘⌥⌃⇧]/);
        cleanup();
      }
    }
  );
});
