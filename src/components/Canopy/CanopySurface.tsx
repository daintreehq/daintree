import type { ReactNode } from "react";
import { AppDialogWindowChrome } from "@/components/ui/AppDialog";
import { CANOPY_TITLE } from "./canopyTerms";

/**
 * What the inbox's every state is drawn in: a plain section filling the window
 * that hosts it, under a header whose title is a dialog's.
 *
 * No close button here: the window closes by the OS's own control, as every
 * Daintree window does, or by Cmd+W and the menu's Close Window, and a second ×
 * beside the first would be a duplicate (#16594). No Escape either: the window
 * is left open all day, often on another display, and one stray press would
 * lose it and its place (#16580). Escape unwinds what is open inside it and
 * stops at the list.
 */
export function CanopySurface({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  if (!isOpen) return null;
  return (
    <AppDialogWindowChrome>
      <section
        aria-label={CANOPY_TITLE}
        data-canopy-standalone=""
        // Focus anywhere in it hands prompt history to the run's reply, short
        // of the docked global assistant, which is a host of its own.
        data-prompt-history-host=""
        // Makes the header the window's title bar. Never `app-no-drag`: its
        // body's scrolled terminal would cut the header's drag away (window-modes.css).
        className="app-window-surface flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface-dialog"
      >
        {children}
      </section>
    </AppDialogWindowChrome>
  );
}
