import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks } from "../../actionTypes";
import type { ActionDefinition, PaletteBehavior } from "@shared/types/actions";

// No vi.mock: action factories are pure object literals — they only touch
// stores/clients inside run()/isReady(), which this suite invokes deliberately
// and narrowly. Mirrors actionMetadata.test.ts / actionDefinitions.bootstrap.test.ts.

function createStubCallbacks(): ActionCallbacks {
  return {
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenResumeSessionsPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
    onAddTerminal: async () => {},
  };
}

// Mirror ActionService.computeRequiresArgs: an action is "requires args" only
// when its schema rejects BOTH undefined and {} — i.e. it cannot be dispatched
// from the palette with empty args.
function requiresArgs(def: ActionDefinition): boolean {
  const schema = def.argsSchema as { safeParse: (v: unknown) => { success: boolean } } | undefined;
  if (!schema) return false;
  return !schema.safeParse(undefined).success && !schema.safeParse({}).success;
}

// A row a user can pick from the action palette today: a command that isn't
// hidden and either takes no required args or is a redirect (which runs its
// sibling, not itself).
function isPaletteRunnable(def: ActionDefinition): boolean {
  if (def.kind !== "command") return false;
  if (def.palette?.mode === "hidden") return false;
  if (def.palette?.mode === "redirect") return true;
  return !requiresArgs(def);
}

/**
 * Actions that, before this fix, passed the old `kind === "command" &&
 * !requiresArgs` palette filter yet misbehaved when the palette dispatched them
 * with `{}` — they threw, silently no-oped, did the wrong thing, OR bypassed a
 * component-wired D1 confirm (danger:"confirm" with no in-run gate; ActionService
 * doesn't gate user-source dispatch). Each must now declare a `palette` behavior
 * (hidden/redirect/requireContext) OR an `isEnabled` gate so it can't be
 * picked-and-broken from the palette.
 *
 * Recurrence guard: if a future change drops one of these signals — or a new
 * such action is added to this list — the test fails and forces an explicit
 * palette decision. NOT a complete list of every action this PR gave a `palette`
 * field (the keybinding/portal/fleet/browser "noise" hides aren't enumerated
 * here — they were never broken, just clutter); this is the set whose dispatch
 * was genuinely unsafe/broken from the palette.
 */
const AUDITED_LEAKY_IDS: readonly string[] = [
  "worktree.createWithRecipe",
  "git.commit",
  "copyTree.generateAndCopyFile",
  "devPreview.restart",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
  "devPreview.promoteToPortal",
  "devPreview.stop",
  "browser.openExternal",
  "browser.copyUrl",
  "worktree.bulk.remove",
  "worktree.bulk.closeSessions",
  "hibernation.updateConfig",
  "idleTerminalNotify.updateConfig",
  "agentSettings.reset",
  "fleet.reject",
  // D1 confirm-bypasses: danger:"confirm" whose confirm was wired only at the
  // component call site, so a source:"user" palette pick ran them unconfirmed.
  // (`worktree.sessions.endAll` now also self-gates in run() per #11345, but stays
  // palette-hidden as a discoverability choice, so it remains audited here.)
  "keybinding.resetAll",
  "worktree.sessions.endAll",
  "logs.clear",
];

