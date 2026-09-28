// First: the bridge must exist before any client module reads it.
import { DELETE_WORKTREE_ID, PREVIEW_ROOT } from "./checkboxFamilyBridge";
import {
  Component,
  StrictMode,
  lazy,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import motionFeatures from "@/lib/motionFeatures";
import { resolveAppTheme } from "@shared/theme/themes";
import type { CliAvailability } from "@shared/types";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAgentSettingsStore } from "@/store";
import { useDiffViewedStore } from "@/store/diffViewedStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPicker } from "@/hooks/useFleetPicker";
import type { UseQuickCreatePaletteReturn } from "@/hooks/useQuickCreatePalette";
import type { WorktreeState } from "@/types";
import type { Project } from "@shared/types/project";
import { WorktreeDeleteDialog } from "@/components/Worktree/WorktreeDeleteDialog";
import { NewWorktreeDialog } from "@/components/Worktree/NewWorktreeDialog";
import { AssignIssueToggle } from "@/components/Worktree/views/IssueSelectorView";
import { QuickCreatePalette } from "@/components/Worktree/QuickCreatePalette";
import { CommitPanel } from "@/components/Worktree/ReviewHub/CommitPanel";
import { FileStageRow } from "@/components/Worktree/ReviewHub/FileStageRow";
import { DiffFileSidebar } from "@/components/FileViewer/DiffFileSidebar";
import { PluginManagerView } from "@/components/Plugin/PluginManagerView";
import { AgentCliStep } from "@/components/Setup/AgentCliStep";
import { CrashRecoveryDialog } from "@/components/Recovery/CrashRecoveryDialog";
import { FleetPickerContent } from "@/components/Fleet/FleetPickerContent";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { SettingsTextarea } from "@/components/Settings/SettingsTextarea";
import { SettingsChoicebox } from "@/components/Settings/SettingsChoicebox";
import { SettingsCheckbox } from "@/components/Settings/SettingsCheckbox";
import { FileBrowserVisibilitySettings } from "@/components/Settings/FileBrowserVisibilitySettings";
import {
  CRASH,
  DIFF_FILES,
  DIFF_VIEWED_KEYS,
  ISSUE,
  PANES,
  RECIPES,
  STAGE_FILES,
  WORKTREES,
} from "./checkboxFamilyFixtures";
import "@/index.css";

// Dynamic, like the fleet harness: the entry obeys the app's lazy-load rule for
// framer-motion (#7659), and dialog motion needs a feature provider to animate in.
const { LazyMotion } = await import("framer-motion");

