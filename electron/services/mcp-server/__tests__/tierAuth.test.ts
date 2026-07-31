import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPaneConfigService } = vi.hoisted(() => ({
  mockPaneConfigService: {
    isValidPaneToken: vi.fn<(token: string) => boolean>(() => false),
    getTierForToken: vi.fn<(token: string) => "workbench" | "action" | "system" | undefined>(
      () => undefined
    ),
  },
}));

vi.mock("../../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: mockPaneConfigService,
}));

import {
  buildAnnotations,
  extractBearerToken,
  isAuthorized,
  isTierPermitted,
  parseToolArguments,
  precomputeApiKeyBearerHash,
  resolveTokenTier,
  shouldExposeTool,
} from "../tierAuth.js";
import { TIER_ALLOWLISTS } from "../shared.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

beforeEach(() => {
  mockPaneConfigService.isValidPaneToken.mockReset();
  mockPaneConfigService.getTierForToken.mockReset();
  mockPaneConfigService.isValidPaneToken.mockReturnValue(false);
  mockPaneConfigService.getTierForToken.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("extractBearerToken", () => {
  it("accepts a single space between scheme and token", () => {
    expect(extractBearerToken("Bearer foo")).toBe("foo");
  });

  it("accepts a TAB between scheme and token", () => {
    expect(extractBearerToken("Bearer\tfoo")).toBe("foo");
  });

  it("accepts a lowercase scheme", () => {
    expect(extractBearerToken("bearer foo")).toBe("foo");
  });

  it("rejects a header with no whitespace after the scheme", () => {
    expect(extractBearerToken("Bearerfoo")).toBeNull();
  });

  it("rejects an empty header", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("rejects a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic foo")).toBeNull();
  });

  it("rejects a header with only whitespace after the scheme", () => {
    expect(extractBearerToken("Bearer    ")).toBeNull();
  });

  it("collapses repeated whitespace and trims trailing whitespace", () => {
    expect(extractBearerToken("Bearer  \tfoo  ")).toBe("foo");
  });

  it("rejects a header with a CR/LF separator", () => {
    expect(extractBearerToken("Bearer\rfoo")).toBeNull();
    expect(extractBearerToken("Bearer\nfoo")).toBeNull();
  });
});

describe("precomputeApiKeyBearerHash", () => {
  it("returns null when the api key is null", () => {
    expect(precomputeApiKeyBearerHash(null)).toBeNull();
  });

  it("returns null when the api key is an empty string", () => {
    expect(precomputeApiKeyBearerHash("")).toBeNull();
  });

  it("produces a 32-byte SHA-256 digest of the full Bearer header", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(32);
  });

  it("is deterministic for the same input", () => {
    const a = precomputeApiKeyBearerHash("secret");
    const b = precomputeApiKeyBearerHash("secret");
    expect(a!.equals(b!)).toBe(true);
  });

  it("differs for different api keys", () => {
    const a = precomputeApiKeyBearerHash("alpha");
    const b = precomputeApiKeyBearerHash("beta");
    expect(a!.equals(b!)).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("authorizes a valid api-key Bearer header", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(isAuthorized("Bearer secret", hash, null)).toBe(true);
  });

  it("rejects a wrong api-key Bearer header", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(isAuthorized("Bearer wrong", hash, null)).toBe(false);
  });

  it("rejects a header with the wrong scheme", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(isAuthorized("Basic secret", hash, null)).toBe(false);
  });

  it("authorizes an empty header when no api key is set", () => {
    expect(isAuthorized("", null, null)).toBe(true);
  });

  it("authorizes a TAB-separated pane token", () => {
    mockPaneConfigService.isValidPaneToken.mockImplementation((t) => t === "pane-tok");
    expect(isAuthorized("Bearer\tpane-tok", null, null)).toBe(true);
  });

  it("authorizes a lowercase-scheme pane token", () => {
    mockPaneConfigService.isValidPaneToken.mockImplementation((t) => t === "pane-tok");
    expect(isAuthorized("bearer pane-tok", null, null)).toBe(true);
  });

  it("authorizes a TAB-separated help token", () => {
    const helpValidator = vi.fn<(t: string) => "workbench" | false>((t) =>
      t === "help-tok" ? "workbench" : false
    );
    expect(isAuthorized("Bearer\thelp-tok", null, helpValidator)).toBe(true);
    expect(helpValidator).toHaveBeenCalledWith("help-tok");
  });

  it("rejects an unknown Bearer token", () => {
    expect(isAuthorized("Bearer nope", null, null)).toBe(false);
  });

  it("rejects a TAB-separated api-key header (api-key match is exact, not parser-normalized)", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(isAuthorized("Bearer\tsecret", hash, null)).toBe(false);
  });

  it("does not throw when the cached api-key hash has an unexpected length", () => {
    const malformed = Buffer.from([1, 2, 3]);
    expect(() => isAuthorized("Bearer secret", malformed, null)).not.toThrow();
    expect(isAuthorized("Bearer secret", malformed, null)).toBe(false);
  });
});

