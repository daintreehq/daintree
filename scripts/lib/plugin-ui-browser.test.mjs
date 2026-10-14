import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dropFullWindowRule,
  facadeRequiredExports,
  readCustomProperties,
  readStringArray,
  rewriteLocalUrls,
  scannableModules,
  validateKitBundle,
} from "./plugin-ui-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_SPECIFIERS = ["react", "react/jsx-runtime", "react-dom", "@daintreehq/plugin-ui"];

const chunk = (overrides = {}) => ({
  fileName: "plugin-ui.js",
  imports: ["react", "react/jsx-runtime"],
  dynamicImports: [],
  moduleIds: ["/repo/src/pluginUi/index.ts", "/repo/node_modules/clsx/dist/clsx.mjs"],
  exports: ["Button", "Dialog"],
  ...overrides,
});

const validate = (chunks) =>
  validateKitBundle({
    chunks,
    hostSpecifiers: HOST_SPECIFIERS,
    requiredExports: ["Button", "Dialog"],
  });

describe("validateKitBundle", () => {
  it("passes one file that imports only React and exports the facade", () => {
    expect(validate([chunk()])).toEqual([]);
  });

  it("ignores the reference Rolldown leaves for a dynamic import it inlined", () => {
    expect(validate([chunk({ dynamicImports: ["plugin-ui.js"] })])).toEqual([]);
  });

  it("refuses a second file, which an import map has no name for", () => {
    const problems = validate([chunk(), chunk({ fileName: "mermaid.js", exports: [] })]);
    expect(problems[0]).toMatch(/expected one JS file, got 2/);
  });

  it("refuses an import the page's map does not serve, the kit itself included", () => {
    expect(validate([chunk({ imports: ["react", "lucide-react"] })])).toEqual([
      'plugin-ui.js imports "lucide-react", which the import map does not serve',
    ]);
    expect(validate([chunk({ imports: ["@daintreehq/plugin-ui"] })])).toHaveLength(1);
    expect(validate([chunk({ dynamicImports: ["./chunk-abc.js"] })])).toHaveLength(1);
  });

  it("refuses a bundled React", () => {
    const moduleIds = ["/repo/node_modules/react/cjs/react.production.js"];
    expect(validate([chunk({ moduleIds })])).toEqual([
      `plugin-ui.js bundles React itself (${moduleIds[0]})`,
    ]);
  });

  it("names exports missing from the facade and ones outside it", () => {
    expect(validate([chunk({ exports: ["Dialog", "setPluginKitHost"] })])).toEqual([
      "missing facade exports: Button",
      "exports outside the facade: setPluginKitHost",
    ]);
  });
});

describe("the contracts it reads from source", () => {
  it("finds the host import map's React entrypoints", () => {
    const source = readFileSync(
      path.join(ROOT, "packages/plugin-vite/src/hostImportMap.ts"),
      "utf-8"
    );
    expect(readStringArray(source, "HOST_IMPORTMAP_SPECIFIERS")).toEqual(
      expect.arrayContaining(["react", "react/jsx-runtime", "react-dom", "react-dom/client"])
    );
  });

  it("finds the kit's entry among the facade contracts", () => {
    const names = facadeRequiredExports(readFileSync(path.join(ROOT, "vite.config.ts"), "utf-8"));
    expect(names).toEqual(expect.arrayContaining(["PLUGIN_UI_VERSION", "whenPluginUiReady"]));
    expect(names).not.toContain("useState");
  });
});

describe("scannableModules", () => {
  it("keeps the repo's source and leaves dependencies, assets and other roots out", () => {
    const ids = [
      "/repo/src/b.tsx",
      "\0/repo/src/a.ts?commonjs-proxy",
      "/repo/src/a.ts",
      "/repo/node_modules/radix/index.mjs",
      "/repo/src/kit.css",
      "/elsewhere/c.ts",
      "\0rolldown/runtime.js",
    ];
    expect(scannableModules(ids, "/repo")).toEqual(["/repo/src/a.ts", "/repo/src/b.tsx"]);
  });
});

describe("readCustomProperties", () => {
  it("lists each variable a sheet reads once, sorted, fallbacks included", () => {
    const css =
      ".token{color:var(--color-syntax-keyword)}\n" +
      ".a{border:2px solid var( --color-surface-input, var(--fallback-ring))}\n" +
      ".b{color:var(--color-syntax-keyword)}";
    expect(readCustomProperties(css)).toEqual([
      "--color-surface-input",
      "--color-syntax-keyword",
      "--fallback-ring",
    ]);
  });

  it("ignores declarations, which a sheet writes rather than reads", () => {
    expect(readCustomProperties(":root{--kit-gap:4px}")).toEqual([]);
  });
});

describe("dropFullWindowRule", () => {
  it("drops the host's full-window rule and nothing else", () => {
    const css =
      ".a{color:red}\nhtml,\nbody,\n#root {\n  height: 100%;\n  overflow: hidden;\n}\n.b{}";
    expect(dropFullWindowRule(css)).toBe(".a{color:red}\n\n.b{}");
  });

  it("throws when the rule is gone, rather than shipping a sheet that clips the page", () => {
    expect(() => dropFullWindowRule("html, body { height: 100% }")).toThrow(/found 0/);
  });
});

describe("rewriteLocalUrls", () => {
  const exists = () => true;

  it("points local urls at copies beside the stylesheet, once each", () => {
    const css =
      'a{src:url(../node_modules/f/mono-400.woff2)}b{src:url("../node_modules/f/mono-400.woff2")}' +
      "c{background:url('./assets/noise.png')}";
    const { css: out, assets } = rewriteLocalUrls(css, "/repo/src", exists);
    expect(out).toBe(
      'a{src:url(./assets/mono-400.woff2)}b{src:url("./assets/mono-400.woff2")}' +
        "c{background:url('./assets/noise.png')}"
    );
    expect(assets).toEqual([
      { source: "/repo/node_modules/f/mono-400.woff2", target: "assets/mono-400.woff2" },
      { source: "/repo/src/assets/noise.png", target: "assets/noise.png" },
    ]);
  });

  it("keeps two files with one name apart", () => {
    const { assets } = rewriteLocalUrls(
      "a{b:url(./x/icon.png)}c{d:url(./y/icon.png)}",
      "/r",
      exists
    );
    expect(new Set(assets.map((asset) => asset.target)).size).toBe(2);
  });

  it("keeps a url's query and fragment on the copy", () => {
    const { css, assets } = rewriteLocalUrls("a{b:url(./icons.svg#close)}", "/r", exists);
    expect(css).toBe("a{b:url(./assets/icons.svg#close)}");
    expect(assets).toEqual([{ source: "/r/icons.svg", target: "assets/icons.svg" }]);
  });

  it("leaves data, remote and fragment urls alone", () => {
    const css = 'a{b:url(data:image/png;base64,AA)}c{d:url("https://x/y.png")}e{f:url(#g)}';
    expect(rewriteLocalUrls(css, "/r", exists)).toEqual({ css, assets: [] });
  });

  it("throws on a url to a file that is not there", () => {
    expect(() => rewriteLocalUrls("a{b:url(./gone.png)}", "/r", () => false)).toThrow(/gone\.png/);
  });
});
