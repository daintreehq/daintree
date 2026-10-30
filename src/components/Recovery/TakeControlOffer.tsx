import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { takeControlConsequence, type ControlFacts } from "./recoveryCopy";
import { useTakeControlBusy } from "./takeControlPending";

/**
 * The action itself, loaded on use: it reaches the panel store, which a file
 * or plugin placeholder has no other reason to pull in. Outside the component,
 * where the compiler doesn't have to lower an `import()`.
 */
function requestTakeControl(projectId: string, panelId: string | undefined): void {
  void import("./takeControl").then(({ takeControl }) => takeControl(projectId, panelId));
}

/**
 * Take control, as every surface but the banners draws it: the banner's own
 * neutral outline and words, and the same request in flight wherever it was
 * asked from.
 */
export function TakeControlButton({
  projectId,
  panelId,
  describedBy,
}: {
  projectId: string;
  /** The pane to hand the keyboard back to once control lands. */
  panelId?: string;
  describedBy?: string;
}) {
  const busy = useTakeControlBusy(projectId);
  return (
    <Button
      variant="outline"
      size="sm"
      loading={busy}
      loadingPresentation="labelled"
      aria-describedby={describedBy}
      onClick={() => requestTakeControl(projectId, panelId)}
    >
      Take control
    </Button>
  );
}

/**
 * Take control where something waits for it — a held launch, a file or a
 * plugin view this window isn't served — with what it does to the device that
 * has control said right beneath it. The window banner makes the same offer
 * for the whole window; this one is for the place the user was trying to use.
 */
export function TakeControlOffer({
  projectId,
  facts,
  panelId,
  children,
}: {
  projectId: string;
  facts: ControlFacts;
  panelId?: string;
  /** Other ways out, after the offer. */
  children?: ReactNode;
}) {
  const consequenceId = useId();
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <TakeControlButton projectId={projectId} panelId={panelId} describedBy={consequenceId} />
        {children}
      </div>
      <p id={consequenceId} className="text-xs text-text-secondary">
        {takeControlConsequence(facts)}
      </p>
    </div>
  );
}
