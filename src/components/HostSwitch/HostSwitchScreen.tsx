import { useEffect, useId, useRef, useState } from "react";
import type { PendingHostSwitch } from "@shared/types/ipc/remoteHosts";
import { Button } from "@/components/ui/button";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { ClientAppError } from "@/utils/clientAppError";
import { hostSwitchRecovery, switchToHost } from "@/components/Hosts/hostSwitching";
import { STILL_WORKING_MS, pendingHostSwitchTitle } from "./pendingHostSwitchFeedback";

const SIDEBAR_CARDS = 4;

function cancel(pending: PendingHostSwitch): void {
  void window.electron?.remoteHosts
    ?.cancelPendingSwitch?.({ switchId: pending.switchId })
    ?.catch(() => {});
}

/**
 * The window's switch to another host, from the moment it is asked for: the
 * window is on its way there, so it shows the host's loading screen instead of
 * the project it is leaving. Cancel goes back to exactly where it was (that
 * project was never touched underneath), and a host that can't be reached ends
 * here, saying what was seen, with a way to retry.
 *
 * Painted below dialogs and palettes, so one opened over it can still take the
 * window somewhere else, which leaves this screen for good.
 */
export function HostSwitchScreen({ pending }: { pending: PendingHostSwitch }) {
  const titleId = useId();
  const failed = pending.phase === "failed";
  // A host that is answering usually lands inside the gate: nothing flashes.
  // Waiting on the link is known to be slow, so it shows at once.
  const [shown, setShown] = useState(pending.phase !== "opening");
  const [stillWorking, setStillWorking] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (shown) return;
    const timer = setTimeout(() => setShown(true), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(timer);
  }, [shown]);

  // Measured per switch, across its phases: a Retry starts the count again.
  useEffect(() => {
    setStillWorking(false);
    const timer = setTimeout(() => setStillWorking(true), STILL_WORKING_MS);
    return () => clearTimeout(timer);
  }, [pending.switchId]);

  // Focus moves onto the screen so nothing typed reaches the project behind
  // it, and goes back to where it was when the screen goes.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true, focusVisible: false });
      }
    };
  }, []);
  useEffect(() => {
    if (shown) primaryRef.current?.focus({ preventScroll: true });
  }, [shown, pending.switchId, failed, pending.committed]);

  const recovery = failed
    ? hostSwitchRecovery(
        pending.hostId,
        new ClientAppError(
          pending.failure?.code ?? "HOST_DISCONNECTED",
          pending.failure?.message ?? "",
          pending.failure?.message
        ),
        () =>
          void switchToHost(pending.hostId, false, pending.request?.projectId, {
            focusIntent: pending.request?.focusIntent,
          })
      )
    : null;
  const runRecovery = () => {
    if (!recovery) return;
    // Retry replaces this screen with the new attempt's; anything else takes
    // the window somewhere else, so it leaves this switch behind first.
    if (recovery.label !== "Retry") cancel(pending);
    recovery.run();
  };
  const cancellable = failed || !pending.committed;

  const message = failed
    ? (pending.failure?.message ?? "Couldn't reach this host. Check that it is on and try again.")
    : stillWorking
      ? "Still working…"
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="host-switch-screen"
      data-phase={pending.phase}
      className={cn(
        "fixed inset-0 z-[calc(var(--z-toolbar)+1)] flex flex-col bg-surface-canvas",
        !shown && "opacity-0"
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !cancellable) return;
        event.preventDefault();
        event.stopPropagation();
        cancel(pending);
      }}
    >
      <div
        aria-hidden="true"
        className="app-drag-region flex h-12 shrink-0 items-center gap-2 bg-surface-toolbar px-4"
      >
        <SkeletonBone immediate className="h-4 w-4" />
        <SkeletonBone immediate className="h-4 w-4" />
        <div className="flex-1" />
        <SkeletonBone immediate className="h-4 w-32" />
        <div className="flex-1" />
        <SkeletonBone immediate className="h-4 w-4" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          aria-hidden="true"
          className="flex w-[300px] shrink-0 flex-col gap-4 bg-surface-sidebar p-4"
        >
          <SkeletonBone immediate className="h-8 w-full rounded-[var(--radius-md)]" />
          {Array.from({ length: SIDEBAR_CARDS }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <SkeletonBone immediate className="h-3 w-3/4" />
              <SkeletonBone immediate className="h-3 w-1/2" />
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8">
          <div
            role={failed ? "alert" : "status"}
            className="flex max-w-md flex-col items-center gap-2 text-center"
          >
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">
              {pendingHostSwitchTitle(pending)}
            </h2>
            {message !== null && <p className="text-sm text-text-secondary">{message}</p>}
          </div>
          {(recovery || cancellable) && (
            <div className="flex items-center gap-2">
              {recovery && (
                <Button ref={primaryRef} variant="contrast" onClick={runRecovery}>
                  {recovery.label}
                </Button>
              )}
              {cancellable && (
                <Button
                  ref={recovery ? undefined : primaryRef}
                  variant="secondary"
                  onClick={() => cancel(pending)}
                >
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
