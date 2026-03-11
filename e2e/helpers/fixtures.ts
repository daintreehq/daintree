import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execSync } from "child_process";

interface FixtureRepoOptions {
  name?: string;
  withFeatureBranch?: boolean;
  withMultipleFiles?: boolean;
  withImageFile?: boolean;
  withUncommittedChanges?: boolean;
}

function git(cmd: string, cwd: string) {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

export function createFixtureRepo(options: FixtureRepoOptions = {}): string {
  const {
    name = "test-project",
    withFeatureBranch = false,
    withMultipleFiles = false,
    withImageFile = false,
    withUncommittedChanges = false,
  } = options;

  const dir = mkdtempSync(path.join(tmpdir(), `canopy-e2e-${name}-`));

  git("init -b main", dir);
  git('config user.email "test@canopy.dev"', dir);
  git('config user.name "Canopy Test"', dir);

  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);

  if (withMultipleFiles) {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "index.ts"),
      'export const main = () => console.log("hello");\n'
    );
    writeFileSync(
      path.join(dir, "src", "utils.ts"),
      "export const add = (a: number, b: number) => a + b;\n"
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", private: true }, null, 2) + "\n"
    );
  }

  if (withImageFile) {
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    // 1x1 red PNG pixel (minimal valid PNG)
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64"
    );
    writeFileSync(path.join(dir, "assets", "logo.png"), pngBuffer);
  }

  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  if (withFeatureBranch) {
    git("branch feature/test-branch", dir);
    const worktreeDir = path.join(
      dir,
      "..",
      path.basename(dir) + "-worktrees",
      "feature-test-branch"
    );
    mkdirSync(path.dirname(worktreeDir), { recursive: true });
    git(`worktree add ${JSON.stringify(worktreeDir)} feature/test-branch`, dir);
    writeFileSync(path.join(worktreeDir, "CHANGELOG.md"), "# Changelog\n\n- Feature branch\n");
    git("add -A", worktreeDir);
    git('commit -m "add changelog"', worktreeDir);
  }

  if (withUncommittedChanges) {
    writeFileSync(path.join(dir, "uncommitted.txt"), "This file is not committed.\n");
  }

  return dir;
}

export function createFixtureRepos(count: number): string[] {
  const repos: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `project-${String.fromCharCode(65 + i)}`;
    repos.push(createFixtureRepo({ name }));
  }
  return repos;
}
