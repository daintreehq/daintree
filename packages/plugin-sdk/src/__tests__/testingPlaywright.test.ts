import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../shared/types/plugin.js";
import { buildPanelPreview } from "../testing/playwright/build.js";
import {
  BrowserProblems,
  PreviewCoverage,
  captureFileName,
  captureStableFrame,
} from "../testing/playwright/capture.js";
import { renderShell } from "../testing/playwright/page.js";
import { createPreview, validateStories, validateThemes } from "../testing/playwright/preview.js";
import { startPanelPreviewServer, type PanelPreviewServer } from "../testing/playwright/server.js";
import { collectCandidates, compilePanelCss } from "../testing/playwright/styles.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-panel-preview-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PreviewCoverage", () => {
  it("lists every declared pair without a verified capture", () => {
    const coverage = new PreviewCoverage(["Empty", "Populated"], ["daintree", "bondi"]);
    coverage.record("Empty", "daintree");
    coverage.record("Populated", "bondi");
    expect(coverage.missing()).toEqual(["Empty × bondi", "Populated × daintree"]);
  });

  it("ignores captures outside the declared matrix", () => {
    const coverage = new PreviewCoverage(["Empty"], ["daintree"]);
    coverage.record("Loading", "daintree");
    expect(coverage.missing()).toEqual(["Empty × daintree"]);
  });
});

describe("BrowserProblems", () => {
  it("reports each problem once, naming when it was seen", () => {
    const problems = new BrowserProblems();
    problems.throwIfAny("before");
    problems.add("console error: boom");
    expect(() => problems.throwIfAny("while capturing")).toThrow(
      /while capturing:\n {2}console error: boom/
    );
    expect(() => problems.throwIfAny("later")).not.toThrow();
  });
});

describe("captureStableFrame", () => {
  it("returns the first frame that matches the one before it", async () => {
    const frames = ["a", "b", "c", "c"].map((f) => Buffer.from(f));
    const between = vi.fn(async () => {});
    const frame = await captureStableFrame({ take: async () => frames.shift()!, between });
    expect(frame.toString()).toBe("c");
    expect(between).toHaveBeenCalledTimes(2);
  });

  it("throws when the frames never settle", async () => {
    let n = 0;
    await expect(
      captureStableFrame({
        take: async () => Buffer.from(String(n++)),
        between: async () => {},
        maxAttempts: 4,
      })
    ).rejects.toThrow(/4 captures in a row differed/);
  });
});

describe("captureFileName", () => {
  it("turns a capture name into a file name", () => {
    expect(captureFileName(" Populated / bondi ")).toBe("Populated-bondi.png");
    expect(() => captureFileName("///")).toThrow(/not a usable capture name/);
  });
});

describe("validation", () => {
  it("accepts built-in themes and refuses unknown, empty and repeated ones", () => {
    expect(validateThemes(["daintree"])).toEqual(["daintree"]);
    expect(() => validateThemes(["nope"])).toThrow(/Unknown preview theme "nope"/);
    expect(() => validateThemes([])).toThrow(/empty/);
    expect(() => validateThemes(["daintree", "daintree"])).toThrow(/repeats/);
  });

  it("defaults to every found story and refuses ones the module lacks", () => {
    expect(validateStories(undefined, ["Empty", "Loading"])).toEqual(["Empty", "Loading"]);
    expect(validateStories(["Loading"], ["Empty", "Loading"])).toEqual(["Loading"]);
    expect(() => validateStories(["Gone"], ["Empty"])).toThrow(/No story "Gone"; known: Empty/);
    expect(() => validateStories(undefined, [])).toThrow(/exports no stories/);
  });
});

