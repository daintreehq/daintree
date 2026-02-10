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

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, "utf8")),
  decryptString: vi.fn((buffer: Buffer) => {
    const text = buffer.toString("utf8");
    if (!text.startsWith("enc:")) {
      throw new Error("Invalid payload");
    }
    return text.slice(4);
  }),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

describe("ProjectEnvSecureStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    storeState.data = { projectEnv: {} };
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value: string) =>
      Buffer.from(`enc:${value}`, "utf8")
    );
    safeStorageMock.decryptString.mockImplementation((buffer: Buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("Invalid payload");
      return text.slice(4);
    });
  });

  async function getService() {
    const mod = await import("../ProjectEnvSecureStorage.js");
    return mod.projectEnvSecureStorage;
  }

  it("stores and retrieves encrypted env values", async () => {
    const service = await getService();
    service.set("project-1", "API_KEY", "secret");

    expect(service.get("project-1", "API_KEY")).toBe("secret");
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("secret");
  });

  it("throws when encryption is unavailable during set", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const service = await getService();

    expect(() => service.set("project-1", "API_KEY", "secret")).toThrow(
      "Cannot store sensitive environment variable"
    );
  });

  it("returns undefined for non-hex stored values", async () => {
    storeState.data.projectEnv = { "project-1:API_KEY": "plain-text" };
    const service = await getService();

    expect(service.get("project-1", "API_KEY")).toBeUndefined();
  });

  it("returns undefined when decrypt fails", async () => {
    const badHex = Buffer.from("not-encrypted", "utf8").toString("hex");
    storeState.data.projectEnv = { "project-1:API_KEY": badHex };
    const service = await getService();

    expect(service.get("project-1", "API_KEY")).toBeUndefined();
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
});
