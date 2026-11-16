// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  MARKDOWN_STAGE_CHARS,
  MARKDOWN_STAGE_PIPELINES,
  useStagedMarkdownBlocks,
  type StagedMarkdownUnit,
} from "../useStagedMarkdownBlocks";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function runFrame() {
  const [id, callback] = frames.entries().next().value!;
  frames.delete(id);
  act(() => callback(performance.now()));
}

function drain(): number {
  let ran = 0;
  while (frames.size > 0) {
    if (++ran > 1000) throw new Error("frames never settled");
    runFrame();
  }
  return ran;
}

function units(count: number, shape: Partial<StagedMarkdownUnit> = {}): StagedMarkdownUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `u${i}`,
    pipelines: 1,
    chars: 10,
    ...shape,
  }));
}

function stage(initial: { units: StagedMarkdownUnit[]; owner: unknown; flush: number }) {
  return renderHook((props) => useStagedMarkdownBlocks(props.units, props.owner, props.flush), {
    initialProps: initial,
  });
}

describe("useStagedMarkdownBlocks", () => {
  it("admits everything in its first commit when it fits one slice", () => {
    const all = units(3);
    const { result } = stage({ units: all, owner: {}, flush: 0 });
    expect([...result.current]).toEqual(["u0", "u1", "u2"]);
    expect(frames.size).toBe(0);
  });

  it("admits a bounded slice per frame, in document order, until every unit is in", () => {
    const all = units(MARKDOWN_STAGE_PIPELINES * 4);
    const { result } = stage({ units: all, owner: {}, flush: 0 });
    const first = result.current.size;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(all.length);
    expect([...result.current]).toEqual(all.slice(0, first).map((unit) => unit.key));

    runFrame();
    expect(result.current.size).toBeGreaterThan(first);
    expect(result.current.size).toBeLessThan(all.length);

    drain();
    expect(result.current.size).toBe(all.length);
  });

  it("counts a pair as two pipelines and bounds a slice by characters too", () => {
    const pairs = units(MARKDOWN_STAGE_PIPELINES, { pipelines: 2 });
    const pairStage = stage({ units: pairs, owner: {}, flush: 0 });
    expect(pairStage.result.current.size).toBe(MARKDOWN_STAGE_PIPELINES / 2);
    pairStage.unmount();

    const heavy = units(4, { chars: MARKDOWN_STAGE_CHARS / 2 });
    const heavyStage = stage({ units: heavy, owner: {}, flush: 0 });
    expect(heavyStage.result.current.size).toBe(2);
  });

  it("still makes progress through a unit bigger than a whole slice", () => {
    const giant = units(3, { chars: MARKDOWN_STAGE_CHARS * 4 });
    const { result } = stage({ units: giant, owner: {}, flush: 0 });
    expect(result.current.size).toBe(1);
    runFrame();
    expect(result.current.size).toBe(2);
  });

  it("stages units that appear later without dropping the ones already in", () => {
    const owner = {};
    const first = units(2);
    const { result, rerender } = stage({ units: first, owner, flush: 0 });
    expect(result.current.size).toBe(2);

    const grown = [
      first[0]!,
      ...units(MARKDOWN_STAGE_PIPELINES * 3).map((unit) => ({
        ...unit,
        key: `new-${unit.key}`,
      })),
      first[1]!,
    ];
    rerender({ units: grown, owner, flush: 0 });
    expect(result.current.has("u0")).toBe(true);
    expect(result.current.has("u1")).toBe(true);
    expect(result.current.size).toBe(2);

    drain();
    expect(result.current.size).toBe(grown.length);
  });

  it("starts over for a new owner during the same render", () => {
    const all = units(MARKDOWN_STAGE_PIPELINES * 3);
    const { result, rerender } = stage({ units: all, owner: "a", flush: 0 });
    drain();
    expect(result.current.size).toBe(all.length);

    rerender({ units: all, owner: "b", flush: 0 });
    expect(result.current.size).toBeLessThan(all.length);
  });

  it("mounts every current unit at once when flushed", () => {
    const owner = {};
    const all = units(MARKDOWN_STAGE_PIPELINES * 5);
    const { result, rerender } = stage({ units: all, owner, flush: 0 });
    expect(result.current.size).toBeLessThan(all.length);

    rerender({ units: all, owner, flush: 1 });
    expect(result.current.size).toBe(all.length);
    drain();
    expect(frames.size).toBe(0);
  });

  it("cancels its pending frame when it unmounts", () => {
    const { unmount } = stage({ units: units(MARKDOWN_STAGE_PIPELINES * 3), owner: {}, flush: 0 });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });
});
