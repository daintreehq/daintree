import { describe, it, expect } from "vitest";
import {
  persistedKindKey,
  requalifyPersistedKind,
  toPersistedKindFields,
} from "../panelKindPersistence.js";

const PROJECT_KIND = "project:proj-a/acme.dashboard/overview";
const PORTABLE_KIND = "acme.dashboard.overview";

describe("toPersistedKindFields", () => {
  it("strips the project id off a project-local plugin kind (#12280)", () => {
    expect(toPersistedKindFields(PROJECT_KIND, true)).toEqual({
      kind: PORTABLE_KIND,
      kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
    });
  });

  it("leaves a global plugin kind byte-identical, adding only the ref", () => {
    // Nothing about the global runtime form is machine-local, so the persisted
    // string must not move — an older build reads it back unchanged.
    expect(toPersistedKindFields(PORTABLE_KIND, true)).toEqual({
      kind: PORTABLE_KIND,
      kindRef: { origin: "global", pluginId: "acme.dashboard", kindId: "overview" },
    });
  });

  it("leaves built-in kinds alone and mints no ref for them", () => {
    for (const kind of ["terminal", "browser", "dev-preview", "file-browser"]) {
      expect(toPersistedKindFields(kind, false)).toEqual({ kind });
    }
  });

  it("mints no ref for a dotted kind no plugin owns", () => {
    // A removed built-in or a kind a test invents can be dotted too. Claiming a
    // plugin owns it would put a ref on state that plugin never wrote.
    expect(toPersistedKindFields("legacy.widget", false)).toEqual({ kind: "legacy.widget" });
  });

  it("splits on the manifest hint when the bare parse would guess wrong", () => {
    // `myplugin.a` matches the scoped-manifest shape, so without the hint the
    // split lands after it and the kind id loses its first segment.
    expect(toPersistedKindFields("myplugin.a.b", true, "myplugin")).toEqual({
      kind: "myplugin.a.b",
      kindRef: { origin: "global", pluginId: "myplugin", kindId: "a.b" },
    });
  });

  it("ignores the hint for the project form, which parses on its slashes", () => {
    // Callers pass the panel's `pluginId`, which for a project plugin is the
    // INSTANCE key, not the manifest id. It must not reach the parse.
    expect(
      toPersistedKindFields(PROJECT_KIND, true, "project-plugin:proj-a::acme.dashboard")
    ).toEqual({
      kind: PORTABLE_KIND,
      kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
    });
  });
});

describe("requalifyPersistedKind", () => {
  const projectRef = {
    origin: "project",
    pluginId: "acme.dashboard",
    kindId: "overview",
  } as const;

  it("qualifies a portable project kind against whichever project opens it", () => {
    expect(requalifyPersistedKind({ kind: PORTABLE_KIND, kindRef: projectRef }, "proj-b")).toBe(
      "project:proj-b/acme.dashboard/overview"
    );
  });

  it("migrates a legacy already-qualified kind onto the opening project", () => {
    // The whole bug: a layout written under proj-a and opened under proj-b used
    // to keep pointing at proj-a and orphan every plugin panel in it.
    expect(requalifyPersistedKind({ kind: PROJECT_KIND }, "proj-b")).toBe(
      "project:proj-b/acme.dashboard/overview"
    );
  });

  it("is idempotent, so Main re-qualifying before the renderer changes nothing", () => {
    const once = requalifyPersistedKind({ kind: PORTABLE_KIND, kindRef: projectRef }, "proj-b");
    expect(requalifyPersistedKind({ kind: once, kindRef: projectRef }, "proj-b")).toBe(once);
  });

  it("never aliases an unqualifiable project kind onto the global kind of the same name", () => {
    // Keeping a plugin installed globally while developing it in
    // `.daintree/plugins` is ordinary, so the portable form can genuinely match
    // an installed global kind. Handing it back would mount that plugin's view
    // over this panel's state and let it persist into it.
    for (const projectId of [null, undefined, ""]) {
      const resolved = requalifyPersistedKind(
        { kind: PORTABLE_KIND, kindRef: projectRef },
        projectId
      );
      expect(resolved).not.toBe(PORTABLE_KIND);
      expect(resolved?.startsWith("project:")).toBe(true);
    }
  });

  it("keeps an unresolved project kind round-trippable back to its own ref", () => {
    // The sentinel must not become the thing that gets saved: unqualifying it
    // again has to yield the original ref so the next save writes the correct
    // portable form.
    const unresolved = requalifyPersistedKind({ kind: PORTABLE_KIND, kindRef: projectRef }, null);
    expect(toPersistedKindFields(unresolved ?? "", true)).toEqual({
      kind: PORTABLE_KIND,
      kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
    });
  });

  it("passes a global plugin kind through unchanged", () => {
    expect(
      requalifyPersistedKind(
        { kind: PORTABLE_KIND, kindRef: { ...projectRef, origin: "global" } },
        "proj-b"
      )
    ).toBe(PORTABLE_KIND);
  });

  it("passes built-ins through untouched whatever the project", () => {
    expect(requalifyPersistedKind({ kind: "terminal" }, "proj-b")).toBe("terminal");
    expect(requalifyPersistedKind({ kind: undefined }, "proj-b")).toBeUndefined();
  });

  it("treats a ref the qualifier would refuse as no ref at all", () => {
    // A slash cannot appear in a validated manifest or panel id. Honouring such
    // a ref would fail BOTH qualification attempts and drop through to the bare
    // portable kind — the aliasing outcome the sentinel exists to prevent — so
    // it is rejected up front and the kind string speaks for itself instead.
    const corrupt = { origin: "project", pluginId: "a/b", kindId: "c" } as const;
    expect(
      requalifyPersistedKind(
        { kind: "project:proj-a/acme.dashboard/overview", kindRef: corrupt },
        "proj-b"
      )
    ).toBe("project:proj-b/acme.dashboard/overview");
  });
});

