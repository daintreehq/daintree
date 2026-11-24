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

function units(
  count: number,
  shape: Partial<StagedMarkdownUnit> = {},
  prefix = "u"
): StagedMarkdownUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `${prefix}${i}`,
    pipelines: 1,
    chars: 10,
    ...shape,
  }));
}

/** Every admitted set any render returned, so an oversized commit can't hide behind a later fix-up. */
function stage(initial: { units: StagedMarkdownUnit[]; owner: unknown; flush: number }) {
  const sizes: number[] = [];
  const hook = renderHook(
    (props) => {
      const staged = useStagedMarkdownBlocks(props.units, props.owner, props.flush);
      sizes.push(staged.admitted.size);
      return staged;
    },
    { initialProps: initial }
  );
  return { ...hook, sizes };
}

function keysOf(set: ReadonlySet<string>): string[] {
  return [...set];
}

describe("useStagedMarkdownBlocks", () => {
  it("admits everything in its first commit when it fits one slice", () => {
    const all = units(3);
    const { result } = stage({ units: all, owner: {}, flush: 0 });
    expect(keysOf(result.current.admitted)).toEqual(["u0", "u1", "u2"]);
    expect(frames.size).toBe(0);
  });

  it("admits one bounded slice per frame, in document order, until every unit is in", () => {
    const all = units(MARKDOWN_STAGE_PIPELINES * 4);
    const { result, sizes } = stage({ units: all, owner: {}, flush: 0 });
    expect(result.current.admitted.size).toBe(MARKDOWN_STAGE_PIPELINES);
    expect(keysOf(result.current.admitted)).toEqual(
      all.slice(0, MARKDOWN_STAGE_PIPELINES).map((unit) => unit.key)
    );

    runFrame();
    expect(keysOf(result.current.admitted)).toEqual(
      all.slice(0, MARKDOWN_STAGE_PIPELINES * 2).map((unit) => unit.key)
    );

    drain();
    expect(result.current.admitted.size).toBe(all.length);
    // No render ever jumped by more than one slice.
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]! - sizes[i - 1]!).toBeLessThanOrEqual(MARKDOWN_STAGE_PIPELINES);
    }
  });

  it("never lets a slice overrun either budget", () => {
    // Eleven singles then a pair: the pair would make thirteen pipelines.
    const mixed = [
      ...units(MARKDOWN_STAGE_PIPELINES - 1),
      { key: "pair", pipelines: 2, chars: 10 },
      ...units(3, {}, "tail"),
    ];
    const pipelineStage = stage({ units: mixed, owner: {}, flush: 0 });
    expect(pipelineStage.result.current.admitted.has("pair")).toBe(false);
    expect(pipelineStage.result.current.admitted.size).toBe(MARKDOWN_STAGE_PIPELINES - 1);
    pipelineStage.unmount();

    // Two units just over half the character budget each can't share a slice.
    const heavy = units(3, { chars: MARKDOWN_STAGE_CHARS / 2 + 1 });
    const charStage = stage({ units: heavy, owner: {}, flush: 0 });
    expect(charStage.result.current.admitted.size).toBe(1);
  });

  it("still makes progress through a unit bigger than a whole slice", () => {
    const giant = units(3, { chars: MARKDOWN_STAGE_CHARS * 4 });
    const { result } = stage({ units: giant, owner: {}, flush: 0 });
    expect(result.current.admitted.size).toBe(1);
    runFrame();
    expect(result.current.admitted.size).toBe(2);
  });

  it("stages units that appear later a slice at a time, keeping the ones already in", () => {
    const owner = {};
    const first = units(2);
    const { result, rerender } = stage({ units: first, owner, flush: 0 });
    expect(result.current.admitted.size).toBe(2);

    const revealed = units(MARKDOWN_STAGE_PIPELINES * 3, {}, "new");
    const grown = [first[0]!, ...revealed, first[1]!];
    rerender({ units: grown, owner, flush: 0 });
    expect(keysOf(result.current.admitted)).toEqual(["u0", "u1"]);

    runFrame();
    expect(keysOf(result.current.admitted)).toEqual([
      "u0",
      "u1",
      ...revealed.slice(0, MARKDOWN_STAGE_PIPELINES).map((unit) => unit.key),
    ]);

    drain();
    expect(result.current.admitted.size).toBe(grown.length);
  });

  it("starts a new owner over in the render that brings it, never committing the old progress", () => {
    const all = units(MARKDOWN_STAGE_PIPELINES * 3);
    const { result, rerender, sizes } = stage({ units: all, owner: "a", flush: 0 });
    drain();
    expect(result.current.admitted.size).toBe(all.length);

    const before = sizes.length;
    rerender({ units: all, owner: "b", flush: 0 });
    const after = sizes.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const size of after) expect(size).toBe(MARKDOWN_STAGE_PIPELINES);
  });

  it("mounts every current unit in the render a flush arrives in", () => {
    const owner = {};
    const all = units(MARKDOWN_STAGE_PIPELINES * 5);
    const { result, rerender, sizes } = stage({ units: all, owner, flush: 0 });
    expect(result.current.admitted.size).toBeLessThan(all.length);

    const before = sizes.length;
    rerender({ units: all, owner, flush: 1 });
    expect(sizes[before]).toBe(all.length);
    drain();
    expect(frames.size).toBe(0);
  });

  it("mounts requested units ahead of the sweep, and ignores a request for a replaced owner", () => {
    const all = units(MARKDOWN_STAGE_PIPELINES * 5);
    const { result, rerender } = stage({ units: all, owner: "a", flush: 0 });
    const admitForA = result.current.admit;

    act(() => result.current.admit(["u50", "u51"]));
    expect(result.current.admitted.has("u50")).toBe(true);
    expect(result.current.admitted.has("u51")).toBe(true);
    expect(result.current.admitted.has("u49")).toBe(false);

    rerender({ units: all, owner: "b", flush: 0 });
    act(() => admitForA(["u55"]));
    expect(result.current.admitted.has("u55")).toBe(false);
  });

  it("cancels its pending frame when it unmounts", () => {
    const { unmount } = stage({ units: units(MARKDOWN_STAGE_PIPELINES * 3), owner: {}, flush: 0 });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });
});
