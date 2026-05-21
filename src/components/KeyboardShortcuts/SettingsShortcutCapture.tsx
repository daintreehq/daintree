import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
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

export interface SettingsShortcutCaptureProps {
  /** Called when user saves the captured key combination */
  onCapture: (combo: string) => void;
  /** Called when user cancels recording */
  onCancel: () => void;
  /** Action ID to exclude from conflict detection */
  excludeActionId: string;
  /**
   * Scope of the binding being edited. Used to filter conflict detection so
   * scope-disjoint bindings (e.g. Escape in modal vs terminal) don't false-flag.
   * Defaults to "global" (the conservative behavior — flags any overlap).
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
}

export function SettingsShortcutCapture({
  onCapture,
  onCancel,
  excludeActionId,
  scope = "global",
  validateCombo,
  compact = false,
}: SettingsShortcutCaptureProps) {
  // Compact (inline) consumers reach this widget by an explicit click, so
  // there's no reason to require a second "Click to record" press. Defaulting
  // `recording` to `compact` arms capture on mount without an effect.
  const [recording, setRecording] = useState(compact);
  const [capturedCombos, setCapturedCombos] = useState<string[]>([]);
  const [chordStep, setChordStep] = useState<"first" | "waiting" | "complete">("first");
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chordTokenRef = useRef(0);
  const [conflictRefreshKey, setConflictRefreshKey] = useState(0);
  const [isUnbinding, setIsUnbinding] = useState(false);

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

      const parts: string[] = [];
      const mac = isMac();

      if (mac && e.metaKey) parts.push("Cmd");
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
    };
  }, [recording, clearChordTimeout, finishRecording, onCancel]);

  const handleStartRecording = () => {
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

  const handleUnbindConflict = async (conflict: { actionId: string; description?: string }) => {
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

      if (isOverrideConflict) {
        if (newOverrideCombos && newOverrideCombos.length > 0) {
          const setResult = await actionService.dispatch(
            "keybinding.setOverride",
            { actionId, combo: newOverrideCombos },
            { source: "user" }
          );
          if (!setResult.ok) {
            throw new Error(setResult.error?.message || "Failed to update keybinding");
          }
        } else {
          const removeResult = await actionService.dispatch(
            "keybinding.removeOverride",
            { actionId },
            { source: "user" }
          );
          if (!removeResult.ok) {
            throw new Error(removeResult.error?.message || "Failed to remove keybinding");
          }
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

      const undoCombo = conflictingCombo!;

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
              const restoreResult = await actionService.dispatch(
                "keybinding.setOverride",
                {
                  actionId,
                  combo: isOverrideConflict && currentOverride ? currentOverride : [undoCombo],
                },
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

  const containerClass = compact
    ? "space-y-2"
    : "bg-daintree-bg/50 border border-daintree-border rounded-[var(--radius-lg)] p-4 space-y-3";
  const captureClass = compact
    ? "flex-1 px-2 py-1 text-sm border rounded text-center transition-colors"
    : "flex-1 px-4 py-2 border rounded text-center transition-colors";

  return (
    <div className={containerClass}>
      <div className="flex items-center gap-2" role="status" aria-live="polite" aria-atomic="true">
        {recording ? (
          <div
            className={cn(
              captureClass,
              "border-daintree-accent bg-daintree-accent/10 text-daintree-accent animate-pulse"
            )}
          >
            {chordStep === "first" ? (
              "Press key combination..."
            ) : chordStep === "waiting" ? (
              <span>
                <span className="font-mono">
                  {keybindingService.formatComboForDisplay(capturedCombos[0]!)}
                </span>
                <span className="text-daintree-accent/70">
                  {" "}
                  — press second key or wait to finish
                </span>
              </span>
            ) : null}
          </div>
        ) : capturedCombo ? (
          <div
            className={cn(
              captureClass,
              "border-daintree-border bg-daintree-bg text-daintree-text font-mono"
            )}
          >
            <span>{keybindingService.formatComboForDisplay(capturedCombo)}</span>
            {isChord && <span className="ml-2 text-xs text-daintree-text/50">(chord)</span>}
          </div>
        ) : (
          <button
            onClick={handleStartRecording}
            className={cn(
              captureClass,
              "border-daintree-border bg-daintree-bg text-daintree-text/60 hover:text-daintree-text hover:border-daintree-accent"
            )}
          >
            Click to record shortcut
          </button>
        )}
      </div>

      {validationError && (
        <div
          className="flex items-start gap-2 text-status-error text-sm"
          role="alert"
          data-testid="shortcut-capture-validation-error"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      {!validationError && conflicts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 text-status-warning text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Conflicts with:</span>
          </div>
          <div className="space-y-1 pl-6">
            {conflicts.map((conflict) => (
              <div key={conflict.actionId} className="flex items-center gap-2 text-sm">
                <span className="text-daintree-text/80">
                  {conflict.description || conflict.actionId}
                </span>
                {conflict.kind === "shadowed" ? (
                  // Shadowed = chord-prefix overlap. Auto-unbind can't resolve it
                  // (the conflicting binding's combo doesn't equal the captured one),
                  // so surface the relationship and leave resolution to the user.
                  // Direction by chord length: shorter prefix shadows the longer chord.
                  <span className="text-xs text-daintree-text/50">
                    {(conflict.combo?.split(" ").length ?? 0) >
                    (capturedCombo?.split(" ").length ?? 0)
                      ? "is shadowed by this chord"
                      : "shadows this chord"}
                  </span>
                ) : (
                  <button
                    onClick={() => handleUnbindConflict(conflict)}
                    disabled={isUnbinding}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                  >
                    <X className="w-3 h-3" />
                    <span>Unbind</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={cn("flex justify-end", compact ? "gap-3" : "gap-2")}>
        <button
          onClick={handleCancel}
          className={cn(
            "text-daintree-text/60 hover:text-daintree-text transition-colors",
            compact ? "text-xs" : "px-3 py-1.5 text-sm"
          )}
        >
          Cancel
        </button>
        <button
          onClick={handleClear}
          className={cn(
            "text-daintree-text/60 hover:text-daintree-text transition-colors",
            compact ? "text-xs" : "px-3 py-1.5 text-sm"
          )}
        >
          Clear
        </button>
        {capturedCombo && (
          <button
            onClick={handleSave}
            disabled={Boolean(validationError)}
            className={cn(
              "bg-daintree-accent text-daintree-bg rounded hover:bg-daintree-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1.5 text-sm"
            )}
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}
