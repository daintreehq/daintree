import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Telescope } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { useOverlayClaim } from "@/hooks/useOverlayState";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { useCanopyStore } from "@/store/canopyStore";
import { hideCanopy } from "./canopyHide";
import { CanopyHeaderCenter } from "./CanopyHostPicker";
import { CanopyPitch } from "./CanopyPitch";
import { CANOPY_TITLE } from "./canopyTerms";

/**
 * All of Canopy a project window shows (#16581): the offer to turn it on, before
 * it is on. Once on, Canopy opens in its own window, so nothing here lists a
 * host, reads a terminal or holds the inbox.
 */
export function CanopyOffer() {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const activated = useCanopyStore((s) => s.snapshot?.activated ?? null);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  const close = useCanopyStore((s) => s.close);
  useOverlayClaim("canopy", isOpen);
  // A view put in the background — another project shown in its place — can
  // be seen by no one, and its offer goes with it.
  useEffect(() => {
    if (!isOpen) return;
    // Already there: opened by a key while the offer's code loaded, and the
    // project switched away before it mounted.
    if (isProjectViewCached()) {
      close();
      return;
    }
    return subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") close();
    });
  }, [isOpen, close]);
  // What had the keyboard when the offer opened, which gets it back on close.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [isOpen]);
  const restoreOpener = useCallback(
    () => (openerRef.current?.isConnected ? openerRef.current : null),
    []
  );
  const loadingRef = useRef<HTMLDivElement>(null);
  // A dialog over a project window, whose own controls close the project: this
  // is what puts the offer away.
  const closeButton = <AppDialog.CloseButton aria-label={`Close ${CANOPY_TITLE}`} />;
  useEffect(() => {
    if (!isOpen || activated !== null) return;
    const frame = requestAnimationFrame(() => {
      loadingRef.current?.focus({ preventScroll: true, focusVisible: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, activated]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      placement="window"
      // The pitch puts the keyboard on its heading, and loading on itself:
      // Close and Turn on are no place for a reflexive Enter.
      initialFocus="none"
      restoreFocusTo={restoreOpener}
      preferRestoreFocusTo
      data-testid="canopy-dialog"
    >
      {/* Until the user turns it on, nothing is read: the pitch is the one
          place that asks, so nothing in front of it asks first. */}
      {activated === false ? (
        <CanopyPitch
          isOpen={isOpen}
          onTurnOn={() => window.electron.canopy.setMode("on").then(applySnapshot)}
          onHide={hideCanopy}
          headerActions={closeButton}
        />
      ) : (
        <>
          <AppDialog.Header>
            <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
            <CanopyHeaderCenter />
            {closeButton}
          </AppDialog.Header>
          {/* Main hasn't said yet whether Canopy is on. The keyboard waits
              here, inside the dialog, rather than on whatever opened it — a
              terminal behind the scrim would take the keys. */}
          <div ref={loadingRef} tabIndex={-1} className="flex-1" aria-busy="true" />
        </>
      )}
    </AppDialog>
  );
}
