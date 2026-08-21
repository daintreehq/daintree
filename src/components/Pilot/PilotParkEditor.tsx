import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { cn } from "@/lib/utils";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "./PilotRunState";
import type { PilotProjectGroup, PilotRow } from "./pilotRows";
import { MAX_PARK_NOTE_LENGTH, type RunParkRecord } from "@shared/types/ipc/fleet";

/**
 * A run another run's park can gate on, carried with enough of its identity
 * (title, workspace, state) for the picker to name it the way Pilot's own
 * rows do.
 */
export interface PilotGateCandidate {
  row: PilotRow;
  group: PilotProjectGroup;
}

export interface PilotParkTarget {
  row: PilotRow;
  group: PilotProjectGroup;
  existingPark: RunParkRecord | undefined;
}

const GATE_NONE = "__none__";

function gateOptionDomId(runId: string): string {
  return `pilot-park-gate-${runId}`;
}

/**
 * The in-palette parking form: one note, one optional gate, two keys.
 *
 * Deliberately a mode of the Pilot dialog rather than a second dialog — the
 * user is already inside a keyboard surface, and stacking a modal on a modal
 * would re-teach focus, Escape and dismissal semantics for one input and a
 * list. Escape pops back to the list because PilotView delegates the DIALOG's
 * own onClose here while the editor is open — the palette's Escape handling
 * runs at a document-level backstop that fires before any inner listener, so
 * intercepting the key locally can never win; redirecting what "close" means
 * can. Enter commits from anywhere except the buttons that mean something
 * else.
 *
 * The gate list is a radiogroup, not a combobox: the candidates are few, the
 * choice is single, and selection-follows-focus is the pattern the filter bar
 * directly above it already taught.
 */
