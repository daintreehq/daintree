import "./handrolledButtonsShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PrerequisiteSpec, WorktreeSnapshot } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";
import type { HeatCell, HeatLevel, ProjectPulse } from "@shared/types/pulse";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { usePanelStore } from "@/store/panelStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { usePulseStore } from "@/store/pulseStore";
import { useProjectStore } from "@/store/projectStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import {
  previewAgentSettings,
  previewAvailability,
} from "@/components/Onboarding/__preview__/firstRunShims";
import { PROJECT, WORKTREES } from "@/components/Terminal/__preview__/resumeSessionFixtures";
import { TerminalCountWarning } from "@/components/Terminal/TerminalCountWarning";
import { ResumeSessionLine } from "@/components/Terminal/ResumeSessionLine";
import { PrerequisiteCard } from "@/components/Setup/SystemToolsStep";
import { SystemRequirementsSection } from "@/components/Setup/SystemRequirementsSection";
import { AgentCliStep } from "@/components/Setup/AgentCliStep";
import { ProjectPulseCard } from "@/components/Pulse/ProjectPulseCard";
import "@/index.css";

/**
 * Visual-review harness for the hand-rolled-button consolidation: raw `<button>`s
 * that copied a `Button` variant by hand move onto `Button`, and the `link`
 * variant is redefined. Two sections, each tagged for the capture spec:
 *
 *   data-capture="matrix"     the primitive: link / ghost / subtle / outline /
 *                             contrast / secondary × xs / sm / default, with an
 *                             icon and a disabled cell, on the panel surface and
 *                             again on the canvas. Every button carries a
 *                             `data-capture-id` (`ghost-sm`, `link-inline-xs`, …);
 *                             the canvas copy prefixes it with `canvas:`.
 *   data-capture="surfaces"   real affected components no other preview page
 *                             mounts, one card each, `data-capture-surface=<Name>`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?section=matrix|surfaces  render one section only (default: both)
 *   ?surface=<Name>           render that one surface card alone
 *   ?git=missing              (read by firstRunShims) the fatal Git check fails
 *
 * Surfaces mounted here: TerminalCountWarning, SystemToolsStep (its exported
 * PrerequisiteCard), SystemRequirementsSection (all-pass and git-missing),
 * AgentCliStep, ProjectPulseCard (loaded and error), ResumeSessionLine.
 *
 * Covered by an existing preview page instead (the spec drives those):
 * PanelLimitConfirmDialog, SafeModeBanner (its restart confirm), HelpPanelVersionGate,
 * ProjectPluginIndicator, ProjectResourceBadge, RunningTaskList, WorktreeFilterPopover,
 * RecipeRunner, FleetPickerPalette/FleetPickerContent, WorktreeDetailsSection, WelcomeScreen,
 * GettingStartedChecklist, contentGridTips/TourInviteCard (the open-project canvas), SubagentChip.
 *
 * Skipped:
 *   SidebarContent empty state — a 1.9k-line component that needs the project,
 *     worktree, panel, fleet and filter stores plus the per-view context wired
 *     together before its empty branch renders; far over the shim budget.
 *   WelcomeScreen / GettingStartedChecklist / ProjectResourceBadge / RunningTaskList /
 *     ProjectPluginIndicator / HelpPanelVersionGate / SafeModeBanner — already
 *     rendered by first-run, sidebar-footer, assistant-launching and
 *     recovery-banners previews; a second mount here would only drift.
 *   Settings tabs (VoiceInput, DaintreeAssistant, ProjectPlugins, PrivacyData,
 *     KeyboardShortcuts, CommandOverrides, McpServer, EnvVarRow, AppThemePicker,
 *     PresetColorPicker, SettingsDialog), PluginDetailPane, ImportConfigDialog,
 *     CrashRecoveryDialog, AgentSetupWizard, FileBrowserPane/Viewer, FileSection,
 *     DiffFileSidebar, DiffNotesSendMenu, BranchPickerPanel, PilotView,
 *     MoveToWorktreePicker, TerminalInfoDialog, NotificationCenter, FleetCountChip,
 *     SavedFleetQuickRecall, AgentButton, PluginTrayButton — each loads its data
 *     through several IPC namespaces or store graphs on mount; not in scope for
 *     a ~40-line shim.
 */

// Dynamic, not static: framer-motion is a restricted eager import, and
// `SystemRequirementsSection` animates through `m.*`, which needs a LazyMotion.
const { LazyMotion, domAnimation } = await import("framer-motion");

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const sectionParam = params.get("section");
const surfaceParam = params.get("surface");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window; the sheet is taller than any
// viewport, and an element screenshot of a clipped document misses its rows.
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

// ---- store seeding (before render: the surfaces read on first render) ----

