// First: the bridge must exist before any client or store module reads it.
import { MCP_PLUGIN_ID, healthShot, mcpShot, previewState as state } from "./errorsCalloutsShims";
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PR } from "@shared/types/forge";
import type { PendingCrash, CrashRecoveryConfig } from "@shared/types/ipc";
import type { ProjectPluginInfo } from "@shared/types/plugin";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { Input } from "@/components/ui/input";
import { TypedNameConfirmInput } from "@/components/ui/TypedNameConfirmInput";
import {
  WorktreeDeleteErrorBanner,
  WorktreeIssueErrorBanner,
} from "@/components/Worktree/WorktreeCard/WorktreeDetailsSection";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import {
  SettingsGroup,
  SettingsInlineError,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { PluginLogsSection } from "@/components/Plugin/PluginLogsSection";
import { PluginMcpServersSection } from "@/components/Plugin/PluginMcpServersSection";
import {
  ProjectPluginDetailPane,
  ProjectPluginSection,
} from "@/components/Plugin/ProjectPluginSection";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { PluginArchiveInstallConfirmDialog } from "@/components/Plugin/PluginArchiveInstallConfirmDialog";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import { SystemRequirementsSection } from "@/components/Setup/SystemRequirementsSection";
import { CommitPanel } from "@/components/Worktree/ReviewHub/CommitPanel";
import { CrashRecoveryDialog } from "@/components/Recovery/CrashRecoveryDialog";
import { LifecycleCommandApprovalDialog } from "@/components/Worktree/LifecycleCommandApprovalDialog";
import { NewWorktreeDialog } from "@/components/Worktree/NewWorktreeDialog";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { McpConfirmDialog } from "@/components/McpConfirmDialog";
import { Callout, CALLOUT_ICON, type CalloutSeverity } from "@/components/ui/Callout";
import { InlineError } from "@/components/ui/field";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useMcpConfirmStore } from "@/store/mcpConfirmStore";
import "@/index.css";

/**
 * Visual-review harness for validation errors, error callouts and warning
 * callouts across the product.
 *
 * Every specimen is the product's own component, driven into its failure state
 * through its real props, stores and bridge calls (see `errorsCalloutsShims.ts`
 * for the calls that fail). Nothing here restyles a component: the canvas, the
 * column widths and the captions are the only harness decoration, so a capture
 * shows whatever the component code draws at the time it is taken.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<scene>            see SCENES below; dialog scenes mount one dialog
 *
 * Inline scenes wrap their specimens in `[data-testid="scene"]`; dialog scenes
 * render the dialog alone and the spec captures its card.
 */

const params = new URLSearchParams(window.location.search);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window; a scene is taller than the
// viewport, and an element screenshot of a clipped document drops the rest.
const INLINE_SCENES = new Set([
  "worktree-banners",
  "missing-cli",
  "typed-name",
  "settings-load-error",
  "plugin-errors",
  "system-requirements",
  "severity-vocabulary",
]);
if (INLINE_SCENES.has(state)) {
  for (const el of [document.documentElement, document.body]) {
    el.style.height = "auto";
    el.style.minHeight = "100vh";
    el.style.overflow = "visible";
  }
}

const noop = () => undefined;

/** How long the MCP supervisor answers before every later poll fails. */
const MCP_LIST_OK_MS = 500;
/** How often the health-check scene looks for the first section's error. */
const HEALTH_POLL_MS = 50;
/** Settle time after that error lands, past StrictMode's repeated mount reads. */
const HEALTH_SETTLE_MS = 300;

