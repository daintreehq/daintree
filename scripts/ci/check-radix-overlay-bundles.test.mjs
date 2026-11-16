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
const REMOVE_SCROLL = "node_modules/react-remove-scroll/dist/es2015/index.js";
const BARREL = "src/components/ui/radix-deferred.ts";

/** Everything the deferred overlays load, named one by one so dropping a package from the guard fails here. */
const DEFERRED_MODULES = [
  ...[
    "react-tooltip",
    "react-popover",
    "react-dropdown-menu",
    "react-select",
    "react-context-menu",
    "react-menu",
    "react-dialog",
    "react-popper",
    "react-arrow",
    "react-collection",
    "react-roving-focus",
    "react-focus-scope",
    "react-focus-guards",
    "react-portal",
    "react-visually-hidden",
    "react-direction",
  ].map((name) => [`node_modules/@radix-ui/${name}/dist/index.mjs`, "a deferred Radix overlay"]),
  ...["core/dist/floating-ui.core.mjs", "dom/dist/floating-ui.dom.mjs", "react-dom/dist/x.mjs"].map(
    (file) => [`node_modules/@floating-ui/${file}`, "Floating UI"]
  ),
  ...["aria-hidden", "react-remove-scroll", "react-remove-scroll-bar"].map((name) => [
    `node_modules/${name}/dist/es2015/index.js`,
    "an overlay-only dependency",
  ]),
  [BARREL, "the deferred Radix barrel"],
];

/**
 * The entry statically imports a boot chunk and the Radix utility chunk, and
 * lazily the app root, which the seeds name; App lazily imports the deferred
 * barrel, whose chunk statically imports the overlay vendor chunk.
 */
function build({
  bootModules = ["src/boot.ts"],
  utilsModules = [PRIMITIVE, DISMISSABLE],
  appImports = ["_vendor-radix-utils.js"],
  appModules = ["src/App.tsx", "src/components/ui/DialogDismissSurface.tsx"],
  entryModules = ["src/main.tsx"],
  entryImports = ["_boot.js", "_vendor-radix-utils.js"],
  overlayModules = [POPOVER, FOCUS_SCOPE, FLOATING, REMOVE_SCROLL],
  preloadFiles = [
    "assets/index-a.js",
    "assets/boot-f.js",
    "assets/vendor-radix-utils-b.js",
    "assets/App-c.js",
  ],
} = {}) {
  const manifest = {
    "index.html": {
      file: "assets/index-a.js",
      src: "index.html",
      isEntry: true,
      imports: entryImports,
      dynamicImports: ["src/App.tsx"],
    },
    "_boot.js": { file: "assets/boot-f.js" },
    "_vendor-radix-utils.js": { file: "assets/vendor-radix-utils-b.js" },
    "src/App.tsx": {
      file: "assets/App-c.js",
      imports: appImports,
      dynamicImports: [BARREL],
    },
    [BARREL]: {
      file: "assets/radix-deferred-d.js",
      isDynamicEntry: true,
      imports: ["_vendor-radix-overlay.js", "_vendor-radix-utils.js"],
    },
    "_vendor-radix-overlay.js": { file: "assets/vendor-radix-overlay-e.js" },
  };
  const modulesByFile = {
    "assets/index-a.js": entryModules,
    "assets/boot-f.js": bootModules,
    "assets/vendor-radix-utils-b.js": utilsModules,
    "assets/App-c.js": appModules,
    "assets/radix-deferred-d.js": [BARREL],
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
    expect(problems).toEqual(
      [POPOVER, FOCUS_SCOPE, FLOATING, REMOVE_SCROLL].map((id) =>
        expect.stringMatching(new RegExp(`^the first-render graph: .* — ${id}$`))
      )
    );
  });

  it("fails on overlay modules grouped into an ordinary boot chunk, whatever it is called", () => {
    const leaked = [FOCUS_SCOPE, FLOATING, REMOVE_SCROLL, `${BARREL}?raw`];
    const problems = checkRadixOverlayBundles(build({ bootModules: ["src/boot.ts", ...leaked] }));
    for (const id of [FOCUS_SCOPE, FLOATING, REMOVE_SCROLL, BARREL]) {
      for (const label of [
        "the renderer's eager graph",
        "the first-render graph",
        "index.html modulepreload",
      ]) {
        expect(problems).toContain(
          `${label}: ${deferredOverlayFamily(id)} in assets/boot-f.js — ${id}`
        );
      }
    }
    expect(problems).toHaveLength(12);
  });

  it("flags every deferred overlay module on its own in a startup chunk", () => {
    for (const [id] of DEFERRED_MODULES) {
      const problems = checkRadixOverlayBundles(build({ bootModules: ["src/boot.ts", id] }));
      expect(problems, id).toHaveLength(3);
    }
  });

  it("matches module ids and seeds through query and hash suffixes", () => {
    expect(
      checkRadixOverlayBundles(
        build({ appModules: ["src/App.tsx?v=1", "src/components/ui/DialogDismissSurface.tsx"] })
      )
    ).toEqual([]);
    expect(checkRadixOverlayBundles(build({ bootModules: [`${BARREL}#x`] }))).toHaveLength(3);
  });

  it("fails when index.html preloads the overlay chunk the graphs don't reach", () => {
    const problems = checkRadixOverlayBundles(
      build({
        preloadFiles: ["assets/index-a.js", "assets/App-c.js", "assets/vendor-radix-overlay-e.js"],
      })
    );
    expect(problems).toEqual(
      [POPOVER, FOCUS_SCOPE, FLOATING, REMOVE_SCROLL].map((id) =>
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
    expect(checkRadixOverlayBundles(build({ entryModules: [] }))).toEqual([
      "the entry chunk assets/index-a.js lists no modules",
    ]);
    // The seed sits in another chunk's list, so only a lookup in its own chunk catches it.
    expect(
      checkRadixOverlayBundles(
        build({ appModules: ["src/Other.tsx"], bootModules: ["src/boot.ts", "src/App.tsx"] })
      )
    ).toEqual(["first-render seed src/App.tsx is missing from its own chunk's module list"]);
    expect(checkRadixOverlayBundles(build({ entryImports: ["_gone.js"] }))).toContain(
      "the renderer's eager graph: index.html imports _gone.js, which the manifest lacks"
    );
    expect(checkRadixOverlayBundles({ ...build(), seeds: [] })).toEqual([
      "the build named no first-render seeds",
    ]);
    expect(checkRadixOverlayBundles({ ...build(), seeds: ["src/Gone.tsx"] })).toEqual([
      "first-render seed src/Gone.tsx is not in the manifest",
    ]);
    expect(checkRadixOverlayBundles(build({ preloadFiles: [] }))).toEqual([
      "index.html names no modulepreload links",
    ]);
    expect(checkRadixOverlayBundles(build({ preloadFiles: ["assets/unknown.js"] }))).toEqual([
      "index.html modulepreload: no module list for assets/unknown.js",
    ]);
    expect(checkRadixOverlayBundles({ ...build(), manifest: {} })).toEqual([
      "the manifest has no renderer entry chunk",
    ]);
  });
});

