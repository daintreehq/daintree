import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { createFixtureRepo, type FixtureRepo } from "../../helpers/fixtures";
import { REFERENCE_APP_ID, REFERENCE_APP_SOURCE } from "../../helpers/referenceAppLifecycle";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_DIR = path.join(REPO_ROOT, ...REFERENCE_APP_SOURCE.split("/"));
/** Local build and preview output, never part of what a project ships. */
const SKIPPED = new Set(["node_modules", "test-results", "playwright-report", ".tour-preview"]);

/**
 * A git repository holding the committed Request Desk reference app at
 * `.daintree/plugins/acme.requests/`, copied as a project would carry it —
 * `dist/` included, since that is what Daintree loads — and a
 * `.daintree/mcp.json` that gives agents read and write access to it.
 */
export function createReferenceAppProject(name: string): FixtureRepo {
  if (!existsSync(path.join(SOURCE_DIR, "dist", "index.js"))) {
    throw new Error(`${REFERENCE_APP_SOURCE}/dist is missing: the reference app cannot load`);
  }
  const repo = createFixtureRepo({ name });
  try {
    const target = path.join(repo.dir, ".daintree", "plugins", REFERENCE_APP_ID);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(SOURCE_DIR, target, {
      recursive: true,
      filter: (src) => !SKIPPED.has(path.basename(src)),
    });
    writeFileSync(
      path.join(repo.dir, ".daintree", "mcp.json"),
      JSON.stringify({ plugins: { [REFERENCE_APP_ID]: "read-write" } }, null, 2) + "\n"
    );
    execFileSync("git", ["add", "-A"], { cwd: repo.dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", "Add Request Desk", "--no-gpg-sign"], {
      cwd: repo.dir,
      stdio: "pipe",
    });
    return repo;
  } catch (error) {
    repo.cleanup();
    throw error;
  }
}

/** The app's machine-local data (the operation journal) for one project, under `homeDir`. */
export function removeReferenceAppData(
  projectId: string | null | undefined,
  homeDir: string = os.homedir()
): void {
  if (!projectId || !/^[0-9a-f]{64}$/.test(projectId)) return;
  rmSync(
    path.join(homeDir, ".daintree", "plugin-data", `project__${projectId}__${REFERENCE_APP_ID}`),
    { recursive: true, force: true }
  );
}
