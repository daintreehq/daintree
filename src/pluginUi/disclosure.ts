import { useLayoutEffect, useRef, useState } from "react";
import type { UseDisclosureOptions, UseDisclosureResult } from "@shared/types/plugin-sdk-react";

/**
 * Open/closed state for a popover, dialog, sheet or section, controlled with
 * `open` + `onOpenChange` or uncontrolled from `defaultOpen`. `onOpenChange`
 * only fires for a change: from what is rendered, from a request made earlier
 * in the same handler, or back from a request a controlled owner hasn't
 * rendered yet. A controlled owner that declines a request hears the next one.
 */
export function useDisclosure(rawOptions?: UseDisclosureOptions): UseDisclosureResult {
  const options: UseDisclosureOptions =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const [inner, setInner] = useState(() => options.defaultOpen === true);
  const controlled = typeof options.open === "boolean";
  const open = controlled ? options.open === true : inner;
  const notify = typeof options.onOpenChange === "function" ? options.onOpenChange : undefined;

  // The last request, and whether the next one still composes with it, so an
  // `onOpen(); onClose()` in one handler ends closed rather than on this
  // render's value. An uncontrolled request is always applied, so it stays live
  // until `open` changes, even across an unrelated commit that renders ahead of
  // it. A controlled owner can decline and keep rendering the same `open`, so
  // there the request stops composing at the next commit or microtask, and
  // repeats compare against what is rendered. Until `open` changes it still
  // lets an undo through: the owner may have accepted on a later lane.
  const rendered = useRef(open);
  const last = useRef<{ value: boolean; live: boolean } | null>(null);
  useLayoutEffect(() => {
    if (rendered.current !== open) last.current = null;
    else if (controlled && last.current) last.current.live = false;
    rendered.current = open;
  });

  const set = (next: boolean) => {
    const request = last.current;
    const repeat = request?.live
      ? next === request.value
      : next === rendered.current && (request === null || request.value === next);
    if (repeat) return;
    const entry = { value: next, live: true };
    last.current = entry;
    if (controlled) {
      queueMicrotask(() => {
        entry.live = false;
      });
    } else {
      setInner(next);
    }
    notify?.(next);
  };

  return {
    open,
    onOpen: () => set(true),
    onClose: () => set(false),
    onToggle: () => {
      const request = last.current;
      set(!(request?.live ? request.value : rendered.current));
    },
    onOpenChange: (next: boolean) => set(next === true),
  };
}
