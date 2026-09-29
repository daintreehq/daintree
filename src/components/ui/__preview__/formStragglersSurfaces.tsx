import {
  Component,
  StrictMode,
  lazy,
  useCallback,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import motionFeatures from "@/lib/motionFeatures";
import { resolveAppTheme } from "@shared/theme/themes";
import type { CliAvailability } from "@shared/types";
import type { IssueTooltipData } from "@shared/types/forge";
import type { Project } from "@shared/types/project";
import type { AppColorScheme } from "@shared/types/appTheme";
import type { BuilderStep, CommandResult } from "@shared/types/commands";
import type { EventRecord, EventFilterOptions } from "@/store/eventStore";
import type { LogFilterOptions, RecipeTerminal, RunCommand, TerminalRecipe } from "@/types";
import type { AgentPreset } from "@/config/agents";
import type { SearchableScratch } from "@/hooks/useProjectSwitcherPalette";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { RecipeImportDialog } from "@/components/TerminalRecipe/RecipeImportDialog";
import { GitInitDialog } from "@/components/Project/GitInitDialog";
import { CloneRepoDialog } from "@/components/Project/CloneRepoDialog";
import { ProjectIdentityEditor } from "@/components/Project/ProjectIdentityEditor";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";
import { CommandBuilder } from "@/components/Commands/CommandBuilder";
import { SaveFleetDialog } from "@/components/Fleet/SaveFleetDialog";
import { CustomPresetChrome } from "@/components/Settings/AgentScopeEditor/CustomPresetChrome";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { AgentCliStep } from "@/components/Setup/AgentCliStep";
import { EventFilters } from "@/components/EventInspector/EventFilters";
import { LogFilters } from "@/components/Logs/LogFilters";
import { ThemeBrowser } from "@/components/ThemeBrowser/ThemeBrowser";
import { ImageDiffViewer } from "@/components/FileViewer/ImageDiffViewer";
import { IssueTooltipContent } from "@/components/Worktree/WorktreeCard/ForgeTooltipContent";
import { NewWorktreeDialog } from "@/components/Worktree/NewWorktreeDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { WIZARD_COMMAND } from "@/components/Commands/__preview__/commandBuilderFixtures";

/**
 * The sections of the form-stragglers harness, mounted by
 * `formStragglersPreview.tsx` once the bridge for the requested section is in.
 *
 * Every section wraps REAL components at a fixed width, so the same section is
 * the same size in every theme and every round. Dialog sections keep a caption
 * in the page; the dialog itself portals to <body>, and the capture spec cuts
 * its frame from the dialog panel.
 *
 * Sections (`data-shot`):
 *   recipe-editor                 RecipeEditor — agent + shell rows: selects, Input, Textarea
 *   recipe-import                 RecipeImportDialog — "Import as" select
 *   git-init                      GitInitDialog — Gitignore select
 *   command-builder               CommandBuilder — select and textarea arguments
 *   save-fleet                    SaveFleetDialog — the live-rule selects (spec picks "Live rule")
 *   project-identity              ProjectIdentityEditor — the name field
 *   scratch-name                  ProjectSwitcherPalette — the scratch create field (spec opens it)
 *   preset-rename                 CustomPresetChrome — renaming
 *   agent-cli-install             AgentCliStep — the "via" install-method picker
 *   event-filters                 EventFilters beside LogFilters
 *   pills                         ThemeBrowser warning pill, ImageDiffViewer side chips, forge label chips
 *   dialog-keyhints-new-worktree  NewWorktreeDialog — the primary with its key hint
 *   dialog-keyhints-clone         CloneRepoDialog — the primary with its key hint
 *   automation-switches           AutomationTab's run-command SettingsSwitch (rows mirrored) beside a SettingsSwitch row
 */

const { LazyMotion } = await import("framer-motion");

const PREVIEW_ROOT = "/Users/you/Code/helios-dashboard";
const PROJECT_ID = "proj-helios";
const PROJECT = {
  id: PROJECT_ID,
  path: PREVIEW_ROOT,
  name: "helios-dashboard",
  emoji: "🌲",
  lastOpened: Date.now(),
} as Project;

const noop = () => {};

// ---------------------------------------------------------------------------
// Harness chrome
// ---------------------------------------------------------------------------

class ShotBoundary extends Component<{ name: string; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn(`[${this.props.name}]`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div data-shot-error={this.props.name} className="text-status-error text-xs p-2">
          {this.props.name}: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-3xs uppercase tracking-wider text-text-secondary mb-1">{children}</div>
  );
}

function Frame({
  label,
  width,
  children,
  surface = "bg-surface-panel",
}: {
  label: string;
  width?: number;
  children: ReactNode;
  surface?: string;
}) {
  return (
    <div data-frame style={width ? { width } : undefined} className="shrink-0 p-1">
      <Label>{label}</Label>
      <div
        className={`rounded-[var(--radius-md)] border border-border-default ${surface} overflow-hidden`}
      >
        <ShotBoundary name={label}>{children}</ShotBoundary>
      </div>
    </div>
  );
}

/** Fixed width, so the same section is the same size in every theme and every round. */
const SECTION_WIDTH = 1100;

function Section({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="p-4 flex flex-col gap-3" style={{ width: SECTION_WIDTH }}>
      <h2 className="text-xs font-semibold text-text-primary">{title}</h2>
      <ShotBoundary name={shot}>
        <div className="flex flex-wrap items-start gap-4">{children}</div>
      </ShotBoundary>
    </section>
  );
}

/** A modal section: the caption stays in the page, the dialog portals to <body>. */
function DialogSection({
  shot,
  title,
  children,
}: {
  shot: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Section shot={shot} title={title}>
      <div data-dialog-section className="text-2xs text-text-secondary">
        Dialog open above
      </div>
      {children}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Store seeding — before the first render, so nothing photographs an arrival.
// ---------------------------------------------------------------------------

const worktreeStore = createWorktreeStore();
setCurrentViewStore(worktreeStore);
useProjectStore.setState({ currentProject: PROJECT });

const claude = (title: string, initialPrompt: string): RecipeTerminal => ({
  type: "claude",
  title,
  initialPrompt,
  env: {},
});
const shell = (title: string, command: string): RecipeTerminal => ({
  type: "terminal",
  title,
  command,
  env: {},
});

const EDITED_RECIPE: TerminalRecipe = {
  id: "recipe-work-issue",
  name: "Work an issue",
  projectId: PROJECT_ID,
  terminals: [
    claude(
      "Work",
      "Pick up {{issue_number}} on {{branch_name}} and run the tests before you push."
    ),
    shell("Tests", "npm test -- --watch"),
  ],
  createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
};

useRecipeStore.setState({
  globalRecipes: [],
  pluginRecipes: [],
  inRepoRecipes: [],
  projectRecipes: [EDITED_RECIPE],
  recipes: [EDITED_RECIPE],
  currentProjectId: PROJECT_ID,
  isLoading: false,
});

// A custom theme whose body text sits on its own canvas colour, so the browser's
// contrast-warning pill has something to count. Built from the page's theme so
// it lands on the browser's tab for that theme's type.
{
  const base = resolveAppTheme(new URLSearchParams(window.location.search).get("theme") ?? "");
  const lowlight: AppColorScheme = {
    ...base,
    id: "custom-lowlight",
    name: "Lowlight (imported)",
    builtin: false,
    heroImage: undefined,
    location: "Imported from lowlight.json",
    tokens: {
      ...base.tokens,
      "text-primary": base.tokens["surface-canvas"],
      "text-secondary": base.tokens["surface-canvas"],
    },
  } as AppColorScheme;
  useAppThemeStore.setState({ customSchemes: [lowlight] });
}

// The GitHub builtin's real issue selector, so the new-worktree dialog's Issue
// row renders its control as the app does.
registerBuiltinView(
  "github.issueSelector",
  lazy(() =>
    import("../../../../plugins/builtin/github/renderer/components/IssueSelector").then((m) => ({
      default: m.IssueSelector,
    }))
  ),
  { pluginId: "daintree.github", label: "Issue picker" }
);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function RecipeEditorSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="recipe-editor" title="RecipeEditor — agent and shell rows">
      <RecipeEditor
        recipe={EDITED_RECIPE}
        defaultScope="project"
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </DialogSection>
  );
}

function RecipeImportSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="recipe-import" title="RecipeImportDialog — Import as">
      <RecipeImportDialog isOpen={open} onClose={() => setOpen(false)} projectId={PROJECT_ID} />
    </DialogSection>
  );
}

