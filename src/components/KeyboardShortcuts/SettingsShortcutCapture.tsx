import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import { InlineError } from "@/components/ui/field";
import { AlertTriangle } from "lucide-react";
import { isMac } from "@/lib/platform";
import {
  CHORD_TIMEOUT_MS,
  combosFieldsEqual,
  keybindingService,
  normalizeKeyForBinding,
  type KeyScope,
} from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { logError, logWarn } from "@/utils/logger";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { buildShortcutRows, findShortcutRow, type ShortcutRowWidening } from "./shortcutRows";

const CHORD_WINDOW_STYLE: React.CSSProperties & Record<"--chord-window", string> = {
  "--chord-window": `${CHORD_TIMEOUT_MS}ms`,
};

export interface SettingsShortcutCaptureProps {
  /** Called when user saves the captured key combination */
  onCapture: (combo: string) => void;
  /** Called when user cancels recording */
  onCancel: () => void;
  /** Action ID to exclude from conflict detection */
  excludeActionId: string;
  /**
   * Scope of the binding being edited. Used to filter conflict detection so
   * scope-disjoint bindings (e.g. Cmd+W in portal vs worktreeGrid) don't
   * false-flag. Defaults to "global" (the conservative behavior — flags any
   * overlap).
   */
  scope?: KeyScope;
  /**
   * Optional validator for the captured combo. Receives the full captured
   * combo string (e.g. "Cmd+Alt+K") and returns an error message to display
   * inline, or null when the combo is acceptable. When non-null, the Save
   * button is disabled. Use to enforce domain rules like "agent shortcuts
   * must use Cmd+Alt+letter" without baking domain copy into this widget.
   */
  validateCombo?: (combo: string) => React.ReactNode | null;
  /**
   * Compact rendering for inline contexts like dropdowns. Drops the outer
   * card chrome, tightens spacing, shrinks action buttons, and auto-starts
   * recording on mount (since the user has already expressed intent by
   * opening the capture). The Settings-page default keeps the full card.
   */
  compact?: boolean;
  /**
   * Start recording on mount. Defaults to `compact`; the settings list passes it
   * too, because its Edit click is already the intent to record.
   */
  autoStart?: boolean;
  /**
   * The binding in force now, shown above the recorder so the user can see what
   * they are replacing. `""` means the action is unbound (and hides Remove);
   * leave it undefined where there is no single current binding to show.
   */
  currentCombo?: string;
  /**
   * Finish on the first non-modifier key instead of waiting out the chord window,
   * for bindings that cannot be chords, where the wait only delays the result and
   * any quick second key would be recorded as a second step.
   */
  singleStroke?: boolean;
  /**
   * What the armed field asks for, in place of "Press a key combination". A binding
   * with a required shape says so here, before the first attempt rather than only
   * in the rejection after it.
   */
  recordingHint?: React.ReactNode;
  /**
   * What the armed field says while modifiers are down, given those modifiers in
   * combo order ("Cmd", "Alt"…). Lets a constrained binding keep teaching its shape
   * (release the extra one, add the missing one) instead of a generic "press a key".
   */
  heldHint?: (held: string[]) => React.ReactNode;
  /**
   * Keep Save disabled while the combo is still bound to another action. Two
   * bindings of equal priority on one combo leave one of them silently dead, so a
   * caller that cannot tolerate that asks for Unbind first.
   */
  blockConflicts?: boolean;
  /**
   * Ids of text outside the recorder that says what a save or removal does (the
   * settings row's description), read with the recorder, Save and Remove.
   */
  describedBy?: string;
}

const MODIFIER_KEYS = ["Meta", "Control", "Alt", "Shift"];

/** The modifiers an event reports as down, in the same order a captured combo uses. */
function heldModifiers(e: KeyboardEvent, mac: boolean): string[] {
  const parts: string[] = [];
  if (mac && e.metaKey) parts.push("Cmd");
  // Control is its own modifier on macOS; elsewhere it is the primary one.
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (!mac && e.ctrlKey) parts.push("Cmd");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  return parts;
}

function sameChord(a: string, b: string): boolean {
  const as = a.trim().split(/\s+/);
  const bs = b.trim().split(/\s+/);
  return as.length === bs.length && as.every((step, i) => combosFieldsEqual(step, bs[i]!));
}

