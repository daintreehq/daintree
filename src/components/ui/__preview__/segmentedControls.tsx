// Imported FIRST so the bridge shim exists before any module reaches for
// `window.electron` at evaluation time (the theme browser and pulse card both do).
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
installPreviewShims();

import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { HeatCell, ProjectPulse, PulseRangeDays } from "@shared/types/pulse";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { QuickStateFilterBar } from "@/components/Worktree/QuickStateFilterBar";
import { QuickStateArmButton } from "@/components/Worktree/QuickStateArmButton";
import { PilotFilterBar } from "@/components/Pilot/PilotFilterBar";
import { ThemeBrowser } from "@/components/ThemeBrowser/ThemeBrowser";
import { ProjectPulseCard } from "@/components/Pulse/ProjectPulseCard";
import { usePulseStore } from "@/store";
import { emptyBandCounts } from "@/lib/fleetAttention";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import type { PilotBandFilter } from "@/components/Pilot/pilotRows";
import "@/index.css";

/**
 * Visual-review harness for every single-choice segmented control in the app.
 *
 * One page, one specimen per consumer, each drawn on the surface its consumer
 * actually sits on and with the options, density, disabled segments and widths
 * that consumer passes. The shared-primitive consumers (diff pane, review hub,
 * plugin surface strip, prompt history, image diff, file toolbar, settings) are
 * rendered through the primitive with their real props; the controls that live
 * inside a larger component (theme browser, pulse card, both quick-state filter
 * bars) are the REAL component, mounted against seeded stores. The fleet
 * picker's commit-mode switch is captured from the fleet preview instead.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib|...   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const WORKTREE_ID = "wt-preview";

function heatmap(): HeatCell[] {
  const cells: HeatCell[] = [];
  const today = new Date("2026-09-28T12:00:00Z");
  for (let i = 59; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const count = (i * 7) % 5 === 0 ? 0 : (i * 13) % 9;
    const level: HeatCell["level"] =
      count === 0 ? 0 : count < 3 ? 1 : count < 5 ? 2 : count < 7 ? 3 : 4;
    cells.push({ date: d.toISOString().slice(0, 10), count, level, isToday: i === 0 });
  }
  return cells;
}

const PULSE: ProjectPulse = {
  worktreeId: WORKTREE_ID,
  worktreePath: "/Users/preview/daintree",
  branch: "develop",
  mainBranch: "main",
  rangeDays: 60,
  generatedAt: Date.parse("2026-09-28T11:58:00Z"),
  heatmap: heatmap(),
  commitsInRange: 214,
  activeDays: 41,
  projectAgeDays: 400,
  currentStreakDays: 6,
  recentCommits: [],
};

usePulseStore.setState({
  pulses: new Map([[WORKTREE_ID, PULSE]]),
  rangeDays: 60 as PulseRangeDays,
  // The card fetches on mount; the harness answers from the seed instead.
  fetchPulse: async () => PULSE,
  setRangeDays: (days: PulseRangeDays) =>
    usePulseStore.setState({
      rangeDays: days,
      pulses: new Map([[WORKTREE_ID, { ...PULSE, rangeDays: days }]]),
    }),
});

/**
 * The primitive every shared-toggle consumer renders, with the props that
 * consumer passes. The harness is the only thing that knows which primitive is
 * current, so a migration edits this one adapter, not every specimen.
 */
interface ToggleOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  ariaLabel?: string;
  tooltip?: string;
}

function Toggle<T extends string>({
  options,
  initial,
  label,
  density,
  className,
}: {
  options: ToggleOption<T>[];
  initial: T;
  label: string;
  density?: "default" | "compact";
  className?: string;
}) {
  const [value, setValue] = useState<T>(initial);
  return (
    <SegmentedRadioGroup<T>
      options={options}
      value={value}
      onChange={setValue}
      aria-label={label}
      density={density}
      className={className}
    />
  );
}

function Specimen({
  id,
  title,
  surface,
  width,
  children,
}: {
  id: string;
  title: string;
  surface: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <section data-shot={id} className="flex flex-col gap-1.5 p-3" style={{ width }}>
      <div data-harness-decoration className="text-2xs text-text-muted">
        {title}
      </div>
      <div className={surface}>{children}</div>
    </section>
  );
}

const TOOLBAR = "flex h-8 items-center gap-2 border border-border-default bg-surface-panel px-2";

const SCOPE_OPTIONS: SegmentedRadioOption<"global" | "project">[] = [
  { value: "global", label: "Global" },
  { value: "project", label: "Project" },
];

const DENSITY_OPTIONS: SegmentedRadioOption<"compact" | "comfortable" | "spacious">[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
];

