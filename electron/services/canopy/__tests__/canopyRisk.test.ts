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
