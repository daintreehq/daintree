// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "daintree-application-navigation";

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

const record = (ownerId: string, sectionId: string) => ({
  ownerId,
  version: 1,
  entries: [{ sectionId, params: {} }],
  index: 0,
});

const history = (sectionId: string) => ({
  entries: [{ sectionId, params: {} }],
  index: 0,
});

function blob(byProject: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, state: { byProject } });
}

beforeEach(() => {
  vi.resetModules();
});

describe("applicationNavigationStore", () => {
  it("drops records that are not structurally sound on restore", async () => {
    installLocalStorage({
      [STORAGE_KEY]: blob({
        good: record("acme.ledger", "overview"),
        noOwner: { ...record("", "overview") },
        badIndex: { ...record("acme.ledger", "overview"), index: 4 },
        nestedEntry: { ...record("acme.ledger", "overview"), entries: ["overview"] },
        tooLong: {
          ...record("acme.ledger", "overview"),
          entries: Array.from({ length: 31 }, () => ({ sectionId: "overview", params: {} })),
        },
      }),
    });
    const { useApplicationNavigationStore } = await import("../applicationNavigationStore");
    expect(Object.keys(useApplicationNavigationStore.getState().byProject)).toEqual(["good"]);
  });

  it("reads a record only under the stamp it was written with", async () => {
    installLocalStorage({ [STORAGE_KEY]: blob({ p: record("acme.ledger", "overview") }) });
    const { useApplicationNavigationStore, selectApplicationNavigationRecord } =
      await import("../applicationNavigationStore");
    const state = useApplicationNavigationStore.getState();
    expect(
      selectApplicationNavigationRecord(state, "p", { ownerId: "acme.ledger", version: 1 })
    ).not.toBeNull();
    expect(
      selectApplicationNavigationRecord(state, "p", { ownerId: "acme.ledger", version: 2 })
    ).toBeNull();
    expect(
      selectApplicationNavigationRecord(state, "p", { ownerId: "acme.other", version: 1 })
    ).toBeNull();
  });

  it("prefers this window's session over what is on disk", async () => {
    installLocalStorage();
    const { useApplicationNavigationStore, selectApplicationNavigationRecord } =
      await import("../applicationNavigationStore");
    useApplicationNavigationStore
      .getState()
      .commit("p", { ownerId: "acme.ledger", version: 1 }, history("record"), history("overview"));
    const state = useApplicationNavigationStore.getState();
    expect(
      selectApplicationNavigationRecord(state, "p", { ownerId: "acme.ledger", version: 1 })
        ?.entries[0]?.sectionId
    ).toBe("record");
    expect(state.byProject.p?.entries[0]?.sectionId).toBe("overview");
  });

  it("keeps another view's project when this view writes its own", async () => {
    const backing = installLocalStorage();
    const { useApplicationNavigationStore } = await import("../applicationNavigationStore");
    // A sibling project view writes after this one hydrated.
    backing.set(STORAGE_KEY, blob({ other: record("acme.crm", "inbox") }));
    useApplicationNavigationStore
      .getState()
      .commit(
        "mine",
        { ownerId: "acme.ledger", version: 1 },
        history("overview"),
        history("overview")
      );
    const written: { state: { byProject: Record<string, unknown> } } = JSON.parse(
      backing.get(STORAGE_KEY) ?? "{}"
    );
    expect(Object.keys(written.state.byProject).sort()).toEqual(["mine", "other"]);
  });
});
