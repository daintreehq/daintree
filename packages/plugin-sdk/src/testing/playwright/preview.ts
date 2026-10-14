import fs from "node:fs/promises";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../../shared/types/plugin.js";
import { PREVIEW_FAILURE_ATTRIBUTE, PREVIEW_READY_ATTRIBUTE } from "../preview/attributes.js";
import { PREVIEW_THEMES } from "../preview/themes.js";
import {
  BrowserProblems,
  PreviewCoverage,
  captureFileName,
  captureStableFrame,
  pairKey,
} from "./capture.js";
import { PREVIEW_HANDLE } from "./page.js";

export interface PanelPreviewOptions {
  /**
   * The plugin's directory, relative to the Playwright config. Defaults to the
   * config's own directory.
   */
  pluginDir?: string;
  /** The stories module, relative to `pluginDir`. Defaults to `review/panel.stories.tsx`. */
  storiesPath?: string;
  /**
   * The stories (export names) a test must capture. Defaults to every story in
   * the module, so a story added later is one the spec has to cover.
   */
  stories?: readonly string[];
  /** Built-in theme ids each story is captured under. Defaults to `["daintree"]`. */
  themes?: readonly string[];
}

export interface PanelPreview {
  /** The declared stories, in the module's order. */
  readonly stories: readonly string[];
  /** The declared themes. */
  readonly themes: readonly string[];
  /** Load the page with `story` mounted under `theme`. */
  open(story: string, theme?: string): Promise<void>;
  /**
   * A verified screenshot of the open story: taken once the page reports
   * ready, fonts have loaded and two consecutive frames match. It fails instead
   * on a failed mount, `play` or style install, and on any console error, page
   * error or failed request. Saved to the test's output folder as `name.png` and
   * attached to the report.
   */
  snap(name: string): Promise<Buffer>;
  /** Fail if any declared (story, theme) pair has no verified capture. */
  finish(): Promise<void>;
}

export interface PanelPreviewFixtures {
  preview: PanelPreview;
}

export interface PageHandle {
  stories?: string[];
  error?: string;
}

const THEME_IDS = new Set(PREVIEW_THEMES.map((theme) => theme.id));

function readinessOf(page: Page): Promise<{ status: string | null; reason: string | null }> {
  return page.evaluate(
    ([ready, failure]) => ({
      status: document.documentElement.getAttribute(ready),
      reason: document.documentElement.getAttribute(failure),
    }),
    [PREVIEW_READY_ATTRIBUTE, PREVIEW_FAILURE_ATTRIBUTE] as const
  );
}

function nextFrames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

export function validateThemes(themes: readonly string[]): readonly string[] {
  if (themes.length === 0) throw new Error("previewOptions.themes is empty");
  for (const theme of themes) {
    if (!THEME_IDS.has(theme)) {
      throw new Error(
        `Unknown preview theme "${theme}". Built-in themes: ${[...THEME_IDS].join(", ")}`
      );
    }
  }
  if (new Set(themes).size !== themes.length)
    throw new Error("previewOptions.themes repeats a theme");
  return themes;
}

export function validateStories(
  declared: readonly string[] | undefined,
  found: string[]
): string[] {
  if (found.length === 0) throw new Error("The stories module exports no stories");
  if (!declared) return found;
  if (declared.length === 0) throw new Error("previewOptions.stories is empty");
  const unknown = declared.filter((story) => !found.includes(story));
  if (unknown.length > 0) {
    throw new Error(
      `No story ${unknown.map((s) => `"${s}"`).join(", ")}; known: ${found.join(", ")}`
    );
  }
  return [...new Set(declared)];
}

/**
 * CSS for every class seen so far, or `null` when `classes` adds none. The
 * build compiles the classes its sources spell out; this covers the ones a
 * panel assembles at runtime, as the host's DOM observer does.
 */
export type RestylePanel = (classes: string[]) => Promise<string | null>;

const RUNTIME_STYLE_ID = "daintree-panel-preview-runtime-styles";

/** Compile what the rendered panel uses beyond the build's classes, and install it. */
async function restyleFromDom(page: Page, restyle: RestylePanel): Promise<void> {
  const classes = await page.evaluate((attribute) => {
    const found = new Set<string>();
    for (const root of document.querySelectorAll(`[${attribute}]`)) {
      for (const element of [root, ...root.querySelectorAll("[class]")]) {
        element.classList.forEach((name) => found.add(name));
      }
    }
    return [...found];
  }, PLUGIN_STYLE_ROOT_ATTRIBUTE);
  const css = await restyle(classes);
  if (css === null) return;
  await page.evaluate(
    ([id, text]) => {
      let style = document.getElementById(id);
      if (!style) {
        style = document.createElement("style");
        style.id = id;
        document.head.append(style);
      }
      style.textContent = text;
    },
    [RUNTIME_STYLE_ID, css] as const
  );
}