function GitInitSection() {
  return (
    <DialogSection shot="git-init" title="GitInitDialog — Gitignore">
      <GitInitDialog
        isOpen
        directoryPath="/Users/you/Code/helios-dashboard"
        onSuccess={noop}
        onCancel={noop}
      />
    </DialogSection>
  );
}

/** One step that carries every field kind this review cares about. */
const BUILDER_STEPS: BuilderStep[] = [
  {
    id: "release",
    title: "Start a release",
    description: "Pick where it goes and say what changed",
    submitLabel: "Start rollout",
    fields: [
      {
        name: "environment",
        label: "Environment",
        type: "select",
        placeholder: "Choose an environment",
        options: [
          { value: "staging", label: "Staging" },
          { value: "canary", label: "Canary (5% of production)" },
          { value: "production", label: "Production" },
        ],
        helpText: "Canary takes 5% of production traffic first.",
      },
      {
        name: "releaseName",
        label: "Release name",
        type: "text",
        placeholder: "spring-cleanup",
      },
      {
        name: "notes",
        label: "Release notes",
        type: "textarea",
        placeholder: "What changed, in a sentence or two",
        helpText: "Posted to the deploy channel.",
      },
    ],
  },
];

function CommandBuilderSection() {
  const onExecute = useCallback(
    async (): Promise<CommandResult> => new Promise<CommandResult>(() => {}),
    []
  );
  return (
    <DialogSection shot="command-builder" title="CommandBuilder — select and textarea arguments">
      <CommandBuilder
        command={WIZARD_COMMAND}
        steps={BUILDER_STEPS}
        context={{ cwd: PREVIEW_ROOT }}
        isExecuting={false}
        executionError={null}
        onExecute={onExecute}
        onCancel={noop}
      />
    </DialogSection>
  );
}

function SaveFleetSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="save-fleet" title="SaveFleetDialog — live rule">
      <SaveFleetDialog isOpen={open} onClose={() => setOpen(false)} armedCount={3} />
    </DialogSection>
  );
}

function ProjectIdentitySection() {
  const [open, setOpen] = useState(true);
  const project = { ...PROJECT, name: "helios-dashboard", emoji: "🌻" } as Project;
  return (
    <Section shot="project-identity" title="ProjectIdentityEditor — name field">
      <div className="flex w-full justify-center">
        <div
          role="group"
          aria-label="Project"
          className="relative flex h-10 w-[260px] items-center justify-center rounded-[var(--radius-md)] border border-border-default text-sm text-text-primary"
        >
          <ProjectIdentityEditor project={project} open={open} onOpenChange={setOpen} />
          🌻 helios-dashboard
        </div>
      </div>
    </Section>
  );
}

const SCRATCHES: SearchableScratch[] = [
  {
    id: "scratch-1",
    name: "Try the retry backoff",
    path: "/Users/you/.daintree/scratch/try-the-retry-backoff",
    createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    lastOpened: Date.now() - 2 * 24 * 60 * 60 * 1000,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    isActive: false,
  },
];

function ScratchNameSection() {
  const [query, setQuery] = useState("");
  return (
    <DialogSection shot="scratch-name" title="ProjectSwitcherPalette — scratch name field">
      <ProjectSwitcherPalette
        isOpen
        mode="modal"
        query={query}
        results={[]}
        selectedIndex={0}
        onQueryChange={setQuery}
        onSelectPrevious={noop}
        onSelectNext={noop}
        onSelect={noop}
        onClose={noop}
        scratchResults={SCRATCHES}
        onCreateScratch={noop}
        onSelectScratch={noop}
        onRenameScratch={noop}
      />
    </DialogSection>
  );
}

const PRESET: AgentPreset = {
  id: "user-review",
  name: "Careful reviewer",
  color: "#7c9cf5",
  displayTitle: "Reviewer",
};

