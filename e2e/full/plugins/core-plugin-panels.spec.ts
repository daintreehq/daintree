import { test, expect, type Page } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";
import { T_LONG } from "../../helpers/timeouts";

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
  // protocol failure from a React-contract failure (covered below). If both
  // tests go red the loader broke; if only the hook test does, the import map
  // did.
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
  // `hook-panel-view` is built by the public @daintreehq/plugin-vite preset, so
  // this exercises the same externalize→import-map path a third-party plugin
  // takes. Waiting on the post-effect "ready" is the whole assertion: reaching
  // it requires the named `react` imports to have resolved, JSX to have resolved
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

  // The build-time guard (hostReactFacadePlugin in vite.config.ts) proves the
  // facade CHUNKS carry the right export names. This proves the other half the
  // build can't see: that the import map in the shipped index.html actually
  // RESOLVES those specifiers at runtime, under the real app:// protocol and CSP.
  test("resolves every mapped specifier to its public export surface", async () => {
    // Passed as a string on purpose: Playwright transpiles this TS spec, which
    // rewrites `await import(...)` inside a callback into a `require()` the
    // renderer can't run. A string literal reaches the page verbatim.
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
      for (const specifier of Object.keys(CONTRACT)) {
        const row = { specifier, error: null, missing: [], notFunctions: [],
                      hasFragment: false, hasOwnJsxDEV: false };
        try {
          const ns = await import(specifier);
          for (const name of CONTRACT[specifier]) {
            if (!Object.hasOwn(ns, name)) row.missing.push(name);
            else if (typeof ns[name] !== "function") {
              row.notFunctions.push(name + ":" + typeof ns[name]);
            }
          }
          row.hasFragment = Object.hasOwn(ns, "Fragment");
          row.hasOwnJsxDEV = Object.hasOwn(ns, "jsxDEV");
        } catch (err) {
          row.error = String((err && err.message) || err);
        }
        rows.push(row);
      }
      return rows;
    })()`;

    const rows = await ctx.window.evaluate<
      Array<{
        specifier: string;
        error: string | null;
        missing: string[];
        notFunctions: string[];
        hasFragment: boolean;
        hasOwnJsxDEV: boolean;
      }>
    >(probe);

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

    // Fragment rides on the three specifiers that document it.
    const fragmentOwners = rows.filter((r) => r.hasFragment).map((r) => r.specifier);
    expect(fragmentOwners).toEqual(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);

    // React's PRODUCTION jsx-dev-runtime exports `jsxDEV` as `undefined` — the
    // name is there, the value isn't. `hasOwn` is the only honest check: reading
    // `ns.jsxDEV` yields `undefined` whether the export exists or not, so a
    // truthiness/`toBeUndefined` assertion would pass on a map that serves
    // nothing at all — exactly the #11208 bug.
    const jsxDev = rows.find((r) => r.specifier === "react/jsx-dev-runtime");
    expect(jsxDev?.hasOwnJsxDEV).toBe(true);
  });
});
