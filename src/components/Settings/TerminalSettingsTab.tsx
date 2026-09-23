import { LayoutGrid, Columns, Rows, ChevronDown } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsNumberInput } from "@/components/Settings/SettingsNumberInput";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { logError, logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  useLayoutConfigStore,
  usePerformanceModeStore,
  useScrollbackStore,
  useScreenReaderStore,
  useTerminalInputStore,
  useTwoPaneSplitStore,
} from "@/store";
import type { ScreenReaderMode } from "@/store";
import type { PanelLayoutStrategy } from "@/types";
import {
  getScrollbackForType,
  estimateMemoryUsage,
  PERFORMANCE_MODE_SCROLLBACK,
} from "@/utils/scrollbackConfig";
import { formatBytes } from "@/lib/formatBytes";
import { actionService } from "@/services/ActionService";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { useMemoryLeakConfigStore } from "@/store/memoryLeakConfigStore";
import type { HardwareInfo } from "@shared/types/ipc/system";

const STRATEGIES: Array<{
  id: PanelLayoutStrategy;
  label: string;
  description: string;
  icon: typeof LayoutGrid;
}> = [
  {
    id: "automatic",
    label: "Automatic",
    description: "2→3→4 cols",
    icon: LayoutGrid,
  },
  {
    id: "fixed-columns",
    label: "Fixed columns",
    description: "Vertical scroll",
    icon: Columns,
  },
  {
    id: "fixed-rows",
    label: "Fixed rows",
    description: "Horizontal expand",
    icon: Rows,
  },
];

const SCROLLBACK_OPTIONS = [
  { value: 500, label: "500 lines", description: "Minimal" },
  { value: 1000, label: "1,000 lines", description: "Default" },
  { value: 2500, label: "2,500 lines", description: "Extended" },
  { value: 5000, label: "5,000 lines", description: "Full history" },
] as const;

const CACHED_VIEWS_OPTIONS = [
  { value: 1, label: "1 project", description: "Minimal" },
  { value: 2, label: "2 projects", description: "Balanced" },
  { value: 3, label: "3 projects", description: "Balanced" },
  { value: 4, label: "4 projects", description: "More cache" },
  { value: 5, label: "5 projects", description: "Max cache" },
] as const;

const TYPICAL_TERMINAL_COUNTS: { agent: number; plain: number } = {
  agent: 8,
  plain: 8,
};

const TERMINAL_SUBTABS: SettingsSubtabItem[] = [
  { id: "performance", label: "Performance" },
  { id: "input", label: "Input" },
  { id: "layout", label: "Layout" },
  { id: "scrollback", label: "Scrollback" },
  { id: "accessibility", label: "Accessibility" },
];

const TERMINAL_SUBTAB_IDS = TERMINAL_SUBTABS.map((s) => s.id);

interface TerminalSettingsTabProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

