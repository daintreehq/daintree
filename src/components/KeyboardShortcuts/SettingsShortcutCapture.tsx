import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
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
import { logError, logWarn } from "@/utils/logger";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";

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
  validateCombo?: (combo: string) => string | null;
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
  const [conflictRefreshKey, setConflictRefreshKey] = useState(0);
  const [isUnbinding, setIsUnbinding] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  // What was captured before "Record again", so Escape can put it back rather
  // than throwing away a combo the user already had.
  const previousDraftRef = useRef<string[]>([]);
  const validationId = useId();
  const conflictsId = useId();

  const capturedCombo = capturedCombos.length > 0 ? capturedCombos.join(" ") : null;

  const validationError = useMemo(() => {
    if (!capturedCombo || !validateCombo) return null;
    return validateCombo(capturedCombo);
  }, [capturedCombo, validateCombo]);

  const conflicts = useMemo(() => {
    // conflictRefreshKey forces the memo to re-evaluate after a successful
    // Unbind so the dismissed conflict row disappears immediately. Without it,
    // the memoized result persists against the unchanged capturedCombo.
    void conflictRefreshKey;
    if (!capturedCombo) return [];
    return keybindingService.findConflicts(capturedCombo, excludeActionId, scope);
  }, [capturedCombo, excludeActionId, scope, conflictRefreshKey]);

  const clearChordTimeout = useCallback(() => {
    if (chordTimeoutRef.current) {
      clearTimeout(chordTimeoutRef.current);
      chordTimeoutRef.current = null;
    }
  }, []);

  const finishRecording = useCallback(
    (combos: string[]) => {
      clearChordTimeout();
      setCapturedCombos(combos);
      setRecording(false);
      setChordStep("complete");
    },
    [clearChordTimeout]
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
        setRecording(false);
        setChordStep("first");
        if (previousDraftRef.current.length > 0) {
          setCapturedCombos(previousDraftRef.current);
          // The recorder that held focus is gone; the restored combo's Save is next.
          requestAnimationFrame(() => saveRef.current?.focus());
        } else {
          setCapturedCombos([]);
          onCancel();
        }
        return;
      }

      const parts: string[] = [];
      const mac = isMac();

      if (mac && e.metaKey) parts.push("Cmd");
      // Control is its own modifier on macOS; elsewhere it is the primary one.
      if (mac && e.ctrlKey) parts.push("Ctrl");
      if (!mac && e.ctrlKey) parts.push("Cmd");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");

      // Use normalizeKeyForBinding to handle physical key codes correctly
      // This fixes issues where Option+/ records as ÷ instead of /
      const key = normalizeKeyForBinding(e);
      if (!["Meta", "Control", "Alt", "Shift"].includes(key)) {
        parts.push(key);
        const combo = parts.join("+");

        setCapturedCombos((prev) => {
          const newCombos = [...prev, combo];

          if (prev.length === 0) {
            setChordStep("waiting");
            clearChordTimeout();
            chordTokenRef.current += 1;
            const token = chordTokenRef.current;
            chordTimeoutRef.current = setTimeout(() => {
              if (chordTokenRef.current !== token) return;
              finishRecording(newCombos);
            }, CHORD_TIMEOUT_MS);
          } else {
            chordTokenRef.current += 1;
            finishRecording(newCombos);
          }

          return newCombos;
        });
      }
    };

    const handleBlur = () => {
      // If the window loses focus mid-recording, held modifier state can't be
      // observed reliably on return — bail out rather than ship a stuck combo.
      // Invoke onCancel so any parent state coordinating the capture session
      // (e.g. AgentTrayCapturingContext.capturingId) also clears; otherwise the
      // tray dropdown can become un-dismissable after a mid-capture alt-tab.
      clearChordTimeout();
      chordTokenRef.current += 1;
      setRecording(false);
      setCapturedCombos([]);
      setChordStep("first");
      onCancel();
    };

    window.addEventListener("keydown", handler, { capture: true });
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("blur", handleBlur);
      clearChordTimeout();
      releaseCapture();
    };
  }, [recording, clearChordTimeout, finishRecording, onCancel]);

  // Land on Save once a combo is in, so Enter commits it; a combo that fails
  // validation has no Save to land on and keeps focus where it was.
  useEffect(() => {
    if (chordStep !== "complete" || recording || compact) return;
    saveRef.current?.focus();
  }, [chordStep, recording, compact]);

  // The Edit button that opened the recorder unmounts with it, so focus moves to
  // the recorder itself rather than falling to the page.
  useEffect(() => {
    if (!recording || compact) return;
    recorderRef.current?.focus({ preventScroll: true });
  }, [recording, compact]);

  const handleStartRecording = () => {
    previousDraftRef.current = capturedCombos;
    setCapturedCombos([]);
    setChordStep("first");
    setRecording(true);
  };

  const handleSave = () => {
    if (capturedCombo && !validationError) {
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

  const handleUnbindConflict = async (conflict: {
    actionId: string;
    description?: string;
    combo?: string;
  }) => {
    const { actionId } = conflict;
    setIsUnbinding(true);

    try {
      const currentOverride = keybindingService.getOverride(actionId);
      const defaultCombo = keybindingService.getDefaultCombo(actionId);

      let conflictingCombo: string | undefined;
      let isOverrideConflict = false;
      let newOverrideCombos: string[] | undefined;

      if (currentOverride) {
        // Platform-aware compare so a stored "Cmd+Shift+E" override is matched
        // when the user captures "Ctrl+Shift+E" on Windows/Linux. (#7941)
        const matchingOverride = currentOverride.find((combo) =>
          combosFieldsEqual(combo, capturedCombo!)
        );
        if (matchingOverride) {
          conflictingCombo = matchingOverride;
          isOverrideConflict = true;
          newOverrideCombos = currentOverride.filter(
            (combo) => !combosFieldsEqual(combo, capturedCombo!)
          );
        }
      }

      if (!conflictingCombo && defaultCombo) {
        if (combosFieldsEqual(defaultCombo, capturedCombo!)) {
          conflictingCombo = defaultCombo;
        }
      }

      // A plugin or second scoped registration isn't in the shipped defaults; the
      // conflict itself carries the combo that clashed.
      if (
        !conflictingCombo &&
        conflict.combo &&
        combosFieldsEqual(conflict.combo, capturedCombo!)
      ) {
        conflictingCombo = conflict.combo;
      }

      if (isOverrideConflict) {
        // Removing the last custom combo stores an empty binding rather than
        // dropping the override: dropping it would bring back the default, which
        // can be the very combo being freed, or another one the user never asked for.
        const setResult = await actionService.dispatch(
          "keybinding.setOverride",
          { actionId, combo: newOverrideCombos ?? [] },
          { source: "user" }
        );
        if (!setResult.ok) {
          throw new Error(setResult.error?.message || "Failed to update keybinding");
        }
      } else if (conflictingCombo) {
        const setResult = await actionService.dispatch(
          "keybinding.setOverride",
          { actionId, combo: [] },
          { source: "user" }
        );
        if (!setResult.ok) {
          throw new Error(setResult.error?.message || "Failed to update keybinding");
        }
      } else {
        logWarn("Could not identify conflicting combo");
        setIsUnbinding(false);
        return;
      }

      setConflictRefreshKey((prev) => prev + 1);
      // The Unbind button goes away with the conflict; Save is the next step.
      requestAnimationFrame(() => saveRef.current?.focus());

      notify({
        type: "success",
        message: `Unbound ${conflict.description || conflict.actionId}`,
        duration: 5000,
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

  const isChord = capturedCombos.length > 1;
  const hasDraft = !recording && capturedCombo !== null;
  const hasConflicts = !validationError && conflicts.length > 0;
  const describedBy =
    [validationError ? validationId : null, hasConflicts ? conflictsId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const fieldClass = compact
    ? "flex-1 min-w-0 px-2 py-1 text-sm border rounded-[var(--radius-md)] text-center"
    : "flex-1 min-w-0 h-9 px-3 flex items-center gap-2 text-sm border rounded-[var(--radius-md)]";

  return (
    <div className={compact ? "space-y-2" : "grid gap-3"} data-testid="shortcut-capture">
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
              data-testid="shortcut-capture-field"
              data-recording="true"
              className={cn(fieldClass, "border-border-strong bg-overlay-subtle text-text-primary")}
            >
              {chordStep === "waiting" && capturedCombos[0] ? (
                <span className="inline-flex items-center gap-2">
                  <KbdChord shortcut={capturedCombos[0]} />
                  <span className="text-text-secondary">Press second key or wait to finish</span>
                </span>
              ) : (
                <span>
                  Press a key combination
                  <span className="text-text-secondary"> · Esc to cancel</span>
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
              {isChord && <span className="text-xs text-text-secondary">Two-step shortcut</span>}
            </div>
          ) : (
            <button
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
          <Button type="button" variant="outline" size="sm" onClick={handleStartRecording}>
            Record again
          </Button>
        )}
      </div>

      {validationError && (
        <div
          id={validationId}
          className="flex items-start gap-2 text-status-error text-sm"
          role="alert"
          data-testid="shortcut-capture-validation-error"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{validationError}</span>
        </div>
      )}

      {hasConflicts && (
        <div id={conflictsId} className="grid gap-1.5" data-testid="shortcut-capture-conflicts">
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <AlertTriangle
              className="w-3.5 h-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <span>Conflicts with</span>
          </p>
          <ul className="grid gap-1 pl-5">
            {conflicts.map((conflict) => {
              const name = conflict.description || conflict.actionId;
              return (
                <li key={conflict.actionId} className="flex items-center gap-2 min-h-7 text-sm">
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
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-auto"
                      onClick={() => handleUnbindConflict(conflict)}
                      disabled={isUnbinding}
                      aria-label={`Unbind ${name}`}
                    >
                      Unbind
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className={cn("flex items-center justify-end", compact ? "gap-3" : "gap-2")}>
        <Button type="button" variant="ghost" size={compact ? "xs" : "sm"} onClick={handleCancel}>
          Cancel
        </Button>
        {(compact || currentCombo !== "") && (
          <Button type="button" variant="ghost" size={compact ? "xs" : "sm"} onClick={handleClear}>
            {compact ? "Clear" : "Remove shortcut"}
          </Button>
        )}
        {capturedCombo && (
          <Button
            ref={saveRef}
            type="button"
            variant="contrast"
            size={compact ? "xs" : "sm"}
            onClick={handleSave}
            disabled={Boolean(validationError)}
            aria-describedby={describedBy}
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
