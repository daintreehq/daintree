import { test, expect, type Page } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";
import { T_LONG } from "../../helpers/timeouts";

/** Toggle a loaded plugin's enabled state; re-enabling re-registers its contributions. */
async function setPluginEnabled(page: Page, pluginId: string, enabled: boolean): Promise<void> {
  await page.evaluate(
    async (payload) =>
      (
        window as unknown as {
          electron: { plugin: { setEnabled: (id: string, on: boolean) => Promise<unknown> } };
        }
      ).electron.plugin.setEnabled(payload.pluginId, payload.enabled),
    { pluginId, enabled }
  );
}

/** Dispatch a renderer action through the E2E-only bridge. */
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

/**
 * Plugin `panels` contribution (#10473). The capability-rich `rich-daintree`
 * sample declares one non-PTY panel (`id: "rich-panel"`). `PluginService`
 * namespaces the kind id as `${pluginId}.${panelId}`, so the contributed kind
 * surfaces as `daintree.rich.rich-panel`. This proves a declared panel
 * contribution actually registers a spawnable panel kind against the
 * main-process registry — the runtime source of truth the panel palette reads
 * from.
 *
 * The contribution rides on `rich-daintree` rather than the minimal
 * `hello-daintree` so the reference plugin's empty-manifest assertions (its
 * "Other" category and "No special permissions" cases) stay intact.
 */
