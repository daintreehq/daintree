import {
  LayoutGrid,
  Columns,
  Rows,
  AlertTriangle,
  Zap,
  HardDrive,
  ChevronDown,
  MessageSquare,
  MousePointerClick,
  SplitSquareHorizontal,
  Monitor,
  RotateCcw,
} from "lucide-react";
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsSubtabBar } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import {
  useLayoutConfigStore,
  usePerformanceModeStore,
  useScrollbackStore,
  useTerminalInputStore,
  useTwoPaneSplitStore,
} from "@/store";
import type { PanelLayoutStrategy, TerminalType } from "@/types";
import {
  getScrollbackForType,
  estimateMemoryUsage,
  formatBytes,
  PERFORMANCE_MODE_SCROLLBACK,
} from "@/utils/scrollbackConfig";
import { actionService } from "@/services/ActionService";

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
    label: "Fixed Columns",
    description: "Vertical Scroll",
    icon: Columns,
  },
  {
    id: "fixed-rows",
    label: "Fixed Rows",
    description: "Horizontal Expand",
    icon: Rows,
  },
];

const SCROLLBACK_OPTIONS = [
  { value: 1000, label: "1,000 lines", description: "Low memory" },
  { value: 2500, label: "2,500 lines", description: "Balanced" },
  { value: 5000, label: "5,000 lines", description: "Extended" },
  { value: 10000, label: "10,000 lines", description: "Full history" },
] as const;

const TYPICAL_TERMINAL_COUNTS: Partial<Record<TerminalType, number>> = {
  claude: 2,
  gemini: 2,
  codex: 2,
  opencode: 2,
  terminal: 8,
};

