import { describe, expect, it } from "vitest";

import {
  buildCatalogService,
  buildKeybindingHarness,
  EMPTY_CONTEXT,
  eventForCombo,
  FULL_CONTEXT,
  loadActionModules,
  PROBE_CONFIRM_ID,
  PROBE_DISABLED_REASON,
  PROBE_ECHO_ID,
  PROBE_GATED_ID,
  WHEN_BINDINGS,
  WHEN_CONTEXT_MODAL,
  WHEN_CONTEXT_TERMINAL,
} from "../lib/actionDispatchFixture";
import { actionDispatchScenarios } from "../scenarios/actionDispatch";

/**
 * PERF-200..205 drive the real ActionService, the real action catalog, the real
 * KeybindingService and the main-process MCP tool-surface projection through an
 * esbuild bundle that supplies the Vite/Electron affordances plain Node lacks.
 * esbuild links every static import whether or not it is reachable, so a new
 * import anywhere in that graph — a store, an `import.meta.glob`, an `electron`
 * value import — breaks the bundle without breaking anything else.
 *
 * The perf run that would catch it gates nothing and is not on PRs, so these
 * link the bundle in ordinary CI and exercise each measured gate once. The
 * scenarios' own timing loops are not run here.
 */
const BUNDLE_TIMEOUT_MS = 120_000;

