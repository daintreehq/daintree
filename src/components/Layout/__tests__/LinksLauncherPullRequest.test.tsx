import { describe, expect, it } from "vitest";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { checkRowLabel } from "@/components/Worktree/ReviewHub/prChecks";
import { launcherCheckRows } from "../LinksLauncherPullRequest";

const run = (overrides: Partial<ForgeCheckRun>): ForgeCheckRun => ({
  name: "build",
  status: "completed",
  conclusion: "failure",
  detailsUrl: "https://ci.example.com/build",
  ...overrides,
});

describe("launcherCheckRows", () => {
  it("keeps failing and running checks that have a safe page, failures first", () => {
    const rows = launcherCheckRows([
      run({ name: "e2e", status: "in_progress", conclusion: undefined }),
      run({ name: "lint", conclusion: "success" }),
      run({ name: "unit" }),
      run({ name: "docs", detailsUrl: undefined }),
      run({ name: "smoke", detailsUrl: "javascript:alert(1)" }),
      run({ name: "deploy", conclusion: "cancelled" }),
    ]);
    expect(rows.map((row) => [checkRowLabel(row), row.detailsUrl])).toEqual([
      ["unit", "https://ci.example.com/build"],
      ["e2e", "https://ci.example.com/build"],
    ]);
  });

  it("qualifies a name another workflow shares, even when that one passed", () => {
    const rows = launcherCheckRows([
      run({ name: "build", workflow: "Release", conclusion: "success" }),
      run({ name: "build", workflow: "CI" }),
    ]);
    expect(rows.map(checkRowLabel)).toEqual(["CI / build"]);
  });
});
