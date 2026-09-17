import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_GUEST_ADAPTER_BYTES,
  __resetGuestAdaptersForTests,
  loadGuestAdapterSource,
  registerGuestAdapter,
  resolveGuestAdapter,
} from "../guestAdapters.js";

afterEach(() => {
  __resetGuestAdaptersForTests();
});

function adapter(over: { id?: string; load?: () => Promise<string>; cache?: boolean } = {}) {
  return {
    id: over.id ?? "test.guest",
    pluginId: "test.plugin",
    load: over.load ?? (async () => "/* body */"),
    cache: over.cache ?? true,
  };
}

describe("guest adapter registry", () => {
  it("refuses an id nothing registered", async () => {
    expect(resolveGuestAdapter("nope")).toBeNull();
    await expect(loadGuestAdapterSource("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads a cacheable body once and a volatile one every time", async () => {
    let reads = 0;
    registerGuestAdapter(
      adapter({
        load: async () => {
          reads += 1;
          return `body ${reads}`;
        },
      })
    );
    expect(await loadGuestAdapterSource("test.guest")).toBe("body 1");
    expect(await loadGuestAdapterSource("test.guest")).toBe("body 1");
    expect(reads).toBe(1);

    // What a dev build registers: the esbuild watcher rewrites the asset while
    // the app runs, so the body on disk is the only honest answer.
    __resetGuestAdaptersForTests();
    reads = 0;
    registerGuestAdapter(
      adapter({
        cache: false,
        load: async () => {
          reads += 1;
          return `body ${reads}`;
        },
      })
    );
    expect(await loadGuestAdapterSource("test.guest")).toBe("body 1");
    expect(await loadGuestAdapterSource("test.guest")).toBe("body 2");
  });

  it("does not let a load in flight cache its body under a replacement", async () => {
    let release: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerGuestAdapter(
      adapter({
        load: async () => {
          await slow;
          return "old body";
        },
      })
    );
    const pending = loadGuestAdapterSource("test.guest");

    registerGuestAdapter(adapter({ load: async () => "new body" }));
    expect(await loadGuestAdapterSource("test.guest")).toBe("new body");

    release!();
    await pending;

    // The outgoing adapter's text must not have landed in the cache the
    // replacement now owns.
    expect(await loadGuestAdapterSource("test.guest")).toBe("new body");
  });

  it("leaves nothing resolvable after its disposer runs", async () => {
    const dispose = registerGuestAdapter(adapter());
    await loadGuestAdapterSource("test.guest");
    dispose();

    expect(resolveGuestAdapter("test.guest")).toBeNull();
    await expect(loadGuestAdapterSource("test.guest")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an empty or oversized body rather than installing it", async () => {
    registerGuestAdapter(adapter({ id: "empty", load: async () => "" }));
    await expect(loadGuestAdapterSource("empty")).rejects.toMatchObject({ code: "INTERNAL" });

    registerGuestAdapter(
      adapter({ id: "huge", load: async () => "x".repeat(MAX_GUEST_ADAPTER_BYTES + 1) })
    );
    await expect(loadGuestAdapterSource("huge")).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });

    registerGuestAdapter(
      adapter({
        id: "broken",
        load: async () => {
          throw new Error("ENOENT");
        },
      })
    );
    await expect(loadGuestAdapterSource("broken")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
