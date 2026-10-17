import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, Ref } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import type { FleetBand } from "@/lib/fleetAttention";
import type { AgentState } from "@shared/types/agent";
import { MAX_PARK_NOTE_LENGTH } from "@shared/types/ipc/fleet";

/**
 * A run another run's park can gate on, carried with enough of its identity
 * (title, where it lives, state) for the picker to name it the way the run's
 * own rows do. Surface-neutral: Pilot and the sidebar's park dialog each map
 * their own rows onto it.
 */
export interface ParkGateCandidate {
  runId: string;
  title: string;
  chrome: TerminalChromeDescriptor;
  presetColor: string | undefined;
  band: FleetBand;
  agentState: AgentState | undefined;
  /** The state in words, for the radio's accessible name. */
  statusLabel: string;
  /** Where the run lives — project or worktree — drawn trailing and read last. */
  contextLabel: string | null;
}

export const PARK_GATE_NONE = "__none__";

/**
 * The gate a submit should carry: the chosen one while it is still a
 * candidate, otherwise none. A gate whose run closed under the form must never
 * be sent — the handler rejects an id it can't see.
 */
export function resolveParkGateId(
  gateId: string,
  candidates: readonly ParkGateCandidate[]
): string | null {
  if (gateId === PARK_GATE_NONE) return null;
  return candidates.some((c) => c.runId === gateId) ? gateId : null;
}

/**
 * What will lift the park, for the choice as it stands — never gated parks in
 * general, so the default cannot read as if something releases it by itself.
 *
 * An exited run is a legal gate (a restart keeps its terminal id, and the
 * release waits for the next busy-to-ready edge), but its release is
 * conditional on it running again, so the copy says "if" rather than "when".
 * One clause either way: a two-sentence helper under a list reads as a
 * warning, which this is not.
 */
function gateHelpText(gate: ParkGateCandidate | null, hasNote: boolean): string {
  if (gate === null) return "Stays parked until you unpark it";
  const withNote = hasNote ? " with your note" : "";
  return gate.agentState === "exited"
    ? `Returns to Waiting${withNote} if ${gate.title} runs again and finishes`
    : `Returns to Waiting${withNote} when ${gate.title} next finishes working`;
}

/**
 * The park form's two fields: one note, one optional release gate.
 *
 * Owns neither the request nor the verbs — each surface hosts these in its own
 * chrome (Pilot's footer key hints, a dialog's footer) and submits through the
 * same IPC.
 *
 * The gate list is native radios, the house pattern for a keyboard-driven
 * single choice (`RadioChoice`): arrows move focus and selection together and
 * wrap, the group is one tab stop, and the checked dot is painted by the user
 * agent — which is the one selection mark that survives `forced-colors`. The
 * row fill it used to rely on alone measured about 1.04:1 against the list.
 */
