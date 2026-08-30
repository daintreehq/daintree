import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

import type { ActionId } from "@shared/types/actions";
import { MCP_EXTERNAL_TIER_TOOLS } from "@shared/config/mcpExternalTierAllowlist";
import { ActionService } from "@/services/ActionService";
import { createActionRegistry } from "./helpers/wireSurface";

const ARTIFACT_PATH = path.resolve(
  __dirname,
  "../../../../electron/services/mcp-server/generated/mcpExternalBaseManifest.ts"
);

/**
 * Fields `ActionService` computes from the *reporting view's* live state, which
 * a host-owned catalog has no business asserting.
 *
 * `enabled`/`disabledReason` answer "can this run right now, here"; the palette
 * projections are renderer-only and read by nothing on the MCP path. Dropping
 * them is what makes the artifact view-invariant rather than a snapshot of the
 * machine that generated it.
 */
const VIEW_DEPENDENT_FIELDS = [
  "enabled",
  "disabledReason",
  "paletteHidden",
  "paletteRedirectTo",
  "paletteDisabled",
  "paletteDisabledReason",
] as const;

/**
 * Materialize the external surface through the real `ActionService`, not a
 * reimplementation of `toManifestEntry`.
 *
 * The projection is not trivial — schemas are compiled from Zod, `band` is
 * derived through `deriveBand`, `requiresArgs` from the args schema, and the
 * palette fields from `definition.palette` — so a second copy of it here would
 * be the only thing this artifact could ever drift against.
 */
type BaseManifestEntry = Record<string, unknown>;

async function buildExpectedEntries(): Promise<BaseManifestEntry[]> {
  const registry = await createActionRegistry();
  const service = new ActionService();
  for (const factory of registry.values()) {
    const definition = factory();
    if (service.has(definition.id)) continue;
    service.register(definition);
  }

  // Nothing on the external surface may decide its own visibility or
  // enablement from context. `list()` evaluates `isVisible` against whatever
  // context it is handed, so an action with one would be present or absent here
  // according to the empty context below — a view-dependent answer baked into a
  // view-independent artifact. Refused rather than documented, because the
  // failure is silent: the tool would simply be missing from every viewless
  // session's surface.
  const contextual = [...MCP_EXTERNAL_TIER_TOOLS].filter((id) => {
    const definition = registry.get(id as ActionId)?.();
    return definition?.isVisible !== undefined || definition?.isEnabled !== undefined;
  });
  if (contextual.length > 0) {
    throw new Error(
      `External-tier actions must not gate on context to appear in the host base ` +
        `manifest, but these declare isVisible/isEnabled: ${contextual.join(", ")}`
    );
  }

  // An empty context on purpose: the catalog describes actions, not a session.
  const listed = service.list({}, { includeSchemas: true });
  const byId = new Map(listed.map((entry) => [entry.id, entry]));

  const missing = MCP_EXTERNAL_TIER_TOOLS.filter((id) => !byId.has(id as ActionId));
  if (missing.length > 0) {
    // An allowlisted id absent from the registry is a broken tier, not an entry
    // to skip — silently dropping it would shrink the served surface and let
    // this test pass by describing less than production exposes.
    throw new Error(`MCP_EXTERNAL_TIER_TOOLS names unregistered action(s): ${missing.join(", ")}`);
  }

  return [...MCP_EXTERNAL_TIER_TOOLS].sort().map((id) => {
    const source = byId.get(id as ActionId);
    if (!source) throw new Error(`Unreachable: ${id} was present a moment ago`);
    const entry: BaseManifestEntry = { ...source };
    for (const field of VIEW_DEPENDENT_FIELDS) delete entry[field];
    // `enabled` is restored as a constant, not as the generating machine's
    // answer: a host-served entry is enabled as far as the host can know, and
    // the bound view has the final say at dispatch either way.
    //
    // Key order is part of the emitted file, so it is normalized here rather
    // than inherited from whatever order `toManifestEntry` happened to assign.
    // Code-unit order, not `localeCompare`: this string ends up byte-compared
    // against a checked-in file on three platforms, and ICU collation is free
    // to differ by locale.
    return Object.fromEntries(
      Object.entries({ ...entry, enabled: true }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
  });
}

async function renderArtifact(entries: BaseManifestEntry[]): Promise<string> {
  const source = `// GENERATED FILE — do not edit by hand.
//
// The tool surface served to a workspace-bound external MCP session whose
// workspace has no single live view — none open, or more than one (#12082).
// Regenerate with:
//
//   UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts
//
// The generator drives the real \`ActionService\` over the real action registry,
// so this is a projection of production code rather than a second source of
// truth. The same test fails when this file drifts from it.

import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

export const MCP_EXTERNAL_BASE_MANIFEST: readonly ActionManifestEntry[] = ${JSON.stringify(
    entries,
    null,
    2
  )};
`;
  const prettier = await import("prettier");
  const config = await prettier.resolveConfig(ARTIFACT_PATH);
  return prettier.format(source, { ...config, filepath: ARTIFACT_PATH });
}

describe("MCP external base manifest artifact", () => {
  // One materialization for the file: it walks the whole action registry and
  // compiles every schema, which is the only slow thing here.
  let expectedEntries: Promise<BaseManifestEntry[]>;
  const expected = () => (expectedEntries ??= buildExpectedEntries());

  it("matches the surface the real action registry produces", async () => {
    const entries = await expected();
    const rendered = await renderArtifact(entries);

    if (process.env.UPDATE_MCP_BASE_MANIFEST === "1") {
      writeFileSync(ARTIFACT_PATH, rendered, "utf8");
    }

    const onDisk = readFileSync(ARTIFACT_PATH, "utf8");
    expect(
      onDisk,
      "Generated MCP base manifest is stale. Regenerate with:\n" +
        "  UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts"
    ).toBe(rendered);
  }, 60_000);

  it("covers exactly the external tier and nothing beyond it", async () => {
    const { MCP_EXTERNAL_BASE_MANIFEST } =
      await import("../../../../electron/services/mcp-server/generated/mcpExternalBaseManifest");

    // Set algebra against the allowlist rather than a copied count: adding a
    // tool to the external tier without regenerating must fail here.
    expect(new Set(MCP_EXTERNAL_BASE_MANIFEST.map((e) => e.id))).toEqual(
      new Set(MCP_EXTERNAL_TIER_TOOLS)
    );
    expect(MCP_EXTERNAL_BASE_MANIFEST.every((e) => e.pluginId === undefined)).toBe(true);
  });

  it("carries the schemas a client needs to call the tools", async () => {
    const { MCP_EXTERNAL_BASE_MANIFEST } =
      await import("../../../../electron/services/mcp-server/generated/mcpExternalBaseManifest");
    const entries = await expected();

    // The point of publishing a full surface rather than an empty one is that a
    // client can actually *call* what it sees, so every tool the live registry
    // gives an input schema must carry the identical schema here.
    for (const entry of entries) {
      const shipped = MCP_EXTERNAL_BASE_MANIFEST.find((e) => e.id === entry.id);
      expect(shipped?.inputSchema).toEqual(entry.inputSchema);
      expect(shipped?.outputSchema).toEqual(entry.outputSchema);
      expect(shipped?.danger).toBe(entry.danger);
      expect(shipped?.requiresArgs).toBe(entry.requiresArgs);
    }
  }, 60_000);
});
