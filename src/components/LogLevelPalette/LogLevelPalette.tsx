import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import type { PaletteCloseReason } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { logsClient } from "@/clients/logsClient";
import { LOGGER_NAMES } from "@shared/config/loggerNames";
import { Badge } from "@/components/ui/badge";

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

/**
 * One option row, in the shape every palette draws: the id the palette's
 * `aria-activedescendant` names, the shared highlight, and the pointer moving
 * the same cursor the arrow keys do.
 */
function LogLevelRow({
  id,
  isSelected,
  onHover,
  onClick,
  children,
}: {
  id: string;
  isSelected: boolean;
  onHover: () => void;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      id={`palette-option-${id}`}
      role="option"
      aria-selected={isSelected}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={isSelected ? undefined : onHover}
      onClick={onClick}
      className={cn(
        PALETTE_ROW_CLASS,
        "w-full flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-md)] text-left cursor-pointer"
      )}
    >
      {children}
    </div>
  );
}

interface LoggerItem {
  id: string;
  name: string;
  current: OverrideLevel | null;
}

const getLoggerActionLabel = (_item: LoggerItem | null): string => "Set logger";
const getLevelActionLabel = (_item: (typeof LEVEL_OPTIONS)[number] | null): string => "Set level";

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

  // The palette is opened through paletteStore and this component stays mounted
  // between openings, so the hooks' own open() never runs. Call it for the
  // module list: it clears the query and drops the follow anchor.
  // setQuery("") + setSelectedIndex(0) would anchor results[0] of the
  // still-filtered list, and the hook would then chase that row to its place in
  // the full list. The level list is reset on entering the level step below.
  const wasOpenRef = useRef(false);
  const openLoggerPalette = loggerPalette.open;
  const openLevelPalette = levelPalette.open;
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      openLoggerPalette();
    }
    if (!isOpen) {
      wasOpenRef.current = false;
    }
  }, [isOpen, openLoggerPalette]);

  const confirmLogger = useCallback(
    (selected: LoggerItem | undefined) => {
      if (!selected) return;
      setPendingLogger(selected.name);
      setStep("level");
      openLevelPalette();
    },
    [openLevelPalette]
  );

  const handleLoggerConfirm = useCallback(() => {
    confirmLogger(loggerPalette.results[loggerPalette.selectedIndex]);
  }, [confirmLogger, loggerPalette.results, loggerPalette.selectedIndex]);

  const confirmLevel = useCallback(
    (selected: (typeof LEVEL_OPTIONS)[number] | undefined) => {
      if (!selected || !pendingLogger) return;
      void applyLevel(pendingLogger, selected.id).finally(() => onClose());
    },
    [pendingLogger, applyLevel, onClose]
  );

  const handleLevelConfirm = useCallback(() => {
    confirmLevel(levelPalette.results[levelPalette.selectedIndex]);
  }, [confirmLevel, levelPalette.results, levelPalette.selectedIndex]);

  // Escape on the level step goes back to the module list as it was left, its
  // search and cursor intact; a scrim click still closes the whole picker.
  const handleLevelClose = useCallback(
    (reason?: PaletteCloseReason) => {
      if (reason === "escape") {
        setStep("logger");
        return;
      }
      onClose();
    },
    [onClose]
  );

  if (step === "logger") {
    return (
      <SearchablePalette<LoggerItem>
        tier="command"
        isOpen={isOpen}
        query={loggerPalette.query}
        results={loggerPalette.results}
        totalResults={loggerPalette.totalResults}
        selectedIndex={loggerPalette.selectedIndex}
        onQueryChange={loggerPalette.setQuery}
        onSelectPrevious={loggerPalette.selectPrevious}
        onSelectNext={loggerPalette.selectNext}
        onSelectIndex={loggerPalette.setSelectedIndex}
        onConfirm={handleLoggerConfirm}
        onClose={onClose}
        getItemId={(item) => item.id}
        // Home and End route through the shell's hover callback.
        onHoverIndex={loggerPalette.setSelectedIndex}
        getActionLabel={getLoggerActionLabel}
        label="Set log level"
        ariaLabel="Set log level — choose a module"
        searchPlaceholder="Search modules"
        searchAriaLabel="Search log modules"
        emptyMessage="No modules registered"
        renderItem={(item, index, isSelected, onHover) => (
          <LogLevelRow
            key={item.id}
            id={item.id}
            isSelected={isSelected}
            onHover={() => onHover(index)}
            onClick={() => confirmLogger(item)}
          >
            <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
              <span className="text-sm text-text-primary font-mono truncate">{item.name}</span>
              {item.current && (
                <Badge
                  size="xs"
                  // Log levels keep the log viewer's own uppercase vocabulary. The
                  // highlighted row's fill would swallow the neutral wash, so the
                  // badge steps up a tone while its row is under the cursor.
                  className={cn("uppercase tracking-wider", isSelected && "bg-overlay-medium")}
                >
                  {item.current}
                </Badge>
              )}
            </div>
          </LogLevelRow>
        )}
      />
    );
  }

  return (
    <SearchablePalette<(typeof LEVEL_OPTIONS)[number]>
      tier="command"
      isOpen={isOpen}
      query={levelPalette.query}
      results={levelPalette.results}
      totalResults={levelPalette.totalResults}
      selectedIndex={levelPalette.selectedIndex}
      onQueryChange={levelPalette.setQuery}
      onSelectPrevious={levelPalette.selectPrevious}
      onSelectNext={levelPalette.selectNext}
      onSelectIndex={levelPalette.setSelectedIndex}
      onConfirm={handleLevelConfirm}
      onClose={handleLevelClose}
      getItemId={(item) => item.id}
      onHoverIndex={levelPalette.setSelectedIndex}
      getActionLabel={getLevelActionLabel}
      label={`Level for ${pendingLogger ?? ""}`}
      ariaLabel="Set log level — choose a level"
      searchPlaceholder="Search levels"
      emptyMessage="No levels available"
      renderItem={(item, index, isSelected, onHover) => (
        <LogLevelRow
          key={item.id}
          id={item.id}
          isSelected={isSelected}
          onHover={() => onHover(index)}
          onClick={() => confirmLevel(item)}
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary">{item.label}</div>
            <div className="text-2xs text-text-secondary">{item.hint}</div>
          </div>
        </LogLevelRow>
      )}
    />
  );
}
