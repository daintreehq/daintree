import { test, expect, type Page } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";

const PLUGIN_ID = "daintree.rich";

/** Dispatch a renderer action through the E2E-only bridge and return its result. */
async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    async (payload) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            a?: unknown,
            opts?: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("__daintreeDispatchAction is not available");
      }
      return dispatch(payload.actionId, payload.args, { source: "menu" });
    },
    { actionId, args }
  );
}

/** Read the rich plugin's stored user-scope setting values over IPC. */
async function userSettingValues(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.values;
  }, PLUGIN_ID);
}

/**
 * Private `host.storage` API (#10556). The rich sample plugin registers a
 * `storage-roundtrip` action that writes / reads / deletes across the three
 * storage scopes (`user`, `project`, `worktree`) and returns what it observed.
 * This drives that action through the real plugin host and asserts the
 * round-trip, the `delete` semantics, and — the central guarantee of the issue —
 * that storage is a store distinct from settings: a storage key that collides
 * with a declared setting id never surfaces in the settings UI.
 */
test.describe.serial("Core: Plugin private storage", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-storage");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("round-trips values across scopes and honours delete", async () => {
    const result = (await dispatchAction(ctx.window, `${PLUGIN_ID}.storage-roundtrip`)) as {
      ok: boolean;
      result: Record<string, unknown>;
    };

    expect(result.ok).toBe(true);
    const report = result.result;

    // user + project scopes always have a target in the onboarded-project layout.
    expect(report.user).toEqual({ n: 1 });
    expect(report.project).toEqual({ n: 2 });

    // The onboarded project root is itself the active worktree, so worktree scope
    // resolves; if a layout ever lacks an active worktree the host throws a clear
    // "no active worktree" error rather than writing to the wrong place.
    if (report.worktreeError === undefined) {
      expect(report.worktree).toEqual({ n: 3 });
    } else {
      expect(String(report.worktreeError)).toMatch(/no active worktree/i);
    }

    // delete removes the key (storage has a real delete; settings does not).
    expect(report.userAfterDelete).toBeUndefined();
  });

  test("storage is a separate store from settings — no key collision leaks", async () => {
    const result = (await dispatchAction(ctx.window, `${PLUGIN_ID}.storage-roundtrip`)) as {
      ok: boolean;
      result: Record<string, unknown>;
    };
    expect(result.ok).toBe(true);

    // The storage write under the "greeting" key (which is also a declared
    // setting id) lands in the storage store and reads back from it...
    expect(result.result.storageGreeting).toBe("STORAGE-ONLY");

    // ...but never appears in the settings store the UI reads from.
    const settings = await userSettingValues(ctx.window);
    expect(settings.greeting).not.toBe("STORAGE-ONLY");
  });
});