/**
 * Visual-review harness for every boolean control in the app, and every
 * Settings "reset to default" button, side by side.
 *
 * Each section mounts the REAL component — the dialogs through their real
 * stores and bridge seams (see `checkboxFamilyBridge.ts`) — so a checkbox that
 * differs from its siblings in size, radius, fill, focus ring or hover shows in
 * one set of frames. Nothing here re-draws a control; the harness keeps working
 * when those controls change underneath it.
 *
 * Sections (`data-shot`):
 *   reference         ui/Checkbox md+sm in every state, beside labels; ui/Switch sm+md
 *   worktree-delete   WorktreeDeleteDialog — Force delete / Close all terminals / Delete branch
 *   new-worktree      NewWorktreeDialog — Create from remote branch, Assign to @user
 *   quick-create      QuickCreatePalette — Assign issue to me
 *   commit-panel      CommitPanel's push confirm — Don't ask again for this worktree
 *   file-stage-row    Review Hub FileStageRow — Viewed
 *   diff-sidebar      DiffFileSidebar — viewed marks
 *   plugin-uninstall  PluginManagerView's uninstall confirm — Also delete saved settings
 *   agent-cli         AgentCliStep (not first run) — Skip permissions list
 *   crash-recovery    CrashRecoveryDialog — panel rows
 *   fleet-picker      FleetPickerContent — group glyphs and member checkboxes
 *   settings-reset    Settings reset buttons, in a group and in the legacy grid
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?only=<section>    render one section alone. The dialogs are modal and
 *                      portal to <body>, so the capture spec loads one per page.
 *   ?state=on|off      the second state of a section whose boolean lives in
 *                      the component (new-worktree: remote base + assign on;
 *                      quick-create: assign off)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const only = params.get("only");
const stateParam = params.get("state");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window, as the app needs. The full sheet
// is taller than any viewport, and an element screenshot of a clipped document
// silently drops what is below the fold.
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

// ---------------------------------------------------------------------------
// Store seeding — before the first render, so nothing photographs an arrival.
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-helios";
const PROJECT = {
  id: PROJECT_ID,
  path: PREVIEW_ROOT,
  name: "helios-dashboard",
  emoji: "🌲",
  lastOpened: Date.now(),
} as Project;

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);

{
  const panelsById: Record<string, (typeof PANES)[number]> = {};
  const panelIds: string[] = [];
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const p of PANES) {
    panelsById[p.id] = p;
    panelIds.push(p.id);
    const key = p.worktreeId ?? "";
    (panelIdsByWorktreeId[key] ??= []).push(p.id);
  }
  usePanelStore.setState({ panelsById, panelIds, panelIdsByWorktreeId, focusedId: "t-1" });
}
useProjectStore.setState({ currentProject: PROJECT });
useWorktreeSelectionStore.setState({ activeWorktreeId: DELETE_WORKTREE_ID });
usePreferencesStore.setState({
  assignWorktreeToSelf: stateParam === "on",
  fileBrowserAlwaysHiddenPatterns: [".DS_Store", "node_modules", "dist", "coverage"],
});
useAgentSettingsStore.setState({
  isInitialized: true,
  settings: {
    agents: {
      claude: { dangerousMode: "on" },
      codex: {},
      gemini: { dangerousMode: "inherit" },
      aider: { dangerousEnabled: true },
    },
  },
});
for (const key of DIFF_VIEWED_KEYS) useDiffViewedStore.getState().toggleViewed(PREVIEW_ROOT, key);
if (only === "plugin-uninstall") usePluginManagerStore.setState({ isOpen: true });

// The GitHub builtin's real issue selector, so the new-worktree dialog's Issue
// row renders its control as the app does. Registered under the plugin id the
// bridge's runtime snapshot reports, so the slot resolves.
registerBuiltinView(
  "github.issueSelector",
  lazy(() =>
    import("../../../../plugins/builtin/github/renderer/components/IssueSelector").then((m) => ({
      default: m.IssueSelector,
    }))
  ),
  { pluginId: "daintree.github", label: "Issue picker" }
);

const noop = () => {};
const resolved = async () => {};
/** Lets the commit panel settle its first render before its primary is clicked. */
const OPEN_CONFIRM_DELAY_MS = 150;
/** How often the plugin manager is checked for a loaded list to arm the uninstall from. */
const ARM_POLL_MS = 100;

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

// ---------------------------------------------------------------------------
// reference
// ---------------------------------------------------------------------------

type BoolState = boolean | "indeterminate";

function CheckboxSpecimen({
  size,
  checked,
  disabled,
  label,
}: {
  size: "md" | "sm";
  checked: BoolState;
  disabled?: boolean;
  label: string;
}) {
  const [value, setValue] = useState<BoolState>(checked);
  const id = `ref-${size}-${label.replace(/\W+/g, "-").toLowerCase()}`;
  // md mirrors GitInitDialog's "Create an initial commit"; sm mirrors
  // WorktreeFilterPopover's "Group by type".
  return (
    <div className="flex h-8 items-center gap-2">
      <Checkbox
        id={id}
        size={size}
        checked={value}
        disabled={disabled}
        onCheckedChange={(next) => setValue(next)}
      />
      <label
        htmlFor={id}
        className={
          size === "md"
            ? "cursor-pointer text-sm text-text-primary"
            : "cursor-pointer text-xs text-text-secondary"
        }
      >
        {label}
      </label>
    </div>
  );
}

function SwitchSpecimen({ size, on, label }: { size: "md" | "sm"; on: boolean; label: string }) {
  const [value, setValue] = useState(on);
  const id = `switch-${size}-${on ? "on" : "off"}`;
  return (
    <div className="flex h-8 items-center gap-2">
      <Switch id={id} size={size} checked={value} onCheckedChange={setValue} />
      <label htmlFor={id} className="cursor-pointer text-sm text-text-primary">
        {label}
      </label>
    </div>
  );
}