describe("compilePanelCss", () => {
  it("compiles the plugin's classes against the design contract, inside the style root", async () => {
    const candidates = collectCandidates([
      `export const View = () => <div className="flex bg-surface-panel bg-red-500" />;`,
    ]);
    const css = await compilePanelCss(candidates);
    expect(css).toContain(`@scope ([${PLUGIN_STYLE_ROOT_ATTRIBUTE}])`);
    expect(css).toMatch(/\.flex\s*\{\s*display: flex/);
    expect(css).toContain(".bg-surface-panel");
    // The contract deletes Tailwind's stock palette, as it does for the host.
    expect(css).not.toContain(".bg-red-500");
  });
});

/**
 * A plugin laid out as npm installs it: real React, and an SDK whose preview
 * and browser kit are stand-ins that each import React, so a second copy in
 * the bundle would show.
 */
async function fixturePlugin(options: { kit?: boolean } = {}): Promise<string> {
  const dir = path.join(tmpDir, "plugin");
  const modules = path.join(dir, "node_modules");
  await fs.mkdir(path.join(modules, "@daintreehq"), { recursive: true });
  for (const name of ["react", "react-dom"]) {
    await fs.symlink(path.join(repoRoot, "node_modules", name), path.join(modules, name));
  }
  const sdk = path.join(modules, "@daintreehq", "plugin-sdk");
  await fs.mkdir(path.join(sdk, "dist"), { recursive: true });
  await fs.mkdir(path.join(sdk, "browser", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@daintreehq/plugin-sdk",
      type: "module",
      exports: {
        "./testing/preview": "./dist/testing-preview.js",
        "./testing/plugin-ui": "./browser/plugin-ui.js",
        "./testing/preview.css": "./browser/preview.css",
      },
    })
  );
  await fs.writeFile(
    path.join(sdk, "dist", "testing-preview.js"),
    `import { createElement } from "react";
export const listPanelStories = () => [];
export const mountPanelStory = () => createElement("div");
`
  );
  await fs.writeFile(
    path.join(sdk, "browser", "plugin-ui.js"),
    `import { useState } from "react";
export const whenPluginUiReady = () => Promise.resolve();
export const Button = () => useState(null)[0];
`
  );
  if (options.kit !== false) {
    await fs.writeFile(path.join(sdk, "browser", "preview.css"), "body{}");
    await fs.writeFile(path.join(sdk, "browser", "assets", "font.woff2"), "font");
  }
  await fs.mkdir(path.join(dir, "review"), { recursive: true });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "panel.tsx"),
    `import { useState } from "react";
import { Button } from "@daintreehq/plugin-ui";
export default function Panel() {
  const [n] = useState(0);
  return <div className="flex gap-2">{n}<Button /></div>;
}
`
  );
  await fs.writeFile(
    path.join(dir, "review", "panel.stories.tsx"),
    `import Panel from "../src/panel";
export default { component: Panel };
export const Empty = {};
`
  );
  return dir;
}

