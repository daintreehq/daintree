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
  { value: 5000, label: "5,000 lines", description: "Balanced" },
  { value: 10000, label: "10,000 lines", description: "Full history" },
] as const;

const TYPICAL_TERMINAL_COUNTS: Partial<Record<TerminalType, number>> = {
  claude: 2,
  gemini: 2,
  codex: 2,
  opencode: 2,
  terminal: 8,
};

export function TerminalSettingsTab() {
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

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500" />
            Performance Mode
          </h4>
          <p className="text-xs text-canopy-text/50 mb-4">
            Manual safe mode for low-end hardware or high-density workflows. Reduces scrollback to
            {` ${PERFORMANCE_MODE_SCROLLBACK} lines and disables animations for maximum performance.`}
          </p>
        </div>

        <button
          onClick={handlePerformanceModeToggle}
          role="switch"
          aria-checked={performanceMode}
          aria-label="Performance Mode Toggle"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            performanceMode
              ? "bg-amber-500/10 border-amber-500 text-amber-500"
              : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
          )}
        >
          <div className="flex items-center gap-3">
            <Zap
              className={cn("w-5 h-5", performanceMode ? "text-amber-500" : "text-canopy-text/50")}
            />
            <div className="text-left">
              <div className="text-sm font-medium">
                {performanceMode ? "Performance Mode Enabled" : "Enable Performance Mode"}
              </div>
              <div className="text-xs opacity-70">
                {performanceMode
                  ? `${PERFORMANCE_MODE_SCROLLBACK} line scrollback, animations disabled`
                  : "Standard scrollback, animations enabled"}
              </div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              performanceMode ? "bg-amber-500" : "bg-canopy-border"
            )}
            aria-hidden="true"
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                performanceMode ? "translate-x-6" : "translate-x-1"
              )}
            />
          </div>
        </button>

        {performanceMode && (
          <p className="text-xs text-amber-500/80 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" />
            New terminals will use reduced scrollback. Existing terminals are unchanged until
            respawned.
          </p>
        )}
      </div>

      <div className="pt-4 border-t border-canopy-border space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-canopy-accent" />
            Hybrid Input Bar
          </h4>
          <p className="text-xs text-canopy-text/50 mb-4">
            Configure the bottom input bar used for agent terminals.
          </p>
        </div>

        <button
          onClick={handleHybridInputEnabledToggle}
          role="switch"
          aria-checked={hybridInputEnabled}
          aria-label="Hybrid Input Bar Toggle"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            hybridInputEnabled
              ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
              : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
          )}
        >
          <div className="flex items-center gap-3">
            <MessageSquare
              className={cn(
                "w-5 h-5",
                hybridInputEnabled ? "text-canopy-accent" : "text-canopy-text/50"
              )}
            />
            <div className="text-left">
              <div className="text-sm font-medium">
                {hybridInputEnabled ? "Hybrid Input Enabled" : "Enable Hybrid Input"}
              </div>
              <div className="text-xs opacity-70">
                {hybridInputEnabled
                  ? "Show the multi-line input bar on agent terminals"
                  : "Hide the input bar and use the terminal directly"}
              </div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              hybridInputEnabled ? "bg-canopy-accent" : "bg-canopy-border"
            )}
            aria-hidden="true"
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                hybridInputEnabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </div>
        </button>

        {hybridInputEnabled && (
          <button
            onClick={handleHybridInputAutoFocusToggle}
            role="switch"
            aria-checked={hybridInputAutoFocus}
            aria-label="Hybrid Input Auto Focus Toggle"
            className={cn(
              "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
              hybridInputAutoFocus
                ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
            )}
          >
            <div className="flex items-center gap-3">
              <MousePointerClick
                className={cn(
                  "w-5 h-5",
                  hybridInputAutoFocus ? "text-canopy-accent" : "text-canopy-text/50"
                )}
              />
              <div className="text-left">
                <div className="text-sm font-medium">
                  {hybridInputAutoFocus ? "Auto-Focus Input" : "Auto-Focus Terminal"}
                </div>
                <div className="text-xs opacity-70">
                  {hybridInputAutoFocus
                    ? "Selecting a pane focuses the input bar"
                    : "Selecting a pane focuses the terminal (xterm)"}
                </div>
              </div>
            </div>
            <div
              className={cn(
                "w-11 h-6 rounded-full relative transition-colors",
                hybridInputAutoFocus ? "bg-canopy-accent" : "bg-canopy-border"
              )}
              aria-hidden="true"
            >
              <div
                className={cn(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  hybridInputAutoFocus ? "translate-x-6" : "translate-x-1"
                )}
              />
            </div>
          </button>
        )}
      </div>

      <div className="pt-4 border-t border-canopy-border space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
            <SplitSquareHorizontal className="w-4 h-4 text-canopy-accent" />
            Two-Pane Split Layout
          </h4>
          <p className="text-xs text-canopy-text/50 mb-4">
            When exactly two panels are open, display them with a resizable divider instead of equal
            columns. The split ratio is remembered per worktree.
          </p>
        </div>

        <button
          onClick={() => setTwoPaneSplitEnabled(!twoPaneSplitConfig.enabled)}
          role="switch"
          aria-checked={twoPaneSplitConfig.enabled}
          aria-label="Two-Pane Split Toggle"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            twoPaneSplitConfig.enabled
              ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
              : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
          )}
        >
          <div className="flex items-center gap-3">
            <SplitSquareHorizontal
              className={cn(
                "w-5 h-5",
                twoPaneSplitConfig.enabled ? "text-canopy-accent" : "text-canopy-text/50"
              )}
            />
            <div className="text-left">
              <div className="text-sm font-medium">
                {twoPaneSplitConfig.enabled
                  ? "Two-Pane Split Enabled"
                  : "Enable Two-Pane Split"}
              </div>
              <div className="text-xs opacity-70">
                {twoPaneSplitConfig.enabled
                  ? "Drag divider to resize, double-click to reset"
                  : "Use equal-width grid for two panels"}
              </div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              twoPaneSplitConfig.enabled ? "bg-canopy-accent" : "bg-canopy-border"
            )}
            aria-hidden="true"
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                twoPaneSplitConfig.enabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </div>
        </button>

        {twoPaneSplitConfig.enabled && (
          <>
            <button
              onClick={() => setPreferPreview(!twoPaneSplitConfig.preferPreview)}
              role="switch"
              aria-checked={twoPaneSplitConfig.preferPreview}
              aria-label="Prefer Preview Toggle"
              className={cn(
                "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                twoPaneSplitConfig.preferPreview
                  ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                  : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
              )}
            >
              <div className="flex items-center gap-3">
                <Monitor
                  className={cn(
                    "w-5 h-5",
                    twoPaneSplitConfig.preferPreview ? "text-canopy-accent" : "text-canopy-text/50"
                  )}
                />
                <div className="text-left">
                  <div className="text-sm font-medium">
                    {twoPaneSplitConfig.preferPreview
                      ? "Preview-Focused Layout"
                      : "Balanced Layout"}
                  </div>
                  <div className="text-xs opacity-70">
                    {twoPaneSplitConfig.preferPreview
                      ? "Give more space to browser/dev-preview panels (65/35)"
                      : "Start with equal space for both panels (50/50)"}
                  </div>
                </div>
              </div>
              <div
                className={cn(
                  "w-11 h-6 rounded-full relative transition-colors",
                  twoPaneSplitConfig.preferPreview ? "bg-canopy-accent" : "bg-canopy-border"
                )}
                aria-hidden="true"
              >
                <div
                  className={cn(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    twoPaneSplitConfig.preferPreview ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </div>
            </button>

            <div className="space-y-2">
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
                />
                <span className="text-xs text-canopy-text/70 font-mono w-16 text-right" aria-hidden="true">
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
              className="flex items-center gap-2 text-xs text-canopy-text/50 hover:text-canopy-text/70 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset all worktree split ratios</span>
            </button>
          </>
        )}
      </div>

      <div className="pt-4 border-t border-canopy-border space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-canopy-accent" />
            Scrollback History
          </h4>
          <p className="text-xs text-canopy-text/50 mb-4">
            Base scrollback applies to agent terminals. Shells and dev servers use reduced limits
            automatically.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Scrollback presets">
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
              <span className="font-mono text-canopy-text/70">{limit.toLocaleString()} lines</span>
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
      </div>

      <div className="pt-4 border-t border-canopy-border">
        <h4 className="text-sm font-medium text-canopy-text mb-2">Grid Layout Strategy</h4>
        <p className="text-xs text-canopy-text/50 mb-4">
          Control how panels arrange in the grid as you add more.
        </p>
      </div>

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
            {layoutConfig.strategy === "fixed-columns" ? "Number of Columns" : "Number of Rows"}
          </label>
          <input
            type="number"
            min="1"
            max="10"
            value={layoutConfig.value}
            onChange={(e) => handleValueChange(e.target.value)}
            className="bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-canopy-text w-full focus:border-canopy-accent focus:outline-none transition-colors"
          />
          <p className="text-xs text-canopy-text/40">
            {layoutConfig.strategy === "fixed-columns"
              ? "Terminals will stack vertically when this many columns are filled."
              : "Terminals will expand horizontally when this many rows are filled."}
          </p>
        </div>
      )}

      <div className="pt-4 border-t border-canopy-border">
        <h5 className="text-xs font-medium text-canopy-text mb-2">Current Strategy</h5>
        <p className="text-xs text-canopy-text/50 leading-relaxed">
          {layoutConfig.strategy === "automatic" &&
            "Uses a balanced square grid that adapts to the number of terminals (1-4 terminals use 2 columns, 5+ use up to 4 columns)."}
          {layoutConfig.strategy === "fixed-columns" &&
            `Maintains exactly ${layoutConfig.value} column${layoutConfig.value > 1 ? "s" : ""}, adding new rows as you open more terminals.`}
          {layoutConfig.strategy === "fixed-rows" &&
            `Maintains exactly ${layoutConfig.value} row${layoutConfig.value > 1 ? "s" : ""}, adding new columns as you open more terminals.`}
        </p>
      </div>
    </div>
  );
}