export function SettingsShortcutCapture({
  onCapture,
  onCancel,
  excludeActionId,
  scope = "global",
  validateCombo,
  compact = false,
  autoStart = compact,
  currentCombo,
  singleStroke = false,
  recordingHint,
  heldHint,
  blockConflicts = false,
  describedBy: outsideDescribedBy,
}: SettingsShortcutCaptureProps) {
  // A consumer that mounts this in response to an explicit click (the compact
  // tray, the settings list's Edit) has no reason to ask for a second "Click to
  // record" press. Seeding `recording` from `autoStart` arms capture on mount
  // without an effect.
  const [recording, setRecording] = useState(autoStart);
  const [capturedCombos, setCapturedCombos] = useState<string[]>([]);
  const [chordStep, setChordStep] = useState<"first" | "waiting" | "complete">("first");
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chordTokenRef = useRef(0);
  // Steps captured in this recording that are still waiting for a second key, read
  // by the window listener, which never sees state newer than its own render.
  const pendingStepsRef = useRef<string[]>([]);
  const [conflictRefreshKey, setConflictRefreshKey] = useState(0);
  const [isUnbinding, setIsUnbinding] = useState(false);
  // Modifiers down right now, so the field shows the recorder hearing ⌘⌥ before
  // the letter lands.
  const [held, setHeld] = useState<string[]>([]);
  // A combo the validator refused. The recorder stays armed with it on show, so the
  // next press is the retry, with no separate step to start recording again.
  const [rejected, setRejected] = useState<string | null>(null);
  // Bumped when a transition removes the focused control without changing whether
  // the draft can be saved (a restored draft, an Unbind that leaves another
  // conflict), so the focus effect below still runs.
  const [focusRequest, setFocusRequest] = useState(0);
  const saveRef = useRef<HTMLButtonElement>(null);
  const recordAgainRef = useRef<HTMLButtonElement>(null);
  const unbindRef = useRef<HTMLButtonElement>(null);
  const idleRef = useRef<HTMLButtonElement>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  // What was captured before "Record again", so Escape can put it back rather
  // than throwing away a combo the user already had.
  const previousDraftRef = useRef<string[]>([]);
  const validationId = useId();
  const conflictsId = useId();

  const capturedCombo = capturedCombos.length > 0 ? capturedCombos.join(" ") : null;

  const validationError = useMemo(() => {
    const combo = rejected ?? capturedCombo;
    if (!combo || !validateCombo) return null;
    return validateCombo(combo);
  }, [rejected, capturedCombo, validateCombo]);

  const conflicts = useMemo(() => {
    // conflictRefreshKey forces the memo to re-evaluate after a successful
    // Unbind so the dismissed conflict row disappears immediately. Without it,
    // the memoized result persists against the unchanged capturedCombo.
    void conflictRefreshKey;
    if (!capturedCombo) return [];
    return keybindingService.findConflicts(capturedCombo, excludeActionId, scope);
  }, [capturedCombo, excludeActionId, scope, conflictRefreshKey]);

  const isChord = capturedCombos.length > 1;
  // Recording the binding that is already in force changes nothing; saving it
  // would still pin an override and mark the row modified.
  const isUnchanged = !!capturedCombo && !!currentCombo && sameChord(capturedCombo, currentCombo);
  const hasDraft = !recording && capturedCombo !== null;
  const hasConflicts = !validationError && conflicts.length > 0;
  const blockingConflict =
    blockConflicts && hasConflicts && conflicts.some((conflict) => conflict.kind !== "shadowed");
  const canSave = !!capturedCombo && !validationError && !isUnchanged && !blockingConflict;

  const clearChordTimeout = useCallback(() => {
    if (chordTimeoutRef.current) {
      clearTimeout(chordTimeoutRef.current);
      chordTimeoutRef.current = null;
    }
  }, []);

  const finishRecording = useCallback(
    (combos: string[]) => {
      clearChordTimeout();
      chordTokenRef.current += 1;
      pendingStepsRef.current = [];
      setHeld([]);
      const combo = combos.join(" ");
      if (validateCombo?.(combo)) {
        setRejected(combo);
        setCapturedCombos([]);
        setChordStep("first");
        return;
      }
      setRejected(null);
      setCapturedCombos(combos);
      setRecording(false);
      setChordStep("complete");
    },
    [clearChordTimeout, validateCombo]
  );

  useEffect(() => {
    if (!recording) return;
    const releaseCapture = keybindingService.beginShortcutCapture();

    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;

      // During IME composition, let the browser/IME own the event lifecycle.
      // keyCode 229 is Chromium's "Process" key signal during active composition
      // where isComposing may not yet be set on the first keydown. Must come
      // before preventDefault/stopPropagation so the IME candidate window keeps
      // working.
      if (e.isComposing || e.keyCode === 229) return;

      e.preventDefault();
      e.stopPropagation();

      // Bare Escape is the way out, never a key to record: swallowing it would
      // leave a keyboard user no exit from the recorder but a pointer.
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        clearChordTimeout();
        chordTokenRef.current += 1;
        pendingStepsRef.current = [];
        setRecording(false);
        setChordStep("first");
        setHeld([]);
        setRejected(null);
        if (previousDraftRef.current.length > 0) {
          // The restored draft is a finished capture again, and the recorder that
          // held focus is gone, so the focus effect picks its next control.
          setCapturedCombos(previousDraftRef.current);
          setChordStep("complete");
          setFocusRequest((n) => n + 1);
        } else {
          setCapturedCombos([]);
          onCancel();
        }
        return;
      }

      // Tab and Shift+Tab move focus, so they are never recorded: with a first key
      // waiting they end the chord window on it, and Enter does too, so a quick
      // Enter meant for Save is not taken as the second key.
      const navigationTab = e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const bareEnter = e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (pendingStepsRef.current.length > 0 && (navigationTab || bareEnter)) {
        finishRecording(pendingStepsRef.current);
        return;
      }

      // With nothing captured, the recorder stands down and hands the keyboard
      // back: Remove and Cancel are otherwise out of reach until some valid combo
      // has been captured.
      if (navigationTab) {
        clearChordTimeout();
        chordTokenRef.current += 1;
        pendingStepsRef.current = [];
        setRecording(false);
        setHeld([]);
        setRejected(null);
        if (previousDraftRef.current.length > 0) {
          setCapturedCombos(previousDraftRef.current);
          setChordStep("complete");
        } else {
          setCapturedCombos([]);
          setChordStep("first");
        }
        setFocusRequest((n) => n + 1);
        return;
      }

      const parts = heldModifiers(e, isMac());

      // Use normalizeKeyForBinding to handle physical key codes correctly
      // This fixes issues where Option+/ records as ÷ instead of /
      const key = normalizeKeyForBinding(e);
      if (MODIFIER_KEYS.includes(key)) {
        setHeld(parts);
        return;
      }

      parts.push(key);
      const combo = parts.join("+");
      setRejected(null);

      if (singleStroke) {
        finishRecording([combo]);
        return;
      }

      const pending = pendingStepsRef.current;
      if (pending.length > 0) {
        finishRecording([...pending, combo]);
        return;
      }

      const steps = [combo];
      pendingStepsRef.current = steps;
      setCapturedCombos(steps);
      setChordStep("waiting");
      clearChordTimeout();
      chordTokenRef.current += 1;
      const token = chordTokenRef.current;
      chordTimeoutRef.current = setTimeout(() => {
        if (chordTokenRef.current !== token) return;
        finishRecording(steps);
      }, CHORD_TIMEOUT_MS);
    };

    // A released modifier arrives as keyup, and the event's flags already exclude it.
    const handleKeyUp = (e: KeyboardEvent) => {
      setHeld(heldModifiers(e, isMac()));
    };

    const handleBlur = () => {
      // If the window loses focus mid-recording, held modifier state can't be
      // observed reliably on return — bail out rather than ship a stuck combo.
      // Invoke onCancel so any parent state coordinating the capture session
      // (e.g. AgentTrayCapturingContext.capturingId) also clears; otherwise the
      // tray dropdown can become un-dismissable after a mid-capture alt-tab.
      clearChordTimeout();
      chordTokenRef.current += 1;
      pendingStepsRef.current = [];
      setRecording(false);
      setCapturedCombos([]);
      setChordStep("first");
      setHeld([]);
      setRejected(null);
      onCancel();
    };

    window.addEventListener("keydown", handler, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
      clearChordTimeout();
      releaseCapture();
    };
  }, [recording, singleStroke, clearChordTimeout, finishRecording, onCancel]);

  // Land on Save once a combo is in, so Enter commits it; a combo that fails
  // validation has no Save to land on and keeps focus where it was.
  // A capture that cannot be saved as it stands (unchanged, or still bound elsewhere)
  // lands on the control that moves it forward instead of on a disabled Save.
  useEffect(() => {
    if (recording) return;
    if (chordStep !== "complete") {
      // Stood down with nothing captured: the idle field is the way back in.
      if (focusRequest > 0) idleRef.current?.focus();
      return;
    }
    const target = canSave
      ? saveRef.current
      : blockingConflict
        ? unbindRef.current
        : recordAgainRef.current;
    target?.focus();
  }, [chordStep, recording, canSave, blockingConflict, focusRequest]);

  // The Edit button that opened the recorder unmounts with it, so focus moves to
  // the recorder itself rather than falling to the page.
  useEffect(() => {
    if (!recording) return;
    recorderRef.current?.focus({ preventScroll: true });
  }, [recording]);

  const handleStartRecording = () => {
    previousDraftRef.current = capturedCombos;
    pendingStepsRef.current = [];
    setCapturedCombos([]);
    setChordStep("first");
    setHeld([]);
    setRejected(null);
    setRecording(true);
  };

  const handleSave = () => {
    if (canSave && capturedCombo) {
      clearChordTimeout();
      setRecording(false);
      onCapture(capturedCombo);
    }
  };

  const handleClear = () => {
    clearChordTimeout();
    setRecording(false);
    onCapture("");
  };

  const handleCancel = () => {
    clearChordTimeout();
    setRecording(false);
    onCancel();
  };

  const handleUnbindConflict = async (conflict: { actionId: string; description?: string }) => {
    const { actionId } = conflict;
    setIsUnbinding(true);

    try {
      const currentOverride = keybindingService.getOverride(actionId);
      // An override is one key list for the whole action, so freeing this combo
      // writes every key the action has without it: storing an empty list would
      // also take a second default (Zoom in's Cmd+= beside Cmd+Shift+=), and
      // dropping the override would bring back a default that may be this very
      // combo. Platform-aware, so a stored "Cmd+Shift+E" is freed when the user
      // captures "Ctrl+Shift+E" on Windows/Linux. (#7941)
      const combos = keybindingService.getTriggerCombos(actionId);
      const remaining = combos.filter((combo) => !combosFieldsEqual(combo, capturedCombo!));
      if (remaining.length === combos.length) {
        // Already freed elsewhere since the list was drawn; redraw it, and move
        // focus on from the Unbind button that goes with it.
        logWarn("Could not identify conflicting combo");
        setConflictRefreshKey((prev) => prev + 1);
        setFocusRequest((n) => n + 1);
        return;
      }

      const setResult = await actionService.dispatch(
        "keybinding.setOverride",
        { actionId, combo: remaining },
        { source: "user" }
      );
      if (!setResult.ok) {
        throw new Error(setResult.error?.message || "Failed to update keybinding");
      }

      setConflictRefreshKey((prev) => prev + 1);
      // The Unbind button goes away with the conflict; the focus effect moves on
      // to Save, or to the next Unbind when another conflict still blocks it.
      setFocusRequest((n) => n + 1);

      notify({
        type: "success",
        message: `Unbound ${conflict.description || conflict.actionId}`,
        duration: UNDO_TOAST_DURATION_MS,
        priority: "high",
        // Time-bound Undo (5s) — must surface even during quiet hours, otherwise
        // the user has no path to recover from an accidental unbind.
        urgent: true,
        // One-shot confirmation; the shortcut table below is the persistent
        // recovery surface, so no inbox row is needed once the 5s Undo lapses.
        transient: true,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              // Put back exactly what was there: the previous override, or no
              // override at all when the binding was inherited.
              const restoreResult = currentOverride
                ? await actionService.dispatch(
                    "keybinding.setOverride",
                    { actionId, combo: currentOverride },
                    { source: "user" }
                  )
                : await actionService.dispatch(
                    "keybinding.removeOverride",
                    { actionId },
                    { source: "user" }
                  );
              if (!restoreResult.ok) {
                throw new Error(restoreResult.error?.message || "Failed to undo");
              }
              setConflictRefreshKey((prev) => prev + 1);
            } catch (err) {
              logError("Failed to undo keybinding change", err);
              // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
              notify({
                type: "error",
                message: "Failed to undo keybinding change",
                duration: 3000,
                priority: "high",
              });
            }
          },
        },
      });
    } catch (err) {
      logError("Failed to unbind keybinding", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        message: "Failed to unbind keybinding",
        duration: 3000,
        priority: "high",
      });
    } finally {
      setIsUnbinding(false);
    }
  };

  const conflictNames = conflicts.map((conflict) => conflict.description || conflict.actionId);
  const firstUnbindable = conflicts.find((conflict) => conflict.kind !== "shadowed");
  // Unbind keeps the other action's remaining keys, and while that action is on
  // its defaults they then apply in every scope it is registered in: a grid-only
  // key left behind goes app-wide. Said before the click, beside the button.
  const unbindWidening = (actionId: string): ShortcutRowWidening | undefined => {
    if (!capturedCombo) return undefined;
    const mac = isMac();
    const rows = buildShortcutRows(
      keybindingService
        .getAllBindingsWithEffectiveCombos()
        .filter((binding) => binding.actionId === actionId),
      (id) => keybindingService.hasOverride(id),
      mac
    );
    const row = findShortcutRow(rows, actionId, capturedCombo, mac);
    if (!row || !combosFieldsEqual(row.key, capturedCombo, mac)) return undefined;
    return row.widening && row.widening.keys.length > 0 ? row.widening : undefined;
  };
  const describedBy =
    [outsideDescribedBy, validationError ? validationId : null, hasConflicts ? conflictsId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const fieldClass = compact
    ? "flex-1 min-w-0 px-2 py-1 text-sm border rounded-[var(--radius-md)] text-center"
    : "flex-1 min-w-0 h-9 px-3 flex items-center gap-2 text-sm border rounded-[var(--radius-md)]";

  return (
    <div
      className={compact ? "space-y-2" : "grid gap-3"}
      data-testid="shortcut-capture"
      onKeyDown={(e) => {
        // Once a combo is captured the recorder no longer owns keys, so Escape
        // would otherwise close the whole settings dialog. It closes this edit.
        if (e.key !== "Escape" || recording || compact) return;
        e.stopPropagation();
        handleCancel();
      }}
    >
      {!compact && currentCombo !== undefined && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <span>Current</span>
          {currentCombo ? (
            <KbdChord shortcut={currentCombo} density="bare" foreground="primary" />
          ) : (
            <span>Not set</span>
          )}
        </p>
      )}

      <div className="flex items-center gap-2">
        <div className="flex flex-1 min-w-0" role="status" aria-live="polite" aria-atomic="true">
          {recording ? (
            // Neutral, not accent: the field is the only thing on the row, so its
            // state is carried by the copy and the stronger border, and the region's
            // one accent stays with the focus ring.
            <div
              ref={recorderRef}
              tabIndex={-1}
              aria-describedby={outsideDescribedBy}
              data-testid="shortcut-capture-field"
              data-recording="true"
              className={cn(
                fieldClass,
                "relative border-border-strong bg-overlay-subtle text-text-primary"
              )}
            >
              {chordStep === "waiting" && capturedCombos[0] ? (
                <span className="inline-flex items-center gap-2">
                  <KbdChord shortcut={capturedCombos[0]} />
                  <span className="text-text-secondary">Press second key or wait to finish</span>
                  {/* How long the second key has. Mounted only while waiting, so every
                      entry starts a full bar; the status copy is what gets announced. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-md)]"
                  >
                    <span
                      data-chord-window=""
                      className="absolute inset-x-0 bottom-0 h-0.5 bg-text-secondary animate-chord-window"
                      style={CHORD_WINDOW_STYLE}
                    />
                  </span>
                </span>
              ) : held.length > 0 ? (
                <span className="inline-flex items-center gap-2">
                  <KbdChord shortcut={held.join("+")} foreground="primary" />
                  <span className="text-text-secondary">
                    {heldHint ? heldHint(held) : "Now press a key"}
                  </span>
                </span>
              ) : rejected ? (
                // The refused combo stays in view beside the reason below, and the
                // recorder stays armed: the next press is the retry.
                <span className="inline-flex items-center gap-2">
                  <KbdChord shortcut={rejected} />
                  <span className="text-text-secondary">
                    Try again <FactSeparator /> Esc to cancel
                  </span>
                </span>
              ) : (
                <span>
                  {recordingHint ?? "Press a key combination"}
                  <span className="text-text-secondary">
                    {" "}
                    <FactSeparator /> Esc to cancel
                  </span>
                </span>
              )}
            </div>
          ) : capturedCombo ? (
            <div
              data-testid="shortcut-capture-field"
              aria-describedby={describedBy}
              className={cn(fieldClass, "border-border-default bg-surface-input text-text-primary")}
            >
              <KbdChord shortcut={capturedCombo} foreground="primary" />
              {isUnchanged ? (
                <span className="text-xs text-text-secondary">Already the current shortcut</span>
              ) : (
                isChord && <span className="text-xs text-text-secondary">Two-step shortcut</span>
              )}
              {hasConflicts && (
                <span className="sr-only">
                  {blockingConflict ? "Already used by" : "Conflicts with"}{" "}
                  {conflictNames.join(", ")}
                </span>
              )}
            </div>
          ) : (
            <button
              ref={idleRef}
              type="button"
              data-testid="shortcut-capture-field"
              onClick={handleStartRecording}
              className={cn(
                fieldClass,
                "border-border-default bg-surface-input text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 ease-out"
              )}
            >
              Click to record shortcut
            </button>
          )}
        </div>
        {hasDraft && !compact && (
          <Button
            ref={recordAgainRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={handleStartRecording}
          >
            Record again
          </Button>
        )}
      </div>

      {validationError && (
        <InlineError id={validationId} role="alert" data-testid="shortcut-capture-validation-error">
          {validationError}
        </InlineError>
      )}

      {hasConflicts && (
        <div id={conflictsId} className="grid gap-1.5" data-testid="shortcut-capture-conflicts">
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <AlertTriangle
              className="w-3.5 h-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <span>{blockingConflict ? "Already used by" : "Conflicts with"}</span>
          </p>
          <ul className="grid gap-1 pl-5">
            {conflicts.map((conflict, index) => {
              const name = conflictNames[index]!;
              const widening =
                conflict.kind === "shadowed" ? undefined : unbindWidening(conflict.actionId);
              const wideningId = `${conflictsId}-widening-${index}`;
              return (
                <li
                  key={conflict.actionId}
                  className="flex flex-wrap items-center gap-x-2 min-h-7 text-sm"
                >
                  <span className="min-w-0 truncate text-text-primary">{name}</span>
                  {conflict.combo && (
                    <KbdChord
                      shortcut={conflict.combo}
                      density="bare"
                      foreground="primary"
                      className="shrink-0"
                    />
                  )}
                  {conflict.kind === "shadowed" ? (
                    // Shadowed = chord-prefix overlap. Auto-unbind can't resolve it
                    // (the conflicting binding's combo doesn't equal the captured one),
                    // so surface the relationship and leave resolution to the user.
                    // Direction by chord length: shorter prefix shadows the longer chord.
                    <span className="text-xs text-text-secondary">
                      {(conflict.combo?.split(" ").length ?? 0) >
                      (capturedCombo?.split(" ").length ?? 0)
                        ? "is shadowed by this chord"
                        : "shadows this chord"}
                    </span>
                  ) : (
                    <Button
                      ref={conflict === firstUnbindable ? unbindRef : undefined}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-auto"
                      onClick={() => handleUnbindConflict(conflict)}
                      disabled={isUnbinding}
                      aria-label={`Unbind ${name}`}
                      aria-describedby={widening ? wideningId : undefined}
                    >
                      Unbind
                    </Button>
                  )}
                  {widening && (
                    <span id={wideningId} className="basis-full pb-1 text-xs text-text-secondary">
                      After unbinding,{" "}
                      {widening.keys.map((key, keyIndex) => (
                        <span key={key}>
                          {keyIndex > 0 && (keyIndex === widening.keys.length - 1 ? " and " : ", ")}
                          <KbdChord shortcut={key} density="bare" foreground="primary" />
                        </span>
                      ))}{" "}
                      {widening.keys.length > 1 ? "apply" : "applies"} {widening.where}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {blockingConflict && (
            <p className="pl-5 text-xs text-text-secondary">
              {conflicts.length > 1 ? "Unbind them" : "Unbind it"} to use this shortcut here
            </p>
          )}
        </div>
      )}

      <div className={cn("flex items-center justify-end", compact ? "gap-3" : "gap-2")}>
        {hasDraft && compact && (
          <Button
            ref={recordAgainRef}
            type="button"
            variant="ghost"
            size="xs"
            className="mr-auto"
            onClick={handleStartRecording}
          >
            Record again
          </Button>
        )}
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size={compact ? "xs" : "sm"}
          onClick={handleCancel}
        >
          Cancel
        </Button>
        {/* Removes the binding in force, never just the draft, so it is only offered
            when there is one to remove and says so in both hosts. */}
        {currentCombo !== "" && (
          <Button
            type="button"
            variant="ghost"
            size={compact ? "xs" : "sm"}
            onClick={handleClear}
            aria-describedby={outsideDescribedBy}
          >
            {compact ? "Remove" : "Remove shortcut"}
          </Button>
        )}
        {capturedCombo && (
          <Button
            ref={saveRef}
            type="button"
            variant="contrast"
            size={compact ? "xs" : "sm"}
            onClick={handleSave}
            disabled={!canSave}
            aria-describedby={describedBy}
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