describe("resolveTokenTier", () => {
  it("resolves a valid api-key header to external", () => {
    const hash = precomputeApiKeyBearerHash("secret");
    expect(resolveTokenTier("Bearer secret", hash, null)).toBe("external");
  });

  it("resolves an empty header with no api key to external", () => {
    expect(resolveTokenTier("", null, null)).toBe("external");
  });

  it("resolves a TAB-separated help token to its help tier (regression for #7129)", () => {
    const helpValidator = vi.fn<(t: string) => "system" | false>((t) =>
      t === "help-tok" ? "system" : false
    );
    expect(resolveTokenTier("Bearer\thelp-tok", null, helpValidator)).toBe("system");
  });

  it("resolves a lowercase-scheme pane token to its pane tier", () => {
    mockPaneConfigService.getTierForToken.mockImplementation((t) =>
      t === "pane-tok" ? "action" : undefined
    );
    expect(resolveTokenTier("bearer pane-tok", null, null)).toBe("action");
  });

  it("falls back to workbench when no parser matches", () => {
    expect(resolveTokenTier("Bearer unknown", null, null)).toBe("workbench");
  });

  it("falls back to workbench when the header has no whitespace after the scheme", () => {
    expect(resolveTokenTier("Bearerfoo", null, null)).toBe("workbench");
  });
});

describe("parseToolArguments", () => {
  it("passes through plain objects", () => {
    expect(parseToolArguments({ key: "value" })).toEqual({ args: { key: "value" } });
  });

  it("strips _meta from plain objects", () => {
    expect(parseToolArguments({ _meta: { hello: true }, action: "x" })).toEqual({
      args: { action: "x" },
    });
  });

  it("returns empty args when only _meta is present", () => {
    expect(parseToolArguments({ _meta: { hello: true } })).toEqual({ args: {} });
  });

  it("coerces undefined to empty args", () => {
    expect(parseToolArguments(undefined)).toEqual({ args: {} });
  });

  it("coerces null to empty args", () => {
    expect(parseToolArguments(null)).toEqual({ args: {} });
  });

  it("coerces arrays to empty args", () => {
    expect(parseToolArguments([1, 2, 3])).toEqual({ args: {} });
  });

  it("coerces strings to empty args", () => {
    expect(parseToolArguments("hello")).toEqual({ args: {} });
  });

  it("coerces numbers to empty args", () => {
    expect(parseToolArguments(42)).toEqual({ args: {} });
  });

  it("coerces booleans to empty args", () => {
    expect(parseToolArguments(true)).toEqual({ args: {} });
  });
});

import { deriveBand, BAND_OVERRIDES } from "../../../../shared/utils/actionRiskBand.js";

