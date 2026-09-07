import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { daintreePlugin } from "../../../packages/plugin-vite/src/index";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { createFixtureRepo } from "../../helpers/fixtures";
import type { ActionDispatchResult } from "../../../shared/types/actions";

async function dispatch(
  page: Page,
  id: string,
  args: unknown
): Promise<ActionDispatchResult<unknown>> {
  return page.evaluate(
    async ({ id, args }) => {
      const bridge = window as unknown as {
        __daintreeDispatchAction: (
          id: string,
          args: unknown,
          options: { source: string }
        ) => Promise<ActionDispatchResult<unknown>>;
      };
      return bridge.__daintreeDispatchAction(id, args, { source: "menu" });
    },
    { id, args }
  );
}

async function writePlugin(
  project: string,
  name: string,
  marker: string,
  shared: boolean,
  packageMarker = "PACKAGE-1"
) {
  const root = path.join(project, ".daintree/plugins", name);
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", private: true })
  );
  await writeFile(
    path.join(root, "plugin.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      scope: "project",
      displayName: name,
      main: "dist/index.js",
      engines: { daintree: ">=0.11.0" },
      capabilities: [],
      contributes: {
        panels: [{ id: "main", name, iconId: "puzzle", color: "var(--theme-category-orange)" }],
        views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
      },
    })
  );
  await writeFile(
    path.join(root, "dist/index.js"),
    "export async function activate() { return () => {}; }"
  );
  if (!shared) {
    await writeFile(
      path.join(root, "dist/panel.js"),
      `
      import { createElement as h } from "react";
      class Editor extends HTMLElement { static build = ${JSON.stringify(marker)}; }
      setTimeout(() => customElements.define("dt-raw-editor", Editor), 0);
      export default function Panel() { return h("div", { "data-testid": "raw-build" }, ${JSON.stringify(marker)}); }
    `
    );
    return;
  }
  await writeFile(
    path.join(root, "adapter.js"),
    `
    globalThis.__adapterEvaluations = (globalThis.__adapterEvaluations ?? 0) + 1;
    export class Editor extends HTMLElement { static build = ${JSON.stringify(packageMarker)}; }
    export const ready = new Promise(resolve => setTimeout(() => {
      customElements.define("dt-shared-editor", Editor);
      resolve();
    }, 0));
    export async function createEditor(text) {
      await ready;
      const element = new Editor();
      element.textContent = text;
      return element;
    }
  `
  );
  await writeFile(
    path.join(root, "panel.js"),
    `
    import { createElement as h, useEffect, useRef } from "react";
    import loadEditor from "virtual:daintree-document-package/@fixture/editor";
    const editor = loadEditor();
    export default function Panel() {
      const ref = useRef(null);
      useEffect(() => {
        let alive = true;
        editor.then(mod => mod.createEditor(${JSON.stringify(name)})).then(element => {
          if (alive) ref.current.replaceChildren(element);
        }).catch(error => { if (alive) ref.current.textContent = error.message; });
        return () => { alive = false; };
      }, []);
      return h("div", { "data-testid": ${JSON.stringify(name)} },
        h("span", null, ${JSON.stringify(marker)}), h("div", { ref }));
    }
  `
  );
  await build({
    configFile: false,
    root,
    logLevel: "error",
    plugins: [
      daintreePlugin({
        documentPackages: {
          "@fixture/editor": { entry: "adapter.js", version: "1.0.0", scope: "document" },
        },
      }),
    ],
    build: {
      emptyOutDir: false,
      minify: false,
      lib: { entry: path.join(root, "panel.js"), formats: ["es"], fileName: () => "panel.js" },
    },
  });
}

async function openPlugin(page: Page, name: string) {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.electron.plugin.getPanelKinds())).some((kind) =>
          kind.extensionId?.endsWith(name)
        ),
      { timeout: 60_000 }
    )
    .toBe(true);
  const kinds = await page.evaluate(() => window.electron.plugin.getPanelKinds());
  const kind = kinds.find((kind) => kind.extensionId?.endsWith(name));
  expect(kind).toBeDefined();
  expect((await dispatch(page, "panel.openPluginPanel", { kind: kind!.id })).ok).toBe(true);
}

