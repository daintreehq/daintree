import { afterEach, describe, expect, it } from "vitest";
import { store } from "../../../store.js";
import { persistedClipboardGrants } from "../clipboardGrants.js";

describe("persistedClipboardGrants", () => {
  afterEach(() => store.set("remoteHostPluginClipboardGrants", {}));

  it("keeps each host, plugin and access apart in this machine's settings", () => {
    expect(persistedClipboardGrants.get("studio", "acme.snip", "write")).toBeNull();
    persistedClipboardGrants.set("studio", "acme.snip", "write", "allow");
    persistedClipboardGrants.set("studio", "acme.snip", "read", "deny");
    persistedClipboardGrants.set("laptop", "acme.snip", "write", "deny");
    expect(persistedClipboardGrants.get("studio", "acme.snip", "write")).toBe("allow");
    expect(persistedClipboardGrants.get("studio", "acme.snip", "read")).toBe("deny");
    expect(persistedClipboardGrants.get("laptop", "acme.snip", "write")).toBe("deny");
    expect(persistedClipboardGrants.get("laptop", "acme.other", "write")).toBeNull();
    expect(store.get("remoteHostPluginClipboardGrants")).toEqual({
      studio: { "acme.snip": { write: "allow", read: "deny" } },
      laptop: { "acme.snip": { write: "deny" } },
    });
  });

  it("reads nothing from inherited or malformed entries", () => {
    store.set("remoteHostPluginClipboardGrants", {
      studio: { "acme.snip": { write: "yes" as never } },
    });
    expect(persistedClipboardGrants.get("studio", "acme.snip", "write")).toBeNull();
    expect(persistedClipboardGrants.get("studio", "toString", "write")).toBeNull();
    expect(persistedClipboardGrants.get("__proto__", "acme.snip", "write")).toBeNull();
  });
});

describe("persistedClipboardGrants list and reset", () => {
  afterEach(() => store.set("remoteHostPluginClipboardGrants", {}));

  it("lists one host's answers and forgets one plugin's or all of them", () => {
    persistedClipboardGrants.set("studio", "acme.b", "write", "allow");
    persistedClipboardGrants.set("studio", "acme.a", "read", "deny");
    persistedClipboardGrants.set("laptop", "acme.a", "write", "allow");
    expect(persistedClipboardGrants.list("studio")).toEqual([
      { pluginId: "acme.a", read: "deny" },
      { pluginId: "acme.b", write: "allow" },
    ]);
    persistedClipboardGrants.reset("studio", "acme.a");
    expect(persistedClipboardGrants.get("studio", "acme.a", "read")).toBeNull();
    expect(persistedClipboardGrants.list("studio")).toEqual([
      { pluginId: "acme.b", write: "allow" },
    ]);
    persistedClipboardGrants.reset("studio");
    expect(persistedClipboardGrants.list("studio")).toEqual([]);
    expect(persistedClipboardGrants.get("laptop", "acme.a", "write")).toBe("allow");
  });
});