function PresetRenameSection() {
  const [name, setName] = useState("Careful reviewer (strict)");
  return (
    <Section shot="preset-rename" title="CustomPresetChrome — renaming">
      <Frame label="Preset rows, renaming" width={720}>
        <SettingsGroup>
          <CustomPresetChrome
            selectedPreset={PRESET}
            agentColor="#d97757"
            isEditing
            editName={name}
            onEditNameChange={setName}
            onCommitEdit={() => true}
            onCancelEdit={noop}
            renameError={null}
            onStartEdit={noop}
            onColorChange={noop}
            onDisplayTitleChange={noop}
            onDuplicate={noop}
          />
        </SettingsGroup>
      </Frame>
    </Section>
  );
}

/** Every agent missing (the store's default), with Claude already installed. */
const AGENT_AVAILABILITY: CliAvailability = {
  ...useCliAvailabilityStore.getState().availability,
  claude: "ready",
};

function AgentCliInstallSection() {
  const selections = { claude: true, aider: true, opencode: true };
  return (
    <Section shot="agent-cli-install" title="AgentCliStep — install method picker">
      <Frame label="Agent setup" width={560} surface="bg-surface-panel-elevated">
        <div className="p-4">
          <AgentCliStep availability={AGENT_AVAILABILITY} selections={selections} isFirstRun />
        </div>
      </Frame>
    </Section>
  );
}

const EVENT_TYPES: [string, EventRecord["category"]][] = [
  ["sys:worktree:update", "system"],
  ["sys:pr:detected", "system"],
  ["agent:state-changed", "agent"],
  ["agent:completed", "agent"],
  ["agent:state-changed", "agent"],
  ["server:ready", "server"],
  ["file:changed", "file"],
  ["watcher:tick", "watcher"],
  ["ui:notify", "ui"],
];
const EVENTS: EventRecord[] = EVENT_TYPES.map(([type, category], i) => ({
  id: `evt-${i}`,
  timestamp: Date.now() - i * 1000,
  type,
  category,
  payload: {},
  source: "main",
})) as EventRecord[];

type EventFilterSubset = Pick<EventFilterOptions, "types" | "categories" | "search" | "traceId">;

function EventFiltersSection() {
  const [eventFilters, setEventFilters] = useState<EventFilterSubset>({
    categories: ["agent"],
    types: ["agent:state-changed"],
  });
  const [logFilters, setLogFilters] = useState<LogFilterOptions>({ levels: ["warn", "error"] });
  return (
    <Section shot="event-filters" title="EventFilters beside LogFilters">
      <Frame label="EventFilters (Event inspector)" width={1060}>
        <EventFilters events={EVENTS} filters={eventFilters} onFiltersChange={setEventFilters} />
      </Frame>
      <Frame label="LogFilters (Logs)" width={1060}>
        <LogFilters
          filters={logFilters}
          onFiltersChange={(next) => setLogFilters((prev) => ({ ...prev, ...next }))}
          onClear={() => setLogFilters({})}
          availableSources={["main", "pty-host", "workspace-host"]}
          levelCounts={{ debug: 120, info: 48, warn: 6, error: 2 }}
          sourceCounts={{ main: 90, "pty-host": 60, "workspace-host": 26 }}
        />
      </Frame>
    </Section>
  );
}

interface Art {
  width: number;
  height: number;
  badge: string;
  dotX: number;
  accent: string;
}

/** The image-diff harness's app-icon fixture, drawn on a canvas. */
function draw(art: Art) {
  const canvas = document.createElement("canvas");
  canvas.width = art.width;
  canvas.height = art.height;
  const ctx = canvas.getContext("2d")!;
  const pad = 24;
  ctx.fillStyle = "#2b6cb0";
  ctx.beginPath();
  ctx.roundRect(pad, pad, art.width - pad * 2, art.height - pad * 2, 28);
  ctx.fill();
  ctx.fillStyle = art.accent;
  ctx.beginPath();
  ctx.arc(art.dotX, art.height / 2, art.height / 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 44px -apple-system, system-ui, sans-serif";
  ctx.fillText(art.badge, art.width - 170, art.height - 56);
  const dataUrl = canvas.toDataURL("image/png");
  return { ok: true as const, dataUrl, byteSize: Math.round((dataUrl.length * 3) / 4) };
}

{
  const head: Art = { width: 640, height: 400, badge: "v1.2", dotX: 180, accent: "#f6ad55" };
  const bridge: object = Reflect.get(window, "electron");
  // The shim answers every namespace through a Proxy; the diff read is the one
  // this page needs to answer for real.
  Reflect.defineProperty(bridge, "diffMedia", {
    value: {
      readFileVersions: async () => ({
        head: draw(head),
        working: draw({ ...head, badge: "v1.3", dotX: 260, accent: "#68d391" }),
      }),
    },
    configurable: true,
  });
}

const ISSUE_TOOLTIP: IssueTooltipData = {
  number: 1287,
  title: "Chart legend overflows on narrow dashboards",
  bodyExcerpt:
    "When the dashboard is narrower than 900px the legend wraps under the plot and hides the last series.",
  state: "open",
  rawState: "OPEN",
  createdAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
  author: { login: "mira-okafor", rawData: null },
  assignees: [],
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "ui", color: "1d76db" },
    { name: "good first issue", color: "7057ff" },
  ],
};

