import { describe, it, expect } from "vitest";
import type { File } from "gitdiff-parser";
import { isGeneratedFile, isGeneratedDiffFile } from "../generatedFileClassifier";

function makeFile(overrides: Partial<File> = {}): File {
  return {
    hunks: [],
    oldEndingNewLine: true,
    newEndingNewLine: true,
    oldMode: "100644",
    newMode: "100644",
    oldRevision: "abc123",
    newRevision: "def456",
    oldPath: "",
    newPath: "",
    type: "modify",
    ...overrides,
  };
}

// --- isGeneratedFile (path-only) ---

describe("isGeneratedFile", () => {
  describe("lockfile basenames", () => {
    it.each([
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "Cargo.lock",
      "go.sum",
      "Gemfile.lock",
      "Pipfile.lock",
      "poetry.lock",
      "composer.lock",
      "mix.lock",
      "flake.lock",
      "deno.lock",
    ])("detects: %s", (name) => {
      expect(isGeneratedFile(name)).toBe(true);
    });

    it("detects lockfiles in subdirectories", () => {
      expect(isGeneratedFile("subdir/package-lock.json")).toBe(true);
      expect(isGeneratedFile("deep/nested/path/yarn.lock")).toBe(true);
      expect(isGeneratedFile("frontend/Cargo.lock")).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(isGeneratedFile("PACKAGE-LOCK.JSON")).toBe(true);
      expect(isGeneratedFile("Yarn.Lock")).toBe(true);
    });
  });

  describe("suffix patterns", () => {
    it.each([
      "bundle.min.js",
      "app.min.css",
      "vendor.min.mjs",
      "vendor.min.js.map",
      "theme.min.css.map",
      "file.lockb",
      "app.bundle.js",
      "styles.bundle.css",
      "app.bundle.js.map",
      "styles.bundle.css.map",
      "shared.chunk.js",
      "lib.chunk.css",
      "shared.chunk.js.map",
      "lib.chunk.css.map",
      "user.pb.go",
      "message.pb.cc",
      "types.pb.h",
      "proto/messages.pb.ts",
      "proto/messages.pb.d.ts",
      "Form.designer.cs",
      "module.wasm",
      "src/__snapshots__/component.snap",
      "something.lock",
    ])("detects: %s", (name) => {
      expect(isGeneratedFile(name)).toBe(true);
    });

    it("detects suffix patterns in subdirectories", () => {
      expect(isGeneratedFile("packages/app/dist/vendor.min.js")).toBe(true);
      expect(isGeneratedFile("proto/generated/messages.pb.go")).toBe(true);
    });
  });

  describe("extension regex patterns (.gen.<ext>, .generated.<ext>)", () => {
    it.each([
      "schema.gen.ts",
      "types.gen.js",
      "api.generated.ts",
      "types.generated.js",
      "schema.generated.css",
      "schema.generated.graphql",
    ])("detects: %s", (name) => {
      expect(isGeneratedFile(name)).toBe(true);
    });
  });

  describe("build-output directories", () => {
    it.each([
      "dist/bundle.js",
      "build/index.html",
      ".next/cache/manifest.json",
      ".nuxt/server.js",
      ".svelte-kit/output.js",
      ".out/report.html",
      "coverage/lcov.info",
      "packages/app/dist/index.js",
      "__generated__/schema.ts",
      "src/__generated__/types.ts",
    ])("detects: %s", (name) => {
      expect(isGeneratedFile(name)).toBe(true);
    });
  });

  describe("non-generated files", () => {
    it.each([
      "src/index.ts",
      "src/component.tsx",
      "README.md",
      "CHANGELOG.md",
      "types/foo.d.ts",
      "docs/guide.md",
      "package.json",
    ])("does not flag: %s", (name) => {
      expect(isGeneratedFile(name)).toBe(false);
    });

    it("does not flag files containing a dir pattern in their name", () => {
      expect(isGeneratedFile("src/distance.ts")).toBe(false);
      expect(isGeneratedFile("redistribution.md")).toBe(false);
      expect(isGeneratedFile("src/build.ts")).toBe(false);
    });
  });

  it("handles empty input", () => {
    expect(isGeneratedFile("")).toBe(false);
  });

  it("normalizes Windows-style backslashes", () => {
    expect(isGeneratedFile("frontend\\package-lock.json")).toBe(true);
    expect(isGeneratedFile("packages\\app\\dist\\bundle.js")).toBe(true);
    expect(isGeneratedFile("src\\index.ts")).toBe(false);
  });
});

// --- isGeneratedDiffFile (path + content) ---

