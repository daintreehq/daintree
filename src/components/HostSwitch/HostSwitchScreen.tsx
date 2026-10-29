import { useEffect, useId, useRef, useState } from "react";
import type { PendingHostSwitch } from "@shared/types/ipc/remoteHosts";
import { CircleCheck, CircleDashed } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Spinner } from "@/components/ui/Spinner";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { registerEscape } from "@/lib/escapeStack";
import { ClientAppError } from "@/utils/clientAppError";
import { hostSwitchRecovery, switchToHost } from "@/components/Hosts/hostSwitching";
import { DaintreeMarkDraw } from "./DaintreeMarkDraw";
import {
  HOST_SWITCH_STEPS,
  hostSwitchStepLabel,
  hostSwitchStoppedIn,
  pendingHostSwitchHeading,
  pendingHostSwitchStatus,
} from "./pendingHostSwitchFeedback";

const COMMITTED_NOTE = "The window is moving now and can't be cancelled";

function cancel(pending: PendingHostSwitch): void {
  void window.electron?.remoteHosts
    ?.cancelPendingSwitch?.({ switchId: pending.switchId })
    ?.catch(() => {});
}

/**
 * The window's switch to another host, from the moment it is asked for: the
 * window is on its way there, so it shows where it is going and how far it
 * has got instead of the project it is leaving. Cancel goes back to exactly
 * where it was (that project was never touched underneath), and a switch that
 * fails ends here, saying where it stopped and why, with the one way back.
 *
 * Painted below dialogs and palettes, so one opened over it can still take the
 * window somewhere else, which leaves this screen for good.
 *
 * It leaves with this view when the switch lands, so main reads its root (the
 * canvas, transparent inside the gate) and its first child (the title band)
 * just before the swap, and the destination fades that surface out
 * (electron/window/switchScreenHandoff.ts).
 */
