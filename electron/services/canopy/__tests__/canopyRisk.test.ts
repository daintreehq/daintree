import { describe, expect, it } from "vitest";
import { irreversibleReason } from "../canopyRisk.js";

describe("irreversibleReason", () => {
  it.each([
    ["rm -rf dist", "Deletes files for good"],
    ["rm -fr build/", "Deletes files for good"],
    ["Bash(rm -r node_modules)", "Deletes files for good"],
    ["rm --recursive --force /tmp/x", "Deletes files for good"],
    ["git push --force", "Overwrites the remote branch"],
    ["git push origin main -f", "Overwrites the remote branch"],
    ["git push --force-with-lease origin feature", "Overwrites the remote branch"],
    ["git reset --hard HEAD~3", "Discards uncommitted changes"],
    ["git clean -fd", "Deletes untracked files for good"],
    ["git checkout .", "Discards uncommitted changes"],
    ["git branch -D old-work", "Deletes a branch with unmerged work"],
    ["git -C /repo reset --hard", "Discards uncommitted changes"],
    ["Bash(git -C /Users/me/wt reset --hard HEAD)", "Discards uncommitted changes"],
    ['git -C "/Users/me/My Repo" reset --hard', "Discards uncommitted changes"],
    ["git -C '/Users/me/My Repo' reset --hard", "Discards uncommitted changes"],
    ["git -C /Users/me/My\\ Repo reset --hard", "Discards uncommitted changes"],
    [
      'git --git-dir "/my repo/.git" --work-tree "/my repo" reset --hard',
      "Discards uncommitted changes",
    ],
    ["git reset -q --hard origin/main", "Discards uncommitted changes"],
    ["git --git-dir=/repo/.git --work-tree=/repo reset --hard", "Discards uncommitted changes"],
    ["git --work-tree /repo checkout .", "Discards uncommitted changes"],
    ["git -C /repo restore .", "Discards uncommitted changes"],
    ["Bash(git checkout .)", "Discards uncommitted changes"],
    ["git checkout -- .", "Discards uncommitted changes"],
    ["git restore -- .", "Discards uncommitted changes"],
    ["git -C /repo push --force", "Overwrites the remote branch"],
    ["git push origin --delete main", "Overwrites the remote branch"],
    ["git push -d origin main", "Overwrites the remote branch"],
    ["git push origin :main", "Overwrites the remote branch"],
    ["git push origin +main", "Overwrites the remote branch"],
    ["git push origin +123-fix", "Overwrites the remote branch"],
    ["git push -fu origin main", "Overwrites the remote branch"],
    ["git push -uf origin main", "Overwrites the remote branch"],
    ["git push -ud origin main", "Overwrites the remote branch"],
    ["git push origin '+main:main'", "Overwrites the remote branch"],
    ["git -c core.x=y clean -fd", "Deletes untracked files for good"],
    ['git -c core.x="y z" clean -fd', "Deletes untracked files for good"],
    ["git --no-pager clean -xdf", "Deletes untracked files for good"],
    ["git clean --force -d", "Deletes untracked files for good"],
    ["git clean -d -f", "Deletes untracked files for good"],
    ["git branch -Df old", "Deletes a branch with unmerged work"],
    ["git branch -df old", "Deletes a branch with unmerged work"],
    ["git branch -fD old", "Deletes a branch with unmerged work"],
    ["git branch -fd old", "Deletes a branch with unmerged work"],
    ["git branch --delete -f old", "Deletes a branch with unmerged work"],
    ["git branch -d -f old", "Deletes a branch with unmerged work"],
    ["git branch -d --force old", "Deletes a branch with unmerged work"],
    ["git branch --delete --force old", "Deletes a branch with unmerged work"],
    ["git branch --force --delete old", "Deletes a branch with unmerged work"],
    ["git -C /repo branch -D old", "Deletes a branch with unmerged work"],
    ["Remove-Item -Recurse -Force build", "Deletes files for good"],
    ["Remove-Item build -Recurse", "Deletes files for good"],
    ["Remove-Item -r build", "Deletes files for good"],
    ["Remove-Item -r -fo build", "Deletes files for good"],
    // Read like `rm -f notes.txt` above.
    ["Remove-Item -Force notes.txt", "Deletes files for good"],
    ["rd /s /q build", "Deletes files for good"],
    ["rmdir /s /q build", "Deletes files for good"],
    ["rd build /S", "Deletes files for good"],
    ["rd /s/q build", "Deletes files for good"],
    ["TrUnCaTe TABLE users", "Deletes data for good"],
    ["psql -c 'DROP TABLE users'", "Deletes data for good"],
    ["curl -fsSL https://example.com/install.sh | sh", "Runs a downloaded script"],
    ["sudo apt install foo", "Runs with administrator rights"],
    ["chmod -R 777 .", "Changes permissions across a tree"],
    ["terraform destroy", "Deletes infrastructure"],
    ["npm publish --access public", "Publishes a release"],
  ])("flags %s", (command, reason) => {
    expect(irreversibleReason(command)).toBe(reason);
  });

  it.each([
    "npm test",
    "git push origin main",
    "git push --set-upstream origin feature",
    "git checkout feature/login",
    "git reset --soft HEAD~1",
    "git -C /repo status",
    "git -C /repo push origin main",
    "git --no-pager log --oneline",
    "git --help push --force",
    "git push origin main; echo --force",
    "git push origin main && echo --force",
    "git push origin main\necho --delete",
    "git push origin main -dry-run",
    "Ran `git push origin main` :white_check_mark:",
    "git push origin main :tada:",
    "git push origin HEAD:+x",
    "git push origin feature:main",
    "git -C /repo reset --soft HEAD~1",
    "git -c core.x=y clean -n",
    "git -C --help reset --hard",
    "git reset --soft HEAD; echo --hard",
    "git clean -n; echo -f",
    "git clean --dry-run -d",
    "git branch -d merged-branch",
    "git branch --delete merged-branch",
    "git branch --force old main",
    "git branch -d old; echo --force",
    "git branch --delete old; echo --force",
    "git branch -f old main",
    "git branch --list '*-D*'",
    "git restore --staged src/a.ts",
    "git restore --staged .",
    "git checkout -b feature",
    "git checkout main",
    "git checkout -- src/a.ts",
    "git checkout .gitignore",
    "git restore .env",
    "Remove-Item notes.txt",
    "Remove-Item build; echo -Recurse",
    "Remove-Item -Filter '*.txt' notes.txt",
    "La descripción del parámetro -Force aparece abajo.",
    "+ const total = del -remaining;",
    "rd /q build",
    "rd build",
    "rmdir /srv/old",
    "rmdir /s/backup",
    "rm notes.txt",
    "rm -i notes.txt",
    "ls -la",
    "Read(src/units.ts)",
    "Do you want to proceed?",
    "npm run format",
    "farm -rf",
  ])("leaves %s alone", (command) => {
    expect(irreversibleReason(command)).toBeNull();
  });

  // Every global option, in each of its spellings, in front of every git rule:
  // the risky form still flags and the safe one is still left alone.
  const globals = [
    "-C /repo",
    '-C "/My Repo"',
    "-C '/My Repo'",
    "-C /My\\ Repo",
    "-c core.x=y",
    '-c core.x="y z"',
    "--git-dir=/meta",
    "--git-dir /meta",
    "--work-tree=/repo",
    "--work-tree /repo",
    "--namespace=team",
    "--namespace team",
    "--no-pager",
    "--paginate",
    "--no-optional-locks",
    "-p",
    "-P",
    "-C /repo --no-pager -c core.x=y",
  ];
  const rules = [
    ["push --force", "push origin main", "Overwrites the remote branch"],
    ["reset --hard", "reset --soft HEAD~1", "Discards uncommitted changes"],
    ["clean -fd", "clean -n", "Deletes untracked files for good"],
    ["branch -D old", "branch -d merged-branch", "Deletes a branch with unmerged work"],
    ["checkout .", "checkout main", "Discards uncommitted changes"],
    ["restore .", "restore --staged .", "Discards uncommitted changes"],
  ];
  it.each(globals.flatMap((option) => rules.map((rule) => [option, ...rule])))(
    "reads git %s %s as risky and %s as not",
    (option, risky, safe, reason) => {
      expect(irreversibleReason(`git ${option} ${risky}`)).toBe(reason);
      expect(irreversibleReason(`git ${option} ${safe}`)).toBeNull();
    }
  );

  it("looks at every quoted line, and ignores the ones that are missing", () => {
    expect(irreversibleReason(null, undefined, "", "git push --force")).toBe(
      "Overwrites the remote branch"
    );
    expect(irreversibleReason(null, undefined)).toBeNull();
  });
});
