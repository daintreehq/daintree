import { describe, it, expect } from "vitest";
import { findWireStrippedKeywords } from "@shared/utils/mcpWireSchema";
import { measureWireSurface, type WireTool } from "./helpers/wireSurface";

/**
 * The context-condensation budgets — see `docs/architecture/mcp-context-condensation.md`.
 *
 * Every string here is paid on every model turn, by every connected client, and
 * the tool region is the single largest part of a request. These gates hold the
 * shape of that region rather than its wording: each is a predicate on the
 * finished text, so a conforming surface passes unchanged and re-running the
 * standard over it changes nothing.
 *
 * What they deliberately do NOT do is push text toward a target. A ceiling gates;
 * it never instructs a rewrite on its own. Prose already under a ceiling is left
 * alone, because iterated "make it shorter" passes compound until meaning breaks,
 * and the resulting failure is invisible — it shows up as the model picking the
 * wrong tool, not as a size number.
 */

/** One imperative sentence, an optional trigger, disambiguation, traps, return shape. */
const MAX_TOOL_DESCRIPTION_BYTES = 400;

/**
 * One clause: what the value means and its unit. This is the authoring standard's
 * number, and it is enforced here as a ratchet on the tail rather than as a hard
 * ceiling — see {@link MAX_PROPERTIES_OVER_TARGET}.
 */
const PROPERTY_DESCRIPTION_TARGET_BYTES = 160;

/**
 * The hard ceiling for a single property description.
 *
 * It sits well above the target on purpose, because this repo pulls in the
 * opposite direction from the standard's calibration and did so deliberately:
 * #11542 moved field semantics OUT of tool descriptions and INTO `.describe()`,
 * precisely so the top-level prose could shrink. Enforcing 160 B here would undo
 * that — the text has nowhere to go but back up into the tool description this
 * suite has just capped at 400 B, or into deletion.
 *
 * So the target gates drift (below) while this catches an outright essay. What is
 * left above the target is protected content under the standard: focus-drift
 * warnings, invisibility side effects, provider-dialect traps. None of it can be
 * cut to fit a number without removing the reason it was written.
 */
const MAX_PROPERTY_DESCRIPTION_BYTES = 320;

/**
 * How many property descriptions may exceed {@link PROPERTY_DESCRIPTION_TARGET_BYTES}.
 *
 * A ratchet: it may fall freely, and raising it is a deliberate act that belongs
 * in a commit message with a reason. This is what makes the target load-bearing
 * without pretending every field can reach it — a new over-target description
 * fails the suite unless an existing one is brought under.
 */
const MAX_PROPERTIES_OVER_TARGET = 49;

/**
 * Total bytes spent above {@link PROPERTY_DESCRIPTION_TARGET_BYTES}, summed over
 * every over-target description.
 *
 * Paired with the count because the count alone is gameable: the same thirty
 * descriptions can each grow from 161 B to 319 B without moving it. Together
 * they bound both how many descriptions run long and how far they run.
 */
const MAX_EXCESS_PROPERTY_BYTES = 3_000;

/** Above this a tool is almost always polymorphic and wants splitting. */
const MAX_TOOL_PARAMS_BYTES = 1_500;

/**
 * Tools whose advertised `parameters` exceed {@link MAX_TOOL_PARAMS_BYTES}, each
 * with the reason it is not simply split.
 *
 * This list may shrink and must never grow without a reason written beside the
 * entry. An unexplained addition is the failure this allowlist exists to make
 * visible: it converts "we shipped a Swiss Army knife" from an invisible drift
 * into a reviewable line.
 */
const OVERSIZED_PARAMS_ALLOWLIST: Readonly<Record<string, string>> = {
  // The three copyTree tools share one options object whose field semantics are
  // pinned clause-by-clause by regression tests (#11722, #11750) — each clause
  // is there because a caller got it wrong. Trimming to fit would delete exactly
  // the content the standard protects, so the honest fix is a narrower tool, not
  // shorter prose.
  "copyTree.generate": "shared CopyTreeOptions object; field semantics are regression-pinned",
  "copyTree.generateAndCopyFile": "shared CopyTreeOptions object; see copyTree.generate",
  "copyTree.injectToTerminal": "shared CopyTreeOptions object; see copyTree.generate",
  // Launch takes the union of agent identity, preset, placement and terminal
  // setup. Splitting it would force a caller to create a panel and then launch
  // into it, which is two round trips and a partially-created panel to clean up
  // on failure.
  "agent.launch": "single-round-trip launch; splitting it leaks a half-created panel on failure",
  // Forge list filters are wide because the underlying forge query is wide;
  // every property maps to one query parameter rather than to a mode.
  "forge.listIssues": "flat filter set over one forge query, not a polymorphic mode switch",
  "forge.listPRs": "flat filter set over one forge query, not a polymorphic mode switch",
  "workflow.startWorkOnIssue": "composite entry point; the arguments are one workflow's inputs",
  "worktree.createWithRecipe": "composite create-plus-launch; splitting is the plain create tool",
};

