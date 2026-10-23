import { describe, expect, it } from "vitest";
import { checkElementPickerBundles } from "./check-element-picker-bundles.mjs";

const TOOL = "src/panels/dev-preview/element-picker/elementPickerTool.ts";
const SURFACES = "src/panels/dev-preview/element-picker/ElementPickerSurfaces.tsx";

/**
 * A build shaped like Vite's: the entry statically imports a shared vendor
 * chunk and lazily the app root, which the first-render seeds name; the dev
 * preview pane and the picker's surfaces load later still. Two chunks share a
 * name, as `boot` and `dist` chunks do in a real build.
 */
function build() {
  const manifest = {
    "index.html": {
      file: "assets/index-a.js",
      name: "index",
      src: "index.html",
      isEntry: true,
      imports: ["_vendor-b.js"],
      dynamicImports: ["src/App.tsx"],
    },
    "_vendor-b.js": { file: "assets/vendor-b.js", name: "vendor" },
    "src/App.tsx": {
      file: "assets/App-c.js",
      name: "App",
      src: "src/App.tsx",
      isDynamicEntry: true,
      imports: ["_vendor-b.js", "_boot-d.js"],
      dynamicImports: ["src/components/DevPreview/DevPreviewPane.tsx"],
    },
    "_boot-d.js": { file: "assets/boot-d.js", name: "boot" },
    "_boot-e.js": { file: "assets/boot-e.js", name: "boot" },
    "src/components/DevPreview/DevPreviewPane.tsx": {
      file: "assets/DevPreviewPane-f.js",
      name: "DevPreviewPane",
      isDynamicEntry: true,
      imports: ["_boot-e.js"],
      dynamicImports: [SURFACES],
    },
    [SURFACES]: { file: "assets/ElementPickerSurfaces-g.js", isDynamicEntry: true },
  };
  const modulesByFile = {
    "assets/index-a.js": ["src/main.tsx"],
    "assets/vendor-b.js": ["node_modules/react/index.js", "node_modules/zod/index.js"],
    "assets/App-c.js": ["src/App.tsx"],
    "assets/boot-d.js": ["src/boot/one.ts", TOOL],
    "assets/boot-e.js": ["src/boot/two.ts", "node_modules/@lezer/javascript/dist/index.js"],
    "assets/DevPreviewPane-f.js": ["src/components/DevPreview/DevPreviewPane.tsx"],
    "assets/ElementPickerSurfaces-g.js": [
      SURFACES,
      "src/panels/dev-preview/element-picker/inspectorController.ts",
      "node_modules/@babel/parser/lib/index.js",
    ],
  };
  return { manifest, modulesByFile, seeds: ["src/App.tsx"] };
}

describe("checkElementPickerBundles", () => {
  it("passes startup chunks that carry only the toolbar's tool, whatever loads later", () => {
    expect(checkElementPickerBundles(build())).toEqual([]);
  });

  it("names a parser that rides in a chunk the entry imports statically", () => {
    const shipped = build();
    shipped.modulesByFile["assets/vendor-b.js"].push(
      "node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs"
    );
    expect(checkElementPickerBundles(shipped)).toEqual([
      "the renderer's eager graph: source-map decoder — node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs",
      "the first-render graph: source-map decoder — node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs",
    ]);
  });

  it("names the picker's surfaces once grouping puts them on the first-render path", () => {
    const shipped = build();
    shipped.modulesByFile["assets/boot-d.js"].push(SURFACES);
    expect(checkElementPickerBundles(shipped)).toEqual([
      `the first-render graph: Element Picker UI beyond the toolbar's tool — ${SURFACES}`,
    ]);
  });

  it("fails closed on a walked chunk it has no module list for", () => {
    const shipped = build();
    delete shipped.modulesByFile["assets/boot-d.js"];
    expect(checkElementPickerBundles(shipped)).toEqual([
      "the first-render graph: no module list for assets/boot-d.js",
    ]);
  });

  it("fails closed on seeds it cannot find, or lists that do not hold them", () => {
    expect(checkElementPickerBundles({ ...build(), seeds: [] })).toEqual([
      "the build named no first-render seeds",
    ]);
    expect(checkElementPickerBundles({ ...build(), seeds: ["src/Gone.tsx"] })).toEqual([
      "first-render seed src/Gone.tsx is not in the manifest",
    ]);
    const shipped = build();
    shipped.modulesByFile["assets/App-c.js"] = ["src/Other.tsx"];
    expect(checkElementPickerBundles(shipped)).toEqual([
      "the first-render graph: src/App.tsx is missing from its own chunk's module list",
    ]);
    shipped.modulesByFile["assets/index-a.js"] = [];
    expect(checkElementPickerBundles(shipped)).toContain(
      "the entry chunk assets/index-a.js lists no modules"
    );
  });

  it("refuses a manifest with no renderer entry", () => {
    const shipped = build();
    shipped.manifest["index.html"].isEntry = false;
    expect(checkElementPickerBundles(shipped)).toEqual([
      "the manifest has no renderer entry chunk",
    ]);
  });
});
