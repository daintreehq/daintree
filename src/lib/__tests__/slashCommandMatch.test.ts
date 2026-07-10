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

  it("tokenizes a space-separated label so each word matches at token tier", () => {
    // Without splitting on whitespace, "creator" matches "Plugin Creator" only as a
    // substring (rank 3) and would lose to the prefix match on "creatorx" (rank 1);
    // token-tier matching (rank 0) requires the whitespace split, so order proves it.
    const commands = [make({ label: "creatorx" }), make({ label: "Plugin Creator" })];
    expect(rankSlashCommands(commands, "creator").map((c) => c.label)).toEqual([
      "Plugin Creator",
      "creatorx",
    ]);
    expect(
      rankSlashCommands([make({ label: "Plugin Creator" })], "plugin").map((c) => c.label)
    ).toEqual(["Plugin Creator"]);
  });

  it("matches against the triggerless insert text when the label alone would not", () => {
    // Label "Ship It" shares nothing with "deploy" — only a distinct insertText matches.
    const deployItem = make({ label: "Ship It", insertText: "$deploy" });
    expect(rankSlashCommands([deployItem], "deploy").map((c) => c.label)).toEqual(["Ship It"]);

    const pluginCreator = make({ label: "Plugin Creator", insertText: "$plugin-creator" });
    expect(rankSlashCommands([pluginCreator], "plugin-creator").map((c) => c.label)).toEqual([
      "Plugin Creator",
    ]);
  });

  it("matches against every alias but never against kind/badge text", () => {
    const aliased = make({ label: "/deploy", aliases: ["ship", "release"] });
    for (const query of ["ship", "release"]) {
      expect(rankSlashCommands([aliased], query).map((c) => c.label)).toEqual(["/deploy"]);
    }

    // `kind: "plugin"` must not make the command matchable by "plugin".
    const kinded = make({ label: "/deploy", kind: "plugin" });
    expect(rankSlashCommands([kinded], "plugin")).toEqual([]);
  });

  it("strips a leading trigger from the query so ranking is trigger-neutral", () => {
    // Unprefixed candidate: only stripping the query's trigger can make it match,
    // so a pass proves each of /, $, @ is normalized off the query.
    const item = make({ label: "plugin" });
    for (const query of ["plugin", "/plugin", "$plugin", "@plugin"]) {
      expect(rankSlashCommands([item], query).map((c) => c.label)).toEqual(["plugin"]);
    }
  });

  it("strips only one leading trigger — a doubled prefix is not normalized twice", () => {
    const item = make({ label: "plugin" });
    expect(rankSlashCommands([item], "$plugin").map((c) => c.label)).toEqual(["plugin"]);
    // "$$plugin" normalizes to "$plugin" (one strip), which cannot match "plugin".
    expect(rankSlashCommands([item], "$$plugin")).toEqual([]);
  });

  it("returns commands in original order for an empty or trigger-only query", () => {
    const commands = [cmd("/zebra"), cmd("/alpha"), cmd("/mango")];
    for (const query of ["", "   ", "/", "$", "@"]) {
      expect(rankSlashCommands(commands, query).map((c) => c.label)).toEqual([
        "/zebra",
        "/alpha",
        "/mango",
      ]);
    }
  });
});