describe("deriveBand", () => {
  it("returns reversible for safe + non-open-world category", () => {
    expect(deriveBand({ danger: "safe", category: "git" })).toBe("reversible");
  });

  it("returns external-effect for safe + open-world category", () => {
    expect(deriveBand({ danger: "safe", category: "forge" })).toBe("external-effect");
  });

  it("returns destructive-local for confirm + non-open-world category", () => {
    expect(deriveBand({ danger: "confirm", category: "worktree" })).toBe("destructive-local");
  });

  it("returns destructive-network for confirm + open-world category", () => {
    expect(deriveBand({ danger: "confirm", category: "system" })).toBe("destructive-network");
  });

  it("applies explicit overrides from BAND_OVERRIDES", () => {
    expect(deriveBand({ id: "git.push", danger: "confirm", category: "git" })).toBe(
      "external-effect"
    );
    expect(
      deriveBand({ id: "copyTree.generateAndCopyFile", danger: "safe", category: "copyTree" })
    ).toBe("destructive-local");
  });

  it("returns reversible for restricted danger (degenerate input)", () => {
    expect(deriveBand({ danger: "restricted", category: "git" })).toBe("reversible");
  });

  it("returns external-effect for restricted + open-world category", () => {
    expect(deriveBand({ danger: "restricted", category: "forge" })).toBe("external-effect");
  });
});

describe("BAND_OVERRIDES invariant", () => {
  it("every override key maps to a non-reversible band", () => {
    for (const [id, band] of Object.entries(BAND_OVERRIDES)) {
      expect(band, `BAND_OVERRIDES["${id}"] must not be "reversible"`).not.toBe("reversible");
    }
  });

  it("every override key is a non-empty string", () => {
    for (const id of Object.keys(BAND_OVERRIDES)) {
      expect(id).toBeTruthy();
    }
  });
});

function makeEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "actions.list",
    name: "actions.list",
    title: "Test",
    description: "Test action",
    category: "introspection",
    kind: "query",
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    ...overrides,
  };
}

describe("shouldExposeTool", () => {
  it("exposes core entries when tier-permitted", () => {
    const entry = makeEntry({ id: "actions.list", mcpVisibility: "core" });
    expect(shouldExposeTool(entry, "workbench")).toBe(true);
  });

  it("excludes discoverable entries from tools/list", () => {
    const entry = makeEntry({ id: "actions.list", mcpVisibility: "discoverable" });
    expect(shouldExposeTool(entry, "workbench")).toBe(false);
  });

  it("excludes hidden entries from tools/list", () => {
    const entry = makeEntry({ id: "actions.list", mcpVisibility: "hidden" });
    expect(shouldExposeTool(entry, "workbench")).toBe(false);
  });

  it("exposes unclassified entries (no mcpVisibility) for back-compat", () => {
    const entry = makeEntry({ id: "actions.list" });
    expect(shouldExposeTool(entry, "workbench")).toBe(true);
  });

  it("still excludes core entries outside the tier allowlist (tier is the authority gate)", () => {
    const entry = makeEntry({ id: "git.push", mcpVisibility: "core" });
    expect(shouldExposeTool(entry, "workbench")).toBe(false);
    expect(shouldExposeTool(entry, "system")).toBe(true);
  });

  it("still excludes restricted-danger tools regardless of visibility", () => {
    const entry = makeEntry({ id: "actions.list", mcpVisibility: "core", danger: "restricted" });
    expect(shouldExposeTool(entry, "workbench")).toBe(false);
  });

  // The metadata filters are advertisement-only and layer on top of the tier
  // floor: an id the external tier *does* permit must still be withheld from
  // tools/list when its manifest entry opts out. Guards against a refactor that
  // reorders the gates so membership short-circuits the visibility checks.
  it.each(["hidden", "discoverable"] as const)(
    "withholds an external-allowlisted tool marked %s",
    (mcpVisibility) => {
      const entry = makeEntry({ id: "actions.search", mcpVisibility });
      expect(TIER_ALLOWLISTS.external.has(entry.id)).toBe(true);
      expect(shouldExposeTool(entry, "external")).toBe(false);
    }
  );

  it("withholds an external-allowlisted tool marked restricted", () => {
    const entry = makeEntry({ id: "actions.search", danger: "restricted" });
    expect(TIER_ALLOWLISTS.external.has(entry.id)).toBe(true);
    expect(shouldExposeTool(entry, "external")).toBe(false);
  });
});

