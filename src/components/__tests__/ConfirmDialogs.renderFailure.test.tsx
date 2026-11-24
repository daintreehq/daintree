// @vitest-environment jsdom
/**
 * A throw inside a confirmation dialog is caught by the dialog's own
 * ErrorBoundary, never the host's in ModalHostLayer, so that boundary must
 * answer the request it was showing (#17204). Otherwise a queued dialog keeps
 * every later request behind its fallback, and a single-slot dialog whose
 * content throws on its first render never runs the unmount cleanup that
 * would have declined it.
 *
 * The dialogs are real; the surface they draw into throws while open when the
 * request's copy says "Explode", or for any request while `explodeAll` is set.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ explodeAll: false, explodePromptId: null as string | null }));

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function OpenSurface(props: {
  isOpen: boolean;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  if (!props.isOpen) return null;
  const text = `${textOf(props.title)} ${textOf(props.description)}`;
  const promptId = usePluginPromptStore.getState().current?.promptId;
  if (
    surface.explodeAll ||
    text.includes("Explode") ||
    (promptId !== undefined && promptId === surface.explodePromptId)
  ) {
    throw new Error(`render failed: ${text}`);
  }
  return <div data-testid="open-surface">{text}</div>;
}

vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: OpenSurface }));
vi.mock("@/components/ui/AppDialog", () => ({ AppDialog: OpenSurface }));
vi.mock("@/components/ui/SearchablePalette", () => ({ SearchablePalette: OpenSurface }));

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
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { globalSkipPermissions: false, agents: {} } }),
}));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (state: unknown) => unknown) =>
    selector({ preferredAgentId: null }),
  selectActiveSlot: () => ({ agentId: null }),
}));
vi.mock("@/clients/pluginClient", () => ({
  pluginClient: {
    getWorktreeDeleteNoteSources: vi.fn(async () => []),
    getWorktreeDeleteNotes: vi.fn(() => new Promise(() => {})),
  },
}));

import { McpConfirmDialog } from "../McpConfirmDialog";
import { PluginConfirmDialog } from "../Plugin/PluginConfirmDialog";
import { PluginMcpConfirmDialog } from "../Plugin/PluginMcpConfirmDialog";
import { PluginCapabilityConfirmDialog } from "../Plugin/PluginCapabilityConfirmDialog";
import { PluginConfirmPromptDialog } from "../Plugin/PluginConfirmPromptDialog";
import { PluginQuickPickDialog } from "../Plugin/PluginQuickPickDialog";
import { PluginInputBoxDialog } from "../Plugin/PluginInputBoxDialog";
import { PanelLimitConfirmDialog } from "../Terminal/PanelLimitConfirmDialog";
import { GitPullRebaseConfirmDialog } from "../Git/GitPullRebaseConfirmDialog";
import { GitForcePushConfirmDialog } from "../Git/GitForcePushConfirmDialog";
import { RecipeConflictDialog } from "../TerminalRecipe/RecipeConflictDialog";
import { GitPushConfirmDialog } from "../Git/GitPushConfirmDialog";
import { GitWorktreeOperationConfirmDialog } from "../Git/GitWorktreeOperationConfirmDialog";
import { ErrorBoundary } from "../ErrorBoundary";
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
  __resetPluginPromptStoreForTesting,
  enqueueUiPrompt,
  usePluginPromptStore,
} from "@/store/pluginPromptStore";
import {
  declineFailedPanelLimitConfirmation,
  usePanelLimitStore,
  type PanelLimitConfirmRequest,
} from "@/store/panelLimitStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import { useGitForcePushStore, type ForcePushRecovery } from "@/store/gitForcePushStore";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import type { PluginUiPromptParams } from "@shared/types/pluginUiPrompt";
import type { PluginPresetLaunchSummary } from "@shared/utils/agentPresetLaunchConsent";

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

function shownText(): string | null {
  return screen.queryByTestId("open-surface")?.textContent ?? null;
}

beforeEach(() => {
  surface.explodeAll = false;
  surface.explodePromptId = null;
  // The git dialogs' preview reads, which never answer here, so a dialog that
  // is shown is shown on its loading state rather than on a failed read.
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { git: new Proxy({}, { get: () => () => new Promise(() => {}) }) },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  __resetMcpConfirmStoreForTesting();
  __resetPluginConfirmStoreForTesting();
  __resetPluginMcpConfirmStoreForTesting();
  __resetPluginCapabilityConfirmStoreForTesting();
  __resetPluginPromptStoreForTesting();
  usePanelLimitStore.getState().resolveConfirmation(false);
  useGitPullRebaseConfirmStore.getState().resolveConfirmation(null);
  useGitPushConfirmStore.getState().resolveConfirmation(null);
  useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
  const forcePush = useGitForcePushStore.getState().pendingConfirm;
  if (forcePush) useGitForcePushStore.getState().resolveConfirmation(forcePush.requestId, false);
  useRecipeConflictStore.getState().resolveConflict("cancel");
  vi.restoreAllMocks();
});

describe("queued dialogs answer the request whose content threw and show the next", () => {
  it("MCP action confirmation", async () => {
    const request = (requestId: string, actionTitle: string) =>
      requestMcpConfirmation({
        requestId,
        actionId: "worktree.delete",
        actionTitle,
        actionDescription: "Permanently delete a worktree.",
        argsSummary: "{}",
        danger: "confirm",
      });
    render(<McpConfirmDialog />);
    let failed!: Promise<unknown>;
    let next!: Promise<unknown>;
    act(() => {
      failed = request("a", "Explode worktree");
      next = request("b", "Delete worktree");
    });
    await flush();

    expect(await failed).toEqual({ decision: "rejected" });
    expect(await isPending(next)).toBe(true);
    expect(shownText()).toContain("Delete worktree");
  });

  it("plugin action confirmation", async () => {
    const request = (requestId: string, actionTitle: string) =>
      requestPluginConfirmation({
        requestId,
        pluginId: "acme.tools",
        actionId: "acme.tools.wipe",
        actionTitle,
        actionDescription: "Wipes it.",
        effectiveDanger: "confirm",
        argsSummary: "",
      });
    render(<PluginConfirmDialog />);
    let failed!: Promise<unknown>;
    let next!: Promise<unknown>;
    act(() => {
      failed = request("a", "Explode");
      next = request("b", "Wipe cache");
    });
    await flush();

    expect(await failed).toBe("rejected");
    expect(await isPending(next)).toBe(true);
    expect(shownText()).toContain("Wipe cache");
  });

  it("plugin MCP consent", async () => {
    const request = (requestId: string, toolName: string) =>
      requestPluginMcpConsent({
        requestId,
        pluginId: "acme.tools",
        serverId: "srv",
        toolName,
        pluginDisplayName: "Acme",
        descriptionDisplay: "Does a thing",
        argsSummary: "",
        dangerTier: "D1",
        declaredCapabilities: [],
        reason: "first-use",
      });
    render(<PluginMcpConfirmDialog />);
    let failed!: Promise<unknown>;
    let next!: Promise<unknown>;
    act(() => {
      failed = request("a", "Explode");
      next = request("b", "do_thing");
    });
    await flush();

    expect(await failed).toBe("rejected");
    expect(await isPending(next)).toBe(true);
    expect(shownText()).toContain("do_thing");
  });

  const preset: PluginPresetLaunchSummary = {
    agentId: "claude",
    agentName: "Claude",
    presetId: "zai",
    presetName: "Z.ai",
    source: "project",
    args: [],
    dangerousMode: "inherit",
    permissionLevel: "cli-default",
    envNames: [],
    fallbacks: [],
    fallbackOnRateLimit: false,
  };

  it.each([
    ["a capability", () => ({ capability: "shell:exec" as const })],
    ["an external site", () => ({ capability: "shell:exec" as const, site: "example.com" })],
    ["a preset launch", () => ({ capability: "agent:launch-preset" as const, preset })],
    ["restoring permissions", () => ({ restore: ["shell:exec" as const] })],
  ])("plugin capability consent for %s", async (_label, branch) => {
    const request = (requestId: string, pluginDisplayName: string) =>
      requestPluginCapabilityConsent({
        requestId,
        pluginId: "acme.tools",
        pluginDisplayName,
        declaredCapabilities: ["shell:exec"],
        ...branch(),
      });
    render(<PluginCapabilityConfirmDialog />);
    let failed!: Promise<unknown>;
    let next!: Promise<unknown>;
    act(() => {
      failed = request("a", "Explode Co");
      next = request("b", "Acme");
    });
    await flush();

    expect(await failed).toBe("rejected");
    expect(await isPending(next)).toBe(true);
    expect(shownText()).toContain("Acme");
  });

  it("plugin confirm prompt", async () => {
    render(<PluginConfirmPromptDialog />);
    let failed!: Promise<unknown>;
    let next!: Promise<unknown>;
    act(() => {
      failed = enqueueUiPrompt({
        promptId: "p1",
        pluginId: "acme.tools",
        params: { kind: "confirm", options: { title: "Explode?" } },
      });
      next = enqueueUiPrompt({
        promptId: "p2",
        pluginId: "acme.tools",
        params: { kind: "confirm", options: { title: "Ship it?" } },
      });
    });
    await flush();

    expect(await failed).toBe(false);
    expect(await isPending(next)).toBe(true);
    expect(shownText()).toContain("Ship it?");
  });

  it.each<[string, () => ReactElement, () => PluginUiPromptParams]>([
    [
      "quick pick",
      () => <PluginQuickPickDialog />,
      () => ({ kind: "quickPick", items: [], options: {} }),
    ],
    ["input box", () => <PluginInputBoxDialog />, () => ({ kind: "inputBox", options: {} })],
  ])("plugin %s prompt", async (_label, dialog, params) => {
    surface.explodePromptId = "p1";
    render(dialog());
    let failed!: Promise<unknown>;
    let sameKind!: Promise<unknown>;
    let otherKind!: Promise<unknown>;
    act(() => {
      failed = enqueueUiPrompt({ promptId: "p1", pluginId: "acme.tools", params: params() });
      sameKind = enqueueUiPrompt({ promptId: "p2", pluginId: "acme.tools", params: params() });
      // Another dialog's kind, so this one's failure must not touch it.
      otherKind = enqueueUiPrompt({
        promptId: "p3",
        pluginId: "acme.tools",
        params: { kind: "confirm", options: { title: "Ship it?" } },
      });
    });
    await flush();

    expect(await failed).toBeUndefined();
    // The dialog comes straight back for the next prompt of its own kind.
    expect(usePluginPromptStore.getState().current?.promptId).toBe("p2");
    expect(shownText()).not.toBeNull();
    expect(await isPending(sameKind)).toBe(true);
    expect(await isPending(otherKind)).toBe(true);
  });

  it("works through a long queue behind content that always throws", async () => {
    surface.explodeAll = true;
    render(<PluginConfirmDialog />);
    const queued: Promise<unknown>[] = [];
    act(() => {
      // Past React's limit of 50 nested updates, two of which each request costs.
      for (let i = 0; i < 60; i++) {
        queued.push(
          requestPluginConfirmation({
            requestId: `r${i}`,
            pluginId: "acme.tools",
            actionId: "acme.tools.wipe",
            actionTitle: "Wipe",
            actionDescription: "Wipes it.",
            effectiveDanger: "confirm",
            argsSummary: "",
          })
        );
      }
    });
    await flush();

    const answers = await Promise.all(queued);
    expect(answers.every((answer) => answer === "rejected")).toBe(true);
  });
});

describe("single-slot dialogs answer a request whose content throws on its first render", () => {
  const record: ForcePushRecovery = {
    cwd: "/repo",
    branchName: "feature",
    leaseSha: "abc123",
    generation: 1,
  } as ForcePushRecovery;

  it.each([
    {
      name: "panel limit",
      Dialog: PanelLimitConfirmDialog,
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
    {
      name: "pull and rebase",
      Dialog: GitPullRebaseConfirmDialog,
      request: () => useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo"),
      declined: { confirmed: false, review: null },
    },
    {
      name: "push",
      Dialog: GitPushConfirmDialog,
      request: () => useGitPushConfirmStore.getState().requestConfirmation("/repo"),
      declined: { confirmed: false, review: null },
    },
    {
      name: "worktree operation",
      Dialog: GitWorktreeOperationConfirmDialog,
      request: () =>
        useGitWorktreeOperationConfirmStore
          .getState()
          .requestConfirmation({ kind: "merge-base", cwd: "/repo", baseBranch: "main" }),
      declined: { confirmed: false, pinned: null, operation: null },
    },
    {
      name: "force push",
      Dialog: GitForcePushConfirmDialog,
      request: () => useGitForcePushStore.getState().requestConfirmation(record),
      declined: false,
    },
    {
      name: "recipe conflict",
      Dialog: RecipeConflictDialog,
      request: () =>
        useRecipeConflictStore.getState().requestConflict({
          recipeId: "r1",
          recipeName: "Build",
          updates: {},
          reason: "stale",
        }),
      declined: "cancel",
    },
  ])("$name", async ({ Dialog, request, declined }) => {
    surface.explodeAll = true;
    let first!: Promise<unknown>;
    act(() => {
      first = request();
    });
    render(<Dialog />);
    await flush();
    expect(await first).toEqual(declined);

    // The boundary resets for the next request and mounts the content afresh.
    let second!: Promise<unknown>;
    act(() => {
      second = request();
    });
    await flush();
    expect(await second).toEqual(declined);

    surface.explodeAll = false;
    let third!: Promise<unknown>;
    act(() => {
      third = request();
    });
    await flush();
    expect(await isPending(third)).toBe(true);
    expect(shownText()).not.toBeNull();
  });
});

describe("a panel limit host that fails above its own boundary", () => {
  const healthy: PanelLimitConfirmRequest = {
    currentCount: 20,
    requestedCount: 2,
    allowedCount: 2,
    confirmationLimit: 20,
    hardLimit: 32,
  };

  /** The dialog behind ModalHostLayer's boundary, wired as the layer wires it. */
  function Host() {
    const requestSeq = usePanelLimitStore((s) => s.requestSeq);
    return (
      <ErrorBoundary
        variant="component"
        componentName="PanelLimitConfirmDialog"
        resetKeys={[requestSeq]}
        onError={() => declineFailedPanelLimitConfirmation(requestSeq)}
      >
        <PanelLimitConfirmDialog />
      </ErrorBoundary>
    );
  }

  it("leaves the request its caller makes next alone when the unmounted dialog's cleanup runs", async () => {
    // Its copy is read in the host itself, above the dialog's own boundary.
    const broken = {
      ...healthy,
      get source(): never {
        throw new Error("unreadable request");
      },
    };
    render(<Host />);
    await flush();

    let retried: Promise<boolean> | null = null;
    let first!: Promise<boolean>;
    act(() => {
      first = usePanelLimitStore.getState().requestConfirmation(broken);
      void first.then(() => {
        retried = usePanelLimitStore.getState().requestConfirmation(healthy);
      });
    });
    await flush();

    expect(await first).toBe(false);
    expect(retried).not.toBeNull();
    expect(await isPending(retried!)).toBe(true);
    expect(shownText()).not.toBeNull();
  });
});