function Specimen({
  label,
  width,
  id,
  children,
}: {
  label: string;
  width: number;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div data-specimen={id} className="flex flex-col gap-2" style={{ width }}>
      <div
        data-harness-decoration
        className="font-mono text-2xs uppercase tracking-wide text-text-muted"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Scene({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="scene"
      className="flex flex-wrap items-start gap-x-10 gap-y-8 p-8"
      style={{ width: 1240, background: "var(--color-surface-canvas)" }}
    >
      {children}
    </div>
  );
}

// ---- worktree-banners ------------------------------------------------------

const GIT_DELETE_STDERR = [
  "fatal: '/Users/you/Code/helios-dashboard-worktrees/feature-auth-refresh' contains modified or untracked files, use --force to delete it",
  "hint: commit or stash your changes, or run",
  "hint:   git worktree remove --force feature-auth-refresh",
].join("\n");

function WorktreeBannersScene() {
  return (
    <Scene>
      <Specimen label="WorktreeDeleteErrorBanner" width={320}>
        <WorktreeDeleteErrorBanner message={GIT_DELETE_STDERR} onRetry={noop} onDismiss={noop} />
      </Specimen>
      <Specimen label="WorktreeIssueErrorBanner · attach" width={320}>
        <WorktreeIssueErrorBanner
          message="GitHub returned 403: Resource not accessible by integration"
          mutationType="attach-issue"
          onRetry={noop}
          onDismiss={noop}
        />
      </Specimen>
      <Specimen label="WorktreeIssueErrorBanner · detach" width={320}>
        <WorktreeIssueErrorBanner
          message="Network request failed — check your connection and try again."
          mutationType="detach-issue"
          onRetry={noop}
          onDismiss={noop}
        />
      </Specimen>
    </Scene>
  );
}

// ---- missing-cli -----------------------------------------------------------

function MissingCliScene() {
  return (
    <Scene>
      <Specimen label="MissingCliGate · missing" width={560}>
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="claude"
            detail={{
              state: "missing",
              resolvedPath: "/Users/you/.local/bin/claude",
              via: null,
            }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
      <Specimen label="MissingCliGate · installed (not launchable)" width={560}>
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="codex"
            detail={{
              state: "installed",
              resolvedPath: "/opt/homebrew/bin/codex",
              via: "which",
              message:
                "Found /opt/homebrew/bin/codex, but it is a shell function wrapper and can't be launched directly.",
            }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
      <Specimen label="MissingCliGate · blocked" width={560}>
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="gemini"
            detail={{
              state: "blocked",
              resolvedPath: "/usr/local/bin/gemini",
              via: "which",
              message: "Execution of /usr/local/bin/gemini was denied (EPERM).",
            }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
      <Specimen label="MissingCliGate · ready" width={560}>
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="claude"
            detail={{ state: "ready", resolvedPath: "/Users/you/.local/bin/claude", via: "which" }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
      <Specimen label="MissingCliGate · unauthenticated" width={560}>
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="codex"
            detail={{
              state: "unauthenticated",
              resolvedPath: "/opt/homebrew/bin/codex",
              via: "which",
            }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
      <Specimen label="MissingCliGate · re-check failed" width={560} id="recheck-failed">
        <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default">
          <MissingCliGate
            agentId="gemini"
            detail={{
              state: "blocked",
              resolvedPath: "/usr/local/bin/gemini",
              via: "which",
              message: "Execution of /usr/local/bin/gemini was denied (EPERM).",
            }}
            onRunAnyway={noop}
            onAvailabilityReady={noop}
            onOpenAgentSettings={noop}
          />
        </div>
      </Specimen>
    </Scene>
  );
}

// ---- typed-name ------------------------------------------------------------

function TypedName({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <TypedNameConfirmInput target="helios-dashboard" value={value} onChange={setValue} />;
}

function TypedNameScene() {
  return (
    <Scene>
      <Specimen label="TypedNameConfirmInput · empty" width={480}>
        <TypedName initial="" />
      </Specimen>
      <Specimen label="TypedNameConfirmInput · mismatch" width={480} id="typed-mismatch">
        <TypedName initial="helios-dash" />
      </Specimen>
    </Scene>
  );
}

// ---- settings-load-error ---------------------------------------------------

function SettingsScene() {
  return (
    <Scene>
      <Specimen label="SettingsLoadErrorBanner" width={640}>
        <SettingsLoadErrorBanner
          title="Couldn't load agent settings"
          message="EACCES: permission denied, open '/Users/you/Library/Application Support/Daintree/agent-settings.json'"
          onRetry={noop}
        />
      </Specimen>
      <Specimen label="SettingsLoadErrorBanner · no title" width={640}>
        <SettingsLoadErrorBanner
          message="The settings store didn't answer in time."
          onRetry={noop}
        />
      </Specimen>
      <Specimen label="SettingsRow · error" width={640}>
        <SettingsGroup>
          <SettingsRow
            label="Dev server port"
            description="The port the dev preview connects to."
            error="Port must be between 1024 and 65535"
            control={({ labelId, descriptionId }) => (
              <Input
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid
                defaultValue="80"
                className="w-28"
              />
            )}
          />
        </SettingsGroup>
      </Specimen>
      <Specimen label="SettingsInlineError" width={640}>
        <SettingsInlineError>
          Couldn&apos;t save the shortcut: ⌘K is already bound to Open command palette.
        </SettingsInlineError>
      </Specimen>
    </Scene>
  );
}

// ---- plugin-errors ---------------------------------------------------------

const PROJECT_ID = "proj-helios";

const INVALID_PLUGIN: ProjectPluginInfo = {
  projectId: PROJECT_ID,
  id: "release-notes",
  displayName: "Release notes",
  version: "0.3.1",
  description: "Drafts release notes from merged pull requests.",
  capabilities: ["network:fetch"],
  dirName: "release-notes",
  state: "invalid",
  muted: false,
  error:
    'plugin.json: `contributes.commands[2].id` must match /^[a-z][a-z0-9.-]*$/ (got "Draft Notes")',
  loadError: {
    message: "activate() threw: TypeError: Cannot read properties of undefined (reading 'token')",
    at: 1_764_000_000_000,
  },
  collidesWithGlobal: true,
};

const CLASH_PLUGIN: ProjectPluginInfo = {
  projectId: PROJECT_ID,
  id: "helios.linear-sync",
  instanceId: `project__${PROJECT_ID}__helios.linear-sync`,
  displayName: "Linear Sync",
  version: "2.4.0",
  capabilities: [],
  dirName: "linear-sync",
  state: "active",
  muted: false,
  collidesWithGlobal: true,
};

function PluginErrorsScene() {
  useEffect(() => {
    // Every poll after the first snapshot fails, so the crashed row stays and
    // the section error appears under it on the next tick.
    const timer = setTimeout(() => {
      mcpShot.listFails = true;
    }, MCP_LIST_OK_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Scene>
      <Specimen label="PluginLogsSection · error" width={480}>
        <PluginLogsSection
          lines={null}
          loading={false}
          error="Couldn't read this plugin's log buffer: plugin host is restarting"
          refresh={noop}
        />
      </Specimen>
      <Specimen label="PluginMcpServersSection · crashed + errors" width={480} id="mcp">
        <PluginMcpServersSection
          pluginId={MCP_PLUGIN_ID}
          declared={[
            { id: "linear", name: "Linear MCP", command: "node" },
            { id: "search", name: "Issue search", command: "node" },
          ]}
        />
      </Specimen>
      <Specimen label="ProjectPluginSection · rows" width={320}>
        <ProjectPluginSection
          plugins={[INVALID_PLUGIN, CLASH_PLUGIN]}
          selectedId={INVALID_PLUGIN.id}
          onSelect={noop}
        />
      </Specimen>
      <Specimen label="ProjectPluginDetailPane · invalid + loadError + clash" width={480}>
        <ProjectPluginDetailPane plugin={INVALID_PLUGIN} />
      </Specimen>
    </Scene>
  );
}

// ---- severity-vocabulary ---------------------------------------------------

const CALLOUT_TONES: CalloutSeverity[] = [
  "error",
  "warning",
  "danger",
  "success",
  "info",
  "neutral",
];
const CALLOUT_COPY: Record<CalloutSeverity, [string, string]> = {
  error: ["Couldn't save settings", "EACCES: permission denied, open settings.json"],
  warning: [
    "Default recipe unavailable",
    "The pinned recipe was deleted or is no longer eligible.",
  ],
  danger: ["This deletes the worktree", "Uncommitted changes in feature-auth-refresh are lost."],
  success: ["CLI is now available", "The agent binary was detected. Re-check to continue."],
  info: [
    "Plugins reload on restart",
    "Changes to plugin files apply the next time Daintree starts.",
  ],
  neutral: ["Sign-in not detected", "The CLI prompts for sign-in on its first run."],
};
const BANNER_TITLE = { warning: "Warning banner", info: "Info banner", neutral: "Neutral banner" };
const MARK_LEVELS: StatusSeverity[] = ["success", "error", "warning", "info"];

function SeverityVocabularyScene() {
  // A tone this build's Callout does not know is skipped, so the same scene
  // captures a tree from before the tone existed.
  const tones = CALLOUT_TONES.filter((tone) => tone in CALLOUT_ICON);
  return (
    <Scene>
      <Specimen label="Callout · default" width={560}>
        {tones.map((tone) => (
          <Callout key={tone} severity={tone} title={CALLOUT_COPY[tone][0]}>
            <p>{CALLOUT_COPY[tone][1]}</p>
          </Callout>
        ))}
      </Specimen>
      <Specimen label="Callout · compact, untitled" width={560}>
        {tones.map((tone) => (
          <Callout key={tone} severity={tone} size="compact">
            <p>{CALLOUT_COPY[tone][1]}</p>
          </Callout>
        ))}
      </Specimen>
      <Specimen label="InlineStatusBanner" width={560}>
        <InlineStatusBanner
          severity="error"
          title="Error banner"
          description="The pane-level band for the same severity."
          animated={false}
        />
        {(["warning", "info", "neutral"] as const).map((tone) => (
          <InlineStatusBanner
            key={tone}
            severity={tone}
            title={BANNER_TITLE[tone]}
            description="The pane-level band for the same severity."
            animated={false}
            actions={[]}
          />
        ))}
        <InlineStatusBanner
          severity="success"
          title="Success banner"
          description="The pane-level band for the same severity."
          animated={false}
          onClose={noop}
          autoDismissAfter={3_600_000}
        />
      </Specimen>
      <Specimen label="InlineError · SeverityMark" width={560}>
        <InlineError>Name is required</InlineError>
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          {MARK_LEVELS.map((level) => (
            <span key={level} className="inline-flex items-center gap-1">
              <SeverityMark severity={level} label={level} className="h-3.5 w-3.5" />
              {level}
            </span>
          ))}
        </div>
      </Specimen>
    </Scene>
  );
}

// ---- system-requirements ---------------------------------------------------

function SystemRequirementsScene() {
  const [secondMounted, setSecondMounted] = useState(false);

  useEffect(() => {
    // Only once the first section shows its error does the bridge start
    // answering, so StrictMode's repeated mount reads can't reach the working
    // list and clear it. The second section then reads the real specs.
    const timer = setInterval(() => {
      const first = document.querySelector('[data-specimen="health-error"]');
      if (!first?.textContent?.includes("Could not run health check")) return;
      clearInterval(timer);
      setTimeout(() => {
        healthShot.specsFail = false;
        setSecondMounted(true);
      }, HEALTH_SETTLE_MS);
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Scene>
      <Specimen
        label="SystemRequirementsSection · health check failed"
        width={560}
        id="health-error"
      >
        <SystemRequirementsSection onFatalFailureChange={noop} onCheckingChange={noop} />
      </Specimen>
      <Specimen label="SystemRequirementsSection · fatal failure" width={560} id="health-fatal">
        {secondMounted && (
          <SystemRequirementsSection onFatalFailureChange={noop} onCheckingChange={noop} />
        )}
      </Specimen>
    </Scene>
  );
}

// The hook re-runs its check on window focus, which would let the first
// section read the now-working spec list and clear its error. Swallow focus
// here, ahead of the hook's own listener.
if (state === "system-requirements") {
  window.addEventListener("focus", (event) => event.stopImmediatePropagation(), true);
}

// ---- dialogs ---------------------------------------------------------------

function CommitPushDialog() {
  const [message, setMessage] = useState(
    "Fix token refresh race in auth client\n\nRetry once with a fresh token before surfacing 401."
  );
  return (
    <div className="p-6" style={{ width: 520 }}>
      <CommitPanel
        stagedCount={3}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={null}
        worktreePath="/Users/you/Code/helios-dashboard"
        currentBranch="fix/auth-refresh"
        commitMessage={message}
        onCommitMessageChange={setMessage}
        onCommit={async () => undefined}
        onCommitAndPush={async () => undefined}
        isPushing={false}
        pushProgress={new Map()}
        pushTargetBranch={null}
        skipPushConfirm={false}
        onSetSkipPushConfirm={noop}
      />
    </div>
  );
}

const CRASH: PendingCrash = {
  logPath: "/Users/you/Library/Logs/Daintree/crash-2026-09-28T10-14-03.json",
  hasBackup: true,
  backupTimestamp: 1_764_000_000_000 - 120_000,
  crashCount: 1,
  panels: [
    {
      id: "p1",
      kind: "agent",
      title: "Claude — fix auth refresh",
      cwd: "/Users/you/Code/helios-dashboard",
      location: "grid",
      isSuspect: false,
    },
    {
      id: "p2",
      kind: "terminal",
      title: "npm run dev",
      cwd: "/Users/you/Code/helios-dashboard",
      location: "grid",
      isSuspect: false,
    },
  ],
  entry: {
    id: "crash-1",
    timestamp: 1_764_000_000_000 - 60_000,
    appVersion: "0.9.4",
    platform: "darwin",
    osVersion: "25.4.0",
    arch: "arm64",
    electronVersion: "42.0.1",
    sessionDurationMs: 3_540_000,
    totalMemory: 34_359_738_368,
    freeMemory: 1_288_490_188,
    panelCount: 2,
    errorMessage:
      "RangeError: Maximum call stack size exceeded\n    while serializing terminal snapshot for panel p1",
    errorStack:
      "RangeError: Maximum call stack size exceeded\n    at serializeBuffer (pty-host/serializer.js:212:19)\n    at serializeBuffer (pty-host/serializer.js:218:12)\n    at snapshotPanel (pty-host/index.js:88:5)",
  },
};

const CRASH_CONFIG: CrashRecoveryConfig = { autoRestoreOnCrash: false };

function CrashDialog() {
  return (
    <CrashRecoveryDialog
      crash={CRASH}
      config={CRASH_CONFIG}
      onResolve={async () => undefined}
      onUpdateConfig={async () => undefined}
      initialError={
        state === "crash-recovery"
          ? "Couldn't restore 2 panels: the session backup is from an older schema (v7)."
          : undefined
      }
    />
  );
}

const PR_FIXTURE: PR = {
  number: 2481,
  title: "Retry token refresh once before surfacing 401",
  body: "",
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  url: "https://github.com/helios-labs/helios-dashboard/pull/2481",
  baseRef: "main",
  headRef: "fix/auth-refresh",
  createdAt: 1_764_000_000_000 - 86_400_000,
  updatedAt: 1_764_000_000_000 - 3_600_000,
  rawData: null,
} as PR;

const worktreeStore = createWorktreeStore();

function NewWorktree() {
  return (
    <WorktreeStoreContext.Provider value={worktreeStore}>
      <NewWorktreeDialog
        isOpen
        onClose={noop}
        rootPath="/Users/you/Code/helios-dashboard"
        initialPR={state === "new-worktree-pr" ? PR_FIXTURE : null}
      />
    </WorktreeStoreContext.Provider>
  );
}

// ---- seeding ---------------------------------------------------------------

function seed() {
  if (state === "missing-cli") {
    // Re-check fails outright, so the gate's own "couldn't re-check" banner shows.
    useCliAvailabilityStore.setState({
      refresh: () => Promise.reject(new Error("availability probe timed out")),
    });
  }
  if (state === "plugin-errors") {
    useProjectPluginStore.setState({
      error: "Couldn't reload .daintree/plugins: EMFILE, too many open files",
    });
  }
  if (state === "archive-install") {
    usePluginArchiveInstallStore.getState().enqueue({
      intentId: "preview-archive-danger",
      archivePath: "/Users/you/Downloads/deploy-runner-1.2.0.dntr",
      archiveFileName: "deploy-runner-1.2.0.dntr",
      manifest: {
        name: "deploy-runner",
        displayName: "Deploy Runner",
        version: "1.2.0",
        category: "workspace",
        authors: [{ name: "Helios Labs" }],
        capabilities: ["shell:exec", "network:fetch", "fs:project-read"],
        recipes: { count: 0, names: [] },
      },
    });
  }
  if (state === "mcp-confirm-destructive") {
    useMcpConfirmStore.getState().enqueue({
      requestId: "preview-mcp-destructive",
      actionId: "worktree.delete",
      actionTitle: "Delete worktree",
      actionDescription: "Remove a worktree and its folder from disk.",
      dangerRationale:
        "Deletes the worktree folder and every uncommitted change in it. This can't be undone.",
      subject: "feature/auth-refresh",
      argsSummary: '{ "worktreeId": "wt-feature-auth-refresh", "force": true }',
      danger: "confirm",
      sessionOrigin: "help",
      previewTitle: "Working tree changes",
      preview: [
        "3 files with uncommitted changes:",
        " M src/auth/refresh.ts",
        " M src/auth/client.ts",
        "?? src/auth/__tests__/refresh.race.test.ts",
        "⚠ 2 local commits are not on any remote and will be lost",
      ],
      enqueuedAt: Date.now(),
    });
  }
}

function Preview() {
  if (INLINE_SCENES.has(state)) return <InlineScene />;
  // Dialogs portal out of the tree, so the shell is what says the page mounted.
  return (
    <div data-preview-shell className="h-screen w-screen">
      <DialogScene />
    </div>
  );
}

function InlineScene() {
  switch (state) {
    case "worktree-banners":
      return <WorktreeBannersScene />;
    case "missing-cli":
      return <MissingCliScene />;
    case "typed-name":
      return <TypedNameScene />;
    case "settings-load-error":
      return <SettingsScene />;
    case "plugin-errors":
      return <PluginErrorsScene />;
    case "system-requirements":
      return <SystemRequirementsScene />;
    case "severity-vocabulary":
      return <SeverityVocabularyScene />;
    default:
      return null;
  }
}

function DialogScene() {
  switch (state) {
    case "archive-install":
      return <PluginArchiveInstallConfirmDialog />;
    case "commit-push":
      return <CommitPushDialog />;
    case "crash-recovery":
    case "crash-report-error":
      return <CrashDialog />;
    case "lifecycle-approval":
      return (
        <LifecycleCommandApprovalDialog
          isOpen
          worktreeId="wt-feature-auth-refresh"
          setupAwaitingApproval
          onClose={noop}
        />
      );
    case "new-worktree-error":
    case "new-worktree-pr":
      return <NewWorktree />;
    case "mcp-confirm-destructive":
      return <McpConfirmDialog />;
    default:
      return <p className="p-8 text-text-primary">Unknown state: {state}</p>;
  }
}

seed();

// Radix loads lazily. Rendering before it lands lets a Tooltip see the loaded
// primitives in the same pass its provider still renders bare children, which
// React reports as a recovered render error — so render once it is in.
void Promise.all([primeRadix(), import("framer-motion")]).then(
  ([, { LazyMotion, domAnimation }]) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <Preview />
          </TooltipProvider>
        </LazyMotion>
      </StrictMode>
    );
  }
);
