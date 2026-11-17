// @vitest-environment jsdom
/**
 * Every host in ModalHostLayer whose dialog answers a waiting request must
 * settle that request when the dialog's chunk fails to load, and settle the
 * next one too rather than hold it behind a fallback for the session (#17204).
 * The real layer and the real stores, with each dialog replaced by a chunk
 * that rejects.
 */
import { lazy, type ComponentProps, type ComponentType } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chunks = vi.hoisted(() => ({
  impl: new Map<string, ComponentType>(),
  loads: new Map<string, number>(),
}));

const LAZY_NAMES = vi.hoisted(() => [
  "LazyPilotView",
  "LazyCanopyOffer",
  "LazyCrossWorktreeDiff",
  "LazySettingsDialog",
  "LazyShortcutReferenceDialog",
  "LazyPluginManagerView",
  "LazyMcpConfirmDialog",
  "LazyPluginConfirmDialog",
  "LazyLayoutApplyConfirmDialog",
  "LazyRecipeRunConfirmDialog",
  "LazyScheduleRunConfirmDialog",
  "LazyPluginArchiveInstallConfirmDialog",
  "LazyPluginMcpConfirmDialog",
  "LazyPluginQuickPickDialog",
  "LazyPluginSendToAgentDialog",
  "LazyPluginInputBoxDialog",
  "LazyPluginConfirmPromptDialog",
  "LazyPluginRunRecipeDialog",
  "LazyPluginCapabilityConfirmDialog",
  "LazyPanelDialogHost",
  "LazyGitInitDialog",
  "LazyCreateProjectFolderDialog",
  "LazyCloneRepoDialog",
  "LazyPanelLimitConfirmDialog",
  "LazyDiagnosticsReviewDialogHost",
  "LazyGitPushConfirmDialog",
  "LazyGitPullRebaseConfirmDialog",
  "LazyFileMutationConfirmDialog",
  "LazyGitWorktreeOperationConfirmDialog",
  "LazyGitForcePushConfirmDialog",
  "LazyProjectSleepConfirmDialog",
  "LazyWorktreeResourceTeardownConfirmDialog",
  "LazyRecipeConflictDialog",
  "LazyOnboardingFlow",
  "LazyGettingStartedChecklist",
  "LazyProjectGroupDialogs",
]);

vi.mock("../lazyPanels", () =>
  Object.fromEntries(
    LAZY_NAMES.map((name) => [
      name,
      function ChunkHost() {
        const Chunk = chunks.impl.get(name);
        return Chunk ? <Chunk /> : null;
      },
    ])
  )
);

vi.mock("../PaletteHosts", () => {
  const Null = () => null;
  return {
    QuickSwitcherHost: Null,
    SendToAgentPaletteHost: Null,
    WorktreePaletteHost: Null,
    QuickCreatePaletteHost: Null,
    PanelPaletteHost: Null,
    ThemePaletteHost: Null,
    ResumeSessionsPaletteHost: Null,
    RecentDictationsPaletteHost: Null,
    LogLevelPaletteHost: Null,
    ActionPaletteHost: Null,
    WorktreeOverviewHost: Null,
  };
});
vi.mock("@/components/Tour/TourHost", () => ({ TourHost: () => null }));
vi.mock("../components/Project/StopProjectConfirmDialog", () => ({
  StopProjectConfirmDialog: () => null,
}));
vi.mock("../components/Project/ProjectSwitcherModalLayer", () => ({
  ProjectSwitcherModalLayer: () => null,
}));
vi.mock("../components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("../components/ui/ShortcutHint", () => ({ ShortcutHint: () => null }));
vi.mock("../components/ui/ReEntrySummary", () => ({ ReEntrySummary: () => null }));
vi.mock("../components/Terminal/TerminalInfoDialogHost", () => ({
  TerminalInfoDialogHost: () => null,
}));
vi.mock("../components/PostHydrationListeners", () => ({ PostHydrationListeners: () => null }));
vi.mock("../components/HostFilePicker/HostFilePickerMount", () => ({
  HostFilePickerMount: () => null,
}));
vi.mock("../components/HostSwitch/HostSwitchMount", () => ({ HostSwitchMount: () => null }));
vi.mock("../components/Hosts/Overview/HostsOverviewMount", () => ({
  HostsOverviewMount: () => null,
}));
vi.mock("../components/Panel", () => ({
  MaximizeFlights: () => null,
  PanelTransitionOverlay: () => null,
}));
vi.mock("../store", () => ({
  usePluginManagerStore: { getState: () => ({ close: () => {} }) },
}));
vi.mock("../store/projectGroupsStore", () => ({
  useProjectGroupsStore: (selector: (s: { dialog: null }) => unknown) => selector({ dialog: null }),
}));
vi.mock("@/store/pilotStore", () => ({
  usePilotStore: (selector: (s: { isOpen: boolean }) => unknown) => selector({ isOpen: false }),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: { currentScratch: null }) => unknown) =>
    selector({ currentScratch: null }),
}));
vi.mock("@/hooks/app/useCanopyOfferShown", () => ({ useCanopyOfferShown: () => false }));

