import { promises as fs } from "node:fs";
import { join, sep } from "node:path";
import type { ProjectFileReader, ProjectFsDirEntry, ProjectFsStat } from "../fs.js";

/**
 * Test-only. `host.fs` is the production reader; this exists so the fixture
 * trees under `__fixtures__/projects` can stand in for a real worktree without
 * the detection code ever importing `node:fs` itself.
 *
 * `node_modules` is stored as `__node_modules__` in the fixtures — the repo
 * gitignores `node_modules` everywhere, so a tracked fixture cannot use the
 * real name — and this reader translates the segment back on the way through.
 * That keeps the production lookup path literal (`<dir>/node_modules/<pkg>`),
 * which is the thing under test.
 */
export const FIXTURE_NODE_MODULES = "__node_modules__";

function translate(path: string): string {
  return path
    .split(sep)
    .map((segment) => (segment === "node_modules" ? FIXTURE_NODE_MODULES : segment))
    .join(sep);
}

export function createFixtureReader(): ProjectFileReader {
  return {
    async readFile(path: string): Promise<string> {
      return fs.readFile(translate(path), "utf8");
    },
    async readdir(path: string): Promise<ProjectFsDirEntry[]> {
      const entries = await fs.readdir(translate(path), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name === FIXTURE_NODE_MODULES ? "node_modules" : entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    async stat(path: string): Promise<ProjectFsStat> {
      const stats = await fs.stat(translate(path));
      return { isDirectory: stats.isDirectory(), isFile: stats.isFile() };
    },
  };
}

/** Absolute path of a fixture worktree root. */
export function fixtureWorktree(name: string): string {
  return join(import.meta.dirname, "..", "..", "..", "__fixtures__", "projects", name);
}

/**
 * An in-memory tree, for the cases a committed fixture cannot express — a
 * `dist/` the scan must skip (gitignored), or deliberately conflicting
 * lockfiles. Keys are absolute paths; a value is a file's contents.
 */
export function createMemoryReader(files: Record<string, string>): ProjectFileReader {
  const normalise = (path: string) => path.replace(/[\\/]+$/, "");
  const paths = Object.keys(files).map(normalise);

  const isFile = (path: string) => paths.includes(normalise(path));
  const isDirectory = (path: string) => {
    const prefix = `${normalise(path)}/`;
    return paths.some((candidate) => candidate.startsWith(prefix));
  };

  return {
    async readFile(path: string): Promise<string> {
      const content = files[normalise(path)];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async readdir(path: string): Promise<ProjectFsDirEntry[]> {
      const prefix = `${normalise(path)}/`;
      const names = new Set<string>();
      for (const candidate of paths) {
        if (!candidate.startsWith(prefix)) continue;
        const name = candidate.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...names].sort().map((name) => ({
        name,
        isDirectory: isDirectory(`${prefix}${name}`),
        isFile: isFile(`${prefix}${name}`),
      }));
    },
    async stat(path: string): Promise<ProjectFsStat> {
      if (isFile(path)) return { isDirectory: false, isFile: true };
      if (isDirectory(path)) return { isDirectory: true, isFile: false };
      throw new Error(`ENOENT: ${path}`);
    },
  };
}
