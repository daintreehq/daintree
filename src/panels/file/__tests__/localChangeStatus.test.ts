import { describe, expect, it } from "vitest";
import type { FileChangeDetail, GitStatus } from "@shared/types/git";
import { lookupLocalChangeStatus } from "../localChangeStatus";

function change(path: string, status: GitStatus): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

describe("lookupLocalChangeStatus", () => {
  it("matches absolute and relative stored paths against the relative file path", () => {
    const changes = [change("/repo/src/a.ts", "modified"), change("docs/b.md", "added")];
    expect(lookupLocalChangeStatus(changes, "/repo", "src/a.ts")).toBe("modified");
    expect(lookupLocalChangeStatus(changes, "/repo", "docs/b.md")).toBe("added");
    expect(lookupLocalChangeStatus(changes, "/repo", "src/missing.ts")).toBeUndefined();
  });

  it("keeps the first entry for a path, as a linear find would", () => {
    const changes = [change("/repo/a.ts", "deleted"), change("a.ts", "added")];
    expect(lookupLocalChangeStatus(changes, "/repo", "a.ts")).toBe("deleted");
  });

  it("folds separators and trailing slashes the way the scan did", () => {
    const changes = [change("C:\\repo\\src\\a.ts", "modified")];
    expect(lookupLocalChangeStatus(changes, "C:\\repo\\", "src/a.ts")).toBe("modified");
  });

  it("returns undefined without a change list", () => {
    expect(lookupLocalChangeStatus(undefined, "/repo", "a.ts")).toBeUndefined();
  });

  it("re-indexes when the same list is read against a different root", () => {
    const changes = [change("/repo/nested/a.ts", "modified")];
    expect(lookupLocalChangeStatus(changes, "/repo", "nested/a.ts")).toBe("modified");
    expect(lookupLocalChangeStatus(changes, "/repo/nested", "a.ts")).toBe("modified");
    expect(lookupLocalChangeStatus(changes, "/repo/nested", "nested/a.ts")).toBeUndefined();
  });

  it("sees a new status once the host replaces the list", () => {
    const first = [change("/repo/a.ts", "modified")];
    expect(lookupLocalChangeStatus(first, "/repo", "a.ts")).toBe("modified");
    const second = [change("/repo/a.ts", "added")];
    expect(lookupLocalChangeStatus(second, "/repo", "a.ts")).toBe("added");
  });
});