describe("action palette behavior", () => {
  let definitions: Map<string, ActionDefinition>;

  beforeAll(async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
    Object.defineProperty(globalThis, "self", {
      value: globalThis,
      configurable: true,
      writable: true,
    });
    const { createActionDefinitions } = await import("../../actionDefinitions");
    const registry = createActionDefinitions(createStubCallbacks()) as Map<
      string,
      () => ActionDefinition
    >;
    definitions = new Map();
    for (const [id, factory] of registry.entries()) {
      try {
        definitions.set(String(id), factory());
      } catch {
        // A factory that throws at construction is a separate failure surfaced
        // by actionMetadata.test.ts; skip it here so it doesn't mask palette
        // assertions.
      }
    }
  });

  it("offers no two palette commands the user cannot tell apart", () => {
    // Two rows with the same title in the same category are a coin toss at the
    // point of choosing. The file browser had exactly this shape — a dialog
    // opener and a panel opener, both "Browse files" — so only one is listed
    // (#11666). Mirrors `useActionPalette`'s own filter for which definitions
    // reach a row at all.
    //
    // Scored through `isPaletteRunnable`, not `kind`/`hidden` alone: an action
    // the palette filters out for requiring args never renders a row, so it
    // cannot collide with anything. Counting those would allowlist phantom
    // pairs and let a real one slip in behind them.
    const seen = new Map<string, string[]>();
    for (const def of definitions.values()) {
      if (!isPaletteRunnable(def)) continue;
      const key = `${def.category ?? "General"} / ${def.title}`;
      seen.set(key, [...(seen.get(key) ?? []), String(def.id)]);
    }

    const collisions = [...seen.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key}: ${ids.join(", ")}`);

    expect(collisions).toEqual([]);
  });

  it("every palette redirect points at a registered, palette-runnable command", () => {
    const failures: string[] = [];
    for (const def of definitions.values()) {
      const palette = def.palette as PaletteBehavior | undefined;
      if (palette?.mode !== "redirect") continue;
      const target = definitions.get(String(palette.to));
      if (!target) {
        failures.push(`${def.id} → ${palette.to} (target not registered)`);
        continue;
      }
      if (target.kind !== "command") {
        failures.push(`${def.id} → ${palette.to} (target is kind "${target.kind}", not command)`);
      }
      if ((target.palette as PaletteBehavior | undefined)?.mode === "redirect") {
        failures.push(`${def.id} → ${palette.to} (target is itself a redirect — no chains)`);
      }
      if ((target.palette as PaletteBehavior | undefined)?.mode === "hidden") {
        failures.push(`${def.id} → ${palette.to} (target is palette-hidden)`);
      }
      if (requiresArgs(target)) {
        // The palette dispatches the target with `{}`, so the target must accept
        // empty args — otherwise the redirect just trades one failure for another.
        failures.push(`${def.id} → ${palette.to} (target requires args; {} would fail)`);
      }
    }
    expect(failures, `Invalid palette redirects:\n${failures.join("\n")}`).toEqual([]);
  });

  it("every audited leaky action now declares a palette behavior or an isEnabled gate", () => {
    const unguarded: string[] = [];
    for (const id of AUDITED_LEAKY_IDS) {
      const def = definitions.get(id);
      if (!def) {
        unguarded.push(`${id} (not registered — update the audit list)`);
        continue;
      }
      const guarded = def.palette !== undefined || def.isEnabled !== undefined;
      if (!guarded) unguarded.push(id);
    }
    expect(
      unguarded,
      `These audited-leaky actions can again be picked-and-broken from the palette:\n${unguarded.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("audited confirm-tier actions cannot be run from the palette", () => {
    // These carry danger:"confirm" but gate the confirm at their component call
    // site — run() clears/kills immediately. ActionService only blocks agent-source
    // dispatch, so if the palette can still run one, a user-source pick executes it
    // with no dialog. Computed from the same predicate the palette itself uses.
    const runnable: string[] = [];
    let audited = 0;
    for (const id of AUDITED_LEAKY_IDS) {
      const def = definitions.get(id);
      if (!def || def.danger !== "confirm") continue;
      audited++;
      if (isPaletteRunnable(def)) runnable.push(id);
    }
    expect(audited).toBeGreaterThan(0);
    expect(
      runnable,
      `These confirm-tier actions are reachable from the palette, which bypasses their call-site confirm:\n${runnable.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("requireContext actions disable themselves when no context is present", () => {
    // With an empty context (no active worktree, nothing focused), every
    // requireContext predicate must report not-ready — that's the state the
    // palette renders as disabled-with-reason instead of dispatching into a
    // throw. A predicate that throws is treated as not-ready by the manifest,
    // so we mirror that here.
    const stillReady: string[] = [];
    let sawRequireContext = false;
    for (const def of definitions.values()) {
      const palette = def.palette as PaletteBehavior | undefined;
      if (palette?.mode !== "requireContext") continue;
      sawRequireContext = true;
      let ready: boolean;
      try {
        ready = palette.isReady({});
      } catch {
        ready = false;
      }
      if (ready) stillReady.push(String(def.id));
      expect(
        palette.reason.trim().length,
        `${def.id} requireContext.reason is empty`
      ).toBeGreaterThan(0);
    }
    expect(sawRequireContext, "expected at least one requireContext action").toBe(true);
    expect(
      stillReady,
      `requireContext predicates stayed ready with no context:\n${stillReady.join("\n")}`
    ).toEqual([]);
  });

  it("the createWithRecipe leak from the report opens the New Worktree dialog", () => {
    // Regression for the exact bug: picking "Create Worktree with Recipe" used
    // to dispatch the headless action with {} and throw "branchName is
    // required…". It must now redirect to the dialog opener.
    const def = definitions.get("worktree.createWithRecipe");
    expect(def).toBeDefined();
    expect(def!.palette).toEqual({ mode: "redirect", to: "worktree.createDialog.open" });
    expect(isPaletteRunnable(def!)).toBe(true);
  });
});

describe("ActionService palette projection (toManifestEntry → list)", () => {
  // Exercises the real projection path — useActionPalette.test.tsx mocks list(),
  // so without this a toManifestEntry regression could ship green.
  function baseDef(over: Partial<ActionDefinition> & { id: string }): ActionDefinition {
    return {
      title: over.id,
      description: "",
      category: "test",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: async () => {},
      ...over,
    } as ActionDefinition;
  }

  it("projects hidden/redirect/requireContext onto the manifest", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();
    service.register(baseDef({ id: "t.hidden", palette: { mode: "hidden" } }));
    service.register(baseDef({ id: "t.redirect", palette: { mode: "redirect", to: "t.target" } }));
    service.register(
      baseDef({
        id: "t.ready",
        palette: {
          mode: "requireContext",
          isReady: (ctx) => Boolean(ctx.activeWorktreeId),
          reason: "need wt",
        },
      })
    );
    service.register(baseDef({ id: "t.plain" }));

    const byId = (ctx?: Parameters<typeof service.list>[0]) =>
      new Map(service.list(ctx).map((e) => [e.id, e]));

    // No context → requireContext predicate is false → disabled-with-reason.
    const off = byId({});
    expect(off.get("t.hidden")?.paletteHidden).toBe(true);
    expect(off.get("t.redirect")?.paletteRedirectTo).toBe("t.target");
    expect(off.get("t.ready")?.paletteDisabled).toBe(true);
    expect(off.get("t.ready")?.paletteDisabledReason).toBe("need wt");
    // A plain action carries none of the palette fields.
    expect(off.get("t.plain")?.paletteHidden).toBeUndefined();
    expect(off.get("t.plain")?.paletteRedirectTo).toBeUndefined();
    expect(off.get("t.plain")?.paletteDisabled).toBeUndefined();

    // isReady re-evaluates per list() call against the passed context — supplying
    // an active worktree flips the row back to enabled.
    const on = byId({ activeWorktreeId: "wt-1" });
    expect(on.get("t.ready")?.paletteDisabled).toBeUndefined();
    expect(on.get("t.ready")?.paletteDisabledReason).toBeUndefined();
  });
});
