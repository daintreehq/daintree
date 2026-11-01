import { test, expect, type Page } from "@playwright/test";
import type { FixtureRepo } from "../../helpers/fixtures";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { saveCurrentProjectSettings } from "../../helpers/projectSettings";
import {
  DEV_SERVER_TIMEOUT,
  capturePreviewConsole,
  dispatch,
  freePort,
  inspectorText,
  previewConsole,
  selectedElement,
} from "./previewDriver";

/**
 * The spec file's fixture project: installed once before its first block and
 * removed after its last, so every variant serves the same install.
 */
export function registerFixtureProject(create: () => FixtureRepo): () => string {
  let project: FixtureRepo | undefined;
  test.beforeAll(() => {
    project = create();
  });
  test.afterAll(() => project?.cleanup());
  return () => {
    if (!project) throw new Error("the fixture project was never created");
    return project.dir;
  };
}

export interface PickerSessionOptions {
  /** The fixture project's directory, read once the session launches. */
  projectDir: () => string;
  projectName: string;
  /** The dev preview's server command, on the port the session picked. */
  command: (port: number) => string;
  /** How long the page may take to come up; a cold Next or Angular compile is slow. */
  readyTimeout?: number;
}

/**
 * One fresh app around one fixture site and one server command, for the
 * describe block it's called in. A fresh launch is a fresh user-data dir, so
 * nothing a previous variant cached — a source map, a document epoch — can
 * answer for this one. `start` is meant to be the block's first test, so a
 * server that never comes up fails by name rather than inside a hook.
 */
export function registerPickerSession(options: PickerSessionOptions) {
  let ctx: AppContext | undefined;
  const rendererConsole: string[] = [];

  test.beforeAll(async () => {
    ctx = await launchApp();
    await capturePreviewConsole(ctx.app);
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      options.projectDir(),
      options.projectName
    );
    ctx.window.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        rendererConsole.push(`[${message.type()}] ${message.text()}`);
      }
    });
    ctx.window.on("pageerror", (error) => rendererConsole.push(`[pageerror] ${error.stack}`));
  });

  test.afterEach(async () => {
    const testInfo = test.info();
    if (testInfo.status === testInfo.expectedStatus || !ctx) return;
    const report = [
      `--- inspector ---\n${await inspectorText(ctx.window)}`,
      `--- renderer console ---\n${rendererConsole.join("\n")}`,
      `--- preview console ---\n${(await previewConsole(ctx.app)).join("\n")}`,
    ].join("\n");
    await testInfo.attach("diagnostics", { body: report });
    await ctx.window
      .screenshot({ path: testInfo.outputPath("failure.png") })
      .catch(() => undefined);
    console.log(report);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  function session(): AppContext {
    if (!ctx) throw new Error("the app for this picker session never launched");
    return ctx;
  }

  /** Start the site in a dev preview with the Element Picker on, ready for a click. */
  async function start(): Promise<void> {
    const { window } = session();
    const timeout = options.readyTimeout ?? DEV_SERVER_TIMEOUT;
    await saveCurrentProjectSettings(window, {
      devServerCommand: options.command(await freePort()),
    });
    const result = await dispatch(window, "devPreview.toggleElementPicker");
    expect(result.ok).toBe(true);
    const strip = window.getByRole("toolbar", { name: "Element Picker" });
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(window.locator("webview")).toBeAttached({ timeout });
    // The strip's live region says its sentence too, so the visible row's text
    // alone matches twice; the announced status is the one state to wait on.
    await expect(
      strip.getByRole("status").filter({ hasText: "Click an element to ask an agent about it" })
    ).toBeVisible({ timeout });
  }

  return { session, start };
}

/**
 * The picker said it couldn't place the selected element and named no file in
 * its place. A pick the page traced shows its identity block only once the host
 * has answered, but one the page reported nothing about is shown untraced at
 * once — including a pick that landed before the framework's extractor was
 * installed — so where the framework names components, prove it reported
 * first with `expectComponentsNamed`.
 */
export async function expectNotTraced(page: Page, sourceFile: string): Promise<void> {
  const identity = selectedElement(page);
  await expect(identity.getByText("Not traced to source")).toBeVisible();
  await expect(identity.getByRole("button", { name: "Copy path" })).toHaveCount(0);
  await expect(identity.getByRole("button", { name: "Open in editor" })).toHaveCount(0);
  await expect(identity).not.toContainText(sourceFile);
}

/**
 * The page's framework reported on the selection: the trail names the
 * components around it. The extractor installing re-sends the selection, so
 * this waits for that answer rather than taking the first one.
 */
export async function expectComponentsNamed(page: Page, name?: string): Promise<void> {
  const trail = selectedElement(page).getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail).toBeVisible({ timeout: 30_000 });
  if (name) await expect(trail).toContainText(name);
}

/** The strip's state once a component, not an element, is the selection. */
export async function expectComponentSelected(page: Page, name: string): Promise<void> {
  const strip = page.getByRole("toolbar", { name: "Element Picker" });
  await expect(strip).toContainText(name, { timeout: 30_000 });
  // By role: the trail also draws an aria-hidden copy of itself to measure
  // its fold, badge included.
  await expect(strip.getByRole("listitem").getByText("Component", { exact: true })).toBeVisible();
}
