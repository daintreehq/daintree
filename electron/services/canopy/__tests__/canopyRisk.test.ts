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
    ["git --git-dir=/repo/.git --work-tree=/repo reset --hard", "Discards uncommitted changes"],
    ["git --work-tree /repo checkout .", "Discards uncommitted changes"],
    ["git -C /repo push --force", "Overwrites the remote branch"],
    ["git push origin --delete main", "Overwrites the remote branch"],
    ["git push -d origin main", "Overwrites the remote branch"],
    ["git push origin :main", "Overwrites the remote branch"],
    ["git push origin +main", "Overwrites the remote branch"],
    ["git -c core.x=y clean -fd", "Deletes untracked files for good"],
    ["git --no-pager clean -xdf", "Deletes untracked files for good"],
    ["git clean --force -d", "Deletes untracked files for good"],
    ["git branch -Df old", "Deletes a branch with unmerged work"],
    ["git branch -d -f old", "Deletes a branch with unmerged work"],
    ["git branch -d --force old", "Deletes a branch with unmerged work"],
    ["git branch --delete --force old", "Deletes a branch with unmerged work"],
    ["git -C /repo branch -D old", "Deletes a branch with unmerged work"],
    ["Remove-Item -Recurse -Force build", "Deletes files for good"],
    ["Remove-Item build -Recurse", "Deletes files for good"],
    ["rd /s /q build", "Deletes files for good"],
    ["rmdir /s /q build", "Deletes files for good"],
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
    "git push origin feature:main",
    "git -C /repo reset --soft HEAD~1",
    "git -c core.x=y clean -n",
    "git clean --dry-run -d",
    "git branch -d merged-branch",
    "git branch --delete merged-branch",
    "git restore --staged src/a.ts",
    "git restore --staged .",
    "git checkout -b feature",
    "git checkout main",
    "git checkout -- src/a.ts",
    "Remove-Item notes.txt",
    "rd build",
    "rmdir /srv/old",
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

  it("looks at every quoted line, and ignores the ones that are missing", () => {
    expect(irreversibleReason(null, undefined, "", "git push --force")).toBe(
      "Overwrites the remote branch"
    );
    expect(irreversibleReason(null, undefined)).toBeNull();
  });
});