// #10701 / #11537: the curated `MCP_TOOL_ALLOWLIST` is the ONLY tool surface an
// external (api-key) caller can reach — there is no opt-in that lifts the floor.
// `fullToolSurface` used to short-circuit both gates and trust the author-set
// `danger` field as the ceiling, which exposed 335 of 426 actions; it was later
// defanged into an empty-add-on union and removed entirely in #11537. Sensitive
// side-effecting actions absent from the allowlist must stay blocked, and the
// two gates must agree on *membership* across exposure (shouldExposeTool) and
// dispatch (isTierPermitted) — a divergence there would advertise a tool the
// dispatcher then rejects (#7155). They deliberately differ on the metadata
// filters, which withhold from tools/list without blocking dispatch.
describe("external tool surface invariants (#10701, #11537)", () => {
  const builtInIds = new Set<string>(BUILT_IN_ACTION_IDS);

  // Real, currently-shipping danger:"safe" actions with genuine side effects
  // (launch a URL/path in the OS, inject env vars, clone an arbitrary repo)
  // that are deliberately absent from the curated external allowlist.
  // fullToolSurface used to expose every one of these.
  const SENSITIVE_NON_ALLOWLISTED = [
    "system.openExternal",
    "system.openPath",
    "env.global.set",
    "project.cloneRepo",
  ];

  // Pin the sentinels to ground truth so the suite below is a real regression
  // guard, not "unknown strings aren't in a set": each must be an actual
  // built-in action that is genuinely outside the curated external allowlist.
  // If one is renamed or promoted into the allowlist, this fails loudly rather
  // than silently asserting nothing.
  it.each(SENSITIVE_NON_ALLOWLISTED)("%s is a real built-in action outside the allowlist", (id) => {
    expect(builtInIds.has(id)).toBe(true);
    expect(TIER_ALLOWLISTS.external.has(id)).toBe(false);
  });

  it.each(SENSITIVE_NON_ALLOWLISTED)(
    "does not expose sensitive non-allowlisted action %s to the external tier",
    (actionId) => {
      const entry = makeEntry({ id: actionId, danger: "safe" });
      expect(shouldExposeTool(entry, "external")).toBe(false);
    }
  );

  it.each(SENSITIVE_NON_ALLOWLISTED)(
    "does not permit dispatch of sensitive non-allowlisted action %s to the external tier",
    (actionId) => {
      expect(isTierPermitted("external", actionId)).toBe(false);
    }
  );

  it("exposure and dispatch gates agree for a sensitive non-allowlisted action", () => {
    const entry = makeEntry({ id: "system.openExternal", danger: "safe" });
    expect(shouldExposeTool(entry, "external")).toBe(
      isTierPermitted("external", "system.openExternal")
    );
  });

  it("still reaches curated-allowlist tools", () => {
    const entry = makeEntry({ id: "actions.list" });
    expect(shouldExposeTool(entry, "external")).toBe(true);
    expect(isTierPermitted("external", "actions.list")).toBe(true);
  });

  // Exact equality, both directions, over the whole action registry: no
  // built-in outside the curated allowlist may be advertised or dispatchable,
  // and none inside it may be withheld. The four sentinels above only sample
  // the complement — the historical bypass leaked 335 ids at once, so the
  // upper bound is the assertion that actually catches that class.
  it("reaches exactly the curated allowlist across every built-in action", () => {
    const exposed = BUILT_IN_ACTION_IDS.filter((id) =>
      shouldExposeTool(makeEntry({ id }), "external")
    );
    const permitted = BUILT_IN_ACTION_IDS.filter((id) => isTierPermitted("external", id));
    const expected = BUILT_IN_ACTION_IDS.filter((id) => TIER_ALLOWLISTS.external.has(id));

    expect(new Set(exposed)).toEqual(new Set(expected));
    expect(new Set(permitted)).toEqual(new Set(expected));
    // The allowlist must not have drifted into naming ids that no longer exist.
    expect(expected.length).toBe(TIER_ALLOWLISTS.external.size);
  });
});

