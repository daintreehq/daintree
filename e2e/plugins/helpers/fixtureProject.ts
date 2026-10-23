import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createFixtureRepo, type FixtureRepo } from "../../helpers/fixtures";

export interface FixtureProjectOptions {
  /** False for a site with no dependencies to install. */
  install?: boolean;
  installTimeoutMs?: number;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;

/** The 1-based line `needle` first appears on, so an expected location can't drift from its file. */
export function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index === -1) throw new Error(`fixture source does not contain ${JSON.stringify(needle)}`);
  return source.slice(0, index).split("\n").length;
}

/** `package.json` for a fixture site, its direct dependencies pinned exactly. */
export function packageJson(
  name: string,
  scripts: Record<string, string>,
  devDependencies: Readonly<Record<string, string>> = {}
): string {
  return (
    JSON.stringify(
      { name, private: true, version: "0.0.1", type: "module", scripts, devDependencies },
      null,
      2
    ) + "\n"
  );
}

/**
 * A throwaway git repo holding `files`, with its dependencies installed from
 * the registry. Fixtures pin their direct dependencies exactly and check in no
 * lockfile, because one would pin a platform's optional binaries to whichever
 * machine generated it. Needs network on a cold npm cache; later runs are
 * served from it.
 */
export function createFixtureProject(
  name: string,
  files: Readonly<Record<string, string>>,
  options: FixtureProjectOptions = {}
): FixtureRepo {
  const repo = createFixtureRepo({ name });
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(repo.dir, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }

    if (options.install !== false) {
      const timeout = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
      const install = (freshness: string) =>
        npm(
          repo.dir,
          ["install", "--no-audit", "--no-fund", freshness, "--loglevel=error"],
          timeout
        );
      try {
        install("--prefer-offline");
      } catch (error) {
        // A cached packument older than a release some dependency now asks
        // for: --prefer-offline trusts it and reports the version missing.
        if (!String((error as { stderr?: unknown }).stderr ?? "").includes("ETARGET")) throw error;
        install("--prefer-online");
      }
    }

    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, stdio: "pipe" });
    git("add", "-A");
    git("commit", "-m", `${name} fixture`, "--no-gpg-sign");
    return repo;
  } catch (error) {
    repo.cleanup();
    throw error;
  }
}

/**
 * Run one of a fixture's package scripts to completion — a production build,
 * made before the preview starts so serving it doesn't spend the preview's
 * readiness budget on a compile.
 */
export function runPackageScript(dir: string, script: string, timeoutMs = 5 * 60_000): void {
  npm(dir, ["run", script, "--silent"], timeoutMs);
}

function npm(cwd: string, args: string[], timeout: number): void {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    stdio: "pipe",
    timeout,
    shell: process.platform === "win32",
  });
}
