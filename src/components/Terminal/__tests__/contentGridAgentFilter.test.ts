import { describe, expect, it } from "vitest";
import type { CliAvailability } from "@shared/types";
import { computeGridCanLaunch, computeGridSelectedAgentIds } from "../contentGridAgentFilter";

const AGENT_IDS = ["claude", "gemini", "codex", "terminal"] as const;

function availability(overrides: Partial<Record<string, string>>): CliAvailability {
  return {
    claude: "missing",
    gemini: "missing",
    codex: "missing",
    terminal: "missing",
    ...overrides,
  } as unknown as CliAvailability;
}

describe("computeGridSelectedAgentIds (issue #5117 loading-guard regression)", () => {
  it("returns undefined (show all) while availability is not yet probed", () => {
    // `agentAvailability` prop is always a truthy object in production because the store
    // pre-populates it with `defaultAvailability()`. The real loading signal is the
    // store's `isInitialized` flag. If the guard gated on only `agentAvailability`, the
    // grid's context menu would start empty on cold boot — this test locks that out.
    const pre = computeGridSelectedAgentIds(false, availability({}), AGENT_IDS);
    expect(pre).toBeUndefined();
  });

  it("returns undefined when agentAvailability is legitimately undefined", () => {
    expect(computeGridSelectedAgentIds(true, undefined, AGENT_IDS)).toBeUndefined();
  });

  it("filters to installed agents once availability is initialized", () => {
    const result = computeGridSelectedAgentIds(
      true,
      availability({ claude: "ready", gemini: "installed", codex: "missing" }),
      AGENT_IDS
    );
    expect(result).toBeDefined();
    expect(result!.has("claude")).toBe(true); // ready → installed
    expect(result!.has("gemini")).toBe(true); // installed
    expect(result!.has("codex")).toBe(false); // missing
    expect(result!.has("terminal")).toBe(false); // terminal is not an agent; still missing
  });

  it("does not use pin state — unpinned installed agents are included (issue #5117)", () => {
    // The helper takes only availability + agent IDs. Pin state is irrelevant by
    // construction; this test locks the contract against future regressions.
    const result = computeGridSelectedAgentIds(
      true,
      availability({ claude: "ready", gemini: "ready" }),
      ["claude", "gemini"]
    );
    expect(result).toEqual(new Set(["claude", "gemini"]));
  });
});

describe("computeGridCanLaunch", () => {
  it("always returns true for the 'terminal' id regardless of state", () => {
    expect(computeGridCanLaunch("terminal", false, undefined)).toBe(true);
    expect(computeGridCanLaunch("terminal", true, availability({}))).toBe(true);
  });

  it("returns true for any agent before the first probe lands (show-all contract)", () => {
    expect(computeGridCanLaunch("claude", false, availability({}))).toBe(true);
    expect(computeGridCanLaunch("claude", true, undefined)).toBe(true);
  });

  it("returns true only when agent is `ready` once availability is known", () => {
    const ready = availability({ claude: "ready", gemini: "installed", codex: "missing" });
    expect(computeGridCanLaunch("claude", true, ready)).toBe(true);
    // installed-but-not-ready: menu entry visible but launch disabled.
    expect(computeGridCanLaunch("gemini", true, ready)).toBe(false);
    expect(computeGridCanLaunch("codex", true, ready)).toBe(false);
  });
});