describe("action dispatch perf bundle", () => {
  it(
    "registers the whole built-in catalog into a real ActionService",
    async () => {
      const mods = await loadActionModules();
      const catalog = buildCatalogService(mods);

      expect(catalog.actionCount).toBeGreaterThan(300);
      expect(mods.BUILT_IN_ACTION_IDS.length).toBeGreaterThan(300);
      const missing = mods.BUILT_IN_ACTION_IDS.filter((id) => !catalog.service.has(id));
      expect(missing).toEqual([]);
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "returns a distinct error code for each pre-run dispatch gate",
    async () => {
      const mods = await loadActionModules();
      const { service } = buildCatalogService(mods, { withProbes: true });

      const notFound = await service.dispatch("perf.no.such.action", undefined, {
        source: "agent",
      });
      expect(notFound.ok).toBe(false);
      expect(notFound.error?.code).toBe("NOT_FOUND");

      const badArgs = await service.dispatch(PROBE_ECHO_ID, { n: "nope" }, { source: "agent" });
      expect(badArgs.ok).toBe(false);
      expect(badArgs.error?.code).toBe("VALIDATION_ERROR");

      const disabled = await service.dispatch(PROBE_GATED_ID, undefined, {
        source: "agent",
        contextOverride: EMPTY_CONTEXT,
      });
      expect(disabled.ok).toBe(false);
      expect(disabled.error?.code).toBe("DISABLED");
      expect(disabled.error?.message).toBe(PROBE_DISABLED_REASON);

      const unconfirmed = await service.dispatch(PROBE_CONFIRM_ID, undefined, { source: "agent" });
      expect(unconfirmed.ok).toBe(false);
      expect(unconfirmed.error?.code).toBe("CONFIRMATION_REQUIRED");

      const ok = await service.dispatch(PROBE_ECHO_ID, { n: 7, label: "x" }, { source: "agent" });
      expect(ok.ok).toBe(true);
      expect(ok.result).toEqual({ n: 7, label: "x" });
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "runs the real enablement predicates against the supplied context",
    async () => {
      const mods = await loadActionModules();
      const { service } = buildCatalogService(mods, { withProbes: true });

      const full = service.list(FULL_CONTEXT, { includeSchemas: false });
      const empty = service.list(EMPTY_CONTEXT, { includeSchemas: false });

      const gatedFull = full.find((entry) => entry.id === PROBE_GATED_ID);
      const gatedEmpty = empty.find((entry) => entry.id === PROBE_GATED_ID);
      expect(gatedFull?.enabled).toBe(true);
      expect(gatedEmpty?.enabled).toBe(false);
      expect(gatedEmpty?.disabledReason).toBe(PROBE_DISABLED_REASON);

      // Real catalog actions must move with the context too, or the sweep is
      // measuring constants.
      const enabledEmpty = new Map(empty.map((entry) => [entry.id, entry.enabled]));
      const realFlips = full.filter(
        (entry) =>
          !entry.id.startsWith("perf.probe.") && enabledEmpty.get(entry.id) !== entry.enabled
      );
      expect(realFlips.length).toBeGreaterThan(0);
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "projects the manifest onto the MCP tool surface the tier allowlist permits",
    async () => {
      const mods = await loadActionModules();
      const { service } = buildCatalogService(mods);
      const manifest = service.list(FULL_CONTEXT);

      const permitted = mods.getTierPermittedActionIds("external");
      expect(permitted.size).toBeGreaterThan(0);

      const exposed = manifest.filter((entry) =>
        mods.shouldExposeTool(entry, "external", mods.UNBOUND_SESSION_SURFACE)
      );
      expect(exposed.length).toBeGreaterThan(0);
      for (const entry of exposed) {
        expect(permitted.has(entry.id)).toBe(true);
      }

      // Every advertised tool carries an object input schema — that is the shape
      // buildToolInputSchema guarantees, and what a client compiles against.
      for (const entry of exposed) {
        expect(mods.buildToolInputSchema(entry)["type"]).toBe("object");
      }

      const surface = mods.buildSurfaceManifest(manifest, "external", "0.0.0-test");
      expect(surface.tools.length).toBe(exposed.length);
      expect(surface.hash).toMatch(/^[0-9a-f]{64}$/);
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "resolves keystrokes, chords and when-gated bindings through the real service",
    async () => {
      const mods = await loadActionModules();
      const harness = buildKeybindingHarness(mods);
      const service = harness.service;
      expect(harness.registeredWhenBindings).toBe(WHEN_BINDINGS.length);

      const chord = mods.DEFAULT_KEYBINDINGS.find((binding) => binding.combo.includes(" "));
      expect(chord).toBeDefined();
      const [prefix, second] = chord!.combo.split(" ") as [string, string];

      service.setWhenContext(WHEN_CONTEXT_TERMINAL);

      const prefixResult = service.resolveKeybinding(eventForCombo(prefix));
      expect(prefixResult.match).toBeUndefined();
      expect(prefixResult.chordPrefix).toBe(true);
      expect(service.getPendingChord()).not.toBe(null);

      const completion = service.resolveKeybinding(eventForCombo(second));
      expect(completion.match?.actionId).toBe(chord!.actionId);

      // An unbound keystroke must scan everything and consume nothing.
      service.clearPendingChord();
      const miss = service.resolveKeybinding(eventForCombo("Cmd+Alt+Shift+F9"));
      expect(miss.match).toBeUndefined();
      expect(miss.shouldConsume).toBe(false);

      // The when clause is what decides, not the combo.
      const gated = WHEN_BINDINGS.find((binding) => binding.expectMatchUnder === "terminal");
      expect(gated).toBeDefined();
      service.setWhenContext(WHEN_CONTEXT_TERMINAL);
      expect(service.resolveKeybinding(eventForCombo(gated!.combo)).match?.actionId).toBe(
        gated!.actionId
      );
      service.setWhenContext(WHEN_CONTEXT_MODAL);
      expect(service.resolveKeybinding(eventForCombo(gated!.combo)).match).toBeUndefined();
    },
    BUNDLE_TIMEOUT_MS
  );
});

describe("action dispatch scenario family", () => {
  it("declares the PERF-200..205 block and a miss count for each", () => {
    expect(actionDispatchScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-200",
      "PERF-201",
      "PERF-202",
      "PERF-203",
      "PERF-204",
      "PERF-205",
    ]);
    for (const scenario of actionDispatchScenarios) {
      expect(scenario.correctness?.length).toBeGreaterThan(0);
      // Warmups matter here: the first run() in a process pays the one-off
      // esbuild link, and a measured iteration must never carry it.
      expect(scenario.warmups ?? 0).toBeGreaterThan(0);
    }
  });
});
