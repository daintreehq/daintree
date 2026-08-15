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
  filterIntrospectionResultForSession,
  getTierPermittedActionIds,
  isAuthorized,
  isTierPermitted,
  parseToolArguments,
  precomputeApiKeyBearerHash,
  readSearchLimit,
  resolveTokenTier,
  shouldExposeTool,
  isWithheldFromBoundSession,
  UNBOUND_SESSION_SURFACE,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
  INTROSPECTION_TOOL_IDS,
} from "../tierAuth.js";
import { TIER_ALLOWLISTS } from "../shared.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../../../../shared/config/mcpExternalTierAllowlist.js";
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

  // The metadata ceilings layer on top of the tier floor: an id the external
  // tier *does* permit must still be withheld from tools/list when its manifest
  // entry opts out. Guards against a refactor that reorders the gates so
  // membership short-circuits the visibility check.
  it("withholds an external-allowlisted tool marked hidden", () => {
    const entry = makeEntry({ id: "actions.search", mcpVisibility: "hidden" });
    expect(TIER_ALLOWLISTS.external.has(entry.id)).toBe(true);
    expect(shouldExposeTool(entry, "external")).toBe(false);
  });

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

  // The clipboard bundle is the one CopyTree tool an external agent gets: it
  // can read files for itself, but only Daintree can write the user's system
  // clipboard. Its siblings stay off the surface, so this pins the membership
  // rather than the whole namespace (#11722).
  it("exposes the curated clipboard bundle to the external tier", () => {
    expect(builtInIds.has("copyTree.generateAndCopyFile")).toBe(true);
    expect(isTierPermitted("external", "copyTree.generateAndCopyFile")).toBe(true);
    expect(shouldExposeTool(makeEntry({ id: "copyTree.generateAndCopyFile" }), "external")).toBe(
      true
    );
  });

  it("keeps every other copyTree tool off the external surface", () => {
    // Derived from the registry rather than listed by hand: a hardcoded list
    // silently stops covering any copyTree tool added later, which is exactly
    // when this guard matters.
    const others = [...BUILT_IN_ACTION_IDS].filter(
      (id) => id.startsWith("copyTree.") && id !== "copyTree.generateAndCopyFile"
    );

    expect(others.length).toBeGreaterThan(0);
    for (const id of others) {
      expect(isTierPermitted("external", id)).toBe(false);
      expect(shouldExposeTool(makeEntry({ id }), "external")).toBe(false);
    }
  });

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