function Gallery() {
  const [quick, setQuick] = useState<QuickStateFilter>("working");
  const [pilot, setPilot] = useState<PilotBandFilter>("all");
  const pilotCounts: Record<PilotBandFilter, number> = {
    all: 9,
    "needs-you": 2,
    quiet: 1,
    working: 3,
    finished: 2,
    parked: 1,
    other: 0,
  };
  const bands = { ...emptyBandCounts(), working: 3 };
  const [scope, setScope] = useState<"global" | "project">("project");
  const [density, setDensity] = useState<"compact" | "comfortable" | "spacious">("comfortable");

  return (
    <div
      data-preview-shell
      className="flex flex-wrap items-start gap-2 p-2"
      style={{ width: 1180 }}
    >
      <Specimen
        id="settings"
        title="Settings — scope switch + full-width preset (canonical)"
        surface="settings-card flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-border-default p-3"
        width={380}
      >
        <SegmentedRadioGroup
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
          aria-label="Settings scope"
        />
        <SegmentedRadioGroup
          options={DENSITY_OPTIONS}
          value={density}
          onChange={setDensity}
          aria-label="Dock density"
          fullWidth
        />
      </Specimen>

      <Specimen
        id="diff-pane"
        title="Diff pane toolbar — scope + layout"
        surface={TOOLBAR}
        width={420}
      >
        <Toggle
          label="Diff content"
          density="compact"
          initial="changes"
          options={[
            { value: "changes", label: "Changes" },
            { value: "full-file", label: "Full file", disabled: true },
          ]}
        />
        <Toggle
          label="Diff layout"
          density="compact"
          initial="split"
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
            { value: "rendered", label: "Rendered" },
          ]}
        />
      </Specimen>

      <Specimen id="review-hub" title="Review hub — diff mode" surface={TOOLBAR} width={300}>
        <Toggle
          label="Diff mode"
          density="compact"
          initial="working-tree"
          options={[
            { value: "working-tree", label: "Working tree" },
            { value: "base-branch", label: "vs develop", disabled: true },
          ]}
        />
      </Specimen>

      <Specimen
        id="surface-strip"
        title="Plugin surface strip — truncating label"
        surface={TOOLBAR}
        width={240}
      >
        <div className="flex min-w-0 items-center">
          <Toggle
            label="Canvas view"
            density="compact"
            className="min-w-0 shrink"
            initial="surface"
            options={[
              {
                value: "surface",
                label: "SvelteKit Site Builder Workbench",
                ariaLabel: "SvelteKit Site Builder Workbench",
              },
              { value: "stock", label: "Launcher" },
            ]}
          />
        </div>
      </Specimen>

      <Specimen
        id="prompt-history"
        title="Prompt history — scope"
        surface="flex items-center gap-2 border border-border-default bg-surface-panel-elevated px-3 py-2"
        width={300}
      >
        <Toggle
          label="History scope"
          density="compact"
          initial="project"
          options={[
            { value: "project", label: "This project", tooltip: "Switch scope (⌘R)" },
            { value: "global", label: "All projects", tooltip: "Switch scope (⌘R)" },
          ]}
        />
      </Specimen>

      <Specimen
        id="image-diff"
        title="Image diff — mode + zoom"
        surface="flex flex-wrap items-center gap-2 bg-surface-panel p-3"
        width={420}
      >
        <Toggle
          label="Comparison mode"
          initial="onion"
          options={[
            { value: "two-up", label: "Two-up" },
            { value: "swipe", label: "Swipe" },
            { value: "onion", label: "Onion skin" },
          ]}
        />
        <Toggle
          label="Zoom"
          initial="fit"
          options={[
            { value: "fit", label: "Fit", ariaLabel: "Fit to screen" },
            { value: "actual", label: "100%", ariaLabel: "Actual size", disabled: true },
          ]}
        />
      </Specimen>

      <Specimen id="file-toolbar" title="File viewer toolbar — mode" surface={TOOLBAR} width={300}>
        <Toggle
          label="View mode"
          density="compact"
          initial="rendered"
          options={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
            { value: "edit", label: "Edit" },
          ]}
        />
      </Specimen>

      <Specimen
        id="quick-state"
        title="Sidebar quick-state filter (separate visual family)"
        surface="surface-sidebar border border-border-default"
        width={320}
      >
        <QuickStateFilterBar
          value={quick}
          onChange={setQuick}
          counts={{ all: 6, working: 2, waiting: 1, finished: 3 }}
          trailing={
            <QuickStateArmButton label="Arm all 2 agents" disabled={false} onArm={() => {}} />
          }
        />
      </Specimen>

      <Specimen
        id="pilot"
        title="Pilot filter (separate visual family, reference)"
        surface="border border-border-default bg-surface-panel-elevated"
        width={620}
      >
        <PilotFilterBar value={pilot} counts={pilotCounts} bands={bands} onChange={setPilot} />
      </Specimen>

      <Specimen id="pulse" title="Project pulse card — range" surface="" width={560}>
        <ProjectPulseCard worktreeId={WORKTREE_ID} />
      </Specimen>

      <Specimen id="theme-browser" title="Theme browser — appearance mode" surface="" width={420}>
        <div className="relative h-[240px] overflow-hidden border border-border-default">
          <ThemeBrowser />
        </div>
      </Specimen>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Gallery />
    </TooltipProvider>
  </StrictMode>
);
