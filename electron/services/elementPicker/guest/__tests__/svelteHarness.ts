import { vi } from "vitest";
import type { SvelteEvidence } from "../../../../../shared/elementPicker/evidence.js";
import type {
  HoverObservation,
  SelectionObservation,
} from "../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../shared/elementPicker/protocol.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../guestChannel.js";
import { createPicker, type PickerHandle } from "../picker.js";
import { installExtractor } from "../registry.js";
import { createSvelteExtractor } from "../svelte/extractor.js";
import type { PickerMode } from "../types.js";

/**
 * The core picker and the Svelte extractor as the page runs them, minus the
 * second world: jsdom has one, so the bridge's events reach both halves in
 * the same realm. Every event the bootstrap posts is parsed by the host's own
 * schema, so a contribution the host would refuse fails the test that made it.
 */

export const CHANNEL = "svelte-test";

const scope = globalThis as unknown as Record<string, unknown>;

export interface SvelteHarness {
  picker: PickerHandle;
  events: ElementPickerEvent[];
}

let current: { picker: PickerHandle; frames: Map<number, FrameRequestCallback> } | null = null;

export function start(
  mode: PickerMode = "select",
  options: { svelte?: boolean } = {}
): SvelteHarness {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  const events: ElementPickerEvent[] = [];
  const picker = createPicker({
    channel: CHANNEL,
    mode,
    post: (event) => {
      const parsed = ElementPickerEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
      events.push(event);
    },
  });
  current = { picker, frames };
  if (options.svelte !== false) {
    const api = { channel: CHANNEL, framework: "svelte", installed: false };
    installExtractor(api, createSvelteExtractor());
    if (!api.installed) throw new Error("the Svelte extractor did not register");
  }
  return { picker, events };
}

export function runFrames(): void {
  if (current === null) return;
  const pending = [...current.frames.values()];
  current.frames.clear();
  for (const callback of pending) callback(0);
}

export function stop(): void {
  current?.picker.dispose();
  current = null;
  delete scope[EXTRACTOR_REGISTRY_GLOBAL];
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
}

export function setMeta(node: Element, loc: unknown, parent?: unknown): void {
  (node as unknown as { __svelte_meta: unknown }).__svelte_meta = { loc, parent };
}

export function loc(line: number, column = 2, file = "src/routes/+page.svelte") {
  return { file, line, column };
}

export function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  node.dispatchEvent(event);
  return event;
}

export function key(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function ofType<T extends ElementPickerEvent["type"]>(
  events: ElementPickerEvent[],
  type: T
): Array<Extract<ElementPickerEvent, { type: T }>> {
  return events.filter((event): event is Extract<ElementPickerEvent, { type: T }> => {
    return event.type === type;
  });
}

export function lastSelectionEvent(events: ElementPickerEvent[]) {
  const latest = ofType(events, "selectionChanged").at(-1);
  if (latest === undefined) throw new Error("no selectionChanged");
  return latest;
}

export function lastSelection(events: ElementPickerEvent[]): SelectionObservation[] {
  return lastSelectionEvent(events).observations;
}

export function evidenceOf(observation: SelectionObservation | undefined): SvelteEvidence {
  const evidence = observation?.frameworkEvidence.find((entry) => entry.kind === "svelte");
  if (evidence === undefined || evidence.kind !== "svelte") throw new Error("no Svelte evidence");
  return evidence;
}

/** The element's own template location, as `loc(...)` writes it, or null. */
export function locOf(observation: HoverObservation | SelectionObservation | null | undefined) {
  const candidate = observation?.sourceCandidates.find(
    (entry) => entry.kind === "template-location"
  );
  if (candidate === undefined || !("location" in candidate)) return null;
  return { file: candidate.file, line: candidate.location.line, column: candidate.location.column };
}

export function componentNames(
  observation: HoverObservation | SelectionObservation | null | undefined
): string[] {
  return (observation?.componentChain.components ?? []).map((record) => record.name?.value ?? "");
}