// #11585 — the external surface has a size ceiling, and it is a product
// constraint rather than a style preference. At 100 entries it exceeded what MCP
// clients tolerate: Cursor caps the tool count across every connected server and
// silently truncates the overflow, and Copilot's 128-tool cap is a hard error.
// Both pick which of our tools survive, and neither tells us. A budget here is
// what keeps "just add one more" from walking the surface back over the line.
describe("external tool surface budget (#11585)", () => {
  // Sized just above the current 23 so a considered addition or two fits, but
  // "just add one more" hits a wall well before the surface drifts back toward
  // the client caps. The description payload is budgeted separately in
  // actionDefinitions.quality.test.ts, where the live registry text is reachable.
  const EXTERNAL_BUDGET_MAX = 26;

  it(`advertises at most ${EXTERNAL_BUDGET_MAX} tools`, () => {
    expect(TIER_ALLOWLISTS.external.size).toBeLessThanOrEqual(EXTERNAL_BUDGET_MAX);
  });

  // Guards the opposite failure: a bad merge or an over-eager cut emptying the
  // list would make every assertion above vacuous rather than red.
  it("still carries a usable orchestration surface", () => {
    expect(TIER_ALLOWLISTS.external.size).toBeGreaterThanOrEqual(15);
    for (const id of ["actions.list", "agent.launch", "terminal.sendCommand", "worktree.list"]) {
      expect(isTierPermitted("external", id)).toBe(true);
    }
  });

  // The cut is a real revocation, not a listing trick: `tools/call` must reject
  // these too. Each id names a prior deliberate decision that #11585 supersedes
  // — the apiKey back-compat guarantee (git/worktree mutations) and #11544's
  // CI-status routes — so a future reader sees the reversal was intentional.
  //
  // Every one of them stays reachable for the in-app assistant, which is not
  // subject to any third-party client's cap. The paired internal-tier assertion
  // is what makes this a boundary rather than a deletion.
  const CUT_FROM_EXTERNAL_KEPT_INTERNALLY = [
    // Caller has its own shell git. `git.push` keeps its bespoke MCP plumbing
    // (branch/commit preview, cwd pinning, headless-safe confirm) at `system`.
    { id: "git.push", keptAt: "system" },
    { id: "git.commit", keptAt: "system" },
    { id: "git.getFileDiff", keptAt: "workbench" },
    // D2 destructive, and not needed to drive work forward.
    { id: "worktree.delete", keptAt: "system" },
    // #11544's two CI-status routes. An external agent has `gh`; the in-app
    // assistant does not, so both stay at workbench.
    { id: "forge.getCIStatus", keptAt: "workbench" },
    { id: "worktree.reviewReadiness", keptAt: "workbench" },
    // #11786's per-check read, for the same reason as its roll-up sibling.
    { id: "forge.getChecks", keptAt: "workbench" },
    // Caller has its own filesystem and `gh`.
    { id: "file.read", keptAt: "workbench" },
    { id: "forge.listIssues", keptAt: "workbench" },
    { id: "project.getCurrent", keptAt: "workbench" },
    { id: "worktree.resource.provision", keptAt: "action" },
  ] as const;

  it.each(CUT_FROM_EXTERNAL_KEPT_INTERNALLY)(
    "$id is denied externally but still reachable at the $keptAt tier",
    ({ id, keptAt }) => {
      // Pin to ground truth first, so a rename turns this into a red test
      // rather than a vacuous "unknown string is absent from a set".
      expect(BUILT_IN_ACTION_IDS as readonly string[]).toContain(id);

      expect(isTierPermitted("external", id)).toBe(false);
      expect(shouldExposeTool(makeEntry({ id }), "external")).toBe(false);

      expect(isTierPermitted(keptAt, id)).toBe(true);
      expect(shouldExposeTool(makeEntry({ id }), keptAt)).toBe(true);
    }
  );

  // The cut is purely subtractive: it authorizes nothing new. `terminal.close`
  // is the id that nearly slipped in — #11540's draft core set had it, on the
  // theory that closing is recoverable and an orchestrator should be able to
  // clean up after itself. Neither half holds here. Nothing binds a panel to the
  // session that created it, and `terminal.list` returns the user's own shells
  // and other agents' terminals alike, so an external caller could trash a
  // terminal it has no relationship to; trash is then purged after 20s
  // (TRASH_TTL_MS), killing the PTY, with no restore action on this surface.
  it("authorizes no terminal-destroying tool externally", () => {
    for (const id of [
      "terminal.close",
      "terminal.closeAll",
      "terminal.kill",
      "terminal.killAll",
      "terminal.restart",
    ]) {
      // Pin to ground truth: a renamed id must fail loudly, not vacuously pass.
      expect(BUILT_IN_ACTION_IDS as readonly string[]).toContain(id);
      expect(isTierPermitted("external", id)).toBe(false);
      expect(shouldExposeTool(makeEntry({ id }), "external")).toBe(false);
    }
    // The in-app assistant, which has a human watching, keeps them.
    expect(isTierPermitted("action", "terminal.close")).toBe(true);
  });

  // A cut PR that quietly widens is the failure #10710 documents, so assert the
  // direction outright rather than trusting the id list to be read carefully.
  it("authorizes nothing the in-app assistant cannot already reach", () => {
    expect([...TIER_ALLOWLISTS.external].filter((id) => !TIER_ALLOWLISTS.system.has(id))).toEqual(
      []
    );
  });
});

