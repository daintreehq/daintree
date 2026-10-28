import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@/config/agents";
import type { CodexQuotaProfile } from "@shared/types/ipc/agentQuota";
import { codexProfileForPreset, formatCodexHeadroom } from "../restartOnPresetChoices";

const okProfile = (
  key: string,
  presetNames: string[],
  isDefault = false,
  usedPercents: number[] = [40],
  planType: string | null = "plus"
): CodexQuotaProfile => ({
  key,
  isDefault,
  presetNames,
  result: {
    status: "ok",
    fetchedAt: 0,
    planType,
    windows: usedPercents.map((usedPercent, index) => ({
      usedPercent,
      windowDurationMins: index === 0 ? 300 : 10080,
      resetsAt: null,
    })),
  },
});

const preset = (id: string, name: string, env?: Record<string, string>): AgentPreset =>
  ({ id, name, env }) as AgentPreset;

describe("codexProfileForPreset (#13746)", () => {
  const profiles = [okProfile("default", [], true), okProfile("work-home", ["Work"])];
  const global = new Set(["work", "plain"]);

  it("finds the profile that names the preset", () => {
    expect(
      codexProfileForPreset(preset("work", "Work", { CODEX_HOME: "/w" }), global, profiles)?.key
    ).toBe("work-home");
  });

  it("puts a preset with no home of its own on the default profile", () => {
    expect(codexProfileForPreset(preset("plain", "Plain"), global, profiles)?.key).toBe("default");
  });

  it("gives a preset whose home main didn't read no reading at all", () => {
    expect(
      codexProfileForPreset(preset("plain", "Plain", { codex_home: "/p" }), global, profiles)
    ).toBeUndefined();
  });

  it("never borrows a namesake's reading for a project or CCR preset", () => {
    expect(
      codexProfileForPreset(preset("project-work", "Work", { CODEX_HOME: "/x" }), global, profiles)
    ).toBeUndefined();
  });
});

describe("formatCodexHeadroom", () => {
  it("names the tightest window and the plan", () => {
    expect(formatCodexHeadroom(okProfile("k", [], false, [20, 82.4]))).toBe(
      "Weekly limit 82% used · plus"
    );
  });

  it("leaves the plan out when the reading has none", () => {
    expect(formatCodexHeadroom(okProfile("k", [], false, [55], null))).toBe(
      "5-hour limit 55% used"
    );
  });

  it("says nothing for an unavailable reading", () => {
    expect(
      formatCodexHeadroom({
        key: "k",
        isDefault: true,
        presetNames: [],
        result: { status: "unavailable", reason: "timeout", fetchedAt: 0 },
      })
    ).toBeUndefined();
  });
});
