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

  it("carries kind through as category (skill/app/plugin badged, command default)", () => {
    const items = toSlashAutocompleteItems(
      [
        make({ label: "/commit", trigger: "/", kind: "skill" }),
        make({ label: "/help", trigger: "/", kind: "command" }),
        make({ label: "/connect", trigger: "/", kind: "app" }),
        make({ label: "/gh", trigger: "/", kind: "plugin" }),
      ],
      ""
    );

    expect(items.find((i) => i.label === "/commit")?.category).toBe("skill");
    expect(items.find((i) => i.label === "/help")?.category).toBe("command");
    expect(items.find((i) => i.label === "/connect")?.category).toBe("app");
    expect(items.find((i) => i.label === "/gh")?.category).toBe("plugin");
  });

  it("treats a triggerless built-in fallback as a slash command", () => {
    const items = toSlashAutocompleteItems([make({ label: "/model" })], "");

    expect(items.map((i) => i.label)).toEqual(["/model"]);
    expect(items[0]?.category).toBe("command");
  });

  it("falls back to the label for insert text when no distinct token is supplied", () => {
    const items = toSlashAutocompleteItems([make({ label: "/diff", trigger: "/" })], "");
    expect(items[0]).toMatchObject({ label: "/diff", insertText: "/diff", key: "/diff" });
  });

  it("keeps a distinct insertText separate from the display label (never derives from it)", () => {
    const items = toSlashAutocompleteItems(
      [
        make({
          label: "Plugin Creator",
          insertText: "$plugin-creator",
          trigger: "/",
          kind: "plugin",
        }),
      ],
      ""
    );
    expect(items[0]).toMatchObject({
      label: "Plugin Creator",
      insertText: "$plugin-creator",
      category: "plugin",
    });
  });
});
