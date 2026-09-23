import { useEffect, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { actionService } from "@/services/ActionService";
import { usePanelLimitStore, type PanelLimitConfirmRequest } from "@/store/panelLimitStore";

function panels(count: number): string {
  return `${count} ${count === 1 ? "panel" : "panels"}`;
}

/**
 * The copy for one batch request. Every number comes from the request the
 * preflight captured, so the dialog states the decision that was actually made:
 * how many will open, onto how many, and which threshold that crosses — and,
 * when the hard limit trimmed the batch, how many were asked for and won't open.
 */
export function describePanelLimitRequest(request: PanelLimitConfirmRequest): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  const { currentCount, requestedCount, allowedCount, confirmationLimit, hardLimit, source } =
    request;
  const total = currentCount + allowedCount;
  const trimmed = allowedCount < requestedCount;
  const subject =
    source?.kind === "recipe"
      ? `'${source.name}'`
      : source?.kind === "clone-layout"
        ? "Cloning the current layout"
        : "This launch";
  const threshold = `past your confirmation threshold of ${confirmationLimit}`;

  if (trimmed) {
    const left = requestedCount - allowedCount;
    return {
      title: `Open ${allowedCount} of ${requestedCount} panels?`,
      // Both batch callers spawn in launch order, so the panels that fit are
      // always the first ones — saying so tells the user which half they get.
      description: `${subject} asks for ${panels(requestedCount)}, but the hard limit of ${hardLimit} leaves room for ${allowedCount === 1 ? "the first one" : `the first ${allowedCount}`}. The other ${left} won't open. Opening ${allowedCount} brings you to ${total}, ${threshold}.`,
      confirmLabel: `Open ${panels(allowedCount)}`,
    };
  }

  const onto =
    currentCount > 0
      ? `adds ${panels(allowedCount)} to the ${currentCount} already open, for ${total} in total`
      : `opens ${panels(allowedCount)}`;
  return {
    title: `Open ${panels(allowedCount)}?`,
    description: `${subject} ${onto}, ${threshold}.`,
    confirmLabel: `Open ${panels(allowedCount)}`,
  };
}

export function PanelLimitConfirmDialog() {
  const pendingConfirm = usePanelLimitStore((state) => state.pendingConfirm);
  const resolveConfirmation = usePanelLimitStore((state) => state.resolveConfirmation);
  // Reset on each new request. `requestSeq` (not a derived key) covers
  // back-to-back requests with identical params — a derived key wouldn't change
  // and a crashed boundary would stay stuck (#9918).
  const requestSeq = usePanelLimitStore((state) => state.requestSeq);

  // Decline a pending request when the host really unmounts, so the batch never
  // waits on a dialog nobody can see. Checked a microtask later because
  // StrictMode's simulated unmount runs this cleanup and then remounts in the
  // same commit — declining there would cancel a request the moment it opened.
  // A ref, not a closure flag: the remount runs a fresh setup, and only state
  // shared across both runs can tell the declining microtask it came back.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        if (usePanelLimitStore.getState().pendingConfirm) {
          usePanelLimitStore.getState().resolveConfirmation(false);
        }
      });
    };
  }, []);

  if (!pendingConfirm) return null;

  const { title, description, confirmLabel } = describePanelLimitRequest(pendingConfirm.request);

  const changeLimits = () => {
    resolveConfirmation(false);
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "terminal", subtab: "performance", sectionId: "terminal-panel-limits" },
      { source: "user" }
    );
  };

  return (
    <ErrorBoundary
      variant="component"
      componentName="PanelLimitConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveConfirmation(false)}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel="Cancel"
        onConfirm={() => resolveConfirmation(true)}
        variant="default"
        hint={
          <button
            type="button"
            onClick={changeLimits}
            className="min-w-0 truncate rounded-sm text-xs text-text-secondary underline underline-offset-2 transition-colors hover:text-text-primary outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            Cancel and change limits
          </button>
        }
      />
    </ErrorBoundary>
  );
}
