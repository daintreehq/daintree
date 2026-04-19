import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { logsClient } from "@/clients/logsClient";
import { LOGGER_NAMES } from "@shared/config/loggerNames";

interface LogLevelPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

type OverrideLevel = "debug" | "info" | "warn" | "error" | "off";
const LEVEL_OPTIONS: Array<{ id: OverrideLevel | "clear"; label: string; hint: string }> = [
  { id: "debug", label: "Debug", hint: "All messages including detailed tracing" },
  { id: "info", label: "Info", hint: "Informational, warnings, and errors" },
  { id: "warn", label: "Warn", hint: "Warnings and errors only" },
  { id: "error", label: "Error", hint: "Errors only" },
  { id: "off", label: "Off", hint: "Suppress all output" },
  {
    id: "clear",
    label: "Clear override",
    hint: "Remove this override and fall back to the default",
  },
];

interface LoggerItem {
  id: string;
  name: string;
  current: OverrideLevel | null;
}

/**
 * Two-step picker modelled on VS Code's "Set Log Level…".
 * Step 1: choose a logger (or wildcard). Step 2: choose a level (or "Clear").
 *
 * The currently-applied override is displayed next to each logger name so
 * users can see at a glance what's already configured before they change it.
 */
export function LogLevelPalette({ isOpen, onClose }: LogLevelPaletteProps) {
  const [overrides, setOverrides] = useState<Record<string, OverrideLevel>>({});
  const [registryExtras, setRegistryExtras] = useState<string[]>([]);
  const [step, setStep] = useState<"logger" | "level">("logger");
  const [pendingLogger, setPendingLogger] = useState<string | null>(null);

  // Reset state whenever the palette opens.
  useEffect(() => {
    if (!isOpen) return;
    setStep("logger");
    setPendingLogger(null);

    void logsClient
      .getLevelOverrides()
      .then((raw) => {
        const coerced: Record<string, OverrideLevel> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (
            value === "debug" ||
            value === "info" ||
            value === "warn" ||
            value === "error" ||
            value === "off"
          ) {
            coerced[key] = value;
          }
        }
        setOverrides(coerced);
      })
      .catch(() => setOverrides({}));

    void logsClient
      .getRegistry()
      .then((names) => setRegistryExtras(names))
      .catch(() => setRegistryExtras([]));
  }, [isOpen]);

  const loggerItems = useMemo<LoggerItem[]>(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const name of LOGGER_NAMES) {
      if (!seen.has(name)) {
        seen.add(name);
        merged.push(name);
      }
    }
    for (const name of registryExtras) {
      if (!seen.has(name)) {
        seen.add(name);
        merged.push(name);
      }
    }
    return merged.map((name) => ({ id: name, name, current: overrides[name] ?? null }));
  }, [overrides, registryExtras]);

  const loggerPalette = useSearchablePalette<LoggerItem>({
    items: loggerItems,
    fuseOptions: { keys: ["name"], threshold: 0.4 },
    getItemId: (item) => item.id,
  });

  const levelPalette = useSearchablePalette<(typeof LEVEL_OPTIONS)[number]>({
    items: LEVEL_OPTIONS,
    fuseOptions: { keys: ["label"], threshold: 0.3 },
    getItemId: (item) => item.id,
  });

  const applyLevel = useCallback(
    async (loggerName: string, choice: OverrideLevel | "clear") => {
      const next = { ...overrides };
      if (choice === "clear") {
        delete next[loggerName];
      } else {
        next[loggerName] = choice;
      }
      setOverrides(next);
      await logsClient.setLevelOverrides(next);
    },
    [overrides]
  );

  const handleLoggerConfirm = useCallback(() => {
    const selected = loggerPalette.results[loggerPalette.selectedIndex];
    if (!selected) return;
    setPendingLogger(selected.name);
    setStep("level");
    levelPalette.setQuery("");
    levelPalette.setSelectedIndex(0);
  }, [loggerPalette.results, loggerPalette.selectedIndex, levelPalette]);

  const handleLevelConfirm = useCallback(() => {
    const selected = levelPalette.results[levelPalette.selectedIndex];
    if (!selected || !pendingLogger) return;
    void applyLevel(pendingLogger, selected.id).finally(() => onClose());
  }, [levelPalette.results, levelPalette.selectedIndex, pendingLogger, applyLevel, onClose]);

  if (step === "logger") {
    return (
      <SearchablePalette<LoggerItem>
        isOpen={isOpen}
        query={loggerPalette.query}
        results={loggerPalette.results}
        totalResults={loggerPalette.totalResults}
        selectedIndex={loggerPalette.selectedIndex}
        onQueryChange={loggerPalette.setQuery}
        onSelectPrevious={loggerPalette.selectPrevious}
        onSelectNext={loggerPalette.selectNext}
        onConfirm={handleLoggerConfirm}
        onClose={onClose}
        getItemId={(item) => item.id}
        label="Set Log Level"
        ariaLabel="Set log level — choose a module"
        searchPlaceholder="Search modules..."
        searchAriaLabel="Search log modules"
        emptyMessage="No modules registered"
        renderItem={(item, _index, isSelected) => (
          <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
            <span className="text-sm text-daintree-text font-mono truncate">{item.name}</span>
            {item.current && (
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
                  isSelected
                    ? "bg-daintree-accent/20 text-daintree-accent"
                    : "bg-daintree-border/60 text-daintree-text/70"
                )}
              >
                {item.current}
              </span>
            )}
          </div>
        )}
      />
    );
  }

  return (
    <SearchablePalette<(typeof LEVEL_OPTIONS)[number]>
      isOpen={isOpen}
      query={levelPalette.query}
      results={levelPalette.results}
      totalResults={levelPalette.totalResults}
      selectedIndex={levelPalette.selectedIndex}
      onQueryChange={levelPalette.setQuery}
      onSelectPrevious={levelPalette.selectPrevious}
      onSelectNext={levelPalette.selectNext}
      onConfirm={handleLevelConfirm}
      onClose={onClose}
      getItemId={(item) => item.id}
      label={`Level for ${pendingLogger ?? ""}`}
      ariaLabel="Set log level — choose a level"
      searchPlaceholder="Search levels..."
      emptyMessage="No levels available"
      renderItem={(item) => (
        <div className="flex-1 min-w-0">
          <div className="text-sm text-daintree-text">{item.label}</div>
          <div className="text-[11px] text-daintree-text/50">{item.hint}</div>
        </div>
      )}
    />
  );
}
