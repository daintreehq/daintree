// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDevPreviewToolSessionsForTests,
  peekDevPreviewToolSession,
  publishDevPreviewToolContext,
  retainDevPreviewToolVisibility,
  startDevPreviewToolSessions,
} from "../sessionManager";
import {
  __resetDevPreviewToolsForTests,
  registerDevPreviewTool,
  type DevPreviewToolSessionContext,
} from "@/registry/devPreviewToolRegistry";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

const PLUGIN = "acme.tools";
const TOOL = "acme.tools.picker";
const PANEL = "preview-1";

interface FakeSession {
  contexts: DevPreviewToolSessionContext[];
  disposals: number;
  aborted: boolean;
  update: (context: DevPreviewToolSessionContext) => void;
  dispose: () => void;
}

const sessions: FakeSession[] = [];

function makeSession(context: DevPreviewToolSessionContext): FakeSession {
  const session: FakeSession = {
    contexts: [context],
    disposals: 0,
    aborted: false,
    update: (next) => session.contexts.push(next),
    dispose: () => {
      session.disposals++;
    },
  };
  context.signal.addEventListener("abort", () => {
    session.aborted = true;
  });
  sessions.push(session);
  return session;
}

function register(createSession: (context: DevPreviewToolSessionContext) => unknown): void {
  registerDevPreviewTool({
    id: TOOL,
    pluginId: PLUGIN,
    label: "Picker",
    Button: () => null,
    createSession: createSession as (context: DevPreviewToolSessionContext) => FakeSession,
  });
}

function panels(entries: Record<string, "grid" | "trash">): void {
  usePanelStore.setState({
    panelIds: Object.keys(entries),
    panelsById: Object.fromEntries(
      Object.entries(entries).map(([id, location]) => [id, { id, kind: "dev-preview", location }])
    ),
  } as never);
}

function switchOn(): void {
  useDevPreviewToolStore.getState().setActive(PANEL, TOOL);
}

function live(): FakeSession | null {
  return peekDevPreviewToolSession(PANEL) as FakeSession | null;
}

beforeEach(() => {
  sessions.length = 0;
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([
      [
        PLUGIN,
        {
          devMode: false,
          displayName: "Acme",
          // The registry admits a tool only when its plugin's manifest declares
          // the id, so the fake meta declares every tool these cases register.
          previewToolIds: new Set([TOOL, "acme.tools.other"]),
        },
      ],
    ]),
    disabledPluginIds: new Set(),
  });
  panels({ [PANEL]: "grid" });
  register(makeSession);
  startDevPreviewToolSessions();
});

afterEach(() => {
  __resetDevPreviewToolSessionsForTests();
  __resetDevPreviewToolsForTests();
  _resetPluginRuntimeStoreForTest();
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
});

