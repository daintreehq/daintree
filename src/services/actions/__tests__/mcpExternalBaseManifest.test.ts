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
import { VIEWLESS_ACTIONS } from "../../../../electron/services/viewless/viewlessActionCatalog";
import { createActionRegistry } from "./helpers/wireSurface";

const ARTIFACT_PATH = path.resolve(
  __dirname,
  "../../../../electron/services/mcp-server/generated/mcpExternalBaseManifest.ts"
);
const VIEWLESS_ARTIFACT_PATH = path.resolve(
  __dirname,
  "../../../../electron/services/mcp-server/generated/mcpViewlessBaseManifest.ts"
);

/**
 * The tools the session server runs in main whatever views are open: its
 * `VIEWLESS_MAIN_PROCESS_TOOLS`, which can't be imported into this renderer
 * test. `sessionServer.test.ts` holds the generated surface to that set, so a
 * tool added there and missed here fails.
 */
const MAIN_PROCESS_TOOLS = [
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "skills.search",
  "skills.load",
  "mcp.surface",
  "project.runCheck",
  "project.runCommand",
  "terminal.readLastMessageOwned",
  "terminal.notifyWhenIdle",
  "assistant.getInbox",
  "assistant.reply",
  "assistant.sendMessage",
];

/**
 * What a help session with no view lists besides the external surface
 * (#13511): the actions the host runs itself (#13498) and the tools main
 * runs, where the external tier doesn't already describe them.
 */
const VIEWLESS_EXTRA_TOOLS = [...new Set([...Object.keys(VIEWLESS_ACTIONS), ...MAIN_PROCESS_TOOLS])]
  .filter((id) => !(MCP_EXTERNAL_TIER_TOOLS as readonly string[]).includes(id))
  .sort();

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

async function buildExpectedEntries(ids: readonly string[]): Promise<BaseManifestEntry[]> {
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
  const contextual = [...ids].filter((id) => {
    const definition = registry.get(id as ActionId)?.();
    return definition?.isVisible !== undefined || definition?.isEnabled !== undefined;
  });
  if (contextual.length > 0) {
    throw new Error(
      `Actions must not gate on context to appear in a host base ` +
        `manifest, but these declare isVisible/isEnabled: ${contextual.join(", ")}`
    );
  }

  // An empty context on purpose: the catalog describes actions, not a session.
  const listed = service.list({}, { includeSchemas: true });
  const byId = new Map(listed.map((entry) => [entry.id, entry]));

  const missing = ids.filter((id) => !byId.has(id as ActionId));
  if (missing.length > 0) {
    // An allowlisted id absent from the registry is a broken tier, not an entry
    // to skip — silently dropping it would shrink the served surface and let
    // this test pass by describing less than production exposes.
    throw new Error(`A host base manifest names unregistered action(s): ${missing.join(", ")}`);
  }

  return [...ids].sort().map((id) => {
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

async function renderArtifact(
  entries: BaseManifestEntry[],
  artifactPath: string,
  constName: string,
  purpose: string
): Promise<string> {
  const source = `// GENERATED FILE — do not edit by hand.
//
${purpose}
// Regenerate with:
//
//   UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts
//
// The generator drives the real \`ActionService\` over the real action registry,
// so this is a projection of production code rather than a second source of
// truth. The same test fails when this file drifts from it.

import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

export const ${constName}: readonly ActionManifestEntry[] = ${JSON.stringify(entries, null, 2)};
`;
  const prettier = await import("prettier");
  const config = await prettier.resolveConfig(artifactPath);
  return prettier.format(source, { ...config, filepath: artifactPath });
}

async function expectArtifact(artifactPath: string, rendered: string): Promise<void> {
  if (process.env.UPDATE_MCP_BASE_MANIFEST === "1") {
    writeFileSync(artifactPath, rendered, "utf8");
  }
  const onDisk = readFileSync(artifactPath, "utf8");
  expect(
    onDisk,
    "Generated MCP base manifest is stale. Regenerate with:\n" +
      "  UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts"
  ).toBe(rendered);
}

describe("MCP external base manifest artifact", () => {
  it("matches the surface the real action registry produces", async () => {
    const entries = await buildExpectedEntries(MCP_EXTERNAL_TIER_TOOLS);
    const rendered = await renderArtifact(
      entries,
      ARTIFACT_PATH,
      "MCP_EXTERNAL_BASE_MANIFEST",
      [
        "// The tool surface served to a workspace-bound external MCP session whose",
        "// workspace has no single live view — none open, or more than one (#12082).",
      ].join("\n")
    );
    await expectArtifact(ARTIFACT_PATH, rendered);
  }, 60_000);

  it("describes every action the host runs with no view that the external tier lacks", async () => {
    const entries = await buildExpectedEntries(VIEWLESS_EXTRA_TOOLS);
    const rendered = await renderArtifact(
      entries,
      VIEWLESS_ARTIFACT_PATH,
      "MCP_VIEWLESS_BASE_MANIFEST",
      [
        "// What a help session with no view lists besides the external surface",
        "// (#13511): the actions the host runs itself (#13498) and the tools main",
        "// runs, where the external tier doesn't already describe them.",
      ].join("\n")
    );
    await expectArtifact(VIEWLESS_ARTIFACT_PATH, rendered);
  }, 60_000);
});
