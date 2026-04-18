import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { isMac } from "@/lib/platform";
import { keybindingService, normalizeKeyForBinding } from "@/services/KeybindingService";

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
        <div className="flex items-start gap-2 text-status-warning text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Conflicts with: {conflicts.map((c) => c.description || c.actionId).join(", ")}
          </span>
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
