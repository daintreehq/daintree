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

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

describe("SecureStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    storeState.data = {};
  });

  async function getService() {
    const mod = await import("../SecureStorage.js");
    return mod.secureStorage;
  }

  it("stores and retrieves plain-text values", async () => {
    const service = await getService();
    service.set("userConfig.githubToken", "ghp_token123");

    expect(service.get("userConfig.githubToken")).toBe("ghp_token123");
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

  it("returns undefined for empty string", async () => {
    storeState.data["userConfig.githubToken"] = "";
    const service = await getService();

    expect(service.get("userConfig.githubToken")).toBeUndefined();
  });
});
