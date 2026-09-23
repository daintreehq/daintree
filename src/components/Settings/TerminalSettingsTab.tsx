import { useState, useMemo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsNumberInput } from "@/components/Settings/SettingsNumberInput";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import type { SettingsPresetOption } from "@/components/Settings/SettingsPresetGroup";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
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
import {
  useMemoryLeakConfigStore,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "@/store/memoryLeakConfigStore";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";
import type { HardwareInfo } from "@shared/types/ipc/system";

const STRATEGIES: Array<{
  id: PanelLayoutStrategy;
  label: string;
  description: string;
}> = [
  {
    id: "automatic",
    label: "Automatic",
    description:
      "A balanced grid that adapts to the terminal count: 1–4 terminals use 2 columns, 5 or more use up to 4",
  },
  {
    id: "fixed-columns",
    label: "Fixed columns",
    description: "Keeps a set number of columns and adds rows as you open more terminals",
  },
  {
    id: "fixed-rows",
    label: "Fixed rows",
    description: "Keeps a set number of rows and adds columns as you open more terminals",
  },
];

const DEFAULT_GRID_VALUE = 3;
const DEFAULT_SPLIT_RATIO = 0.5;

const SCROLLBACK_OPTIONS: readonly SettingsPresetOption<number>[] = [
  { value: 500, label: "500" },
  { value: 1000, label: "1,000" },
  { value: 2500, label: "2,500" },
  { value: 5000, label: "5,000" },
];

const CACHED_VIEWS_OPTIONS: readonly SettingsPresetOption<number>[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
];

const SCREEN_READER_OPTIONS: readonly SettingsPresetOption<ScreenReaderMode>[] = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

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
          <SettingsSection title="Terminal resources">
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
                    isModified={autoRestartThresholdMb !== DEFAULT_AUTO_RESTART_THRESHOLD_MB}
                    onReset={() => {
                      setAutoRestartThresholdMb(DEFAULT_AUTO_RESTART_THRESHOLD_MB);
                      safeFireAndForget(
                        window.electron.terminalConfig.setMemoryLeakAutoRestartThresholdMb(
                          DEFAULT_AUTO_RESTART_THRESHOLD_MB
                        ),
                        { context: "Resetting memory leak auto-restart threshold" }
                      );
                    }}
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
          <SettingsSection title="Project views">
            <SettingsGroup>
              <SettingsPresetGroup
                id="terminal-cached-project-views"
                label="Cached project views"
                description="Project views kept loaded in memory. More keeps switching back near-instant; fewer saves memory. The default scales with your RAM."
                options={CACHED_VIEWS_OPTIONS}
                value={cachedProjectViews}
                onChange={(value) => void handleCachedProjectViewsChange(value)}
              />
            </SettingsGroup>
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
                    description="Used when a worktree has no saved ratio of its own. Default: 50/50"
                    isModified={twoPaneSplitConfig.defaultRatio !== DEFAULT_SPLIT_RATIO}
                    onReset={() => setDefaultRatio(DEFAULT_SPLIT_RATIO)}
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
                          className="w-40 accent-[var(--color-text-primary)] disabled:opacity-50"
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
              <SettingsGroup className="overflow-hidden">
                <RadioChoiceGroup
                  legend="Grid layout strategy"
                  legendHidden
                  className="space-y-0 divide-y divide-border-subtle"
                >
                  {STRATEGIES.map(({ id, label, description }) => (
                    <RadioChoiceRow
                      key={id}
                      bare
                      name="gridLayoutStrategy"
                      value={id}
                      checked={layoutConfig.strategy === id}
                      onChange={() => handleStrategyChange(id)}
                      label={label}
                      description={description}
                      className={cn(
                        "px-4 py-3 transition-colors",
                        "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                        layoutConfig.strategy === id
                          ? "bg-overlay-selected"
                          : "hover:bg-overlay-soft"
                      )}
                    />
                  ))}
                </RadioChoiceGroup>

                {layoutConfig.strategy !== "automatic" && (
                  <SettingsDependents>
                    <SettingsNumberInput
                      label={
                        layoutConfig.strategy === "fixed-columns"
                          ? "Number of columns"
                          : "Number of rows"
                      }
                      description={
                        layoutConfig.strategy === "fixed-columns"
                          ? `Terminals stack vertically once this many columns are filled. Default: ${DEFAULT_GRID_VALUE}`
                          : `Terminals expand horizontally once this many rows are filled. Default: ${DEFAULT_GRID_VALUE}`
                      }
                      min={1}
                      max={10}
                      value={layoutConfig.value}
                      onChange={(e) => handleValueChange(e.target.value)}
                      isModified={layoutConfig.value !== DEFAULT_GRID_VALUE}
                      onReset={() => handleValueChange(String(DEFAULT_GRID_VALUE))}
                    />
                  </SettingsDependents>
                )}
              </SettingsGroup>
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "scrollback" && (
          <SettingsSection
            title="Scrollback history"
            id="terminal-scrollback"
            description="Background terminals may temporarily reduce scrollback under memory pressure."
            badge="New terminals"
          >
            <SettingsGroup>
              <SettingsPresetGroup
                label="Base scrollback"
                description={`Lines kept for agent terminals. Shells and dev servers use reduced limits automatically. Default: ${SCROLLBACK_DEFAULT.toLocaleString()} lines`}
                options={SCROLLBACK_OPTIONS}
                value={scrollbackLines}
                onChange={(value) => void handleScrollbackChange(value)}
                disabled={performanceMode}
                disabledReason={`Performance mode caps scrollback at ${PERFORMANCE_MODE_SCROLLBACK} lines`}
                isModified={scrollbackLines !== SCROLLBACK_DEFAULT}
                onReset={() => void handleScrollbackChange(SCROLLBACK_DEFAULT)}
              />
            </SettingsGroup>

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

            <SettingsGroup id="memory-details">
              <SettingsRow
                label="Estimated memory"
                description={`A typical session of ${TYPICAL_TERMINAL_COUNTS.agent} agents (${formatBytes(memoryEstimate.agent)}) and ${TYPICAL_TERMINAL_COUNTS.plain} terminals (${formatBytes(memoryEstimate.plain)})`}
                control={
                  <span className="font-mono text-xs font-medium text-text-primary">
                    {formatBytes(memoryEstimate.total)}
                  </span>
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}

        {effectiveSubtab === "accessibility" && (
          <SettingsSection title="Assistive technology">
            <SettingsGroup>
              <SettingsPresetGroup
                id="terminal-screen-reader"
                label="Screen reader mode"
                description="Lets assistive technology read terminal output through an overlay that costs some performance. Auto turns it on only while the OS reports an active screen reader. Default: Auto"
                options={SCREEN_READER_OPTIONS}
                value={screenReaderMode}
                onChange={(mode) => void handleScreenReaderModeChange(mode)}
                isModified={screenReaderMode !== "auto"}
                onReset={() => void handleScreenReaderModeChange("auto")}
              />
            </SettingsGroup>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
