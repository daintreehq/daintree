import { afterEach, describe, expect, it } from "vitest";
import { store } from "../../../store.js";
import { persistedPluginViewConsent } from "../pluginViewConsent.js";

const KEY = "remoteHostPluginViewConsent";
const DIGEST = "c".repeat(64);

afterEach(() => store.set(KEY, {}));

describe("persistedPluginViewConsent", () => {
  it("keeps one digest per host and plugin, and resets one or all", () => {
    persistedPluginViewConsent.allow("studio-01", "acme.graph", DIGEST);
    persistedPluginViewConsent.allow("studio-01", "acme.peek", DIGEST);
    persistedPluginViewConsent.allow("bigbox", "acme.graph", DIGEST);
    expect(store.get(KEY)).toEqual({
      "studio-01": { "acme.graph": { digest: DIGEST }, "acme.peek": { digest: DIGEST } },
      bigbox: { "acme.graph": { digest: DIGEST } },
    });
    expect(persistedPluginViewConsent.list("studio-01")).toEqual(["acme.graph", "acme.peek"]);
    persistedPluginViewConsent.reset("studio-01", "acme.peek");
    expect(persistedPluginViewConsent.list("studio-01")).toEqual(["acme.graph"]);
    persistedPluginViewConsent.reset("studio-01");
    expect(persistedPluginViewConsent.allowedDigest("studio-01", "acme.graph")).toBeNull();
    expect(persistedPluginViewConsent.allowedDigest("bigbox", "acme.graph")).toBe(DIGEST);
  });

  it("counts anything malformed as not allowed", () => {
    for (const value of [
      [],
      { "studio-01": [] },
      { "studio-01": { "acme.graph": [] } },
      { "studio-01": { "acme.graph": { digest: "nope" } } },
      { "studio-01": { "acme.graph": { pins: {} } } },
    ]) {
      store.set(KEY, value as never);
      expect(persistedPluginViewConsent.allowedDigest("studio-01", "acme.graph")).toBeNull();
      expect(persistedPluginViewConsent.list("studio-01")).toEqual([]);
    }
    persistedPluginViewConsent.allow("studio-01", "acme.graph", "not-a-digest");
    expect(persistedPluginViewConsent.allowedDigest("studio-01", "acme.graph")).toBeNull();
  });
});