// The boundary's reporting path, which a caught chunk failure goes through.
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
  getRendererSentryConsent: vi.fn(() => ({ level: "off", hasSeenPrompt: false })),
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { ModalHostLayer } from "../ModalHostLayer";
import { useModalResetKeys } from "../hooks/app/useModalResetKeys";
import { __resetMcpConfirmStoreForTesting, requestMcpConfirmation } from "@/store/mcpConfirmStore";
import {
  __resetPluginConfirmStoreForTesting,
  requestPluginConfirmation,
} from "@/store/pluginConfirmStore";
import {
  __resetPluginMcpConfirmStoreForTesting,
  requestPluginMcpConsent,
} from "@/store/pluginMcpConfirmStore";
import {
  __resetPluginCapabilityConfirmStoreForTesting,
  requestPluginCapabilityConsent,
} from "@/store/pluginCapabilityConfirmStore";
import {
  __resetPluginArchiveInstallStoreForTesting,
  usePluginArchiveInstallStore,
} from "@/store/pluginArchiveInstallStore";
import {
  __resetPluginPromptStoreForTesting,
  enqueueUiPrompt,
  usePluginPromptStore,
} from "@/store/pluginPromptStore";
import {
  cancelLayoutApplyConfirmations,
  requestLayoutApplyConfirmation,
} from "@/store/layoutApplyConfirmStore";
import {
  cancelRecipeRunConfirmations,
  requestRecipeRunConfirmation,
} from "@/store/recipeRunConfirmStore";
import {
  cancelScheduleRunConfirmations,
  requestScheduleRunConfirmation,
} from "@/store/scheduleRunConfirmStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useFileMutationConfirmStore } from "@/store/fileMutationConfirmStore";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useWorktreeResourceTeardownConfirmStore } from "@/store/worktreeResourceTeardownConfirmStore";
import type { PluginUiPromptParams } from "@shared/types/pluginUiPrompt";

type LayerProps = ComponentProps<typeof ModalHostLayer>;

