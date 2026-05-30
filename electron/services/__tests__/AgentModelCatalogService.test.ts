import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

import { AgentModelCatalogService } from "../AgentModelCatalogService.js";

function makeCatalog(): Record<string, unknown> {
  return {
    anthropic: {
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": {
          name: "Claude Sonnet 4.6",
          limit: { context: 1_000_000 },
        },
        "claude-opus-4-6": {
          name: "Claude Opus 4.6",
          limit: { context: 200_000 },
        },
        "claude-haiku-4-5-20251001": {
          name: "Claude Haiku 4.5",
          limit: { context: 200_000 },
        },
      },
    },
    openai: {
      name: "OpenAI",
      models: {
        "gpt-5.4": {
          name: "GPT-5.4",
          limit: { context: 128_000 },
        },
        o3: {
          name: "o3",
          limit: { context: 200_000 },
        },
      },
    },
    google: {
      name: "Google",
      models: {
        "gemini-2.5-pro": {
          name: "Gemini 2.5 Pro",
          limit: { context: 1_048_576 },
        },
      },
    },
  };
}

type FetchFn = NonNullable<ConstructorParameters<typeof AgentModelCatalogService>[0]>["fetchImpl"];
type ExecFn = NonNullable<
  ConstructorParameters<typeof AgentModelCatalogService>[0]
>["execFileImpl"];

function mockFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}): FetchFn {
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => payload,
  }));
}

function mockFailingFetch(error: unknown): FetchFn {
  return vi.fn(async () => {
    throw error;
  });
}

async function makeTmpCachePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-catalog-test-"));
  return path.join(dir, "models-catalog.json");
}