describe("deferredOverlayFamily", () => {
  it("names each deferred overlay module's family", () => {
    for (const [id, family] of DEFERRED_MODULES) expect(deferredOverlayFamily(id), id).toBe(family);
    expect(
      deferredOverlayFamily("../daintree/node_modules/@radix-ui/react-menu/dist/index.mjs")
    ).toBe("a deferred Radix overlay");
  });

  it("leaves the eager Radix packages and look-alike names alone", () => {
    for (const eager of [
      DISMISSABLE,
      PRIMITIVE,
      "node_modules/@radix-ui/react-slot/dist/index.mjs",
      "node_modules/@radix-ui/react-checkbox/dist/index.mjs",
      "node_modules/@radix-ui/react-switch/dist/index.mjs",
      "node_modules/@radix-ui/react-menubar/dist/index.mjs",
      "node_modules/react-remove-scroll-extra/index.js",
      "node_modules/not-aria-hidden/index.js",
      "src/components/ui/popover.tsx",
      "src/components/ui/radix-deferred.test.ts",
    ]) {
      expect(deferredOverlayFamily(eager), eager).toBeNull();
    }
  });
});

describe("modulePreloadFiles", () => {
  it("reads every modulepreload href as a dist-relative file", () => {
    const html = [
      '<script type="module" crossorigin src="./assets/index-a.js"></script>',
      '<link rel="modulepreload" crossorigin href="./assets/vendor-react-b.js">',
      "<link rel=modulepreload href=/assets/boot-c.js>",
      '<link href="assets/vendor-radix-utils-d.js?v=1" rel="modulepreload">',
      "<link rel='modulepreload' href='./assets/single-g.js' />",
      '<LINK REL = "ModulePreload"\n  HREF = "./assets/upper-h.js">',
      '<link rel="modulepreload prefetch" href="./assets/tokens-i.js#top">',
      '<link rel="stylesheet" href="./assets/index-e.css">',
      '<link rel="preload" href="./assets/font-f.woff2" as="font">',
    ].join("\n");
    expect(modulePreloadFiles(html)).toEqual([
      "assets/vendor-react-b.js",
      "assets/boot-c.js",
      "assets/vendor-radix-utils-d.js",
      "assets/single-g.js",
      "assets/upper-h.js",
      "assets/tokens-i.js",
    ]);
  });

  it("reads rel and href as whole attributes, not as the tail of another one", () => {
    const html = [
      '<link rel="modulepreload" data-href="./assets/decoy-a.js" href="./assets/real-b.js">',
      '<link rel="stylesheet" data-rel="modulepreload" href="./assets/index-c.css">',
      '<link rel="modulepreload-extra" href="./assets/not-a-token-d.js">',
      '<link rel="modulepreload" href="./assets/first-e.js" href="./assets/second-f.js">',
    ].join("\n");
    expect(modulePreloadFiles(html)).toEqual(["assets/real-b.js", "assets/first-e.js"]);
  });
});
