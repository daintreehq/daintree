import { beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf8")),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
}));

import { migration021 } from "../021-mcp-api-key-safestorage.js";

interface McpServerSnapshot {
  enabled?: boolean;
  port?: number | null;
  apiKey?: string;
  apiKeyEncrypted?: string;
  fullToolSurface?: boolean;
}

function makeStoreMock(initial: { mcpServer?: McpServerSnapshot } = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration021.up>[0] & {
    data: Record<string, unknown>;
  };
}

describe("migration021 — migrate MCP API key to safeStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((s: string) =>
      Buffer.from(`enc:${s}`, "utf8")
    );
  });

  it("encrypts a plaintext apiKey into apiKeyEncrypted and removes the legacy field", () => {
    const store = makeStoreMock({
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKey: "daintree_abc123",
        fullToolSurface: false,
      },
    });

    migration021.up(store);

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKey).toBeUndefined();
    expect(result.apiKeyEncrypted).toBe(
      Buffer.from("enc:daintree_abc123", "utf8").toString("base64")
    );
    expect(result.enabled).toBe(true);
    expect(result.port).toBe(45454);
    expect(result.fullToolSurface).toBe(false);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("daintree_abc123");
  });

  it("removes an empty plaintext apiKey field without writing apiKeyEncrypted", () => {
    const store = makeStoreMock({
      mcpServer: {
        enabled: false,
        port: null,
        apiKey: "",
        fullToolSurface: false,
      },
    });

    migration021.up(store);

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKey).toBeUndefined();
    expect(result.apiKeyEncrypted).toBeUndefined();
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("is a no-op when neither apiKey nor apiKeyEncrypted are present", () => {
    const store = makeStoreMock({
      mcpServer: {
        enabled: false,
        port: null,
        fullToolSurface: false,
      },
    });

    migration021.up(store);

    expect(store.set).not.toHaveBeenCalled();
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("re-encrypts plaintext as the source of truth when both fields are present", () => {
    const store = makeStoreMock({
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKey: "fresh_plaintext",
        apiKeyEncrypted: "stale-base64-from-a-different-machine",
        fullToolSurface: false,
      },
    });

    migration021.up(store);

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKey).toBeUndefined();
    expect(result.apiKeyEncrypted).toBe(
      Buffer.from("enc:fresh_plaintext", "utf8").toString("base64")
    );
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(1);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("fresh_plaintext");
  });

  it("is idempotent when apiKeyEncrypted already exists and no plaintext is left", () => {
    const store = makeStoreMock({
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKeyEncrypted: "preexisting-base64",
        fullToolSurface: false,
      },
    });

    migration021.up(store);

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKeyEncrypted).toBe("preexisting-base64");
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("drops plaintext (no encryption) when safeStorage is unavailable", () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = makeStoreMock({
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKey: "daintree_abc123",
        fullToolSurface: false,
      },
    });

    try {
      migration021.up(store);
    } finally {
      consoleWarnSpy.mockRestore();
    }

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKey).toBeUndefined();
    expect(result.apiKeyEncrypted).toBeUndefined();
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("drops plaintext when encryptString throws", () => {
    safeStorageMock.encryptString.mockImplementationOnce(() => {
      throw new Error("encryption failed");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = makeStoreMock({
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKey: "daintree_abc123",
        fullToolSurface: false,
      },
    });

    try {
      migration021.up(store);
    } finally {
      consoleWarnSpy.mockRestore();
    }

    const result = store.data.mcpServer as McpServerSnapshot;
    expect(result.apiKey).toBeUndefined();
    expect(result.apiKeyEncrypted).toBeUndefined();
  });

  it("handles a missing mcpServer config (fresh installs)", () => {
    const store = makeStoreMock({});

    migration021.up(store);

    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("has version 21", () => {
    expect(migration021.version).toBe(21);
  });
});