function ReferenceSection() {
  const states: { checked: BoolState; disabled?: boolean; label: string }[] = [
    { checked: false, label: "Unchecked" },
    { checked: true, label: "Checked" },
    { checked: "indeterminate", label: "Indeterminate" },
    { checked: false, disabled: true, label: "Disabled off" },
    { checked: true, disabled: true, label: "Disabled on" },
  ];
  return (
    <Section shot="reference" title="Reference — ui/Checkbox and ui/Switch">
      <Frame label="Checkbox md · text-sm primary (GitInitDialog)" width={300}>
        <div className="p-3 flex flex-col">
          {states.map((s) => (
            <CheckboxSpecimen key={s.label} size="md" {...s} />
          ))}
        </div>
      </Frame>
      <Frame label="Checkbox sm · text-xs secondary (WorktreeFilterPopover)" width={300}>
        <div className="p-3 flex flex-col">
          {states.map((s) => (
            <CheckboxSpecimen key={s.label} size="sm" {...s} />
          ))}
        </div>
      </Frame>
      <Frame label="Switch sm / md" width={300}>
        <div className="p-3 flex flex-col">
          <SwitchSpecimen size="sm" on={false} label="Small, off" />
          <SwitchSpecimen size="sm" on label="Small, on" />
          <SwitchSpecimen size="md" on={false} label="Medium, off" />
          <SwitchSpecimen size="md" on label="Medium, on" />
        </div>
      </Frame>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Dialog sections — each renders its own modal; the spec photographs the dialog.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- harness fixture
const DELETE_WORKTREE = {
  id: DELETE_WORKTREE_ID,
  worktreeId: DELETE_WORKTREE_ID,
  path: DELETE_WORKTREE_ID,
  name: "feature-retry-backoff",
  branch: "feature/retry-backoff",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: Date.now(),
} as unknown as WorktreeState;

function DialogSection({
  shot,
  title,
  children,
}: {
  shot: string;
  title: string;
  children: ReactNode;
}) {
  // The dialog portals to <body>; the section keeps a caption so a full-page
  // look at the harness still says what is open.
  return (
    <Section shot={shot} title={title}>
      <p className="text-xs text-text-secondary">The dialog is open over this page.</p>
      {children}
    </Section>
  );
}

function WorktreeDeleteSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="worktree-delete" title="WorktreeDeleteDialog — options">
      <WorktreeDeleteDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        worktree={DELETE_WORKTREE}
      />
    </DialogSection>
  );
}

function NewWorktreeSection() {
  const [open, setOpen] = useState(true);
  return (
    <DialogSection shot="new-worktree" title="NewWorktreeDialog — base and issue rows">
      <NewWorktreeDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        rootPath={PREVIEW_ROOT}
        initialIssue={ISSUE}
      />
    </DialogSection>
  );
}

/** AssignIssueToggle alone, props only: the component the dialog's Issue row hangs off. */
function AssignToggleSection() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  const [c, setC] = useState(false);
  return (
    <Section shot="assign-toggle" title="AssignIssueToggle — props only">
      <Frame label="Checked, with a user" width={320}>
        <div className="p-3">
          <AssignIssueToggle
            assignWorktreeToSelf={a}
            onSetAssignWorktreeToSelf={setA}
            currentUser="mira-okafor"
          />
        </div>
      </Frame>
      <Frame label="Unchecked, with a user" width={320}>
        <div className="p-3">
          <AssignIssueToggle
            assignWorktreeToSelf={b}
            onSetAssignWorktreeToSelf={setB}
            currentUser="mira-okafor"
          />
        </div>
      </Frame>
      <Frame label="Unchecked, disabled, no user" width={320}>
        <div className="p-3">
          <AssignIssueToggle assignWorktreeToSelf={c} onSetAssignWorktreeToSelf={setC} disabled />
        </div>
      </Frame>
    </Section>
  );
}

function QuickCreateSection() {
  const [assignToSelf, setAssignToSelf] = useState(stateParam !== "off");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(true);
  const results = [
    ...RECIPES.map((r) => ({ ...r, _kind: "recipe" as const })),
    { _kind: "customize" as const, id: "__customize__" as const, name: "Customize…" as const },
  ];
  const selected = results[selectedIndex];
  const palette: UseQuickCreatePaletteReturn = {
    isOpen,
    query: "",
    results,
    totalResults: results.length,
    selectedIndex,
    matchesById: new Map(),
    isStale: false,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
    toggle: () => setIsOpen((v) => !v),
    setQuery: noop,
    setSelectedIndex,
    selectPrevious: () => setSelectedIndex((i) => Math.max(0, i - 1)),
    selectNext: () => setSelectedIndex((i) => Math.min(results.length - 1, i + 1)),
    confirmSelection: noop,
    confirmItem: noop,
    isPending: false,
    assignToSelf,
    setAssignToSelf,
    selectedRecipe: selected && selected._kind === "recipe" ? selected : null,
  };
  return (
    <DialogSection shot="quick-create" title="QuickCreatePalette — assign issue to me">
      <QuickCreatePalette palette={palette} />
    </DialogSection>
  );
}

