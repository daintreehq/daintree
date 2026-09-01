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
  buildToolInputSchema,
  buildToolOutputSchema,
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
  buildTargetPolicy,
  buildUnavailableStub,
  MCP_TARGET_POLICY_VERSION,
  type TargetPolicySessionSnapshot,
} from "../tierAuth.js";
import { McpUnavailableActionStubSchema } from "../../../../shared/types/mcpIntrospection.js";
import { findWireStrippedKeywords } from "../../../../shared/utils/mcpWireSchema.js";
import { TIER_ALLOWLISTS } from "../shared.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import type { McpTargetPolicy } from "../../../../shared/types/mcpTargetPolicy.js";
import {
  McpGetSchemaResultSchema,
  McpGetSchemaWireResultSchema,
} from "../../../../shared/types/mcpTargetPolicy.js";

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

/**
 * The wire/validation split, asserted against the SHIPPED builders rather than
 * against a reimplementation of them. This is the pair `sessionServer` calls to
 * fill `tools/list`, so deleting the projection from `buildToolInputSchema` —
 * or accidentally adding one to `buildToolOutputSchema` — fails here.
 *
 * The budget suite in `src/services/actions/__tests__/mcpWireBudget.test.ts`
 * measures the same projection over the live registry, but it necessarily
 * re-applies it in the renderer (these builders are main-process modules). That
 * makes it a measurement of the standard, not proof of the production path;
 * this is the proof.
 */
describe("wire/validation schema split", () => {
  const CONSTRAINED_SCHEMA = {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many" },
      tags: { type: "array", items: { type: "string", maxLength: 8 }, minItems: 1 },
      // A property NAMED after a keyword: it must survive as an advertised argument.
      pattern: { type: "string", pattern: "^a", description: "The glob" },
    },
    required: ["limit", "pattern"],
  } as const;

  it("advertises no value-range keyword on the input schema", () => {
    const wire = buildToolInputSchema(
      makeEntry({ inputSchema: structuredClone(CONSTRAINED_SCHEMA) as Record<string, unknown> })
    );

    expect(findWireStrippedKeywords(wire)).toEqual([]);
  });

  it("keeps every argument the schema declares, including keyword-named ones", () => {
    const wire = buildToolInputSchema(
      makeEntry({ inputSchema: structuredClone(CONSTRAINED_SCHEMA) as Record<string, unknown> })
    );

    const properties = (wire as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["limit", "pattern", "tags"]);
    // Prose and the mask-relevant keywords survive; only the bounds go.
    expect(properties["pattern"]).toEqual({ type: "string", description: "The glob" });
    expect((wire as { required: string[] }).required).toEqual(["limit", "pattern"]);
  });

  it("always advertises additionalProperties:false", () => {
    // Load-bearing for strict/grammar-constrained backends, so it must survive
    // the projection AND be added to a schema that omitted it.
    expect(
      buildToolInputSchema(makeEntry({ inputSchema: { type: "object", properties: {} } }))
    ).toMatchObject({ additionalProperties: false });
    expect(buildToolInputSchema(makeEntry())).toMatchObject({ additionalProperties: false });
  });

  it("does not mutate the manifest entry it projects", () => {
    const inputSchema = structuredClone(CONSTRAINED_SCHEMA) as Record<string, unknown>;
    const before = JSON.stringify(inputSchema);
    buildToolInputSchema(makeEntry({ inputSchema }));

    expect(JSON.stringify(inputSchema)).toBe(before);
  });

  it("leaves the OUTPUT schema unprojected", () => {
    // An advertised `outputSchema` is compiled and enforced by the MCP SDK's AJV
    // pass on the client, and main-process tools never get the `resultSchema`
    // check that covers renderer dispatches. Stripping bounds here would delete
    // real validation rather than dead prompt text.
    const outputSchema = {
      type: "object",
      properties: { hash: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64 } },
    };

    expect(buildToolOutputSchema(makeEntry({ outputSchema }))).toEqual(outputSchema);
  });

  it("still refuses a non-object output schema", () => {
    expect(buildToolOutputSchema(makeEntry({ outputSchema: { type: "string" } }))).toBeUndefined();
    expect(buildToolOutputSchema(makeEntry())).toBeUndefined();
  });
});

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
  // The surface currently sits AT this ceiling, which is the intended state:
  // the next addition has to raise the number, and raising it is the decision
  // this budget exists to force into the open. The description payload is
  // budgeted separately in actionDefinitions.quality.test.ts, where the live
  // registry text is reachable.
  //
  // 26 → 28 for #11909's `terminal.closeOwned` and `worktree.deleteOwned`. They
  // are the two halves of one capability the surface was missing outright — an
  // external orchestrator could create terminals and worktrees but not clean up
  // after itself — rather than two independent conveniences, and neither
  // widens what the caller can reach: both act only on resources the session
  // itself created.
  const EXTERNAL_BUDGET_MAX = 28;

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