const TERMINAL_SUBTABS: SettingsSubtabItem[] = [
  { id: "performance", label: "Performance" },
  { id: "input", label: "Input" },
  { id: "layout", label: "Layout" },
  { id: "scrollback", label: "Scrollback" },
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

  const twoPaneSplitConfig = useTwoPaneSplitStore((state) => state.config);
  const setTwoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.setEnabled);
  const setPreferPreview = useTwoPaneSplitStore((state) => state.setPreferPreview);
  const setDefaultRatio = useTwoPaneSplitStore((state) => state.setDefaultRatio);
  const resetAllWorktreeRatios = useTwoPaneSplitStore((state) => state.resetAllWorktreeRatios);

  const [showMemoryDetails, setShowMemoryDetails] = useState(false);

  const memoryEstimate = useMemo(() => {
    const base = performanceMode ? PERFORMANCE_MODE_SCROLLBACK : scrollbackLines;
    return estimateMemoryUsage(TYPICAL_TERMINAL_COUNTS, base);
  }, [performanceMode, scrollbackLines]);

  const scrollbackLimits = useMemo(() => {
    const effectiveBase = performanceMode ? PERFORMANCE_MODE_SCROLLBACK : scrollbackLines;
    const types: Array<{ type: TerminalType; label: string }> = [
      { type: "claude", label: "Agent (Claude/Gemini/Codex/OpenCode)" },
      { type: "terminal", label: "Terminal" },
    ];
    return types.map(({ type, label }) => ({
      label,
      limit: performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(type, effectiveBase),
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
      console.error("Failed to persist scrollback setting:", error);
    }
  };

  const handleStrategyChange = (strategy: PanelLayoutStrategy) => {
    void actionService.dispatch(
      "terminal.gridLayout.setStrategy",
      { strategy },
      { source: "user" }
    );
  };

  const handleValueChange = (val: string) => {
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 1 && num <= 10) {
      void actionService.dispatch(
        "terminal.gridLayout.setValue",
        { value: num },
        { source: "user" }
      );
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
      console.error("Failed to persist performance mode setting:", error);
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
      console.error("Failed to persist hybrid input setting:", error);
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
      console.error("Failed to persist hybrid input focus setting:", error);
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
      />

      {effectiveSubtab === "performance" && (
        <SettingsSection
          icon={Zap}
          title="Performance Mode"
          id="terminal-performance-mode"
          description={`Manual safe mode for low-end hardware or high-density workflows. Reduces scrollback to ${PERFORMANCE_MODE_SCROLLBACK} lines and disables animations for maximum performance.`}
          iconColor="text-status-warning"
        >
          <SettingsSwitchCard
            icon={Zap}
            title={performanceMode ? "Performance Mode Enabled" : "Enable Performance Mode"}
            subtitle={
              performanceMode
                ? `${PERFORMANCE_MODE_SCROLLBACK} line scrollback, animations disabled`
                : "Standard scrollback, animations enabled"
            }
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
            lifecycleBadge="New Terminals"
          />

          {performanceMode && (
            <p className="text-xs text-status-warning/80 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              New terminals will use reduced scrollback. Existing terminals are unchanged until
              respawned.
            </p>
          )}
        </SettingsSection>
      )}

      {effectiveSubtab === "input" && (
        <SettingsSection
          icon={MessageSquare}
          title="Hybrid Input Bar"
          id="terminal-hybrid-input"
          description="Configure the bottom input bar used for agent terminals."
        >
          <SettingsSwitchCard
            icon={MessageSquare}
            title={hybridInputEnabled ? "Hybrid Input Enabled" : "Enable Hybrid Input"}
            subtitle={
              hybridInputEnabled
                ? "Show the multi-line input bar on agent terminals"
                : "Hide the input bar and use the terminal directly"
            }
            isEnabled={hybridInputEnabled}
            onChange={handleHybridInputEnabledToggle}
            ariaLabel="Hybrid Input Bar Toggle"
            isModified={!hybridInputEnabled}
            onReset={() =>
              void actionService.dispatch(
                "terminalConfig.setHybridInputEnabled",
                { enabled: true },
                { source: "user" }
              )
            }
          />

          <div className="ml-4 border-l-2 border-canopy-border pl-4">
            <SettingsSwitchCard
              icon={MousePointerClick}
              title={hybridInputAutoFocus ? "Auto-Focus Input" : "Auto-Focus Terminal"}
              subtitle={
                hybridInputAutoFocus
                  ? "Selecting a pane focuses the input bar"
                  : "Selecting a pane focuses the terminal (xterm)"
              }
              isEnabled={hybridInputAutoFocus}
              onChange={handleHybridInputAutoFocusToggle}
              ariaLabel="Hybrid Input Auto Focus Toggle"
              isModified={!hybridInputAutoFocus}
              onReset={() =>
                void actionService.dispatch(
                  "terminalConfig.setHybridInputAutoFocus",
                  { enabled: true },
                  { source: "user" }
                )
              }
              disabled={!hybridInputEnabled}
            />
          </div>
        </SettingsSection>
      )}

      {effectiveSubtab === "layout" && (
        <div className="space-y-6">
          <SettingsSection
            icon={SplitSquareHorizontal}
            title="Two-Pane Split Layout"
            id="terminal-two-pane-split"
            description="When exactly two panels are open, display them with a resizable divider instead of equal columns. The split ratio is remembered per worktree."
          >
            <SettingsSwitchCard
              icon={SplitSquareHorizontal}
              title={
                twoPaneSplitConfig.enabled ? "Two-Pane Split Enabled" : "Enable Two-Pane Split"
              }
              subtitle={
                twoPaneSplitConfig.enabled
                  ? "Drag divider to resize, double-click to reset"
                  : "Use equal-width grid for two panels"
              }
              isEnabled={twoPaneSplitConfig.enabled}
              onChange={() => setTwoPaneSplitEnabled(!twoPaneSplitConfig.enabled)}
              ariaLabel="Two-Pane Split Toggle"
              isModified={!twoPaneSplitConfig.enabled}
              onReset={() => setTwoPaneSplitEnabled(true)}
            />

            <div className="ml-4 space-y-3 border-l-2 border-canopy-border pl-4">
              <SettingsSwitchCard
                icon={Monitor}
                title={
                  twoPaneSplitConfig.preferPreview ? "Preview-Focused Layout" : "Balanced Layout"
                }
                subtitle={
                  twoPaneSplitConfig.preferPreview
                    ? "Give more space to browser/dev-preview panels (65/35)"
                    : "Start with equal space for both panels (50/50)"
                }
                isEnabled={twoPaneSplitConfig.preferPreview}
                onChange={() => setPreferPreview(!twoPaneSplitConfig.preferPreview)}
                ariaLabel="Prefer Preview Toggle"
                isModified={twoPaneSplitConfig.preferPreview}
                onReset={() => setPreferPreview(false)}
                disabled={!twoPaneSplitConfig.enabled}
              />

              <div
                className={cn(
                  "space-y-2",
                  !twoPaneSplitConfig.enabled && "opacity-50 pointer-events-none"
                )}
              >
                <label htmlFor="default-ratio-slider" className="text-sm text-canopy-text/70">
                  Default Ratio
                </label>
                <div className="flex items-center gap-4">
                  <input
                    id="default-ratio-slider"
                    type="range"
                    min="20"
                    max="80"
                    value={Math.round(twoPaneSplitConfig.defaultRatio * 100)}
                    onChange={(e) => setDefaultRatio(Number(e.target.value) / 100)}
                    aria-valuetext={`${Math.round(twoPaneSplitConfig.defaultRatio * 100)} percent left, ${Math.round((1 - twoPaneSplitConfig.defaultRatio) * 100)} percent right`}
                    className="flex-1 accent-canopy-accent"
                    disabled={!twoPaneSplitConfig.enabled}
                  />
                  <span
                    className="text-xs text-canopy-text/70 font-mono w-16 text-right"
                    aria-hidden="true"
                  >
                    {Math.round(twoPaneSplitConfig.defaultRatio * 100)}/
                    {Math.round((1 - twoPaneSplitConfig.defaultRatio) * 100)}
                  </span>
                </div>
                <p className="text-xs text-canopy-text/40">
                  Default split ratio when no worktree-specific ratio is saved.
                </p>
              </div>

              <button
                onClick={resetAllWorktreeRatios}
                disabled={!twoPaneSplitConfig.enabled}
                className={cn(
                  "flex items-center gap-2 text-xs text-canopy-text/50 transition-colors",
                  twoPaneSplitConfig.enabled
                    ? "hover:text-canopy-text/70"
                    : "opacity-50 cursor-not-allowed"
                )}
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset all worktree split ratios</span>
              </button>
            </div>
          </SettingsSection>

          <SettingsSection
            icon={LayoutGrid}
            title="Grid Layout Strategy"
            id="terminal-grid-layout"
            description="Control how panels arrange in the grid as you add more."
          >
            <div className="grid grid-cols-3 gap-3">
              {STRATEGIES.map(({ id, label, description, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => handleStrategyChange(id)}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-[var(--radius-md)] border transition-all",
                    layoutConfig.strategy === id
                      ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                      : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
                  )}
                >
                  <Icon className="w-6 h-6 mb-2" />
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-[11px] text-center mt-1 opacity-60">{description}</span>
                </button>
              ))}
            </div>

            {layoutConfig.strategy !== "automatic" && (
              <div className="space-y-2">
                <label className="text-sm text-canopy-text/70">
                  {layoutConfig.strategy === "fixed-columns"
                    ? "Number of Columns"
                    : "Number of Rows"}
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={layoutConfig.value}
                  onChange={(e) => handleValueChange(e.target.value)}
                  className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text w-full focus:border-canopy-accent focus:outline-none transition-colors"
                />
                <p className="text-xs text-canopy-text/40">
                  {layoutConfig.strategy === "fixed-columns"
                    ? "Terminals will stack vertically when this many columns are filled."
                    : "Terminals will expand horizontally when this many rows are filled."}
                </p>
              </div>
            )}

            <p className="text-xs text-canopy-text/40 leading-relaxed">
              {layoutConfig.strategy === "automatic" &&
                "Uses a balanced square grid that adapts to the number of terminals (1-4 terminals use 2 columns, 5+ use up to 4 columns)."}
              {layoutConfig.strategy === "fixed-columns" &&
                `Maintains exactly ${layoutConfig.value} column${layoutConfig.value > 1 ? "s" : ""}, adding new rows as you open more terminals.`}
              {layoutConfig.strategy === "fixed-rows" &&
                `Maintains exactly ${layoutConfig.value} row${layoutConfig.value > 1 ? "s" : ""}, adding new columns as you open more terminals.`}
            </p>
          </SettingsSection>
        </div>
      )}

      {effectiveSubtab === "scrollback" && (
        <SettingsSection
          icon={HardDrive}
          title="Scrollback History"
          id="terminal-scrollback"
          description="Base scrollback applies to agent terminals. Shells and dev servers use reduced limits automatically."
          badge="New Terminals"
        >
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Scrollback presets">
            {SCROLLBACK_OPTIONS.map(({ value, label, description }) => (
              <button
                key={value}
                onClick={() => handleScrollbackChange(value)}
                disabled={performanceMode}
                role="radio"
                aria-checked={scrollbackLines === value}
                aria-label={`${label} - ${description}`}
                className={cn(
                  "flex flex-col items-center justify-center p-3 rounded-[var(--radius-md)] border transition-all",
                  performanceMode && "opacity-50 cursor-not-allowed",
                  scrollbackLines === value
                    ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                    : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
                )}
              >
                <span className="text-xs font-medium">{label}</span>
                <span className="text-[11px] mt-0.5 opacity-60">{description}</span>
              </button>
            ))}
          </div>

          <div className="text-xs text-canopy-text/50 space-y-1.5 bg-canopy-bg/50 rounded-[var(--radius-md)] p-3">
            <div className="font-medium text-canopy-text/70 mb-2">
              Effective limits per type{performanceMode ? " (performance mode)" : ""}:
            </div>
            {scrollbackLimits.map(({ label, limit }) => (
              <div key={label} className="flex justify-between">
                <span>{label}</span>
                <span className="font-mono text-canopy-text/70">
                  {limit.toLocaleString()} lines
                </span>
              </div>
            ))}
          </div>

          <button
            onClick={() => setShowMemoryDetails(!showMemoryDetails)}
            className="flex items-center gap-1.5 text-xs text-canopy-text/50 hover:text-canopy-text/70 transition-colors"
            aria-expanded={showMemoryDetails}
            aria-controls="memory-details"
          >
            <ChevronDown
              className={cn("w-3 h-3 transition-transform", showMemoryDetails && "rotate-180")}
            />
            <span>Estimated memory usage</span>
          </button>

          {showMemoryDetails && (
            <div
              id="memory-details"
              className="text-xs text-canopy-text/50 space-y-1.5 bg-canopy-bg/50 rounded-[var(--radius-md)] p-3"
            >
              <div className="font-medium text-canopy-text/70 mb-2">
                Typical session (6 agents, 6 shells, 2 dev servers):
              </div>
              <div className="flex justify-between">
                <span>Agent terminals (6)</span>
                <span className="font-mono text-canopy-text/70">
                  {formatBytes(
                    (memoryEstimate.perType.claude ?? 0) +
                      (memoryEstimate.perType.gemini ?? 0) +
                      (memoryEstimate.perType.codex ?? 0)
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Terminals (8)</span>
                <span className="font-mono text-canopy-text/70">
                  {formatBytes(memoryEstimate.perType.terminal ?? 0)}
                </span>
              </div>
              <div className="flex justify-between pt-1.5 border-t border-canopy-border mt-1.5">
                <span className="font-medium text-canopy-text/70">Total estimated</span>
                <span className="font-mono font-medium text-canopy-accent">
                  {formatBytes(memoryEstimate.total)}
                </span>
              </div>
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}
