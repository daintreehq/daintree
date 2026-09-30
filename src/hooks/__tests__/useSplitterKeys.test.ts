import { describe, expect, it } from "vitest";
import {
  resolveSplitterKey,
  splitterKeyShortcuts,
  type SplitterGrowKey,
  type SplitterKeyOptions,
} from "../useSplitterKeys";

const GROW_KEYS: SplitterGrowKey[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
const OPPOSITE: Record<SplitterGrowKey, SplitterGrowKey> = {
  ArrowLeft: "ArrowRight",
  ArrowRight: "ArrowLeft",
  ArrowUp: "ArrowDown",
  ArrowDown: "ArrowUp",
};
const CROSS_AXIS: Record<SplitterGrowKey, SplitterGrowKey[]> = {
  ArrowLeft: ["ArrowUp", "ArrowDown"],
  ArrowRight: ["ArrowUp", "ArrowDown"],
  ArrowUp: ["ArrowLeft", "ArrowRight"],
  ArrowDown: ["ArrowLeft", "ArrowRight"],
};

const opts = (growKey: SplitterGrowKey, value = 300): SplitterKeyOptions => ({
  growKey,
  value,
  min: 100,
  max: 600,
  step: 10,
  largeStep: 50,
});

function press(key: string, o: SplitterKeyOptions, mods: Partial<KeyboardEvent> = {}) {
  return resolveSplitterKey(
    { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods },
    o
  );
}

function valueOf(result: ReturnType<typeof resolveSplitterKey>): number {
  if (result?.kind !== "set") throw new Error(`expected a value, got ${JSON.stringify(result)}`);
  return result.value;
}

describe("splitter keyboard contract", () => {
  it.each(GROW_KEYS)("%s grows the pane and its opposite shrinks it by the same step", (grow) => {
    const o = opts(grow);
    const up = valueOf(press(grow, o)) - o.value;
    const down = o.value - valueOf(press(OPPOSITE[grow], o));
    expect(up).toBeGreaterThan(0);
    expect(down).toBe(up);
  });

  it.each(GROW_KEYS)("Shift takes a strictly larger step in the same direction (%s)", (grow) => {
    const o = opts(grow);
    const fine = valueOf(press(grow, o)) - o.value;
    const coarse = valueOf(press(grow, o, { shiftKey: true })) - o.value;
    expect(coarse).toBeGreaterThan(fine);
    expect(o.value - valueOf(press(OPPOSITE[grow], o, { shiftKey: true }))).toBe(coarse);
  });

  it.each(GROW_KEYS)("Home and End jump to the limits, never to a reset (%s)", (grow) => {
    const o = opts(grow);
    expect(valueOf(press("Home", o))).toBe(o.min);
    expect(valueOf(press("End", o))).toBe(o.max);
  });

  it.each(GROW_KEYS)("Enter and Space reset (%s)", (grow) => {
    expect(press("Enter", opts(grow))).toEqual({ kind: "reset" });
    expect(press(" ", opts(grow))).toEqual({ kind: "reset" });
  });

  it.each(GROW_KEYS)("never steps past a limit (%s)", (grow) => {
    const atMax = opts(grow, 600);
    const atMin = opts(grow, 100);
    expect(valueOf(press(grow, atMax, { shiftKey: true }))).toBe(atMax.max);
    expect(valueOf(press(OPPOSITE[grow], atMin, { shiftKey: true }))).toBe(atMin.min);
  });

  it.each(GROW_KEYS)("leaves the other axis and modified keys alone (%s)", (grow) => {
    const o = opts(grow);
    for (const key of CROSS_AXIS[grow]) expect(press(key, o)).toBeNull();
    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      expect(press(grow, o, { [mod]: true })).toBeNull();
    }
    expect(press("a", o)).toBeNull();
  });

  it("gives PageUp/PageDown a direction only on a horizontal splitter", () => {
    const horizontal = opts("ArrowUp");
    expect(valueOf(press("PageUp", horizontal))).toBe(
      valueOf(press("ArrowUp", horizontal, { shiftKey: true }))
    );
    expect(valueOf(press("PageDown", horizontal))).toBe(
      valueOf(press("ArrowDown", horizontal, { shiftKey: true }))
    );
    for (const grow of ["ArrowLeft", "ArrowRight"] as const) {
      expect(press("PageUp", opts(grow))).toBeNull();
      expect(press("PageDown", opts(grow))).toBeNull();
    }
  });

  it.each(GROW_KEYS)("announces exactly the keys it binds (%s)", (grow) => {
    const o = opts(grow);
    const announced = splitterKeyShortcuts(grow).split(" ");
    for (const shortcut of announced) {
      const [mod, key] = shortcut.includes("+") ? shortcut.split("+") : [null, shortcut];
      const eventKey = key === "Space" ? " " : key!;
      expect(press(eventKey, o, mod === "Shift" ? { shiftKey: true } : {})).not.toBeNull();
    }
    const everyKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"];
    for (const key of everyKey) {
      if (press(key, o) !== null) expect(announced).toContain(key);
    }
  });
});
