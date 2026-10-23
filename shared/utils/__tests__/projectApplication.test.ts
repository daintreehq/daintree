import { describe, expect, it } from "vitest";
import type { PluginApplicationDescriptor } from "../../types/plugin.js";
import {
  resolveProjectApplication,
  type ProjectApplicationCandidate,
} from "../projectApplication.js";

const APP: PluginApplicationDescriptor = {
  name: "Ledger",
  destination: "home",
  presentation: { forgeStats: "hidden" },
};

function candidate(
  overrides: Partial<ProjectApplicationCandidate> = {}
): ProjectApplicationCandidate {
  return {
    manifestId: "acme.ledger",
    version: "2.1.0",
    application: APP,
    instanceId: "project:acme.ledger",
    staged: false,
    muted: false,
    loadFailed: false,
    engineIncompatible: false,
    ...overrides,
  };
}

function resolve(
  candidates: ProjectApplicationCandidate[],
  options: { trusted?: boolean; homeHeldBy?: string | null } = {}
) {
  return resolveProjectApplication({
    candidates,
    trusted: options.trusted ?? true,
    homeHeldBy: options.homeHeldBy ?? null,
  });
}

describe("resolveProjectApplication", () => {
  it("is null when no plugin declares an application", () => {
    expect(resolve([])).toBeNull();
  });

  it("is active, with no fallback, once the owner is loaded", () => {
    expect(resolve([candidate()], { homeHeldBy: "project:acme.ledger" })).toEqual({
      status: "active",
      ownerId: "acme.ledger",
      version: "2.1.0",
      instanceId: "project:acme.ledger",
      application: APP,
      fallback: null,
    });
  });

  it("is loading while a trusted owner has not loaded yet", () => {
    expect(resolve([candidate({ instanceId: undefined })])).toMatchObject({
      status: "loading",
      fallback: "standard-workspace",
    });
  });

  it.each([
    [{ trusted: false }, {}, "untrusted"],
    [{}, { muted: true }, "muted"],
    [{}, { staged: true }, "staged"],
  ] as const)("is disabled (%#) and falls back", (options, overrides, reason) => {
    expect(resolve([candidate(overrides)], options)).toMatchObject({
      status: "disabled",
      reason,
      fallback: "standard-workspace",
    });
  });

  it.each([
    [{ loadFailed: true }, "load-failed"],
    [{ engineIncompatible: true }, "engine-incompatible"],
  ] as const)("is unavailable (%#) and falls back", (overrides, reason) => {
    expect(resolve([candidate(overrides)])).toMatchObject({
      status: "unavailable",
      reason,
      fallback: "standard-workspace",
    });
  });

  it.each(["assets-missing", "schema-too-new"] as const)(
    "is unavailable when the payload failed its preflight (%s), naming what was found",
    (reason) => {
      const problems = ["one", "two"];
      const resolved = resolve([
        candidate({ instanceId: undefined, preflight: { reason, problems } }),
      ])!;
      expect(resolved).toMatchObject({
        status: "unavailable",
        reason,
        version: "2.1.0",
        problems,
        fallback: "standard-workspace",
      });
      expect(resolved.problems).not.toBe(problems);
    }
  );

  it("ranks a preflight failure after the engine range and ahead of a load failure", () => {
    const preflight = { reason: "assets-missing" as const, problems: ["dist/home.js"] };
    expect(resolve([candidate({ preflight, engineIncompatible: true })])).toMatchObject({
      reason: "engine-incompatible",
    });
    const failed = resolve([candidate({ preflight, loadFailed: true })]);
    expect(failed).toMatchObject({ reason: "assets-missing" });
    expect(resolve([candidate({ preflight, muted: true })])).toMatchObject({ reason: "muted" });
  });

  it("names problems only for a preflight reason", () => {
    expect(resolve([candidate({ loadFailed: true })])!.problems).toBeUndefined();
  });

  it("puts trust ahead of every other reason", () => {
    expect(
      resolve([candidate({ muted: true, loadFailed: true, engineIncompatible: true })], {
        trusted: false,
      })
    ).toMatchObject({ status: "disabled", reason: "untrusted" });
  });

  it("is replaced when another plugin holds the Home a home application opens on", () => {
    expect(resolve([candidate()], { homeHeldBy: "project:acme.other" })).toMatchObject({
      status: "replaced",
      heldBy: "project:acme.other",
      fallback: "standard-workspace",
    });
  });

  it("is not replaced by a Home holder when the application opens on the grid", () => {
    const grid = candidate({ application: { name: "Ledger", destination: "grid" } });
    expect(resolve([grid], { homeHeldBy: "project:acme.other" })).toMatchObject({
      status: "active",
    });
  });

  it("applies neither of two declarations, whatever order they arrive in", () => {
    const a = candidate({ manifestId: "acme.books", instanceId: "project:acme.books" });
    const b = candidate();
    const expected = {
      status: "unavailable",
      reason: "owner-ambiguous",
      ownerId: "acme.books",
      candidates: ["acme.books", "acme.ledger"],
      fallback: "standard-workspace",
    };
    expect(resolve([a, b])).toMatchObject(expected);
    expect(resolve([b, a])).toEqual(resolve([a, b]));
  });

  it("hands back a detached copy of the descriptor", () => {
    const input = candidate();
    const resolved = resolve([input])!;
    expect(resolved.application).toEqual(APP);
    expect(resolved.application).not.toBe(input.application);
    expect(resolved.application.presentation).not.toBe(APP.presentation);
  });
});
