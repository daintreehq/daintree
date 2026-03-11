import { beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => storeState.data[key]),
  set: vi.fn((key: string, value: unknown) => {
    storeState.data[key] = value;
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

  it("stores and retrieves plain-text env values", async () => {
    const service = await getService();
    service.set("project-1", "API_KEY", "secret");

    expect(service.get("project-1", "API_KEY")).toBe("secret");
  });

  it("returns undefined for missing keys", async () => {
    const service = await getService();

    expect(service.get("project-1", "MISSING")).toBeUndefined();
  });

  it("set handles malformed projectEnv store value by normalizing", async () => {
    storeState.data.projectEnv = "corrupted";
    const service = await getService();

    expect(() => service.set("project-1", "API_KEY", "secret")).not.toThrow();
    expect(service.get("project-1", "API_KEY")).toBe("secret");
  });

  it("listKeys returns only keys for the requested project", async () => {
    const service = await getService();
    service.set("project-1", "A", "1");
    service.set("project-1", "B", "2");
    service.set("project-2", "C", "3");

    expect(service.listKeys("project-1").sort()).toEqual(["A", "B"]);
  });

  it("deleteAllForProject removes only matching project keys", async () => {
    const service = await getService();
    service.set("project-1", "A", "1");
    service.set("project-2", "B", "2");

    service.deleteAllForProject("project-1");

    expect(service.get("project-1", "A")).toBeUndefined();
    expect(service.get("project-2", "B")).toBe("2");
  });

  describe("migrateAllForProject", () => {
    it("moves all keys from old project ID to new project ID", async () => {
      const service = await getService();
      service.set("old-id", "API_KEY", "secret");
      service.set("old-id", "DB_PASS", "password");

      service.migrateAllForProject("old-id", "new-id");

      expect(service.get("new-id", "API_KEY")).toBe("secret");
      expect(service.get("new-id", "DB_PASS")).toBe("password");
      expect(service.get("old-id", "API_KEY")).toBeUndefined();
      expect(service.get("old-id", "DB_PASS")).toBeUndefined();
    });

    it("does not affect keys for other projects", async () => {
      const service = await getService();
      service.set("old-id", "A", "1");
      service.set("other-project", "B", "2");

      service.migrateAllForProject("old-id", "new-id");

      expect(service.get("other-project", "B")).toBe("2");
    });

    it("is a no-op when old project has no env vars", async () => {
      const service = await getService();
      service.set("other-project", "B", "2");

      service.migrateAllForProject("old-id", "new-id");

      expect(service.listKeys("new-id")).toHaveLength(0);
      expect(service.get("other-project", "B")).toBe("2");
    });

    it("pre-existing destination key takes precedence over migrated value", async () => {
      const service = await getService();
      service.set("old-id", "API_KEY", "from-old");
      service.set("new-id", "API_KEY", "pre-existing");

      service.migrateAllForProject("old-id", "new-id");

      expect(service.get("new-id", "API_KEY")).toBe("pre-existing");
      expect(service.get("old-id", "API_KEY")).toBeUndefined();
    });

    it("handles key with prefix collision gracefully", async () => {
      const service = await getService();
      service.set("proj", "KEY", "v1");
      service.set("proj-extra", "KEY", "v2");

      service.migrateAllForProject("proj", "new-proj");

      expect(service.get("new-proj", "KEY")).toBe("v1");
      expect(service.get("proj-extra", "KEY")).toBe("v2");
      expect(service.get("proj", "KEY")).toBeUndefined();
    });
  });
});