// The two forge tool surfaces are curated by hand in separate files —
// WORKBENCH_TIER_TOOLS in shared/config/helpAssistantTierAllowlists.ts and
// MCP_TOOL_ALLOWLIST_ENTRIES here in mcp-server/shared.ts — with nothing
// linking them. Adding a read to only one has shipped a tool invisible to the
// other caller class before (#10696, #11545).
//
// The subset check below is one-directional by necessity: the two lists
// diverge deliberately in the other direction (external carries forge writes
// the workbench tier withholds, and `forge.validateToken` is external-only),
// so equality would be wrong. It catches the workbench-only direction — the
// one that has actually bitten — but says nothing about a tool absent from
// both, hence the per-tool sentinel that follows it.
describe("forge tool exposure across the two curated allowlists", () => {
  it("every forge tool at the workbench tier is also reachable externally", () => {
    const workbenchForgeTools = [...TIER_ALLOWLISTS.workbench].filter((id) =>
      id.startsWith("forge.")
    );

    // Guard the guard: an empty cohort would make this vacuously pass.
    expect(workbenchForgeTools.length).toBeGreaterThan(0);

    expect(workbenchForgeTools.filter((id) => !TIER_ALLOWLISTS.external.has(id))).toEqual([]);
  });

  // Sentinel for the read added in #11545. The subset invariant above still
  // passes if this id is dropped from both lists, which would silently undo
  // the feature — an agent could post a comment but not read the thread again.
  it("permits forge.listIssueComments at both the workbench and external tiers", () => {
    const entry = makeEntry({ id: "forge.listIssueComments", kind: "query", danger: "safe" });
    for (const tier of ["workbench", "external"] as const) {
      expect(isTierPermitted(tier, "forge.listIssueComments", false)).toBe(true);
      expect(shouldExposeTool(entry, tier, false)).toBe(true);
    }
  });
});

describe("buildAnnotations", () => {
  it("safe command → destructiveHint: false", () => {
    const entry = makeEntry({ kind: "command", danger: "safe" });
    expect(buildAnnotations(entry).destructiveHint).toBe(false);
  });

  it("confirm command → destructiveHint: true", () => {
    const entry = makeEntry({ kind: "command", danger: "confirm" });
    expect(buildAnnotations(entry).destructiveHint).toBe(true);
  });

  it("query → readOnlyHint: true, idempotentHint: true, destructiveHint: false", () => {
    const entry = makeEntry({ kind: "query", danger: "safe" });
    const annotations = buildAnnotations(entry);
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.idempotentHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
  });

  it("mcpAnnotations.destructiveHint: false overrides confirm default (??-guard regression)", () => {
    const entry = makeEntry({
      kind: "command",
      danger: "confirm",
      mcpAnnotations: { destructiveHint: false },
    });
    expect(buildAnnotations(entry).destructiveHint).toBe(false);
  });

  it("mcpAnnotations.destructiveHint: true overrides safe default", () => {
    const entry = makeEntry({
      kind: "command",
      danger: "safe",
      mcpAnnotations: { destructiveHint: true },
    });
    expect(buildAnnotations(entry).destructiveHint).toBe(true);
  });

  it("confirm query with no override → destructiveHint: true (danger-derived, not kind-derived)", () => {
    const entry = makeEntry({ kind: "query", danger: "confirm" });
    expect(buildAnnotations(entry).destructiveHint).toBe(true);
  });

  it("restricted entry bypassing upstream gate → destructiveHint: false (not confirm)", () => {
    const entry = makeEntry({ kind: "command", danger: "restricted" });
    expect(buildAnnotations(entry).destructiveHint).toBe(false);
  });
});