describe("dev preview tool sessions", () => {
  it("builds the session when the tool is switched on, before any surface mounts", () => {
    switchOn();
    expect(sessions).toHaveLength(1);
    expect(live()).toBe(sessions[0]);
    expect(sessions[0]?.contexts[0]?.visible).toBe(false);
  });

  it("gives the session the preview's context, and the changes to it", () => {
    publishDevPreviewToolContext({
      panelId: PANEL,
      projectId: "p1",
      worktreeId: "wt-1",
      worktreePath: "/repo",
      url: "",
      isWebviewReady: false,
    });
    switchOn();
    expect(sessions[0]?.contexts[0]).toMatchObject({ worktreePath: "/repo", url: "" });

    publishDevPreviewToolContext({
      panelId: PANEL,
      projectId: "p1",
      worktreeId: "wt-1",
      worktreePath: "/repo",
      url: "http://localhost:5173/",
      isWebviewReady: true,
    });
    expect(sessions[0]?.contexts.at(-1)).toMatchObject({
      url: "http://localhost:5173/",
      isWebviewReady: true,
    });
  });

  it("keeps the one session across surfaces coming and going, and tracks whether any is mounted", () => {
    switchOn();
    const session = live();
    const releaseToolbar = retainDevPreviewToolVisibility(PANEL);
    const releaseDrawer = retainDevPreviewToolVisibility(PANEL);
    expect(session?.contexts.at(-1)?.visible).toBe(true);

    releaseToolbar();
    expect(session?.contexts.at(-1)?.visible).toBe(true);
    releaseDrawer();
    expect(session?.contexts.at(-1)?.visible).toBe(false);

    expect(live()).toBe(session);
    expect(session?.disposals).toBe(0);
  });

  it("disposes and aborts when the tool is switched off", () => {
    switchOn();
    const session = live();
    useDevPreviewToolStore.getState().setActive(PANEL, null);
    expect(session?.disposals).toBe(1);
    expect(session?.aborted).toBe(true);
    expect(live()).toBeNull();
  });

  it("switches the tool off and disposes when the preview is trashed", () => {
    switchOn();
    const session = live();
    panels({ [PANEL]: "trash" });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(session?.disposals).toBe(1);
    expect(session?.aborted).toBe(true);
  });

  it("switches the tool off and disposes when the preview is removed", () => {
    switchOn();
    const session = live();
    panels({ other: "grid" });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(session?.disposals).toBe(1);
  });

  it("switches the tool off and disposes when the last preview is removed", () => {
    switchOn();
    const session = live();
    // A cleared panel store is this view's panels being over — the one case
    // where a bound preview and an open workspace must not be left behind.
    usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(session?.disposals).toBe(1);
  });

  it("switches the tool off and disposes when the owning plugin is disabled", () => {
    switchOn();
    const session = live();
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set([PLUGIN]) });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(session?.disposals).toBe(1);
  });

  it("switches the tool off and disposes when its manifest stops declaring it", () => {
    switchOn();
    const session = live();
    expect(session).not.toBeNull();
    // The same plugin, still enabled, whose refreshed meta no longer names the tool.
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([
        [PLUGIN, { devMode: false, displayName: "Acme", previewToolIds: new Set<string>() }],
      ]),
    });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(session?.disposals).toBe(1);
  });

  it("does not build a session while the owning plugin is disabled", () => {
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set([PLUGIN]) });
    switchOn();
    expect(live()).toBeNull();
    expect(sessions).toHaveLength(0);
  });

  it("switches the tool off when its session cannot be built", async () => {
    __resetDevPreviewToolsForTests();
    let signal: AbortSignal | undefined;
    register((next) => {
      signal = next.signal;
      return Promise.reject(new Error("the chunk failed to load"));
    });
    switchOn();
    await Promise.resolve();
    await Promise.resolve();
    // Better a toggle that springs back than a strip that never arrives.
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(signal?.aborted).toBe(true);
    expect(live()).toBeNull();
  });

  it("does not switch off a tool the failing factory had itself switched to", async () => {
    __resetDevPreviewToolsForTests();
    const OTHER = "acme.tools.other";
    registerDevPreviewTool({
      id: OTHER,
      pluginId: PLUGIN,
      label: "Other",
      Button: () => null,
      createSession: makeSession,
    });
    register(() => {
      useDevPreviewToolStore.getState().setActive(PANEL, OTHER);
      return Promise.reject(new Error("the chunk failed to load"));
    });
    switchOn();
    await Promise.resolve();
    await Promise.resolve();
    // The failure was the first tool's; the second is switched on and served.
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({ [PANEL]: OTHER });
    expect(live()).not.toBeNull();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.disposals).toBe(0);
  });

  it("clears a tool switched on for a preview that is already gone or trashed", () => {
    panels({});
    switchOn();
    expect(live()).toBeNull();
    expect(sessions).toHaveLength(0);
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});

    panels({ [PANEL]: "trash" });
    switchOn();
    expect(live()).toBeNull();
    expect(sessions).toHaveLength(0);
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
  });

  it("clears a tool switched on while its plugin is disabled", () => {
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set([PLUGIN]) });
    switchOn();
    expect(live()).toBeNull();
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    // Re-enabling does not resurrect a selection that was never honoured.
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set() });
    expect(live()).toBeNull();
  });

  it("disposes a session whose factory switched its own tool off before returning", () => {
    __resetDevPreviewToolsForTests();
    register((next) => {
      useDevPreviewToolStore.getState().setActive(PANEL, null);
      return makeSession(next);
    });
    switchOn();
    expect(live()).toBeNull();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.disposals).toBe(1);
  });

  it("disposes a session that resolves after its preview let go", async () => {
    let resolve: ((session: FakeSession) => void) | undefined;
    let context: DevPreviewToolSessionContext | undefined;
    __resetDevPreviewToolsForTests();
    register((next) => {
      context = next;
      return new Promise<FakeSession>((r) => {
        resolve = r;
      });
    });
    switchOn();
    expect(live()).toBeNull();

    useDevPreviewToolStore.getState().setActive(PANEL, null);
    const late = makeSession(context!);
    resolve?.(late);
    await Promise.resolve();
    expect(late.disposals).toBe(1);
    expect(live()).toBeNull();
  });

  it("adopts a session that resolves while its preview still holds it", async () => {
    let resolve: ((session: FakeSession) => void) | undefined;
    let context: DevPreviewToolSessionContext | undefined;
    __resetDevPreviewToolsForTests();
    register((next) => {
      context = next;
      return new Promise<FakeSession>((r) => {
        resolve = r;
      });
    });
    switchOn();
    const created = makeSession(context!);
    resolve?.(created);
    await Promise.resolve();
    expect(live()).toBe(created);
    expect(created.disposals).toBe(0);
  });
});