describe("buildPanelPreview", () => {
  it("bundles the stories, harness and kit against one installed React", async () => {
    const pluginDir = await fixturePlugin();
    const built = await buildPanelPreview({ pluginDir, storiesPath: "review/panel.stories.tsx" });

    // Nothing left for an import map to resolve.
    expect(built.script).not.toMatch(/\bfrom\s*["']/);
    expect(built.script).not.toMatch(/\bimport\s*\(\s*["']react/);
    // React itself, inlined once: esbuild wraps each CommonJS module under its path.
    expect(
      built.script.match(/"[^"]*node_modules\/react\/cjs\/react\.production\.js"\(/g)
    ).toHaveLength(1);
    expect(built.script).toContain("whenPluginUiReady");
    expect(built.kitDir).toBe(
      path.join(pluginDir, "node_modules", "@daintreehq", "plugin-sdk", "browser")
    );
    // The plugin's own classes, not the kit's or React's.
    expect(built.css).toContain(".gap-2");
  });

  it("names the missing stories module", async () => {
    const pluginDir = await fixturePlugin();
    await expect(
      buildPanelPreview({ pluginDir, storiesPath: "review/missing.stories.tsx" })
    ).rejects.toThrow(/No stories module at .*missing\.stories\.tsx/);
  });

  it("says how to get the SDK's browser build when it is absent", async () => {
    const pluginDir = await fixturePlugin({ kit: false });
    await expect(
      buildPanelPreview({ pluginDir, storiesPath: "review/panel.stories.tsx" })
    ).rejects.toThrow(/no browser build/);
  });
});

function request(
  url: string,
  options: { method?: string; host?: string } = {}
): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? "GET",
        headers: options.host ? { host: options.host } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startPanelPreviewServer", () => {
  let server: PanelPreviewServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function serve(): Promise<PanelPreviewServer> {
    const kitDir = path.join(tmpDir, "kit");
    await fs.mkdir(path.join(kitDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(kitDir, "preview.css"), "body{}");
    await fs.writeFile(path.join(kitDir, "assets", "face.woff2"), "font");
    await fs.writeFile(path.join(tmpDir, "secret.txt"), "secret");
    server = await startPanelPreviewServer({
      title: "Viewer",
      script: "export {};",
      css: ".flex{}",
      kitDir,
    });
    return server;
  }

  it("serves the shell, the build and the kit's files", async () => {
    const { url } = await serve();
    const page = await request(url);
    expect(page.status).toBe(200);
    expect(page.body).toBe(renderShell("Viewer"));
    expect((await request(`${url}_preview/panel.js`)).body).toBe("export {};");
    expect((await request(`${url}_preview/panel.css`)).body).toBe(".flex{}");
    const font = await request(`${url}_preview/kit/assets/face.woff2`);
    expect(font).toMatchObject({ status: 200, type: "font/woff2", body: "font" });
  });

  it("keeps requests inside the kit directory and on loopback", async () => {
    const { url } = await serve();
    expect((await request(`${url}_preview/kit/%2e%2e%2fsecret.txt`)).status).toBe(404);
    expect((await request(url, { host: "evil.example:80" })).status).toBe(403);
    expect((await request(url, { method: "POST" })).status).toBe(405);
  });
});

/** A page whose readiness, fonts and frames the test sets. */
function fakePage(state: {
  readiness: { status: string | null; reason: string | null };
  frames?: string[];
  font?: string | null;
}) {
  const gotos: string[] = [];
  const page = {
    goto: vi.fn(async (url: string) => {
      gotos.push(url);
    }),
    waitForFunction: vi.fn(async () => {
      if (state.readiness.status === null) throw new Error("Timeout");
    }),
    evaluate: vi.fn(async (fn: (...args: unknown[]) => unknown, arg?: unknown) => {
      if (Array.isArray(arg)) return state.readiness;
      if (fn.toString().includes("fonts")) return state.font ?? null;
      return undefined;
    }),
    screenshot: vi.fn(async () => Buffer.from(state.frames?.shift() ?? "frame")),
  };
  return { page: page as unknown as Page, gotos };
}

function fakeTestInfo() {
  const attach = vi.fn(async () => {});
  const info = { outputPath: (file: string) => path.join(tmpDir, "out", file), attach };
  return { testInfo: info as unknown as TestInfo, attach };
}

describe("createPreview", () => {
  const ready = { status: "ready", reason: null };

  function setup(
    readiness: { status: string | null; reason: string | null } = ready,
    problems = new BrowserProblems()
  ) {
    const state = { readiness, frames: undefined as string[] | undefined };
    const { page, gotos } = fakePage(state);
    const { testInfo, attach } = fakeTestInfo();
    const created = createPreview(
      page,
      "http://127.0.0.1:1/",
      testInfo,
      ["Empty", "Populated"],
      ["daintree", "bondi"],
      problems
    );
    return { ...created, state, gotos, attach, problems };
  }

  it("opens a story under a theme by query", async () => {
    const { preview, gotos } = setup();
    await preview.open("Populated", "bondi");
    expect(gotos).toEqual(["http://127.0.0.1:1/?story=Populated&theme=bondi"]);
    await expect(preview.open("Missing")).rejects.toThrow(/not a declared story/);
    await expect(preview.open("Empty", "nope")).rejects.toThrow(/not a declared theme/);
  });

  it("captures a settled frame, saves and attaches it", async () => {
    const { preview, state, attach } = setup();
    await preview.open("Empty", "daintree");
    state.frames = ["one", "two", "two"];
    const frame = await preview.snap("Empty daintree");
    expect(frame.toString()).toBe("two");
    const file = path.join(tmpDir, "out", "Empty-daintree.png");
    expect((await fs.readFile(file)).toString()).toBe("two");
    expect(attach).toHaveBeenCalledWith("Empty daintree", { path: file, contentType: "image/png" });
  });

  it("refuses to capture before a story is open, or twice under one name", async () => {
    const { preview } = setup();
    await expect(preview.snap("x")).rejects.toThrow(/call preview.open\(\) first/);
    await preview.open("Empty");
    await preview.snap("x");
    await expect(preview.snap("x")).rejects.toThrow(/already taken/);
  });

  it("fails on a preview that reported failed, and counts nothing", async () => {
    const { preview, attach } = setup({
      status: "failed",
      reason: "styles failed to install: bad class",
    });
    await preview.open("Empty");
    await expect(preview.snap("Empty")).rejects.toThrow(
      /Empty × daintree did not render: styles failed to install: bad class/
    );
    expect(attach).not.toHaveBeenCalled();
    await expect(preview.finish()).rejects.toThrow(/Empty × daintree/);
  });

  it("fails on a console error the page raised", async () => {
    const problems = new BrowserProblems();
    const { preview } = setup(ready, problems);
    await preview.open("Empty");
    problems.add("console error: Cannot read properties of undefined");
    await expect(preview.snap("Empty")).rejects.toThrow(/console error: Cannot read properties/);
  });

  it("names a page that never reported readiness", async () => {
    const { preview } = setup({ status: null, reason: null });
    await preview.open("Empty");
    await expect(preview.snap("Empty")).rejects.toThrow(/never reported ready or failed/);
  });

  it("fails on a font that did not load", async () => {
    const { page } = fakePage({ readiness: ready, font: "Inter" });
    const { testInfo } = fakeTestInfo();
    const { preview } = createPreview(
      page,
      "http://127.0.0.1:1/",
      testInfo,
      ["Empty"],
      ["daintree"],
      new BrowserProblems()
    );
    await preview.open("Empty");
    await expect(preview.snap("Empty")).rejects.toThrow(/font did not load: Inter/);
  });

  it("finishes only once every declared pair has a verified capture", async () => {
    const { preview, unfinished } = setup();
    expect(unfinished()).toBe(false);
    await preview.open("Empty", "daintree");
    await preview.snap("Empty-daintree");
    expect(unfinished()).toBe(true);
    await expect(preview.finish()).rejects.toThrow(
      /No verified capture of:\n {2}Empty × bondi\n {2}Populated × daintree\n {2}Populated × bondi/
    );
    expect(unfinished()).toBe(false);
    for (const [story, theme] of [
      ["Empty", "bondi"],
      ["Populated", "daintree"],
      ["Populated", "bondi"],
    ] as const) {
      await preview.open(story, theme);
      await preview.snap(`${story}-${theme}`);
    }
    await expect(preview.finish()).resolves.toBeUndefined();
  });
});