useProjectStore.setState({ currentProject: PROJECT, projects: [PROJECT], isLoading: false });
useCliAvailabilityStore.setState({
  availability: previewAvailability,
  hasRealData: true,
  isLoading: false,
  isRefreshing: false,
  isInitialized: true,
  lastCheckedAt: Date.now(),
});
useAgentSettingsStore.setState({
  settings: structuredClone(previewAgentSettings),
  isLoading: false,
  isInitialized: true,
});

function terminal(i: number, extra: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: `t-${i}`,
    title: `Agent ${i}`,
    kind: "terminal",
    cwd: PROJECT.path,
    cols: 120,
    rows: 40,
    worktreeId: "wt-main",
    location: "grid",
    hasPty: true,
    runtimeStatus: "running",
    ...extra,
  } as PtyPanelData;
}
const PANELS = Array.from({ length: 14 }, (_, i) =>
  terminal(i, i < 3 ? { agentState: "completed" } : {})
);
usePanelStore.setState({
  panelsById: Object.fromEntries(PANELS.map((p) => [p.id, p])),
  panelIds: PANELS.map((p) => p.id),
});
usePanelLimitStore.setState({
  softWarningLimit: 12,
  confirmationLimit: 24,
  hardLimit: 48,
  warningsDisabled: false,
  hardwareDefaultsApplied: true,
  lastSoftWarningDismissedAt: null,
});

const DAY = 86_400_000;
const HEAT_LEVELS: readonly HeatLevel[] = [0, 1, 2, 3, 4];
function heatmap(days: number): HeatCell[] {
  const today = Date.now();
  return Array.from({ length: days }, (_, i) => {
    const count = (i * 7) % 11 < 4 ? 0 : (i * 13) % 9;
    const level = HEAT_LEVELS[Math.min(4, Math.ceil(count / 2))] ?? 0;
    return {
      date: new Date(today - (days - 1 - i) * DAY).toISOString().slice(0, 10),
      count,
      level,
      isToday: i === days - 1,
    };
  });
}
const PULSE: ProjectPulse = {
  worktreeId: "wt-pulse",
  worktreePath: PROJECT.path,
  branch: "develop",
  mainBranch: "develop",
  rangeDays: 60,
  generatedAt: Date.now(),
  heatmap: heatmap(60),
  commitsInRange: 214,
  activeDays: 41,
  projectAgeDays: 420,
  currentStreakDays: 6,
  recentCommits: [],
};
usePulseStore.setState({
  pulses: new Map([["wt-pulse", PULSE]]),
  errors: new Map([
    ["wt-pulse", null],
    ["wt-pulse-error", "This directory is not a git repository"],
  ]),
});

// ---- the matrix ----

const VARIANTS = ["link", "ghost", "subtle", "outline", "contrast", "secondary"] as const;
const SIZES = ["xs", "sm", "default"] as const;

function Cell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-10 items-center">{children}</div>;
}

function MatrixSheet({ prefix, surface }: { prefix: string; surface: string }) {
  const id = (s: string) => `${prefix}${s}`;
  return (
    <div
      data-matrix-sheet={surface}
      className={cn(
        "rounded-[var(--radius-lg)] border border-border-default p-5",
        surface === "panel" ? "bg-surface-panel" : "bg-surface-canvas"
      )}
    >
      <div className="mb-3 font-mono text-2xs uppercase tracking-wide text-text-muted">
        on the {surface} surface
      </div>
      {/* Inline, not an arbitrary utility: Tailwind scans preview dirs, and a
          preview-only value would otherwise land in the app's stylesheet. */}
      <div
        className="grid items-center gap-x-6 gap-y-1"
        style={{ gridTemplateColumns: "9rem repeat(3, minmax(0, 1fr))" }}
      >
        <div />
        <div className="font-mono text-2xs text-text-muted">label</div>
        <div className="font-mono text-2xs text-text-muted">icon + label</div>
        <div className="font-mono text-2xs text-text-muted">disabled</div>
        {VARIANTS.flatMap((variant) =>
          (variant === "link" ? (["default"] as const) : SIZES).map((size) => {
            const key = `${variant}-${size}`;
            return (
              <div key={key} className="contents">
                <div className="font-mono text-2xs text-text-secondary">{key}</div>
                <Cell>
                  <Button
                    variant={variant}
                    size={variant === "link" ? undefined : size}
                    data-capture-id={id(key)}
                  >
                    Open plugin manager
                  </Button>
                </Cell>
                <Cell>
                  <Button
                    variant={variant}
                    size={variant === "link" ? undefined : size}
                    data-capture-id={id(`${key}-icon`)}
                  >
                    {variant === "link" ? (
                      <>
                        Open docs
                        <ExternalLink aria-hidden="true" />
                      </>
                    ) : (
                      <>
                        <RotateCw aria-hidden="true" />
                        Check again
                      </>
                    )}
                  </Button>
                </Cell>
                <Cell>
                  <Button
                    variant={variant}
                    size={variant === "link" ? undefined : size}
                    disabled
                    data-capture-id={id(`${key}-disabled`)}
                  >
                    Retry
                  </Button>
                </Cell>
              </div>
            );
          })
        )}
      </div>
      <div className="mt-4 space-y-2 border-t border-divider pt-4">
        <p className="text-xs text-text-secondary">
          To be asked less often,{" "}
          <Button variant="link" data-capture-id={id("link-inline-xs")}>
            cancel and change your panel limits
          </Button>
          . The link sits inside a text-xs secondary sentence.
        </p>
        <p className="text-sm text-text-primary">
          Installed another way?{" "}
          <Button variant="link" data-capture-id={id("link-inline-sm")}>
            Claude Code docs
            <ArrowRight aria-hidden="true" />
          </Button>{" "}
          — the link sits inside a text-sm sentence.
        </p>
      </div>
    </div>
  );
}

