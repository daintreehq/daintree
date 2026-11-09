import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AppDialog, AppDialogWindowChrome, type AppDialogProps } from "@/components/ui/AppDialog";
import {
  isTopmostDialogBackstop,
  markBackstopConsumedEscape,
  radixLayerWasOpenWhenEscapePressed,
  registerDialogEscapeBackstop,
} from "@/lib/dialogEscapeBackstop";
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
 * close button inside are the same in both.
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
  // Read when Escape lands: registering again for a new closer would put this
  // surface back on top of a dialog open over it, as AppDialog's comment says.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  // Escape reaches the host as it reaches the dialog: from the list, after the
  // search has cleared, and never past a dialog or a menu open inside the inbox.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const closeThis = () => closeRef.current();
    const unregister = registerDialogEscapeBackstop(closeThis);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.repeat) return;
      if (!isTopmostDialogBackstop(closeThis) || radixLayerWasOpenWhenEscapePressed()) return;
      markBackstopConsumedEscape();
      closeThis();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unregister();
    };
  }, [isOpen]);
  if (!isOpen) return null;
  return (
    <AppDialogWindowChrome onClose={close}>
      <section
        aria-label={CANOPY_TITLE}
        data-canopy-standalone=""
        // The window's title bar is the header: `.dialog-window-header` drags
        // only beneath `app-no-drag`, as in a window AppDialog.
        className="app-no-drag flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface-dialog"
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
