import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  buildCatalogService,
  buildKeybindingHarness,
  EMPTY_CONTEXT,
  eventForCombo,
  FULL_CONTEXT,
  getSharedCatalog,
  loadActionModules,
  makeKeyEvent,
  PROBE_CONFIRM_ID,
  PROBE_DISABLED_REASON,
  PROBE_ECHO_ID,
  PROBE_GATED_ID,
  PROBE_PALETTE_ID,
  PROBE_PALETTE_REASON,
  WHEN_BINDINGS,
  WHEN_CONTEXT_MODAL,
  WHEN_CONTEXT_TERMINAL,
  type ActionManifestRow,
  type CatalogService,
} from "../lib/actionDispatchFixture";

// Action dispatch, enablement, MCP tool-surface generation and keybinding
// resolution — the layer CLAUDE.md calls "the typed dispatch layer behind menus,
// keybindings, context menus, and agent automation". Everything here drives the
// shipped `ActionService`, the shipped ~495-action catalog, the shipped
// `KeybindingService` and the shipped main-process `tools/list` projection.
// `lib/actionDispatchFixture.ts` states exactly what is real and what is not;
// the short version is that no real action's `run()` is ever entered, because
// `run()` bodies need a renderer.

const MCP_TIERS = ["workbench", "action", "system", "external"] as const;

/**
 * How many real actions of each rejection shape to include in the dispatch
 * script. Large enough that one action's oddity cannot carry the number,
 * small enough that the script stays a keystroke-scale workload.
 */
const REJECT_SAMPLE = 12;
const OK_DISPATCHES = 24;

/** One row of the `tools/list` payload, as sessionServer assembles it. */
interface ProjectedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: { examples: unknown[] };
}

interface DispatchStep {
  actionId: string;
  args: unknown;
  source: string;
  contextOverride?: Record<string, unknown>;
  /** Expected `ActionError.code`, or null for a successful dispatch. */
  expectCode: string | null;
}

interface DispatchPlan {
  catalog: CatalogService;
  steps: DispatchStep[];
}

let dispatchPlanPromise: Promise<DispatchPlan> | null = null;

/**
 * Build the dispatch script once. Every real-action step is one the gate chain
 * rejects BEFORE `run()`; the successful path uses the fixture's probe action.
 * Expectations are derived from the manifest the service itself produces, never
 * from a hardcoded id list, so a product change moves the plan rather than
 * breaking the oracle.
 */
function getDispatchPlan(): Promise<DispatchPlan> {
  dispatchPlanPromise ??= (async () => {
    const { catalog } = await getSharedCatalog();
    const manifest = catalog.service.list(FULL_CONTEXT);
    const steps: DispatchStep[] = [];

    steps.push({
      actionId: "perf.no.such.action",
      args: undefined,
      source: "agent",
      expectCode: "NOT_FOUND",
    });

    // A number can never satisfy an object schema, so these are rejected by
    // `argsSchema.safeParse` — the first gate, ahead of `isEnabled`.
    const objectSchemaArgActions = manifest
      .filter((entry) => entry.requiresArgs && entry.inputSchema?.["type"] === "object")
      .slice(0, REJECT_SAMPLE);
    for (const entry of objectSchemaArgActions) {
      steps.push({
        actionId: entry.id,
        args: 12345,
        source: "agent",
        expectCode: "VALIDATION_ERROR",
      });
    }

    // `isEnabled` runs after args validation, so only argument-free actions
    // reach the disabled gate with `undefined` args.
    const disabledActions = manifest
      .filter((entry) => !entry.enabled && !entry.requiresArgs)
      .slice(0, REJECT_SAMPLE);
    for (const entry of disabledActions) {
      steps.push({ actionId: entry.id, args: undefined, source: "agent", expectCode: "DISABLED" });
    }

    // The gate an MCP client hits on every destructive tool it is offered.
    const confirmActions = manifest
      .filter((entry) => entry.danger === "confirm" && entry.enabled && !entry.requiresArgs)
      .slice(0, REJECT_SAMPLE);
    for (const entry of confirmActions) {
      steps.push({
        actionId: entry.id,
        args: undefined,
        source: "agent",
        expectCode: "CONFIRMATION_REQUIRED",
      });
    }

    steps.push({
      actionId: PROBE_CONFIRM_ID,
      args: undefined,
      source: "agent",
      expectCode: "CONFIRMATION_REQUIRED",
    });
    steps.push({
      actionId: PROBE_GATED_ID,
      args: undefined,
      source: "agent",
      contextOverride: EMPTY_CONTEXT,
      expectCode: "DISABLED",
    });
    steps.push({
      actionId: PROBE_ECHO_ID,
      args: { n: "not-a-number" },
      source: "agent",
      expectCode: "VALIDATION_ERROR",
    });

    // The only dispatches allowed to reach `run()`: args validation, the
    // enablement gate, the danger gate, `run()`, result-schema validation and
    // the repeat/hint bookkeeping, all on real product code.
    for (let i = 0; i < OK_DISPATCHES; i += 1) {
      steps.push({
        actionId: PROBE_ECHO_ID,
        args: { n: i, label: `perf-${i}` },
        source: i % 2 === 0 ? "agent" : "user",
        expectCode: null,
      });
    }

    return { catalog, steps };
  })();
  return dispatchPlanPromise;
}