const noop = () => {};
const BASE_PROPS = {
  resumeSession: async () => {},
  handleLaunchAgent: noop,
  defaultTerminalCwd: undefined,
  activeWorktreeId: null,
  isProjectSwitcherModalOpen: false,
  projectSwitcherPalette: {},
  isWorktreeOverviewOpen: false,
  closeWorktreeOverview: noop,
  selectWorktree: noop,
  availability: {},
  crossDiffDialog: { isOpen: false, initialWorktreeId: null },
  shouldMountCrossDiffDialog: false,
  closeCrossWorktreeDiff: noop,
  isSettingsOpen: false,
  shouldMountSettings: false,
  setIsSettingsOpen: noop,
  settingsTab: undefined,
  settingsSubtab: undefined,
  settingsSectionId: undefined,
  settingsNavNonce: 0,
  refreshSettings: async () => {},
  currentProject: null,
  isShortcutsOpen: false,
  shouldMountShortcutsDialog: false,
  setIsShortcutsOpen: noop,
  isPluginManagerOpen: false,
  shouldMountPluginManager: false,
  pluginDeepLink: { intent: null, clear: noop },
  isStateLoaded: true,
  gitInitDialogOpen: false,
  shouldMountGitInitDialog: false,
  effectiveGitInitPath: null,
  effectiveGitInitIdentity: null,
  effectiveGitInitGroupId: null,
  gitInitDialogStep: "confirm",
  handleGitInitSuccess: async () => {},
  openWithoutGit: async () => {},
  closeGitInitDialog: noop,
  createFolderDialogOpen: false,
  shouldMountCreateFolderDialog: false,
  closeCreateFolderDialog: noop,
  cloneRepoDialogOpen: false,
  shouldMountCloneRepoDialog: false,
  handleCloneSuccess: async () => {},
  startBackgroundClone: async () => {},
  closeCloneRepoDialog: noop,
  reEntrySummary: {},
  gettingStarted: { visible: false, checklist: null },
} as unknown as Omit<LayerProps, keyof ReturnType<typeof useModalResetKeys>>;

/** The layer as App mounts it, with its reset keys read from the live stores. */
function Layer() {
  const keys = useModalResetKeys();
  return <ModalHostLayer {...BASE_PROPS} {...keys} />;
}