export function HostSwitchScreen({ pending }: { pending: PendingHostSwitch }) {
  const titleId = useId();
  const failed = pending.phase === "failed";
  // A host that is answering usually lands inside the gate: nothing flashes.
  // Waiting on the link is known to be slow, so it shows at once.
  const [shown, setShown] = useState(pending.phase !== "opening");
  const [stillWorking, setStillWorking] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const cancellable = failed || !pending.committed;
  const escapeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (shown) return;
    const timer = setTimeout(() => setShown(true), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(timer);
  }, [shown]);

  // Measured per switch, across its phases: a Retry starts the count again.
  useEffect(() => {
    setStillWorking(false);
    const timer = setTimeout(() => setStillWorking(true), UI_STILL_WORKING_MS);
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
  // Focus moves only while nothing else has taken it since the switch began:
  // a palette opened over the screen (even inside its loading gate) keeps it.
  // Inside the gate the screen itself takes it, so Tab can't wander the
  // project behind while nothing shows; once shown it goes to the button. With
  // no control left (the window is moving), the screen holds it.
  useEffect(() => {
    const active = document.activeElement;
    const ownsFocus =
      active === null ||
      active === document.body ||
      active === restoreFocusRef.current ||
      screenRef.current?.contains(active) === true;
    if (!ownsFocus) return;
    if (shown && primaryRef.current) primaryRef.current.focus({ preventScroll: true });
    else screenRef.current?.focus({ preventScroll: true, focusVisible: false });
  }, [shown, pending.switchId, failed, pending.committed]);

  // On the escape stack for as long as it is up, so Escape and Cmd/Ctrl+W
  // leave the screen rather than reach the project behind it. It sits under
  // every dialog and palette, open before it or after, and they close first. Once the window is moving
  // there is nothing to leave, and the keys still go nowhere.
  useEffect(() => {
    escapeRef.current = () => {
      if (cancellable) cancel(pending);
    };
  }, [cancellable, pending]);
  useEffect(() => {
    const { unregister } = registerEscape(() => escapeRef.current(), { position: "bottom" });
    return unregister;
  }, []);

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
    if (recovery.kind !== "retry") cancel(pending);
    recovery.run();
  };
  const failureMessage =
    pending.failure?.message ?? "Couldn't reach this host. Check that it is on and try again.";
  // Where the switch is (or stopped): a failure keeps the step it reached.
  const current =
    pending.phase === "failed" ? (pending.failure?.phase ?? "connecting") : pending.phase;
  const currentIndex = HOST_SWITCH_STEPS.indexOf(current);

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
      ref={screenRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Tab stays on the screen: the controls behind it are not there.
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (!shown) return;
        const buttons = [...(screenRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        if (buttons.length === 0) return;
        const at = buttons.findIndex((button) => button === document.activeElement);
        const step = event.shiftKey ? -1 : 1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      }}
    >
      {/* The toolbar's band, empty: the window keeps its title bar to drag by
          and its controls to sit on. Nothing else here stands in for a layout
          the destination hasn't shown yet. */}
      <div aria-hidden="true" className="app-drag-region h-12 shrink-0 bg-surface-toolbar" />
      {/* The canvas covers the window at once when the gate opens, so the project
          being left never shows through; what it says fades in over it, as the
          boot screen's does, and a switch landing moments later cuts from a
          quiet frame rather than a finished one. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-6",
          "transition-opacity duration-200 ease-out starting:opacity-0",
          !shown && "opacity-0"
        )}
      >
        {/* Anchored from the top rather than centred, so a failure's reason
            grows downward and the mark, names and steps above it stay put. */}
        <div className="mx-auto flex w-full max-w-sm flex-col items-center pb-12 pt-[clamp(1.5rem,calc(50vh-15rem),18rem)]">
          <div className="h-16 w-[90px] shrink-0 text-text-secondary">
            {/* Mounted when the screen is first shown and kept for the whole
                switch, a retry included, so the draw plays once. */}
            {shown && <DaintreeMarkDraw className="size-full" />}
          </div>
          <h2
            id={titleId}
            className="mt-5 w-full text-center text-lg font-semibold text-text-primary [overflow-wrap:anywhere]"
          >
            {pendingHostSwitchHeading(pending)}
          </h2>
          <p className="mt-1 w-full text-center text-sm [overflow-wrap:anywhere]">
            <span className="text-text-secondary">Project</span>{" "}
            {pending.projectName ? (
              <span className="font-medium text-text-primary">{pending.projectName}</span>
            ) : (
              <span className="text-text-secondary">{failed ? "not known" : "not known yet"}</span>
            )}
          </p>
          <ol aria-label="Progress" className="mt-6 flex w-full flex-col gap-1">
            {HOST_SWITCH_STEPS.map((step, index) => {
              if (failed && index === currentIndex) {
                return (
                  <li key={step} className="py-1">
                    <Callout
                      severity="error"
                      role="alert"
                      title={hostSwitchStoppedIn(step)}
                      // Its glyph sits in the steps' glyph column: padding plus border.
                      className="-mx-3.25 text-sm"
                    >
                      <p className="[text-wrap:pretty]">{failureMessage}</p>
                      {recovery?.hint && <p className="mt-1 [text-wrap:pretty]">{recovery.hint}</p>}
                    </Callout>
                  </li>
                );
              }
              const state =
                index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
              return (
                <li
                  key={step}
                  aria-current={state === "active" ? "step" : undefined}
                  className={cn(
                    "flex min-h-7 items-center gap-2 text-sm",
                    state === "active" ? "font-medium text-text-primary" : "text-text-secondary"
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {state === "done" ? (
                      <CircleCheck className="size-4" aria-hidden="true" />
                    ) : state === "active" ? (
                      <Spinner size="md" />
                    ) : (
                      <CircleDashed className="size-4" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0">
                    {hostSwitchStepLabel(step, state)}
                    <span className="sr-only">
                      {state === "done" ? ", done" : state === "pending" ? ", not started" : ""}
                    </span>
                    {/* On the step it is about, in the line it already has, so
                        nothing below moves when it appears. */}
                    {state === "active" && stillWorking && (
                      <span className="ml-2 font-normal text-text-secondary">Still working…</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="mt-7 flex min-h-8 w-full flex-wrap items-center justify-center gap-x-2 gap-y-3">
            {recovery && (
              <Button
                ref={primaryRef}
                variant="contrast"
                onClick={runRecovery}
                // An update names its host, which can be longer than the column.
                className="h-auto min-h-8 max-w-full whitespace-normal text-center [overflow-wrap:anywhere]"
              >
                {recovery.label}
              </Button>
            )}
            {cancellable ? (
              <Button
                ref={recovery ? undefined : primaryRef}
                variant="secondary"
                onClick={() => cancel(pending)}
              >
                Cancel
              </Button>
            ) : (
              <p className="text-center text-sm text-text-secondary">{COMMITTED_NOTE}</p>
            )}
          </div>
        </div>
      </div>
      {/* What changed, said once per step and once at the point of no return:
          the visible list, the project name and "Still working…" stay quiet. */}
      <div role="status" className="sr-only">
        {pending.phase === "failed"
          ? null
          : pending.committed
            ? `${pendingHostSwitchStatus(pending.phase)} ${COMMITTED_NOTE}`
            : pendingHostSwitchStatus(pending.phase)}
      </div>
    </div>
  );
}
