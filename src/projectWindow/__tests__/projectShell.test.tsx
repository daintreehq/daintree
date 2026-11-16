/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { StrictMode, isValidElement, type ReactNode } from "react";
import { PROJECT_SHELL_SOURCE } from "@shared/config/projectShell";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const record =
    <T,>(name: string, value?: T) =>
    () => {
      calls.push(name);
      return value;
    };
  return {
    calls,
    record,
    /** `calls` as the first microtask after `initBuiltInPanelKinds` saw it. */
    callsAtFirstMicrotask: null as string[] | null,
    render: vi.fn<(node: ReactNode) => void>(),
    reportBootstrapFailure: vi.fn<(error: unknown) => void>(),
    preloadRestoredPanesFromBoot: vi.fn(),
    bootPayload: { restoredPaneKinds: ["terminal"] },
    initStoreOrchestrator: vi.fn<() => () => void>(),
  };
});

vi.mock("@/lib/bootPromise", () => ({
  getSafeBootPromise: () => {
    mocks.calls.push("app:boot");
    return Promise.resolve(mocks.bootPayload);
  },
}));
vi.mock("@/panels/registry", () => ({
  initBuiltInPanelKinds: () => {
    mocks.calls.push("initBuiltInPanelKinds");
    // Runs once the synchronous run that called this has ended, before any
    // continuation queued after it: anything the shell awaited before a call
    // below would push that call past this snapshot.
    queueMicrotask(() => {
      mocks.callsAtFirstMicrotask = [...mocks.calls];
    });
  },
  preloadRestoredPanesFromBoot: mocks.preloadRestoredPanesFromBoot,
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => {
    mocks.calls.push("createRoot");
    return { render: mocks.render };
  },
}));
vi.mock("@/config/terminalFont", () => ({}));
vi.mock("@/store/rendererStoreOrchestrator", () => ({
  initStoreOrchestrator: mocks.initStoreOrchestrator,
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: {
    getState: () => ({ initialize: mocks.record("agentSettings.initialize", Promise.resolve()) }),
  },
}));
vi.mock("@/utils/reportBootstrapFailure", () => ({
  reportBootstrapFailure: mocks.reportBootstrapFailure,
}));
vi.mock("@/utils/reactRootErrorCallbacks", () => ({
  onCaughtError: vi.fn(),
  onUncaughtError: vi.fn(),
  onRecoverableError: vi.fn(),
}));
vi.mock("@/contexts/WorktreeStoreContext", () => ({
  WorktreeStoreProvider: function WorktreeStoreProvider({ children }: { children: ReactNode }) {
    return children;
  },
}));
vi.mock("@/services/projectSwitchStatusTiming", () => ({
  installProjectSwitchStatusTiming: mocks.record("installProjectSwitchStatusTiming"),
}));
vi.mock("@/services/plugin/runningPluginActions", () => ({
  installRunningPluginActions: mocks.record("installRunningPluginActions"),
}));
vi.mock("@/store/pluginContextKeyStore", () => ({
  usePluginContextKeyStore: { getState: () => ({ init: mocks.record("pluginContextKeys.init") }) },
}));
vi.mock("@/store/pluginProjectSurfacesStore", () => ({
  usePluginProjectSurfacesStore: {
    getState: () => ({ init: mocks.record("pluginProjectSurfaces.init") }),
  },
}));
vi.mock("@/store/pluginHostedViewsStore", () => ({
  usePluginHostedViewsStore: { getState: () => ({ init: mocks.record("pluginHostedViews.init") }) },
}));
vi.mock("@/services/plugin/appPluginKitHost", () => ({
  installAppPluginKitHost: mocks.record("installAppPluginKitHost", () => {}),
}));
vi.mock("@/lib/remoteHosts", () => ({ isRemoteShellSupported: () => false }));
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  answerBufferSamplesUntilLoaded: mocks.record("answerBufferSamplesUntilLoaded"),
}));
function mockApp(): void {
  vi.doMock("@/App", () => {
    mocks.calls.push("App evaluated");
    return { default: function App() {} };
  });
}

