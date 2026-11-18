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
      const backing = installLocalStorage({
        [PORTAL_KEY]: original,
        [`${PORTAL_KEY}.__bak`]: original,
      });

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
      // Read once the move is on disk, the dock's payload and its backup go.
      expect(backing.has(PORTAL_KEY)).toBe(false);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
    });

    it("removes the Portal's payload on a launch after an earlier one already moved the links", async () => {
      const moved = JSON.stringify({
        state: { links: [{ ...portalLink("user-a", "user"), type: undefined }] },
        version: 0,
      });
      const backing = installLocalStorage({
        [KEY]: moved,
        [PORTAL_KEY]: portalPayload([
          portalLink("system-claude", "system"),
          portalLink("user-a", "user"),
        ]),
      });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(PORTAL_KEY)).toBe(false);
      expect(stored(backing)).toMatchObject({ state: { links: [{ id: "user-a" }] } });
    });

    it("keeps the Portal's payload while the list on disk lacks one of its links", async () => {
      const legacy = portalPayload([portalLink("user-a", "user"), portalLink("user-b", "user")]);
      const backing = installLocalStorage({
        [KEY]: JSON.stringify({ state: { links: [portalLink("user-a", "user")] }, version: 0 }),
        [PORTAL_KEY]: legacy,
      });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.get(PORTAL_KEY)).toBe(legacy);
    });

    it("keeps the Portal's payload when the list on disk is at a version hydration refuses", async () => {
      const legacy = portalPayload([portalLink("user-a", "user")]);
      const backing = installLocalStorage({
        [KEY]: JSON.stringify({ state: { links: [portalLink("user-a", "user")] }, version: 1 }),
        [PORTAL_KEY]: legacy,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});

      await loadStore();

      expect(backing.get(PORTAL_KEY)).toBe(legacy);
    });

    it("keeps the Portal's payload when the list on disk can't be read back", async () => {
      const legacy = portalPayload([portalLink("user-a", "user")]);
      const backing = installLocalStorage({ [KEY]: "{not json", [PORTAL_KEY]: legacy });

      await loadStore();

      expect(backing.get(PORTAL_KEY)).toBe(legacy);
    });

    it("never lets an edit after a move that couldn't read the Portal's payload cost its links", async () => {
      const legacy = portalPayload([portalLink("user-a", "user")]);
      const backing = installLocalStorage({ [PORTAL_KEY]: legacy });
      const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
      vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key) => {
        if (key === PORTAL_KEY) throw new Error("storage unavailable");
        return realGet(key);
      });

      const first = await loadStore();
      first.useGlobalLinksStore.getState().addLink({ title: "New", url: "https://new.test/" });
      expect(backing.has(KEY)).toBe(true);

      vi.restoreAllMocks();
      await loadStore();
      expect(backing.get(PORTAL_KEY)).toBe(legacy);
    });

    it("takes the Portal's backup when its live copy holds no link list", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: "null",
        [`${PORTAL_KEY}.__bak`]: portalPayload([portalLink("user-a", "user")]),
      });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
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
      expect(stored(backing)).toMatchObject({ state: { links: [{ id: "user-b" }] } });
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
    ])(
      "treats %s as no links, keeping it since nothing shows it held none",
      async (_label, raw) => {
        const backing = installLocalStorage({ [PORTAL_KEY]: raw });
        const { useGlobalLinksStore } = await loadStore();
        expect(useGlobalLinksStore.getState().links).toEqual([]);
        expect(stored(backing)).toEqual({ state: { links: [] }, version: 0 });
        expect(backing.get(PORTAL_KEY)).toBe(raw);
      }
    );

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
      const backing = installLocalStorage({
        [PORTAL_KEY]: "{not json",
        [`${PORTAL_KEY}.__bak`]: portalPayload([portalLink("user-saved", "user")]),
      });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-saved"]);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
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
      // The move isn't on disk, so the only copy of the links stays.
      expect(backing.has(PORTAL_KEY)).toBe(true);

      vi.restoreAllMocks();
      const nextLaunch = await loadStore();
      expect(nextLaunch.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(KEY)).toBe(true);
      expect(backing.has(PORTAL_KEY)).toBe(false);
    });

    it("leaves the move for a later launch when storage can't be read", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: portalPayload([portalLink("user-a", "user")]),
      });
      const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
      vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key) => {
        if (key === KEY) throw new Error("storage unavailable");
        return realGet(key);
      });

      const first = await loadStore();
      expect(first.migrateLegacyGlobalLinks()).toBeNull();
      expect(backing.has(KEY)).toBe(false);
      expect(backing.has(PORTAL_KEY)).toBe(true);

      vi.restoreAllMocks();
      const nextLaunch = await loadStore();
      expect(nextLaunch.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
    });

    it("doesn't record the move when the Portal's payload can't be read, so a later launch still moves it", async () => {
      const backing = installLocalStorage({
        [PORTAL_KEY]: portalPayload([portalLink("user-a", "user")]),
      });
      const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
      vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key) => {
        if (key === PORTAL_KEY) throw new Error("storage unavailable");
        return realGet(key);
      });

      const first = await loadStore();
      expect(first.useGlobalLinksStore.getState().links).toEqual([]);
      expect(backing.has(KEY)).toBe(false);
      expect(backing.has(PORTAL_KEY)).toBe(true);

      vi.restoreAllMocks();
      const nextLaunch = await loadStore();
      expect(nextLaunch.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
    });

    it("keeps both copies when the Portal's backup can't be read, so a later launch still moves it", async () => {
      const payload = portalPayload([portalLink("user-a", "user")]);
      const backing = installLocalStorage({
        [PORTAL_KEY]: "{not json",
        [`${PORTAL_KEY}.__bak`]: payload,
      });
      const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
      vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key) => {
        if (key === `${PORTAL_KEY}.__bak`) throw new Error("storage unavailable");
        return realGet(key);
      });

      const first = await loadStore();
      expect(first.useGlobalLinksStore.getState().links).toEqual([]);
      expect(backing.has(KEY)).toBe(false);
      expect(backing.get(`${PORTAL_KEY}.__bak`)).toBe(payload);

      vi.restoreAllMocks();
      const nextLaunch = await loadStore();
      expect(nextLaunch.useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
    });

    it("moves links from a backup whose live copy is already gone, then removes it", async () => {
      const backing = installLocalStorage({
        [`${PORTAL_KEY}.__bak`]: portalPayload([portalLink("user-a", "user")]),
      });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
    });

    it("removes a backup left behind after an earlier launch already moved the links", async () => {
      const backing = installLocalStorage({
        [KEY]: JSON.stringify({ state: { links: [portalLink("user-a", "user")] }, version: 0 }),
        [`${PORTAL_KEY}.__bak`]: portalPayload([portalLink("user-a", "user")]),
      });

      const { useGlobalLinksStore } = await loadStore();

      expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["user-a"]);
      expect(backing.has(`${PORTAL_KEY}.__bak`)).toBe(false);
    });

    it("reads an unversioned payload from an older release and keeps an always-on link always on", async () => {
      installLocalStorage({
        [PORTAL_KEY]: JSON.stringify({
          state: { links: [portalLink("user-pinned", "user", { alwaysEnabled: true })] },
        }),
      });
      const { useGlobalLinksStore } = await loadStore();
      expect(useGlobalLinksStore.getState().links).toEqual([
        {
          id: "user-pinned",
          title: "user-pinned",
          url: "https://user-pinned.test/",
          icon: "globe",
          enabled: true,
          order: 0,
          alwaysEnabled: true,
        },
      ]);
    });
  });

  describe("editing", () => {
    const ids = (links: Array<{ id: string }>) => links.map((l) => l.id);

    it("adds, edits, toggles, reorders and removes links", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const links = () => useGlobalLinksStore.getState().links;

      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test", icon: "search" });
      const c = store.addLink({ title: "C", url: "https://c.test" });
      expect(ids(links())).toEqual([a, b, c]);
      expect(links()[1]).toMatchObject({ icon: "search", enabled: true });
      expect(links()[0]!.icon).toBe("globe");

      store.updateLink(a, { title: "Renamed", url: "https://renamed.test" });
      store.toggleLink(b);
      store.reorderLinks(2, 0);
      expect(ids(links())).toEqual([c, a, b]);
      expect(links()[1]).toMatchObject({ title: "Renamed", url: "https://renamed.test" });
      expect(links()[2]!.enabled).toBe(false);

      store.reorderLinks(0, 1);
      expect(ids(links())).toEqual([a, c, b]);

      store.removeLink(a);
      expect(ids(links())).toEqual([c, b]);
    });

    it("re-ranks only the link that moved", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });
      const c = store.addLink({ title: "C", url: "https://c.test" });
      const before = new Map(useGlobalLinksStore.getState().links.map((l) => [l.id, l]));

      store.reorderLinks(2, 1);
      store.removeLink(a);

      const after = useGlobalLinksStore.getState().links;
      expect(after.map((l) => l.id)).toEqual([c, b]);
      expect(after.find((l) => l.id === b)).toBe(before.get(b));
      expect(after.find((l) => l.id === c)).not.toBe(before.get(c));
    });

    it("puts a removed link back where it was, with a rank that holds after a restart, once its neighbours have moved", async () => {
      installLocalStorage();
      const first = await loadStore();
      const { positionOf } = await import("@/lib/undoToast");
      const store = first.useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test", icon: "search" });
      const c = store.addLink({ title: "C", url: "https://c.test" });
      store.toggleLink(b);

      const removed = first.useGlobalLinksStore.getState().links[1]!;
      const position = positionOf(first.useGlobalLinksStore.getState().links, b);
      store.removeLink(b);
      // C moves ahead of A: B's old rank now sits outside the gap it came from.
      store.reorderLinks(1, 0);
      store.updateLink(a, { order: 0.5 });
      expect(ids(first.useGlobalLinksStore.getState().links)).toEqual([c, a]);

      store.restoreLink(removed, { order: [c, b, a] });
      store.restoreLink(removed, position);

      const restored = first.useGlobalLinksStore.getState().links;
      expect(ids(restored)).toEqual([c, b, a]);
      expect(restored[1]).toMatchObject({ title: "B", icon: "search", enabled: false });

      const afterRestart = await loadStore();
      expect(ids(afterRestart.useGlobalLinksStore.getState().links)).toEqual([c, b, a]);
    });

    it("restores the original order whichever of two removals is undone first", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const { positionOf } = await import("@/lib/undoToast");
      const store = useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });
      store.addLink({ title: "C", url: "https://c.test" });
      const before = useGlobalLinksStore.getState().links;
      const [linkA, linkB] = [a, b].map((id) => before.find((l) => l.id === id)!);

      for (const undoOrder of [
        [linkA!, linkB!],
        [linkB!, linkA!],
      ]) {
        const positions = new Map<string, ReturnType<typeof positionOf>>();
        for (const link of [linkA!, linkB!]) {
          positions.set(link.id, positionOf(useGlobalLinksStore.getState().links, link.id));
          store.removeLink(link.id);
        }
        for (const link of undoOrder) store.restoreLink(link, positions.get(link.id)!);
        expect(ids(useGlobalLinksStore.getState().links)).toEqual(ids(before));
      }
    });

    it("keeps adding after a link was given the largest rank there is", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      store.updateLink(a, { order: Number.MAX_VALUE });
      const b = store.addLink({ title: "B", url: "https://b.test" });

      const links = useGlobalLinksStore.getState().links;
      expect(ids(links)).toEqual([a, b]);
      expect(links[0]!.order).toBeLessThan(links[1]!.order);
      expect(links.every((l) => Number.isFinite(l.order))).toBe(true);
    });

    it("ignores an update that tries to change a link's id, and moves a link given a new order", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });

      store.updateLink(a, { id: "hijack", order: 5 } as never);
      expect(ids(useGlobalLinksStore.getState().links)).toEqual([b, a]);
    });

    it("keeps a link added as always on switched on", async () => {
      installLocalStorage();
      const { useGlobalLinksStore } = await loadStore();
      const store = useGlobalLinksStore.getState();
      const pinned = store.addLink({ title: "P", url: "https://p.test", alwaysEnabled: true });

      store.toggleLink(pinned);
      expect(useGlobalLinksStore.getState().links[0]).toMatchObject({
        enabled: true,
        alwaysEnabled: true,
      });
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
    const ids = (links: Array<{ id: string }>) => links.map((l) => l.id);

    function storedIds(backing: Map<string, string>): string[] {
      return (stored(backing) as { state: { links: Array<{ id: string }> } }).state.links.map(
        (l) => l.id
      );
    }

    async function threeLinksInTwoViews() {
      const backing = installLocalStorage();
      const seed = await loadStore();
      const store = seed.useGlobalLinksStore.getState();
      const a = store.addLink({ title: "A", url: "https://a.test" });
      const b = store.addLink({ title: "B", url: "https://b.test" });
      const c = store.addLink({ title: "C", url: "https://c.test" });
      const stale = await loadStore();
      const sibling = await loadStore();
      return { backing, stale, sibling, a, b, c };
    }

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

    it("does not bring back a link a sibling removed when a stale view removes another", async () => {
      const { backing, stale, sibling, a, b, c } = await threeLinksInTwoViews();

      sibling.useGlobalLinksStore.getState().removeLink(b);
      stale.useGlobalLinksStore.getState().removeLink(a);

      expect(storedIds(backing)).toEqual([c]);
    });

    it("does not bring back a link a sibling removed when a stale view reorders", async () => {
      const { backing, stale, sibling, a, b, c } = await threeLinksInTwoViews();

      sibling.useGlobalLinksStore.getState().removeLink(b);
      stale.useGlobalLinksStore.getState().reorderLinks(2, 0);

      expect(storedIds(backing)).toEqual([c, a]);
    });

    it("keeps a sibling's switch when a stale view edits another link", async () => {
      const { backing, stale, sibling, a, b } = await threeLinksInTwoViews();

      sibling.useGlobalLinksStore.getState().toggleLink(b);
      stale.useGlobalLinksStore.getState().updateLink(a, { title: "Renamed" });

      const links = (stored(backing) as { state: { links: Array<Record<string, unknown>> } }).state
        .links;
      expect(links.find((l) => l.id === b)!.enabled).toBe(false);
      expect(links.find((l) => l.id === a)!.title).toBe("Renamed");
    });

    it("settles two links added at the same rank in one order, whichever view writes next", async () => {
      const backing = installLocalStorage();
      const first = await loadStore();
      const second = await loadStore();

      const x = first.useGlobalLinksStore.getState().addLink({ title: "X", url: "https://x.test" });
      const y = second.useGlobalLinksStore
        .getState()
        .addLink({ title: "Y", url: "https://y.test" });
      const settled = storedIds(backing);
      expect(settled).toEqual([x, y].sort());

      first.useGlobalLinksStore.getState().updateLink(x, { title: "Renamed" });
      expect(storedIds(backing)).toEqual(settled);
    });

    function tiedPayload(first: string) {
      const link = (id: string, order: number) => ({
        id,
        title: id.toUpperCase(),
        url: `https://${id}.test`,
        icon: "globe",
        enabled: true,
        order,
      });
      return JSON.stringify({
        state: { links: [link(first, 0), link("b", 1), link("c", 1)] },
        version: 0,
      });
    }

    function storedRanks(backing: Map<string, string>): number[] {
      return (stored(backing) as { state: { links: Array<{ order: number }> } }).state.links.map(
        (l) => l.order
      );
    }

    it("keeps a move between two tied links when a stale view later edits the one it passed", async () => {
      const backing = installLocalStorage({ [KEY]: tiedPayload("z") });
      const mover = await loadStore();
      const stale = await loadStore();
      expect(ids(mover.useGlobalLinksStore.getState().links)).toEqual(["z", "b", "c"]);

      mover.useGlobalLinksStore.getState().reorderLinks(0, 1);
      expect(storedIds(backing)).toEqual(["b", "z", "c"]);

      stale.useGlobalLinksStore.getState().updateLink("c", { title: "Renamed" });
      expect(storedIds(backing)).toEqual(["b", "z", "c"]);
      const ranks = storedRanks(backing);
      expect(ranks.every((rank, i) => i === 0 || rank > ranks[i - 1]!)).toBe(true);
    });

    it("does not bring back a link a sibling removed when a stale view's move renumbers the list", async () => {
      const backing = installLocalStorage({ [KEY]: tiedPayload("a") });
      const remover = await loadStore();
      const stale = await loadStore();

      remover.useGlobalLinksStore.getState().removeLink("c");
      stale.useGlobalLinksStore.getState().reorderLinks(0, 1);

      expect(storedIds(backing)).toEqual(["b", "a"]);
    });

    it("keeps both views' edits to different fields of the same link", async () => {
      const { backing, stale, sibling, b } = await threeLinksInTwoViews();

      sibling.useGlobalLinksStore.getState().toggleLink(b);
      stale.useGlobalLinksStore.getState().updateLink(b, { title: "Renamed" });

      const link = (
        stored(backing) as { state: { links: Array<Record<string, unknown>> } }
      ).state.links.find((l) => l.id === b);
      expect(link).toMatchObject({ title: "Renamed", enabled: false });
    });

    it("brings back a link a sibling removed only when a stale view edited what it says", async () => {
      const { backing, stale, sibling, a, b, c } = await threeLinksInTwoViews();

      sibling.useGlobalLinksStore.getState().removeLink(b);
      stale.useGlobalLinksStore.getState().updateLink(b, { title: "Still wanted" });

      expect(storedIds(backing)).toEqual([a, b, c]);
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
    });
  });
});
