import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ForgeProviderEntry } from "../../../../shared/types/forge.js";

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

const registryMock = vi.hoisted(() => ({
  getRegisteredForgeProviders: vi.fn<() => ForgeProviderEntry[]>(() => []),
}));

vi.mock("../../forgeProviderRegistry.js", () => registryMock);

import { buildStoredCredentials } from "../forgeCredentialUtils.js";

function registerGiteaProvider() {
  registryMock.getRegisteredForgeProviders.mockReturnValue([
    {
      pluginId: "acme",
      contribution: {
        id: "gitea",
        name: "Gitea",
        matches: ["gitea.example.com"],
        credentialFields: [
          { id: "token", label: "API token", type: "password" },
          { id: "baseUrl", label: "Base URL", type: "text" },
        ],
      },
    },
  ]);
}

describe("buildStoredCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) delete storeMock._data[key];
    registryMock.getRegisteredForgeProviders.mockReturnValue([]);
  });

  it("returns the password-typed field as a bearer credential", () => {
    registerGiteaProvider();
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ token: "secret-token", baseUrl: "https://gitea.example.com" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toEqual({
      kind: "bearer",
      value: "secret-token",
    });
  });

  it("falls back to the first record value when the provider declares no fields", () => {
    registryMock.getRegisteredForgeProviders.mockReturnValue([]);
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ apiKey: "lone-value" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toEqual({ kind: "bearer", value: "lone-value" });
  });

  it("returns null when no credential is stored for the provider", () => {
    registerGiteaProvider();
    storeMock._data["forgeCredentials"] = {
      "corp.gitlab": JSON.stringify({ token: "other" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toBeNull();
  });

  it("returns null when the forgeCredentials key is absent", () => {
    registerGiteaProvider();
    expect(buildStoredCredentials("acme.gitea")).toBeNull();
  });

  it("returns null when the primary value is empty or whitespace", () => {
    registerGiteaProvider();
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ token: "   ", baseUrl: "https://gitea.example.com" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toBeNull();
  });

  it("returns null for a malformed stored record", () => {
    registerGiteaProvider();
    storeMock._data["forgeCredentials"] = { "acme.gitea": "not-json{" };
    expect(buildStoredCredentials("acme.gitea")).toBeNull();
  });

  it("returns null for an empty or invalid provider id", () => {
    registerGiteaProvider();
    expect(buildStoredCredentials("")).toBeNull();
  });
});