export function RunParkFields({
  note,
  onNoteChange,
  noteRef,
  noteDescribedBy,
  gateId,
  onGateChange,
  candidates,
  disabled,
  labelClassName,
  testIdPrefix,
  gateGroupName,
}: {
  note: string;
  onNoteChange: (note: string) => void;
  noteRef?: Ref<HTMLInputElement>;
  /** Names the run the form is about, since focus lands on the note first. */
  noteDescribedBy?: string;
  gateId: string;
  onGateChange: (gateId: string) => void;
  candidates: readonly ParkGateCandidate[];
  disabled: boolean;
  labelClassName: string;
  testIdPrefix: string;
  /** Specs select the group by name, so it is fixed per surface rather than `useId`-derived. */
  gateGroupName: string;
}) {
  /** Set when the chosen gate's run closed under the form and the park fell back to manual. */
  const [gateLost, setGateLost] = useState(false);

  const ids = useId();
  const noteId = `${ids}-note`;
  const gateLabelId = `${ids}-gate-label`;
  const gateHelpId = `${ids}-gate-help`;

  const gateRefs = useRef(new Map<string, HTMLInputElement | null>());

  const gateOptions = useMemo<Array<{ id: string; candidate: ParkGateCandidate | null }>>(
    () => [
      { id: PARK_GATE_NONE, candidate: null },
      ...candidates.map((candidate) => ({ id: candidate.runId, candidate })),
    ],
    [candidates]
  );

  // A gate that stopped existing (its run closed while the form was open)
  // degrades to "no gate" rather than submitting an id the handler will
  // reject — and says so, because that silently changes what will unpark it.
  useEffect(() => {
    if (gateId !== PARK_GATE_NONE && !candidates.some((c) => c.runId === gateId)) {
      onGateChange(PARK_GATE_NONE);
      setGateLost(true);
      // The removed radio took focus with it if it held it.
      const focus = document.activeElement;
      if (focus === null || focus === document.body) {
        gateRefs.current.get(PARK_GATE_NONE)?.focus();
      }
    }
  }, [gateId, candidates, onGateChange]);

  /**
   * What the radiogroup RENDERS from, never the raw state: the sync effect
   * above lands one commit late, and a frame whose checked id points at a
   * removed option is a radiogroup with no checked radio and no tab stop.
   */
  const effectiveGateId = resolveParkGateId(gateId, candidates) ?? PARK_GATE_NONE;
  const chosenGate = gateOptions.find((option) => option.id === effectiveGateId)?.candidate ?? null;

  // An existing park's gate can sit below the list's fold; the choice being
  // edited has to be on screen when the form opens. Mount only — later
  // selection changes move focus, which scrolls natively.
  const openingGateRef = useRef(effectiveGateId);
  useEffect(() => {
    gateRefs.current
      .get(openingGateRef.current)
      ?.closest("label")
      ?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const selectGate = useCallback(
    (id: string) => {
      onGateChange(id);
      setGateLost(false);
    },
    [onGateChange]
  );

  /**
   * Native radios already own the arrows. Home and End are added on top, and
   * every navigation key stops here so a host list's own key handling never
   * sees a key the group consumed.
   */
  const handleGateKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      let to: string | undefined;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
        case "ArrowLeft":
        case "ArrowRight":
          event.stopPropagation();
          return;
        case "Home":
          to = gateOptions[0]?.id;
          break;
        case "End":
          to = gateOptions[gateOptions.length - 1]?.id;
          break;
        default:
          return;
      }
      if (to === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      selectGate(to);
      gateRefs.current.get(to)?.focus();
    },
    [gateOptions, selectGate]
  );

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className={labelClassName}>
          Note (optional)
        </label>
        <Input
          id={noteId}
          ref={noteRef}
          type="text"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          maxLength={MAX_PARK_NOTE_LENGTH}
          disabled={disabled}
          placeholder="Why is this parked?"
          data-testid={`${testIdPrefix}-note`}
          aria-describedby={noteDescribedBy}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={gateLabelId} className={labelClassName}>
          Park until
        </span>
        <ScrollShadow
          compact
          className="max-h-56 rounded-[var(--radius-md)] border border-border-default"
        >
          <div
            role="radiogroup"
            aria-labelledby={gateLabelId}
            aria-describedby={gateHelpId}
            data-testid={`${testIdPrefix}-gates`}
            onKeyDown={handleGateKeyDown}
            // Right inset clears the overlay scrollbar, which otherwise sits on
            // the focused row's ring.
            className="flex flex-col gap-px p-1 pr-2"
          >
            {gateOptions.map(({ id, candidate }) => {
              const checked = id === effectiveGateId;
              return (
                <label
                  key={id}
                  className={cn(
                    "flex min-h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm transition-colors",
                    disabled ? "cursor-not-allowed" : "cursor-pointer",
                    "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                    checked
                      ? "bg-overlay-raised text-text-primary"
                      : "text-text-secondary hover:bg-overlay-soft hover:text-text-primary"
                  )}
                >
                  <input
                    type="radio"
                    name={gateGroupName}
                    value={id}
                    checked={checked}
                    onChange={() => selectGate(id)}
                    disabled={disabled}
                    ref={(el) => {
                      gateRefs.current.set(id, el);
                    }}
                    data-testid={candidate === null ? `${testIdPrefix}-gate-none` : undefined}
                    // The glyph and brand icon are decoration, so the radio
                    // spells its whole identity out: two same-titled runs on
                    // different agents or in different states must not be one
                    // string to a screen reader.
                    {...(candidate !== null
                      ? {
                          "aria-label": [
                            candidate.title,
                            candidate.chrome.label,
                            candidate.statusLabel,
                            candidate.contextLabel,
                          ]
                            .filter((part): part is string => part !== null && part !== "")
                            .join(", "),
                        }
                      : {})}
                    // The row carries the visible ring; the control's own is
                    // neutralised with a transparent outline (see RadioChoice),
                    // which forced-colors repaints to a system ring.
                    className="shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-transparent"
                  />
                  {candidate === null ? (
                    <span className="min-w-0 flex-1 truncate">{"I'll unpark it myself"}</span>
                  ) : (
                    <>
                      <span
                        aria-hidden="true"
                        className="flex size-3.5 shrink-0 items-center justify-center"
                      >
                        <PilotRunState band={candidate.band} agentState={candidate.agentState} />
                      </span>
                      <TerminalIcon
                        chrome={candidate.chrome}
                        className="h-4 w-4 shrink-0"
                        brandColor={candidate.presetColor ?? candidate.chrome.color}
                      />
                      <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                      {candidate.contextLabel !== null && (
                        <span className="shrink-0 text-xs text-text-secondary">
                          {candidate.contextLabel}
                        </span>
                      )}
                    </>
                  )}
                </label>
              );
            })}
          </div>
        </ScrollShadow>
        {/* Describes the CURRENT choice, so the default never reads as if
            something will lift the park automatically. */}
        <p id={gateHelpId} className="text-xs leading-snug text-text-secondary">
          {gateHelpText(chosenGate, note.trim().length > 0)}
        </p>
        {gateLost && (
          <p
            role="status"
            data-testid={`${testIdPrefix}-gate-lost`}
            className="text-xs text-text-secondary"
          >
            The gate run closed, so this run now stays parked until you unpark it
          </p>
        )}
      </div>
    </>
  );
}