function CommitPanelSection() {
  const [message, setMessage] = useState(
    "Honour Retry-After in the retry backoff\n\nThe server's header now caps the next delay, and jitter never pushes past it."
  );
  const [skip, setSkip] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Open the push confirm the way a user does: the primary button.
  useEffect(() => {
    const timer = setTimeout(() => {
      const buttons = rootRef.current?.querySelectorAll("button") ?? [];
      const primary = [...buttons].find((b) => /push/i.test(b.textContent ?? ""));
      primary?.click();
    }, OPEN_CONFIRM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Section shot="commit-panel" title="CommitPanel — push confirm">
      <Frame label="CommitPanel" width={420}>
        <div ref={rootRef} className="p-3">
          <CommitPanel
            stagedCount={3}
            isDetachedHead={false}
            hasConflicts={false}
            hasRemote
            pushDestination={{ remote: "origin", branch: "feature/retry-backoff" }}
            worktreePath={DELETE_WORKTREE_ID}
            currentBranch="feature/retry-backoff"
            commitMessage={message}
            onCommitMessageChange={setMessage}
            onCommit={resolved}
            onCommitAndPush={resolved}
            isPushing={false}
            pushProgress={new Map()}
            pushTargetBranch={null}
            skipPushConfirm={skip}
            onSetSkipPushConfirm={setSkip}
          />
        </div>
      </Frame>
    </Section>
  );
}

function PluginUninstallSection() {
  // Arm the uninstall the way a user does: the detail pane's Uninstall button,
  // once the list has loaded and the sideloaded plugin is selected.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const rows = [...document.querySelectorAll<HTMLElement>("button")];
      const button = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Uninstall Linear Sync']"
      );
      if (button) {
        clearInterval(timer);
        button.click();
        return;
      }
      const row = rows.find((el) => el.textContent?.trim().startsWith("Linear Sync"));
      row?.click();
      if (tries > 80) clearInterval(timer);
    }, ARM_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <DialogSection shot="plugin-uninstall" title="PluginManagerView — uninstall confirm">
      <PluginManagerView />
    </DialogSection>
  );
}

function CrashRecoverySection() {
  const [config, setConfig] = useState({ autoRestoreOnCrash: false });
  return (
    <DialogSection shot="crash-recovery" title="CrashRecoveryDialog — panel rows">
      <CrashRecoveryDialog
        crash={CRASH}
        config={config}
        onResolve={resolved}
        onUpdateConfig={async (patch) => setConfig((c) => ({ ...c, ...patch }))}
      />
    </DialogSection>
  );
}

// ---------------------------------------------------------------------------
// Inline sections
// ---------------------------------------------------------------------------

function FileStageRowSection() {
  const [viewed, setViewed] = useState<Record<string, boolean>>({
    [STAGE_FILES[0]!.path]: true,
  });
  return (
    <Section shot="file-stage-row" title="Review Hub FileStageRow — Viewed">
      <Frame label="Unstaged changes" width={520}>
        <div role="listbox" aria-label="Unstaged changes" className="flex flex-col gap-0.5 p-2">
          {STAGE_FILES.map((file, i) => (
            <FileStageRow
              key={file.path}
              id={`stage-row-${i}`}
              rowIndex={i}
              file={file}
              section="unstaged"
              isStaged={false}
              isSelected={false}
              isFocused={false}
              onToggle={noop}
              onRowClick={noop}
              viewed={viewed[file.path] === true}
              onViewedChange={(v) => setViewed((prev) => ({ ...prev, [file.path]: v }))}
            />
          ))}
        </div>
      </Frame>
    </Section>
  );
}

function DiffSidebarSection() {
  const [current, setCurrent] = useState(1);
  return (
    <Section shot="diff-sidebar" title="DiffFileSidebar — viewed marks">
      <Frame label="Diff file shelf" width={300}>
        <div className="flex flex-col" style={{ height: 320 }}>
          <DiffFileSidebar
            files={DIFF_FILES}
            currentIndex={current}
            worktreePath={PREVIEW_ROOT}
            worktreeId="wt-main"
            onSelect={setCurrent}
          />
        </div>
      </Frame>
    </Section>
  );
}

