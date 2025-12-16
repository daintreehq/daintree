import { describe, expect, it } from "vitest";
import { rankSlashCommands } from "../slashCommandMatch";
import type { SlashCommand } from "@shared/types";

function cmd(label: string): SlashCommand {
  return {
    id: label,
    label,
    description: label,
    scope: "built-in",
    agentId: "claude",
  };
}

describe("rankSlashCommands", () => {
  it("prioritizes command-start matches over other matches", () => {
    const ranked = rankSlashCommands([cmd("/git:work-issue"), cmd("/workbench")], "/wo");
    expect(ranked.map((c) => c.label)).toEqual(["/workbench", "/git:work-issue"]);
  });

  it("prioritizes full-token matches over partial prefix matches", () => {
    const ranked = rankSlashCommands([cmd("/github:work-issue"), cmd("/worktree:remove")], "/work");
    expect(ranked.map((c) => c.label)).toEqual(["/github:work-issue", "/worktree:remove"]);
  });

  it("prioritizes colon-segment start matches over dash-subword matches", () => {
    const ranked = rankSlashCommands([cmd("/git:work-issue"), cmd("/git:issue-fix")], "/issue");
    expect(ranked.map((c) => c.label)).toEqual(["/git:issue-fix", "/git:work-issue"]);
  });

  it("matches dash-subwords before within-word substring matches", () => {
    const ranked = rankSlashCommands([cmd("/git:pre-fix"), cmd("/git:prefix")], "/fi");
    expect(ranked.map((c) => c.label)).toEqual(["/git:pre-fix", "/git:prefix"]);
  });

  it("matches deeper colon namespaces and prefers earlier colon segments", () => {
    const ranked = rankSlashCommands([cmd("/git:branch:list"), cmd("/tool:list")], "/list");
    expect(ranked.map((c) => c.label)).toEqual(["/tool:list", "/git:branch:list"]);
  });
});
