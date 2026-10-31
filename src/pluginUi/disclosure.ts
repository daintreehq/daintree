import { useLayoutEffect, useRef, useState } from "react";
import type { UseDisclosureOptions, UseDisclosureResult } from "@shared/types/plugin-sdk-react";

/**
 * Open/closed state for a popover, dialog, sheet or section, controlled with
 * `open` + `onOpenChange` or uncontrolled from `defaultOpen`. `onOpenChange`
 * only fires for a change from what is rendered, or from a request made
 * earlier in the same handler; a controlled owner that declines a request
 * hears the next one.
 */
export function useDisclosure(rawOptions?: UseDisclosureOptions): UseDisclosureResult {
  const options: UseDisclosureOptions =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const [inner, setInner] = useState(() => options.defaultOpen === true);
  const controlled = typeof options.open === "boolean";
  const open = controlled ? options.open === true : inner;
  const notify = typeof options.onOpenChange === "function" ? options.onOpenChange : undefined;

  // Changes compare against the last request not yet rendered, so an
  // `onOpen(); onClose()` in one handler ends closed rather than on this
  // render's value. A controlled owner can decline and keep rendering the same
  // `open`, so its request lapses at the next commit or microtask; an
  // uncontrolled one is always applied, so it lasts until `open` changes, even
  // across an unrelated commit that renders ahead of it.
  const rendered = useRef(open);
  const pending = useRef<{ value: boolean } | null>(null);
  useLayoutEffect(() => {
    if (controlled || rendered.current !== open) pending.current = null;
    rendered.current = open;
  });

  const set = (next: boolean) => {
    const current = pending.current?.value ?? rendered.current;
    if (next === current) return;
    const request = { value: next };
    pending.current = request;
    if (controlled) {
      // Only this request's own lapse: a newer one made after a commit stands.
      queueMicrotask(() => {
        if (pending.current === request) pending.current = null;
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
    onToggle: () => set(!(pending.current?.value ?? rendered.current)),
    onOpenChange: (next: boolean) => set(next === true),
  };
}