/**
 * Individual property descriptions permitted to exceed
 * {@link MAX_PROPERTY_DESCRIPTION_BYTES}, keyed by `toolId :: schema path`.
 *
 * Scoped to the exact property rather than the whole tool on purpose. Exempting
 * a tool would mean a brand-new 500-byte field on the same tool inherits the
 * exemption and never trips anything — the allowlist would grow silent coverage
 * it was never granted.
 *
 * Same contract as above: shrink freely, grow only with a reason. Everything
 * here is protected content under the standard — a negative constraint, a shape
 * requirement, or a disambiguation against a named sibling — which cannot be cut
 * to fit a ceiling. The three copyTree tools share one options object, so the
 * text is written once and advertised three times.
 */
const OVERSIZED_PROPERTY_ALLOWLIST: Readonly<Record<string, string>> = Object.fromEntries(
  ["copyTree.generate", "copyTree.generateAndCopyFile", "copyTree.injectToTerminal"].flatMap(
    (tool) =>
      [
        "properties.options.properties.scopeIgnoresIgnoreFiles",
        "properties.options.properties.always",
        "properties.options.properties.scopePaths",
        "properties.options.properties.includePaths",
        "properties.options.properties.filter",
      ].map((path) => [
        `${tool} :: ${path}`,
        "CopyTreeOptions precedence rules; every clause is regression-pinned (#11722, #11750)",
      ])
  )
);

let cached: WireTool[] | undefined;
async function surface(): Promise<WireTool[]> {
  cached ??= await measureWireSurface();
  return cached;
}

/** Every property description above the one-clause target, allowlist applied. */
async function propertiesOverTarget(): Promise<Array<{ id: string; path: string; bytes: number }>> {
  const tools = await surface();
  return tools
    .flatMap((t) => t.propertyDescriptions.map((p) => ({ id: t.id, path: p.path, bytes: p.bytes })))
    .filter((p) => !(`${p.id} :: ${p.path}` in OVERSIZED_PROPERTY_ALLOWLIST))
    .filter((p) => p.bytes > PROPERTY_DESCRIPTION_TARGET_BYTES)
    .sort((a, b) => b.bytes - a.bytes);
}

describe("MCP wire budget — tool descriptions (§4.2)", () => {
  it("keeps every advertised description within one screen of prose", async () => {
    const tools = await surface();

    const over = tools
      .filter((t) => t.descriptionBytes > MAX_TOOL_DESCRIPTION_BYTES)
      .map((t) => `${t.id} (${t.descriptionBytes}B)`);

    expect(over).toEqual([]);
  });

  it("has a description on every tool it advertises", async () => {
    const tools = await surface();
    expect(tools.filter((t) => t.description.trim() === "").map((t) => t.id)).toEqual([]);
  });
});

describe("MCP wire budget — property descriptions (§4.3)", () => {
  it("lets no single property description run to an essay", async () => {
    const tools = await surface();

    const over: string[] = [];
    for (const tool of tools) {
      for (const prop of tool.propertyDescriptions) {
        if (`${tool.id} :: ${prop.path}` in OVERSIZED_PROPERTY_ALLOWLIST) continue;
        if (prop.bytes > MAX_PROPERTY_DESCRIPTION_BYTES) {
          over.push(`${tool.id} :: ${prop.path} (${prop.bytes}B)`);
        }
      }
    }

    expect(over).toEqual([]);
  });

  it("ratchets down the number of properties above the one-clause target", async () => {
    const overTarget = await propertiesOverTarget();

    // Named in the failure so the ratchet says which descriptions to look at,
    // rather than only that a count moved.
    expect(
      overTarget.length,
      overTarget.map((p) => `${p.id} :: ${p.path} (${p.bytes}B)`).join("\n")
    ).toBeLessThanOrEqual(MAX_PROPERTIES_OVER_TARGET);
  });

  it("ratchets down the total bytes spent above the target", async () => {
    // The count alone is gameable: thirty descriptions can each grow from 161 B
    // to 319 B without moving it. Summing the excess prices that growth, so the
    // two together bound both how many descriptions run long and how far.
    const overTarget = await propertiesOverTarget();
    const excess = overTarget.reduce(
      (sum, p) => sum + (p.bytes - PROPERTY_DESCRIPTION_TARGET_BYTES),
      0
    );

    expect(excess).toBeLessThanOrEqual(MAX_EXCESS_PROPERTY_BYTES);
  });

  it("allowlists only properties that actually exceed the ceiling", async () => {
    // A stale allowlist entry is worse than none: it silently exempts a tool
    // whose prose has since been fixed, so the next regression there goes unseen.
    const tools = await surface();
    // Compared against the ceiling the allowlist actually exempts, not the
    // target. Checking the target instead would keep an entry looking "fresh"
    // long after its description fell back under the ceiling.
    const stillOver = new Set(
      tools.flatMap((t) =>
        t.propertyDescriptions
          .filter((p) => p.bytes > MAX_PROPERTY_DESCRIPTION_BYTES)
          .map((p) => `${t.id} :: ${p.path}`)
      )
    );

    const stale = Object.keys(OVERSIZED_PROPERTY_ALLOWLIST).filter((key) => !stillOver.has(key));
    expect(stale).toEqual([]);
  });
});

