import { useLayoutEffect, useRef, useState } from "react";
import type { UseDisclosureOptions, UseDisclosureResult } from "@shared/types/plugin-sdk-react";

/**
 * Open/closed state for a popover, dialog, sheet or section, controlled with
 * `open` + `onOpenChange` or uncontrolled from `defaultOpen`. `onOpenChange`
 * only fires when the value actually changes.
 */
export function useDisclosure(rawOptions?: UseDisclosureOptions): UseDisclosureResult {
  const options: UseDisclosureOptions =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const [inner, setInner] = useState(() => options.defaultOpen === true);
  const controlled = typeof options.open === "boolean";
  const open = controlled ? options.open === true : inner;
  const notify = typeof options.onOpenChange === "function" ? options.onOpenChange : undefined;

  // The value the next change compares against: the last one set, so an
  // `onOpen(); onClose()` in one handler ends closed, not on this render's value.
  const latest = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    latest.current = open;
  }, [open]);

  const set = (next: boolean) => {
    const current = latest.current ?? open;
    if (next === current) return;
    latest.current = next;
    if (!controlled) setInner(next);
    notify?.(next);
  };

  return {
    open,
    onOpen: () => set(true),
    onClose: () => set(false),
    onToggle: () => set(!(latest.current ?? open)),
    onOpenChange: (next: boolean) => set(next === true),
  };
}
