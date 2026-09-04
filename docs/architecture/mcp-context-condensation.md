# MCP context condensation

The authoring standard for every string Daintree pays to send to a model on every turn: tool descriptions, field descriptions, and the JSON Schemas that carry them. It applies to the action manifest, because that manifest _is_ the tool surface of the [MCP server](./mcp-server.md).

This is the Daintree-side half of a standard shared with the assistant CLI. The two repos condense different artifacts (the CLI owns its own tool schemas; this repo owns actions, their schemas, and the prose on both) but the rules below and the reasoning in [What must not be cut](#what-must-not-be-cut) are the same on both sides.

## Why it exists

The tool region is the largest single part of an MCP request, it is re-sent on every round including tool-continuation rounds where nothing the user typed changed, and clients cap what they will accept — Cursor silently truncates past its cap, Copilot hard-errors at 128 tools. #11585 already cut the external surface from 100 tools to the high twenties for exactly this reason. That cut attacked tool _count_; this standard attacks _bytes per tool_, which is the axis left over.

The two surfaces differ by an order of magnitude: a third-party client sees only the external roster ([`shared/config/mcpExternalTierAllowlist.ts`](../../shared/config/mcpExternalTierAllowlist.ts)), while the in-app assistant's cumulative `system` tier is several times larger. Take the current byte figures from the ratchets below rather than from prose, which drifts the moment a tool lands.

## The idempotency contract

Every rule below is a **predicate on the finished text**, not an instruction to shorten. Applying a predicate that already holds changes nothing, which is what makes the rules safe to re-run in CI and safe to hand to a model as a rewrite instruction.

"Shorten this" is not idempotent. It compounds on every pass and erodes meaning until something breaks, the same way iterated conversation compaction degrades a transcript. So:

- Every rule names a **normal form**, not a direction of travel.
- Budgets are **ceilings that gate**, never targets to approach. Text already under a ceiling is left alone; a ceiling never instructs a rewrite by itself.
- No rule references the previous version of the text. "Remove redundancy with what came before" cannot be evaluated on the artifact alone and will not converge.
- Anything still over a ceiling after one normalization pass gets **split or moved to a shared home** — never a second trim pass. A second trim is where idempotency dies.

## What must not be cut

Read this before the budgets. Over-compression is worse than no compression, and the failure is invisible until routing quality drops: the model picks the neighbouring tool, and nothing in the size numbers says so.

The following is **protected content**. It may never be removed to meet a budget. If something cannot fit its ceiling with these intact, it is too big and must be split, not trimmed:

1. **Disambiguation against a named sibling** — "use the batched wait for several terminals". This is what stops the model picking the neighbour, and it is the first thing a naive compressor deletes because it reads as an aside.
2. **Negative constraints** — "Leave unset over MCP, where the bridge stamps its own origin." A prohibition is not padding.
3. **Non-obvious shape requirements** — "supplying an empty list is rejected rather than treated as no scoping". These exist because a caller got it wrong.
4. **Per-property semantics** — what a parameter _means_, as distinct from its type. `cadenceMs: integer` is not a substitute for the unit and the thing being timed.
5. **Units, defaults, and return shape** — "defaults to 60s", "returns the panel id".

The budgets target repetition, ceremony, and prose that restates the schema. They do not target meaning.

## The wire/validation split

The single structural change, and the reason the rest is safe.

`argsSchema` (zod) is the authoritative schema. `ActionService.dispatch` validates every call against it; the emitted JSON Schema is never fed back into a validator, so it exists only to be advertised. That makes the two a projection rather than a fork — there is no second schema to hand-maintain, and none to rot.

`toWireSchema` ([`shared/utils/mcpWireSchema.ts`](../../shared/utils/mcpWireSchema.ts)) drops the value-range family — `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minProperties`, `maxProperties`, `minContains`, `maxContains`, `pattern` — from the **input** schemas that ride `tools/list`. Constrained-decoding backends do not enforce these at the token-masking level, so they arrive as plain prompt text: billed every turn, routinely violated anyway, and able to degrade output when the model's chosen path contradicts one.

Server-side enforcement is untouched, though it is worth being precise about which enforcement, because it is not one mechanism. Renderer-dispatched actions are checked by `argsSchema.safeParse`; plugin-contributed actions by the plugin host's own AJV pass against the original descriptor schema; main-process tools (the idle waits, `skills.*`, `mcp.surface`, `project.runCheck`) by their own hand-written argument checks. None of the three reads this projection, so none of them weakens when it drops a keyword.

**Output schemas are deliberately NOT projected.** An advertised `outputSchema` is not advertisement, it is an enforced contract: the MCP SDK compiles it and validates `structuredContent` against it with AJV on the client, and AJV does enforce the value-range family. Stripping it would delete real validation rather than dead prompt text, and it would bite hardest on main-process tools, which never reach the `resultSchema` check that covers renderer dispatches — for those the client's AJV pass is the only validation there is.

Two consequences worth stating:

- **A bound the caller needs is prose, not a keyword.** Put it in the field's `.describe()`, where it survives the projection and reads as the instruction it is.
- **`additionalProperties: false` is deliberately not stripped.** With a complete `required` array it is what lets a strict backend build a deterministic mask, and it measurably reduces hallucinated keys. Stripping it would cost accuracy to save bytes.

The walk is keyword-aware rather than name-aware, because a schema may legally declare a _property_ called `pattern` or `maximum`. A blind key-delete would silently un-advertise a required argument — a failure with no error anywhere.

`actions.getSchema` is deliberately left un-projected. It is an on-demand single-entry fetch rather than a per-turn cost, which makes it the escape hatch where full constraints stay visible.

The `mcp.surface` compatibility hash is likewise computed from the **unprojected** input schema. That digest answers "would my existing calls still work", and tightening a `maximum` from 100 to 50 breaks calls that used to succeed — hashing the projected view would let exactly that change pass silently. Compatibility is a property of what the server accepts, not of what the model is shown.

## Normal forms

### Tool description

In order, and nothing else:

1. **One imperative sentence** naming the action. Present tense, no leading article, no "This tool…", no restatement of the tool's own name.
2. Optional — a **trigger clause** ("Use this to…"), only when the action sentence does not already imply it.
3. Optional — **disambiguation** naming a sibling. In this repo siblings are named in _prose_, not by action id: a client rewrites every character outside `[A-Za-z0-9_-]` when it namespaces a tool, so a literal `terminal.list` in a description points at a name the model was never shown. `actionDefinitions.quality.test.ts` enforces this.
4. Optional — **prohibitions and shape traps**.
5. Optional — **return shape**, one clause.

Predicates, all enforced:

- No sentence restates a parameter's name, type, or default — the schema carries those adjacently and the model reads both.
- No cross-reference to another tool by action id.
- No marketing language ("powerful", "flexible", "comprehensive", "seamlessly").
- No sentence that would still be true if the tool did the opposite thing.

### Field description

One clause: what the value means, and its unit. Not its type, not its presence rules — `required` already says that. A field whose meaning is fully carried by its name and `enum` takes **no** description.

**Shared vocabulary is defined once.** Where a concept appears on many tools — worktree and project selectors, spawn provenance, focus policy — it is described on the shared schema and inherited, not restated per tool. `locationArgs.ts` is the worked example: four descriptions cover 94 advertised properties.

## Budgets

Enforced by [`src/services/actions/__tests__/mcpWireBudget.test.ts`](../../src/services/actions/__tests__/mcpWireBudget.test.ts), measured from the live registry rather than a fixture, so a captured copy cannot drift while the gates keep passing.

| Constant | Governs | Kind |
| --- | --- | --- |
| `MAX_TOOL_DESCRIPTION_BYTES` (400 B) | one tool description | hard ceiling |
| `MIN_DESCRIPTION_BYTES` (120 B) | one tool description | hard floor (`actionDefinitions.quality.test.ts`) |
| `PROPERTY_DESCRIPTION_TARGET_BYTES` (160 B) | one field description | target, ratcheted by count (`MAX_PROPERTIES_OVER_TARGET`) and by total excess (`MAX_EXCESS_PROPERTY_BYTES`) |
| `MAX_PROPERTY_DESCRIPTION_BYTES` (320 B) | one field description | hard ceiling |
| `MAX_TOOL_PARAMS_BYTES` (1,500 B) | one tool's `parameters` | hard ceiling, justified allowlist |
| `MAX_EXTERNAL_PAYLOAD_BYTES` | the whole external wire surface | aggregate ratchet |
| `MAX_COHORT_PAYLOAD_BYTES` | the whole in-app wire surface | aggregate ratchet |
| — | value-range keywords on the wire | hard: zero |

The two aggregate ratchets are the ones that move. Read their current values from `mcpWireBudget.test.ts`, where each raise sits beside the comment justifying it — that comment history is the record of what the surface has been allowed to spend, and why.

The aggregate ratchets bound the description-and-schema payload — the part authors control and the part that moves. They are deliberately not the full serialized `tools/list` byte count, which also carries tool names, annotations, `_meta.examples` and JSON framing that this standard does not govern.

The field-description target is a **count ratchet** (paired with a total-excess ratchet, so the same thirty descriptions cannot each grow from 161 B to 319 B unnoticed) rather than a hard ceiling, and that is a deliberate local calibration. #11542 moved field semantics out of tool descriptions and into `.describe()` so the top-level prose could shrink; enforcing 160 B here would push that text back up into the tool description now capped at 400 B, or delete it. What sits above the target today is protected content. The ratchet may fall freely; raising it is a deliberate act that belongs in a commit message with a reason.

Two allowlists carry a written reason per entry — oversized `parameters`, keyed by tool, and oversized field descriptions, keyed by `toolId :: schema path`. The second is path-scoped on purpose: exempting a whole tool would silently extend the exemption to every field added to it later. Both are checked for staleness against the ceiling they exempt, because an entry that no longer needs its exemption would otherwise go on covering the next regression.

### Raising a ratchet

Every budget above may fall freely. Raising one is a deliberate act, and the reason has to be one of these — anything else means the budget is doing its job and the change is what should give way:

1. **The surface genuinely grew.** A new tool was added on purpose, or an existing one gained an argument it needs. The ratchet moves by roughly what that addition costs, in the same commit that adds it.
2. **Protected content was restored.** A clause came back because it was cut in error — see [What must not be cut](#what-must-not-be-cut). Name the clause.
3. **The measurement changed, not the surface.** The harness started counting something it should always have counted. Say what, and expect the number to jump once and then hold.

What is **not** a reason: a tool that came in over budget and would fit if some unrelated prose were trimmed. That trade is the failure mode this whole standard exists to prevent — it pays for a new tool with the disambiguation clause on an old one, and the bill arrives as a routing regression nobody traces back. If a new tool does not fit, the options are to shrink _that tool_, to drop something from the tier, or to raise the ceiling on the record. Not to go hunting elsewhere.

Headroom is deliberately thin — the external aggregate sits within a couple of percent of its ceiling — so this decision will come up on roughly the next tool added. It is written down here so it gets made on the merits rather than under deadline.

## Application order

Fixed, so that two conforming passes cannot disagree about which rule fired first.

1. Project the wire view (mechanical, no judgment).
2. Delete restated types, defaults, and presence rules (mechanical).
3. Delete hedges, boasts, and provenance (mechanical).
4. Normalize to the forms above (judgment).
5. Re-measure. Anything still over ceiling goes to step 6 — **never back to step 4**.
6. Split the tool, or move the text to a shared schema.

Steps 1–3 are safely automatable. Steps 4–6 touch meaning and are reviewed against [What must not be cut](#what-must-not-be-cut).

## Measuring

The gates fail with the offending ids and byte counts, so the suite is the report:

```bash
npx vitest run src/services/actions/__tests__/mcpWireBudget.test.ts
```

`measureWireSurface()` in [`src/services/actions/__tests__/helpers/wireSurface.ts`](../../src/services/actions/__tests__/helpers/wireSurface.ts) returns the per-tool breakdown (description, params, output, and every field description with its path) if you need to rank candidates rather than check a ceiling.

## Open questions

- **`$ref` / `$defs` deduplication.** Schemas are emitted with `reused: "inline"`, so a shared shape is duplicated at every use site. Deduplicating is legal, but whether it saves _prompt_ tokens is unresolved: providers generally dereference or compile the schema before it reaches the model's context, in which case `$ref` shrinks the HTTP payload and not the billed prompt. Resolve it by measuring reported prompt tokens on one tool both ways before adopting it anywhere.
- **Output schemas.** They ride `tools/list` and are 43 KB of the in-app surface, a quarter of it, and nothing here governs them: the wire projection is deliberately withheld (it would delete client-side validation) and the prose rules were written for arguments. Shrinking them means returning less, or returning it in a flatter shape — a design question, not an authoring one.
- **Whether the tool inventory has the right shape.** Orchestration tools are mostly verbs over a small set of nouns (terminal, agent, worktree, recipe), which invites collapsing each noun into one polymorphic tool. The atomicity ceiling deliberately pushes the other way, because overloaded multi-mode tools measure badly against atomic ones. The tension is real: the win may be entirely in bytes-per-tool rather than in tool count. Resolve it with a measurement, not an intuition.
