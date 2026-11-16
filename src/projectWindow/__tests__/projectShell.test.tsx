/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

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
    render: vi.fn(),
    reportBootstrapFailure: vi.fn(),
    preloadRestoredPanesFromBoot: vi.fn(),
    bootPayload: { restoredPaneKinds: ["terminal"] },
    initStoreOrchestrator: vi.fn(),
  };
});

vi.mock("@/lib/bootPromise", () => ({
  getSafeBootPromise: () => {
    mocks.calls.push("app:boot");
    return Promise.resolve(mocks.bootPayload);
  },
}));
vi.mock("@/panels/registry", () => ({
  initBuiltInPanelKinds: mocks.record("initBuiltInPanelKinds"),
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
vi.mock("@/App", () => {
  mocks.calls.push("App evaluated");
  return { default: function App() {} };
});

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

describe("project shell", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.calls.length = 0;
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

    // `App evaluated` marks the first await: everything before it ran in the
    // shell's own synchronous evaluation, where `app:boot` goes out too.
    expect(mocks.calls).toEqual([...SYNCHRONOUS_BOOTSTRAP, "App evaluated", "createRoot"]);
    expect(mocks.preloadRestoredPanesFromBoot).toHaveBeenCalledWith(mocks.bootPayload);
    expect(mocks.reportBootstrapFailure).not.toHaveBeenCalled();
  });

  it("wraps App in the worktree store provider under StrictMode", async () => {
    await evaluateShell();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    const strictMode = mocks.render.mock.calls[0]![0] as ReactElement<{ children: ReactElement }>;
    const provider = strictMode.props.children as ReactElement<{ children: ReactElement }>;
    expect((provider.type as { name: string }).name).toBe("WorktreeStoreProvider");
    expect((provider.props.children.type as { name: string }).name).toBe("App");
  });

  it("reports a failed App import as a bootstrap failure instead of mounting", async () => {
    vi.doMock("@/App", () => {
      throw new Error("App chunk failed");
    });

    try {
      await evaluateShell();
      await vi.waitFor(() => expect(mocks.reportBootstrapFailure).toHaveBeenCalledTimes(1));
    } finally {
      vi.doMock("@/App", () => ({ default: function App() {} }));
    }

    expect(mocks.render).not.toHaveBeenCalled();
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