function breakChunk(name: string) {
  chunks.loads.set(name, 0);
  chunks.impl.set(
    name,
    lazy(() => {
      chunks.loads.set(name, (chunks.loads.get(name) ?? 0) + 1);
      return Promise.reject(new Error(`${name} chunk failed to load`));
    })
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await flush();
  return !done;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function prompt(params: PluginUiPromptParams) {
  return enqueueUiPrompt({ promptId: nextId("prompt"), pluginId: "acme.tools", params });
}

interface Host {
  chunk: string;
  request: () => Promise<unknown>;
  declined: unknown;
}

const HOSTS: Record<string, Host> = {
  McpConfirmDialog: {
    chunk: "LazyMcpConfirmDialog",
    request: () =>
      requestMcpConfirmation({
        requestId: nextId("mcp"),
        actionId: "worktree.delete",
        actionTitle: "Delete worktree",
        actionDescription: "Permanently delete a worktree.",
        argsSummary: "{}",
        danger: "confirm",
      }),
    declined: { decision: "rejected" },
  },
  PluginConfirmDialog: {
    chunk: "LazyPluginConfirmDialog",
    request: () =>
      requestPluginConfirmation({
        requestId: nextId("plugin-confirm"),
        pluginId: "acme.tools",
        actionId: "acme.tools.wipe",
        actionTitle: "Wipe",
        actionDescription: "Wipes it.",
        effectiveDanger: "confirm",
        argsSummary: "",
      }),
    declined: "rejected",
  },
  PluginMcpConfirmDialog: {
    chunk: "LazyPluginMcpConfirmDialog",
    request: () =>
      requestPluginMcpConsent({
        requestId: nextId("plugin-mcp"),
        pluginId: "acme.tools",
        serverId: "srv",
        toolName: "do_thing",
        pluginDisplayName: "Acme",
        descriptionDisplay: "Does a thing",
        argsSummary: "",
        dangerTier: "D1",
        declaredCapabilities: [],
        reason: "first-use",
      }),
    declined: "rejected",
  },
  PluginCapabilityConfirmDialog: {
    chunk: "LazyPluginCapabilityConfirmDialog",
    request: () =>
      requestPluginCapabilityConsent({
        requestId: nextId("capability"),
        pluginId: "acme.tools",
        pluginDisplayName: "Acme",
        capability: "shell:exec",
        declaredCapabilities: ["shell:exec"],
      }),
    declined: "rejected",
  },
  PluginQuickPickDialog: {
    chunk: "LazyPluginQuickPickDialog",
    request: () => prompt({ kind: "quickPick", items: [], options: {} }),
    declined: undefined,
  },
  PluginInputBoxDialog: {
    chunk: "LazyPluginInputBoxDialog",
    request: () => prompt({ kind: "inputBox", options: {} }),
    declined: undefined,
  },
  PluginConfirmPromptDialog: {
    chunk: "LazyPluginConfirmPromptDialog",
    request: () => prompt({ kind: "confirm", options: { title: "Ship it?" } }),
    declined: false,
  },
  PluginSendToAgentDialog: {
    chunk: "LazyPluginSendToAgentDialog",
    request: () => prompt({ kind: "sendToAgent", request: { text: "hi", sourceLabel: "Acme" } }),
    declined: { status: "cancelled" },
  },
  PluginRunRecipeDialog: {
    chunk: "LazyPluginRunRecipeDialog",
    request: () =>
      prompt({
        kind: "runRecipe",
        request: { recipeId: "r1", variables: {}, sourceLabel: "Acme" },
      }),
    declined: { status: "cancelled" },
  },
  LayoutApplyConfirmDialog: {
    chunk: "LazyLayoutApplyConfirmDialog",
    request: () =>
      requestLayoutApplyConfirmation({
        layoutId: nextId("layout"),
        layoutName: "Review",
        pluginName: "Acme",
        previewLines: [],
      }),
    declined: false,
  },
  RecipeRunConfirmDialog: {
    chunk: "LazyRecipeRunConfirmDialog",
    request: () => requestRecipeRunConfirmation({ recipeName: "Build", missing: ["issue"] }),
    declined: false,
  },
  ScheduleRunConfirmDialog: {
    chunk: "LazyScheduleRunConfirmDialog",
    request: () =>
      requestScheduleRunConfirmation({ scheduleName: "Nightly", policy: "skip", openRunCount: 1 }),
    declined: false,
  },
  PanelLimitConfirmDialog: {
    chunk: "LazyPanelLimitConfirmDialog",
    request: () =>
      usePanelLimitStore.getState().requestConfirmation({
        currentCount: 20,
        requestedCount: 2,
        allowedCount: 2,
        confirmationLimit: 20,
        hardLimit: 32,
      }),
    declined: false,
  },
  GitPushConfirmDialog: {
    chunk: "LazyGitPushConfirmDialog",
    request: () => useGitPushConfirmStore.getState().requestConfirmation("/repo"),
    declined: { confirmed: false, review: null },
  },
  GitPullRebaseConfirmDialog: {
    chunk: "LazyGitPullRebaseConfirmDialog",
    request: () => useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo"),
    declined: false,
  },
  FileMutationConfirmDialog: {
    chunk: "LazyFileMutationConfirmDialog",
    request: () =>
      useFileMutationConfirmStore
        .getState()
        .requestConfirmation({ kind: "discard", relativePath: "a.ts", worktreePath: "/repo" }),
    declined: null,
  },
  GitWorktreeOperationConfirmDialog: {
    chunk: "LazyGitWorktreeOperationConfirmDialog",
    request: () =>
      useGitWorktreeOperationConfirmStore
        .getState()
        .requestConfirmation({ kind: "merge-base", cwd: "/repo", baseBranch: "main" }),
    declined: { confirmed: false, pinned: null },
  },
  GitForcePushConfirmDialog: {
    chunk: "LazyGitForcePushConfirmDialog",
    request: () =>
      useGitForcePushStore.getState().requestConfirmation({
        cwd: "/repo",
        branchName: "feature",
        leaseSha: "abc123",
        generation: 1,
      } as Parameters<ReturnType<typeof useGitForcePushStore.getState>["requestConfirmation"]>[0]),
    declined: false,
  },
  RecipeConflictDialog: {
    chunk: "LazyRecipeConflictDialog",
    request: () =>
      useRecipeConflictStore.getState().requestConflict({
        recipeId: "r1",
        recipeName: "Build",
        updates: {},
        reason: "stale",
      }),
    declined: "cancel",
  },
  ProjectSleepConfirmDialog: {
    chunk: "LazyProjectSleepConfirmDialog",
    request: () =>
      useProjectSleepConfirmStore.getState().requestConfirmation({ kind: "idle", projects: [] }),
    declined: false,
  },
  WorktreeResourceTeardownConfirmDialog: {
    chunk: "LazyWorktreeResourceTeardownConfirmDialog",
    request: () =>
      useWorktreeResourceTeardownConfirmStore.getState().requestConfirmation({
        worktreeId: "wt-1",
        label: "feature",
        commands: ["docker compose down"],
        approved: true,
      }),
    declined: false,
  },
};

beforeEach(() => {
  chunks.impl.clear();
  chunks.loads.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  __resetMcpConfirmStoreForTesting();
  __resetPluginConfirmStoreForTesting();
  __resetPluginMcpConfirmStoreForTesting();
  __resetPluginCapabilityConfirmStoreForTesting();
  __resetPluginArchiveInstallStoreForTesting();
  __resetPluginPromptStoreForTesting();
  cancelLayoutApplyConfirmations();
  cancelRecipeRunConfirmations();
  cancelScheduleRunConfirmations();
  vi.restoreAllMocks();
});

describe("ModalHostLayer confirm hosts whose chunk fails", () => {
  it.each(Object.entries(HOSTS))(
    "%s declines the waiting request and every one after it",
    async (_name, host) => {
      breakChunk(host.chunk);
      let first!: Promise<unknown>;
      act(() => {
        first = host.request();
      });
      render(<Layer />);
      await flush();
      expect(await first).toEqual(host.declined);

      let second!: Promise<unknown>;
      act(() => {
        second = host.request();
      });
      await flush();
      expect(await second).toEqual(host.declined);
      // The boundary reset for the second request; the chunk itself was not
      // fetched again, so declining is what kept it from waiting.
      expect(chunks.loads.get(host.chunk)).toBe(1);
    }
  );

  it("works through a queue that built up behind a dialog that can't load", async () => {
    breakChunk("LazyPluginConfirmDialog");
    render(<Layer />);
    await flush();

    const queued = [0, 1, 2].map(() => HOSTS.PluginConfirmDialog!.request());
    await flush();

    await expect(Promise.all(queued)).resolves.toEqual(["rejected", "rejected", "rejected"]);
  });

  it("moves a stalled archive install queue on, though nothing awaits it", async () => {
    breakChunk("LazyPluginArchiveInstallConfirmDialog");
    render(<Layer />);
    await flush();

    act(() => {
      usePluginArchiveInstallStore.getState().enqueue({
        intentId: "i1",
        archivePath: "/tmp/a.daintree-plugin",
      } as Parameters<ReturnType<typeof usePluginArchiveInstallStore.getState>["enqueue"]>[0]);
      usePluginArchiveInstallStore.getState().enqueue({
        intentId: "i2",
        archivePath: "/tmp/b.daintree-plugin",
      } as Parameters<ReturnType<typeof usePluginArchiveInstallStore.getState>["enqueue"]>[0]);
    });
    await flush();

    expect(usePluginArchiveInstallStore.getState().current).toBeNull();
    expect(usePluginArchiveInstallStore.getState().queue).toEqual([]);
  });

  it("leaves a plugin prompt of another kind alone when one prompt dialog's chunk fails", async () => {
    breakChunk("LazyPluginQuickPickDialog");
    render(<Layer />);
    await flush();

    let confirm!: Promise<unknown>;
    let quickPick!: Promise<unknown>;
    act(() => {
      confirm = HOSTS.PluginConfirmPromptDialog!.request();
      quickPick = HOSTS.PluginQuickPickDialog!.request();
    });
    expect(await isPending(confirm)).toBe(true);
    expect(await isPending(quickPick)).toBe(true);

    act(() => usePluginPromptStore.getState().resolveCurrent(true));
    expect(await confirm).toBe(true);
    await flush();
    expect(await quickPick).toBeUndefined();
  });
});
