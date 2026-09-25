import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureOwnerOnlyDir, OWNER_RW_FILE_MODE } from "../../utils/fs.js";
import type { GitFactory } from "./gitOps.js";

const BUNDLE_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED = 32;

export interface BundleEntry {
  token: string;
  path: string;
  createdAt: number;
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function isBundleToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/**
 * Repository bundles in flight between hosts, in one owner-only folder. A
 * bundle is only ever named by a token minted here, so nothing outside can
 * point a clone or a delete at an arbitrary path. Entries expire after an
 * hour; anything left in the folder from an earlier run is swept.
 */
export class BundleStore {
  private readonly entries = new Map<string, BundleEntry>();
  private swept = false;

  constructor(
    private readonly dir: () => string,
    private readonly now: () => number = Date.now
  ) {}

  private async ready(): Promise<string> {
    const dir = this.dir();
    await ensureOwnerOnlyDir(dir);
    if (!this.swept) {
      this.swept = true;
      const names = await fs.readdir(dir).catch(() => []);
      await Promise.all(names.map((name) => fs.rm(path.join(dir, name), { force: true })));
    }
    await this.expire();
    return dir;
  }

  private async expire(): Promise<void> {
    const cutoff = this.now() - BUNDLE_TTL_MS;
    const ordered = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const [index, entry] of ordered.entries()) {
      if (entry.createdAt < cutoff || ordered.length - index > MAX_TRACKED) {
        await this.discard(entry.token);
      }
    }
  }

  /** `git bundle create --all` of the repository at `repoPath`: committed history only. */
  async create(git: GitFactory, repoPath: string): Promise<BundleEntry & { size: number }> {
    const dir = await this.ready();
    const token = newToken();
    const target = path.join(dir, `${token}.bundle`);
    const repo = await git.local(repoPath);
    try {
      await repo.raw(["bundle", "create", "--quiet", target, "--all"]);
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
    await fs.chmod(target, OWNER_RW_FILE_MODE).catch(() => {});
    const { size } = await fs.stat(target);
    const entry = { token, path: target, createdAt: this.now() };
    this.entries.set(token, entry);
    return { ...entry, size };
  }

  /** A fresh token and the private path an incoming bundle for it is written to. */
  async expect(): Promise<BundleEntry> {
    const dir = await this.ready();
    const token = newToken();
    const entry = { token, path: path.join(dir, `${token}.bundle`), createdAt: this.now() };
    this.entries.set(token, entry);
    return entry;
  }

  /** Take in a bundle already written to a private path here (a local hop). */
  async adopt(sourcePath: string): Promise<BundleEntry> {
    const entry = await this.expect();
    await fs.copyFile(sourcePath, entry.path);
    await fs.chmod(entry.path, OWNER_RW_FILE_MODE).catch(() => {});
    return entry;
  }

  get(token: string): BundleEntry | null {
    return isBundleToken(token) ? (this.entries.get(token) ?? null) : null;
  }

  async discard(token: string): Promise<void> {
    const entry = this.get(token);
    if (!entry) return;
    this.entries.delete(token);
    await fs.rm(entry.path, { force: true }).catch(() => {});
  }
}