function AgentCliSection() {
  const availability = Object.fromEntries(
    LAUNCHABLE_AGENT_IDS.map((id) => [id, "ready"])
  ) as CliAvailability;
  const selections = { claude: true, codex: true, gemini: true, aider: true };
  return (
    <Section shot="agent-cli" title="AgentCliStep — skip permissions">
      <Frame label="Agent setup (not first run)" width={520} surface="bg-surface-panel-elevated">
        <div className="p-4">
          <AgentCliStep availability={availability} selections={selections} isFirstRun={false} />
        </div>
      </Frame>
    </Section>
  );
}

function FleetPickerSection() {
  const picker = useFleetPicker({
    isOpen: true,
    mode: "cold-start",
    onCommit: noop,
    owner: "cold-start",
  });
  const { acquired, setSelectedIds } = picker;
  // One worktree fully picked, one partly (its heading reads indeterminate), one
  // not at all.
  useEffect(() => {
    if (!acquired) return;
    const timer = setTimeout(() => setSelectedIds(new Set(["t-1", "t-2", "t-3", "t-4"])), 0);
    return () => clearTimeout(timer);
  }, [acquired, setSelectedIds]);
  return (
    <Section shot="fleet-picker" title="FleetPickerContent — groups and members">
      <Frame label="Select terminals to arm" width={560} surface="bg-surface-panel-elevated">
        <div className="flex flex-col" style={{ maxHeight: 520 }}>
          {acquired ? (
            <FleetPickerContent
              picker={picker}
              testIdPrefix="checkbox-family-fleet"
              autoFocusSearch={false}
            />
          ) : null}
        </div>
      </Frame>
    </Section>
  );
}

const SELECT_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
];

const CHOICE_OPTIONS = [
  { value: "split", label: "Split", description: "Side by side" },
  { value: "unified", label: "Unified", description: "One column" },
];

function SettingsResetSection() {
  const [port, setPort] = useState("5174");
  const [shell, setShell] = useState("/opt/homebrew/bin/fish");
  const [mode, setMode] = useState("always");
  const [prompt, setPrompt] = useState("Summarise the diff in one line.");
  const [layout, setLayout] = useState("unified");
  const [checked, setChecked] = useState(true);
  const [gPort, setGPort] = useState("5174");
  const [gShell, setGShell] = useState("/opt/homebrew/bin/fish");
  const [gMode, setGMode] = useState("always");
  const [gPrompt, setGPrompt] = useState("Summarise the diff in one line.");
  const [gLayout, setGLayout] = useState("unified");
  const [gLayout2, setGLayout2] = useState("split");
  const [gChecked, setGChecked] = useState(true);
  const [gSwitch, setGSwitch] = useState(true);

  return (
    <Section shot="settings-reset" title="Settings — reset to default">
      <div data-frame className="shrink-0 p-1" style={{ width: 520 }}>
        <Label>Inside a SettingsGroup</Label>
        <div data-settings-grouped className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <ShotBoundary name="settings-grouped">
            <SettingsGroup>
              <SettingsRow
                label="Restore terminals on launch"
                description="Reopens every terminal from the last session"
                isModified
                onReset={() => setGSwitch(false)}
                control={({ labelId, descriptionId }) => (
                  <Switch
                    checked={gSwitch}
                    onCheckedChange={setGSwitch}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                  />
                )}
              />
              <SettingsRow
                label="Worktree path pattern"
                description="Where new worktrees are created"
                layout="stacked"
                isModified
                onReset={noop}
                control={
                  <div className="font-mono text-xs text-text-secondary">
                    {"{parent}/{repo}-worktrees/{branch}"}
                  </div>
                }
              />
              <SettingsInput
                label="Dev server port"
                type="number"
                value={gPort}
                onChange={(e) => setGPort(e.target.value)}
                isModified
                onReset={() => setGPort("5173")}
              />
              <SettingsInput
                label="Default shell"
                description="Used for new plain terminals"
                value={gShell}
                onChange={(e) => setGShell(e.target.value)}
                isModified
                onReset={() => setGShell("")}
              />
              <SettingsSelect
                label="Auto-assign issues"
                value={gMode}
                onValueChange={setGMode}
                options={SELECT_OPTIONS}
                isModified
                onReset={() => setGMode("auto")}
              />
              <SettingsTextarea
                label="Summary prompt"
                value={gPrompt}
                onChange={(e) => setGPrompt(e.target.value)}
                rows={2}
                isModified
                onReset={() => setGPrompt("")}
              />
              <SettingsChoicebox
                label="Diff layout"
                value={gLayout}
                onChange={setGLayout}
                options={CHOICE_OPTIONS}
                isModified
                onReset={() => setGLayout("split")}
              />
              <SettingsChoicebox
                aria-label="Diff layout, unlabelled"
                value={gLayout2}
                onChange={setGLayout2}
                options={CHOICE_OPTIONS}
                isModified
                onReset={() => setGLayout2("unified")}
              />
              <SettingsCheckbox
                label="Confirm before force push"
                description="Asks before overwriting the remote branch"
                checked={gChecked}
                onChange={setGChecked}
                isModified
                onReset={() => setGChecked(false)}
              />
            </SettingsGroup>
          </ShotBoundary>
        </div>
      </div>

      <div data-frame className="shrink-0 p-1" style={{ width: 520 }}>
        <Label>Legacy grid — no group</Label>
        <div
          data-settings-legacy
          className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-[var(--radius-md)] border border-border-default bg-surface-panel p-4"
        >
          <ShotBoundary name="settings-legacy">
            <SettingsInput
              label="Dev server port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              isModified
              onReset={() => setPort("5173")}
            />
            <SettingsInput
              label="Default shell"
              description="Used for new plain terminals"
              value={shell}
              onChange={(e) => setShell(e.target.value)}
              isModified
              onReset={() => setShell("")}
            />
            <SettingsSelect
              label="Auto-assign issues"
              value={mode}
              onValueChange={setMode}
              options={SELECT_OPTIONS}
              isModified
              onReset={() => setMode("auto")}
            />
            <SettingsTextarea
              label="Summary prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              isModified
              onReset={() => setPrompt("")}
            />
            <SettingsChoicebox
              label="Diff layout"
              value={layout}
              onChange={setLayout}
              options={CHOICE_OPTIONS}
              columns={2}
              isModified
              onReset={() => setLayout("split")}
            />
            <SettingsChoicebox
              aria-label="Diff layout, unlabelled"
              value={layout}
              onChange={setLayout}
              options={CHOICE_OPTIONS}
              columns={2}
              isModified
              onReset={() => setLayout("split")}
            />
            <SettingsCheckbox
              label="Confirm before force push"
              description="Asks before overwriting the remote branch"
              checked={checked}
              onChange={setChecked}
              isModified
              onReset={() => setChecked(false)}
            />
          </ShotBoundary>
        </div>
      </div>

      <Frame label="FileBrowserVisibilitySettings (modified list)" width={520}>
        <div className="p-4">
          <FileBrowserVisibilitySettings />
        </div>
      </Frame>
    </Section>
  );
}

