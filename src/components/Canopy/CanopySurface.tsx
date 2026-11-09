import type { ReactNode } from "react";
import { AppDialog, AppDialogWindowChrome } from "@/components/ui/AppDialog";
import { useCanopyFrame } from "./canopyFrame";
import { CANOPY_TITLE } from "./canopyTerms";

/**
 * What the inbox's every state is drawn in: a plain section filling the window
 * that hosts it, under a header whose title and close button are a dialog's.
 *
 * No Escape here: the host is a window left open all day, often on another
 * display, and one stray press would lose it and its place (#16580). Escape
 * unwinds what is open inside it and stops at the list; the window closes by
 * its close button, Cmd+W or its own title bar.
 */
export function CanopySurface({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  const { close } = useCanopyFrame();
  if (!isOpen) return null;
  return (
    <AppDialogWindowChrome onClose={close}>
      <section
        aria-label={CANOPY_TITLE}
        data-canopy-standalone=""
        // Makes the header the window's title bar. Never `app-no-drag`: its
        // body's scrolled terminal would cut the header's drag away (window-modes.css).
        className="app-window-surface flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface-dialog"
      >
        {children}
      </section>
    </AppDialogWindowChrome>
  );
}

/** Names what it closes where there is no dialog to call it. */
export function CanopyCloseButton() {
  return <AppDialog.CloseButton aria-label={`Close ${CANOPY_TITLE}`} />;
}
