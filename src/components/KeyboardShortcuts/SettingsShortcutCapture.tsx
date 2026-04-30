import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { isMac } from "@/lib/platform";
import { keybindingService, normalizeKeyForBinding } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { logError, logWarn } from "@/utils/logger";

const CHORD_TIMEOUT_MS = 1000;

export interface SettingsShortcutCaptureProps {
  /** Called when user saves the captured key combination */
  onCapture: (combo: string) => void;
  /** Called when user cancels recording */
  onCancel: () => void;
  /** Action ID to exclude from conflict detection */
  excludeActionId: string;
}

export function SettingsShortcutCapture({
  onCapture,
  onCancel,
  excludeActionId,
}: SettingsShortcutCaptureProps) {
  const [recording, setRecording] = useState(false);
  const [capturedCombos, setCapturedCombos] = useState<string[]>([]);
  const [chordStep, setChordStep] = useState<"first" | "waiting" | "complete">("first");
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chordTokenRef = useRef(0);
  const [_conflictRefreshKey, setConflictRefreshKey] = useState(0);
  const [isUnbinding, setIsUnbinding] = useState(false);

  const capturedCombo = capturedCombos.length > 0 ? capturedCombos.join(" ") : null;

  const conflicts = useMemo(() => {
    if (!capturedCombo) return [];
    return keybindingService.findConflicts(capturedCombo, excludeActionId);
  }, [capturedCombo, excludeActionId]);

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

    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      clearChordTimeout();
    };
  }, [recording, clearChordTimeout, finishRecording]);

  const handleStartRecording = () => {
    setCapturedCombos([]);
    setChordStep("first");
    setRecording(true);
  };

  const handleSave = () => {
    if (capturedCombo) {
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
        const matchingOverride = currentOverride.find(
          (combo) => combo.trim().toLowerCase() === capturedCombo!.trim().toLowerCase()
        );
        if (matchingOverride) {
          conflictingCombo = matchingOverride;
          isOverrideConflict = true;
          newOverrideCombos = currentOverride.filter(
            (combo) => combo.trim().toLowerCase() !== capturedCombo!.trim().toLowerCase()
          );
        }
      }

      if (!conflictingCombo && defaultCombo) {
        const normalizedDefault = defaultCombo.trim().toLowerCase();
        const normalizedCaptured = capturedCombo!.trim().toLowerCase();
        if (normalizedDefault === normalizedCaptured) {
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

  return (
    <div className="bg-daintree-bg/50 border border-daintree-border rounded-[var(--radius-lg)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        {recording ? (
          <div className="flex-1 px-4 py-2 border border-daintree-accent rounded bg-daintree-accent/10 text-daintree-accent animate-pulse text-center">
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
          <div className="flex-1 px-4 py-2 border border-daintree-border rounded bg-daintree-bg text-daintree-text text-center font-mono">
            <span>{keybindingService.formatComboForDisplay(capturedCombo)}</span>
            {isChord && <span className="ml-2 text-xs text-daintree-text/50">(chord)</span>}
          </div>
        ) : (
          <button
            onClick={handleStartRecording}
            className="flex-1 px-4 py-2 border border-daintree-border rounded bg-daintree-bg text-daintree-text/60 hover:text-daintree-text hover:border-daintree-accent transition-colors"
          >
            Click to record shortcut
          </button>
        )}
      </div>

      {conflicts.length > 0 && (
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
                <button
                  onClick={() => handleUnbindConflict(conflict)}
                  disabled={isUnbinding}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                >
                  <X className="w-3 h-3" />
                  <span>Unbind</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-sm text-daintree-text/60 hover:text-daintree-text transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleClear}
          className="px-3 py-1.5 text-sm text-daintree-text/60 hover:text-daintree-text transition-colors"
        >
          Clear
        </button>
        {capturedCombo && (
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-sm bg-daintree-accent text-daintree-bg rounded hover:bg-daintree-accent/90 transition-colors"
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}
