import { describe, expect, it } from "vitest";
import { build } from "vite";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { daintreePlugin } from "../index.js";

describe("document package build boundary", () => {
  it.each([
    'export const load = () => import("@fixture/missing-dependency");',
    'import "@fixture/missing-dependency"; export const ready = true;',
  ])("rejects unresolved dependencies before they can become runtime stubs: %s", async (source) => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-unresolved-"));
    try {
      await writeFile(path.join(root, "adapter.js"), source);
      await expect(
        build({
          configFile: false,
          root,
          logLevel: "silent",
          plugins: [
            daintreePlugin({
              documentPackages: { editor: { entry: "adapter.js", version: "1.0.0" } },
            }),
          ],
          build: { write: false, lib: { entry: path.join(root, "adapter.js"), formats: ["es"] } },
        })
      ).rejects.toThrow(/missing-dependency/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives identical packages in different roots the same hash while keeping distinct names addressable separately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-identity-"));
    try {
      const assets: string[][] = [];
      const sources: string[][] = [];
      for (const directory of ["first", "second"]) {
        const pluginRoot = path.join(root, directory);
        await mkdir(pluginRoot);
        await writeFile(path.join(pluginRoot, "adapter.js"), "export const state = new Map();");
        await writeFile(
          path.join(pluginRoot, "view.js"),
          'export { default as a } from "virtual:daintree-document-package/@acme/a"; export { default as b } from "virtual:daintree-document-package/@acme/b";'
        );
        const result = await build({
          configFile: false,
          root: pluginRoot,
          logLevel: "silent",
          plugins: [
            daintreePlugin({
              documentPackages: {
                "@acme/a": { entry: "adapter.js", version: "1.0.0", scope: "document" },
                "@acme/b": { entry: "adapter.js", version: "1.0.0", scope: "document" },
              },
            }),
          ],
          build: {
            write: false,
            lib: { entry: path.join(pluginRoot, "view.js"), formats: ["es"] },
          },
        });
        const outputs = Array.isArray(result) ? result : [result];
        sources.push(
          outputs
            .flatMap((output) => ("output" in output ? output.output : []))
            .filter((file) => file.type === "asset")
            .map((file) => String(file.source))
        );
        assets.push(
          outputs
            .flatMap((output) => ("output" in output ? output.output : []))
            .filter((file) => file.type === "asset")
            .map((file) => file.fileName)
            .sort()
        );
      }
      expect(sources[0]).toEqual(sources[1]);
      expect(assets[0]).toEqual(assets[1]);
      expect(assets[0]).toHaveLength(2);
      expect(new Set(assets[0]).size).toBe(2);
      const [firstName, secondName] = assets[0] ?? [];
      if (!firstName || !secondName) throw new Error("Missing package assets");
      expect(path.basename(firstName)).toBe(path.basename(secondName));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits a complete content-addressed adapter and a lazy loader, with no library in the view", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-build-"));
    try {
      await writeFile(
        path.join(root, "library.js"),
        'export class Editor { marker = "PACKAGE_ONLY_MARKER" };'
      );
      await writeFile(
        path.join(root, "adapter.js"),
        'export const load = () => import("./library.js");'
      );
      await writeFile(
        path.join(root, "view.js"),
        'export { default as loadEditor } from "virtual:daintree-document-package/@acme/editor";'
      );
      const result = await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [
          daintreePlugin({
            documentPackages: {
              "@acme/editor": { entry: "adapter.js", version: "1.0.0", scope: "document" },
            },
          }),
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry: path.join(root, "view.js"), formats: ["es"] },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const files = outputs.flatMap((output) => ("output" in output ? output.output : []));
      const adapter = files.find((file) => file.type === "asset" && file.fileName.endsWith(".js"));
      const view = files.find((file) => file.type === "chunk");
      if (adapter?.type !== "asset" || view?.type !== "chunk")
        throw new Error("Missing bundle output");
      expect(String(adapter.source)).toContain("PACKAGE_ONLY_MARKER");
      expect(view.code).not.toContain("PACKAGE_ONLY_MARKER");
      const digest = createHash("sha256").update(adapter.source).digest("hex");
      expect(adapter.fileName).toContain(digest);
      expect(view.code).toContain(digest);
      expect(view.code).toContain("bridge.load(import.meta.url");
      expect(view.code).not.toContain("ROLLUP_FILE_URL");
      expect(view.imports).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects CSS assets that would depend on the retired provider's authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-css-"));
    try {
      await writeFile(
        path.join(root, "adapter.js"),
        'import "./style.css"; export const editor = true;'
      );
      await writeFile(path.join(root, "style.css"), ".editor { color: red; }");
      await expect(
        build({
          configFile: false,
          root,
          logLevel: "silent",
          plugins: [
            daintreePlugin({
              documentPackages: { editor: { entry: "adapter.js", version: "1.0.0" } },
            }),
          ],
          build: { write: false, lib: { entry: path.join(root, "adapter.js"), formats: ["es"] } },
        })
      ).rejects.toThrow(/self-contained/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the adapter build on an optional unresolved dependency even though the view builds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-optional-"));
    try {
      // Lexxy's Active Storage shape: a caught dynamic import of a package that
      // is not installed. Rolldown would otherwise inline a throw-stub and pass
      // the self-contained check.
      await writeFile(
        path.join(root, "adapter.js"),
        'export const upload = () => import("@fixture/optional-dependency").catch(() => null);\nexport const ready = true;'
      );
      await writeFile(
        path.join(root, "view.js"),
        'export { default as loadEditor } from "virtual:daintree-document-package/editor";'
      );
      await expect(
        build({
          configFile: false,
          root,
          logLevel: "silent",
          plugins: [
            daintreePlugin({
              documentPackages: { editor: { entry: "adapter.js", version: "1.0.0" } },
            }),
          ],
          build: { write: false, lib: { entry: path.join(root, "view.js"), formats: ["es"] } },
        })
      ).rejects.toThrow(/optional-dependency/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces process.env.NODE_ENV inside the retained adapter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-package-env-"));
    try {
      await writeFile(path.join(root, "adapter.js"), "export const mode = process.env.NODE_ENV;");
      await writeFile(
        path.join(root, "view.js"),
        'export { default as loadEditor } from "virtual:daintree-document-package/editor";'
      );
      const result = await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [
          daintreePlugin({
            documentPackages: { editor: { entry: "adapter.js", version: "1.0.0" } },
          }),
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry: path.join(root, "view.js"), formats: ["es"] },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const adapter = outputs
        .flatMap((output) => ("output" in output ? output.output : []))
        .find((file) => file.type === "asset" && file.fileName.endsWith(".js"));
      if (adapter?.type !== "asset") throw new Error("Missing adapter asset");
      expect(String(adapter.source)).not.toContain("process.env");
      expect(String(adapter.source)).toMatch(/production/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