// Policy guard for the help-session MCP tiers (#10640). NOTE: the Daintree
// Assistant itself is now provisioned at the `system` tier (see
// HelpSessionService.doProvision — selecting it grants full capability), so the
// assertions below lock the `action` tier that still governs the Claude/Codex
// help OVERLAYS, plus the system/external boundaries the assistant relies on.
// The distinction is load-bearing: `action` leaves irreversible mutations
// (git.push, worktree.delete) TIER_NOT_PERMITTED so the overlays need a
// human-approved scoped grant, while `system` (the assistant) and `external`
// permit them subject only to the confirm gate. These assertions lock those
// invariants against allowlist drift (e.g. someone promoting git.push into the
// action tier). They test the runtime gate `isTierPermitted`, not the raw
// allowlist arrays, so they fail closed if the tier wiring itself regresses.
describe("help-session tier policy (#10640)", () => {
  // The conductor's working tool set — orchestration, terminal driving, branch
  // setup, recipes, and reads — all resolve under `action`.
  const ASSISTANT_REQUIRED_TOOLS = [
    "agent.launch",
    "agent.terminal",
    "agent.getState",
    "workflow.startWorkOnIssue",
    "terminal.new",
    "terminal.sendCommand",
    "terminal.getOutput",
    "terminal.getStatus",
    "terminal.waitUntilIdle",
    "terminal.waitUntilIdleBatch",
    "recipe.run",
    "worktree.createWithRecipe",
    "worktree.setActive",
    "worktree.list",
    "git.getProjectPulse",
    "files.search",
    "copyTree.generate",
  ];

  // Irreversible / shared-state mutations the conductor must NOT be able to
  // fire unattended at its default tier — they require explicit elevation.
  const HIGH_BLAST_RADIUS_TOOLS = [
    "git.commit",
    "git.push",
    "worktree.delete",
    "forge.assignIssue",
  ];

  it.each(ASSISTANT_REQUIRED_TOOLS)(
    "permits the assistant's required tool %s at the action tier",
    (toolId) => {
      expect(isTierPermitted("action", toolId)).toBe(true);
    }
  );

  it.each(HIGH_BLAST_RADIUS_TOOLS)(
    "withholds high-blast-radius tool %s at the action tier (requires a grant)",
    (toolId) => {
      expect(isTierPermitted("action", toolId)).toBe(false);
      // Sanity check: the tool exists in the model and IS reachable one tier up,
      // so the `false` above is a real tier boundary, not a typo'd action id.
      expect(isTierPermitted("system", toolId)).toBe(true);
    }
  );

  it("auto-permits those same mutations under the external tier — the default we are moving the assistant off of", () => {
    // Documents the security contrast that motivates pinning the assistant to
    // `action`: on `external` (the api-key fallback) these run subject only to
    // the confirm gate, with no tier floor in front of them.
    for (const toolId of ["git.push", "git.commit", "worktree.delete"]) {
      expect(isTierPermitted("external", toolId)).toBe(true);
    }
  });
});

// agent.listToolbar and agent.listAvailable are the narrow, read-only discovery
// surfaces for toolbar state and the effective launch registry. They must be reachable by every tier — including external
// api-key consumers and workbench help sessions — WITHOUT exposing the broad
// `agentSettings.get` (which leaks custom flags, dangerous args, global env, and
// presets). These assertions pin that exact boundary: the safe alternative is
// reachable everywhere the leaky one must stay walled off from external.
describe("narrow agent discovery tier reachability", () => {
  it.each(["agent.listToolbar", "agent.listAvailable"] as const)(
    "permits %s at every tier",
    (toolId) => {
      for (const tier of ["workbench", "action", "system", "external"] as const) {
        expect(isTierPermitted(tier, toolId)).toBe(true);
      }
    }
  );

  it("keeps the broad agentSettings.get off the external tier so the narrow alternative is the only external path", () => {
    expect(isTierPermitted("external", "agentSettings.get")).toBe(false);
    // Sanity check the contrast is real, not a typo'd id: agentSettings.get IS
    // reachable for the trusted in-app workbench session.
    expect(isTierPermitted("workbench", "agentSettings.get")).toBe(true);
  });
});
