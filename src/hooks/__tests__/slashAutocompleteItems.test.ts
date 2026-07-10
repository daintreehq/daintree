import { describe, expect, it } from "vitest";
import { toSlashAutocompleteItems } from "../slashAutocompleteItems";
import type { SlashCommand } from "@shared/types";

function make(partial: Partial<SlashCommand> & { label: string }): SlashCommand {
  return {
    id: partial.label,
    description: "",
    scope: "built-in",
    agentId: "codex",
    ...partial,
  };
}

describe("toSlashAutocompleteItems", () => {
  it("excludes non-slash triggers so $ capabilities never leak into the slash menu", () => {
    const commands = [
      make({ label: "/help", trigger: "/" }),
      make({ label: "$imagegen", trigger: "$", kind: "skill" }),
      make({ label: "/review", trigger: "/", kind: "command" }),
    ];

    const labels = toSlashAutocompleteItems(commands, "").map((i) => i.label);

    expect(labels).toContain("/help");
    expect(labels).toContain("/review");
    expect(labels).not.toContain("$imagegen");
  });

  it("carries kind through as category (skill badged, command default)", () => {
    const items = toSlashAutocompleteItems(
      [
        make({ label: "/commit", trigger: "/", kind: "skill" }),
        make({ label: "/help", trigger: "/", kind: "command" }),
      ],
      ""
    );

    expect(items.find((i) => i.label === "/commit")?.category).toBe("skill");
    expect(items.find((i) => i.label === "/help")?.category).toBe("command");
  });

  it("treats a triggerless built-in fallback as a slash command", () => {
    const items = toSlashAutocompleteItems([make({ label: "/model" })], "");

    expect(items.map((i) => i.label)).toEqual(["/model"]);
    expect(items[0]?.category).toBe("command");
  });

  it("uses the canonical label as the inserted value", () => {
    const items = toSlashAutocompleteItems([make({ label: "/diff", trigger: "/" })], "");
    expect(items[0]).toMatchObject({ label: "/diff", value: "/diff", key: "/diff" });
  });
});
