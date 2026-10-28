import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { disabledBuiltinDirs, checkVanillaPluginBundles } from "./check-vanilla-plugin-bundles.mjs";

const DISABLED = ["plugins/builtin/markdown-editor/"];
const STUB = "plugins/builtin/markdown-editor/renderer/index.ts";
const VIEW = "plugins/builtin/markdown-editor/renderer/MarkdownEditorView.tsx";

/** The entry statically imports a shared chunk and lazily the app root, which the seeds name; the editor view is lazy. */
function build({ sharedModules = [STUB], viewChunkImportedBy = "lazy" } = {}) {
  const manifest = {
    "index.html": {
      file: "assets/index-a.js",
      src: "index.html",
      isEntry: true,
      imports: ["_shared-b.js"],
      dynamicImports: ["src/App.tsx"],
    },
    "_shared-b.js": { file: "assets/shared-b.js" },
    "src/App.tsx": {
      file: "assets/App-c.js",
      imports: ["_shared-b.js"],
      dynamicImports: viewChunkImportedBy === "lazy" ? [VIEW] : [],
    },
    [VIEW]: { file: "assets/View-d.js", isDynamicEntry: true },
  };
  const modulesByFile = {
    "assets/index-a.js": ["src/main.tsx"],
    "assets/shared-b.js": sharedModules,
    "assets/App-c.js": ["src/App.tsx"],
    "assets/View-d.js": [VIEW],
  };
  return { manifest, modulesByFile, seeds: ["src/App.tsx"], disabledDirs: DISABLED };
}

describe("checkVanillaPluginBundles", () => {
  it("passes when a disabled plugin contributes only its registration stub", () => {
    expect(checkVanillaPluginBundles(build())).toEqual([]);
  });

  it("fails when the optional implementation is merged into a statically imported chunk", () => {
    const problems = checkVanillaPluginBundles(build({ sharedModules: [STUB, VIEW] }));
    expect(problems.some((p) => p.includes(VIEW))).toBe(true);
  });

  it("fails closed on a chunk with no module list", () => {
    const input = build();
    delete input.modulesByFile["assets/shared-b.js"];
    expect(checkVanillaPluginBundles(input).join("\n")).toMatch(/no module list/);
  });

  it("fails closed on a seed the manifest lacks and on an empty disabled set", () => {
    const input = { ...build(), seeds: ["src/Missing.tsx"], disabledDirs: [] };
    const text = checkVanillaPluginBundles(input).join("\n");
    expect(text).toMatch(/not in the manifest/);
    expect(text).toMatch(/no default-disabled/);
  });
});

describe("disabledBuiltinDirs", () => {
  it("derives one directory per shipped default-disabled plugin id", () => {
    const source = readFileSync(
      new URL("../../shared/config/pluginDefaults.ts", import.meta.url),
      "utf8"
    );
    const dirs = disabledBuiltinDirs(source);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.every((d) => /^plugins\/builtin\/[a-z0-9-]+\/$/.test(d))).toBe(true);
  });
});