test.describe.serial("Core: Plugin panels contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-panels");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed panel kind in the main-process registry", async () => {
    const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
    const richPanel = kinds.find((kind) => kind.id === "daintree.rich.rich-panel");

    expect(richPanel).toBeDefined();
    expect(richPanel).toMatchObject({
      id: "daintree.rich.rich-panel",
      name: "Rich Panel",
      extensionId: "daintree.rich",
      hasPty: false,
      showInPalette: true,
    });
  });

  // Regression for #10512: registration alone (above) is NOT enough — the bug
  // was that a registered plugin panel never reached a mounted GridPanel because
  // the grid membership selectors dropped non-built-in kinds. This opens the
  // panel and asserts its React component actually MOUNTS over `plugin://`,
  // which is the coverage gap that let the bug ship.
  //
  // This view imports nothing, which is deliberate: it isolates a `plugin://`
  // protocol failure from a React-contract failure (covered below). Read the two
  // together — this one passing while the hook view fails means the loader is
  // fine and the React contract broke. (The suite is `serial`, so a failure here
  // skips the rest rather than reporting them red.)
  test("mounts the contributed view's React component in the grid", async () => {
    await dispatchAction(ctx.window, "panel.openPluginPanel", {
      kind: "daintree.rich.rich-panel",
    });

    // The view lazy-imports over `plugin://`; allow generous time for the cold
    // protocol load.
    await expect(ctx.window.getByText("Rich panel view mounted")).toBeVisible({
      timeout: T_LONG,
    });
  });

  // Regression for #11208: every packaged build since v0.15.0 mapped all five
  // React specifiers to the `vendor-react` code-split chunk, whose exports are
  // Rolldown's private cross-chunk interface — so a plugin doing `import
  // { useState } from "react"` died at load with "does not provide an export
  // named 'useState'". Nothing caught it because the only plugin:// view in the
  // repo imported no React, and dev mode used a different (working) mechanism.
  //
  // The build-time guard (hostReactFacadePlugin in vite.config.ts) proves the
  // facade CHUNKS carry the right export names. This proves the half the build
  // can't see: that the shipped index.html's import map actually RESOLVES those
  // specifiers at runtime, under the real app:// protocol and CSP.
  //
  // Ordered before the hook-panel test on purpose — the suite is `serial`, so on
  // a #11208-style regression this reports exactly which specifiers lost which
  // exports instead of just "the panel never mounted".
  test("resolves every mapped specifier to its public export surface", async () => {
    // Passed as a string rather than a callback so the probe reaches the page
    // verbatim. A callback's `await import(...)` has to survive Playwright's TS
    // transform intact, which is a version-dependent detail this test has no
    // reason to depend on; a string can't be rewritten.
    const probe = `(async () => {
      const CONTRACT = {
        "react": ["useState", "useEffect", "useMemo", "useCallback", "useRef",
                  "useContext", "useReducer", "createElement", "forwardRef",
                  "memo", "createContext", "lazy"],
        "react/jsx-runtime": ["jsx", "jsxs"],
        "react/jsx-dev-runtime": [],
        "react-dom": ["createPortal", "flushSync"],
        "react-dom/client": ["createRoot", "hydrateRoot"]
      };
      const rows = [];
      const fragments = new Map();
      for (const specifier of Object.keys(CONTRACT)) {
        const row = { specifier, error: null, missing: [], notFunctions: [],
                      fragmentType: "absent", hasOwnJsxDEV: false, versionType: "absent" };
        try {
          const ns = await import(specifier);
          for (const name of CONTRACT[specifier]) {
            if (!Object.hasOwn(ns, name)) row.missing.push(name);
            else if (typeof ns[name] !== "function") {
              row.notFunctions.push(name + ":" + typeof ns[name]);
            }
          }
          if (Object.hasOwn(ns, "Fragment")) {
            row.fragmentType = typeof ns.Fragment;
            fragments.set(specifier, ns.Fragment);
          }
          if (Object.hasOwn(ns, "version")) row.versionType = typeof ns.version;
          row.hasOwnJsxDEV = Object.hasOwn(ns, "jsxDEV");
        } catch (err) {
          row.error = String((err && err.message) || err);
        }
        rows.push(row);
      }
      // Identity, not just presence: every specifier that exposes Fragment must
      // expose the SAME symbol. Distinct symbols mean the facades resolved to
      // different React copies, which is the "Invalid hook call" failure.
      const fragmentValues = [...fragments.values()];
      const distinctFragments = new Set(fragmentValues).size;
      return { rows, fragmentOwners: [...fragments.keys()], distinctFragments };
    })()`;

    const { rows, fragmentOwners, distinctFragments } = await ctx.window.evaluate<{
      rows: Array<{
        specifier: string;
        error: string | null;
        missing: string[];
        notFunctions: string[];
        fragmentType: string;
        hasOwnJsxDEV: boolean;
        versionType: string;
      }>;
      fragmentOwners: string[];
      distinctFragments: number;
    }>(probe);

    // Assert on the whole shape at once so a failure names every broken
    // specifier, not just the first.
    expect(
      rows.map((r) => ({
        specifier: r.specifier,
        error: r.error,
        missing: r.missing,
        notFunctions: r.notFunctions,
      }))
    ).toEqual([
      { specifier: "react", error: null, missing: [], notFunctions: [] },
      { specifier: "react/jsx-runtime", error: null, missing: [], notFunctions: [] },
      { specifier: "react/jsx-dev-runtime", error: null, missing: [], notFunctions: [] },
      { specifier: "react-dom", error: null, missing: [], notFunctions: [] },
      { specifier: "react-dom/client", error: null, missing: [], notFunctions: [] },
    ]);

    // Fragment rides on the three specifiers that document it, is a real symbol
    // (not an own-but-undefined binding), and agrees across all three.
    //
    // NOT a single-instance proof, despite the temptation to read it as one:
    // React builds Fragment with `Symbol.for("react.fragment")`, a REGISTERED
    // symbol, so two duplicated React copies in one realm still hand back the
    // identical symbol. This only proves the facades expose a live, canonical
    // marker rather than a hollow binding. Single-instance is proven by the
    // hook-panel test below (a second copy throws "Invalid hook call") and, at
    // build time, by the guard asserting all five facades import the one shared
    // vendor-react chunk.
    expect(fragmentOwners).toEqual(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
    expect(rows.filter((r) => r.fragmentType === "symbol").map((r) => r.specifier)).toEqual(
      fragmentOwners
    );
    expect(distinctFragments).toBe(1);

    // `version` is a string wherever React documents it — catches a facade whose
    // names resolve but whose bindings are hollow.
    expect(rows.filter((r) => r.versionType === "string").map((r) => r.specifier)).toEqual([
      "react",
      "react-dom",
      "react-dom/client",
    ]);

    // React's PRODUCTION jsx-dev-runtime exports `jsxDEV` as `undefined` — the
    // name is there, the value isn't. `hasOwn` is the only honest check: reading
    // `ns.jsxDEV` yields `undefined` whether the export exists or not, so a
    // truthiness/`toBeUndefined` assertion would pass on a map that serves
    // nothing at all — exactly the #11208 bug. The value itself is deliberately
    // not asserted: it's React's to define, and differs between dev and prod.
    const jsxDev = rows.find((r) => r.specifier === "react/jsx-dev-runtime");
    expect(jsxDev?.hasOwnJsxDEV).toBe(true);
  });

  // `hook-panel-view` is built by the public @daintreehq/plugin-vite preset, so
  // this exercises the same externalize→import-map path a third-party plugin
  // takes — the probe above proves the specifiers resolve; this proves a real
  // component built the real way actually renders.
  //
  // Waiting on the post-effect "ready" is the whole assertion: reaching it
  // requires the named `react` imports to have resolved, JSX to have resolved
  // `react/jsx-runtime`, AND the hooks to dispatch through the HOST's React —
  // a duplicated React would throw "Invalid hook call" before ever getting here.
  test("mounts a hook-based view that imports React through the host import map", async () => {
    await dispatchAction(ctx.window, "panel.openPluginPanel", {
      kind: "daintree.rich.hook-panel",
    });

    await expect(ctx.window.getByText("Hook panel view ready")).toBeVisible({
      timeout: T_LONG,
    });
  });

  // Regression for #11636. `GridPanel` subscribed to the definition registry but
  // then called `getPanelKindDefinition(kind)` separately, so React Compiler —
  // which cannot see that the getter reads mutable module state — cached the
  // result keyed only on `kind`. The subscription still rerendered the panel,
  // but the cache kept serving the definition resolved on that fiber's FIRST
  // render, and `ContentGridDefault` keys the wrapper on a stable `group.id` so
  // the fiber never remounted. A panel restored before its plugin registered its
  // kind therefore sat on "Plugin unavailable" until closed and reopened.
  //
  // Only the compiled bundle can show this: vitest runs uncompiled TSX where the
  // getter re-runs every render, so a unit test passes with or without the bug.
  //
  // Disable/re-enable is the lever because panel contributions register on
  // plugin LOAD (PluginService.loadPlugin), not on activation — so toggling is
  // what actually removes and re-registers the definition. Both directions are
  // asserted on the SAME `data-panel-id`: the panel record is never recreated,
  // which is what preserves its `extensionState`. Kept last in this serial suite
  // because it briefly disables the plugin the earlier tests depend on.
  test("hot-swaps a live panel when its plugin kind is unregistered and registered again", async () => {
    // Default `reuseExisting` returns the panel opened by the earlier test
    // rather than spawning a second one.
    const opened = (await dispatchAction(ctx.window, "panel.openPluginPanel", {
      kind: "daintree.rich.rich-panel",
    })) as { panelId: string };

    const panel = ctx.window.locator(`[data-panel-id="${opened.panelId}"]`);
    const unavailable = panel.getByRole("region", { name: "Plugin unavailable" });

    await expect(panel.getByText("Rich panel view mounted")).toBeVisible({ timeout: T_LONG });

    // Unregistering must reach the mounted panel. Pre-fix the stale cache kept
    // the real view rendered here and this assertion failed.
    await setPluginEnabled(ctx.window, "daintree.rich", false);
    await expect(unavailable).toBeVisible({ timeout: T_LONG });

    // The #11636 direction: the kind returns while the panel is already mounted
    // and showing the placeholder, and the same panel resolves to the real view.
    await setPluginEnabled(ctx.window, "daintree.rich", true);
    await waitForRichPluginReady(ctx.app, ctx.window);

    await expect(panel.getByText("Rich panel view mounted")).toBeVisible({ timeout: T_LONG });
    await expect(unavailable).toHaveCount(0);
  });
});
