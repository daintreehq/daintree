import { beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

// A write is a snapshot, as on disk: changing the object after store.set stores nothing.
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => structuredClone(storeState.data[key])),
  set: vi.fn((key: string, value: unknown) => {
    storeState.data[key] = JSON.parse(JSON.stringify(value));
  }),
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

describe("ProjectEnvSecureStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    storeState.data = { projectEnv: {} };
  });

  async function getService() {
    const mod = await import("../ProjectEnvSecureStorage.js");
    return mod.projectEnvSecureStorage;
  }

  function values(entries: Record<string, string>): Map<string, string> {
    return new Map(Object.entries(entries));
  }

  it("preserves intentionally-blank stored values instead of coercing to undefined", async () => {
    const service = await getService();
    service.replaceForProject("project-1", values({ OPTIONAL_TOKEN: "" }), new Set());

    expect(service.getForProject("project-1", ["OPTIONAL_TOKEN"]).get("OPTIONAL_TOKEN")).toBe("");
  });

  it("replaceForProject handles malformed projectEnv store value by normalizing", async () => {
    storeState.data.projectEnv = "corrupted";
    const service = await getService();

    expect(() =>
      service.replaceForProject("project-1", values({ API_KEY: "secret" }), new Set())
    ).not.toThrow();
    expect(service.getForProject("project-1", ["API_KEY"]).get("API_KEY")).toBe("secret");
  });

  describe("getForProject", () => {
    it("resolves every key from one read, leaving out keys with no stored value", async () => {
      storeState.data.projectEnv = { "project-1:A": "1", "project-1:B": "", "project-2:C": "3" };
      const service = await getService();

      const resolved = service.getForProject("project-1", ["A", "B", "C", "D"]);

      expect([...resolved]).toEqual([
        ["A", "1"],
        ["B", ""],
      ]);
      expect(storeMock.get).toHaveBeenCalledTimes(1);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("does not read the map when no keys are asked for", async () => {
      const service = await getService();

      expect(service.getForProject("project-1", []).size).toBe(0);
      expect(storeMock.get).not.toHaveBeenCalled();
    });

    it("leaves out entries that are not strings", async () => {
      storeState.data.projectEnv = { "project-1:A": 5, "project-1:B": "2" };
      const service = await getService();

      expect([...service.getForProject("project-1", ["A", "B"])]).toEqual([["B", "2"]]);
    });

    it("does not resolve a key named like an Object member", async () => {
      const service = await getService();

      expect(service.getForProject("project-1", ["constructor", "__proto__"]).size).toBe(0);
    });
  });

  describe("replaceForProject", () => {
    it("adds, replaces and removes in one read and one write", async () => {
      storeState.data.projectEnv = {
        "project-1:KEEP": "same",
        "project-1:CHANGE": "before",
        "project-1:STALE_1": "x",
        "project-1:STALE_2": "y",
        "project-2:STALE_1": "theirs",
      };
      const service = await getService();

      service.replaceForProject(
        "project-1",
        values({ KEEP: "same", CHANGE: "after", ADD: "new" }),
        new Set()
      );

      expect(storeMock.get).toHaveBeenCalledTimes(1);
      expect(storeMock.set).toHaveBeenCalledTimes(1);
      expect(storeState.data.projectEnv).toEqual({
        "project-1:KEEP": "same",
        "project-1:CHANGE": "after",
        "project-1:ADD": "new",
        "project-2:STALE_1": "theirs",
      });
    });

    it("writes nothing when the values match, whatever order they arrive in", async () => {
      storeState.data.projectEnv = { "project-1:A": "1", "project-1:B": "" };
      const service = await getService();

      service.replaceForProject("project-1", values({ B: "", A: "1" }), new Set());

      expect(storeMock.get).toHaveBeenCalledTimes(1);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("writes nothing for a project with nothing stored and nothing to store", async () => {
      storeState.data.projectEnv = { "project-2:A": "theirs" };
      const service = await getService();

      service.replaceForProject("project-1", new Map(), new Set());

      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("treats a blank value replacing a stored one as a change", async () => {
      storeState.data.projectEnv = { "project-1:A": "1" };
      const service = await getService();

      service.replaceForProject("project-1", values({ A: "" }), new Set());

      expect(storeMock.set).toHaveBeenCalledTimes(1);
      expect(storeState.data.projectEnv).toEqual({ "project-1:A": "" });
    });

    it("keeps a retained key's stored value without inventing a missing one", async () => {
      storeState.data.projectEnv = { "project-1:RETAINED": "stored", "project-1:STALE": "x" };
      const service = await getService();

      service.replaceForProject("project-1", new Map(), new Set(["RETAINED", "NOT_STORED"]));

      expect(storeMock.set).toHaveBeenCalledTimes(1);
      expect(storeState.data.projectEnv).toEqual({ "project-1:RETAINED": "stored" });
    });

    it("writes the given value over a retained key's stored one", async () => {
      storeState.data.projectEnv = { "project-1:A": "before" };
      const service = await getService();

      service.replaceForProject("project-1", values({ A: "after" }), new Set(["A"]));

      expect(storeState.data.projectEnv).toEqual({ "project-1:A": "after" });
    });

    it("leaves a project whose ID starts with this project's alone", async () => {
      storeState.data.projectEnv = { "proj:STALE": "x", "proj-extra:STALE": "theirs" };
      const service = await getService();

      service.replaceForProject("proj", new Map(), new Set());

      expect(storeState.data.projectEnv).toEqual({ "proj-extra:STALE": "theirs" });
    });

    it("recognises a stored key whose name contains a colon", async () => {
      storeState.data.projectEnv = { "project-1:A:B": "1" };
      const service = await getService();

      service.replaceForProject("project-1", values({ "A:B": "1" }), new Set());

      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("does not write only to drop malformed entries, and a real change drops them", async () => {
      storeState.data.projectEnv = { "project-1:A": "1", "project-1:BAD": 5, "project-2:BAD": 6 };
      const service = await getService();

      service.replaceForProject("project-1", values({ A: "1" }), new Set());
      expect(storeMock.set).not.toHaveBeenCalled();

      service.replaceForProject("project-1", values({ A: "2" }), new Set());
      expect(storeState.data.projectEnv).toEqual({ "project-1:A": "2" });
    });

    it("leaves a malformed map alone when there is nothing to store", async () => {
      storeState.data.projectEnv = "corrupted";
      const service = await getService();

      service.replaceForProject("project-1", new Map(), new Set());

      expect(storeMock.set).not.toHaveBeenCalled();
      expect(storeState.data.projectEnv).toBe("corrupted");
    });

    it("propagates a failed write without changing the stored map", async () => {
      storeState.data.projectEnv = { "project-1:A": "1" };
      const service = await getService();
      storeMock.set.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      expect(() => service.replaceForProject("project-1", values({ A: "2" }), new Set())).toThrow(
        "disk full"
      );
      expect(storeState.data.projectEnv).toEqual({ "project-1:A": "1" });
    });
  });

  it("deleteAllForProject removes only matching project keys", async () => {
    storeState.data.projectEnv = { "project-1:A": "1", "project-2:B": "2" };
    const service = await getService();

    service.deleteAllForProject("project-1");

    expect(service.getForProject("project-1", ["A"]).has("A")).toBe(false);
    expect(service.getForProject("project-2", ["B"]).get("B")).toBe("2");
  });

  describe("migrateAllForProject", () => {
    it("moves all keys from old project ID to new project ID", async () => {
      storeState.data.projectEnv = { "old-id:API_KEY": "secret", "old-id:DB_PASS": "password" };
      const service = await getService();

      service.migrateAllForProject("old-id", "new-id");

      expect(storeState.data.projectEnv).toEqual({
        "new-id:API_KEY": "secret",
        "new-id:DB_PASS": "password",
      });
    });

    it("is a no-op when old project has no env vars", async () => {
      storeState.data.projectEnv = { "other-project:B": "2" };
      const service = await getService();

      service.migrateAllForProject("old-id", "new-id");

      expect(storeState.data.projectEnv).toEqual({ "other-project:B": "2" });
    });

    it("pre-existing destination key takes precedence over migrated value", async () => {
      storeState.data.projectEnv = {
        "old-id:API_KEY": "from-old",
        "new-id:API_KEY": "pre-existing",
      };
      const service = await getService();

      service.migrateAllForProject("old-id", "new-id");

      expect(storeState.data.projectEnv).toEqual({ "new-id:API_KEY": "pre-existing" });
    });

    it("handles key with prefix collision gracefully", async () => {
      storeState.data.projectEnv = { "proj:KEY": "v1", "proj-extra:KEY": "v2" };
      const service = await getService();

      service.migrateAllForProject("proj", "new-proj");

      expect(storeState.data.projectEnv).toEqual({ "new-proj:KEY": "v1", "proj-extra:KEY": "v2" });
    });
  });
});