export interface TeardownState {
  status?: string;
  expectedStatus: string;
}

/**
 * What a passing test still owes at teardown: no browser problem after its last
 * capture, and a `finish()` if it opened a story. A failed, skipped or
 * expected-to-fail test is left with the outcome it already has.
 */
export function checkTeardown(
  state: TeardownState,
  unfinished: boolean,
  problems: BrowserProblems
): void {
  if (state.status !== "passed" || state.expectedStatus !== "passed") return;
  problems.throwIfAny("after the last capture");
  if (unfinished) {
    throw new Error(
      "The test opened a story but never called preview.finish(), so nothing checked that every declared story and theme was captured"
    );
  }
}

export function createPreview(
  page: Page,
  pageUrl: string,
  testInfo: TestInfo,
  stories: string[],
  themes: readonly string[],
  problems: BrowserProblems,
  restyle?: RestylePanel
) {
  const coverage = new PreviewCoverage(stories, themes);
  const names = new Set<string>();
  let current: { story: string; theme: string } | null = null;
  let opened = false;
  let finished = false;

  const preview: PanelPreview = {
    stories,
    themes,
    async open(story, theme = themes[0]!) {
      if (!stories.includes(story)) {
        throw new Error(`"${story}" is not a declared story; declared: ${stories.join(", ")}`);
      }
      if (!themes.includes(theme)) {
        throw new Error(`"${theme}" is not a declared theme; declared: ${themes.join(", ")}`);
      }
      current = null;
      opened = true;
      const query = new URLSearchParams({ story, theme });
      await page.goto(`${pageUrl}?${query.toString()}`);
      current = { story, theme };
    },
    async snap(name) {
      if (!current) throw new Error("preview.snap() needs a story: call preview.open() first");
      const { story, theme } = current;
      const file = captureFileName(name);
      if (names.has(file)) throw new Error(`A capture named "${name}" was already taken`);
      const what = `while capturing "${name}" (${pairKey(story, theme)})`;

      problems.throwIfAny(what);
      try {
        await page.waitForFunction(
          (ready) => document.documentElement.hasAttribute(ready),
          PREVIEW_READY_ATTRIBUTE
        );
      } catch (error) {
        problems.throwIfAny(what);
        throw new Error(`${pairKey(story, theme)} never reported ready or failed`, {
          cause: error,
        });
      }
      const assertReady = async () => {
        const readiness = await readinessOf(page);
        if (readiness.status !== "ready") {
          throw new Error(
            `${pairKey(story, theme)} did not render: ${readiness.reason ?? readiness.status}`
          );
        }
        problems.throwIfAny(what);
      };
      await assertReady();
      if (restyle) await restyleFromDom(page, restyle);
      // Again here, for a face something after the mount brought into use.
      const failedFont = await page.evaluate(async () => {
        await document.fonts.ready;
        let failed: string | null = null;
        document.fonts.forEach((face) => {
          if (face.status === "error") failed ??= face.family;
        });
        return failed;
      });
      if (failedFont) throw new Error(`${pairKey(story, theme)}: font did not load: ${failedFont}`);
      await nextFrames(page);

      const frame = await captureStableFrame({
        take: () => page.screenshot({ animations: "disabled", caret: "hide" }),
        between: () => nextFrames(page),
      });
      await assertReady();

      const target = testInfo.outputPath(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, frame);
      await testInfo.attach(name, { path: target, contentType: "image/png" });
      names.add(file);
      coverage.record(story, theme);
      return frame;
    },
    async finish() {
      finished = true;
      problems.throwIfAny("after the last capture");
      const missing = coverage.missing();
      if (missing.length > 0) {
        throw new Error(`No verified capture of:\n  ${missing.join("\n  ")}`);
      }
    },
  };
  return {
    preview,
    /** A test that opened a story and passed without accounting for its matrix. */
    unfinished: () => opened && !finished,
  };
}

/** Load the bare page and read the stories it found, or why it could not start. */
export async function discoverStories(
  page: Page,
  pageUrl: string,
  problems: BrowserProblems
): Promise<string[]> {
  let handle: PageHandle;
  try {
    await page.goto(pageUrl);
    handle = await page
      .waitForFunction((key) => {
        const value = (window as unknown as Record<string, PageHandle | undefined>)[key];
        return value && (value.stories || value.error) ? value : null;
      }, PREVIEW_HANDLE)
      .then((result) => result.jsonValue() as Promise<PageHandle>);
  } catch (error) {
    // A script that never ran says why in the console, not on the page.
    problems.throwIfAny("while loading the stories");
    throw error;
  }
  if (handle.error) throw new Error(`The panel preview did not start: ${handle.error}`);
  problems.throwIfAny("while loading the stories");
  return handle.stories ?? [];
}
