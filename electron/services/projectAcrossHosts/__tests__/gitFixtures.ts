import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { GitFactory } from "../gitOps.js";

const GLOBAL_CONFIG = path.join(
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pah-gitconfig-"))),
  "gitconfig"
);
fs.writeFileSync(GLOBAL_CONFIG, "");

/**
 * Real git, isolated from the developer's own config. No network: every
 * remote URL a test uses is rewritten (`insteadOf`) to a local bare repo.
 */
export const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: GLOBAL_CONFIG,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  LC_ALL: "C",
};

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export const testGit: GitFactory = {
  local: async (cwd) => simpleGit(cwd, { unsafe: { allowUnsafeConfigPaths: true } }).env(GIT_ENV),
  network: async (cwd) => simpleGit(cwd, { unsafe: { allowUnsafeConfigPaths: true } }).env(GIT_ENV),
};

export function tempRoot(prefix = "pah-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeBare(root: string, name: string): string {
  const dir = path.join(root, `${name}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--bare", "-q", "-b", "main"]);
  return dir;
}

/** A repo with one commit on `main`, optionally with `origin` pointing at `originUrl`. */
export function makeRepo(root: string, name: string, originUrl?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  commit(dir, "init");
  if (originUrl) git(dir, ["remote", "add", "origin", originUrl]);
  return dir;
}

let counter = 0;
export function commit(dir: string, message: string): string {
  fs.writeFileSync(path.join(dir, `f${++counter}.txt`), message);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Make `url` (a forge-looking remote) resolve to the local bare repo `bare`. */
export function aliasRemote(url: string, bare: string): void {
  fs.appendFileSync(GLOBAL_CONFIG, `[url "${bare}"]\n\tinsteadOf = ${url}\n`);
}
