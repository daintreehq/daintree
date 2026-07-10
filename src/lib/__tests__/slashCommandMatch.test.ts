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

function make(partial: Partial<SlashCommand> & { label: string }): SlashCommand {
  return {
    id: partial.label,
    description: "",
    scope: "built-in",
    agentId: "claude",
    ...partial,
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

  it("matches a hyphenated label by each subword and by the whole token", () => {
    const item = make({ label: "neo-issue" });
    for (const query of ["neo", "issue", "neo-issue"]) {
      expect(rankSlashCommands([item], query).map((c) => c.label)).toEqual(["neo-issue"]);
    }
  });

  it("matches a space-separated label by each word", () => {
    const item = make({ label: "Plugin Creator", insertText: "$plugin-creator" });
    for (const query of ["plugin", "creator"]) {
      expect(rankSlashCommands([item], query).map((c) => c.label)).toEqual(["Plugin Creator"]);
    }
  });

  it("matches against the triggerless insert text", () => {
    const item = make({ label: "Plugin Creator", insertText: "$plugin-creator" });
    expect(rankSlashCommands([item], "plugin-creator").map((c) => c.label)).toEqual([
      "Plugin Creator",
    ]);
  });

  it("matches against aliases but never against badge/kind text", () => {
    const aliased = make({ label: "/deploy", aliases: ["ship", "release"] });
    expect(rankSlashCommands([aliased], "ship").map((c) => c.label)).toEqual(["/deploy"]);

    // `kind: "plugin"` must not make the command matchable by "plugin".
    const kinded = make({ label: "/deploy", kind: "plugin" });
    expect(rankSlashCommands([kinded], "plugin")).toEqual([]);
  });

  it("ranks identically regardless of the trigger prefix on the query", () => {
    const commands = [
      make({ label: "Plugin Creator", insertText: "$plugin-creator" }),
      cmd("/help"),
    ];
    const baseline = rankSlashCommands(commands, "plugin").map((c) => c.label);
    for (const query of ["/plugin", "$plugin", "@plugin"]) {
      expect(rankSlashCommands(commands, query).map((c) => c.label)).toEqual(baseline);
    }
    expect(baseline).toEqual(["Plugin Creator"]);
  });

  it("strips only one leading trigger — repeated prefixes are not normalized twice", () => {
    const item = make({ label: "Plugin Creator", insertText: "$plugin-creator" });
    // A single `$` matches; a doubled `$$` leaves a literal `$` that cannot match.
    expect(rankSlashCommands([item], "$plugin").map((c) => c.label)).toEqual(["Plugin Creator"]);
    expect(rankSlashCommands([item], "$$plugin")).toEqual([]);
  });
});
