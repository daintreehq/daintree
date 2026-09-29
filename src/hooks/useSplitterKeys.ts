import { useCallback } from "react";
import type React from "react";

export type SplitterGrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SplitterKeyOptions {
  /** The arrow that makes the pane this handle sizes bigger. It also fixes the axis. */
  growKey: SplitterGrowKey;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Shift+arrow. */
  largeStep: number;
}

export type SplitterKeyResult = { kind: "set"; value: number } | { kind: "reset" } | null;

const OPPOSITE: Record<SplitterGrowKey, SplitterGrowKey> = {
  ArrowLeft: "ArrowRight",
  ArrowRight: "ArrowLeft",
  ArrowUp: "ArrowDown",
  ArrowDown: "ArrowUp",
};

/**
 * Every splitter's keyboard contract, per the WAI-ARIA window-splitter pattern plus
 * the house reset: arrows step, Shift+arrow takes the large step, Home and End jump
 * to the pane's smallest and largest size, and Enter or Space resets. The arrows on
 * the other axis do nothing, so a vertical splitter never eats ArrowUp from a scroller.
 * A horizontal splitter also takes PageUp/PageDown as the large step in that direction;
 * a vertical one has no direction for them, so it leaves them alone.
 */
export function resolveSplitterKey(
  e: Pick<React.KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  { growKey, value, min, max, step, largeStep }: SplitterKeyOptions
): SplitterKeyResult {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const clamp = (next: number) => Math.min(Math.max(next, min), max);
  const horizontal = growKey === "ArrowUp" || growKey === "ArrowDown";
  const page = horizontal && (e.key === "PageUp" || e.key === "PageDown");
  const key = page ? (e.key === "PageUp" ? "ArrowUp" : "ArrowDown") : e.key;
  const delta = e.shiftKey || page ? largeStep : step;
  switch (key) {
    case growKey:
      return { kind: "set", value: clamp(value + delta) };
    case OPPOSITE[growKey]:
      return { kind: "set", value: clamp(value - delta) };
    case "Home":
      return { kind: "set", value: min };
    case "End":
      return { kind: "set", value: max };
    case "Enter":
    case " ":
      return { kind: "reset" };
    default:
      return null;
  }
}

/** The `aria-keyshortcuts` a splitter on this axis actually binds. */
export function splitterKeyShortcuts(growKey: SplitterGrowKey): string {
  if (growKey === "ArrowLeft" || growKey === "ArrowRight") {
    return "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Enter Space";
  }
  return "ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown PageUp PageDown Home End Enter Space";
}

export interface UseSplitterKeysOptions extends SplitterKeyOptions {
  onChange: (value: number) => void;
  onReset: () => void;
}

/**
 * `resolveSplitterKey` wired to a setter. The handler returns whether it consumed
 * the key, so a caller that must also stop propagation can do so for handled keys only.
 */
export function useSplitterKeys({
  growKey,
  value,
  min,
  max,
  step,
  largeStep,
  onChange,
  onReset,
}: UseSplitterKeysOptions): (e: React.KeyboardEvent) => boolean {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const result = resolveSplitterKey(e, { growKey, value, min, max, step, largeStep });
      if (!result) return false;
      e.preventDefault();
      if (result.kind === "reset") onReset();
      else onChange(result.value);
      return true;
    },
    [growKey, value, min, max, step, largeStep, onChange, onReset]
  );
}
