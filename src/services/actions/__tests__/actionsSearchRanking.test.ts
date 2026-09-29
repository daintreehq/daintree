import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hintMocks = vi.hoisted(() => ({
  getState: vi.fn(() => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  getEffectiveCombo: vi.fn((_actionId: string): string | null => null),
  getDisplayCombo: vi.fn((_actionId: string): string => ""),
}));

vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("../../../store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.getEffectiveCombo,
    getDisplayCombo: hintMocks.getDisplayCombo,
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { z } from "zod";
import {
  HELP_ASSISTANT_TIERS,
  HELP_TIER_CUMULATIVE,
} from "@shared/config/helpAssistantTierAllowlists";
import { ACTIONS_SEARCH_MAX_LIMIT } from "@shared/config/mcpIntrospection";
import { ActionService, actionService } from "@/services/ActionService";
import type { ActionRegistry } from "../actionTypes";
import type { HelpAssistantTier } from "@shared/types";
import { createActionRegistry } from "./helpers/wireSurface";

/**
 * `actions.search` over the real built-in registry, read the way a help session
 * at each tool set receives it: the MCP server over-fetches the maximum page,
 * then drops what the set can't call. A session asked to launch agents once
 * spent several calls on focus and navigation actions before finding
 * `agent.launch`, so the assertion is on the first callable result, not on
 * scores.
 */

let registry: ActionRegistry;

beforeAll(async () => {
  registry = await createActionRegistry();
  const service = new ActionService();
  for (const factory of registry.values()) {
    const definition = factory();
    if (service.has(definition.id)) continue;
    service.register(definition);
  }
  const manifest = service.list({}, { includeSchemas: false });
  vi.spyOn(actionService, "list").mockReturnValue(manifest);
});

afterAll(() => {
  vi.restoreAllMocks();
});

const SearchResultSchema = z.object({ results: z.array(z.object({ id: z.string() })) });

async function firstCallable(query: string, tier: HelpAssistantTier): Promise<string | undefined> {
  const search = registry.get("actions.search")!();
  const result: unknown = await search.run({ query, limit: ACTIONS_SEARCH_MAX_LIMIT }, {});
  const { results } = SearchResultSchema.parse(result);
  const callable = new Set<string>(HELP_TIER_CUMULATIVE[tier]);
  return results.find((entry) => callable.has(entry.id))?.id;
}

// Controls: the launch synonyms must not pull agent.launch ahead of the
// action a query actually names — "agent" in particular is a word most
// agent-facing queries share, and the "agents" keyword contains it. "start
// dev server" pins that a keyword which only restates a title ("Toggle Dev
// Server Dashboard") isn't counted twice.
const CONTROLS: Array<[query: string, expected: string]> = [
  ["restart agent", "terminal.restart"],
  ["close terminal", "terminal.close"],
  ["terminal status", "terminal.getStatus"],
  ["list worktrees", "worktree.list"],
  ["new terminal", "terminal.new"],
  ["run check", "project.runCheck"],
  ["interrupt agent", "terminal.interruptOwned"],
  ["agent output", "terminal.getOutput"],
  ["agent state", "terminal.getStatus"],
  ["agent history", "agentSessionHistory.resume"],
  ["start dev server", "devPreview.restart"],
];

describe("actions.search ranking over the real registry", () => {
  // The smaller set has fewer competitors, the larger one more near-misses —
  // "start agent" meets `terminal.restart` only at `full` — so both are read.
  describe.each(HELP_ASSISTANT_TIERS)("at the %s tool set", (tier) => {
    it.each([
      "spawn agent",
      "spawn agents",
      "spawn 5 agents",
      "launch agent",
      "launch agents",
      "start an agent",
      "start agent",
      "new agent",
      "launch codex",
      "run codex on a task",
      "run codex on task",
    ])("puts agent.launch first for %j", async (query) => {
      expect(await firstCallable(query, tier)).toBe("agent.launch");
    });

    // Each control is read at every set that can call its answer.
    const controls = CONTROLS.filter(([, expected]) =>
      HELP_TIER_CUMULATIVE[tier].includes(expected)
    );
    it.each(controls)("keeps %j on %s", async (query, expected) => {
      expect(await firstCallable(query, tier)).toBe(expected);
    });
  });

  it("reads every control at some tool set", () => {
    const readable = CONTROLS.filter(([, expected]) =>
      HELP_ASSISTANT_TIERS.some((tier) => HELP_TIER_CUMULATIVE[tier].includes(expected))
    );
    expect(readable).toEqual(CONTROLS);
  });
});
