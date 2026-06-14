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

import {
  buildStoredCredentials,
  credentialFieldsFor,
  pickPrimaryValue,
} from "../forgeCredentialUtils.js";
import type { CredentialField } from "../../../../shared/types/forge.js";

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

  it("selects the password-typed field even when it is not declared first", () => {
    registryMock.getRegisteredForgeProviders.mockReturnValue([
      {
        pluginId: "acme",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
          // Password field deliberately second so a `fields[0]`-always bug fails.
          credentialFields: [
            { id: "baseUrl", label: "Base URL", type: "text" },
            { id: "token", label: "API token", type: "password" },
          ],
        },
      },
    ]);
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ baseUrl: "https://gitea.example.com", token: "secret-token" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toEqual({
      kind: "bearer",
      value: "secret-token",
    });
  });

  it("falls back to the first declared field when none is a password field", () => {
    registryMock.getRegisteredForgeProviders.mockReturnValue([
      {
        pluginId: "acme",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
          credentialFields: [
            { id: "user", label: "User", type: "text" },
            { id: "host", label: "Host", type: "text" },
          ],
        },
      },
    ]);
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ user: "alice", host: "gitea.example.com" }),
    };
    expect(buildStoredCredentials("acme.gitea")).toEqual({ kind: "bearer", value: "alice" });
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

// The save path (forge:set-credential in forgeSettings.ts) and the replay path
// (buildStoredCredentials) now share these exported helpers, so the value
// passed to validateToken and the value replayed into setCredentials are
// guaranteed identical. These lock the single-primary selection rule directly.
describe("pickPrimaryValue", () => {
  const passwordSecond: CredentialField[] = [
    { id: "baseUrl", label: "Base URL", type: "text" },
    { id: "token", label: "API token", type: "password" },
  ];

  it("prefers the password-typed field regardless of declaration order", () => {
    const record = { baseUrl: "https://gitea.example.com", token: "secret" };
    expect(pickPrimaryValue(passwordSecond, record)).toBe("secret");
  });

  it("falls back to the first declared field when none is a password field", () => {
    const fields: CredentialField[] = [
      { id: "user", label: "User", type: "text" },
      { id: "host", label: "Host", type: "text" },
    ];
    expect(pickPrimaryValue(fields, { user: "alice", host: "h" })).toBe("alice");
  });

  it("falls back to the first record value when no fields are declared", () => {
    expect(pickPrimaryValue([], { apiKey: "lone" })).toBe("lone");
  });

  it("returns an empty string when the primary field is missing from the record", () => {
    expect(pickPrimaryValue(passwordSecond, { baseUrl: "https://gitea.example.com" })).toBe("");
  });

  it("agrees with buildStoredCredentials on the same fixture (one source of truth)", () => {
    registerGiteaProvider();
    const record = { token: "secret-token", baseUrl: "https://gitea.example.com" };
    storeMock._data["forgeCredentials"] = { "acme.gitea": JSON.stringify(record) };

    const replayed = buildStoredCredentials("acme.gitea");
    const direct = pickPrimaryValue(credentialFieldsFor("acme.gitea"), record);
    expect(replayed).toEqual({ kind: "bearer", value: direct });
  });
});

describe("credentialFieldsFor", () => {
  it("returns the registered provider's declared fields", () => {
    registerGiteaProvider();
    expect(credentialFieldsFor("acme.gitea")).toEqual([
      { id: "token", label: "API token", type: "password" },
      { id: "baseUrl", label: "Base URL", type: "text" },
    ]);
  });

  it("returns an empty array for an unregistered provider", () => {
    expect(credentialFieldsFor("nope.missing")).toEqual([]);
  });
});
