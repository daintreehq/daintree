import type { ReactElement, ReactNode } from "react";
import { KbdChord } from "@/components/ui/Kbd";

/**
 * Build tooltip content as a flex row: action label on the left, chord pills
 * on the right. A surface that can only hold a string (a native `title`) uses
 * `labelWithShortcut` from `@/lib/kbdShortcut`, which prints the same grammar;
 * an accessible name uses `describeChord`.
 */
/** The gap between a label and its keys, shared with the shortcut hint card. */
export const SHORTCUT_ROW_GAP = "gap-4";

export function createTooltipContent(label: ReactNode, shortcut?: string): ReactElement {
  if (!shortcut || !shortcut.trim()) {
    return <span>{label}</span>;
  }

  return (
    <span className={`flex items-center justify-between ${SHORTCUT_ROW_GAP} w-full`}>
      <span>{label}</span>
      <KbdChord shortcut={shortcut} />
    </span>
  );
}