// Forge used to be curated by hand in two separate files — WORKBENCH_TIER_TOOLS
// in shared/config/helpAssistantTierAllowlists.ts and the external allowlist
// in mcp-server/shared.ts — with nothing linking them, and adding a read to only
// one shipped a tool invisible to the other caller class twice (#10696, #11545).
//
// #11585 removed the whole forge surface from `external` and so retired that
// drift risk in the only way that actually works: one curated forge list, at the
// help-assistant tiers. The rationale is that an external agent driving Daintree
// over MCP already has `gh` or its provider's own tools, whereas the in-app
// assistant does not. The assertions below lock that split so a future "why not
// just add it back externally?" has to argue with a red test.
describe("forge tool exposure is help-assistant-only (#11585)", () => {
  it("no forge tool is reachable at the external tier", () => {
    expect([...TIER_ALLOWLISTS.external].filter((id) => id.startsWith("forge."))).toEqual([]);
  });

  // Measured against the real registry, not against another tier: `system` is
  // built as a union that already contains `workbench`, so "workbench forge ⊆
  // system forge" is true by construction and would stay green while the whole
  // surface drained away. The cut moved forge's only home to the in-app tiers,
  // so this is now the assertion carrying that weight.
  it("keeps every forge action reachable by the in-app assistant", () => {
    const allForgeActions = BUILT_IN_ACTION_IDS.filter((id) => id.startsWith("forge."));
    const systemForgeTools = [...TIER_ALLOWLISTS.system].filter((id) => id.startsWith("forge."));

    expect(allForgeActions.length).toBeGreaterThan(0);
    // No exemptions: every forge action in the registry is an MCP tool at the
    // system tier. Carrying a placeholder exclusion here would blind the check
    // the day an id matching it actually appears.
    expect(new Set(systemForgeTools)).toEqual(new Set(allForgeActions));
  });

  // Sentinel for the read added in #11545: an agent that can post a comment must
  // still be able to read the thread. The cohort checks above stay green if this
  // id is dropped from every list, which would silently undo the feature.
  it("permits forge.listIssueComments at the workbench and system tiers", () => {
    const entry = makeEntry({ id: "forge.listIssueComments", kind: "query", danger: "safe" });
    for (const tier of ["workbench", "system"] as const) {
      expect(isTierPermitted(tier, "forge.listIssueComments")).toBe(true);
      expect(shouldExposeTool(entry, tier)).toBe(true);
    }
  });

  // Sentinel for the read added in #11786, for the same reason as the one
  // above: an agent that can see a PR is red must be able to ask which check
  // failed, and the cohort checks stay green if this id is dropped everywhere.
  it("permits forge.getChecks at the workbench and system tiers", () => {
    const entry = makeEntry({ id: "forge.getChecks", kind: "query", danger: "safe" });
    for (const tier of ["workbench", "system"] as const) {
      expect(isTierPermitted(tier, "forge.getChecks")).toBe(true);
      expect(shouldExposeTool(entry, tier)).toBe(true);
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
// human-approved scoped grant, while `system` (the assistant) permits them
// subject only to the confirm gate. `external` used to permit them too — #11585
// removed them from that surface entirely, so `system` is now the only tier that
// reaches them. These assertions lock those invariants against allowlist drift
// (e.g. someone promoting git.push into the action tier). They test the runtime
// gate `isTierPermitted`, not the raw allowlist arrays, so they fail closed if
// the tier wiring itself regresses.
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

  it("withholds those same mutations from the external tier too (#11585)", () => {
    // `external` used to auto-permit these, subject only to the confirm gate,
    // which was the security contrast that motivated pinning the assistant to
    // `action` in the first place. #11585 closed it from the other side: an
    // api-key caller has its own shell git and does not need ours, so the
    // mutations now live only where a human is in the loop. `system` remains the
    // one tier that reaches them.
    for (const toolId of ["git.push", "git.commit", "worktree.delete"]) {
      expect(isTierPermitted("external", toolId)).toBe(false);
      expect(isTierPermitted("system", toolId)).toBe(true);
    }
  });
});

// agent.listToolbar and agent.listAvailable are the narrow, read-only discovery
// surfaces for toolbar state and the effective launch registry. Both must be
// reachable by every in-app tier WITHOUT exposing the broad `agentSettings.get`
// (which leaks custom flags, dangerous args, global env, and presets).
//
// They part ways at `external` (#11585). `agent.listAvailable` stays: it answers
// which agent ids `agent.launch` will actually accept, including user- and
// plugin-contributed ones, and nothing outside Daintree can answer that.
// `agent.listToolbar` reports which buttons the user has surfaced in the UI —
// real for the in-app assistant, not worth a slot on a capped external surface.
describe("narrow agent discovery tier reachability", () => {
  it.each(["agent.listToolbar", "agent.listAvailable"] as const)(
    "permits %s at every in-app tier",
    (toolId) => {
      for (const tier of ["workbench", "action", "system"] as const) {
        expect(isTierPermitted(tier, toolId)).toBe(true);
      }
    }
  );

  it("keeps only the launch-registry read on the external tier", () => {
    expect(isTierPermitted("external", "agent.listAvailable")).toBe(true);
    expect(isTierPermitted("external", "agent.listToolbar")).toBe(false);
  });

  it("keeps the broad agentSettings.get off the external tier so the narrow alternative is the only external path", () => {
    expect(isTierPermitted("external", "agentSettings.get")).toBe(false);
    // Sanity check the contrast is real, not a typo'd id: agentSettings.get IS
    // reachable for the trusted in-app workbench session.
    expect(isTierPermitted("workbench", "agentSettings.get")).toBe(true);
  });
});

describe("getTierPermittedActionIds", () => {
  const TIERS = ["workbench", "action", "system", "external"] as const;

  // The discovery filter enumerates the tier surface while tools/call probes it
  // one id at a time. Both must resolve to the same set or discovery drifts
  // from dispatch — the exact failure #11525 is about.
  it.each(TIERS)("agrees with isTierPermitted for every action id at tier %s", (tier) => {
    const permitted = getTierPermittedActionIds(tier);
    for (const id of BUILT_IN_ACTION_IDS) {
      expect(permitted.has(id)).toBe(isTierPermitted(tier, id));
    }
  });

  // Every tier must resolve to a distinct, non-empty surface: a selector bug
  // that collapsed two tiers onto one set would widen discovery silently.
  it.each(TIERS)("resolves tier %s to a populated surface", (tier) => {
    expect(getTierPermittedActionIds(tier).size).toBeGreaterThan(0);
  });

  it("keeps every tier surface distinct from every other tier's", () => {
    const sameMembership = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
      a.size === b.size && Array.from(a).every((id) => b.has(id));

    const surfaces = TIERS.map((tier) => ({ tier, ids: getTierPermittedActionIds(tier) }));
    const collapsed = surfaces.flatMap((left, i) =>
      surfaces
        .slice(i + 1)
        .filter((right) => sameMembership(left.ids, right.ids))
        .map((right) => `${left.tier}/${right.tier}`)
    );

    // Naming the collapsed pairs makes a regression point at the two tiers that
    // merged rather than just reporting "not distinct".
    expect(collapsed).toEqual([]);
  });
});

describe("readSearchLimit", () => {
  it("falls back to the schema default when limit is absent", () => {
    expect(readSearchLimit(undefined)).toBe(ACTIONS_SEARCH_DEFAULT_LIMIT);
    expect(readSearchLimit({})).toBe(ACTIONS_SEARCH_DEFAULT_LIMIT);
    expect(readSearchLimit({ query: "terminal" })).toBe(ACTIONS_SEARCH_DEFAULT_LIMIT);
    expect(readSearchLimit("not-an-object")).toBe(ACTIONS_SEARCH_DEFAULT_LIMIT);
    expect(readSearchLimit([1, 2])).toBe(ACTIONS_SEARCH_DEFAULT_LIMIT);
  });

  it("returns an in-contract limit unchanged", () => {
    expect(readSearchLimit({ limit: 1 })).toBe(1);
    expect(readSearchLimit({ limit: 7 })).toBe(7);
    expect(readSearchLimit({ limit: ACTIONS_SEARCH_MAX_LIMIT })).toBe(ACTIONS_SEARCH_MAX_LIMIT);
  });

  // A null verdict tells the caller to leave args alone so the renderer's zod
  // validation still rejects them. Clamping instead would silently accept
  // input the published tool contract forbids.
  it("returns null for a limit the tool contract rejects", () => {
    expect(readSearchLimit({ limit: 0 })).toBeNull();
    expect(readSearchLimit({ limit: -3 })).toBeNull();
    expect(readSearchLimit({ limit: ACTIONS_SEARCH_MAX_LIMIT + 1 })).toBeNull();
    expect(readSearchLimit({ limit: 2.5 })).toBeNull();
    expect(readSearchLimit({ limit: "20" })).toBeNull();
    expect(readSearchLimit({ limit: null })).toBeNull();
    expect(readSearchLimit({ limit: Number.NaN })).toBeNull();
  });
});

describe("filterIntrospectionResultForSession", () => {
  const permitted = new Set(["terminal.list", "worktree.list", "actions.search"]);

  function listResult(entries: ActionManifestEntry[]) {
    return { ok: true as const, result: { actions: entries } };
  }
  function searchResult(entries: ActionManifestEntry[], totalMatches = entries.length) {
    return { ok: true as const, result: { totalMatches, results: entries } };
  }
  function ids(result: ReturnType<typeof filterIntrospectionResultForSession>): string[] {
    const payload = (result as { result: { actions?: unknown[]; results?: unknown[] } }).result;
    const entries = payload.actions ?? payload.results ?? [];
    return entries.map((entry) => (entry as ActionManifestEntry).id);
  }

  it("passes a failed dispatch through untouched", () => {
    const failure = {
      ok: false as const,
      error: { code: "EXECUTION_ERROR" as const, message: "boom" },
    };
    expect(
      filterIntrospectionResultForSession("actions.list", failure, permitted, { callerLimit: 20 })
    ).toBe(failure);
  });

  it("passes a non-introspection action through untouched", () => {
    const result = listResult([makeEntry({ id: "git.push" })]);
    expect(
      filterIntrospectionResultForSession("git.push", result, permitted, { callerLimit: 20 })
    ).toBe(result);
  });

  // Guards against a fourth registry-enumerating tool joining
  // INTROSPECTION_TOOL_IDS without a matching filter branch — the handler
  // would then route it here and get its payload back unfiltered.
  it("filters a denied entry out of every id it claims to handle", () => {
    for (const actionId of INTROSPECTION_TOOL_IDS) {
      const denied = makeEntry({ id: "git.push" });
      const input =
        actionId === "actions.getSchema"
          ? { ok: true as const, result: { ok: true, entry: denied } }
          : actionId === "actions.search"
            ? searchResult([denied])
            : listResult([denied]);
      const filtered = filterIntrospectionResultForSession(actionId, input, permitted, {
        callerLimit: 20,
        requestedActionId: "git.push",
      });
      expect(JSON.stringify(filtered)).not.toContain('git.push"');
    }
  });

  describe("actions.list", () => {
    it("drops entries outside the session's permitted surface", () => {
      const result = listResult([
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "git.push" }),
        makeEntry({ id: "worktree.list" }),
      ]);
      expect(
        ids(
          filterIntrospectionResultForSession("actions.list", result, permitted, {
            callerLimit: 20,
          })
        )
      ).toEqual(["terminal.list", "worktree.list"]);
    });

    // The filter authorizes against the session's EFFECTIVE surface — its static
    // tier widened by live grants — which is why it cannot be rebuilt on
    // shouldExposeTool. A tool the user has approved must stay introspectable
    // for as long as the grant lasts, even though the static tier still says no.
    it("keeps a granted entry the static tier gate would withhold", () => {
      const entry = makeEntry({ id: "git.push" });
      // Ground truth: git.push is off the external tier since #11585, so the
      // static gate rejects it and only the grant can explain the result below.
      expect(shouldExposeTool(entry, "external")).toBe(false);

      const granted = new Set([...permitted, "git.push"]);
      expect(
        ids(
          filterIntrospectionResultForSession("actions.list", listResult([entry]), granted, {
            callerLimit: 20,
          })
        )
      ).toEqual(["git.push"]);
    });

    // Main is the authorization boundary; it re-applies the ceilings rather
    // than trusting that the renderer already did.
    it("drops hidden and restricted entries even when tier-permitted", () => {
      const result = listResult([
        makeEntry({ id: "terminal.list", mcpVisibility: "hidden" }),
        makeEntry({ id: "worktree.list", danger: "restricted" }),
        makeEntry({ id: "actions.search" }),
      ]);
      expect(
        ids(
          filterIntrospectionResultForSession("actions.list", result, permitted, {
            callerLimit: 20,
          })
        )
      ).toEqual(["actions.search"]);
    });

    it("drops malformed entries carrying no usable id", () => {
      const result = { ok: true as const, result: { actions: [null, {}, { id: 42 }] } };
      expect(
        ids(
          filterIntrospectionResultForSession("actions.list", result, permitted, {
            callerLimit: 20,
          })
        )
      ).toEqual([]);
    });

    it("does not mutate the payload it was given", () => {
      const result = listResult([
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "git.push" }),
      ]);
      const before = structuredClone(result);
      filterIntrospectionResultForSession("actions.list", result, permitted, { callerLimit: 20 });
      expect(result).toEqual(before);
    });
  });

  describe("actions.search", () => {
    it("recomputes totalMatches from the permitted subset", () => {
      const result = searchResult([
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "git.push" }),
        makeEntry({ id: "git.commit" }),
      ]);
      const filtered = filterIntrospectionResultForSession("actions.search", result, permitted, {
        callerLimit: 20,
      });
      const payload = (filtered as { result: { totalMatches: number } }).result;
      expect(payload.totalMatches).toBe(1);
      expect(ids(filtered)).toEqual(["terminal.list"]);
    });

    // The renderer ranks and slices before main sees tier, so the handler
    // over-fetches the schema maximum. Without that, denied top-ranked hits
    // consume the caller's page and permitted matches below them never ship —
    // a search that reports nothing while matches exist.
    it("fills the caller's page from permitted matches ranked below denied ones", () => {
      const denied = Array.from({ length: 60 }, (_, i) => makeEntry({ id: `git.denied${i}` }));
      const allowed = [
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "worktree.list" }),
        makeEntry({ id: "actions.search" }),
      ];
      const overFetched = searchResult([...denied, ...allowed]);
      const filtered = filterIntrospectionResultForSession(
        "actions.search",
        overFetched,
        permitted,
        { callerLimit: 3 }
      );
      expect(ids(filtered)).toEqual(["terminal.list", "worktree.list", "actions.search"]);
      expect((filtered as { result: { totalMatches: number } }).result.totalMatches).toBe(3);
    });

    it("slices the permitted matches down to the caller's limit", () => {
      const result = searchResult([
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "worktree.list" }),
        makeEntry({ id: "actions.search" }),
      ]);
      const filtered = filterIntrospectionResultForSession("actions.search", result, permitted, {
        callerLimit: 2,
      });
      expect(ids(filtered)).toEqual(["terminal.list", "worktree.list"]);
      // totalMatches still reports everything permitted, not just the page.
      expect((filtered as { result: { totalMatches: number } }).result.totalMatches).toBe(3);
    });

    it("reports zero matches rather than an inflated count when nothing is permitted", () => {
      const result = searchResult([makeEntry({ id: "git.push" })], 40);
      const filtered = filterIntrospectionResultForSession("actions.search", result, permitted, {
        callerLimit: 20,
      });
      expect((filtered as { result: { totalMatches: number } }).result.totalMatches).toBe(0);
      expect(ids(filtered)).toEqual([]);
    });
  });

  describe("actions.getSchema", () => {
    it("returns a permitted entry unchanged", () => {
      const entry = makeEntry({ id: "terminal.list" });
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        { ok: true as const, result: { ok: true, entry } },
        permitted,
        { callerLimit: 20, requestedActionId: "terminal.list" }
      );
      expect(filtered).toEqual({ ok: true, result: { ok: true, entry } });
    });

    it("keeps a core-marked entry reachable (visibility is not the gate)", () => {
      const entry = makeEntry({ id: "worktree.list", mcpVisibility: "core" });
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        { ok: true as const, result: { ok: true, entry } },
        permitted,
        { callerLimit: 20, requestedActionId: "worktree.list" }
      );
      expect(filtered).toEqual({ ok: true, result: { ok: true, entry } });
    });

    it("strips fields the renderer attached alongside an authorized entry", () => {
      const entry = makeEntry({ id: "terminal.list" });
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        { ok: true as const, result: { ok: true, entry, leaked: makeEntry({ id: "git.push" }) } },
        permitted,
        { callerLimit: 20, requestedActionId: "terminal.list" }
      );
      expect(filtered).toEqual({ ok: true, result: { ok: true, entry } });
    });

    it("fails closed when no requested id accompanies the answer", () => {
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        { ok: true as const, result: { ok: true, entry: makeEntry({ id: "terminal.list" }) } },
        permitted,
        { callerLimit: 20 }
      );
      expect((filtered as { result: { ok: boolean } }).result.ok).toBe(false);
    });

    // NOT_FOUND rather than a tier error: a distinct code would confirm the id
    // exists while offering no route to it, since grants are minted off a
    // denied dispatch and never off a schema read.
    it("collapses a denied entry onto the existing NOT_FOUND data shape", () => {
      const result = {
        ok: true as const,
        result: { ok: true, entry: makeEntry({ id: "git.push" }) },
      };
      const filtered = filterIntrospectionResultForSession("actions.getSchema", result, permitted, {
        callerLimit: 20,
        requestedActionId: "git.push",
      });
      const payload = (
        filtered as { result: { ok: boolean; error: { code: string; message: string } } }
      ).result;
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("NOT_FOUND");
      expect(payload.error.message).toContain("git.push");
      expect(payload.error.message).toContain("actions.search");
    });

    it("collapses a denied hidden or restricted entry the same way", () => {
      for (const entry of [
        makeEntry({ id: "terminal.list", mcpVisibility: "hidden" }),
        makeEntry({ id: "terminal.list", danger: "restricted" }),
      ]) {
        const filtered = filterIntrospectionResultForSession(
          "actions.getSchema",
          { ok: true as const, result: { ok: true, entry } },
          permitted,
          { callerLimit: 20, requestedActionId: "terminal.list" }
        );
        expect((filtered as { result: unknown }).result).toEqual({
          ok: false,
          error: { code: "NOT_FOUND", message: expect.stringContaining("terminal.list") },
        });
      }
    });

    it("rebuilds an existing denial rather than forwarding it", () => {
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        {
          ok: true as const,
          result: {
            ok: false,
            error: { code: "NOT_FOUND", message: "nope" },
            entry: makeEntry({ id: "git.push" }),
          },
        },
        permitted,
        { callerLimit: 20, requestedActionId: "git.push" }
      );
      // The smuggled `entry` is gone and the message names the requested id.
      expect((filtered as { result: unknown }).result).toEqual({
        ok: false,
        error: { code: "NOT_FOUND", message: expect.stringContaining("git.push") },
      });
    });
  });
});