interface ScaledCatalogs {
  scales: Array<{ size: number; catalog: CatalogService }>;
}

let scaledCatalogsPromise: Promise<ScaledCatalogs> | null = null;

/**
 * Catalogs at 1x, 2x and 4x the shipped size, built once. Registration is not
 * what PERF-205 measures, so it is deliberately outside the timed bracket.
 */
function getScaledCatalogs(): Promise<ScaledCatalogs> {
  scaledCatalogsPromise ??= (async () => {
    const mods = await loadActionModules();
    const base = buildCatalogService(mods);
    const scales = [{ size: base.actionCount, catalog: base }];
    for (const multiplier of [2, 4]) {
      const catalog = buildCatalogService(mods, {
        clones: base.actionCount * (multiplier - 1),
      });
      scales.push({ size: catalog.actionCount, catalog });
    }
    return { scales };
  })();
  return scaledCatalogsPromise;
}

export const actionDispatchScenarios: PerfScenario[] = [
  {
    id: "PERF-200",
    name: "Action Registry - Catalog Registration",
    description:
      "Build the real built-in action catalog with createActionDefinitions() and register every " +
      "definition into a fresh ActionService. This is the renderer's action_registry:register " +
      "span: ~495 definition objects constructed and registered, with register() computing " +
      "requiresArgs through each action's own zod schema (JSON-Schema compilation stays deferred, " +
      "per #8614). registerMs is the number on the cold-start path; builtInRegistrationMisses " +
      "reads the registry back against BUILT_IN_ACTION_IDS.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 16 },
    warmups: 2,
    correctness: ["builtInRegistrationMisses"],
    async run() {
      const mods = await loadActionModules();

      const start = performance.now();
      const catalog = buildCatalogService(mods);
      const durationMs = performance.now() - start;

      // Independent oracle: the shipped id list, read back out of the registry.
      // A register() that stored nothing finishes instantly and scores 397.
      let builtInRegistrationMisses = 0;
      for (const id of mods.BUILT_IN_ACTION_IDS) {
        if (!catalog.service.has(id)) builtInRegistrationMisses += 1;
      }

      return {
        durationMs,
        metrics: {
          registeredActionCount: catalog.actionCount,
          builtInActionCount: mods.BUILT_IN_ACTION_IDS.length,
          factoryMs: catalog.factoryMs,
          registerMs: catalog.registerMs,
          builtInRegistrationMisses,
        },
      };
    },
  },
  {
    id: "PERF-201",
    name: "Action Dispatch - Gate Chain",
    description:
      "Drive ActionService.dispatch() through every outcome an MCP tool call or a keybinding can " +
      "produce against the real catalog: NOT_FOUND, VALIDATION_ERROR (real zod argsSchemas), " +
      "DISABLED (real isEnabled predicates), CONFIRMATION_REQUIRED (real danger gate from an " +
      "agent source) and a successful dispatch through run() plus resultSchema validation on a " +
      "harness-owned probe action. No real action's run() is entered — those need a renderer — " +
      "and window.electron is absent, so the action:dispatched IPC leg is NOT in these numbers.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["dispatchOutcomeMisses"],
    async run() {
      const { catalog, steps } = await getDispatchPlan();
      const service = catalog.service;

      const perDispatch: number[] = [];
      let okDispatchCount = 0;
      let rejectedDispatchCount = 0;
      // Every step declares the outcome the gate chain owes it. A service that
      // answered every call the same way — the shape a dead dispatcher takes —
      // cannot satisfy five different expected codes at once.
      let dispatchOutcomeMisses = 0;

      const start = performance.now();
      for (const step of steps) {
        const options: Record<string, unknown> = { source: step.source };
        if (step.contextOverride) options.contextOverride = step.contextOverride;
        const t0 = performance.now();
        const result = await service.dispatch(step.actionId, step.args, options);
        perDispatch.push(performance.now() - t0);

        if (result.ok) {
          okDispatchCount += 1;
          if (step.expectCode !== null) dispatchOutcomeMisses += 1;
        } else {
          rejectedDispatchCount += 1;
          if (result.error?.code !== step.expectCode) dispatchOutcomeMisses += 1;
        }
      }
      const durationMs = performance.now() - start;

      // The probe's disabled path must carry its own reason through, not a
      // generic fallback — proof the gate read the definition and not a default.
      const gated = await service.dispatch(PROBE_GATED_ID, undefined, {
        source: "agent",
        contextOverride: EMPTY_CONTEXT,
      });
      if (gated.ok || gated.error?.message !== PROBE_DISABLED_REASON) {
        dispatchOutcomeMisses += 1;
      }

      return {
        durationMs,
        metrics: {
          dispatchCount: perDispatch.length,
          okDispatchCount,
          rejectedDispatchCount,
          registeredActionCount: catalog.actionCount,
          avgDispatchMs: perDispatch.reduce((sum, ms) => sum + ms, 0) / perDispatch.length,
          p95DispatchMs: percentile(perDispatch, 95),
          dispatchOutcomeMisses,
        },
      };
    },
  },
  {
    id: "PERF-202",
    name: "Action Manifest - Enablement Sweep",
    description:
      "ActionService.list(ctx, { includeSchemas: false }) over the real catalog — the palette's " +
      "per-context re-projection, which runs every isVisible, isEnabled, disabledReason and " +
      "palette.requireContext predicate across ~495 actions. Swept under a cold-window context " +
      "and a fully-loaded one; contextFlipCount is how many actions actually change enablement " +
      "between the two, which is the signal a predicate that went constant would erase.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["enablementMisses"],
    async run() {
      const { mods, catalog } = await getSharedCatalog();
      const service = catalog.service;
      const SWEEPS = 8;

      const perSweep: number[] = [];
      let emptyEntries: ActionManifestRow[] = [];
      let fullEntries: ActionManifestRow[] = [];

      const start = performance.now();
      for (let i = 0; i < SWEEPS; i += 1) {
        const t0 = performance.now();
        emptyEntries = service.list(EMPTY_CONTEXT, { includeSchemas: false });
        perSweep.push(performance.now() - t0);

        const t1 = performance.now();
        fullEntries = service.list(FULL_CONTEXT, { includeSchemas: false });
        perSweep.push(performance.now() - t1);
      }
      const durationMs = performance.now() - start;

      const enabledByIdEmpty = new Map(emptyEntries.map((entry) => [entry.id, entry.enabled]));
      let contextFlipCount = 0;
      for (const entry of fullEntries) {
        const before = enabledByIdEmpty.get(entry.id);
        if (before !== undefined && before !== entry.enabled) contextFlipCount += 1;
      }

      // Two independent readings. The first proves the WHOLE shipped catalog
      // was projected (a truncated or empty listing scores the miss); the
      // second proves the predicates were actually called with the context
      // handed in, which a listing built from cached constants cannot fake.
      let enablementMisses = 0;
      const fullIds = new Set(fullEntries.map((entry) => entry.id));
      for (const id of mods.BUILT_IN_ACTION_IDS) {
        if (!fullIds.has(id)) enablementMisses += 1;
      }
      const gatedFull = fullEntries.find((entry) => entry.id === PROBE_GATED_ID);
      const gatedEmpty = emptyEntries.find((entry) => entry.id === PROBE_GATED_ID);
      const paletteFull = fullEntries.find((entry) => entry.id === PROBE_PALETTE_ID);
      const paletteEmpty = emptyEntries.find((entry) => entry.id === PROBE_PALETTE_ID);
      if (gatedFull?.enabled !== true) enablementMisses += 1;
      if (gatedEmpty?.enabled !== false || gatedEmpty.disabledReason !== PROBE_DISABLED_REASON) {
        enablementMisses += 1;
      }
      if (paletteFull?.paletteDisabled !== undefined) enablementMisses += 1;
      if (
        paletteEmpty?.paletteDisabled !== true ||
        paletteEmpty.paletteDisabledReason !== PROBE_PALETTE_REASON
      ) {
        enablementMisses += 1;
      }

      return {
        durationMs,
        metrics: {
          manifestEntryCount: fullEntries.length,
          enabledEntryCount: fullEntries.filter((entry) => entry.enabled).length,
          disabledEntryCount: fullEntries.filter((entry) => !entry.enabled).length,
          paletteHiddenCount: fullEntries.filter((entry) => entry.paletteHidden).length,
          paletteDisabledCount: fullEntries.filter((entry) => entry.paletteDisabled).length,
          contextFlipCount,
          avgSweepMs: perSweep.reduce((sum, ms) => sum + ms, 0) / perSweep.length,
          p95SweepMs: percentile(perSweep, 95),
          enablementMisses,
        },
      };
    },
  },
  {
    id: "PERF-203",
    name: "MCP Tool Surface - tools/list Generation",
    description:
      "The public tool surface an external agent sees. Compiles the manifest cold (zod " +
      "toJSONSchema over ~307 argument schemas, deferred off cold start by #8614 and paid on " +
      "first MCP connection), then runs the real tools/list projection — shouldExposeTool, " +
      "buildToolInputSchema, buildAnnotations, buildToolOutputSchema — at all four tiers, plus " +
      "buildSurfaceManifest's sha256 compatibility digest. The advertised payload bytes are a " +
      "public contract billed on every turn, and are machine-independent — so every advertised tool " +
      "is graded against what its definition declared, since a surface stripped of its schemas and " +
      "annotations is both cheaper and smaller.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 16 },
    warmups: 2,
    correctness: ["surfaceMisses", "toolSchemaMisses"],
    async run() {
      const mods = await loadActionModules();
      // Fresh service: the schema cache is per-service and this scenario's
      // headline is the COLD compile a first MCP connection pays.
      const catalog = buildCatalogService(mods);
      const service = catalog.service;

      const start = performance.now();
      const coldStart = performance.now();
      const manifest = service.list(FULL_CONTEXT);
      const coldManifestMs = performance.now() - coldStart;

      const warmStart = performance.now();
      service.list(FULL_CONTEXT);
      const warmManifestMs = performance.now() - warmStart;

      const toolCountByTier: Record<string, number> = {};
      const payloadBytesByTier: Record<string, number> = {};
      const toolsByTier = new Map<string, ProjectedTool[]>();
      const surfaceByTier = new Map<string, { hash: string; toolCount: number }>();
      let surfaceHashMs = 0;

      const projectionStart = performance.now();
      for (const tier of MCP_TIERS) {
        const exposed = manifest.filter((entry) =>
          mods.shouldExposeTool(entry, tier, mods.UNBOUND_SESSION_SURFACE)
        );
        // The exact shape sessionServer's ListToolsRequest handler returns.
        const tools: ProjectedTool[] = exposed.map((entry) => {
          const outputSchema = mods.buildToolOutputSchema(entry);
          const meta =
            entry.examples && entry.examples.length > 0 ? { examples: entry.examples } : undefined;
          return {
            name: entry.id,
            description: entry.description,
            inputSchema: mods.buildToolInputSchema(entry),
            annotations: mods.buildAnnotations(entry) as Record<string, unknown>,
            ...(outputSchema ? { outputSchema } : {}),
            ...(meta ? { _meta: meta } : {}),
          };
        });
        toolCountByTier[tier] = tools.length;
        payloadBytesByTier[tier] = Buffer.byteLength(JSON.stringify({ tools }), "utf8");
        toolsByTier.set(tier, tools);

        const hashStart = performance.now();
        const surface = mods.buildSurfaceManifest(manifest, tier, "0.0.0-perf");
        surfaceHashMs += performance.now() - hashStart;
        surfaceByTier.set(tier, { hash: surface.hash, toolCount: surface.tools.length });
      }
      const projectionMs = performance.now() - projectionStart;
      const durationMs = performance.now() - start;

      // Grading is outside the timed bracket: it is oracle work, not projection
      // work, and the advertised payload is what this scenario prices.

      // The listing owes back every action that was registered. Read against
      // the ids that went INTO register(), never against the listing itself —
      // an expectation derived from `list()` makes an empty listing vacuously
      // correct, and an empty listing is the smallest payload and the fastest
      // compile the harness could ever record.
      let surfaceMisses = 0;
      const entryById = new Map(manifest.map((entry) => [entry.id, entry]));
      for (const id of catalog.registeredIds) {
        if (!entryById.has(id)) surfaceMisses += 1;
      }

      let toolSchemaMisses = 0;
      // The compile half, over the whole manifest: a definition that declares an
      // argument schema is owed a JSON Schema in its entry. A builder that
      // emitted none would still produce well-formed, much cheaper tools.
      for (const [id, want] of catalog.expectations) {
        const entry = entryById.get(id);
        if (!entry) continue;
        if (want.expectsInputSchema && !entry.inputSchema) toolSchemaMisses += 1;
        if (want.expectsOutputSchema && !entry.outputSchema) toolSchemaMisses += 1;
      }

      for (const tier of MCP_TIERS) {
        // Re-derive the exposure set from the tier allowlist and the manifest's
        // own fields, never from shouldExposeTool. The two disagreeing is the
        // whole point of the reading.
        const permitted = mods.getTierPermittedActionIds(tier);
        const expected = new Set<string>();
        for (const id of permitted) {
          const entry = entryById.get(id);
          // An id the allowlist advertises that the catalog never produced.
          if (!entry) {
            surfaceMisses += 1;
            continue;
          }
          if (entry.danger !== "restricted" && entry.mcpVisibility !== "hidden") expected.add(id);
        }
        const tools = toolsByTier.get(tier) ?? [];
        const actual = new Set(tools.map((tool) => tool.name));
        for (const id of expected) if (!actual.has(id)) surfaceMisses += 1;
        for (const id of actual) if (!expected.has(id)) surfaceMisses += 1;

        const surface = surfaceByTier.get(tier);
        if (
          !surface ||
          !/^[0-9a-f]{64}$/.test(surface.hash) ||
          surface.toolCount !== expected.size
        ) {
          surfaceMisses += 1;
        }

        // The projection half, per advertised tool. Payload BYTES are the
        // headline and a tool stripped of its schema and annotations is much
        // cheaper, so each one is checked against what its definition declared.
        for (const tool of tools) {
          const want = catalog.expectations.get(tool.name);
          if (!want) {
            toolSchemaMisses += 1;
            continue;
          }
          const input = tool.inputSchema;
          if (input?.["type"] !== "object" || input["additionalProperties"] !== false) {
            toolSchemaMisses += 1;
          }
          const properties = input?.["properties"] as Record<string, unknown> | undefined;
          for (const name of want.argNames) {
            if (!properties || !(name in properties)) toolSchemaMisses += 1;
          }
          const annotations = tool.annotations;
          if (
            annotations?.["title"] !== want.title ||
            annotations["readOnlyHint"] !== want.readOnlyHint ||
            annotations["idempotentHint"] !== want.idempotentHint ||
            annotations["destructiveHint"] !== want.destructiveHint
          ) {
            toolSchemaMisses += 1;
          }
          const entry = entryById.get(tool.name);
          if (entry?.outputSchema?.["type"] === "object" && !tool.outputSchema) {
            toolSchemaMisses += 1;
          }
        }
      }

      const advertisedArgNames = [...catalog.expectations.values()].reduce(
        (sum, want) => sum + want.argNames.length,
        0
      );

      return {
        durationMs,
        metrics: {
          manifestEntryCount: manifest.length,
          registeredActionCount: catalog.actionCount,
          inputSchemaCount: manifest.filter((entry) => entry.inputSchema).length,
          outputSchemaCount: manifest.filter((entry) => entry.outputSchema).length,
          declaredArgNameCount: advertisedArgNames,
          workbenchToolCount: toolCountByTier.workbench ?? 0,
          externalToolCount: toolCountByTier.external ?? 0,
          systemToolCount: toolCountByTier.system ?? 0,
          workbenchToolPayloadBytes: payloadBytesByTier.workbench ?? 0,
          externalToolPayloadBytes: payloadBytesByTier.external ?? 0,
          systemToolPayloadBytes: payloadBytesByTier.system ?? 0,
          coldManifestMs,
          warmManifestMs,
          projectionMs,
          surfaceHashMs,
          surfaceMisses,
          toolSchemaMisses,
        },
      };
    },
  },
  {
    id: "PERF-204",
    name: "Keybinding Resolution - Per Keystroke",
    description:
      "KeybindingService.resolveKeybinding() over the real DEFAULT_KEYBINDINGS table plus " +
      "plugin-shaped bindings carrying when clauses. Every keydown is a full scan of every " +
      "registered binding with a parseCombo per candidate, so the no-match keystroke — the one " +
      "the app pays for most keys a user presses — is the worst case and is reported separately. " +
      "Covers chord prefixes, chord completion and the cancelled-chord path. The when-clause " +
      "parser and evaluator are real; the context snapshot is supplied through setWhenContext " +
      "because the live builder reads the DOM. bindingTableMisses predicates the scanned table " +
      "against DEFAULT_KEYBINDINGS itself, because a shorter table resolves faster on every " +
      "sample and the probed combos would keep matching.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["resolutionMisses", "bindingTableMisses"],
    async run() {
      const mods = await loadActionModules();
      const harness = buildKeybindingHarness(mods);
      const service = harness.service;

      const defaults = mods.DEFAULT_KEYBINDINGS;
      const plainBindings = defaults
        .filter((b) => b.scope === "global" && b.combo && !b.combo.includes(" "))
        .slice(0, 12);
      const chordBinding = defaults.find((b) => b.combo?.includes(" "));
      if (!chordBinding) throw new Error("no chord binding in DEFAULT_KEYBINDINGS");
      const [chordPrefix, chordSecond] = chordBinding.combo.split(" ") as [string, string];

      const REPEATS = 4;
      const hitSamples: number[] = [];
      const missSamples: number[] = [];
      const otherSamples: number[] = [];
      let resolutionMisses = 0;
      let resolutionCount = 0;

      const NO_BINDING_EVENT = () =>
        makeKeyEvent({ key: "F9", code: "F9", metaKey: true, altKey: true, shiftKey: true });

      const start = performance.now();
      for (let r = 0; r < REPEATS; r += 1) {
        service.setWhenContext(WHEN_CONTEXT_TERMINAL);

        for (const binding of plainBindings) {
          service.clearPendingChord();
          const event = eventForCombo(binding.combo);
          const t0 = performance.now();
          const result = service.resolveKeybinding(event);
          hitSamples.push(performance.now() - t0);
          resolutionCount += 1;
          // A bound combo must produce a match and must be swallowed, or the
          // keystroke would leak through to the terminal.
          if (!result.match || result.shouldConsume !== true) resolutionMisses += 1;
        }

        // The unbound keystroke: a full scan that matches nothing and must NOT
        // consume the event.
        service.clearPendingChord();
        for (let i = 0; i < 12; i += 1) {
          const t0 = performance.now();
          const result = service.resolveKeybinding(NO_BINDING_EVENT());
          missSamples.push(performance.now() - t0);
          resolutionCount += 1;
          if (result.match || result.chordPrefix || result.shouldConsume) resolutionMisses += 1;
        }

        // Chord prefix -> completion.
        service.clearPendingChord();
        let t = performance.now();
        const prefixResult = service.resolveKeybinding(eventForCombo(chordPrefix));
        otherSamples.push(performance.now() - t);
        resolutionCount += 1;
        if (
          prefixResult.match ||
          prefixResult.chordPrefix !== true ||
          service.getPendingChord() === null
        ) {
          resolutionMisses += 1;
        }
        t = performance.now();
        const completion = service.resolveKeybinding(eventForCombo(chordSecond));
        otherSamples.push(performance.now() - t);
        resolutionCount += 1;
        if (completion.match?.actionId !== chordBinding.actionId) resolutionMisses += 1;

        // Chord prefix -> a second key that completes nothing. The event must
        // still be consumed so it cannot type into a terminal.
        service.clearPendingChord();
        service.resolveKeybinding(eventForCombo(chordPrefix));
        t = performance.now();
        const cancelled = service.resolveKeybinding(NO_BINDING_EVENT());
        otherSamples.push(performance.now() - t);
        resolutionCount += 1;
        if (cancelled.match || cancelled.shouldConsume !== true) resolutionMisses += 1;
        if (service.getLastInvalidKey() === null) resolutionMisses += 1;
        service.clearLastInvalidKey();

        // when-gated bindings: the same keystroke must match under one context
        // and not under the other, which is the only thing that proves the
        // clause was parsed and evaluated rather than ignored.
        for (const contextName of ["terminal", "modal"] as const) {
          service.setWhenContext(
            contextName === "terminal" ? WHEN_CONTEXT_TERMINAL : WHEN_CONTEXT_MODAL
          );
          for (const binding of WHEN_BINDINGS) {
            service.clearPendingChord();
            t = performance.now();
            const result = service.resolveKeybinding(eventForCombo(binding.combo));
            otherSamples.push(performance.now() - t);
            resolutionCount += 1;
            const shouldMatch = binding.expectMatchUnder === contextName;
            const matched = result.match?.actionId === binding.actionId;
            if (matched !== shouldMatch) resolutionMisses += 1;
          }
        }
      }
      const durationMs = performance.now() - start;

      // Every keydown is a full scan, so the twelve probed combos price a table
      // the other hundred-odd rows are in. Deleting an unprobed default makes
      // every sample above faster and leaves each individual probe still
      // matching, so the scan's cardinality is predicated against the real
      // DEFAULT_KEYBINDINGS table rather than merely reported beside it. A
      // binding the registration guard refused removes a whole when-clause from
      // the scan, so the accepted count is graded the same way.
      let bindingTableMisses = harness.missingDefaultBindings;
      bindingTableMisses += Math.abs(harness.expectedBindingCount - harness.bindingCount);
      bindingTableMisses += Math.abs(WHEN_BINDINGS.length - harness.registeredWhenBindings);

      const all = [...hitSamples, ...missSamples, ...otherSamples];
      const avgUs = (samples: number[]) =>
        (samples.reduce((sum, ms) => sum + ms, 0) / Math.max(1, samples.length)) * 1000;

      return {
        durationMs,
        metrics: {
          resolutionCount,
          bindingCount: harness.bindingCount,
          expectedBindingCount: harness.expectedBindingCount,
          whenBindingCount: harness.registeredWhenBindings,
          hitResolveUs: avgUs(hitSamples),
          missResolveUs: avgUs(missSamples),
          avgResolveUs: avgUs(all),
          p95ResolveUs: percentile(all, 95) * 1000,
          resolutionMisses,
          bindingTableMisses,
        },
      };
    },
  },
  {
    id: "PERF-205",
    name: "Action Manifest - Catalog Scaling",
    description:
      "The same enablement sweep as PERF-202 against catalogs of 1x, 2x and 4x the shipped size, " +
      "built from id-renamed clones of the real definitions so the per-action predicate work is " +
      "the shipped work. list() is O(actions) and is re-run on every palette context change and " +
      "every MCP manifest fetch, so msPerKAction is the slope that decides whether the plugin " +
      "ecosystem can grow the catalog without the palette stuttering. Each scale must project back " +
      "every id registered into it, clones included: an implementation that caps the listing has " +
      "the flattest slope available. Registration is outside the timed bracket — PERF-200 owns that.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["scalingMisses"],
    async run() {
      const { scales } = await getScaledCatalogs();
      const REPEATS = 6;
      const sweepBySize = new Map<number, number>();
      const projectedBySize = new Map<number, ActionManifestRow[]>();
      let entriesProjected = 0;

      const start = performance.now();
      for (const { size, catalog } of scales) {
        const samples: number[] = [];
        let entries: ActionManifestRow[] = [];
        for (let r = 0; r < REPEATS; r += 1) {
          const t0 = performance.now();
          entries = catalog.service.list(FULL_CONTEXT, { includeSchemas: false });
          samples.push(performance.now() - t0);
        }
        entriesProjected += entries.length;
        sweepBySize.set(size, percentile(samples, 95));
        projectedBySize.set(size, entries);
      }
      const durationMs = performance.now() - start;

      // Graded outside the bracket: the slope is what this scenario prices, and
      // the oracle grows with the catalog while the sweep is what must.
      //
      // The whole point is the slope across 1x/2x/4x, so requiring only the
      // built-ins plus "at least one clone" pays an implementation that caps the
      // listing: it returns a constant number of rows at every scale, which is
      // the flattest and best-looking slope available. Each scale therefore owes
      // back the FULL projected set — every id that was registered into that
      // catalog, clones included.
      let scalingMisses = 0;
      for (const { size, catalog } of scales) {
        const ids = new Set((projectedBySize.get(size) ?? []).map((entry) => entry.id));
        for (const id of catalog.registeredIds) {
          if (!ids.has(id)) scalingMisses += 1;
        }
      }

      const largest = scales[scales.length - 1]!.size;
      const worstLargeMs = sweepBySize.get(largest) ?? 0;
      const expectedEntries = scales.reduce(
        (sum, scale) => sum + scale.catalog.registeredIds.length,
        0
      );

      return {
        durationMs,
        metrics: {
          baseActionCount: scales[0]!.size,
          largestActionCount: largest,
          entriesProjectedCount: entriesProjected,
          expectedEntriesCount: expectedEntries,
          sweepMsBase: sweepBySize.get(scales[0]!.size) ?? 0,
          sweepMsLargest: worstLargeMs,
          msPerKAction: worstLargeMs / (largest / 1000),
          scalingMisses,
        },
      };
    },
  },
];
