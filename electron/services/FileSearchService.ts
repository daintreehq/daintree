import * as fs from "fs/promises";
import * as path from "path";
import { simpleGit } from "simple-git";
import { Cache } from "../utils/cache.js";
import type { Dirent } from "fs";

interface FileListCacheEntry {
  files: string[];
}

const FILE_LIST_CACHE = new Cache<string, FileListCacheEntry>({
  maxSize: 30,
  defaultTTL: 30_000,
});

const MAX_RESULTS_DEFAULT = 50;
const MAX_QUERY_LENGTH = 256;
const MAX_FALLBACK_FILES = 20_000;

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  let normalized = trimmed;
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  return normalized.replace(/\/+/g, "/");
}

function scorePath(queryLower: string, file: string): number | null {
  if (queryLower.length === 0) return 0;

  const fileLower = file.toLowerCase();
  const normalizedQuery = queryLower.replace(/\/$/, "");
  const normalizedFile = fileLower.replace(/\/$/, "");
  const basename = normalizedFile.slice(normalizedFile.lastIndexOf("/") + 1);

  if (basename === normalizedQuery) return 0;
  if (normalizedFile === normalizedQuery) return 1;

  const basenameIdx = basename.indexOf(normalizedQuery);
  const fileIdx = normalizedFile.indexOf(normalizedQuery);

  if (basenameIdx === 0) return 10;
  if (fileIdx === 0) return 20;
  if (basenameIdx > 0) return 30 + basenameIdx;
  if (fileIdx > 0) return 50 + fileIdx;
  return null;
}

function pickTopMatches(files: string[], query: string, limit: number): string[] {
  const queryLower = normalizeQuery(query).toLowerCase();
  const effectiveLimit = clampInt(limit, 1, 100, MAX_RESULTS_DEFAULT);

  if (queryLower.length === 0) {
    return files
      .slice()
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, effectiveLimit);
  }

  const best: Array<{ file: string; score: number }> = [];
  let worstIdx = -1;
  let worstScore = -Infinity;

  for (const file of files) {
    const score = scorePath(queryLower, file);
    if (score === null) continue;

    if (best.length < effectiveLimit) {
      best.push({ file, score });
      if (score > worstScore) {
        worstScore = score;
        worstIdx = best.length - 1;
      }
      continue;
    }

    if (score >= worstScore) continue;
    best[worstIdx] = { file, score };

    worstScore = -Infinity;
    worstIdx = -1;
    for (let i = 0; i < best.length; i++) {
      if (best[i].score > worstScore) {
        worstScore = best[i].score;
        worstIdx = i;
      }
    }
  }

  best.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  return best.map((m) => m.file);
}

async function loadFilesFromDisk(cwd: string): Promise<string[]> {
  const queue: string[] = [cwd];
  const results: string[] = [];

  while (queue.length > 0 && results.length < MAX_FALLBACK_FILES) {
    const dir = queue.pop();
    if (!dir) break;

    let entries: Array<Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(cwd, absolute);
      const relativePosix = toPosixPath(relative);

      if (entry.isDirectory()) {
        results.push(`${relativePosix}/`);
        queue.push(absolute);
        if (results.length >= MAX_FALLBACK_FILES) break;
        continue;
      }

      if (!entry.isFile()) continue;
      results.push(relativePosix);
      if (results.length >= MAX_FALLBACK_FILES) break;
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

async function loadGitFiles(cwd: string): Promise<string[]> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    return [];
  }

  const gitRootRaw = (await git.revparse(["--show-toplevel"])).trim();
  const gitRoot = path.resolve(gitRootRaw);
  const relativeToRoot = toPosixPath(path.relative(gitRoot, cwd));
  const pathspec = relativeToRoot && relativeToRoot !== "." ? relativeToRoot : null;

  const args = ["ls-files", "--cached", "--others", "--exclude-standard"] as string[];
  if (pathspec) {
    args.push("--", pathspec);
  }

  const output = await simpleGit(gitRoot).raw(args);
  const prefix = pathspec ? `${pathspec.replace(/\/$/, "")}/` : "";

  const files = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p))
    .filter((p) => p.length > 0);

  const dirs = new Set<string>();
  for (const file of files) {
    let dir = file;
    while (true) {
      const slashIdx = dir.lastIndexOf("/");
      if (slashIdx === -1) break;
      dir = dir.slice(0, slashIdx);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }

  const dirPaths = Array.from(dirs).map((d) => `${d}/`);
  return [...files, ...dirPaths];
}

export class FileSearchService {
  async search(payload: { cwd: string; query: string; limit?: number }): Promise<string[]> {
    try {
      const resolvedCwd = path.resolve(payload.cwd);
      const limit = clampInt(payload.limit, 1, 100, MAX_RESULTS_DEFAULT);

      const cached = FILE_LIST_CACHE.get(resolvedCwd);
      const files =
        cached?.files ??
        (await (async () => {
          const loaded = await this.loadFileList(resolvedCwd);
          FILE_LIST_CACHE.set(resolvedCwd, { files: loaded });
          return loaded;
        })());

      return pickTopMatches(files, payload.query, limit);
    } catch {
      return [];
    }
  }

  private async loadFileList(cwd: string): Promise<string[]> {
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(cwd);
    } catch {
      return [];
    }

    if (!stats.isDirectory()) {
      return [];
    }

    try {
      const gitFiles = await loadGitFiles(cwd);
      if (gitFiles.length > 0) return gitFiles;
    } catch {
      // ignore; fall back to filesystem walk
    }

    return loadFilesFromDisk(cwd);
  }
}

export const fileSearchService = new FileSearchService();
