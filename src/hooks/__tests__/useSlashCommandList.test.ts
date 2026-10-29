import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@shared/types";
import { buildSlashCommandMap } from "../useSlashCommandList";

function make(partial: Partial<SlashCommand> & { label: string }): SlashCommand {
  return {
    id: partial.label,
    description: "",
    scope: "built-in",
    agentId: "antigravity",
    ...partial,
  };
}

describe("buildSlashCommandMap", () => {
  it("resolves a typed alias to its command", () => {
    const usage = make({ label: "/usage", aliases: ["quota"] });
    const map = buildSlashCommandMap([usage]);
    expect(map.get("/usage")).toBe(usage);
    expect(map.get("/quota")).toBe(usage);
  });

  it("never lets an alias take a real command's token, whatever the order", () => {
    const clear = make({ label: "/clear", aliases: ["new"] });
    const realNew = make({ label: "/new" });
    for (const commands of [
      [clear, realNew],
      [realNew, clear],
    ]) {
      expect(buildSlashCommandMap(commands).get("/new")).toBe(realNew);
    }
  });

  it("keys by insert text and leaves non-slash triggers out, aliases included", () => {
    const skill = make({ label: "Plugin Creator", insertText: "/plugin-creator" });
    const dollar = make({ label: "$github", trigger: "$", aliases: ["gh"] });
    const map = buildSlashCommandMap([skill, dollar]);
    expect([...map.keys()]).toEqual(["/plugin-creator"]);
  });
});
