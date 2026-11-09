import type { ReactNode } from "react";
import { AppDialog, AppDialogWindowChrome, type AppDialogProps } from "@/components/ui/AppDialog";
import { useCanopyFrame } from "./canopyFrame";
import { CANOPY_TITLE } from "./canopyTerms";

type CanopySurfaceProps = Pick<
  AppDialogProps,
  "initialFocus" | "restoreFocusTo" | "preferRestoreFocusTo"
> & {
  isOpen: boolean;
  children: ReactNode;
};

/**
 * What the panel's every state is drawn in: today's window dialog, or a plain
 * section filling whatever a standalone host gives it. The header, title and
 * close button inside are the same in both; only the dialog closes on Escape.
 */
export function CanopySurface({ isOpen, children, ...dialog }: CanopySurfaceProps) {
  const frame = useCanopyFrame();
  if (frame.host === "standalone") {
    return (
      <StandaloneSurface isOpen={isOpen} close={frame.close}>
        {children}
      </StandaloneSurface>
    );
  }
  return (
    <AppDialog
      isOpen={isOpen}
      onClose={frame.close}
      placement="window"
      {...dialog}
      data-testid="canopy-dialog"
    >
      {children}
    </AppDialog>
  );
}

function StandaloneSurface({
  isOpen,
  close,
  children,
}: {
  isOpen: boolean;
  close: () => void;
  children: ReactNode;
}) {
  // No Escape here: the host is a window left open all day, often on another
  // display, and one stray press would lose it and its place (#16580). Escape
  // unwinds what is open inside it and stops at the list; the window closes by
  // its close button, Cmd+W or its own title bar.
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
  const frame = useCanopyFrame();
  return (
    <AppDialog.CloseButton
      {...(frame.host === "standalone" ? { "aria-label": `Close ${CANOPY_TITLE}` } : {})}
    />
  );
}