async function cleanup(cachePath: string): Promise<void> {
  try {
    await fs.rm(path.dirname(cachePath), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

interface PersistedCachePayload {
  fetchedAt?: unknown;
  raw: {
    anthropic?: {
      models?: Record<string, unknown>;
    };
  };
}

async function readPersistedCache(cachePath: string): Promise<PersistedCachePayload> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(cachePath, "utf-8");
      return JSON.parse(text) as PersistedCachePayload;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for persisted cache");
}

describe("AgentModelCatalogService", () => {
  let cachePath: string;

  beforeEach(async () => {
    cachePath = await makeTmpCachePath();
  });

  afterEach(async () => {
    await cleanup(cachePath);
  });

  it("returns remote-derived models merged with bundled IDs for claude", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    expect(result.agentId).toBe("claude");
    expect(result.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"])
    );
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.source).toBe("merged");
  });

  it("preserves bundled shortLabel for known models", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    const sonnet = result.models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet?.shortLabel).toBe("Sonnet");
  });

  it("falls back to bundled when fetch fails", async () => {
    const fetchImpl = mockFailingFetch(new Error("network down"));
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    expect(result.source).toBe("bundled");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.contextWindow).toBe(200_000);
  });

  it("falls back to bundled when fetch returns non-OK status", async () => {
    const fetchImpl = mockFetch({}, { ok: false, status: 500 });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    expect(result.source).toBe("bundled");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("returns bundled when remote provider is missing for the agent", async () => {
    const fetchImpl = mockFetch({
      anthropic: {
        models: {
          "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", limit: { context: 200_000 } },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("aider");

    expect(result.source).toBe("bundled");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("tolerates malformed entries — non-object entries skipped, valid ones surface", async () => {
    const fetchImpl = mockFetch({
      anthropic: {
        models: {
          "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", limit: { context: 1_000_000 } },
          "string-entry": "not-an-object",
          "null-entry": null,
          "claude-opus-4-6": { name: "Claude Opus 4.6", limit: { context: 200_000 } },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    expect(result.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
    expect(result.models.map((m) => m.id)).toContain("claude-opus-4-6");
    expect(result.models.find((m) => m.id === "string-entry")).toBeUndefined();
    expect(result.models.find((m) => m.id === "null-entry")).toBeUndefined();
  });

  it("dedupes concurrent calls via singleflight", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => makeCatalog(),
    })) as unknown as FetchFn;
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    await Promise.all([
      service.getResolvedModels("claude"),
      service.getResolvedModels("codex"),
      service.getResolvedModels("gemini"),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses in-memory cache within TTL", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    await service.getResolvedModels("claude");
    await service.getResolvedModels("claude");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("persists fetched catalog to disk", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    await service.getResolvedModels("claude");

    const payload = await readPersistedCache(cachePath);
    expect(payload.raw.anthropic?.models?.["claude-sonnet-4-6"]).toBeDefined();
    expect(typeof payload.fetchedAt).toBe("number");
  });

  it("reads disk cache as fallback when network fails on cold start", async () => {
    const populator = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch(makeCatalog()),
    });
    await populator.getResolvedModels("claude");
    await readPersistedCache(cachePath);

    const offline = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFailingFetch(new Error("offline")),
    });
    const result = await offline.getResolvedModels("claude");

    expect(result.source).toBe("merged");
    expect(result.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
  });

  it("enriches codex models from the bundled CLI catalog", async () => {
    const execFileImpl: ExecFn = vi.fn(async () => ({
      stdout: JSON.stringify([
        { slug: "gpt-5.4", display_name: "GPT-5.4", context_window: 200_000 },
        { slug: "o3-mini", display_name: "o3-mini", context_window: 128_000 },
      ]),
      stderr: "",
    })) as unknown as ExecFn;

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch(makeCatalog()),
      execFileImpl,
      codexCommand: "codex",
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["gpt-5.4", "o3", "o3-mini"])
    );
    // Codex CLI's context window is preferred when present.
    expect(result.contextWindow).toBe(200_000);
  });

  it("silently ignores codex CLI failure", async () => {
    const execFileImpl: ExecFn = vi.fn(async () => {
      const err: NodeJS.ErrnoException = new Error("not found");
      err.code = "ENOENT";
      throw err;
    }) as unknown as ExecFn;

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch(makeCatalog()),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toContain("gpt-5.4");
    expect(result.source).toBe("merged");
  });

  it("returns null for unknown agent IDs", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("not-a-real-agent");

    expect(result.source).toBe("bundled");
    expect(result.models).toEqual([]);
    expect(result.contextWindow).toBeNull();
  });

  it("accepts codex CLI output as a {models: [...]} object (real shape)", async () => {
    const execFileImpl: ExecFn = vi.fn(async () => ({
      stdout: JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 256_000 },
          { slug: "gpt-5.4", display_name: "GPT-5.4", context_window: 128_000 },
        ],
      }),
      stderr: "",
    })) as unknown as ExecFn;

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch({}),
      execFileImpl,
      codexCommand: "codex",
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toContain("gpt-5.5");
    expect(result.contextWindow).toBe(256_000);
  });

  it("tolerates non-numeric limit.context anywhere in the remote catalog", async () => {
    const fetchImpl = mockFetch({
      anthropic: {
        models: {
          "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", limit: { context: 200_000 } },
          "claude-experimental": { name: "Claude Experimental", limit: { context: "unlimited" } },
        },
      },
      // A whole separate provider with a malformed entry must not poison
      // the catalog for the well-formed anthropic provider.
      openai: {
        models: {
          "gpt-5.4": { name: "GPT-5.4", limit: { context: null } },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    expect(result.source).toBe("merged");
    expect(result.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
    expect(result.models.map((m) => m.id)).toContain("claude-experimental");
    expect(result.contextWindow).toBe(200_000);
  });

  it("dedupes concurrent codex CLI calls via singleflight", async () => {
    const execFileImpl: ExecFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        stdout: JSON.stringify({
          models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 256_000 }],
        }),
        stderr: "",
      };
    }) as unknown as ExecFn;

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch({}),
      execFileImpl,
    });

    await Promise.all([
      service.getResolvedModels("codex"),
      service.getResolvedModels("codex"),
      service.getResolvedModels("codex"),
    ]);

    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it("derives shortLabel from name for remote-only models", async () => {
    const fetchImpl = mockFetch({
      anthropic: {
        models: {
          "claude-new-model": {
            name: "Claude New (preview)",
            limit: { context: 200_000 },
          },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    const newModel = result.models.find((m) => m.id === "claude-new-model");
    expect(newModel).toBeDefined();
    // Trailing parenthetical is stripped to keep the label short.
    expect(newModel?.shortLabel).toBe("Claude New");
  });
});