/** Everything the shell must have done, in this order, before it imports App. */
const SYNCHRONOUS_BOOTSTRAP = [
  "app:boot",
  "initBuiltInPanelKinds",
  "initStoreOrchestrator",
  "answerBufferSamplesUntilLoaded",
  "installProjectSwitchStatusTiming",
  "installRunningPluginActions",
  "pluginContextKeys.init",
  "pluginProjectSurfaces.init",
  "pluginHostedViews.init",
  "installAppPluginKitHost",
  "agentSettings.initialize",
  "app:boot",
];

async function evaluateShell(): Promise<void> {
  await import("../projectShell");
}

function childOf(node: ReactNode): ReactNode {
  if (!isValidElement<{ children?: ReactNode }>(node)) throw new Error("not a React element");
  return node.props.children;
}

function typeOf(node: ReactNode): unknown {
  if (!isValidElement(node)) return undefined;
  return typeof node.type === "function" ? node.type.name : node.type;
}

describe("project shell", () => {
  beforeEach(() => {
    vi.resetModules();
    // Registered per test: a factory's module stays cached across
    // resetModules, so a test that ran first would otherwise decide whether
    // the next one sees App evaluate.
    mockApp();
    mocks.calls.length = 0;
    mocks.callsAtFirstMicrotask = null;
    mocks.render.mockReset();
    mocks.reportBootstrapFailure.mockReset();
    mocks.preloadRestoredPanesFromBoot.mockReset();
    mocks.initStoreOrchestrator.mockReset().mockImplementation(() => {
      mocks.calls.push("initStoreOrchestrator");
      return () => {};
    });
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("sends app:boot and installs every project listener synchronously as it evaluates, then mounts App", async () => {
    await evaluateShell();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    // Everything from the panel kinds to the agent settings ran in one
    // synchronous run, with no await in between: an await anywhere before the
    // App import would leave a call out of the first-microtask snapshot.
    expect(mocks.callsAtFirstMicrotask).toEqual(SYNCHRONOUS_BOOTSTRAP);
    expect(mocks.calls).toEqual([...SYNCHRONOUS_BOOTSTRAP, "App evaluated", "createRoot"]);
    expect(mocks.preloadRestoredPanesFromBoot).toHaveBeenCalledWith(mocks.bootPayload);
    expect(mocks.reportBootstrapFailure).not.toHaveBeenCalled();
  });

  it("wraps App in the worktree store provider under StrictMode", async () => {
    await evaluateShell();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    const root = mocks.render.mock.calls[0]![0];
    expect(typeOf(root)).toBe(StrictMode);
    const provider = childOf(root);
    expect(typeOf(provider)).toBe("WorktreeStoreProvider");
    expect(typeOf(childOf(provider))).toBe("App");
  });

  it("reports a failed App import as a bootstrap failure instead of mounting", async () => {
    vi.doMock("@/App", () => {
      throw new Error("App chunk failed");
    });

    await evaluateShell();
    await vi.waitFor(() => expect(mocks.reportBootstrapFailure).toHaveBeenCalledTimes(1));

    // Vitest wraps a throwing mock factory, keeping the module's own error as the cause.
    expect(mocks.reportBootstrapFailure.mock.calls[0]![0]).toHaveProperty(
      "cause.message",
      "App chunk failed"
    );
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("awaits nothing in startProjectWindow before the App import", () => {
    // The first-microtask snapshot can't see a yield ahead of its own anchor
    // (`initBuiltInPanelKinds`), so the source must not have one: the App
    // import is the bootstrap's only await.
    const file = join(process.cwd(), PROJECT_SHELL_SOURCE);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const start = source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "startProjectWindow"
    );
    const awaited: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
        awaited.push(node.getText(source));
        return;
      }
      if (ts.isFunctionLike(node) && node !== start) return;
      ts.forEachChild(node, visit);
    };
    expect(start).toBeDefined();
    visit(start!);
    expect(awaited).toEqual(['await import("@/App")']);
  });

  it("reports a throw during the synchronous bootstrap instead of leaving it uncaught", async () => {
    const failure = new Error("orchestrator failed");
    mocks.initStoreOrchestrator.mockImplementation(() => {
      throw failure;
    });

    await evaluateShell();
    await vi.waitFor(() => expect(mocks.reportBootstrapFailure).toHaveBeenCalledWith(failure));

    expect(mocks.calls).not.toContain("App evaluated");
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