describe("isGeneratedDiffFile", () => {
  it("returns true for a path-only generated file", () => {
    const file = makeFile({ newPath: "package-lock.json" });
    expect(isGeneratedDiffFile(file)).toBe(true);
  });

  it("returns false for a normal source file with no generated content", () => {
    const file = makeFile({
      newPath: "src/index.ts",
    });
    expect(isGeneratedDiffFile(file)).toBe(false);
  });

  describe("content-based detection (added files)", () => {
    it("detects Go-style generated header", () => {
      const file = makeFile({
        type: "add",
        newPath: "proto/messages.go",
        hunks: [
          {
            content: "@@ -0,0 +1,5 @@\n",
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 5,
            changes: [
              {
                type: "insert" as const,
                content: "// Code generated by protoc-gen-go. DO NOT EDIT.\n",
                isInsert: true,
                lineNumber: 1,
              },
              {
                type: "insert" as const,
                content: "package proto\n",
                isInsert: true,
                lineNumber: 2,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(true);
    });

    it("detects auto-generated marker (hyphenated)", () => {
      const file = makeFile({
        type: "add",
        newPath: "src/types.ts",
        hunks: [
          {
            content: "@@ -0,0 +1,3 @@\n",
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 3,
            changes: [
              {
                type: "insert" as const,
                content: "// auto-generated file — edits will be overwritten\n",
                isInsert: true,
                lineNumber: 1,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(true);
    });

    it("detects auto generated marker (unhyphenated)", () => {
      const file = makeFile({
        type: "add",
        newPath: "generated/api.ts",
        hunks: [
          {
            content: "@@ -0,0 +1,2 @@\n",
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 2,
            changes: [
              {
                type: "insert" as const,
                content: "// autogenerated — DO NOT MODIFY\n",
                isInsert: true,
                lineNumber: 1,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(true);
    });

    it("does not flag file with header beyond sniff window (line > 20)", () => {
      const changes = [];
      for (let i = 1; i <= 25; i++) {
        changes.push({
          type: "insert" as const,
          content: `// line ${i}\n`,
          isInsert: true,
          lineNumber: i,
        });
      }
      changes[20] = {
        type: "insert" as const,
        content: "// Code generated by tool. DO NOT EDIT.\n",
        isInsert: true,
        lineNumber: 21,
      };

      const file = makeFile({
        type: "add",
        newPath: "src/late-generated.ts",
        hunks: [
          {
            content: "@@ -0,0 +1,25 @@\n",
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 25,
            changes,
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(false);
    });

    it("does not flag a modified file even with generated header content", () => {
      const file = makeFile({
        type: "modify",
        newPath: "proto/messages.go",
        hunks: [
          {
            content: "@@ -1,5 +1,6 @@\n",
            oldStart: 1,
            newStart: 1,
            oldLines: 5,
            newLines: 6,
            changes: [
              {
                type: "normal" as const,
                content: "// Code generated by protoc-gen-go. DO NOT EDIT.\n",
                isNormal: true,
                oldLineNumber: 1,
                newLineNumber: 1,
              },
              {
                type: "insert" as const,
                content: "// new method\n",
                isInsert: true,
                lineNumber: 6,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(false);
    });

    it("does not flag added file whose first hunk does not start at line 1", () => {
      const file = makeFile({
        type: "add",
        newPath: "src/appended.ts",
        hunks: [
          {
            content: "@@ -0,0 +1,3 @@\n",
            oldStart: 0,
            newStart: 50,
            oldLines: 0,
            newLines: 3,
            changes: [
              {
                type: "insert" as const,
                content: "// Code generated by tool. DO NOT EDIT.\n",
                isInsert: true,
                lineNumber: 50,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(false);
    });

    it("returns false for a binary file that is not path-generated", () => {
      const file = makeFile({
        type: "add",
        newPath: "assets/image.png",
        isBinary: true,
      });
      expect(isGeneratedDiffFile(file)).toBe(false);
    });

    it("returns true for a binary file with a generated path", () => {
      const file = makeFile({
        type: "add",
        newPath: "dist/bundle.js",
        isBinary: true,
      });
      expect(isGeneratedDiffFile(file)).toBe(true);
    });

    it("does not flag bare 'generated by' in an ordinary comment", () => {
      const file = makeFile({
        type: "add",
        newPath: "src/data.ts",
        hunks: [
          {
            content: "@@ -0,0 +1,3 @@\n",
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 3,
            changes: [
              {
                type: "insert" as const,
                content: "// Data generated by the analytics pipeline\n",
                isInsert: true,
                lineNumber: 1,
              },
            ],
          },
        ],
      });
      expect(isGeneratedDiffFile(file)).toBe(false);
    });
  });

  it("resolves path from oldPath when newPath is /dev/null (deleted file)", () => {
    const file = makeFile({
      type: "delete",
      newPath: "/dev/null",
      oldPath: "package-lock.json",
    });
    expect(isGeneratedDiffFile(file)).toBe(true);
  });

  it("returns false for files with no usable path", () => {
    const file = makeFile({
      type: "delete",
      newPath: "/dev/null",
      oldPath: "/dev/null",
    });
    expect(isGeneratedDiffFile(file)).toBe(false);
  });
});