function PillsSection() {
  return (
    <Section shot="pills" title="Pills — theme warnings, image diff sides, forge labels">
      <Frame label="ThemeBrowser — warning pill" width={390}>
        <div data-pill-theme-browser style={{ height: 560 }}>
          <ThemeBrowser />
        </div>
      </Frame>
      <div className="flex flex-col gap-4">
        <Frame label="ImageDiffViewer — side chips" width={640}>
          <div style={{ height: 320 }}>
            <ImageDiffViewer
              relPath="assets/icons/app-icon.png"
              worktreePath="/preview/worktree"
              status="modified"
            />
          </div>
        </Frame>
        <Frame
          label="ForgeTooltipContent — label chips"
          width={360}
          surface="bg-surface-panel-elevated"
        >
          <div className="p-3">
            <IssueTooltipContent data={ISSUE_TOOLTIP} />
          </div>
        </Frame>
      </div>
    </Section>
  );
}

function NewWorktreeKeyhintSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="dialog-keyhints-new-worktree" title="NewWorktreeDialog — primary key hint">
      <NewWorktreeDialog isOpen={open} onClose={() => setOpen(false)} rootPath={PREVIEW_ROOT} />
    </DialogSection>
  );
}

function CloneKeyhintSection() {
  return (
    <DialogSection shot="dialog-keyhints-clone" title="CloneRepoDialog — primary key hint">
      <CloneRepoDialog isOpen onSuccess={noop} onCancel={noop} />
    </DialogSection>
  );
}

const RUN_COMMANDS: RunCommand[] = [
  {
    id: "cmd-dev",
    name: "Dev server",
    command: "npm run dev",
    preferredLocation: "dock",
    preferredAutoRestart: true,
  },
  { id: "cmd-test", name: "Tests", command: "npm test -- --watch" },
];

const LOCATION_OPTIONS = [
  { value: "grid", label: "Grid" },
  { value: "dock", label: "Dock" },
] as const;

/**
 * AutomationTab's run-command rows, rebuilt from the same primitives with the
 * same classes (AutomationTab.tsx, the `runCommands.map` block).
 *
 * The tab itself cannot be mounted here: Vite dev runs the React Compiler with
 * `panicThreshold: "critical_errors"`, and AutomationTab's `ref={focus.register(id)}`
 * inside the map is a critical "Cannot access refs during render" error, so its
 * module answers 500 and takes the page down with it. Keep this in step with
 * the tab until that compiles in dev.
 */