describe("persistedKindKey", () => {
  it("matches a legacy qualified snapshot to its newly portable replacement", () => {
    // The first save after upgrading compares the two. A raw string comparison
    // fails, and failing it drops the preserved extension state.
    expect(persistedKindKey({ kind: PROJECT_KIND })).toBe(
      persistedKindKey({
        kind: PORTABLE_KIND,
        kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
      })
    );
  });

  it("keeps a project kind distinct from the global kind of the same name", () => {
    expect(
      persistedKindKey({
        kind: PORTABLE_KIND,
        kindRef: { origin: "project", pluginId: "acme.dashboard", kindId: "overview" },
      })
    ).not.toBe(
      persistedKindKey({
        kind: PORTABLE_KIND,
        kindRef: { origin: "global", pluginId: "acme.dashboard", kindId: "overview" },
      })
    );
  });

  it("separates two kinds of the same origin and plugin", () => {
    // Origin alone is not identity: keying on it would let one contribution's
    // fragment be preserved onto a sibling kind from the same plugin.
    const base = { origin: "project", pluginId: "acme.dashboard", kindId: "overview" } as const;
    expect(persistedKindKey({ kind: PORTABLE_KIND, kindRef: base })).not.toBe(
      persistedKindKey({
        kind: "acme.dashboard.settings",
        kindRef: { ...base, kindId: "settings" },
      })
    );
    expect(persistedKindKey({ kind: PORTABLE_KIND, kindRef: base })).not.toBe(
      persistedKindKey({
        kind: "other.plugin.overview",
        kindRef: { ...base, pluginId: "other.plugin" },
      })
    );
  });

  it("still separates two unrelated non-plugin kinds", () => {
    expect(persistedKindKey({ kind: "terminal" })).not.toBe(persistedKindKey({ kind: "browser" }));
    expect(persistedKindKey({ kind: "terminal" })).toBe(persistedKindKey({ kind: "terminal" }));
  });

  it("qualifies a project kind under different projects to the same key", () => {
    // The key answers "which kind", not "whose copy of it" — two projects' saves
    // of the same contribution must not look like a kind change.
    expect(persistedKindKey({ kind: "project:proj-a/acme.dashboard/overview" })).toBe(
      persistedKindKey({ kind: "project:proj-b/acme.dashboard/overview" })
    );
  });
});

describe("untrusted input (#12280)", () => {
  // `kindRef` rides the snapshot schemas' passthrough and is never validated
  // there, on purpose: declaring it would let one malformed ref make
  // `filterValidTerminalEntries` drop the whole panel. So these arrive raw.
  const MALFORMED = [
    {},
    { origin: "project" },
    { origin: "nonsense", pluginId: "a", kindId: "b" },
    { origin: "project", pluginId: 7, kindId: "b" },
    null,
    "not-an-object",
  ];

  it("never throws on a malformed kindRef, whatever is on disk", () => {
    // `inferKind` runs inside a `.map()` over every terminal in a hydration, so
    // a throw here would take the entire project's layout down, not one panel.
    for (const kindRef of MALFORMED) {
      expect(() =>
        requalifyPersistedKind({ kind: PORTABLE_KIND, kindRef: kindRef as never }, "proj-b")
      ).not.toThrow();
      expect(() =>
        persistedKindKey({ kind: PORTABLE_KIND, kindRef: kindRef as never })
      ).not.toThrow();
    }
  });

  it("falls back to the persisted kind when the ref is unusable", () => {
    expect(requalifyPersistedKind({ kind: "terminal", kindRef: {} as never }, "proj-b")).toBe(
      "terminal"
    );
  });
});

describe("legacy dotted kinds under a non-scoped manifest id (#12280)", () => {
  // `myplugin.a` matches the scoped-manifest shape, so a hint-less parse splits
  // it there. The previous snapshot has no `kindRef` to short-circuit that, so
  // both sides must reach the same key through the `pluginId` hint or the guard
  // sees a kind change that never happened.
  it("keys a hint-less legacy snapshot the same as its re-serialized form", () => {
    const previous = { kind: "myplugin.a.b", pluginId: "myplugin" };
    const next = toPersistedKindFields("myplugin.a.b", true, "myplugin");
    expect(persistedKindKey(previous)).toBe(persistedKindKey(next));
  });

  it("still separates two genuinely different kinds under that manifest", () => {
    expect(persistedKindKey({ kind: "myplugin.a.b", pluginId: "myplugin" })).not.toBe(
      persistedKindKey({ kind: "myplugin.a.c", pluginId: "myplugin" })
    );
  });
});
