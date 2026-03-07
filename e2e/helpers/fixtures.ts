import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execSync } from "child_process";

interface FixtureRepoOptions {
  name?: string;
  withFeatureBranch?: boolean;
  withMultipleFiles?: boolean;
}

function git(cmd: string, cwd: string) {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

export function createFixtureRepo(options: FixtureRepoOptions = {}): string {
  const { name = "test-project", withFeatureBranch = false, withMultipleFiles = false } = options;

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

  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  if (withFeatureBranch) {
    git("checkout -b feature/test-branch", dir);
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n- Feature branch\n");
    git("add -A", dir);
    git('commit -m "add changelog"', dir);
    git("checkout main", dir);
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
