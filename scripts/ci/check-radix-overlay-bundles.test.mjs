import { describe, expect, it } from "vitest";
import {
  checkRadixOverlayBundles,
  deferredOverlayFamily,
  modulePreloadFiles,
} from "./check-radix-overlay-bundles.mjs";

const DISMISSABLE = "node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs";
const PRIMITIVE = "node_modules/@radix-ui/react-primitive/dist/index.mjs";
const POPOVER = "node_modules/@radix-ui/react-popover/dist/index.mjs";
const FOCUS_SCOPE = "node_modules/@radix-ui/react-focus-scope/dist/index.mjs";
const FLOATING = "node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs";

/**
 * The entry statically imports the Radix utility chunk and lazily the app root,
 * which the seeds name; App lazily imports the deferred barrel, whose chunk
 * statically imports the overlay vendor chunk.
 */
function build({
  utilsModules = [PRIMITIVE, DISMISSABLE],
  appImports = ["_vendor-radix-utils.js"],
  entryImports = ["_vendor-radix-utils.js"],
  overlayModules = [POPOVER, FOCUS_SCOPE, FLOATING],
  preloadFiles = ["assets/index-a.js", "assets/vendor-radix-utils-b.js", "assets/App-c.js"],
} = {}) {
  const manifest = {
    "index.html": {
      file: "assets/index-a.js",
      src: "index.html",
      isEntry: true,
      imports: entryImports,
      dynamicImports: ["src/App.tsx"],
    },
    "_vendor-radix-utils.js": { file: "assets/vendor-radix-utils-b.js" },
    "src/App.tsx": {
      file: "assets/App-c.js",
      imports: appImports,
      dynamicImports: ["src/components/ui/radix-deferred.ts"],
    },
    "src/components/ui/radix-deferred.ts": {
      file: "assets/radix-deferred-d.js",
      isDynamicEntry: true,
      imports: ["_vendor-radix-overlay.js", "_vendor-radix-utils.js"],
    },
    "_vendor-radix-overlay.js": { file: "assets/vendor-radix-overlay-e.js" },
  };
  const modulesByFile = {
    "assets/index-a.js": ["src/main.tsx"],
    "assets/vendor-radix-utils-b.js": utilsModules,
    "assets/App-c.js": ["src/App.tsx", "src/components/ui/DialogDismissSurface.tsx"],
    "assets/radix-deferred-d.js": ["src/components/ui/radix-deferred.ts"],
    "assets/vendor-radix-overlay-e.js": overlayModules,
  };
  return { manifest, modulesByFile, seeds: ["src/App.tsx"], preloadFiles };
}

describe("checkRadixOverlayBundles", () => {
  it("passes when the overlays load only behind the deferred barrel and dismissable-layer stays eager", () => {
    expect(checkRadixOverlayBundles(build())).toEqual([]);
  });

  it("fails when the app root statically imports the overlay chunk (#17028)", () => {
    const problems = checkRadixOverlayBundles(
      build({ appImports: ["_vendor-radix-utils.js", "_vendor-radix-overlay.js"] })
    );
    expect(
      problems.some((p) => p.startsWith("the first-render graph") && p.includes(POPOVER))
    ).toBe(true);
    expect(problems.some((p) => p.startsWith("the renderer's eager graph"))).toBe(false);
  });

  it("fails on overlay modules grouped into an eager chunk, whatever the chunk is called", () => {
    const problems = checkRadixOverlayBundles(
      build({ utilsModules: [PRIMITIVE, DISMISSABLE, FOCUS_SCOPE, FLOATING] })
    );
    expect(problems.filter((p) => p.includes(FOCUS_SCOPE))).toHaveLength(3);
    expect(problems.filter((p) => p.includes(FLOATING))).toHaveLength(3);
  });

  it("fails when index.html preloads the overlay chunk the graphs don't reach", () => {
    const problems = checkRadixOverlayBundles(
      build({
        preloadFiles: ["assets/index-a.js", "assets/App-c.js", "assets/vendor-radix-overlay-e.js"],
      })
    );
    expect(problems).toEqual(
      [POPOVER, FOCUS_SCOPE, FLOATING].map((id) =>
        expect.stringMatching(new RegExp(`^index\\.html modulepreload: .* — ${id}$`))
      )
    );
  });

  it("fails closed on missing evidence", () => {
    const missingList = build();
    delete missingList.modulesByFile["assets/vendor-radix-utils-b.js"];
    expect(checkRadixOverlayBundles(missingList)).toContain(
      "the renderer's eager graph: no module list for assets/vendor-radix-utils-b.js"
    );

    const danglingImport = build({ entryImports: ["_gone.js"] });
    expect(checkRadixOverlayBundles(danglingImport)).toContain(
      "the renderer's eager graph: index.html imports _gone.js, which the manifest lacks"
    );

    expect(checkRadixOverlayBundles({ ...build(), seeds: [] })).toContain(
      "the build named no first-render seeds"
    );
    expect(checkRadixOverlayBundles({ ...build(), seeds: ["src/Gone.tsx"] })).toContain(
      "first-render seed src/Gone.tsx is not in the manifest"
    );
    expect(checkRadixOverlayBundles(build({ preloadFiles: [] }))).toContain(
      "index.html names no modulepreload links"
    );
    expect(checkRadixOverlayBundles(build({ preloadFiles: ["assets/unknown.js"] }))).toContain(
      "index.html modulepreload: no module list for assets/unknown.js"
    );
    expect(checkRadixOverlayBundles({ ...build(), manifest: {} })).toEqual([
      "the manifest has no renderer entry chunk",
    ]);
  });
});

describe("deferredOverlayFamily", () => {
  it("names the deferred overlay family and leaves the eager Radix packages alone", () => {
    expect(deferredOverlayFamily(POPOVER)).toBe("a deferred Radix overlay");
    expect(
      deferredOverlayFamily("../daintree/node_modules/@radix-ui/react-menu/dist/index.mjs")
    ).toBe("a deferred Radix overlay");
    expect(deferredOverlayFamily(FLOATING)).toBe("Floating UI");
    expect(deferredOverlayFamily("src/components/ui/radix-deferred.ts")).toBe(
      "the deferred Radix barrel"
    );
    for (const eager of [
      DISMISSABLE,
      PRIMITIVE,
      "node_modules/@radix-ui/react-slot/dist/index.mjs",
      "node_modules/@radix-ui/react-checkbox/dist/index.mjs",
      "node_modules/@radix-ui/react-switch/dist/index.mjs",
      "node_modules/@radix-ui/react-menubar/dist/index.mjs",
      "src/components/ui/popover.tsx",
    ]) {
      expect(deferredOverlayFamily(eager)).toBeNull();
    }
  });
});

describe("modulePreloadFiles", () => {
  it("reads every modulepreload href as a dist-relative file, whatever its quoting", () => {
    const html = [
      '<script type="module" crossorigin src="./assets/index-a.js"></script>',
      '<link rel="modulepreload" crossorigin href="./assets/vendor-react-b.js">',
      "<link rel=modulepreload href=/assets/boot-c.js>",
      '<link href="assets/vendor-radix-utils-d.js?v=1" rel="modulepreload">',
      '<link rel="stylesheet" href="./assets/index-e.css">',
      '<link rel="preload" href="./assets/font-f.woff2" as="font">',
    ].join("\n");
    expect(modulePreloadFiles(html)).toEqual([
      "assets/vendor-react-b.js",
      "assets/boot-c.js",
      "assets/vendor-radix-utils-d.js",
    ]);
  });
});