test("attributes native conflicts, shares a package across plugins and reloads, and recovers by replacing the document", async () => {
  test.setTimeout(300_000);
  const fixture = createFixtureRepo({ name: "document-packages" });
  let ctx: AppContext | undefined;
  try {
    await writePlugin(fixture.dir, "acme.raw", "BUILD-1", false);
    await writePlugin(fixture.dir, "acme.first", "BUILD-1", true);
    await writePlugin(fixture.dir, "acme.second", "BUILD-1", true);
    ctx = await launchApp({});
    const page = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
    await openPlugin(page, "acme.raw");
    await openPlugin(page, "acme.first");
    await openPlugin(page, "acme.second");
    await expect(page.getByTestId("raw-build")).toHaveText("BUILD-1");
    await expect(page.getByTestId("acme.first").locator("dt-shared-editor")).toHaveText(
      "acme.first"
    );
    await expect(page.getByTestId("acme.second").locator("dt-shared-editor")).toHaveText(
      "acme.second"
    );
    expect(pageErrors).toEqual([]);
    await page.evaluate(() => {
      const state = window as unknown as { originalEditor: CustomElementConstructor | undefined };
      state.originalEditor = customElements.get("dt-shared-editor");
    });

    await writePlugin(fixture.dir, "acme.raw", "BUILD-2", false);
    await writePlugin(fixture.dir, "acme.first", "BUILD-2", true);
    expect((await dispatch(page, "plugin.reloadProject", {})).ok).toBe(true);
    await expect(page.getByTestId("raw-build")).toHaveText("BUILD-2", { timeout: 60_000 });
    await expect(page.getByTestId("acme.first").locator("span")).toHaveText("BUILD-2", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("acme.first").locator("dt-shared-editor")).toHaveText(
      "acme.first"
    );
    await expect
      .poll(() => pageErrors.some((error) => error.includes('"dt-raw-editor"')))
      .toBe(true);
    expect(pageErrors.filter((error) => !error.includes('"dt-raw-editor"'))).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          customElements.get("dt-shared-editor") ===
          (window as unknown as { originalEditor: CustomElementConstructor }).originalEditor
      )
    ).toBe(true);
    await expect(page.getByText("Plugins need a window reload")).toHaveCount(1);
    await expect(page.getByText("Plugins need a window reload")).toBeVisible();
    expect(
      await page.evaluate(
        () => (customElements.get("dt-raw-editor") as unknown as { build: string }).build
      )
    ).toBe("BUILD-1");

    // A different adapter build is refused before it can run its registration timer.
    await writePlugin(fixture.dir, "acme.second", "BUILD-3", true, "PACKAGE-2");
    expect((await dispatch(page, "plugin.reloadProject", {})).ok).toBe(true);
    await expect(page.getByTestId("acme.second")).toContainText("different version or build", {
      timeout: 60_000,
    });
    expect(
      await page.evaluate(
        () => (customElements.get("dt-shared-editor") as unknown as { build: string }).build
      )
    ).toBe("PACKAGE-1");

    // Refused before evaluation: the replacement adapter's module body never ran.
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { __adapterEvaluations: number }).__adapterEvaluations
      )
    ).toBe(1);
    // The refusal itself surfaces as an attributed rejection: the fixture retains
    // the loader promise at module scope, so it settles before the mount effect
    // attaches its catch. Anything else here is unexpected.
    expect(
      pageErrors.filter(
        (error) =>
          !error.includes('"dt-raw-editor"') && !error.includes("different version or build")
      )
    ).toEqual([]);

    // Align both consumers, then exercise the actual banner recovery action.
    await writePlugin(fixture.dir, "acme.first", "BUILD-3", true, "PACKAGE-2");
    expect((await dispatch(page, "plugin.reloadProject", {})).ok).toBe(true);
    await expect(page.getByTestId("acme.first")).toContainText("different version or build", {
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Reload window", exact: true }).first().click();
    // The banner action opens a confirm dialog; only its confirm button reloads.
    await expect(page.getByText("Reload this project window?")).toBeVisible();
    await page.getByRole("button", { name: "Reload window", exact: true }).last().click();
    await expect(page.getByTestId("acme.first").locator("dt-shared-editor")).toHaveText(
      "acme.first",
      { timeout: 60_000 }
    );
    await expect(page.getByText("Plugins need a window reload")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (customElements.get("dt-raw-editor") as unknown as { build: string }).build
      )
    ).toBe("BUILD-2");
    expect(
      await page.evaluate(
        () => (customElements.get("dt-shared-editor") as unknown as { build: string }).build
      )
    ).toBe("PACKAGE-2");
  } finally {
    if (ctx) await closeApp(ctx.app);
    fixture.cleanup();
  }
});
