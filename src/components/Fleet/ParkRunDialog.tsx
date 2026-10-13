import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { InlineError } from "@/components/ui/field";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { bandForRun, bandLabel } from "@/lib/fleetAttention";
import {
  composePilotRunTitle,
  derivePilotRunChrome,
  directoryLabel,
} from "@/components/Pilot/pilotRows";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import {
  PARK_GATE_NONE,
  RunParkFields,
  resolveParkGateId,
  type ParkGateCandidate,
} from "./RunParkFields";

/** Specs select the group by name, so it is fixed rather than `useId`-derived. */
const GATE_GROUP_NAME = "park-run-gate";

const LABEL_CLASS = "text-xs font-medium text-text-secondary";

type PendingVerb = "park" | "unpark";

function toCandidate(run: FleetRunRow): ParkGateCandidate {
  const chrome = derivePilotRunChrome(run);
  const band = bandForRun(run);
  return {
    runId: run.runId,
    title: composePilotRunTitle(run, chrome),
    chrome,
    presetColor: run.agentPresetColor,
    band,
    agentState: run.agentState,
    statusLabel: bandLabel(band, run),
    contextLabel: directoryLabel(run.cwd),
  };
}

/**
 * Park one agent from outside Pilot — the session row and pane menus.
 *
 * The same note and release gate Pilot's editor offers, through the same
 * fields. Gates are drawn from the target's own workspace: the menu was opened
 * inside one project, and a release tied to another project's run is a Pilot
 * decision, where both are on screen.
 *
 * Everything is read live from the snapshot, so the target's title and the
 * candidate list keep moving underneath the form, and a target that leaves the
 * fleet closes the dialog — there is nothing left to park.
 */
export function ParkRunDialog({
  runId,
  onClose,
  restoreFocusTo,
}: {
  runId: string;
  onClose: () => void;
  /** Where focus goes when the dialog closes — the surface the menu opened on. */
  restoreFocusTo?: RestoreFocusTarget;
}) {
  const snapshot = useFleetSnapshotStore((s) => s.snapshot);
  const target = snapshot?.runs.find((run) => run.runId === runId) ?? null;
  const targetWorkspaceId = target?.workspaceId;

  // Captured once: a park that lands mid-edit must not rewrite the form.
  const [existingPark] = useState(() => target?.park);
  const [note, setNote] = useState(existingPark?.note ?? "");
  const [gateId, setGateId] = useState<string>(existingPark?.gateRunId ?? PARK_GATE_NONE);
  const [pending, setPending] = useState<PendingVerb | null>(null);
  const [error, setError] = useState<{ verb: PendingVerb; message: string } | null>(null);
  const busy = pending !== null;

  const ids = useId();
  const targetId = `${ids}-target`;
  const noteRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo<ParkGateCandidate[]>(() => {
    if (!snapshot || targetWorkspaceId === undefined) return [];
    return snapshot.runs
      .filter((run) => run.runId !== runId && run.workspaceId === targetWorkspaceId)
      .map(toCandidate);
  }, [snapshot, runId, targetWorkspaceId]);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  /** Doherty-gated: nearly every park is a local write that lands at once. */
  const showBusy = useDeferredLoading(busy, UI_DOHERTY_THRESHOLD);

  const targetGone = target === null;
  useEffect(() => {
    if (targetGone) onClose();
  }, [targetGone, onClose]);

  const submit = useCallback(
    (verb: PendingVerb, request: () => Promise<unknown>, fallback: string) => {
      if (busy) return;
      setPending(verb);
      setError(null);
      request()
        .then(() => onClose())
        .catch((cause: unknown) => {
          setPending(null);
          setError({ verb, message: formatErrorMessage(cause, fallback) });
        });
    },
    [busy, onClose]
  );

  const park = useCallback(() => {
    const trimmed = note.trim();
    const gateRunId = resolveParkGateId(gateId, candidates);
    submit(
      "park",
      () =>
        window.electron.fleet.parkRun(runId, {
          ...(trimmed.length > 0 ? { note: trimmed } : {}),
          ...(gateRunId !== null ? { gateRunId } : {}),
        }),
      "Couldn't park the agent"
    );
  }, [submit, note, gateId, candidates, runId]);

  const unpark = useCallback(() => {
    submit("unpark", () => window.electron.fleet.unparkRun(runId), "Couldn't unpark the agent");
  }, [submit, runId]);

  // Enter commits from the note and the gate list, as Pilot's editor does — a
  // native radio has no Enter action of its own.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing || event.repeat) return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const t = event.target;
      if (!(t instanceof HTMLInputElement) || (t.type !== "text" && t.type !== "radio")) return;
      event.preventDefault();
      park();
    },
    [park]
  );

  if (target === null) return null;

  const chrome = derivePilotRunChrome(target);
  const title = composePilotRunTitle(target, chrome);
  const isReparking = existingPark !== undefined;

  return (
    <AppDialog
      isOpen
      onClose={onClose}
      size="sm"
      // The note is where the form starts; the default would land on the
      // header's close button.
      initialFocus="none"
      restoreFocusTo={restoreFocusTo}
      dismissible={!busy}
    >
      <AppDialog.Header>
        <AppDialog.Title>{isReparking ? "Edit park" : "Park agent"}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div
          data-testid="park-run-dialog"
          className="flex flex-col gap-4"
          onKeyDown={handleKeyDown}
        >
          <div id={targetId} className="flex min-w-0 items-start gap-2.5">
            <TerminalIcon
              chrome={chrome}
              className="mt-0.5 h-4 w-4 shrink-0"
              brandColor={target.agentPresetColor ?? chrome.color}
            />
            <div className="min-w-0">
              <p
                data-testid="park-run-target"
                className="line-clamp-2 text-sm font-medium break-words text-balance text-text-primary"
              >
                {title}
              </p>
              <p className="truncate text-xs text-text-secondary">{chrome.label}</p>
            </div>
          </div>

          <RunParkFields
            note={note}
            onNoteChange={setNote}
            noteRef={noteRef}
            noteDescribedBy={targetId}
            gateId={gateId}
            onGateChange={setGateId}
            candidates={candidates}
            disabled={busy}
            labelClassName={LABEL_CLASS}
            testIdPrefix="park-run"
            gateGroupName={GATE_GROUP_NAME}
          />

          {error !== null && <InlineError role="alert">{error.message}</InlineError>}
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        leadingAction={
          isReparking
            ? {
                label: "Unpark",
                onClick: unpark,
                disabled: busy && pending !== "unpark",
                loading: showBusy && pending === "unpark",
              }
            : undefined
        }
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: busy }}
        primaryAction={{
          label: isReparking ? "Update park" : "Park",
          onClick: park,
          disabled: busy && pending !== "park",
          loading: showBusy && pending === "park",
        }}
      />
    </AppDialog>
  );
}
