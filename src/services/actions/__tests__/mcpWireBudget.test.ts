import { describe, it, expect } from "vitest";
import { findWireStrippedKeywords } from "@shared/utils/mcpWireSchema";
import { HELP_TIER_CUMULATIVE } from "@shared/config/helpAssistantTierAllowlists";
import { measureWireSurface, type WireTool } from "./helpers/wireSurface";
import { TerminalSubmissionRecordSchema } from "../definitions/schemas";

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
 *
 * 49 → 50 for #12354's `forge.openRepo`. Its one over-target property is the
 * shared `projectId` selector (204 B) that every project-scoped forge open action
 * already carries, reused verbatim rather than worded afresh. Bringing that under
 * would mean cutting its unknown-id caveat from every tool that shares it — the
 * protected content the target is not allowed to buy back.
 *
 * 50 → 42 for the core/full split, measured at 42. Nothing was trimmed: eight
 * over-target descriptions left with the tools that carried them, which are on
 * no in-app tool set any more — `forge.openRepo`'s `projectId` above and its
 * three `forge.open*` siblings, `agent.terminal`'s `focusPolicy`,
 * `git.getFileDiff`'s `status`, `terminal.killAll`'s `confirmed` and
 * `terminal.killBatch`'s `terminalIds`.
 */
const MAX_PROPERTIES_OVER_TARGET = 42;

/**
 * Total bytes spent above {@link PROPERTY_DESCRIPTION_TARGET_BYTES}, summed over
 * every over-target description.
 *
 * Paired with the count because the count alone is gameable: the same thirty
 * descriptions can each grow from 161 B to 319 B without moving it. Together
 * they bound both how many descriptions run long and how far they run.
 *
 * 3_000 → 2_200 for the core/full split, measured at 2_170 B (2_557 B before
 * it). The same eight descriptions as the count above took 387 B of excess off
 * the surface with them, which would otherwise have been left as headroom for
 * the next long description to spend without anyone deciding it should.
 */
