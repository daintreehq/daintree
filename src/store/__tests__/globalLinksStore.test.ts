// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "daintree-global-links";
const PORTAL_KEY = "portal-storage";

function portalLink(id: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    title: id,
    url: `https://${id}.test/`,
    icon: "globe",
    enabled: true,
    order: 0,
    ...extra,
  };
}

function portalPayload(links: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ state: { width: 600, tabs: [], links, ...extra }, version: 0 });
}

function stored(backing: Map<string, string>): unknown {
  const raw = backing.get(KEY);
  return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
}

describe("globalLinksStore", () => {
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  async function loadStore() {
    vi.resetModules();
    return import("../globalLinksStore");
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("migration from portal-storage", () => {
    it("carries user links over with title, URL, icon, enabled state and order, leaving the built-in chats", async () => {
      const original = portalPayload([
        portalLink("system-claude", "system"),
        portalLink("discovered-gemini", "discovered"),
        portalLink("user-docs", "user", { title: "Docs", icon: "search", order: 7 }),
        portalLink("system-mistral", "user"),
        portalLink("user-ci", "user", { title: "CI", enabled: false, order: 2 }),
      ]);
      const backing = installLocalStorage({ [PORTAL_KEY]: original });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links).toEqual([
        {
          id: "user-docs",
          title: "Docs",
          url: "https://user-docs.test/",
          icon: "search",
          enabled: true,
          order: 0,
        },
        {
          id: "user-ci",
          title: "CI",
          url: "https://user-ci.test/",
          icon: "globe",
          enabled: false,
          order: 1,
        },
      ]);
      expect(stored(backing)).toEqual({
        state: { links: useGlobalLinksStore.getState().links },
        version: 0,
      });
      // The Portal's own copy stays for the dock until it is removed.
      expect(backing.get(PORTAL_KEY)).toBe(original);
    });

    it("moves links once: a second launch neither duplicates them nor brings back a removed one", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: portalPayload([portalLink("user-a", "user"), portalLink("user-b", "user")]),
      });

      const first = await loadStore();
      expect(first.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual([
        "user-a",
        "user-b",
      ]);
      first.useGlobalLinksStore.getState().removeLink("user-a");
      expect(first.migrateLegacyGlobalLinks()).toBeNull();

      const second = await loadStore();
      expect(second.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-b"]);
      expect(stored(backing)).toMatchObject({ state: { links: [{ id: "user-b", order: 0 }] } });
    });

    it("records the move even when there was nothing to carry, so links added to the Portal later aren't pulled in", async () => {
      const backing = installLocalStorage();
      const first = await loadStore();
      expect(first.useGlobalLinksStore.getState().links).toEqual([]);
      expect(stored(backing)).toEqual({ state: { links: [] }, version: 0 });

      backing.set(PORTAL_KEY, portalPayload([portalLink("user-late", "user")]));
      const second = await loadStore();
      expect(second.useGlobalLinksStore.getState().links).toEqual([]);
    });

    it.each([
      ["an empty string", ""],
      ["a payload with no state", JSON.stringify({ version: 0 })],
      ["a payload with no links", portalPayload([]).replace('"links":[]', '"other":1')],
      ["links that aren't a list", JSON.stringify({ state: { links: { a: 1 } }, version: 0 })],
    ])("treats %s as no links", async (_label, raw) => {
      const backing = installLocalStorage({ [PORTAL_KEY]: raw });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links).toEqual([]);
      expect(stored(backing)).toEqual({ state: { links: [] }, version: 0 });
    });

    it("skips malformed entries and keeps the rest", async () => {
      installLocalStorage({
        [PORTAL_KEY]: portalPayload([
          null,
          "user-x",
          { ...portalLink("user-no-url", "user"), url: "" },
          { ...portalLink("", "user") },
          portalLink("user-ok", "user", { icon: 3, enabled: "yes", title: undefined }),
          portalLink("user-ok", "user", { title: "Duplicate" }),
        ]),
      });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links).toEqual([
        {
          id: "user-ok",
          title: "",
          url: "https://user-ok.test/",
          icon: "globe",
          enabled: true,
          order: 0,
        },
      ]);
    });

    it("reads the Portal's backup when its live payload is corrupt", async () => {
      installLocalStorage({
        [PORTAL_KEY]: "{not json",
        [`${PORTAL_KEY}.__bak`]: portalPayload([portalLink("user-saved", "user")]),
      });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-saved"]);
    });

    it("comes up empty, and records the move, when the payload and its backup are both corrupt", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: "{not json",
        [`${PORTAL_KEY}.__bak`]: "also not json",
      });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links).toEqual([]);
      expect(stored(backing)).toEqual({ state: { links: [] }, version: 0 });
    });

    it("still shows moved links this session when storage refuses the write", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: portalPayload([portalLink("user-a", "user")]),
      });
      const realSet = globalThis.localStorage.setItem.bind(globalThis.localStorage);
      vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
        if (key === KEY) throw new DOMException("full", "QuotaExceededError");
        realSet(key, value);
      });

      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(KEY)).toBe(false);
    });
  });

  describe("editing", () => {
    it("adds, edits, toggles, reorders and removes links, keeping order in step with the list", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();

      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test", icon: "search" });
      const c = store.addLink({ title: "C", url: "https://c.test" });
      expect(useGlobalLinksStore.getState().links.map((l) => [l.id, l.order])).toEqual([
        [a, 0],
        [b, 1],
        [c, 2],
      ]);
      expect(useGlobalLinksStore.getState().links[1]).toMatchObject({
        icon: "search",
        enabled: true,
      });

      store.updateLink(a, { title: "Renamed", url: "https://renamed.test" });
      store.toggleLink(b);
      store.reorderLinks(2, 0);
      expect(useGlobalLinksStore.getState().links.map((l) => [l.id, l.order])).toEqual([
        [c, 0],
        [a, 1],
        [b, 2],
      ]);
      expect(useGlobalLinksStore.getState().links[1]!.title).toBe("Renamed");
      expect(useGlobalLinksStore.getState().links[2]!.enabled).toBe(false);

      store.removeLink(a);
      expect(useGlobalLinksStore.getState().links.map((l) => [l.id, l.order])).toEqual([
        [c, 0],
        [b, 1],
      ]);
    });

    it("puts a removed link back where it was", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const { positionOf } = await import("@/lib/undoToast");
      const store = useGlobalLinksStore.getState();
      store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });
      store.addLink({ title: "C", url: "https://c.test" });

      const removed = useGlobalLinksStore.getState().links[1]!;
      const position = positionOf(useGlobalLinksStore.getState().links, b);
      store.removeLink(b);
      store.restoreLink(removed, position);
      store.restoreLink(removed, position);

      expect(useGlobalLinksStore.getState().links.map((l) => [l.title, l.order])).toEqual([
        ["A", 0],
        ["B", 1],
        ["C", 2],
      ]);
    });

    it("ignores an update that tries to change a link's id, and moves a link given a new order", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });

      store.updateLink(a, { id: "hijack", order: 5 } as never);
      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual([b, a]);
    });

    it("keeps the list across a restart", async () => {
      installLocalStorage();
      const first = await loadStore();
      first.useGlobalLinksStore.getState().addLink({ title: "Kept", url: "https://kept.test" });

      const second = await loadStore();
      expect(second.useGlobalLinksStore.getState().links.map((l) => l.title)).toEqual(["Kept"]);
    });
  });

  describe("across project views", () => {
    it("does not let a stale view drop a link a sibling added", async () => {
      const backing = installLocalStorage();
      const stale = await loadStore();
      const sibling = await loadStore();

      sibling.useGlobalLinksStore.getState().addLink({ title: "Sibling", url: "https://s.test" });
      stale.useGlobalLinksStore.getState().addLink({ title: "Stale", url: "https://t.test" });

      const titles = (stored(backing) as { state: { links: Array<{ title: string }> } }).state.links
        .map((l) => l.title)
        .sort();
      expect(titles).toEqual(["Sibling", "Stale"]);
    });

    it("picks up a sibling view's change from a storage event", async () => {
      const backing = installLocalStorage();
      const view = await loadStore();
      expect(view.useGlobalLinksStore.getState().links).toEqual([]);

      backing.set(
        KEY,
        JSON.stringify({
          state: {
            links: [
              {
                id: "user-x",
                title: "X",
                url: "https://x.test",
                icon: "globe",
                enabled: true,
                order: 0,
              },
            ],
          },
          version: 0,
        })
      );
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
      await Promise.resolve();

      expect(view.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-x"]);
      expect(view.hasGlobalLink("user-x")).toBe(true);
    });
  });
});