// Policy guard for the help-session MCP tiers (#10640). Every help agent —
// the Daintree Assistant and the Claude/Codex overlays alike — provisions at
// the tier the user configured, with `action` as the default floor (#11907
// removed the identity override that used to pin the assistant to `system`).
// So the assertions below lock the `action` tier that governs a default
// session, plus the system/external boundaries above it.
// The distinction is load-bearing: `action` leaves irreversible mutations
// (git.push, worktree.delete) TIER_NOT_PERMITTED so a default session needs a
// human-approved scoped grant, while `system` — the tier a user has to select
// deliberately — permits them subject only to the confirm gate. `external` used
// to permit them too — #11585
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
  it.each(["agent.listToolbar", "agent.listAvailable", "agent.listPresets"] as const)(
    "permits %s at every in-app tier",
    (toolId) => {
      for (const tier of ["workbench", "action", "system"] as const) {
        expect(isTierPermitted(tier, toolId)).toBe(true);
      }
    }
  );

  it("keeps only the launch-resolving reads on the external tier", () => {
    expect(isTierPermitted("external", "agent.listAvailable")).toBe(true);
    // Preset ids are the other argument `agent.launch` accepts and cannot be
    // guessed from outside, so this read earns the same slot on the same
    // argument as the registry read above.
    expect(isTierPermitted("external", "agent.listPresets")).toBe(true);
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
    // A renderer-owned ladder session with no grants: the ordinary case, and the
    // baseline every policy assertion below varies one axis away from.
    function snapshot(
      overrides: Partial<TargetPolicySessionSnapshot> = {}
    ): TargetPolicySessionSnapshot {
      return {
        tier: "workbench",
        rendererOwnedOrigin: true,
        perToolGrantedActionIds: new Set<string>(),
        nativeGrantedActionIds: new Set<string>(),
        ...overrides,
      };
    }

    function lookup(
      entry: ActionManifestEntry,
      opts: {
        requestedActionId?: string;
        permittedActionIds?: ReadonlySet<string>;
        policySnapshot?: TargetPolicySessionSnapshot | null;
      } = {}
    ) {
      const { policySnapshot = snapshot() } = opts;
      return filterIntrospectionResultForSession(
        "actions.getSchema",
        { ok: true as const, result: { ok: true, entry, policy: null, error: null } },
        opts.permittedActionIds ?? permitted,
        {
          callerLimit: 20,
          requestedActionId: opts.requestedActionId ?? entry.id,
          ...(policySnapshot ? { policySnapshot } : {}),
        }
      );
    }

    function payloadOf(result: ReturnType<typeof filterIntrospectionResultForSession>) {
      return (
        result as {
          result: {
            ok: boolean;
            entry: unknown;
            policy: McpTargetPolicy | null;
            error: { code: string; message: string } | null;
          };
        }
      ).result;
    }

    function policyOf(result: ReturnType<typeof filterIntrospectionResultForSession>) {
      const policy = payloadOf(result).policy;
      if (policy === null) throw new Error("expected a policy record");
      return policy;
    }

    it("returns a permitted entry alongside its policy", () => {
      const entry = makeEntry({ id: "terminal.list" });
      const payload = payloadOf(lookup(entry));

      expect(payload.ok).toBe(true);
      expect(payload.entry).toEqual(entry);
      expect(payload.error).toBeNull();
      expect(payload.policy).not.toBeNull();
    });

    it("keeps a core-marked entry reachable (visibility is not the gate)", () => {
      const entry = makeEntry({ id: "worktree.list", mcpVisibility: "core" });
      const payload = payloadOf(lookup(entry));

      expect(payload.ok).toBe(true);
      expect(payload.entry).toEqual(entry);
    });

    it("strips fields the renderer attached alongside an authorized entry", () => {
      const entry = makeEntry({ id: "terminal.list" });
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        {
          ok: true as const,
          result: {
            ok: true,
            entry,
            policy: null,
            error: null,
            leaked: makeEntry({ id: "git.push" }),
          },
        },
        permitted,
        { callerLimit: 20, requestedActionId: "terminal.list", policySnapshot: snapshot() }
      );

      expect(Object.keys(payloadOf(filtered)).sort()).toEqual(["entry", "error", "ok", "policy"]);
    });

    // The renderer cannot fill `policy` — it has no session state — so a read
    // that reaches main without the session facts to build one has nothing
    // authoritative to say about the target. Denying beats answering with an
    // entry a client would read as unrestricted.
    it("fails closed when no policy snapshot accompanies the read", () => {
      const payload = payloadOf(
        lookup(makeEntry({ id: "terminal.list" }), { policySnapshot: null })
      );

      expect(payload.ok).toBe(false);
      expect(payload.policy).toBeNull();
      expect(payload.error?.code).toBe("NOT_FOUND");
    });

    it("fails closed on a target no tier permits, even when a grant names it", () => {
      // Neither issuance path can mint a grant for an id `minimumPermittingTier`
      // does not place, so this is a stale-metadata backstop rather than a
      // reachable state — and its safe answer is the same denial.
      const orphan = "actions.persistedStores";
      const payload = payloadOf(
        lookup(makeEntry({ id: orphan }), {
          permittedActionIds: new Set([...permitted, orphan]),
          policySnapshot: snapshot({ perToolGrantedActionIds: new Set([orphan]) }),
        })
      );

      expect(payload.ok).toBe(false);
      expect(payload.policy).toBeNull();
    });

    it("fails closed when no requested id accompanies the answer", () => {
      const filtered = filterIntrospectionResultForSession(
        "actions.getSchema",
        {
          ok: true as const,
          result: {
            ok: true,
            entry: makeEntry({ id: "terminal.list" }),
            policy: null,
            error: null,
          },
        },
        permitted,
        { callerLimit: 20, policySnapshot: snapshot() }
      );
      expect(payloadOf(filtered).ok).toBe(false);
    });

    // NOT_FOUND rather than a tier error, for every caller the existence
    // catalog is closed to: a distinct code would confirm the id exists while
    // offering no route to it, since grants are minted off a denied dispatch
    // and never off a schema read. A renderer-owned session DOES have a route
    // — the panel's own tier control — which is the whole of why #12117 carves
    // it out; that case is covered under "first-party existence catalog".
    it("collapses a denied entry onto the existing NOT_FOUND data shape", () => {
      const payload = payloadOf(
        lookup(makeEntry({ id: "git.push" }), {
          policySnapshot: snapshot({ rendererOwnedOrigin: false }),
        })
      );

      expect(payload.ok).toBe(false);
      expect(payload.entry).toBeNull();
      expect(payload.policy).toBeNull();
      expect(payload.error?.code).toBe("NOT_FOUND");
      expect(payload.error?.message).toContain("git.push");
      expect(payload.error?.message).toContain("actions.search");
    });

    it("collapses a denied hidden or restricted entry the same way", () => {
      for (const entry of [
        makeEntry({ id: "terminal.list", mcpVisibility: "hidden" }),
        makeEntry({ id: "terminal.list", danger: "restricted" }),
      ]) {
        expect(payloadOf(lookup(entry))).toEqual({
          ok: false,
          entry: null,
          policy: null,
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
        { callerLimit: 20, requestedActionId: "git.push", policySnapshot: snapshot() }
      );
      // The smuggled `entry` is gone and the message names the requested id.
      expect(payloadOf(filtered)).toEqual({
        ok: false,
        entry: null,
        policy: null,
        error: { code: "NOT_FOUND", message: expect.stringContaining("git.push") },
      });
    });

    describe("policy record (#11910)", () => {
      it("reports the tier as the admitting mechanism for a tier-permitted target", () => {
        const policy = policyOf(lookup(makeEntry({ id: "terminal.list" })));

        expect(policy.authorizedBy).toBe("tier");
        expect(policy.callable).toBe(true);
        expect(policy.unavailableReason).toBeNull();
        expect(policy.effectiveTier).toBe("workbench");
        expect(policy.minimumTier).toBe("workbench");
        expect(policy.version).toBe(MCP_TARGET_POLICY_VERSION);
        expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
      });

      // The distinction a client acts on: tier access is durable for the
      // session, a grant lapses. Reporting only `callable` would collapse them.
      it("reports a grant as the admitting mechanism, with the tier it would need", () => {
        const policy = policyOf(
          lookup(makeEntry({ id: "git.push" }), {
            permittedActionIds: new Set([...permitted, "git.push"]),
            policySnapshot: snapshot({ perToolGrantedActionIds: new Set(["git.push"]) }),
          })
        );

        expect(policy.authorizedBy).toBe("grant");
        expect(policy.minimumTier).toBe("system");
        expect(policy.effectiveTier).toBe("workbench");
        expect(policy.callable).toBe(true);
      });

      it("reports a native grant as the admitting mechanism", () => {
        const policy = policyOf(
          lookup(makeEntry({ id: "git.push" }), {
            permittedActionIds: new Set([...permitted, "git.push"]),
            policySnapshot: snapshot({ nativeGrantedActionIds: new Set(["git.push"]) }),
          })
        );

        expect(policy.authorizedBy).toBe("nativeGrant");
      });

      // A native grant is an explicit user approval of the tool's scope, so the
      // dispatch gate sets `dispatchConfirmed` from it. A per-tool grant only
      // widens the floor, and the modal still fires.
      it("clears requiresConfirmation for a native grant but not a per-tool grant", () => {
        const confirmEntry = makeEntry({ id: "worktree.list", danger: "confirm" });

        const nativelyGranted = policyOf(
          lookup(confirmEntry, {
            policySnapshot: snapshot({ nativeGrantedActionIds: new Set(["worktree.list"]) }),
          })
        );
        expect(nativelyGranted.danger).toBe("confirm");
        expect(nativelyGranted.requiresConfirmation).toBe(false);

        const perToolGranted = policyOf(
          lookup(confirmEntry, {
            policySnapshot: snapshot({ perToolGrantedActionIds: new Set(["worktree.list"]) }),
          })
        );
        expect(perToolGranted.requiresConfirmation).toBe(true);
      });

      it("keeps requiresConfirmation set for a per-resolved-target tool (#12121)", () => {
        // `peekNativeGrant` refuses terminal.killAll, so a grant listing it
        // buys no bypass. Reading the allowlist alone would advertise one the
        // dispatch gate will not honour.
        // System tier so the floor admits the call on its own — this isolates
        // the confirmation axis instead of collapsing the whole record.
        const policy = policyOf(
          lookup(makeEntry({ id: "terminal.killAll", danger: "confirm" }), {
            permittedActionIds: new Set([...permitted, "terminal.killAll"]),
            policySnapshot: snapshot({
              tier: "system",
              nativeGrantedActionIds: new Set(["terminal.killAll"]),
            }),
          })
        );

        expect(policy.danger).toBe("confirm");
        expect(policy.requiresConfirmation).toBe(true);
        expect(policy.authorizedBy).toBe("tier");
      });

      it("reports the flat external tier rather than a rung the caller cannot climb", () => {
        const policy = policyOf(
          lookup(makeEntry({ id: "terminal.list" }), {
            policySnapshot: snapshot({ tier: "external", rendererOwnedOrigin: false }),
          })
        );

        expect(policy.minimumTier).toBe("external");
        expect(policy.effectiveTier).toBe("external");
        expect(policy.grantable).toBe(false);
      });

      // The divergence `resolveTokenTier` makes reachable: an unrecognised
      // bearer token resolves to `workbench` while the origin still defaults to
      // `external`. Both grant-issuance paths gate on the ORIGIN, so a
      // tier-derived answer here would promise an approval flow that always
      // throws.
      it("reports grantable:false for a ladder tier whose origin cannot hold grants", () => {
        const rendererOwned = policyOf(lookup(makeEntry({ id: "terminal.list" })));
        expect(rendererOwned.grantable).toBe(true);

        const foreignOrigin = policyOf(
          lookup(makeEntry({ id: "terminal.list" }), {
            policySnapshot: snapshot({ rendererOwnedOrigin: false }),
          })
        );
        expect(foreignOrigin.grantable).toBe(false);
      });

      // A grant whose origin could not have been issued never admits the call at
      // the dispatch gate either, so the policy must not claim it does.
      it("ignores grants a non-renderer-owned origin could not have been issued", () => {
        const payload = payloadOf(
          lookup(makeEntry({ id: "git.push" }), {
            permittedActionIds: new Set([...permitted, "git.push"]),
            policySnapshot: snapshot({
              rendererOwnedOrigin: false,
              perToolGrantedActionIds: new Set(["git.push"]),
            }),
          })
        );

        expect(payload.ok).toBe(false);
        expect(payload.policy).toBeNull();
      });

      it("reports a disabled target as reachable but not callable", () => {
        const policy = policyOf(
          lookup(makeEntry({ id: "terminal.list", enabled: false, disabledReason: "no terminals" }))
        );

        expect(policy.callable).toBe(false);
        expect(policy.unavailableReason).toBe("DISABLED");
        // Still authorized — this is a transient state of a visible action, not
        // an authorization denial, so it does not collapse to NOT_FOUND.
        expect(policy.authorizedBy).toBe("tier");
      });

      // `resolveEffectiveActionDanger` keys the elevation on the ARGUMENT, so a
      // target that cannot accept a `recipeId` can never be elevated by one.
      it("flags only targets whose arguments can escalate confirmation", () => {
        const escalatable = policyOf(
          lookup(
            makeEntry({
              id: "terminal.list",
              inputSchema: { type: "object", properties: { recipeId: { type: "string" } } },
            })
          )
        );
        expect(escalatable.danger).toBe("safe");
        expect(escalatable.confirmationMayEscalate).toBe(true);

        const plain = policyOf(
          lookup(
            makeEntry({
              id: "terminal.list",
              inputSchema: { type: "object", properties: { limit: { type: "number" } } },
            })
          )
        );
        expect(plain.confirmationMayEscalate).toBe(false);
      });

      it("never reports escalation for a target already declared confirm", () => {
        const policy = policyOf(
          lookup(
            makeEntry({
              id: "worktree.list",
              danger: "confirm",
              inputSchema: { type: "object", properties: { recipeId: { type: "string" } } },
            })
          )
        );

        expect(policy.confirmationMayEscalate).toBe(false);
      });

      // The renderer's own `resultSchema` check runs before main substitutes the
      // policy, so it only ever validates the null placeholder. Nothing else
      // validates what main builds — this is the check that the finished record
      // satisfies the contract the companion CLI codes against.
      it("builds a record that satisfies the published wire contract", () => {
        for (const target of [
          makeEntry({ id: "terminal.list" }),
          makeEntry({ id: "worktree.list", danger: "confirm" }),
          makeEntry({ id: "terminal.list", enabled: false }),
        ]) {
          const parsed = McpGetSchemaWireResultSchema.safeParse(payloadOf(lookup(target)));
          expect(parsed.success).toBe(true);
        }
      });

      it("emits a denial that satisfies the same wire contract", () => {
        const parsed = McpGetSchemaWireResultSchema.safeParse(
          payloadOf(lookup(makeEntry({ id: "git.push" })))
        );
        expect(parsed.success).toBe(true);
      });

      // The looser staging schema exists only so the renderer's half-built value
      // validates; it must not be mistaken for the wire contract.
      it("rejects the renderer's staging shape as a wire result", () => {
        const staging = {
          ok: true,
          entry: makeEntry({ id: "terminal.list" }),
          policy: null,
          error: null,
        };

        expect(McpGetSchemaResultSchema.safeParse(staging).success).toBe(true);
        expect(McpGetSchemaWireResultSchema.safeParse(staging).success).toBe(false);
      });

      // The record is the caller's own authorization boundary and nothing more.
      // Grant expiry, issuance times, actor ids and denial counts are either
      // cross-session or abuse-signal internals with no legitimate client use,
      // so a new field cannot arrive here without a deliberate edit to this list.
      it("exposes exactly the agreed fields and no grant internals", () => {
        const policy = policyOf(
          lookup(makeEntry({ id: "terminal.list" }), {
            policySnapshot: snapshot({ nativeGrantedActionIds: new Set(["terminal.list"]) }),
          })
        );

        expect(Object.keys(policy).sort()).toEqual([
          "authorizedBy",
          "callable",
          "confirmationMayEscalate",
          "danger",
          "dynamicInvocation",
          "effectiveTier",
          "grantable",
          "hash",
          "minimumTier",
          "preferredTool",
          "requiresConfirmation",
          "unavailableReason",
          "version",
        ]);
      });
    });

    describe("per-target hash", () => {
      const base = makeEntry({
        id: "terminal.list",
        inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 100 } } },
      });

      it("ignores prose so a reworded description is not a compatibility break", () => {
        const reworded = {
          ...base,
          description: "Completely different wording",
          title: "Renamed",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number", maximum: 100, description: "how many" } },
          },
        };

        expect(policyOf(lookup(reworded)).hash).toBe(policyOf(lookup(base)).hash);
      });

      it("changes when a constraint a caller's code depends on tightens", () => {
        const tightened = {
          ...base,
          inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 50 } } },
        };

        expect(policyOf(lookup(tightened)).hash).not.toBe(policyOf(lookup(base)).hash);
      });

      it("changes when the target's danger changes", () => {
        const gated = { ...base, id: "worktree.list", danger: "confirm" as const };
        const plain = { ...base, id: "worktree.list" };

        expect(policyOf(lookup(gated)).hash).not.toBe(policyOf(lookup(plain)).hash);
      });

      // The output schema is hashed as the LOOKUP HANDS IT OVER, not as
      // `tools/list` would advertise it. `buildToolOutputSchema` collapses
      // anything without a top-level `type: "object"` to nothing, so hashing
      // that view would let a top-level union swap its variants — visible right
      // there in `entry.outputSchema` — without moving the digest.
      it("covers an output schema tools/list would refuse to advertise", () => {
        const union = (variant: string) => ({
          ...base,
          outputSchema: {
            anyOf: [{ type: "object", properties: { [variant]: { type: "string" } } }],
          },
        });
        expect(buildToolOutputSchema(union("a"))).toBeUndefined();

        expect(policyOf(lookup(union("a"))).hash).not.toBe(policyOf(lookup(union("b"))).hash);
      });

      // Live session state is deliberately outside the preimage: a digest that
      // flapped as grants came and went would describe a target no lookup ever
      // returned, and clients would learn to ignore it.
      it("holds still while only live session state moves", () => {
        const granted = policyOf(
          lookup(base, {
            policySnapshot: snapshot({ nativeGrantedActionIds: new Set(["terminal.list"]) }),
          })
        );
        const plain = policyOf(lookup(base));

        expect(granted.requiresConfirmation).toBe(plain.requiresConfirmation);
        expect(granted.hash).toBe(plain.hash);
      });

      // The caller's own ladder is part of the preimage for the same reason the
      // surface hash carries `tier`: two callers of one build genuinely see
      // different contracts for the same id.
      it("differs between an external caller and a ladder caller", () => {
        const ladder = policyOf(lookup(base));
        const external = policyOf(
          lookup(base, {
            policySnapshot: snapshot({ tier: "external", rendererOwnedOrigin: false }),
          })
        );

        expect(external.hash).not.toBe(ladder.hash);
      });
    });
  });

  describe("buildTargetPolicy fail-closed contract", () => {
    const snap: TargetPolicySessionSnapshot = {
      tier: "workbench",
      rendererOwnedOrigin: true,
      perToolGrantedActionIds: new Set<string>(),
      nativeGrantedActionIds: new Set<string>(),
    };

    it("returns null rather than a partial record for anything it cannot describe", () => {
      const malformed: unknown[] = [
        null,
        undefined,
        "terminal.list",
        {},
        { id: 42 },
        { id: "terminal.list" },
        makeEntry({ id: "terminal.list", danger: "restricted" }),
        makeEntry({ id: "terminal.list", mcpVisibility: "hidden" }),
        { ...makeEntry({ id: "terminal.list" }), kind: "sideways" },
        // A non-boolean `enabled` must not read as callable.
        { ...makeEntry({ id: "terminal.list" }), enabled: "false" },
        { ...makeEntry({ id: "terminal.list" }), enabled: undefined },
      ];

      for (const entry of malformed) {
        expect(buildTargetPolicy(entry, snap)).toBeNull();
      }
    });

    // A manifest entry is only as well-formed as whatever built it, and
    // JSON.stringify throws on a cycle. Fail closed rather than letting it
    // escape the tool call as an exception.
    it("returns null instead of throwing on a schema that cannot be canonicalised", () => {
      const cyclic: Record<string, unknown> = { type: "object" };
      cyclic["self"] = cyclic;

      expect(
        buildTargetPolicy(makeEntry({ id: "terminal.list", inputSchema: cyclic }), snap)
      ).toBeNull();
    });
  });

  // #12117: an out-of-tier id used to be indistinguishable from a nonexistent
  // one at every discovery surface, so the assistant reported capabilities the
  // product ships as ones it lacks. A renderer-owned session now learns that
  // the name exists and which tier would permit it — and nothing else.
  describe("first-party existence catalog (#12117)", () => {
    // `git.push` is system-tier; the session below is workbench, so it is
    // out-of-tier for real rather than by fixture construction.
    const OUT_OF_TIER = "git.push";

    function firstParty(
      overrides: Partial<TargetPolicySessionSnapshot> = {}
    ): TargetPolicySessionSnapshot {
      return {
        tier: "workbench",
        rendererOwnedOrigin: true,
        perToolGrantedActionIds: new Set<string>(),
        nativeGrantedActionIds: new Set<string>(),
        ...overrides,
      };
    }

    function listFor(
      entries: ActionManifestEntry[],
      policySnapshot: TargetPolicySessionSnapshot | undefined,
      opts: { listPaging?: { offset: number; limit: number }; permit?: ReadonlySet<string> } = {}
    ) {
      return (
        filterIntrospectionResultForSession(
          "actions.list",
          { ok: true as const, result: { actions: entries } },
          opts.permit ?? permitted,
          {
            callerLimit: 20,
            ...(opts.listPaging ? { listPaging: opts.listPaging } : {}),
            ...(policySnapshot ? { policySnapshot } : {}),
          }
        ) as {
          result: {
            actions: unknown[];
            total: number;
            hasMore: boolean;
            unavailable?: unknown[];
            unavailableTotal?: number;
            unavailableHasMore?: boolean;
          };
        }
      ).result;
    }

    function searchFor(
      entries: ActionManifestEntry[],
      policySnapshot: TargetPolicySessionSnapshot | undefined,
      callerLimit = 20
    ) {
      return (
        filterIntrospectionResultForSession(
          "actions.search",
          { ok: true as const, result: { totalMatches: entries.length, results: entries } },
          permitted,
          { callerLimit, ...(policySnapshot ? { policySnapshot } : {}) }
        ) as {
          result: {
            results: unknown[];
            totalMatches: number;
            unavailable?: unknown[];
            unavailableTotalMatches?: number;
          };
        }
      ).result;
    }

    /** Ids of whichever collection the caller names, for order-sensitive asserts. */
    function stubIds(stubs: unknown[] | undefined): string[] {
      return (stubs ?? []).map((s) => (s as { id: string }).id);
    }

    function schemaFor(
      entry: ActionManifestEntry,
      policySnapshot: TargetPolicySessionSnapshot | undefined
    ) {
      return (
        filterIntrospectionResultForSession(
          "actions.getSchema",
          { ok: true as const, result: { ok: true, entry, policy: null, error: null } },
          permitted,
          {
            callerLimit: 20,
            requestedActionId: entry.id,
            ...(policySnapshot ? { policySnapshot } : {}),
          }
        ) as {
          result: {
            ok: boolean;
            entry: unknown;
            policy: unknown;
            unavailable?: unknown;
            error: { code: string; message: string } | null;
          };
        }
      ).result;
    }

    it("names an out-of-tier action, its band, and the tier that permits it", () => {
      const stub = buildUnavailableStub(
        makeEntry({ id: OUT_OF_TIER, title: "Push", category: "git", danger: "confirm" }),
        firstParty()
      );

      expect(stub).toEqual({
        id: OUT_OF_TIER,
        title: "Push",
        // BAND_OVERRIDES pins git.push to external-effect; deriving it here
        // rather than reading `entry.band` is what keeps a renderer-attached
        // value from crossing the tier boundary unvalidated.
        band: "external-effect",
        minimumTier: "system",
        callable: false,
      });
      expect(McpUnavailableActionStubSchema.safeParse(stub).success).toBe(true);
    });

    // `git.push` above proves nothing about the derivation: BAND_OVERRIDES pins
    // it, so a builder that passed a hard-coded `danger: "safe"` into
    // `deriveBand` would still report it correctly. `worktree.delete` — the
    // action #12117 was actually filed about — has no override and is
    // `danger: "confirm"` in a non-open-world category, so its band can only be
    // right if the entry's OWN danger reaches the derivation.
    it("derives the band from the entry's own danger, not a fixed value", () => {
      const destructive = buildUnavailableStub(
        makeEntry({
          id: "worktree.delete",
          title: "Delete Worktree",
          category: "worktree",
          danger: "confirm",
        }),
        firstParty()
      );
      expect(destructive).toMatchObject({ band: "destructive-local", minimumTier: "system" });

      const safe = buildUnavailableStub(
        makeEntry({ id: "worktree.delete", category: "worktree", danger: "safe" }),
        firstParty()
      );
      expect(safe).toMatchObject({ band: "reversible" });
    });

    it("carries no description, schemas, or policy across the tier boundary", () => {
      const stub = buildUnavailableStub(
        makeEntry({
          id: OUT_OF_TIER,
          description: "secret prose",
          inputSchema: { type: "object", properties: { force: { type: "boolean" } } },
          outputSchema: { type: "object" },
          disabledReason: "nope",
        }),
        firstParty()
      );

      expect(Object.keys(stub ?? {}).sort()).toEqual([
        "band",
        "callable",
        "id",
        "minimumTier",
        "title",
      ]);
    });

    it.each([
      // The divergence `resolveTokenTier` makes reachable: an unrecognised
      // bearer token resolves to a ladder tier while the origin still defaults
      // to `external`. The ORIGIN decides, exactly as grant issuance does.
      ["a ladder tier on a foreign origin", firstParty({ rendererOwnedOrigin: false })],
      ["an external-tier caller", firstParty({ tier: "external", rendererOwnedOrigin: false })],
      // Belt and braces on the other axis: `external` is a flat peer of the
      // ladder, so there is no rung to name even for a first-party origin.
      ["an external tier on a renderer-owned origin", firstParty({ tier: "external" })],
      ["an absent snapshot", undefined],
    ])("stays closed to %s", (_label, snap) => {
      expect(buildUnavailableStub(makeEntry({ id: OUT_OF_TIER }), snap)).toBeNull();
    });

    // The rows above all name tiers that exist today, so they would stay green
    // against a `tier !== "external"` check — the fail-OPEN shape. This is the
    // one that would not: a second flat peer added to `McpTier` has no rung on
    // the ladder and nothing honest to report, and must be refused until
    // someone puts it on the ladder deliberately. Cast because the tier does
    // not exist yet; that is exactly the future this guards.
    it("stays closed to a tier that is not on the ladder at all", () => {
      const futurePeer = firstParty({
        tier: "partner" as unknown as TargetPolicySessionSnapshot["tier"],
      });

      expect(buildUnavailableStub(makeEntry({ id: OUT_OF_TIER }), futurePeer)).toBeNull();
      expect(listFor([makeEntry({ id: OUT_OF_TIER })], futurePeer).unavailable).toBeUndefined();
    });

    it("refuses ceilings and unplaceable ids, which no elevation would reach", () => {
      const unreachable: unknown[] = [
        makeEntry({ id: OUT_OF_TIER, mcpVisibility: "hidden" }),
        makeEntry({ id: OUT_OF_TIER, danger: "restricted" }),
        // In no tier allowlist at all, so there is no tier to name.
        makeEntry({ id: "actions.persistedStores" }),
        // Already permitted at this session's own tier: reporting a tier it is
        // already at would read as "elevate" when elevating changes nothing.
        makeEntry({ id: "terminal.list" }),
        null,
        undefined,
        { id: OUT_OF_TIER },
        { ...makeEntry({ id: OUT_OF_TIER }), title: "" },
        { ...makeEntry({ id: OUT_OF_TIER }), category: undefined },
      ];

      for (const entry of unreachable) {
        expect(buildUnavailableStub(entry, firstParty())).toBeNull();
      }
    });

    it("reports out-of-tier ids beside the callable ones in actions.list", () => {
      const payload = listFor(
        [makeEntry({ id: "terminal.list" }), makeEntry({ id: OUT_OF_TIER })],
        firstParty()
      );

      expect((payload.actions as ActionManifestEntry[]).map((e) => e.id)).toEqual([
        "terminal.list",
      ]);
      expect(payload.total).toBe(1);
      expect(payload.unavailable).toEqual([
        expect.objectContaining({ id: OUT_OF_TIER, minimumTier: "system", callable: false }),
      ]);
      expect(payload.unavailableTotal).toBe(1);
    });

    it("reports them in actions.search too", () => {
      const payload = searchFor(
        [makeEntry({ id: "worktree.list" }), makeEntry({ id: OUT_OF_TIER })],
        firstParty()
      );

      expect(payload.totalMatches).toBe(1);
      expect(payload.unavailable).toEqual([expect.objectContaining({ id: OUT_OF_TIER })]);
      expect(payload.unavailableTotalMatches).toBe(1);
    });

    // The key set, not just the values: an external client's payload has to
    // stay byte-for-byte what it was, so the field is ABSENT rather than an
    // empty array it might one day wonder about.
    it("adds no key at all for a session the catalog is closed to", () => {
      const entries = [makeEntry({ id: "terminal.list" }), makeEntry({ id: OUT_OF_TIER })];
      const foreign = firstParty({ rendererOwnedOrigin: false });

      expect(Object.keys(listFor(entries, foreign)).sort()).toEqual([
        "actions",
        "hasMore",
        "limit",
        "offset",
        "total",
      ]);
      expect(Object.keys(searchFor(entries, foreign)).sort()).toEqual(["results", "totalMatches"]);
      expect(schemaFor(makeEntry({ id: OUT_OF_TIER }), foreign)).toEqual({
        ok: false,
        entry: null,
        policy: null,
        error: { code: "NOT_FOUND", message: expect.stringContaining(OUT_OF_TIER) },
      });
    });

    // Same window, two counters. Deliberately uneven — 2 callable against 3
    // unavailable, paged 2 at a time — so a regression that shared one cursor,
    // reported a page length as a total, or let one collection's size steer
    // the other's slice cannot fit inside a single page and pass.
    it("counts and pages the two collections independently", () => {
      const entries = [
        makeEntry({ id: "terminal.list" }),
        makeEntry({ id: "worktree.list" }),
        makeEntry({ id: OUT_OF_TIER }),
        makeEntry({ id: "git.commit" }),
        makeEntry({ id: "git.stageAll" }),
      ];

      const first = listFor(entries, firstParty(), { listPaging: { offset: 0, limit: 2 } });
      expect((first.actions as ActionManifestEntry[]).map((e) => e.id)).toEqual([
        "terminal.list",
        "worktree.list",
      ]);
      expect(first.total).toBe(2);
      expect(stubIds(first.unavailable)).toEqual([OUT_OF_TIER, "git.commit"]);
      expect(first.unavailableTotal).toBe(3);

      // Second page: the callable set is exhausted, the catalog is not. Each
      // collection advances on its own contents, not on the other's.
      const second = listFor(entries, firstParty(), { listPaging: { offset: 2, limit: 2 } });
      expect(second.actions).toEqual([]);
      expect(second.total).toBe(2);
      expect(stubIds(second.unavailable)).toEqual(["git.stageAll"]);
      expect(second.unavailableTotal).toBe(3);
    });

    // The case a shared cursor gets wrong: the callable set is exhausted on
    // page one while the catalog is not. `hasMore` keeps its callable-only
    // meaning, so a client paging on it alone would stop with stubs unfetched
    // and conclude the catalog was exhaustive — the exact wrong conclusion for
    // a surface whose job is to prove a capability exists. That is what
    // `unavailableHasMore` is for.
    it("signals more catalog entries when hasMore has already gone false", () => {
      const page = listFor(
        [
          makeEntry({ id: "terminal.list" }),
          makeEntry({ id: OUT_OF_TIER }),
          makeEntry({ id: "git.commit" }),
        ],
        firstParty(),
        { listPaging: { offset: 0, limit: 1 } }
      );

      expect(page.hasMore).toBe(false);
      expect(page.total).toBe(1);
      expect(stubIds(page.unavailable)).toEqual([OUT_OF_TIER]);
      expect(page.unavailableTotal).toBe(2);
      expect(page.unavailableHasMore).toBe(true);

      // And the continuation the flag promised actually resolves.
      const next = listFor(
        [
          makeEntry({ id: "terminal.list" }),
          makeEntry({ id: OUT_OF_TIER }),
          makeEntry({ id: "git.commit" }),
        ],
        firstParty(),
        { listPaging: { offset: 1, limit: 1 } }
      );
      expect(stubIds(next.unavailable)).toEqual(["git.commit"]);
      expect(next.unavailableHasMore).toBe(false);
    });

    it("applies the caller's search limit to each collection on its own", () => {
      const payload = searchFor(
        [
          makeEntry({ id: "terminal.list" }),
          makeEntry({ id: OUT_OF_TIER }),
          makeEntry({ id: "git.commit" }),
        ],
        firstParty(),
        1
      );

      expect((payload.results as ActionManifestEntry[]).map((e) => e.id)).toEqual([
        "terminal.list",
      ]);
      expect(stubIds(payload.unavailable)).toEqual([OUT_OF_TIER]);
      // The count is of everything main saw, not of the page it returned.
      expect(payload.unavailableTotalMatches).toBe(2);
    });

    // A grant widens `permittedActionIds`, so the id takes the callable branch
    // and cannot also appear as a stub — the two collections are disjoint by
    // construction rather than by a second membership check.
    it("moves a granted id into the callable array rather than duplicating it", () => {
      const entries = [makeEntry({ id: OUT_OF_TIER })];

      const ungranted = listFor(entries, firstParty());
      expect(ungranted.actions).toEqual([]);
      expect(stubIds(ungranted.unavailable)).toEqual([OUT_OF_TIER]);

      const granted = listFor(
        entries,
        firstParty({ perToolGrantedActionIds: new Set([OUT_OF_TIER]) }),
        { permit: new Set([...permitted, OUT_OF_TIER]) }
      );

      expect((granted.actions as ActionManifestEntry[]).map((e) => e.id)).toEqual([OUT_OF_TIER]);
      expect(granted.total).toBe(1);
      expect(granted.unavailable).toEqual([]);
      expect(granted.unavailableTotal).toBe(0);
    });

    it("answers actions.getSchema with the tier instead of an indistinguishable denial", () => {
      const payload = schemaFor(makeEntry({ id: OUT_OF_TIER }), firstParty());

      expect(payload.ok).toBe(false);
      // Still a denial: no entry, no policy, no schemas.
      expect(payload.entry).toBeNull();
      expect(payload.policy).toBeNull();
      expect(payload.error?.code).toBe("TIER_NOT_PERMITTED");
      expect(payload.unavailable).toEqual(
        expect.objectContaining({ id: OUT_OF_TIER, minimumTier: "system", callable: false })
      );
      expect(McpGetSchemaWireResultSchema.safeParse(payload).success).toBe(true);
    });

    // The two denial fields move together or the record lies. Strictness alone
    // cannot say so — an optional key beside an enum admits both halves of a
    // contradiction — so the correlation is asserted here rather than assumed.
    it("rejects a denial whose code and stub disagree", () => {
      const stub = buildUnavailableStub(makeEntry({ id: OUT_OF_TIER }), firstParty());
      const denial = { ok: false as const, entry: null, policy: null };

      // A tier denial that names no tier tells the model a capability exists
      // and gives it nothing to say to the user.
      expect(
        McpGetSchemaWireResultSchema.safeParse({
          ...denial,
          error: { code: "TIER_NOT_PERMITTED", message: "x" },
        }).success
      ).toBe(false);

      // And the reverse: a NOT_FOUND carrying a stub would confirm the id
      // exists in the very shape that exists to be indistinguishable.
      expect(
        McpGetSchemaWireResultSchema.safeParse({
          ...denial,
          unavailable: stub,
          error: { code: "NOT_FOUND", message: "x" },
        }).success
      ).toBe(false);
    });

    // The precondition `buildUnavailableStub` documents, enforced at the call
    // site: an entry the session CAN reach right now — here through a live
    // grant — must never fall through to the catalog when its policy fails to
    // build. Reporting "needs system tier" for a tool the grant already admits
    // would be a lie about access the caller has.
    it("does not name a tier for a reachable target whose policy fails to build", () => {
      const payload = (
        filterIntrospectionResultForSession(
          "actions.getSchema",
          {
            ok: true as const,
            result: {
              ok: true,
              // `enabled` absent, so `buildTargetPolicy` fails closed.
              entry: { ...makeEntry({ id: OUT_OF_TIER }), enabled: undefined },
              policy: null,
              error: null,
            },
          },
          new Set([...permitted, OUT_OF_TIER]),
          {
            callerLimit: 20,
            requestedActionId: OUT_OF_TIER,
            policySnapshot: firstParty({ perToolGrantedActionIds: new Set([OUT_OF_TIER]) }),
          }
        ) as { result: { ok: boolean; unavailable?: unknown; error: { code: string } | null } }
      ).result;

      expect(payload.ok).toBe(false);
      expect(payload.error?.code).toBe("NOT_FOUND");
      expect(payload.unavailable).toBeUndefined();
    });

    it("keeps an unknown id indistinguishable even for a first-party session", () => {
      // The renderer answers `ok: false` for an id it cannot find, so the
      // catalog never sees an entry to describe — which is the point: an id
      // that does not exist must not be confirmable by probing.
      const payload = (
        filterIntrospectionResultForSession(
          "actions.getSchema",
          {
            ok: true as const,
            result: { ok: false, entry: null, policy: null, error: { code: "NOT_FOUND" } },
          },
          permitted,
          { callerLimit: 20, requestedActionId: "not.a.real.action", policySnapshot: firstParty() }
        ) as { result: { ok: boolean; unavailable?: unknown; error: { code: string } | null } }
      ).result;

      expect(payload.ok).toBe(false);
      expect(payload.error?.code).toBe("NOT_FOUND");
      expect(payload.unavailable).toBeUndefined();
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

  it.each(["safe", "restricted"] as const)(
    "does not withhold a %s tool from a bound session",
    (danger) => {
      // Only the confirmation gate is unreachable in the background. A tool is
      // not withheld for being dangerous — the bound surface still carries
      // terminal, agent and worktree mutations.
      expect(isWithheldFromBoundSession({ danger }, "external", BOUND)).toBe(false);
    }
  );
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
      const entry = makeEntry({ id, kind: "command", danger: "safe" });
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