describe("isWithheldFromBoundSession (#11789)", () => {
  const BOUND = { workspaceBound: true };

  it("withholds a confirm-gated tool from a bound external session", () => {
    expect(isWithheldFromBoundSession({ danger: "confirm" }, "external", BOUND)).toBe(true);
  });

  it("leaves an unbound external session's confirm-gated tools alone", () => {
    // An unbound session follows focus into a window someone is looking at, so
    // the native dialog still has a human in front of it.
    expect(
      isWithheldFromBoundSession({ danger: "confirm" }, "external", UNBOUND_SESSION_SURFACE)
    ).toBe(false);
  });

  it.each(["workbench", "action", "system"] as const)(
    "never withholds from the %s tier, so the pinned Assistant is untouched",
    (tier) => {
      // The Daintree Assistant is pinned to a renderer and carries confirm-gated
      // tools in its own allowlist. Keying this on "has a route" instead of
      // "external and bound" would silently regress it.
      expect(isWithheldFromBoundSession({ danger: "confirm" }, tier, BOUND)).toBe(false);
    }
  );

  it.each(["safe", "destructive", "restricted"] as const)(
    "does not withhold a %s tool from a bound session",
    (danger) => {
      expect(isWithheldFromBoundSession({ danger }, "external", BOUND)).toBe(false);
    }
  );

  it("is derived from manifest danger, so it covers any confirm-gated tool in the external allowlist", () => {
    // Not a curated id list: a future confirm-gated addition to
    // MCP_EXTERNAL_TIER_TOOLS is withheld the day it lands, with no second
    // allowlist to keep in step.
    for (const toolId of MCP_EXTERNAL_TIER_TOOLS) {
      expect(isWithheldFromBoundSession({ danger: "confirm" }, "external", BOUND)).toBe(true);
      expect(typeof toolId).toBe("string");
    }
  });
});

