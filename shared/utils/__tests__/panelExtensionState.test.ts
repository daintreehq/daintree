import { describe, it, expect } from "vitest";
import {
  decodePanelExtensionState,
  panelExtensionStateVersionMessage,
  restoredExtensionStateVersion,
} from "../panelExtensionState.js";

const BAG = { activeTab: "overview" };

describe("decodePanelExtensionState", () => {
  it("refuses a bag written by a newer build of the plugin", () => {
    const result = decodePanelExtensionState({
      state: BAG,
      persistedVersion: 3,
      declaredVersion: 2,
    });
    expect(result).toEqual({
      ok: false,
      reason: "future-version",
      state: BAG,
      persistedVersion: 3,
      declaredVersion: 2,
    });
  });

  it("hands the refused bag back, because refusing it is not licence to drop it", () => {
    // The record and its state stay on disk so reinstalling the newer plugin
    // returns the user's state intact — only the view's chance to overwrite it
    // is withheld.
    const result = decodePanelExtensionState({
      state: BAG,
      persistedVersion: 9,
      declaredVersion: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(BAG);
  });

  it("accepts a bag at the declared version", () => {
    expect(
      decodePanelExtensionState({ state: BAG, persistedVersion: 2, declaredVersion: 2 })
    ).toEqual({ ok: true, state: BAG, version: 2 });
  });

  it("migrates an older bag forward, telling the view which version it holds", () => {
    expect(
      decodePanelExtensionState({ state: BAG, persistedVersion: 1, declaredVersion: 4 })
    ).toEqual({ ok: true, state: BAG, version: 1 });
  });

  it("reads an unstamped bag as legacy v0 rather than as the current version", () => {
    // Bags written before versioning existed are whatever the plugin was
    // writing then. Reporting them as current would tell the view no migration
    // is needed when it is exactly what is needed.
    expect(decodePanelExtensionState({ state: BAG, declaredVersion: 2 })).toEqual({
      ok: true,
      state: BAG,
      version: 0,
    });
  });

  it("passes the bag through unjudged when the plugin declares no version", () => {
    // Absence means "no opinion" — refusing here would enforce a promise the
    // plugin author never made. An unregistered kind lands here too.
    expect(decodePanelExtensionState({ state: BAG, persistedVersion: 7 })).toEqual({
      ok: true,
      state: BAG,
      version: 7,
    });
  });

  it("has nothing to judge when there is no bag", () => {
    expect(decodePanelExtensionState({ declaredVersion: 1 })).toEqual({
      ok: true,
      state: undefined,
      version: 0,
    });
  });

  it("treats a corrupt persisted version as legacy instead of throwing", () => {
    // Total by construction: this reads untrusted on-disk JSON, and the caller
    // has no better answer than the legacy one for a value that is not a
    // version at all.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", null, {}]) {
      const result = decodePanelExtensionState({
        state: BAG,
        persistedVersion: bad as number,
        declaredVersion: 2,
      });
      expect(result).toEqual({ ok: true, state: BAG, version: 0 });
    }
  });

  it("ignores a corrupt declared version rather than refusing every bag", () => {
    expect(
      decodePanelExtensionState({
        state: BAG,
        persistedVersion: 5,
        declaredVersion: Number.NaN,
      })
    ).toEqual({ ok: true, state: BAG, version: 5 });
  });
});

describe("panelExtensionStateVersionMessage", () => {
  it("names both versions so the direction of the mismatch is visible", () => {
    const message = panelExtensionStateVersionMessage("Acme Dashboard", 3, 2);
    expect(message).toContain("Acme Dashboard");
    expect(message).toContain("3");
    expect(message).toContain("2");
    // The action, and the reassurance that waiting costs nothing.
    expect(message).toContain("Update the plugin");
    expect(message).toContain("kept");
  });
});

describe("restoredExtensionStateVersion", () => {
  it("resolves an unstamped restored bag to explicit legacy v0", () => {
    // Left absent, `addPanel` reads it as a fresh spawn and stamps the version
    // the plugin declares TODAY — relabelling a legacy bag as current, telling
    // the view no migration is needed, and persisting the lie on the next save.
    expect(restoredExtensionStateVersion({ extensionState: { a: 1 } })).toBe(0);
  });

  it("keeps the stamped version of a restored bag", () => {
    expect(
      restoredExtensionStateVersion({ extensionState: { a: 1 }, extensionStateVersion: 3 })
    ).toBe(3);
  });

  it("stays absent when there is no bag, so a fresh spawn stamps its own", () => {
    expect(restoredExtensionStateVersion({})).toBeUndefined();
    expect(restoredExtensionStateVersion({ extensionStateVersion: 3 })).toBeUndefined();
  });

  it("treats a corrupt stamp as legacy rather than trusting it", () => {
    expect(
      restoredExtensionStateVersion({ extensionState: { a: 1 }, extensionStateVersion: -2 })
    ).toBe(0);
  });
});
