// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { buildGuestAsset } from "./buildGuestAsset.js";
import { GUEST_HANDLE_NAME } from "../../renderer/guest/names.js";
import type { GuestMode, GuestRuntimeHandle } from "../../renderer/guest/types.js";

/**
 * The asset the host installs, built exactly as `scripts/build-main.mjs` builds
 * it. These are the properties the host prelude relies on when it splices the
 * text into the scope it declared `api` in — the contract the old
 * `toString()`-serialised body met by construction and this one must be held to.
 */

let asset = "";
let minified = "";

beforeAll(() => {
  asset = buildGuestAsset();
  minified = buildGuestAsset({ minify: true });
}, 60_000);

interface StubApi {
  protocolVersion: number;
  sessionId: string;
  documentEpoch: number;
  mode: GuestMode;
  posted: unknown[];
  post(event: unknown): void;
  setMode(mode: GuestMode): void;
  setModeCalls: GuestMode[];
  reselect: (...args: unknown[]) => boolean;
  clearSelection: () => void;
  dispose: (() => void) | null;
  guest?: GuestRuntimeHandle;
}

function stubApi(): StubApi {
  const api: StubApi = {
    protocolVersion: 1,
    sessionId: "session-asset",
    documentEpoch: 2,
    mode: "select",
    posted: [],
    post(event) {
      api.posted.push(event);
    },
    setModeCalls: [],
    setMode(mode) {
      api.setModeCalls.push(mode);
      api.mode = mode;
    },
    reselect: () => false,
    clearSelection: () => undefined,
    dispose: null,
  };
  return api;
}

/** Runs the asset the way the prelude does: spliced into a scope holding `api`. */
function run(source: string): StubApi {
  const api = stubApi();
  new Function("api", source)(api);
  return api;
}

describe("the built guest runtime asset", () => {
  it("is a self-contained script with no module syntax left in it", () => {
    expect(asset.startsWith("(() => {")).toBe(true);
    expect(asset.trimEnd().endsWith("})();")).toBe(true);
    expect(asset).not.toMatch(/^\s*(import|export)\s/m);
    // Strict, because the prelude splices this inside a `try` block where a
    // directive prologue of its own would no longer take effect.
    expect(asset).toContain('"use strict";');
    expect(() => new Function(asset)).not.toThrow();
  });

  it("leaves `api` a free identifier for the prelude to supply", () => {
    // Declaring it would shadow the prelude's and route around the envelope
    // numbering the prelude owns.
    expect(asset).not.toMatch(/\b(?:const|let|var|function|class)\s+api\b/);
    expect(() => new Function(asset)()).toThrow(ReferenceError);
  });

  it("never reads the CDP binding itself", () => {
    // Every observation goes out through `api.post`, so the sequence stays the
    // prelude's to count.
    expect(asset).toContain("api.post(event)");
    expect(asset).toContain('bindingName: ""');
    expect(asset).toContain(GUEST_HANDLE_NAME);
  });

  it("wires the hooks the host drives the runtime through", () => {
    document.body.innerHTML = "<button id='cta'>Buy</button>";
    const api = run(asset);

    expect(typeof api.dispose).toBe("function");
    expect(api.guest).toBeDefined();
    expect(api.guest?.getMode()).toBe("select");
    expect(api.posted.some((event) => (event as { type: string }).type === "documentReady")).toBe(
      true
    );

    // The prelude's own `setMode` must still run, and be reachable bare.
    api.setMode("browse");
    expect(api.setModeCalls).toEqual(["browse"]);
    expect(api.guest?.getMode()).toBe("browse");

    expect(api.reselect({ file: "nope.svelte", line: 1, column: 0 }, 0, null, null)).toBe(false);
    api.clearSelection();
    api.dispose?.();
  });

  it("survives minification, which is what a production build emits", () => {
    document.body.innerHTML = "<button id='cta'>Buy</button>";
    expect(minified).not.toMatch(/\b(?:const|let|var|function|class)\s+api\b/);
    const api = run(minified);
    expect(api.guest?.getMode()).toBe("select");
    api.dispose?.();
  });
});