describe("MCP wire budget — atomicity (§4.4)", () => {
  it("keeps each tool's advertised parameters small enough to reason over", async () => {
    const tools = await surface();

    const over = tools
      .filter((t) => t.paramsBytes > MAX_TOOL_PARAMS_BYTES && !(t.id in OVERSIZED_PARAMS_ALLOWLIST))
      .map((t) => `${t.id} (${t.paramsBytes}B)`);

    expect(over).toEqual([]);
  });

  it("allowlists only tools that actually exceed the ceiling", async () => {
    const tools = await surface();
    const stillOver = new Set(
      tools.filter((t) => t.paramsBytes > MAX_TOOL_PARAMS_BYTES).map((t) => t.id)
    );

    const stale = Object.keys(OVERSIZED_PARAMS_ALLOWLIST).filter((id) => !stillOver.has(id));
    expect(stale).toEqual([]);
  });
});

describe("MCP wire budget — the wire/validation split (§4.1)", () => {
  it("advertises no value-range keyword anywhere in the tool surface", async () => {
    // These are not enforced by constrained decoding, so they reach the model as
    // prompt text and nothing else. `argsSchema` still rejects a bad value, so
    // their absence costs no safety — a bound the caller genuinely needs belongs
    // in the field's own description, where it survives the projection.
    const tools = await surface();

    const leaked: string[] = [];
    for (const tool of tools) {
      for (const path of findWireStrippedKeywords(tool.inputSchema)) {
        leaked.push(`${tool.id} :: ${path}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it("keeps additionalProperties:false on every advertised input schema", async () => {
    // The half of the split that must NOT be projected away: with a complete
    // `required` array it is what lets a strict backend build a deterministic
    // mask, and it measurably reduces hallucinated keys.
    const tools = await surface();

    const missing = tools
      .filter((t) => (t.inputSchema as Record<string, unknown>)["additionalProperties"] !== false)
      .map((t) => t.id);

    expect(missing).toEqual([]);
  });
});

describe("MCP wire budget — aggregate ratchets (§9)", () => {
  // Ratchets, not targets. Each sits a little above the real total so ordinary
  // wording edits pass while a doubling trips. They may fall freely; raising one
  // is a deliberate act that belongs in a commit message with a reason.
  //
  // These bound the description-and-schema payload, which is the part authors
  // control and the part that moves. They are deliberately NOT the full
  // serialized `tools/list` byte count: that also carries tool names,
  // annotations, `_meta.examples` and JSON framing, none of which this standard
  // governs. Reading them as the wire total would overstate what a rewrite here
  // can achieve.
  // 43_000 → 45_500 for #11909, which spent bytes in two places: the two new
  // `*Owned` cleanup tools, and a `spawnedTerminalIds` field added to
  // `recipe.run` and `worktree.createWithRecipe`. The second is the one worth
  // defending — those composites previously reported only a count, so the
  // panels they created were unidentifiable, and no wording change buys that
  // back.
  const MAX_EXTERNAL_PAYLOAD_BYTES = 45_500;
  const MAX_COHORT_PAYLOAD_BYTES = 190_000;

  const wireBytes = (t: WireTool) => t.descriptionBytes + t.paramsBytes + t.outputBytes;

  it("keeps the third-party client surface within budget", async () => {
    const tools = await surface();
    const total = tools.filter((t) => t.external).reduce((sum, t) => sum + wireBytes(t), 0);

    expect(total).toBeLessThanOrEqual(MAX_EXTERNAL_PAYLOAD_BYTES);
  });

  it("keeps the full in-app surface within budget", async () => {
    const tools = await surface();
    const total = tools.reduce((sum, t) => sum + wireBytes(t), 0);

    expect(total).toBeLessThanOrEqual(MAX_COHORT_PAYLOAD_BYTES);
  });

  it("measures a surface that is actually there", async () => {
    // Guards the guard: a harness that silently returned nothing would satisfy
    // every ceiling above while proving the opposite of what it claims.
    const tools = await surface();
    expect(tools.length).toBeGreaterThan(100);
    expect(tools.filter((t) => t.external).length).toBeGreaterThan(15);
  });
});