describe("shouldExposeTool with a workspace-bound session (#11789)", () => {
  const BOUND = { workspaceBound: true };

  it("hides a confirm-gated tool the tier would otherwise permit", () => {
    const entry = makeEntry({ id: "recipe.run", kind: "command", danger: "confirm" });
    expect(shouldExposeTool(entry, "external")).toBe(isTierPermitted("external", "recipe.run"));
    expect(shouldExposeTool(entry, "external", BOUND)).toBe(false);
  });

  it("keeps the rest of the external surface, including its mutating tools", () => {
    // The bound surface is not "read-only" — losing terminal/agent/worktree
    // tools would gut the feature rather than narrow it.
    for (const id of [
      "terminal.sendCommand",
      "terminal.new",
      "agent.launch",
      "worktree.createWithRecipe",
    ]) {
      const entry = makeEntry({ id, kind: "command", danger: "destructive" });
      expect(shouldExposeTool(entry, "external", BOUND)).toBe(isTierPermitted("external", id));
    }
  });

  it("leaves every non-external tier's exposure unchanged when bound", () => {
    const entry = makeEntry({ id: "recipe.run", kind: "command", danger: "confirm" });
    for (const tier of ["workbench", "action", "system"] as const) {
      expect(shouldExposeTool(entry, tier, BOUND)).toBe(shouldExposeTool(entry, tier));
    }
  });
});