const MAX_EXCESS_PROPERTY_BYTES = 2_200;

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

  it("holds the submission record's output observation to the one-clause target", () => {
    // The collector above walks input schemas only, so an output property
    // escapes the target unless it is pinned by name. #12478 was allowed onto a
    // tool at its description cap on the condition that it fit here.
    const description = TerminalSubmissionRecordSchema.shape.outputChangeAfterWriteAt.description;

    expect(description).toBeDefined();
    expect(Buffer.byteLength(description ?? "", "utf8")).toBeLessThanOrEqual(
      PROPERTY_DESCRIPTION_TARGET_BYTES
    );
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
  // 45_500 → 45_800 for the `worktree.createWithRecipe` source union. The flat
  // predecessor advertised five independently optional fields whose legal
  // combinations existed only inside `run()`, so the generated schema accepted
  // `{}` — an empty call was advertised as valid and only a dispatch could
  // teach otherwise. The union costs a repeated `branchName` across two arms
  // and buys a schema that names the three creation modes and their required
  // fields. Those bytes are the contract; the old ones were a claim that was
  // not true.
  // 45_800 → 46_200: each arm of the `worktree.createWithRecipe` source union
  // is `.strict()`, so the generated schema closes them individually. Production
  // only adds `additionalProperties: false` to the ROOT object, so without this
  // the advertised arms accepted fields borrowed from a sibling mode —
  // `baseBranch` on an existing-branch reuse, a `branchName` beside a pull
  // request — which runtime zod then silently stripped. The bytes buy a schema
  // that refuses the combination instead of quietly ignoring half of it.
  // 46_200 → 46_400 for `terminal.list`'s `owned` filter: 191 B, 2 B of it
  // description and 189 B the params advertising the boolean and the sentence
  // saying what it answers — the terminals this session's own ledger recorded,
  // so a session that reconnected owns none. Unsaid, that honest empty result
  // reads as a broken filter and the caller falls back to the unfiltered
  // listing, which is the fan-out the filter exists to remove. A ceiling gates;
  // it does not instruct a rewrite, and this is the text that standard protects.
  // The headroom went to #12312's `workspace.list`; each PR fits alone and only
  // the landing order does not.
  // 46_400 → 46_600 ahead of the spend, for #12189's two additions to the
  // external tier:
  //   - `agent.listAvailable`'s `defaultAgentId` and `resolvedDefaultAgentId`,
  //     207 B. The user's explicit pick and what a launch would actually spawn
  //     are different answers whenever the pick is unset or its CLI is not
  //     launchable, and a caller that reads one as the other names an agent the
  //     host then refuses. The two descriptions are what make the pair legible;
  //     without them "resolved" is a word a client has to guess at.
  //   - `agent.launch`'s `worktreeId`, 36 B. The action now fails closed when a
  //     headless caller omits it, so the old "Defaults to the active worktree"
  //     describes a behaviour only a person driving the UI still gets.
  // #12189 is within budget alone; #12312's `workspace.list` consumed the prior
  // headroom and only the landing order exceeds the ceiling.
  //
  // Raised here rather than on that branch because #12317, #12318 and #12319 are
  // all open against this same surface and would otherwise each re-raise it on
  // rebase.
  // 46_600 → 47_600, extending that same pre-spend to the two of those three
  // that actually cost bytes. Both were raising this constant on their own
  // branches and colliding with each other on every rebase:
  //   - #12318's `terminal.getStatus`, 462 B. An orchestrator holding a bound
  //     workspace whose view has been evicted had no way to read that terminal
  //     at all; the status is what makes an evicted binding reachable instead
  //     of merely reported.
  //   - #12319's `terminal.revealOwned`, 479 B. An owning session could act on
  //     its panel but not bring the user to it, so a client that needed a human
  //     to look had nothing to call.
  // #12317 spends nothing here — its additions are main-process resources, and
  // this budget measures the renderer action registry.
  // The cost of pre-spending is real: measured external usage on develop is
  // 46_332 B, so develop sits 1_268 B under its own ceiling until all three
  // land, and a spend that drifts into that window will not be caught. Once
  // #12189 (243 B), #12318 and #12319 are in, usage is 47_516 B and the ratchet
  // is back to biting with 84 B of slack.
  // 47_600 → 48_865 for #12338's `terminal.interruptOwned`. Most of the spend is
  // its output schema, and that is the tool rather than its prose: it is the one
  // tool here whose contract is mostly what it does NOT confirm.
  // `batchDoubleEscape` is a one-way `ipcRenderer.send`, so every outcome it can
  // report is something it asked for — `requested` or `requested-unverified`,
  // the latter meaning the target's CLI names no interrupt key at all — and
  // `agentStateAtDispatch` is the heuristic that gated the call rather than
  // evidence a turn was running. A caller that reads a bare success here retries
  // against an agent it never stopped, so each of those needs advertising.
  // 48_865 → 49_150 for the `hasPty` field #12342 added to `terminal.getStatus`
  // on develop; the tool is externally advertised, so this branch inherits the
  // 285 B on rebase rather than spending them.
  // 49_150 is develop's own measured total, not headroom: #12342's `hasPty` and
  // #12345's interrupt tools both landed while this branch was open, so it
  // inherits their bytes on rebase and spends only the 3_255 B below.
  // 49_150 → 52_500 for #12339's two wait tools, measured at 52_405 B. Almost
  // all of it is the output schemas they never advertised: 1_865 B for
  // `terminal.waitUntilIdle` and 1_366 B for the batch, against a net wait-tool
  // growth of 3_255 B.
  // Both carried a hand-written `rawOutputSchema` without `mcpOutputSchema`, so
  // `computeSchemas` produced nothing and `tools/list` published no output
  // contract at all — while the main-process short-circuit was already
  // attaching `structuredContent` on every call, with no advertised schema for
  // a client to validate it against. Turning the flag on is what closes that
  // mismatch, and the bytes are the contract itself, not decoration: the point
  // of the issue is that a reconciler cannot tell an agent that finished from a
  // session that is gone, and `trackingState` is only actionable if a generated
  // client can see it.
  // Not paid for by weakening the output schemas, whose structure is
  // AJV-validated client-side; the descriptions were tightened instead.
  // MAX_PROPERTIES_OVER_TARGET was deliberately NOT raised — `waitUntilIdle`'s
  // `terminalId` description was kept under the 160 B target instead.
  //
  // 52_500 → 54_100 for #12340's `terminal.setClientMetadata` plus the two
  // arguments it adds to `terminal.list`, measured at 54_039 B. The writer is
  // 1_126 B of the measured 1_634 — 370 B description, 542 B input schema,
  // 214 B output — and the rest
  // is the read: `includeClientMetadata` and `terminalId` on the existing
  // listing, plus the row field they return. Carrying the read there rather
  // than as a second tool is what holds the feature to one allowlist slot;
  // those two arguments are what make it opt-in and narrowable instead of
  // making every discovery call pay for records up to 2 KB each.
  //
  // Trimmed before raising, so the spend is the tool and not its prose: both
  // new property descriptions were brought under the 160 B one-clause target,
  // leaving MAX_PROPERTIES_OVER_TARGET untouched at 49.
  //
  // 54_100 → 55_900 for #12337's submission correlation, split across both
  // tools it takes to answer one question:
  //   - `terminal.sendCommand` gains an output schema it never had, so the
  //     `submissionToken` it now returns lands in validated `structuredContent`
  //     rather than only in the text body. A correlator a client has to scrape
  //     back out of prose is not a contract, and correlation is the entire
  //     point of the issue.
  //   - `terminal.getStatus` gains the `submissionToken` input and the
  //     `submission` record. Most of that record is the `phase` enum's
  //     description, and the length is load-bearing: `pty_written` is the
  //     strongest thing observable at this boundary, and a model that reads it
  //     as "the agent got it" would draw exactly the false conclusion this
  //     tracking exists to prevent.
  // Deliberately NOT funded by trimming the neighbouring `exitCode`,
  // `lastCheckResult` and `error` descriptions, which is where the ~1_500 B
  // would have to come from. Those are honesty caveats guarded by
  // `schemaDescriptions.test.ts`; spending them to buy room for a new caveat
  // trades one safeguard for another and nets nothing.
  // Re-measured at 55_850 B after #12346 landed `terminal.setClientMetadata`
  // on develop under this branch. This PR's own spend is unchanged at 1_811 B
  // over whatever develop measures; the step from 54_100 is that constant plus
  // #12346's inherited baseline, not a wider spend here.
  //
  // 55_900 → 56_400 for #12428, measured at 56_400 B. `lastOutputChangeAt` lands
  // on `terminal.getStatus` and both wait tools: 567 B, three copies of one
  // 126 B description plus the `unavailableFields` enum member. The field is the
  // whole fix. A spinner redraws for as long as a frozen turn sits there, so
  // `agentState` and `lastTransitionAt` never change, and without this a caller
  // can only tell a stalled agent from a busy one by pulling scrollback every
  // round. The description stays on all three because the name alone reads as
  // raw output time, and spinner redraws are exactly what it leaves out. It was
  // trimmed from 152 B before raising.
  //
  // 56_400 → 56_450, measured at 56_449 B. The `waitingReason` enum's `"prompt"`
  // arm used to read "empty input prompt (safe to auto-drive)". It is also the
  // classifier's fallback when nothing more specific matched
  // (`WaitingReasonClassifier`'s default branch), so a model that took the old
  // wording at face value would drive a wait it had not identified. Same
  // argument as the `pty_written` spend above: the length is the fix, because
  // the short version is the one that reads as a reassurance. Trimmed from
  // 144 B to 99 B before raising, for a net 49 B.
  //
  // 56_450 → 56_700 for #12478, measured at 56_662 B: 213 B for
  // `submission.outputChangeAfterWriteAt` on `terminal.getStatus`, most of it the
  // field's 151 B description. A submission can reach `pty_written` and be
  // dropped by an agent that has not finished starting, and a caller holding the
  // token had no way to see that the screen never moved after the Enter short of
  // pulling scrollback. The description has to say the value is an ordering and
  // not attribution, or a startup repaint reads as the agent taking the turn.
  // The tool description, at 383 of its 400 B, is untouched; what a caller
  // should do with an absent value lives in the help partials instead.
  // 56_700 → 59_650 for #12479's `terminal.readLastMessageOwned`, measured at
  // 59_609 B. Nearly all of it is the output schema, and that is the contract a
  // main-process tool has no other check on: nothing between the reader and the
  // client validates the result, so the client's AJV pass against these two
  // closed arms is what catches an `ok` missing its fields or an `unavailable`
  // carrying them. What the prose carries is what a caller would otherwise get
  // wrong — that `stopReason` is raw, that an unanswered tool call is not proof
  // the agent is waiting on it, and that `search-cap-reached` withholds an older
  // reply rather than passing it off as current. The reason and question-input
  // descriptions were trimmed before raising.
  // 59_650 → 61_350 for #12488's handback, measured at 61_306 B: a `handback`
  // argument on `terminal.sendCommandOwned` and `agent.launch`, and
  // `lastHandback` on the status entry and both wait results. The wait schemas carry only the
  // shared field description, never the per-message one, and every new
  // description sits under the 160-byte target. What stays is what a caller
  // would otherwise get wrong: that the marker is an observation rather than a
  // finish verdict, that its message is the agent's own lossy claim, that its
  // absence never means the agent is still working, and where it is refused.
  // 61_350 → 61_950 for #12496, measured at 61_940 B: `maxBytes`, `messageIndex`
  // and `cursor` on `terminal.readLastMessageOwned`, `message.nextCursor` on its
  // result, and the `message-not-found` reason. Without them an orchestrator
  // cannot reach the head of a long report or the report before a short reply,
  // and falls back to asking the agent to re-print it. The bounds are in the
  // descriptions because the wire strips `minimum`/`maximum`, and a caller that
  // misses them is refused rather than clamped. The tool description is
  // untouched.
  // 61_950 → 62_200 for #12535, measured at 62_181 B: `agentIncarnation` on
  // `terminal.getStatus`'s output. It is the only field that moves when an agent
  // exits and another is launched in the shell it left behind — `spawnedAt` is
  // the pty generation and holds, as do the pid and the restart count. A caller
  // holding an earlier reading has nothing else to tell that session from its
  // successor, and would otherwise go on addressing a conversation that ended.
  // Its description was written under the property target rather than over it.
  // 62_200 → 63_300 for #12717's `worktree.waitForPullRequest`, measured at
  // 63_298 B on top of #12745's `lastTypedInputAt`, which landed first and
  // took 285 B of the headroom — the tool's prose was cut again to absorb it
  // rather than raise past 63_300. The spend is its description, the
  // `worktreeIds`/`timeoutMs` arguments, and the output schema, since the per-worktree rows are read back as structured
  // content. `timedOut` names that detection pauses while the project is in
  // the background — without it a supervisor reads a string of expired waits
  // on a backgrounded project as "no PR yet". The property descriptions were
  // cut to the target before measuring.
  const MAX_EXTERNAL_PAYLOAD_BYTES = 63_300;
  // 190_000 → 192_700 for the same 2_048 B the external half above pays for.
  // Every byte #11909 spends sits on an externally advertised tool, so both
  // totals moved by the identical amount. Only this one needed the ratchet
  // raised: #11908's seven in-app tools had already taken the cohort to
  // 189_743, leaving 257 B of headroom that #11909 could not fit under.
  // 192_700 → 193_100 for #12091's `git.fetch`. In-app only — it is deliberately
  // absent from the external tier, which is why the external ceiling above did
  // not move. Its 151 B description sits well under the per-tool ceiling; the
  // rest is the `withWorktreeLocation` schema every git tool already carries.
  // 193_100 → 195_000 for #12123's `terminal.killBatch`. In-app only, so the
  // external ceiling again does not move. Most of its cost is the output schema:
  // the tool exists to tell five per-target outcomes apart — destroyed,
  // deselected by the approver, already gone, newly busy, teardown errored — and
  // a caller that cannot distinguish them will retry the ones a human just
  // refused, or the irreversible kills it was never told about. Naming them is
  // the tool, not decoration on it.
  // 195_000 → 202_700 for the forge read contracts and worktree readiness. Three
  // spends, all output schemas:
  //   - `forge.getPRs`, the plural lookup that removes the observed one-call-per-
  //     number fan-out. Its cost is per-number `status`, which is the whole
  //     point: `not_found` and `unresolved` are different answers, and a caller
  //     that conflates them closes work that exists.
  //   - `forge.getPR`, which now wraps its result as `{ pr }` so it can advertise
  //     an output schema at all — a top-level nullable emitted `anyOf`, which
  //     `buildToolOutputSchema` drops, so the tool advertised nothing.
  //   - `worktree.waitUntilReady` plus the `setupState` every worktree row now
  //     carries. Creation returns when git does, and nothing on this surface
  //     could previously say whether setup had finished.
  // In-app only — none of the three is on the external tier, which is why the
  // external ceiling above moves for a different reason and by a different
  // amount.
  // 202_700 → 203_000 for `worktree.create`'s output schema. Its result was a
  // bare `z.string()` worktree id, which `buildToolOutputSchema` drops for not
  // being object-rooted — so the tool advertised nothing at all. It is now
  // `{ worktreeId, branch }`, which is also what lets a caller learn the branch
  // the host actually landed on after collision recovery instead of assuming
  // the one it asked for.
  // 203_000 → 204_400 for the same closed union arms, plus the `forge.getPRs`
  // output schema becoming a discriminated union. That one repeats `number` and
  // `status` across three branches, and the repetition is the contract: with
  // `pr` and `reason` as independent optionals the advertised schema accepted
  // `{status:"found"}` with no PR and `{status:"not_found"}` carrying one —
  // contradictions a strict client would have validated as fine.
  // 204_400 → 204_685 for the same 285 B: `terminal.getStatus` sits on both
  // tiers, so the cohort total moved by the identical amount.
  // 204_685 → 207_900 for the same two output schemas as the external ceiling
  // above. Both wait tools are on the external tier, so both totals take the
  // identical spend; the two ceilings move by different amounts only because
  // they had different headroom to begin with, not because anything was trimmed
  // from one and not the other.
  // Measured at 207_890 B — the same 3_255 B on top of develop's 204_635.
  //
  // 207_900 → 209_600 for the same #12340 additions, measured at 209_524 B —
  // the identical 1_634 B, because every tool it touches is on both tiers. On
  // this branch alone the feature fitted under 204_400 with 5 B to spare, the
  // difference being one redundant word in the tool description. #12338,
  // #12342, #12343 and #12345 have all landed on develop since and spent that
  // window, so the cohort now carries the same additions as a raise rather
  // than absorbing them.
  //
  // 209_600 → 211_400 for #12337, measured at 211_335 B. Both tools are on the
  // external tier, so this total moves by the same 1_811 B as the external one
  // above and was re-measured over #12346's landing; it needs no separate
  // justification beyond the entry above.
  //
  // 211_400 → 212_000 for #12354's `forge.openRepo`, measured at 211_981 B. In-app
  // only — no forge tool is on the external tier — so the external ceiling above
  // does not move. The spend is its 168 B description plus the
  // `withProjectLocation` schema every project-scoped forge open action already
  // carries, and the tool is on this surface at all because every forge action has
  // to be reachable by the in-app assistant (`tierAuth.test.ts`).
  //
  // 212_000 → 214_000 for #12407's `terminal.sendCommandOwned` and
  // `terminal.injectOwned`, measured at 213_924 B — 1_943 B over the 211_981 B
  // before them. They sit on the action tier beside the unscoped pair, which the
  // assistant keeps, so this cohort carries both: 557 B of description, 659 B
  // of input schema and 727 B for the submission's output schema, repeated
  // rather than trimmed because the owned tool returns the delegate's receipt
  // and a client needs the `submissionToken` in validated structured content to
  // check delivery at all. The external ceiling above does not move — there the
  // owned pair replaced the unscoped one.
  //
  // 214_000 → 214_300 for #12450, measured at 214_286 B. Terminal tails are now
  // fitted under the 50 KiB response budget instead of being cut into unparseable
  // JSON, so fewer lines can come back than were asked for, and the only way a
  // caller can tell is the output schema: `terminal.getStatus` gains
  // `recentOutputTruncated` and both `truncated` flags say what cut the tail.
  // Without that a short answer reads as a quiet terminal, which is the
  // misreading the issue was filed over. Both tools are on the external tier,
  // which absorbed the same spend inside its existing headroom.
  //
  // 214_300 → 214_900 for #12428, measured at 214_853 B: the same 567 B as the
  // external ceiling above, since all three tools are on both surfaces.
  //
  // 214_900 → 214_950 for the `waitingReason` `"prompt"` rewording, measured at
  // 214_902 B: the same 49 B as the external ceiling above, on one tool.
  //
  // 214_950 → 215_150 for #12478, measured at 215_115 B: the same 213 B as the
  // external ceiling above, since `terminal.getStatus` is on both surfaces. Both
  // figures were re-measured on top of #12477's `waitingReason` rewording, which
  // landed on develop first and is included in them.
  // 215_150 → 218_100 for #12479, measured at 218_062 B: the same tool as the
  // external raise above, carried at the workbench floor for the subset
  // invariant — the external surface may not reach past the assistant's.
  // 218_100 → 219_950 for #12488, measured at 219_927 B: the external raise
  // above plus the same argument on `terminal.sendCommand`, which is in-app
  // only.
  // 219_950 → 220_600 for #12496, measured at 220_561 B: the same spend as the
  // external raise above, on a tool that is on both surfaces.
  // 220_600 → 226_350 for #12491's four terminal-watch tools, measured at
  // 226_301 B. In-app only — an api-key client has no pane to wake, so the
  // external ceiling above does not move. The spend is 1_101 B of description,
  // the watch arguments, and output schemas for all four: the observations and
  // the wake's standing are read back as structured content, and a client that
  // validates it needs the schema to accept it at all. Their property
  // descriptions were cut to the target before measuring.
  // 226_350 → 226_600 for #12535, measured at 226_541 B: the same spend as the
  // external raise above, on a tool that is on both surfaces.
  // 226_600 → 227_300 for #12611's `plugin.reloadPanel`, measured at 227_263 B.
  // In-app only, on the action tier, so the external ceiling above does not
  // move. The spend is its 257 B description, the `panelId` argument, and the
  // output schema: the scheduling outcome is read back as structured content.
  // 227_300 → 133_800 for the core/full split, measured at 133_792 B across 79
  // tools (227_075 B across 181 before it). The workbench/action/system ladder
  // became two tool sets, and every tool on neither — git, forge writes and the
  // `forge.open*` family, file reads, portal, theme and settings writes, session
  // bookmarks, the recipe editor, fleet arming and the bulk kills — is off MCP
  // entirely, so the cohort is the `full` set plus the owned twins an agent pane
  // is served in place of the unscoped ids. Lowered rather than left: 93 KB of
  // headroom would let the surface grow back to its old size without a single
  // raise having to be argued. The external ceiling above does not move — that
  // list is unchanged.
  // 133_800 → 129_800 for terminal notices, measured at 129_791 B across 76
  // tools. The four watch tools and their output schemas left MCP; in their
  // place are `terminal.notifyWhenIdle` on core and a `notify` argument on the
  // three submit paths. The external ceiling above does not move: an api-key
  // client has no pane to notify, so `notify` is not advertised to it.
  // 129_800 → 132_000 for the three batch tools, measured at 131_984 B. As
  // with the description total, `terminal.sendKeys(Owned)` and `replyLines`
  // were fitted under the old ceiling by trimming; the batch tools replace a
  // call per participant per round, so a four-agent vote costs 4 calls
  // instead of 12. They carry no output schema, which keeps each near 700 B.
  // The external ceiling does not move.
  const MAX_COHORT_PAYLOAD_BYTES = 132_000;

  const wireBytes = (t: WireTool) => t.descriptionBytes + t.paramsBytes + t.outputBytes;

  it("keeps the third-party client surface within budget", async () => {
    const tools = await surface();
    // Measured as an api-key client receives it: arguments that need a pane of
    // the caller's own are not advertised to that tier.
    const total = tools
      .filter((t) => t.external)
      .reduce((sum, t) => sum + t.descriptionBytes + t.externalParamsBytes + t.outputBytes, 0);

    expect(total).toBeLessThanOrEqual(MAX_EXTERNAL_PAYLOAD_BYTES);
  });

  it("keeps the full in-app surface within budget", async () => {
    const tools = await surface();
    const total = tools.reduce((sum, t) => sum + wireBytes(t), 0);

    expect(total).toBeLessThanOrEqual(MAX_COHORT_PAYLOAD_BYTES);
  });

  it("measures a surface that is actually there", async () => {
    // Guards the guard: a harness that silently returned nothing would satisfy
    // every ceiling above while proving the opposite of what it claims. The
    // floor is the `full` tool set, since the cohort is that set plus the owned
    // twins and the external roster, both of which may overlap it.
    const tools = await surface();
    expect(tools.length).toBeGreaterThanOrEqual(HELP_TIER_CUMULATIVE.full.length);
    expect(tools.filter((t) => t.external).length).toBeGreaterThan(15);
  });
});
