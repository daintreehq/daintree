import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { KBD_BARE_CLASS } from "@/components/ui/Kbd";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
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

/** Where "this is taking a while" stops being noise and starts being news. */
const PARK_STILL_WORKING_MS = 5_000;

/** Specs select the group by name, so it is fixed rather than `useId`-derived. */
const GATE_GROUP_NAME = "pilot-park-gate";

type PendingVerb = "park" | "unpark";

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
 * The gate list is native radios, the house pattern for a keyboard-driven
 * single choice (`RadioChoice`): arrows move focus and selection together and
 * wrap, the group is one tab stop, and the checked dot is painted by the user
 * agent — which is the one selection mark that survives `forced-colors`. The
 * row fill it used to rely on alone measured about 1.04:1 against the list.
 */
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
function gateHelpText(gate: PilotGateCandidate | null, hasNote: boolean): string {
  if (gate === null) return "Stays parked until you unpark it";
  const withNote = hasNote ? " with your note" : "";
  return gate.row.run.agentState === "exited"
    ? `Returns to Waiting${withNote} if ${gate.row.title} runs again and finishes`
    : `Returns to Waiting${withNote} when ${gate.row.title} next finishes working`;
}

export function PilotParkEditor({
  target,
  candidates,
  onClose,
  footerSlot,
}: {
  target: PilotParkTarget;
  candidates: PilotGateCandidate[];
  /** `changed` is true when a park was created, replaced or lifted. */
  onClose: (changed: boolean) => void;
  /**
   * Where the action bar renders: the dialog's footer, outside the body's
   * scroller. Inside it, a 60vh body on a short window scrolled Park itself
   * out of view and faded it under the "more below" cue. Portalled, so the
   * buttons still sit in this component's React tree — Enter handling and the
   * `data-no-submit` opt-outs reach them unchanged.
   */
  footerSlot: HTMLElement | null;
}) {
  const [note, setNote] = useState(target.existingPark?.note ?? "");
  const [gateId, setGateId] = useState<string>(target.existingPark?.gateRunId ?? GATE_NONE);
  const [pending, setPending] = useState<PendingVerb | null>(null);
  /** The failure, with the verb it belongs to so the alert describes that button. */
  const [error, setError] = useState<{ verb: PendingVerb; message: string } | null>(null);
  /** Set when the chosen gate's run closed under the editor and the park fell back to manual. */
  const [gateLost, setGateLost] = useState(false);
  const busy = pending !== null;

  const ids = useId();
  const noteId = `${ids}-note`;
  const gateLabelId = `${ids}-gate-label`;
  const gateHelpId = `${ids}-gate-help`;
  const errorId = `${ids}-error`;
  const targetId = `${ids}-target`;

  /**
   * Submitting disables the whole form, and a disabled form with no other sign
   * of life is indistinguishable from a broken one.
   *
   * Doherty-gated, so a park that lands in 80ms — which is nearly all of them,
   * the write being a local record — flashes nothing on the way. Past the gate
   * the button that was pressed says it is working; past five seconds a polite
   * status says so in words, for the case where the pty host is the thing not
   * answering.
   *
   * The form's values stay on screen throughout. A note the user typed is the
   * one thing here that cannot be recovered by trying again.
   */
  const showBusy = useDeferredLoading(busy, UI_DOHERTY_THRESHOLD);
  const showStillWorking = useDeferredLoading(busy, PARK_STILL_WORKING_MS);

  const rootRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const gateRefs = useRef(new Map<string, HTMLInputElement | null>());
  /**
   * Disabling the form blurs whatever held focus, so a rejected submit would
   * otherwise leave the keyboard on `document.body` — outside the dialog's
   * own key handling, with nothing to Tab back into.
   */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // A gate that stopped existing (its run closed while the editor was open)
  // degrades to "no gate" rather than submitting an id the handler will
  // reject — and says so, because that silently changes what will unpark it.
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
      setGateLost(true);
      // The removed radio took focus with it if it held it.
      const focus = document.activeElement;
      if (!rootRef.current?.contains(focus) && !footerSlot?.contains(focus)) {
        gateRefs.current.get(GATE_NONE)?.focus();
      }
    }
  }, [gateId, candidates, footerSlot]);
  /**
   * What the radiogroup RENDERS from, never the raw state: the sync effect
   * above lands one commit late, and a frame whose checked id points at a
   * removed option is a radiogroup with no checked radio and no tab stop.
   */
  const effectiveGateId = gateOptions.some((option) => option.id === gateId) ? gateId : GATE_NONE;
  const chosenGate = gateOptions.find((option) => option.id === effectiveGateId)?.candidate ?? null;

  // An existing park's gate can sit below the list's fold; the choice being
  // edited has to be on screen when the editor opens. Mount only — later
  // selection changes move focus, which scrolls natively.
  const openingGateRef = useRef(effectiveGateId);
  useEffect(() => {
    gateRefs.current
      .get(openingGateRef.current)
      ?.closest("label")
      ?.scrollIntoView?.({ block: "nearest" });
  }, []);

  useEffect(() => {
    if (pending !== null) return;
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus();
  }, [pending]);

  const run = useCallback(
    (verb: PendingVerb, request: () => Promise<unknown>, fallback: string) => {
      if (busy) return;
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPending(verb);
      setError(null);
      request()
        .then(() => onClose(true))
        .catch((cause: unknown) => {
          setPending(null);
          setError({ verb, message: formatErrorMessage(cause, fallback) });
        });
    },
    [busy, onClose]
  );

  const confirm = useCallback(() => {
    const trimmed = note.trim();
    run(
      "park",
      () =>
        window.electron.fleet.parkRun(target.row.run.runId, {
          ...(trimmed.length > 0 ? { note: trimmed } : {}),
          ...(effectiveGateId !== GATE_NONE ? { gateRunId: effectiveGateId } : {}),
        }),
      "Couldn't park the run"
    );
  }, [run, note, effectiveGateId, target.row.run.runId]);

  const unpark = useCallback(() => {
    run(
      "unpark",
      () => window.electron.fleet.unparkRun(target.row.run.runId),
      "Couldn't unpark the run"
    );
  }, [run, target.row.run.runId]);

  /**
   * Enter commits from the note input and the gate list — a native radio has
   * no Enter action of its own, so there is nothing to collide with. Buttons
   * that mean something else (Cancel, Unpark) opt out via the data attribute
   * so one keypress never fires two verbs.
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

  const selectGate = useCallback((id: string) => {
    setGateId(id);
    setGateLost(false);
  }, []);

  /**
   * Native radios already own the arrows. Home and End are added on top, and
   * every navigation key stops here so the palette body's own list handling
   * never sees a key the group consumed.
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

  const isReparking = target.existingPark !== undefined;
  const primaryLabel = isReparking ? "Update park" : "Park";

  return (
    <div
      ref={rootRef}
      data-testid="pilot-park-editor"
      // The body scroller pads by 8px; 4 more puts the form on the same 12px
      // column as the dialog's header label and the footer's Park button.
      className="flex flex-col gap-4 px-1 py-2"
      onKeyDown={handleKeyDown}
    >
      <div id={targetId} className="flex min-w-0 items-start gap-2.5">
        <TerminalIcon
          chrome={target.row.chrome}
          className="mt-0.5 h-4 w-4 shrink-0"
          brandColor={target.row.presetColor ?? target.row.chrome.color}
        />
        <div className="min-w-0">
          {/* Wraps rather than truncates: this is the one place the whole
              title can be read before committing to parking it. */}
          <p
            data-testid="pilot-park-target"
            className="line-clamp-2 text-sm font-medium break-words text-pretty text-text-primary"
          >
            {target.row.title}
          </p>
          <p className="truncate text-xs text-text-secondary">
            {target.row.chrome.label} · {target.group.name}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className={PALETTE_SECTION_LABEL_CLASS}>
          Note (optional)
        </label>
        <Input
          id={noteId}
          ref={noteRef}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={MAX_PARK_NOTE_LENGTH}
          disabled={busy}
          placeholder="Why is this parked?"
          data-testid="pilot-park-note"
          // Focus lands here first, so this is where a screen reader learns
          // which run the form is about.
          aria-describedby={targetId}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={gateLabelId} className={PALETTE_SECTION_LABEL_CLASS}>
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
            data-testid="pilot-park-gates"
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
                    busy ? "cursor-not-allowed" : "cursor-pointer",
                    "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                    checked
                      ? "bg-overlay-raised text-text-primary"
                      : "text-text-secondary hover:bg-overlay-soft hover:text-text-primary"
                  )}
                >
                  <input
                    type="radio"
                    name={GATE_GROUP_NAME}
                    value={id}
                    checked={checked}
                    onChange={() => selectGate(id)}
                    disabled={busy}
                    ref={(el) => {
                      gateRefs.current.set(id, el);
                    }}
                    data-testid={candidate === null ? "pilot-park-gate-none" : undefined}
                    // The glyph and brand icon are decoration, so the radio
                    // spells its whole identity out: two same-titled runs on
                    // different agents or in different states must not be one
                    // string to a screen reader.
                    {...(candidate !== null
                      ? {
                          "aria-label": `${candidate.row.title}, ${candidate.row.chrome.label}, ${candidate.row.statusLabel}, ${candidate.group.name}`,
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
                        <PilotRunState
                          band={candidate.row.band}
                          agentState={candidate.row.run.agentState}
                        />
                      </span>
                      <TerminalIcon
                        chrome={candidate.row.chrome}
                        className="h-4 w-4 shrink-0"
                        brandColor={candidate.row.presetColor ?? candidate.row.chrome.color}
                      />
                      <span className="min-w-0 flex-1 truncate">{candidate.row.title}</span>
                      <span className="shrink-0 text-xs text-text-secondary">
                        {candidate.group.name}
                      </span>
                    </>
                  )}
                </label>
              );
            })}
          </div>
        </ScrollShadow>
        {/* Describes the CURRENT choice, so the default never reads as if
            something will lift the park automatically. */}
        <p id={gateHelpId} className="text-xs leading-snug text-pretty text-text-secondary">
          {gateHelpText(chosenGate, note.trim().length > 0)}
        </p>
        {gateLost && (
          <p
            role="status"
            data-testid="pilot-park-gate-lost"
            className="text-xs text-text-secondary"
          >
            The gate run closed, so this run now stays parked until you unpark it
          </p>
        )}
      </div>

      {error !== null && (
        <p id={errorId} role="alert" className="text-xs text-status-danger">
          {error.message}
        </p>
      )}

      {showStillWorking && error === null && (
        <p role="status" data-testid="pilot-park-slow" className="text-xs text-text-secondary">
          Still working…
        </p>
      )}

      {footerSlot !== null &&
        createPortal(
          <div className="flex w-full items-center gap-2">
            <Button
              variant="contrast"
              size="sm"
              onClick={confirm}
              disabled={busy && pending !== "park"}
              loading={showBusy && pending === "park"}
              aria-describedby={error?.verb === "park" ? errorId : undefined}
              data-testid="pilot-park-confirm"
            >
              {primaryLabel}
              {/* Inherits the button's own ink rather than taking a chip: a
              boxed keycap on the inverse fill reads as a second control. */}
              <kbd aria-hidden="true" className={cn(KBD_BARE_CLASS, "text-current")}>
                ↵
              </kbd>
            </Button>
            {isReparking && (
              <Button
                variant="subtle"
                size="sm"
                onClick={unpark}
                disabled={busy && pending !== "unpark"}
                loading={showBusy && pending === "unpark"}
                data-no-submit
                aria-describedby={error?.verb === "unpark" ? errorId : undefined}
                data-testid="pilot-park-unpark"
              >
                Unpark
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onClose(false)}
              disabled={busy}
              data-no-submit
              data-testid="pilot-park-cancel"
              className="ml-auto"
            >
              Cancel
              <kbd aria-hidden="true" className={KBD_BARE_CLASS}>
                esc
              </kbd>
            </Button>
          </div>,
          footerSlot
        )}
    </div>
  );
}
