import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execSync } from "child_process";

/**
 * Create a temporary git repository that can be opened as a Canopy project.
 * Works on CI (GitHub Actions) and locally.
 */
export function createFixtureRepo(name = "test-project"): string {
  const dir = mkdtempSync(path.join(tmpdir(), `canopy-e2e-${name}-`));

  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@canopy.dev"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Canopy Test"', { cwd: dir, stdio: "ignore" });

  // Create a minimal file and initial commit so the repo isn't empty
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "ignore" });

  return dir;
}
