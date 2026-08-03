import { describe, expect, it } from "vitest";
import {
  PROCESS_TOOL_ICON_BY_COMMAND,
  PROCESS_TOOL_REGISTRY,
  getProcessToolConfig,
  getProcessToolPriority,
} from "../processToolRegistry.js";

const entries = Object.entries(PROCESS_TOOL_REGISTRY);

describe("PROCESS_TOOL_REGISTRY", () => {
  it("resolves every declared command back to the entry that declared it", () => {
    for (const [iconId, config] of entries) {
      for (const command of config.commands) {
        expect(PROCESS_TOOL_ICON_BY_COMMAND[command], `${command} → ${iconId}`).toBe(iconId);
      }
    }
  });

  it("claims each command exactly once", () => {
    // A duplicate alias resolves last-wins at runtime, so the losing entry
    // becomes unreachable without any error.
    const owners = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [iconId, config] of entries) {
      for (const command of config.commands) {
        const owner = owners.get(command);
        if (owner !== undefined) duplicates.push(`${command}: ${owner} vs ${iconId}`);
        else owners.set(command, iconId);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("exposes no command the registry does not declare", () => {
    const declared = new Set(entries.flatMap(([, config]) => config.commands));
    expect(Object.keys(PROCESS_TOOL_ICON_BY_COMMAND).sort()).toEqual([...declared].sort());
  });

  it("gives every entry a non-empty label and at least one command", () => {
    for (const [iconId, config] of entries) {
      expect(config.label.trim(), `${iconId} label`).not.toBe("");
      expect(config.commands.length, `${iconId} commands`).toBeGreaterThan(0);
    }
  });

  it("keeps keys and commands lowercase so lookups can normalize by case alone", () => {
    for (const [iconId, config] of entries) {
      expect(iconId).toBe(iconId.toLowerCase());
      for (const command of config.commands) {
        expect(command).toBe(command.toLowerCase());
      }
    }
  });
});

describe("getProcessToolConfig", () => {
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "treats the inherited key %s as unregistered",
    (iconId) => {
      expect(getProcessToolConfig(iconId)).toBeUndefined();
    }
  );

  it("returns undefined for an unknown id and for no id", () => {
    expect(getProcessToolConfig("not-a-real-tool")).toBeUndefined();
    expect(getProcessToolConfig(null)).toBeUndefined();
    expect(getProcessToolConfig(undefined)).toBeUndefined();
    expect(getProcessToolConfig("")).toBeUndefined();
  });
});

describe("getProcessToolPriority", () => {
  it("ranks tools above runtimes above package managers", () => {
    // The ordering is the whole point of the tier field: it is what makes a
    // deeper `vite` outrank the `npm` that spawned it.
    const rankOf = (tier: string) => {
      const match = entries.find(([, config]) => config.tier === tier);
      expect(match, `no entry with tier ${tier}`).toBeDefined();
      return getProcessToolPriority(match![0]);
    };
    expect(rankOf("tool")).toBeLessThan(rankOf("runtime"));
    expect(rankOf("runtime")).toBeLessThan(rankOf("package-manager"));
  });

  it("ranks every package manager below every runtime and tool", () => {
    const worstNonPackageManager = Math.max(
      ...entries
        .filter(([, config]) => config.tier !== "package-manager")
        .map(([iconId]) => getProcessToolPriority(iconId))
    );
    for (const [iconId, config] of entries) {
      if (config.tier !== "package-manager") continue;
      expect(getProcessToolPriority(iconId), iconId).toBeGreaterThan(worstNonPackageManager);
    }
  });

  it("ranks an unregistered id alongside ordinary tools", () => {
    // Plugin-contributed icon ids name something specific, so they must not
    // lose to a package manager.
    const toolEntry = entries.find(([, config]) => config.tier === "tool")!;
    expect(getProcessToolPriority("some-plugin-icon")).toBe(getProcessToolPriority(toolEntry[0]));
  });
});
