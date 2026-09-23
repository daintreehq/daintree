import { Fragment, useState, useMemo, useEffect } from "react";
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
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { logError, logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionId } from "@shared/types/actions";
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
import { computeHardwareDefaults, usePanelLimitStore } from "@/store/panelLimitStore";
import {
  useMemoryLeakConfigStore,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "@/store/memoryLeakConfigStore";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";
import { computeDefaultCachedViews } from "@shared/config/cachedProjectViews";
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

// Mirrors DEFAULT_LAYOUT_CONFIG in layoutConfigStore, which does not export it.
const DEFAULT_STRATEGY: PanelLayoutStrategy = "automatic";
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

type SaveGroup =
  "resources" | "project-views" | "input" | "grid-layout" | "scrollback" | "accessibility";

interface SaveFailure {
  group: SaveGroup;
  retry: () => void;
}

async function dispatchSetting(actionId: ActionId, args: unknown): Promise<void> {
  const result = await actionService.dispatch(actionId, args, { source: "user" });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

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
  // What the user is typing into the threshold while it is out of range. The
  // store keeps the value in effect; the field shows the draft and says why it
  // isn't applied, and leaving the field puts the effective value back.
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);

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
      { isAgent: true, label: "Agent terminals" },
      { isAgent: false, label: "Shells and dev servers" },
    ];
    return types.map(({ isAgent, label }) => ({
      label,
      limit: performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(isAgent, effectiveBase),
    }));
  }, [performanceMode, scrollbackLines]);

  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  // Every save here rolls its value back on failure (the actions do it themselves;
  // the direct IPC calls pass a rollback), so the banner only has to say so and
  // offer the same write again. `apply` is the whole operation — any optimistic
  // store update as well as the write — so Retry replays both, and a retry that
  // succeeds after a rollback leaves the page showing what was saved.
  const persist = async (
    group: SaveGroup,
    apply: () => Promise<unknown>,
    logMessage: string,
    rollback?: () => void
  ): Promise<void> => {
    try {
      await apply();
      setSaveFailure((current) => (current?.group === group ? null : current));
    } catch (error) {
      rollback?.();
      logError(logMessage, error);
      setSaveFailure({
        group,
        retry: () => void persist(group, apply, logMessage, rollback),
      });
    }
  };

  const saveError = (group: SaveGroup) =>
    saveFailure?.group === group ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message="The setting is back to its previous value."
        onRetry={saveFailure.retry}
      />
    ) : null;

  const handleScrollbackChange = (value: number) =>
    persist(
      "scrollback",
      () => dispatchSetting("terminalConfig.setScrollback", { scrollbackLines: value }),
      "Failed to persist scrollback setting"
    );

  const handleStrategyChange = (strategy: PanelLayoutStrategy) =>
    void persist(
      "grid-layout",
      () => dispatchSetting("panel.gridLayout.setStrategy", { strategy }),
      "Failed to persist grid layout strategy"
    );

  const handleValueChange = (val: string) => {
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 1 && num <= 10) {
      void persist(
        "grid-layout",
        () => dispatchSetting("panel.gridLayout.setValue", { value: num }),
        "Failed to persist grid layout value"
      );
    }
  };

  const setPerformanceMode = (value: boolean) =>
    persist(
      "resources",
      () => dispatchSetting("terminalConfig.setPerformanceMode", { performanceMode: value }),
      "Failed to persist performance mode setting"
    );

  const setResourceMonitoring = (value: boolean) => {
    const previous = resourceMonitoringEnabled;
    void persist(
      "resources",
      () => {
        setResourceMonitoringEnabled(value);
        return window.electron.terminalConfig.setResourceMonitoring(value);
      },
      "Failed to persist resource monitoring setting",
      () => setResourceMonitoringEnabled(previous)
    );
  };

  const setMemoryLeakDetection = (value: boolean) => {
    const previous = memoryLeakDetectionEnabled;
    void persist(
      "resources",
      () => {
        setMemoryLeakDetectionEnabled(value);
        return window.electron.terminalConfig.setMemoryLeakDetection(value);
      },
      "Failed to persist memory leak detection setting",
      () => setMemoryLeakDetectionEnabled(previous)
    );
  };

  const saveAutoRestartThreshold = (value: number, previous: number) => {
    void persist(
      "resources",
      () => {
        setAutoRestartThresholdMb(value);
        return window.electron.terminalConfig.setMemoryLeakAutoRestartThresholdMb(value);
      },
      "Failed to persist memory leak auto-restart threshold",
      () => setAutoRestartThresholdMb(previous)
    );
  };

  const setHybridInputEnabled = (enabled: boolean) =>
    persist(
      "input",
      () => dispatchSetting("terminalConfig.setHybridInputEnabled", { enabled }),
      "Failed to persist hybrid input setting"
    );

  const setHybridInputAutoFocus = (enabled: boolean) =>
    persist(
      "input",
      () => dispatchSetting("terminalConfig.setHybridInputAutoFocus", { enabled }),
      "Failed to persist hybrid input focus setting"
    );

  const handleScreenReaderModeChange = (mode: ScreenReaderMode) =>
    persist(
      "accessibility",
      () => dispatchSetting("terminalConfig.setScreenReaderMode", { mode }),
      "Failed to persist screen reader mode"
    );

  const handleCachedProjectViewsChange = (value: number) =>
    persist(
      "project-views",
      () => dispatchSetting("terminalConfig.setCachedProjectViews", { cachedProjectViews: value }),
      "Failed to persist cached project views setting"
    );

  // The same recommendation the bulk reset applies; unknown until the hardware
  // probe answers, and then no row claims to differ from it.
  const hardwareLimits =
    hardwareInfo && hardwareInfo.totalMemoryBytes > 0
      ? computeHardwareDefaults(hardwareInfo.totalMemoryBytes)
      : null;

  // Main reports the effective count (the stored value, else this same RAM
  // tier), so a count off the tier is one the user chose. Unknown until the
  // hardware probe answers.
  const defaultCachedViews =
    hardwareInfo && hardwareInfo.totalMemoryBytes > 0
      ? computeDefaultCachedViews(hardwareInfo.totalMemoryBytes)
      : null;

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
            {saveError("resources")}
            <SettingsGroup>
              <SettingsSwitchCard
                id="terminal-performance-mode"
                title="Performance mode"
                subtitle={`Cuts scrollback to ${PERFORMANCE_MODE_SCROLLBACK} lines and turns off animations, for low-end hardware or high-density workflows. Existing terminals keep their scrollback until respawned.`}
                isEnabled={performanceMode}
                onChange={() => void setPerformanceMode(!performanceMode)}
                ariaLabel="Performance Mode Toggle"
                isModified={performanceMode}
                onReset={() => void setPerformanceMode(false)}
                lifecycleBadge="New terminals"
              />

              <SettingsSwitchCard
                id="terminal-resource-monitoring"
                title="Resource monitoring"
                subtitle="Show per-terminal CPU and memory in panel headers. Polls the process tree every 2.5 seconds."
                isEnabled={resourceMonitoringEnabled}
                onChange={() => setResourceMonitoring(!resourceMonitoringEnabled)}
                ariaLabel="Resource Monitoring Toggle"
                isModified={resourceMonitoringEnabled}
                onReset={() => setResourceMonitoring(false)}
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
                  onChange={() => setMemoryLeakDetection(!memoryLeakDetectionEnabled)}
                  isModified={memoryLeakDetectionEnabled}
                  onReset={() => setMemoryLeakDetection(false)}
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
                    description="Restart a terminal automatically once its memory (RSS) passes this. 1,024–32,768 MB."
                    min={1024}
                    max={32768}
                    step={1024}
                    suffix="MB"
                    value={thresholdDraft ?? autoRestartThresholdMb}
                    error={
                      thresholdDraft !== null ? "Enter a value from 1,024 to 32,768 MB" : undefined
                    }
                    onBlur={() => setThresholdDraft(null)}
                    isModified={autoRestartThresholdMb !== DEFAULT_AUTO_RESTART_THRESHOLD_MB}
                    onReset={() => {
                      setThresholdDraft(null);
                      saveAutoRestartThreshold(
                        DEFAULT_AUTO_RESTART_THRESHOLD_MB,
                        autoRestartThresholdMb
                      );
                    }}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1024 && val <= 32768) {
                        setThresholdDraft(null);
                        saveAutoRestartThreshold(val, autoRestartThresholdMb);
                      } else {
                        setThresholdDraft(e.target.value);
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
                  isModified={
                    !!hardwareLimits && panelLimits.softWarningLimit !== hardwareLimits.soft
                  }
                  onReset={() => hardwareLimits && setSoftWarningLimit(hardwareLimits.soft)}
                  resetAriaLabel="Reset soft warning to the hardware-recommended value"
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
                  isModified={
                    !!hardwareLimits && panelLimits.confirmationLimit !== hardwareLimits.confirm
                  }
                  onReset={() => hardwareLimits && setConfirmationLimit(hardwareLimits.confirm)}
                  resetAriaLabel="Reset confirmation limit to the hardware-recommended value"
                />
              </SettingsDependents>

              <SettingsNumberInput
                label="Hard limit"
                description="Absolute maximum number of panels. Can't be bypassed."
                min={4}
                max={100}
                value={panelLimits.hardLimit}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) setPanelHardLimit(val);
                }}
                isModified={!!hardwareLimits && panelLimits.hardLimit !== hardwareLimits.hard}
                onReset={() => hardwareLimits && setPanelHardLimit(hardwareLimits.hard)}
                resetAriaLabel="Reset hard limit to the hardware-recommended value"
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
            {saveError("project-views")}
            <SettingsGroup>
              <SettingsPresetGroup
                id="terminal-cached-project-views"
                label="Cached project views"
                description={`Project views kept loaded in memory. More keeps switching back near-instant; fewer saves memory. ${
                  defaultCachedViews !== null
                    ? `Default on this machine: ${defaultCachedViews}.`
                    : "The default scales with your RAM."
                }`}
                options={CACHED_VIEWS_OPTIONS}
                value={cachedProjectViews}
                onChange={(value) => void handleCachedProjectViewsChange(value)}
                isModified={
                  defaultCachedViews !== null && cachedProjectViews !== defaultCachedViews
                }
                onReset={() =>
                  defaultCachedViews !== null &&
                  void handleCachedProjectViewsChange(defaultCachedViews)
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}

        {effectiveSubtab === "input" && (
          <SettingsSection title="Agent input">
            {saveError("input")}
            <SettingsGroup>
              <SettingsSwitchCard
                id="terminal-hybrid-input"
                title="Hybrid input bar"
                subtitle="Show the multi-line input bar at the bottom of agent terminals"
                isEnabled={hybridInputEnabled}
                onChange={() => void setHybridInputEnabled(!hybridInputEnabled)}
                isModified={!hybridInputEnabled}
                onReset={() => void setHybridInputEnabled(true)}
              />

              <SettingsDependents
                disabled={!hybridInputEnabled}
                reason="Turn on the hybrid input bar to choose where focus starts"
              >
                <SettingsSwitchCard
                  id="terminal-hybrid-autofocus"
                  title="Focus the input bar first"
                  subtitle="Agent panes start with the input bar focused instead of the terminal. Clicking either still wins, and Cmd-Opt-Arrow follows whichever you're using."
                  isEnabled={hybridInputAutoFocus}
                  onChange={() => void setHybridInputAutoFocus(!hybridInputAutoFocus)}
                  isModified={!hybridInputAutoFocus}
                  onReset={() => void setHybridInputAutoFocus(true)}
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
                  subtitle="When exactly two panels are open, show a resizable divider instead of equal columns. The ratio is remembered per worktree."
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
                    description="Used when a worktree has no saved ratio of its own. Default: 50/50."
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
                          className={cn(
                            "text-xs text-text-secondary font-mono w-12 text-right",
                            disabled && "opacity-50"
                          )}
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
              title="Grid layout"
              id="terminal-grid-layout"
              description="How panels arrange in the grid as you add more"
            >
              {saveError("grid-layout")}
              <SettingsGroup className="overflow-hidden">
                <SettingsRow
                  label="Strategy"
                  description={`Default: ${STRATEGIES.find((s) => s.id === DEFAULT_STRATEGY)?.label}`}
                  isModified={layoutConfig.strategy !== DEFAULT_STRATEGY}
                  onReset={() => handleStrategyChange(DEFAULT_STRATEGY)}
                  resetAriaLabel="Reset grid layout strategy to default"
                />
                <RadioChoiceGroup
                  legend="Grid layout strategy"
                  legendHidden
                  className="space-y-0 divide-y divide-border-subtle"
                >
                  {/* A fixed strategy's count sits directly under the choice it
                      configures, so the consequence and its setting read together. */}
                  {STRATEGIES.map(({ id, label, description }) => (
                    <Fragment key={id}>
                      <RadioChoiceRow
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
                      {id !== "automatic" && layoutConfig.strategy === id && (
                        <SettingsDependents>
                          <SettingsNumberInput
                            label={id === "fixed-columns" ? "Number of columns" : "Number of rows"}
                            description={
                              id === "fixed-columns"
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
                    </Fragment>
                  ))}
                </RadioChoiceGroup>
              </SettingsGroup>
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "scrollback" && (
          <SettingsSection
            title="Scrollback history"
            id="terminal-scrollback"
            description="Background terminals may temporarily reduce scrollback under memory pressure"
            badge="New terminals"
          >
            {saveError("scrollback")}
            <SettingsGroup>
              <SettingsPresetGroup
                label="Base scrollback"
                description={`Every terminal scales from this: agent terminals keep 10× it and shells 0.3×, within their own limits. Default: ${SCROLLBACK_DEFAULT.toLocaleString()}.`}
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
              label={`Lines each terminal keeps${performanceMode ? " (performance mode)" : ""}`}
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
                label="Estimated scrollback memory"
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
            {saveError("accessibility")}
            <SettingsGroup>
              <SettingsPresetGroup
                id="terminal-screen-reader"
                label="Screen reader mode"
                description="Makes terminal output readable by screen readers, at some performance cost. Auto turns it on while the OS reports a screen reader. Default: Auto."
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
