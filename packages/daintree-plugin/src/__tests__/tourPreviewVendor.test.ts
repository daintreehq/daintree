import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { HOST_IMPORTMAP_SPECIFIERS } from "../../../plugin-vite/src/hostImportMap.js";
import { buildVendorGraph, renderFacade } from "../tour/preview/vendor.js";

const requireHere = createRequire(import.meta.url);

function packageDir(name: string): string {
  return path.dirname(requireHere.resolve(`${name}/package.json`));
}

/** A stand-in `@daintreehq/tour`: real ESM entries, shaped like the published package. */
const FAKE_TOUR: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "@daintreehq/tour",
    type: "module",
    exports: {
      ".": "./dist/index.js",
      "./react": "./dist/react.js",
      "./kit": "./dist/kit.js",
      "./mock-app": "./dist/mock-app.js",
    },
  }),
  "dist/index.js": "export class TourPlayer {}\n",
  "dist/react.js": [
    'import { createContext, useContext } from "react";',
    "export const TourPlayerContext = createContext(null);",
    "export function useCue(id) { return useContext(TourPlayerContext)?.timing.cues[id] !== undefined; }",
  ].join("\n"),
  "dist/kit.js": [
    'import { jsx } from "react/jsx-runtime";',
    'import { Search } from "lucide-react";',
    'export function TourCanvas({ children }) { return jsx("div", { className: "bg-surface-canvas", "data-tour-canvas": "", children: [jsx(Search, {}), children] }); }',
    "export function measureAnchor() { return null; }",
  ].join("\n"),
  "dist/mock-app.js": [
    'import { createContext } from "react";',
    'export { TourCanvas as MockApp } from "./kit.js";',
    "export const EMPTY_MOCK_KIT = {};",
    "export const MockKitContext = createContext(EMPTY_MOCK_KIT);",
    "",
  ].join("\n"),
};

let tmpDir: string;

async function writePlugin(options: { withReact?: boolean; withLucide?: boolean } = {}) {
  const modules = path.join(tmpDir, "node_modules");
  await fs.mkdir(path.join(modules, "@daintreehq"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "plugin" }));
  if (options.withReact ?? true) {
    for (const name of ["react", "react-dom", "scheduler"]) {
      await fs.symlink(packageDir(name), path.join(modules, name));
    }
  }
  if (options.withLucide ?? true) {
    await fs.symlink(packageDir("lucide-react"), path.join(modules, "lucide-react"));
  }
  for (const [file, text] of Object.entries(FAKE_TOUR)) {
    const target = path.join(modules, "@daintreehq", "tour", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-vendor-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("renderFacade", () => {
  it("names a CommonJS package's exports instead of star-exporting them", () => {
    const facade = renderFacade("react", ["useState", "default", "createContext", "not-safe"]);
    expect(facade).not.toContain("export *");
    expect(facade).toContain('export { createContext, useState } from "react";');
    expect(facade).toContain("export default m.default ?? m;");
  });

  it("star-exports the tour's ESM entries", () => {
    expect(renderFacade("@daintreehq/tour/react", [])).toBe(
      'export * from "@daintreehq/tour/react";\n'
    );
  });
});

describe("buildVendorGraph", () => {
  it("bundles every packaged host specifier from the plugin's own dependencies", async () => {
    await writePlugin();
    const graph = await buildVendorGraph(tmpDir);

    // `@daintreehq/plugin-ui` has no package behind it, only the running host.
    expect(Object.keys(graph.imports).sort()).toEqual(
      HOST_IMPORTMAP_SPECIFIERS.filter((s) => s !== "@daintreehq/plugin-ui").sort()
    );
    for (const url of Object.values(graph.imports)) {
      expect(graph.files.has(url.replace("/_preview/vendor/", ""))).toBe(true);
    }
    expect(graph.imports["react-dom/client"]).toBe("/_preview/vendor/react-dom-client.js");

    const react = graph.files.get("react.js")!;
    expect(react).toMatch(/export\s*\{[^}]*\buseState\b/);
    // One React: every facade imports the chunk holding it rather than inlining a copy.
    const copies = [...graph.files.values()].filter((text) =>
      text.includes("react/cjs/react.development.js")
    );
    expect(copies.length).toBe(1);

    expect(
      graph.tourFiles.map((file) => path.relative(tmpDir, file).split(path.sep).join("/")).sort()
    ).toEqual(
      [
        "node_modules/@daintreehq/tour/dist/index.js",
        "node_modules/@daintreehq/tour/dist/kit.js",
        "node_modules/@daintreehq/tour/dist/mock-app.js",
        "node_modules/@daintreehq/tour/dist/react.js",
      ].sort()
    );
  }, 30_000);

  it("names the package to install when React isn't there", async () => {
    await writePlugin({ withReact: false });
    await expect(buildVendorGraph(tmpDir)).rejects.toThrow(
      /Couldn't resolve "react" from .*npm install --save-dev react\b/
    );
  });

  it("asks for lucide-react when the mockup kit can't find it", async () => {
    await writePlugin({ withLucide: false });
    await expect(buildVendorGraph(tmpDir)).rejects.toThrow(/npm install --save-dev lucide-react/);
  }, 30_000);
});