export function PilotParkEditor({
  target,
  candidates,
  onClose,
}: {
  target: PilotParkTarget;
  candidates: PilotGateCandidate[];
  /** `changed` is true when a park was created, replaced or lifted. */
  onClose: (changed: boolean) => void;
}) {
  const [note, setNote] = useState(target.existingPark?.note ?? "");
  const [gateId, setGateId] = useState<string>(target.existingPark?.gateRunId ?? GATE_NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteRef = useRef<HTMLInputElement>(null);
  const gateRefs = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // A gate that stopped existing (its run closed while the editor was open)
  // silently degrades to "no gate" rather than submitting an id the handler
  // will reject.
  const gateOptions = useMemo<Array<{ id: string; candidate: PilotGateCandidate | null }>>(
    () => [
      { id: GATE_NONE, candidate: null },
      ...candidates.map((candidate) => ({ id: candidate.row.run.runId, candidate })),
    ],
    [candidates]
  );
  useEffect(() => {
    if (gateId !== GATE_NONE && !candidates.some((c) => c.row.run.runId === gateId)) {
      setGateId(GATE_NONE);
    }
  }, [gateId, candidates]);
  /**
   * What the radiogroup RENDERS from, never the raw state: the sync effect
   * above lands one commit late, and a frame whose checked id points at a
   * removed option is a radiogroup with no checked radio and no tab stop —
   * focus falls out of the form if that radio held it.
   */
  const effectiveGateId = gateOptions.some((option) => option.id === gateId) ? gateId : GATE_NONE;

  const confirm = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const trimmed = note.trim();
    window.electron.fleet
      .parkRun(target.row.run.runId, {
        ...(trimmed.length > 0 ? { note: trimmed } : {}),
        ...(effectiveGateId !== GATE_NONE ? { gateRunId: effectiveGateId } : {}),
      })
      .then(() => onClose(true))
      .catch((cause: unknown) => {
        setBusy(false);
        setError(formatErrorMessage(cause, "Couldn't park the run"));
      });
  }, [busy, note, effectiveGateId, target.row.run.runId, onClose]);

  const unpark = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    window.electron.fleet
      .unparkRun(target.row.run.runId)
      .then(() => onClose(true))
      .catch((cause: unknown) => {
        setBusy(false);
        setError(formatErrorMessage(cause, "Couldn't unpark the run"));
      });
  }, [busy, target.row.run.runId, onClose]);

  /**
   * Enter commits from the note input and the gate list. Buttons that mean
   * something else (Cancel, Unpark, and each gate radio, whose Enter already
   * selects it natively) opt out via the data attribute so one keypress never
   * fires two verbs.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      // Unmodified, non-repeat Enter only: the Alt+Enter chord that OPENED
      // the editor can key-repeat straight into the autofocused note input,
      // and a submit fired by the opening gesture would park with an
      // untouched form.
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat) return;
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest("[data-no-submit]") !== null) return;
      event.preventDefault();
      confirm();
    },
    [confirm]
  );

  const moveGate = useCallback((to: string) => {
    setGateId(to);
    gateRefs.current.get(to)?.focus();
  }, []);

  const handleGateKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = gateOptions.findIndex((option) => option.id === effectiveGateId);
      if (index === -1) return;

      let next: string | undefined;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowRight":
          next = gateOptions[(index + 1) % gateOptions.length]?.id;
          break;
        case "ArrowUp":
        case "ArrowLeft":
          next = gateOptions[(index - 1 + gateOptions.length) % gateOptions.length]?.id;
          break;
        case "Home":
          next = gateOptions[0]?.id;
          break;
        case "End":
          next = gateOptions[gateOptions.length - 1]?.id;
          break;
        default:
          return;
      }
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      moveGate(next);
    },
    [gateOptions, effectiveGateId, moveGate]
  );

  const isReparking = target.existingPark !== undefined;

  return (
    <div
      data-testid="pilot-park-editor"
      className="flex flex-col gap-3 px-3 py-2"
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <TerminalIcon
          chrome={target.row.chrome}
          className="h-4 w-4 shrink-0"
          brandColor={target.row.presetColor ?? target.row.chrome.color}
          userChosen={target.row.presetColor !== undefined}
        />
        <span className="min-w-0 truncate text-sm text-daintree-text">{target.row.title}</span>
        <span className="shrink-0 text-xs text-daintree-text/40">{target.group.name}</span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-medium tracking-wide text-daintree-text/50 uppercase">
          Note
        </span>
        <input
          ref={noteRef}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={MAX_PARK_NOTE_LENGTH}
          disabled={busy}
          placeholder="Why is this parked? (optional)"
          data-testid="pilot-park-note"
          className={cn(
            "w-full rounded-[var(--radius-sm)] border border-border-default bg-transparent px-2 py-1.5",
            "text-sm text-daintree-text placeholder:text-daintree-text/35"
          )}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span
          id="pilot-park-gate-label"
          className="text-[10px] font-medium tracking-wide text-daintree-text/50 uppercase"
        >
          Park until
        </span>
        <div
          role="radiogroup"
          aria-labelledby="pilot-park-gate-label"
          aria-orientation="vertical"
          data-testid="pilot-park-gates"
          onKeyDown={handleGateKeyDown}
          className="flex max-h-56 flex-col overflow-y-auto rounded-[var(--radius-sm)] border border-border-default"
        >
          {gateOptions.map(({ id, candidate }) => {
            const isActive = id === effectiveGateId;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                disabled={busy}
                // The glyph and brand icon are aria-hidden decoration, so the
                // radio spells its whole identity out: two same-titled runs on
                // different agents or in different states must not be one
                // string to a screen reader.
                {...(candidate !== null
                  ? {
                      "aria-label": `${candidate.row.title}, ${candidate.row.chrome.label}, ${candidate.row.statusLabel}, ${candidate.group.name}`,
                    }
                  : {})}
                data-no-submit
                id={gateOptionDomId(id)}
                ref={(el) => {
                  gateRefs.current.set(id, el);
                }}
                onClick={() => setGateId(id)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent",
                  isActive
                    ? "bg-overlay-subtle text-daintree-text"
                    : "text-daintree-text/70 hover:bg-tint/[0.04]"
                )}
              >
                {candidate === null ? (
                  <span className="text-daintree-text/70">I unpark it myself</span>
                ) : (
                  <>
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <PilotRunState
                        band={candidate.row.band}
                        agentState={candidate.row.run.agentState}
                      />
                    </span>
                    <TerminalIcon
                      chrome={candidate.row.chrome}
                      className="h-4 w-4 shrink-0"
                      brandColor={candidate.row.presetColor ?? candidate.row.chrome.color}
                      userChosen={candidate.row.presetColor !== undefined}
                    />
                    <span className="min-w-0 flex-1 truncate">{candidate.row.title}</span>
                    <span className="shrink-0 text-xs text-daintree-text/40">
                      {candidate.group.name}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-snug text-daintree-text/40">
          Gated parks lift when that agent next finishes working — the run pops back into Waiting
          with your note.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-status-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          data-testid="pilot-park-confirm"
          className={cn(
            "rounded-[var(--radius-sm)] bg-overlay-subtle px-3 py-1 text-sm text-daintree-text transition-colors",
            "hover:bg-tint/[0.08] disabled:opacity-50",
            "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
          )}
        >
          {isReparking ? "Update park" : "Park"}
        </button>
        {isReparking && (
          <button
            type="button"
            onClick={unpark}
            disabled={busy}
            data-no-submit
            data-testid="pilot-park-unpark"
            className={cn(
              "rounded-[var(--radius-sm)] px-3 py-1 text-sm text-daintree-text/70 transition-colors",
              "hover:bg-overlay-subtle hover:text-daintree-text disabled:opacity-50",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
            )}
          >
            Unpark
          </button>
        )}
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={busy}
          data-no-submit
          data-testid="pilot-park-cancel"
          className={cn(
            "ml-auto rounded-[var(--radius-sm)] px-3 py-1 text-sm text-daintree-text/50 transition-colors",
            "hover:bg-overlay-subtle hover:text-daintree-text disabled:opacity-50",
            "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