function RunCommandRows() {
  const [commands, setCommands] = useState(RUN_COMMANDS);
  const update = (index: number, patch: Partial<RunCommand>) =>
    setCommands((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return (
    <SettingsSection
      id="project-run-commands"
      title="Run commands"
      description="Quick access to common project tasks like build, test, and deploy"
    >
      <SettingsGroup>
        {commands.map((cmd, index) => {
          const name = cmd.name.trim() || `command ${index + 1}`;
          return (
            <div
              key={cmd.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-2 px-4 py-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Input
                  type="text"
                  value={cmd.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  placeholder="Command name"
                  aria-label="Run command name"
                  className="flex-1 min-w-0"
                />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  aria-label={`Move ${name} up`}
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === commands.length - 1}
                  aria-label={`Move ${name} down`}
                >
                  <ChevronDown />
                </Button>
                <Button variant="ghost-danger" size="icon-sm" aria-label={`Delete ${name}`}>
                  <Trash2 />
                </Button>
              </div>
              <Input
                type="text"
                value={cmd.command}
                onChange={(e) => update(index, { command: e.target.value })}
                placeholder="npm run build"
                aria-label="Run command"
                spellCheck={false}
                className="col-start-1 font-mono"
              />
              <div className="col-start-1 flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary" aria-hidden="true">
                    Opens in
                  </span>
                  <SegmentedRadioGroup
                    options={[...LOCATION_OPTIONS]}
                    value={cmd.preferredLocation === "dock" ? "dock" : "grid"}
                    onChange={(value) => update(index, { preferredLocation: value })}
                    aria-label={`Where ${name} opens`}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <SettingsSwitch
                    checked={!!cmd.preferredAutoRestart}
                    onCheckedChange={(checked) => update(index, { preferredAutoRestart: checked })}
                  />
                  Restart when it exits
                </label>
              </div>
            </div>
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}

function AutomationSwitchesSection() {
  const [notify, setNotify] = useState(true);
  return (
    <Section shot="automation-switches" title="Run-command Switch sm beside a SettingsSwitch row">
      <Frame label="SettingsSwitch row (reference)" width={720} surface="bg-surface-dialog">
        <div className="p-4">
          <SettingsGroup>
            <SettingsRow
              label="Notify when an agent finishes"
              description="Shows a system notification when a background agent completes"
              control={({ labelId, descriptionId }) => (
                <SettingsSwitch
                  checked={notify}
                  onCheckedChange={setNotify}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              )}
            />
          </SettingsGroup>
        </div>
      </Frame>
      <Frame
        label="AutomationTab run commands (rows mirrored, see RunCommandRows)"
        width={720}
        surface="bg-surface-dialog"
      >
        <div className="p-4">
          <RunCommandRows />
        </div>
      </Frame>
    </Section>
  );
}

// ---------------------------------------------------------------------------

const SECTIONS: Record<string, () => ReactNode> = {
  "recipe-editor": () => <RecipeEditorSection />,
  "recipe-import": () => <RecipeImportSection />,
  "git-init": () => <GitInitSection />,
  "command-builder": () => <CommandBuilderSection />,
  "save-fleet": () => <SaveFleetSection />,
  "project-identity": () => <ProjectIdentitySection />,
  "scratch-name": () => <ScratchNameSection />,
  "preset-rename": () => <PresetRenameSection />,
  "agent-cli-install": () => <AgentCliInstallSection />,
  "event-filters": () => <EventFiltersSection />,
  pills: () => <PillsSection />,
  "dialog-keyhints-new-worktree": () => <NewWorktreeKeyhintSection />,
  "dialog-keyhints-clone": () => <CloneKeyhintSection />,
  "automation-switches": () => <AutomationSwitchesSection />,
};

function Preview({ only }: { only: string }) {
  const render = SECTIONS[only];
  return (
    <div className="flex flex-col gap-2" data-preview-ready>
      <ShotBoundary name={only}>
        {render ? render() : <div data-shot-error={only}>unknown section &quot;{only}&quot;</div>}
      </ShotBoundary>
    </div>
  );
}

export function mountFormStragglers(only: string, themeId: string): void {
  applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
  document.body.style.background = "var(--color-surface-canvas)";
  document.body.style.margin = "0";
  // `index.css` pins the document to the window, as the app needs; an element
  // screenshot of a clipped document silently drops what is below the fold.
  for (const el of [document.documentElement, document.body]) {
    el.style.height = "auto";
    el.style.minHeight = "100vh";
    el.style.overflow = "visible";
  }
  // The theme browser reads the committed scheme to pick its dark/light tab.
  useAppThemeStore.setState({ selectedSchemeId: themeId });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LazyMotion strict features={motionFeatures}>
        <WorktreeStoreContext.Provider value={worktreeStore}>
          <TooltipProvider>
            <Preview only={only} />
          </TooltipProvider>
        </WorktreeStoreContext.Provider>
      </LazyMotion>
    </StrictMode>
  );
}
