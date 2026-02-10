import { beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => storeState.data[key]),
  set: vi.fn((key: string, value: unknown) => {
    storeState.data[key] = value;
  }),
  delete: vi.fn((key: string) => {
    delete storeState.data[key];
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

describe("SecureStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    storeState.data = {};
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
    const mod = await import("../SecureStorage.js");
    return mod.secureStorage;
  }

  it("stores and retrieves encrypted values when encryption is available", async () => {
    const service = await getService();
    service.set("userConfig.githubToken", "token-123");

    expect(service.get("userConfig.githubToken")).toBe("token-123");
  });

  it("migrates plain-text values to encrypted storage when available", async () => {
    storeState.data["userConfig.githubToken"] = "plain-token";
    const service = await getService();

    expect(service.get("userConfig.githubToken")).toBe("plain-token");
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("plain-token");
  });

  it("keeps plain-text values when encryption is unavailable", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    storeState.data["userConfig.githubToken"] = "plain-token";
    const service = await getService();

    expect(service.get("userConfig.githubToken")).toBe("plain-token");
  });

  it("clears encrypted values if decryption fails", async () => {
    storeState.data["userConfig.githubToken"] = Buffer.from("bad-payload", "utf8").toString("hex");
    const service = await getService();

    expect(service.get("userConfig.githubToken")).toBeUndefined();
    expect(storeMock.delete).toHaveBeenCalledWith("userConfig.githubToken");
  });

  it("clears corrupted non-string values and returns undefined", async () => {
    storeState.data["userConfig.githubToken"] = { token: "bad-shape" };
    const service = await getService();

    expect(service.get("userConfig.githubToken")).toBeUndefined();
    expect(storeMock.delete).toHaveBeenCalledWith("userConfig.githubToken");
  });

  it("deletes value when set to undefined", async () => {
    const service = await getService();
    service.set("userConfig.githubToken", "abc");
    service.set("userConfig.githubToken", undefined);

    expect(storeMock.delete).toHaveBeenCalledWith("userConfig.githubToken");
  });
});