// ---------------------------------------------------------------------------

const SECTIONS: Record<string, () => ReactNode> = {
  reference: () => <ReferenceSection />,
  "worktree-delete": () => <WorktreeDeleteSection />,
  "new-worktree": () => <NewWorktreeSection />,
  "assign-toggle": () => <AssignToggleSection />,
  "quick-create": () => <QuickCreateSection />,
  "commit-panel": () => <CommitPanelSection />,
  "file-stage-row": () => <FileStageRowSection />,
  "diff-sidebar": () => <DiffSidebarSection />,
  "plugin-uninstall": () => <PluginUninstallSection />,
  "agent-cli": () => <AgentCliSection />,
  "crash-recovery": () => <CrashRecoverySection />,
  "fleet-picker": () => <FleetPickerSection />,
  "settings-reset": () => <SettingsResetSection />,
};

/** Sections that open a modal; the full sheet leaves them out so one never sits over another. */
const MODAL_SECTIONS = new Set([
  "worktree-delete",
  "new-worktree",
  "quick-create",
  "commit-panel",
  "plugin-uninstall",
  "crash-recovery",
]);

function Preview() {
  const names = only ? [only] : Object.keys(SECTIONS).filter((name) => !MODAL_SECTIONS.has(name));
  return (
    <div className="flex flex-col gap-2" data-preview-ready>
      {names.map((name) => {
        const render = SECTIONS[name];
        return (
          <ShotBoundary key={name} name={name}>
            {render ? (
              render()
            ) : (
              <div data-shot-error={name}>unknown section &quot;{name}&quot;</div>
            )}
          </ShotBoundary>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion strict features={motionFeatures}>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <TooltipProvider>
          <Preview />
        </TooltipProvider>
      </WorktreeStoreContext.Provider>
    </LazyMotion>
  </StrictMode>
);