function Matrix() {
  return (
    <section data-capture="matrix" className="flex flex-col gap-4 p-4" style={{ width: 880 }}>
      <MatrixSheet prefix="" surface="panel" />
      <MatrixSheet prefix="canvas:" surface="canvas" />
    </section>
  );
}

// ---- the real surfaces ----

const PREREQ_SPEC: PrerequisiteSpec = {
  tool: "gh",
  label: "GitHub CLI",
  versionArgs: ["--version"],
  severity: "warn",
  installUrl: "https://cli.github.com",
  installBlocks: {
    generic: [{ label: "Homebrew", commands: ["brew install gh"] }],
    macos: [{ label: "Homebrew", commands: ["brew install gh"] }],
    linux: [{ label: "apt", commands: ["sudo apt install gh"] }],
    windows: [{ label: "winget", commands: ["winget install GitHub.cli"] }],
  },
};

const noop = () => undefined;

/** The per-view worktree store is created by the provider, so it is seeded from inside the tree. */
function SeedWorktrees({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({
      worktrees: new Map<string, WorktreeSnapshot>(WORKTREES.map((wt) => [wt.id, wt])),
    });
    return true;
  });
  return ready ? children : null;
}

const SURFACES: Record<string, { width: number; render: () => ReactNode }> = {
  TerminalCountWarning: {
    width: 560,
    render: () => <TerminalCountWarning onOpenBulkActions={noop} />,
  },
  SystemToolsStep: {
    width: 360,
    render: () => (
      <PrerequisiteCard
        spec={PREREQ_SPEC}
        state={{
          tool: "gh",
          label: "GitHub CLI",
          available: false,
          unavailableReason: "not-found",
          version: null,
          severity: "warn",
          meetsMinVersion: false,
          installUrl: PREREQ_SPEC.installUrl,
          installBlocks: PREREQ_SPEC.installBlocks,
        }}
      />
    ),
  },
  SystemRequirementsSection: {
    width: 640,
    render: () => <SystemRequirementsSection onFatalFailureChange={noop} onCheckingChange={noop} />,
  },
  AgentCliStep: {
    width: 640,
    render: () => (
      <AgentCliStep
        availability={previewAvailability}
        selections={{ claude: true, codex: true, gemini: true, opencode: true }}
        isFirstRun
      />
    ),
  },
  ProjectPulseCard: {
    width: 640,
    render: () => <ProjectPulseCard worktreeId="wt-pulse" />,
  },
  "ProjectPulseCard-error": {
    width: 640,
    render: () => <ProjectPulseCard worktreeId="wt-pulse-error" />,
  },
  ResumeSessionLine: {
    width: 560,
    render: () => <ResumeSessionLine />,
  },
};

function SurfaceCard({ name }: { name: string }) {
  const surface = SURFACES[name];
  if (!surface) {
    throw new Error(`unknown surface "${name}" — one of ${Object.keys(SURFACES).join(", ")}`);
  }
  return (
    <div
      data-capture-surface={name}
      className="rounded-[var(--radius-lg)] border border-border-default bg-surface-panel p-4"
      style={{ width: surface.width + 34 }}
    >
      <div className="mb-3 font-mono text-2xs uppercase tracking-wide text-text-muted">{name}</div>
      {surface.render()}
    </div>
  );
}

function Surfaces() {
  const names = surfaceParam ? [surfaceParam] : Object.keys(SURFACES);
  return (
    <section data-capture="surfaces" className="flex flex-col items-start gap-4 p-4">
      {names.map((name) => (
        <SurfaceCard key={name} name={name} />
      ))}
    </section>
  );
}

function Page() {
  const showMatrix = !surfaceParam && sectionParam !== "surfaces";
  const showSurfaces = !!surfaceParam || sectionParam !== "matrix";
  return (
    <div data-preview-shell className="bg-surface-canvas">
      {showMatrix && <Matrix />}
      {showSurfaces && <Surfaces />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <WorktreeStoreProvider>
          <SeedWorktrees>
            <Page />
          </SeedWorktrees>
        </WorktreeStoreProvider>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
