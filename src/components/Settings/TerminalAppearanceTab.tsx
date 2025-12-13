import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useTerminalFontStore } from "@/store";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

const SYSTEM_STACK = DEFAULT_TERMINAL_FONT_FAMILY;
const JETBRAINS_STACK = `"JetBrains Mono", ${DEFAULT_TERMINAL_FONT_FAMILY}`;

const FONT_FAMILY_OPTIONS: Array<{ id: string; label: string; value: string }> = [
  {
    id: "system",
    label: "System monospace (Menlo/Monaco/Consolas)",
    value: SYSTEM_STACK,
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    value: JETBRAINS_STACK,
  },
];

export function TerminalAppearanceTab() {
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);
  const setFontSize = useTerminalFontStore((state) => state.setFontSize);
  const setFontFamily = useTerminalFontStore((state) => state.setFontFamily);

  const [fontSizeInput, setFontSizeInput] = useState<string>(String(fontSize));
  const [fontSizeError, setFontSizeError] = useState<string | null>(null);

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize]);

  const selectedFontFamilyId = useMemo(() => {
    if (fontFamily.includes("JetBrains Mono")) {
      return "jetbrains";
    }
    return "system";
  }, [fontFamily]);

  const handleFontSizeBlur = async () => {
    const parsed = Number(fontSizeInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setFontSizeInput(String(fontSize));
      setFontSizeError("Font size must be a whole number.");
      return;
    }
    if (parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
      setFontSizeError(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}px.`);
      setFontSizeInput(String(fontSize));
      return;
    }

    if (parsed === fontSize) {
      setFontSizeError(null);
      return;
    }

    const previous = fontSize;
    setFontSize(parsed);
    setFontSizeError(null);

    try {
      await terminalConfigClient.setFontSize(parsed);
    } catch (error) {
      console.error("Failed to persist terminal font size:", error);
      setFontSize(previous);
      setFontSizeInput(String(previous));
      setFontSizeError("Failed to save font size.");
    }
  };

  const handleFontFamilyChange = async (value: string) => {
    const option = FONT_FAMILY_OPTIONS.find((opt) => opt.id === value);
    if (!option) return;

    const nextFamily = option.value;
    if (nextFamily === fontFamily) return;

    const previous = fontFamily;
    setFontFamily(nextFamily);

    try {
      await terminalConfigClient.setFontFamily(nextFamily);
    } catch (error) {
      console.error("Failed to persist terminal font family:", error);
      setFontFamily(previous);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">Font size</h4>
        <div className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              value={fontSizeInput}
              onChange={(e) => {
                setFontSizeInput(e.target.value);
                if (fontSizeError) {
                  setFontSizeError(null);
                }
              }}
              onBlur={handleFontSizeBlur}
              className="bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-canopy-text w-24 focus:border-canopy-accent focus:outline-none transition-colors"
              aria-label="Terminal font size"
            />
            <span className="text-sm text-canopy-text/70">px</span>
          </div>
          <p className="text-xs text-canopy-text/50">
            Current: <span className="font-mono">{fontSize}px</span>. Smaller fonts reduce the
            number of cells on screen and can improve performance.
          </p>
          {fontSizeError && <p className="text-xs text-red-500">{fontSizeError}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">Font family</h4>
        <div className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] p-4 space-y-2">
          <select
            value={selectedFontFamilyId}
            onChange={(e) => handleFontFamilyChange(e.target.value)}
            className={cn(
              "bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text w-full focus:border-canopy-accent focus:outline-none transition-colors"
            )}
            aria-label="Terminal font family"
          >
            {FONT_FAMILY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-canopy-text/50">
            JetBrains Mono is bundled with Canopy. If it is not available on your system, the
            terminal will fall back to your platform&rsquo;s monospace font.
          </p>
        </div>
      </div>
    </div>
  );
}
