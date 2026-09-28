import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

/**
 * Bridge answers for the labels/badges harness. Imported FIRST by the preview so the
 * shim is on `window` before any store module evaluates.
 *
 * Most surfaces render from props or seeded stores; the handful that read over IPC on
 * mount would otherwise render their empty or error branch. Those namespaces answer
 * from `bridgeAnswers`, which the preview fills before it mounts anything. Every other
 * method on an overridden namespace stays inert, exactly like the base shim.
 */
export const bridgeAnswers: Record<string, unknown> = {};

function inert(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function withFallback(methods: Record<string, (...args: never[]) => unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

const answer = (key: string) => Promise.resolve(bridgeAnswers[key]);

const isHarness = !Reflect.get(window, "electron");

installPreviewShims({
  plugin: withFallback({
    list: () => answer("plugin.list"),
    getSettingValues: () =>
      Promise.resolve({
        values: bridgeAnswers["plugin.settingValues"] ?? {},
        secretsSet: [],
        secretTier: "keychain",
        secretsPlaintext: [],
      }),
    getDiagnosticsSnapshot: () => Promise.resolve({ plugins: [] }),
    getRuntimeStatuses: () => Promise.resolve([]),
  }),
  pluginMcp: withFallback({ list: () => Promise.resolve([]) }),
  terminal: withFallback({ getInfo: () => answer("terminal.getInfo") }),
  mcpServer: withFallback({
    getPaneNotifyState: (id: string) => {
      const table = bridgeAnswers["mcpServer.paneNotify"];
      return Promise.resolve(table instanceof Map ? table.get(id) : undefined);
    },
  }),
  onboarding: withFallback({ get: () => answer("onboarding.get") }),
  logs: withFallback({
    getRegistry: () => Promise.resolve([]),
    getLevelOverrides: () => answer("logs.levelOverrides"),
    setLevelOverrides: () => Promise.resolve({ success: true }),
  }),
  devPreview: withFallback({ getDiagnostics: () => answer("devPreview.getDiagnostics") }),
});

// A harness page must never inherit persisted state from an earlier page load.
if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