export function TerminalSettingsTab({ activeSubtab, onSubtabChange }: TerminalSettingsTabProps) {
  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);

  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);

  const scrollbackLines = useScrollbackStore((state) => state.scrollbackLines);

  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);

  const screenReaderMode = useScreenReaderStore((state) => state.screenReaderMode);
  const resourceMonitoringEnabled = useResourceMonitoringStore((state) => state.enabled);
  const setResourceMonitoringEnabled = useResourceMonitoringStore((state) => state.setEnabled);

  const twoPaneSplitConfig = useTwoPaneSplitStore((state) => state.config);
  const setTwoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.setEnabled);
  const setPreferPreview = useTwoPaneSplitStore((state) => state.setPreferPreview);
  const setDefaultRatio = useTwoPaneSplitStore((state) => state.setDefaultRatio);
  const resetAllWorktreeRatios = useTwoPaneSplitStore((state) => state.resetAllWorktreeRatios);

  const panelLimits = usePanelLimitStore(
    useShallow((state) => ({
      softWarningLimit: state.softWarningLimit,
      confirmationLimit: state.confirmationLimit,
      hardLimit: state.hardLimit,
      warningsDisabled: state.warningsDisabled,
    }))
  );
  const setWarningsDisabled = usePanelLimitStore((state) => state.setWarningsDisabled);
  const setSoftWarningLimit = usePanelLimitStore((state) => state.setSoftWarningLimit);
  const setConfirmationLimit = usePanelLimitStore((state) => state.setConfirmationLimit);
  const setPanelHardLimit = usePanelLimitStore((state) => state.setHardLimit);
  const resetToHardwareDefaults = usePanelLimitStore((state) => state.resetToHardwareDefaults);
  const initializeFromHardware = usePanelLimitStore((state) => state.initializeFromHardware);

  const memoryLeakDetectionEnabled = useMemoryLeakConfigStore((s) => s.enabled);
  const autoRestartThresholdMb = useMemoryLeakConfigStore((s) => s.autoRestartThresholdMb);
  const setMemoryLeakDetectionEnabled = useMemoryLeakConfigStore((s) => s.setEnabled);
  const setAutoRestartThresholdMb = useMemoryLeakConfigStore((s) => s.setAutoRestartThresholdMb);

  const cachedProjectViews = useCachedProjectViewsStore((s) => s.cachedProjectViews);

  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null);

  useEffect(() => {
    void initializeFromHardware();
    window.electron.system
      .getHardwareInfo()
      .then(setHardwareInfo)
      .catch((err) => {
        // Background probe — the UI gracefully renders without hardware info.
        logWarn("Failed to load hardware info", {
          error: formatErrorMessage(err, "Hardware info probe failed"),
        });
      });
  }, [initializeFromHardware]);

  const [showMemoryDetails, setShowMemoryDetails] = useState(false);

  const memoryEstimate = useMemo(() => {
    const base = performanceMode ? PERFORMANCE_MODE_SCROLLBACK : scrollbackLines;
    return estimateMemoryUsage(TYPICAL_TERMINAL_COUNTS, base);
  }, [performanceMode, scrollbackLines]);

  const scrollbackLimits = useMemo(() => {
    const effectiveBase = performanceMode ? PERFORMANCE_MODE_SCROLLBACK : scrollbackLines;
    const types: Array<{ isAgent: boolean; label: string }> = [
      { isAgent: true, label: "Agent (Claude/Gemini/Codex/OpenCode)" },
      { isAgent: false, label: "Terminal" },
    ];
    return types.map(({ isAgent, label }) => ({
      label,
      limit: performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(isAgent, effectiveBase),
    }));
  }, [performanceMode, scrollbackLines]);

  const handleScrollbackChange = async (value: number) => {
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setScrollback",
        { scrollbackLines: value },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist scrollback setting", error);
    }
  };

  const handleStrategyChange = (strategy: PanelLayoutStrategy) => {
    void actionService.dispatch("panel.gridLayout.setStrategy", { strategy }, { source: "user" });
  };

  const handleValueChange = (val: string) => {
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 1 && num <= 10) {
      void actionService.dispatch("panel.gridLayout.setValue", { value: num }, { source: "user" });
    }
  };

  const handlePerformanceModeToggle = async () => {
    const newValue = !performanceMode;
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setPerformanceMode",
        { performanceMode: newValue },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist performance mode setting", error);
    }
  };

  const handleHybridInputEnabledToggle = async () => {
    const nextValue = !hybridInputEnabled;
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setHybridInputEnabled",
        { enabled: nextValue },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist hybrid input setting", error);
    }
  };

  const handleHybridInputAutoFocusToggle = async () => {
    const nextValue = !hybridInputAutoFocus;
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setHybridInputAutoFocus",
        { enabled: nextValue },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist hybrid input focus setting", error);
    }
  };

  const handleScreenReaderModeChange = async (mode: ScreenReaderMode) => {
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setScreenReaderMode",
        { mode },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist screen reader mode", error);
    }
  };

  const handleCachedProjectViewsChange = async (value: number) => {
    try {
      const result = await actionService.dispatch(
        "terminalConfig.setCachedProjectViews",
        { cachedProjectViews: value },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist cached project views setting", error);
    }
  };

  const effectiveSubtab =
    activeSubtab && TERMINAL_SUBTAB_IDS.includes(activeSubtab) ? activeSubtab : "performance";

  return (
    <div>
      <SettingsSubtabBar
        subtabs={TERMINAL_SUBTABS}
        activeId={effectiveSubtab}
        onChange={onSubtabChange}
        group="terminal"
        ariaLabel="Terminal settings sections"
      />

      <div {...subtabPanelProps("terminal", effectiveSubtab)} className="space-y-8">
        {effectiveSubtab === "performance" && (
          <SettingsSection title="Performance">
            <SettingsGroup>
              <SettingsSwitchCard
                id="terminal-performance-mode"
                title="Performance mode"
                subtitle={`Cuts scrollback to ${PERFORMANCE_MODE_SCROLLBACK} lines and turns off animations, for low-end hardware or high-density workflows. Existing terminals keep their scrollback until respawned`}
                isEnabled={performanceMode}
                onChange={handlePerformanceModeToggle}
                ariaLabel="Performance Mode Toggle"
                colorScheme="amber"
                isModified={performanceMode}
                onReset={() =>
                  void actionService.dispatch(
                    "terminalConfig.setPerformanceMode",
                    { performanceMode: false },
                    { source: "user" }
                  )
                }
                lifecycleBadge="New terminals"
              />

              <SettingsSwitchCard
                id="terminal-resource-monitoring"
                title="Resource monitoring"
                subtitle="Show per-terminal CPU and memory in panel headers. Polls the process tree every 2.5 seconds"
                isEnabled={resourceMonitoringEnabled}
                onChange={() => {
                  const newValue = !resourceMonitoringEnabled;
                  setResourceMonitoringEnabled(newValue);
                  safeFireAndForget(
                    window.electron.terminalConfig.setResourceMonitoring(newValue),
                    { context: "Setting terminal resource monitoring" }
                  );
                }}
                ariaLabel="Resource Monitoring Toggle"
                isModified={resourceMonitoringEnabled}
                onReset={() => {
                  setResourceMonitoringEnabled(false);
                  safeFireAndForget(window.electron.terminalConfig.setResourceMonitoring(false), {
                    context: "Resetting terminal resource monitoring",
                  });
                }}
              />

              <SettingsDependents
                disabled={!resourceMonitoringEnabled}
                reason="Turn on resource monitoring to detect memory leaks"
              >
                <SettingsSwitchCard
                  id="terminal-memory-leak-detection"
                  title="Memory leak detection"
                  subtitle="Warn when a terminal's memory keeps growing, with options to restart it"
                  isEnabled={memoryLeakDetectionEnabled}
                  onChange={() => {
                    const newValue = !memoryLeakDetectionEnabled;
                    setMemoryLeakDetectionEnabled(newValue);
                    safeFireAndForget(
                      window.electron.terminalConfig.setMemoryLeakDetection(newValue),
                      { context: "Setting terminal memory leak detection" }
                    );
                  }}
                  isModified={memoryLeakDetectionEnabled}
                  onReset={() => {
                    setMemoryLeakDetectionEnabled(false);
                    safeFireAndForget(
                      window.electron.terminalConfig.setMemoryLeakDetection(false),
                      { context: "Resetting terminal memory leak detection" }
                    );
                  }}
                />

                <SettingsDependents
                  disabled={!memoryLeakDetectionEnabled}
                  reason={
                    resourceMonitoringEnabled
                      ? "Turn on memory leak detection to restart terminals automatically"
                      : undefined
                  }
                >
                  <SettingsNumberInput
                    label="Auto-restart threshold"
                    description="Restart a terminal automatically once its memory (RSS) passes this. 1,024–32,768 MB"
                    min={1024}
                    max={32768}
                    step={1024}
                    suffix="MB"
                    value={autoRestartThresholdMb}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        setAutoRestartThresholdMb(val);
                        if (val >= 1024 && val <= 32768) {
                          safeFireAndForget(
                            window.electron.terminalConfig.setMemoryLeakAutoRestartThresholdMb(val),
                            { context: "Setting memory leak auto-restart threshold" }
                          );
                        }
                      }
                    }}
                  />
                </SettingsDependents>
              </SettingsDependents>
            </SettingsGroup>
          </SettingsSection>
        )}

        {effectiveSubtab === "performance" && (
          <SettingsSection
            title="Panel limits"
            id="terminal-panel-limits"
            description="When warnings appear as you open more panels. Limits are detected from your hardware on first launch."
          >
            <SettingsGroup>
              <SettingsSwitchCard
                id="terminal-panel-warnings-toggle"
                title="Panel warnings"
                subtitle="Show warning banners as you open more panels; batch spawns confirm past the limit"
                isEnabled={!panelLimits.warningsDisabled}
                onChange={() => setWarningsDisabled(!panelLimits.warningsDisabled)}
                isModified={panelLimits.warningsDisabled}
                onReset={() => setWarningsDisabled(false)}
              />

              <SettingsDependents
                disabled={panelLimits.warningsDisabled}
                reason="Turn on panel warnings to set when they appear"
              >
                <SettingsNumberInput
                  label="Soft warning"
                  description="Show a dismissible banner when the panel count reaches this number"
                  min={4}
                  max={100}
                  value={panelLimits.softWarningLimit}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) setSoftWarningLimit(val);
                  }}
                />

                <SettingsNumberInput
                  label="Confirmation required"
                  description="Confirm before a batch spawn (recipe or worktree spin-up) pushes the panel count past this number"
                  min={4}
                  max={100}
                  value={panelLimits.confirmationLimit}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) setConfirmationLimit(val);
                  }}
                />
              </SettingsDependents>

              <SettingsNumberInput
                label="Hard limit"
                description="Absolute maximum number of panels. Can't be bypassed"
                min={4}
                max={100}
                value={panelLimits.hardLimit}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) setPanelHardLimit(val);
                }}
              />

              <SettingsRow
                label="Hardware-recommended limits"
                description={
                  hardwareInfo && hardwareInfo.totalMemoryBytes > 0
                    ? `Detected ${Math.round(hardwareInfo.totalMemoryBytes / (1024 * 1024 * 1024))} GB RAM, ${hardwareInfo.logicalCpuCount} CPU cores`
                    : "Recalculate all three limits from this machine's hardware"
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void resetToHardwareDefaults()}
                    aria-label="Reset to hardware-recommended defaults"
                  >
                    Reset
                  </Button>
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}

        {effectiveSubtab === "performance" && (
          <SettingsSection
            title="Cached project views"
            id="terminal-cached-project-views"
            description="Project views kept loaded in memory. More keeps switching back near-instant; fewer saves memory. The default scales with your RAM."
          >
            <div
              className="grid grid-cols-5 gap-3"
              role="radiogroup"
              aria-label="Cached project views"
            >
              {CACHED_VIEWS_OPTIONS.map(({ value, label, description }) => (
                <button
                  key={value}
                  onClick={() => handleCachedProjectViewsChange(value)}
                  role="radio"
                  aria-checked={cachedProjectViews === value}
                  aria-label={`${label} - ${description}`}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-[var(--radius-md)] border transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                    cachedProjectViews === value
                      ? "bg-overlay-selected border-border-strong text-text-primary font-medium"
                      : "border-border-default hover:bg-tint/5 text-text-secondary"
                  )}
                >
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-2xs mt-0.5 opacity-60">{description}</span>
                </button>
              ))}
            </div>
          </SettingsSection>
        )}

        {effectiveSubtab === "input" && (
          <SettingsSection title="Agent input">
            <SettingsGroup>
              <SettingsSwitchCard
                id="terminal-hybrid-input"
                title="Hybrid input bar"
                subtitle="Show the multi-line input bar at the bottom of agent terminals"
                isEnabled={hybridInputEnabled}
                onChange={handleHybridInputEnabledToggle}
                isModified={!hybridInputEnabled}
                onReset={() =>
                  void actionService.dispatch(
                    "terminalConfig.setHybridInputEnabled",
                    { enabled: true },
                    { source: "user" }
                  )
                }
              />

              <SettingsDependents
                disabled={!hybridInputEnabled}
                reason="Turn on the hybrid input bar to choose where focus starts"
              >
                <SettingsSwitchCard
                  id="terminal-hybrid-autofocus"
                  title="Focus the input bar first"
                  subtitle="Agent panes start with the input bar focused instead of the terminal. Clicking either still wins, and Cmd-Opt-Arrow follows whichever you're using"
                  isEnabled={hybridInputAutoFocus}
                  onChange={handleHybridInputAutoFocusToggle}
                  isModified={!hybridInputAutoFocus}
                  onReset={() =>
                    void actionService.dispatch(
                      "terminalConfig.setHybridInputAutoFocus",
                      { enabled: true },
                      { source: "user" }
                    )
                  }
                />
              </SettingsDependents>
            </SettingsGroup>
          </SettingsSection>
        )}

        {effectiveSubtab === "layout" && (
          <>
            <SettingsSection title="Two-pane split" id="terminal-two-pane-split">
              <SettingsGroup>
                <SettingsSwitchCard
                  title="Split two panels with a divider"
                  subtitle="When exactly two panels are open, show a resizable divider instead of equal columns. The ratio is remembered per worktree"
                  isEnabled={twoPaneSplitConfig.enabled}
                  onChange={() => setTwoPaneSplitEnabled(!twoPaneSplitConfig.enabled)}
                  isModified={!twoPaneSplitConfig.enabled}
                  onReset={() => setTwoPaneSplitEnabled(true)}
                />

                <SettingsDependents
                  disabled={!twoPaneSplitConfig.enabled}
                  reason="Turn on the two-pane split to adjust it"
                >
                  <SettingsSwitchCard
                    id="terminal-preview-layout"
                    title="Preview-focused layout"
                    subtitle="Give more space to browser and dev-preview panels"
                    isEnabled={twoPaneSplitConfig.preferPreview}
                    onChange={() => setPreferPreview(!twoPaneSplitConfig.preferPreview)}
                    isModified={twoPaneSplitConfig.preferPreview}
                    onReset={() => setPreferPreview(false)}
                  />

                  <SettingsRow
                    id="terminal-default-ratio"
                    label="Default ratio"
                    description="Used when a worktree has no saved ratio of its own"
                    control={({ labelId, descriptionId, disabled }) => (
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min="20"
                          max="80"
                          value={Math.round(twoPaneSplitConfig.defaultRatio * 100)}
                          onChange={(e) => setDefaultRatio(Number(e.target.value) / 100)}
                          aria-labelledby={labelId}
                          aria-describedby={descriptionId}
                          aria-valuetext={`${Math.round(twoPaneSplitConfig.defaultRatio * 100)} percent left, ${Math.round((1 - twoPaneSplitConfig.defaultRatio) * 100)} percent right`}
                          className="w-40 accent-accent-primary disabled:opacity-50"
                          disabled={disabled}
                        />
                        <span
                          className="text-xs text-text-secondary font-mono w-12 text-right"
                          aria-hidden="true"
                        >
                          {Math.round(twoPaneSplitConfig.defaultRatio * 100)}/
                          {Math.round((1 - twoPaneSplitConfig.defaultRatio) * 100)}
                        </span>
                      </div>
                    )}
                  />

                  <SettingsRow
                    id="terminal-reset-ratios"
                    label="Worktree split ratios"
                    description="Clear every per-worktree ratio so all worktrees use the default"
                    control={({ disabled }) => (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={resetAllWorktreeRatios}
                        disabled={disabled}
                        aria-label="Reset all worktree split ratios"
                      >
                        Reset all
                      </Button>
                    )}
                  />
                </SettingsDependents>
              </SettingsGroup>
            </SettingsSection>

            <SettingsSection
              title="Grid layout strategy"
              id="terminal-grid-layout"
              description="How panels arrange in the grid as you add more."
            >
              <div className="grid grid-cols-3 gap-3">
                {STRATEGIES.map(({ id, label, description, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => handleStrategyChange(id)}
                    className={cn(
                      "flex flex-col items-center justify-center p-4 rounded-[var(--radius-md)] border transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                      layoutConfig.strategy === id
                        ? "bg-overlay-selected border-border-strong text-text-primary font-medium"
                        : "border-border-default hover:bg-tint/5 text-text-secondary"
                    )}
                  >
                    <Icon className="w-6 h-6 mb-2" />
                    <span className="text-xs font-medium">{label}</span>
                    <span className="text-2xs text-center mt-1 opacity-60">{description}</span>
                  </button>
                ))}
              </div>

              {layoutConfig.strategy !== "automatic" && (
                <SettingsGroup>
                  <SettingsNumberInput
                    label={
                      layoutConfig.strategy === "fixed-columns"
                        ? "Number of columns"
                        : "Number of rows"
                    }
                    description={
                      layoutConfig.strategy === "fixed-columns"
                        ? "Terminals stack vertically once this many columns are filled"
                        : "Terminals expand horizontally once this many rows are filled"
                    }
                    min={1}
                    max={10}
                    value={layoutConfig.value}
                    onChange={(e) => handleValueChange(e.target.value)}
                  />
                </SettingsGroup>
              )}

              <p className="text-xs text-text-secondary leading-relaxed select-text">
                {layoutConfig.strategy === "automatic" &&
                  "Uses a balanced square grid that adapts to the number of terminals (1-4 terminals use 2 columns, 5+ use up to 4 columns)."}
                {layoutConfig.strategy === "fixed-columns" &&
                  `Maintains exactly ${layoutConfig.value} column${layoutConfig.value > 1 ? "s" : ""}, adding new rows as you open more terminals.`}
                {layoutConfig.strategy === "fixed-rows" &&
                  `Maintains exactly ${layoutConfig.value} row${layoutConfig.value > 1 ? "s" : ""}, adding new columns as you open more terminals.`}
              </p>
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "scrollback" && (
          <SettingsSection
            title="Scrollback history"
            id="terminal-scrollback"
            description="Base scrollback applies to agent terminals. Shells and dev servers use reduced limits automatically. Background terminals may temporarily reduce scrollback under memory pressure."
            badge="New terminals"
          >
            <div
              className="grid grid-cols-4 gap-3"
              role="radiogroup"
              aria-label="Scrollback presets"
            >
              {SCROLLBACK_OPTIONS.map(({ value, label, description }) => (
                <button
                  key={value}
                  onClick={() => handleScrollbackChange(value)}
                  disabled={performanceMode}
                  role="radio"
                  aria-checked={scrollbackLines === value}
                  aria-label={`${label} - ${description}`}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-[var(--radius-md)] border transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                    performanceMode && "opacity-50 cursor-not-allowed",
                    scrollbackLines === value
                      ? "bg-overlay-selected border-border-strong text-text-primary font-medium"
                      : "border-border-default hover:bg-tint/5 text-text-secondary"
                  )}
                >
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-2xs mt-0.5 opacity-60">{description}</span>
                </button>
              ))}
            </div>

            <SettingsGroup
              label={`Effective limits per type${performanceMode ? " (performance mode)" : ""}`}
            >
              {scrollbackLimits.map(({ label, limit }) => (
                <SettingsRow
                  key={label}
                  label={label}
                  control={
                    <span className="font-mono text-xs text-text-secondary">
                      {limit.toLocaleString()} lines
                    </span>
                  }
                />
              ))}
            </SettingsGroup>

            <button
              onClick={() => setShowMemoryDetails(!showMemoryDetails)}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
              aria-expanded={showMemoryDetails}
              aria-controls="memory-details"
            >
              <ChevronDown
                className={cn("w-3 h-3 transition-transform", showMemoryDetails && "rotate-180")}
              />
              <span>Estimated memory usage</span>
            </button>

            {showMemoryDetails && (
              <SettingsGroup id="memory-details" label="Typical session (8 agents, 8 shells)">
                <SettingsRow
                  label="Agent terminals (8)"
                  control={
                    <span className="font-mono text-xs text-text-secondary">
                      {formatBytes(memoryEstimate.agent)}
                    </span>
                  }
                />
                <SettingsRow
                  label="Terminals (8)"
                  control={
                    <span className="font-mono text-xs text-text-secondary">
                      {formatBytes(memoryEstimate.plain)}
                    </span>
                  }
                />
                <SettingsRow
                  label="Total estimated"
                  control={
                    <span className="font-mono text-xs font-medium text-text-primary">
                      {formatBytes(memoryEstimate.total)}
                    </span>
                  }
                />
              </SettingsGroup>
            )}
          </SettingsSection>
        )}

        {effectiveSubtab === "accessibility" && (
          <SettingsSection
            title="Screen reader mode"
            id="terminal-screen-reader"
            description="Lets assistive technology read terminal output. Auto turns it on only while the OS reports an active screen reader."
          >
            <div
              className="grid grid-cols-3 gap-3"
              role="radiogroup"
              aria-label="Screen reader mode"
            >
              {(
                [
                  { value: "auto", label: "Auto", description: "Follow OS" },
                  { value: "on", label: "On", description: "Always enabled" },
                  { value: "off", label: "Off", description: "Disabled" },
                ] as const
              ).map(({ value, label, description }) => (
                <button
                  key={value}
                  onClick={() => handleScreenReaderModeChange(value)}
                  role="radio"
                  aria-checked={screenReaderMode === value}
                  aria-label={`${label} - ${description}`}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-[var(--radius-md)] border transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                    screenReaderMode === value
                      ? "bg-overlay-selected border-border-strong text-text-primary font-medium"
                      : "border-border-default hover:bg-tint/5 text-text-secondary"
                  )}
                >
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-2xs mt-0.5 opacity-60">{description}</span>
                </button>
              ))}
            </div>

            <p className="text-xs text-text-secondary leading-relaxed select-text">
              Screen reader mode adds an accessible DOM overlay to each terminal, which has a
              performance cost. For best results, only enable when using a screen reader.
            </p>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
