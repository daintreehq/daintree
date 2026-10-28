import { describe, it, expect } from "vitest";
import { matchesFileMenuTarget } from "../fileMenuMatch";

const file = (relativePath: string) => ({
  isDirectory: false,
  relativePath,
  name: relativePath.split("/").pop()!,
});
const folder = (relativePath: string) => ({
  isDirectory: true,
  relativePath,
  name: relativePath.split("/").pop()!,
});

describe("matchesFileMenuTarget", () => {
  it("admits everything when nothing is declared", () => {
    expect(matchesFileMenuTarget({}, file("a.ts"))).toBe(true);
    expect(matchesFileMenuTarget({}, folder("src"))).toBe(true);
  });

  it("matches on kind", () => {
    expect(matchesFileMenuTarget({ kind: "folder" }, folder("content"))).toBe(true);
    expect(matchesFileMenuTarget({ kind: "folder" }, file("a.ts"))).toBe(false);
    expect(matchesFileMenuTarget({ kind: "file" }, folder("content"))).toBe(false);
  });

  it("matches extensions case-insensitively and never on folders or dotfiles", () => {
    const item = { extensions: ["md"] };
    expect(matchesFileMenuTarget(item, file("docs/FOO.MD"))).toBe(true);
    expect(matchesFileMenuTarget(item, file("a.ts"))).toBe(false);
    expect(matchesFileMenuTarget(item, file("README"))).toBe(false);
    expect(matchesFileMenuTarget({ extensions: ["env"] }, file(".env"))).toBe(false);
    expect(matchesFileMenuTarget(item, folder("notes.md"))).toBe(false);
  });

  it("matches worktree-relative path globs on files and folders", () => {
    expect(matchesFileMenuTarget({ paths: ["content"] }, folder("content"))).toBe(true);
    expect(matchesFileMenuTarget({ paths: ["content/**"] }, file("content/a/b.md"))).toBe(true);
    expect(matchesFileMenuTarget({ paths: ["content/**"] }, file("src/b.md"))).toBe(false);
  });

  it("never matches a path glob against an absolute path outside a worktree", () => {
    expect(matchesFileMenuTarget({ paths: ["**"] }, file("/tmp/a.json"))).toBe(false);
    expect(matchesFileMenuTarget({ paths: ["**/*.json"] }, file("C:/tmp/a.json"))).toBe(false);
  });

  it("requires every declared field to hold", () => {
    const item = { kind: "file" as const, extensions: ["json"], paths: ["records/**"] };
    expect(matchesFileMenuTarget(item, file("records/a.json"))).toBe(true);
    expect(matchesFileMenuTarget(item, file("other/a.json"))).toBe(false);
    expect(matchesFileMenuTarget(item, file("records/a.txt"))).toBe(false);
  });
});
