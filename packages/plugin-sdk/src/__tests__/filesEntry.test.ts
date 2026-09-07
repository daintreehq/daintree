import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as filesEntry from "../files.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The `files` subpath is the file-listing machinery plugins build their own
 * browsers on, and it is also what Daintree's own file browser imports. These
 * guard the two ways that pairing breaks silently: a re-export that no longer
 * resolves (which a plugin author only discovers at build time, not us), and
 * the subpath drifting out of the places that have to declare it.
 */
describe("@daintreehq/plugin-sdk/files", () => {
  it("resolves every export the barrel promises", () => {
    // A broken or renamed re-export leaves `undefined` behind rather than
    // throwing, so assert on the actual binding rather than merely importing.
    const runtimeExports = [
      "flattenTree",
      "buildFolderListingRows",
      "findNodeInListings",
      "sortFileNodes",
      "isDefaultFileSort",
      "createVisibilityFilter",
      "countHiddenRows",
      "isRowPathVisible",
      "parentDirectoryOf",
      "canonicalizeRootPath",
      "parentRootPath",
      "ancestorDirectories",
      "resolveTypeahead",
      "resolveTreeKey",
      "buildFileBrowserGitStatusIndex",
      "getFileBrowserRowGitStatus",
      "getFileTypeCategory",
    ] as const;

    for (const name of runtimeExports) {
      expect(typeof filesEntry[name], `${name} should be a function`).toBe("function");
    }

    const constantExports = ["DEFAULT_FILE_SORT", "NO_HIDDEN_ROWS", "TYPEAHEAD_RESET_MS"] as const;

    for (const name of constantExports) {
      expect(filesEntry[name], `${name} should be defined`).toBeDefined();
    }
  });

  it("keeps host-shaped and policy-freezing helpers out of the public surface", () => {
    // These exist in the source the built-in browser imports, and are withheld
    // deliberately. `sourceIdentityKey` and the snapshot pair are keyed by
    // `FileBrowserSource`, a union naming a worktree id no plugin can
    // construct; the snapshot format has no version or migration story; and the
    // cache/bound constants would freeze tuning policy on first publish.
    // Re-exporting any of them is a decision, not an oversight, so it should
    // fail here first.
    const withheld = [
      "sourceIdentityKey",
      "snapshotFromListings",
      "snapshotMatchesSource",
      "pruneListings",
      "isReadableRelativePath",
      "MAX_SNAPSHOT_LISTINGS",
      "MAX_SNAPSHOT_NODES",
      "MAX_SNAPSHOT_TEXT_CHARS",
      "MAX_TREE_DEPTH",
    ];

    for (const name of withheld) {
      expect(Object.hasOwn(filesEntry, name), `${name} should not be public`).toBe(false);
    }

    // And the type that leaks host vocabulary must not appear in the reviewed
    // declaration snapshot either — a type-only export is invisible to the
    // runtime check above.
    const snapshot = readFileSync(path.join(packageRoot, "api-report/files.d.ts"), "utf-8");
    expect(snapshot).not.toContain("FileBrowserSource");
    expect(snapshot).not.toContain("worktreeId");
  });

  it("classifies filenames without pulling in an icon library", () => {
    // The headless split is the reason this can ship at all: bundling
    // `lucide-react` into the SDK would drag an icon set into every plugin.
    expect(filesEntry.getFileTypeCategory("src/index.ts")).toBe("source");
    expect(filesEntry.getFileTypeCategory("package-lock.json")).toBe("lock");
    expect(filesEntry.getFileTypeCategory(".eslintrc.json")).toBe("config");
    expect(filesEntry.getFileTypeCategory("clip.mp4")).toBe("video");
    expect(filesEntry.getFileTypeCategory("mystery.zzz")).toBe("unknown");

    const source = readFileSync(path.join(packageRoot, "src/files/fileTypeCategory.ts"), "utf-8");
    expect(source).not.toContain("lucide-react");
    expect(source).not.toContain("react");
  });

  it("is declared everywhere the subpath has to be listed", () => {
    // Three files must agree or the subpath half-exists: package exports (what
    // a consumer resolves), the tsup entry (whether dist/files.js is built at
    // all), and the API-surface gate (whether additions get reviewed).
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(manifest.exports["./files"]).toEqual({
      types: "./dist/files.d.ts",
      import: "./dist/files.js",
      default: "./dist/files.js",
    });

    const tsup = readFileSync(path.join(packageRoot, "tsup.config.ts"), "utf-8");
    expect(tsup).toContain('files: "src/files.ts"');

    const gate = readFileSync(
      path.join(packageRoot, "../../scripts/ci/check-api-surface.mjs"),
      "utf-8"
    );
    expect(gate).toContain('name: "./files"');
  });

  it("composes a browsable tree through the public surface alone", () => {
    // The 650 file-browser tests exercise this code through the app's shims,
    // which import the implementation modules directly. They would all still
    // pass with the public barrel broken. This drives one real scenario through
    // the exports a plugin author actually gets.
    const listings = new Map([
      [
        "",
        [
          { name: "src", path: "src", isDirectory: true },
          { name: "README.md", path: "README.md", isDirectory: false, size: 12, mtimeMs: 1 },
          { name: ".env", path: ".env", isDirectory: false, size: 3, mtimeMs: 1 },
        ],
      ],
      [
        "src",
        [
          { name: "index.ts", path: "src/index.ts", isDirectory: false, size: 40, mtimeMs: 2 },
          { name: "app.css", path: "src/app.css", isDirectory: false, size: 10, mtimeMs: 2 },
        ],
      ],
    ]);

    const visibility = { hideDotfiles: true, alwaysHiddenPatterns: [] };
    const visible = filesEntry.createVisibilityFilter(visibility);
    const rows = filesEntry.flattenTree(
      listings,
      new Set(["src"]),
      new Set(),
      "",
      visible,
      filesEntry.DEFAULT_FILE_SORT
    );

    // Under the default sort the listing order is preserved verbatim, because
    // `readdir({ detail: true })` already returns entries directories-first and
    // name-collated — re-sorting would be redundant work on every render. The
    // dotfile is filtered out rather than merely sorted away, and an expanded
    // directory's children follow it at depth 1.
    expect(rows.map((row) => row.path)).toEqual([
      "src",
      "src/index.ts",
      "src/app.css",
      "README.md",
    ]);
    expect(rows.find((row) => row.path === "src/index.ts")?.depth).toBe(1);

    // A non-default sort does reorder, so a browser offering sort controls gets
    // them without touching the listings it cached.
    const bySize = filesEntry.flattenTree(listings, new Set(["src"]), new Set(), "", visible, {
      key: "size",
      direction: "asc",
    });
    expect(bySize.map((row) => row.path)).toEqual([
      "src",
      "src/app.css",
      "src/index.ts",
      "README.md",
    ]);

    // The hidden entry is still counted, so a browser can offer to reveal it.
    // Counting takes the visibility settings rather than the predicate, because
    // it has to attribute each hidden row to the toggle that would bring it
    // back — the two recoveries differ.
    const hidden = filesEntry.countHiddenRows(listings, new Set(["src"]), "", visibility);
    expect(hidden.dotfiles).toBe(1);
    expect(hidden.alwaysHidden).toBe(0);

    // Keyboard resolution returns a declarative intent, not a DOM mutation.
    expect(filesEntry.resolveTreeKey("ArrowDown", rows, null)).toEqual({
      type: "select",
      path: "src",
    });
    expect(filesEntry.resolveTreeKey("ArrowLeft", rows, "src/index.ts")).toEqual({
      type: "select",
      path: "src",
    });

    // Typeahead skips the cursor row and matches on name, not path.
    expect(filesEntry.resolveTypeahead("re", rows, "src")).toBe("README.md");

    // And a row can be classified for an icon without any icon library.
    expect(filesEntry.getFileTypeCategory("src/app.css")).toBe("source");
  });

  it("keeps the model free of host-only imports", () => {
    // `shared/types/panel.ts` would drag the whole renderer type graph —
    // terminals, xterm, forge — into a package whose declaration bundle is
    // built by following imports. Narrow modules only.
    for (const file of ["src/files/fileTree.ts", "src/files/gitStatus.ts"]) {
      const source = readFileSync(path.join(packageRoot, file), "utf-8");
      expect(source, `${file} must not import the panel union`).not.toContain("types/panel");
      expect(source, `${file} must not use host path aliases`).not.toContain('from "@/');
      expect(source, `${file} must not use the shared barrel`).not.toContain('from "@shared/');
    }
  });
});
