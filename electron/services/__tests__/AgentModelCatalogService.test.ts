import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

import { AgentModelCatalogService } from "../AgentModelCatalogService.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";

/**
 * A models.dev entry the capability filter accepts: tool calling plus text
 * output. Entries missing either are what the filter exists to drop.
 */
function chatModel(name: string, context: number): Record<string, unknown> {
  return {
    name,
    limit: { context },
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  };
}

function makeCatalog(): Record<string, unknown> {
  return {
    anthropic: {
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": chatModel("Claude Sonnet 4.6", 1_000_000),
        "claude-opus-4-6": chatModel("Claude Opus 4.6", 200_000),
        "claude-haiku-4-5-20251001": chatModel("Claude Haiku 4.5", 200_000),
      },
    },
    openai: {
      name: "OpenAI",
      models: {
        "gpt-5.4": chatModel("GPT-5.4", 128_000),
        o3: chatModel("o3", 200_000),
      },
    },
    google: {
      name: "Google",
      models: {
        "gemini-2.5-pro": chatModel("Gemini 2.5 Pro", 1_048_576),
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

/** `visibility`/`priority` as the real `codex debug models --bundled` emits them. */
const LISTED = (priority: number) => ({ visibility: "list", priority });

function mockCodexCli(models: Record<string, unknown>[]): ExecFn {
  return vi.fn(async () => ({
    stdout: JSON.stringify({ models }),
    stderr: "",
  })) as unknown as ExecFn;
}

/** The IDs an agent ships as its offline fallback, in declared order. */
function bundledIdsFor(agentId: string): string[] {
  return getEffectiveAgentConfig(agentId)!.models!.map((m) => m.id);
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

  it("keeps a curated agent's list authoritative — remote IDs never join it", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const bundledIds = bundledIdsFor("claude");
    const result = await service.getResolvedModels("claude");

    expect(result.agentId).toBe("claude");
    // Every dated Anthropic ID in the fixture clears the capability filter, so
    // only the curated-list projection keeps them out of the picker (#11879).
    expect(result.models.map((m) => m.id)).toEqual(bundledIds);
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.source).toBe("merged");
  });

  it("lets remote metadata enrich a curated entry without changing membership", async () => {
    const fetchImpl = mockFetch({
      anthropic: {
        models: {
          // Same ID as a curated alias: remote may improve its display name.
          opus: chatModel("Claude Opus (latest)", 400_000),
          "claude-opus-4-7": chatModel("Claude Opus 4.7", 200_000),
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("claude");

    const opus = result.models.find((m) => m.id === "opus");
    expect(opus?.name).toBe("Claude Opus (latest)");
    // Curated shortLabel survives the remote name.
    expect(opus?.shortLabel).toBe("Opus");
    expect(result.models.map((m) => m.id)).not.toContain("claude-opus-4-7");
  });

  it("preserves bundled shortLabel for known models", async () => {
    const fetchImpl = mockFetch(makeCatalog());
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    const bundledPro = getEffectiveAgentConfig("gemini")!.models![0]!;
    const pro = result.models.find((m) => m.id === bundledPro.id);
    expect(pro?.shortLabel).toBe(bundledPro.shortLabel);
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

  // A non-object entry fails `models` at the record level, so the whole catalog
  // is rejected rather than the one entry — the resolver must still degrade to
  // bundled silently instead of throwing into IPC. (`extractRemote`'s per-entry
  // safeParse is a second line of defence that this path never reaches.)
  it("degrades to bundled when a malformed entry rejects the remote catalog", async () => {
    const fetchImpl = mockFetch({
      google: {
        models: {
          "gemini-3-pro": chatModel("Gemini 3 Pro", 1_000_000),
          "string-entry": "not-an-object",
          "null-entry": null,
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.source).toBe("bundled");
    expect(result.models.map((m) => m.id)).toEqual(bundledIdsFor("gemini"));
  });

  it("drops models.dev entries no coding CLI could drive", async () => {
    const fetchImpl = mockFetch({
      google: {
        models: {
          "gemini-3-pro": chatModel("Gemini 3 Pro", 1_000_000),
          // Image + embedding models: published by the provider, rejected by
          // the CLI. These are the entries #11879 reported in the picker.
          "gemini-image-1": {
            name: "Gemini Image 1",
            limit: { context: 4_000_000 },
            tool_call: false,
            modalities: { input: ["text"], output: ["image"] },
          },
          "gemini-embedding-1": {
            name: "Gemini Embedding",
            limit: { context: 8_000_000 },
            tool_call: false,
            modalities: { input: ["text"], output: ["text"] },
          },
          // Tool-capable but audio-out: still not something --model takes.
          "gemini-realtime": {
            name: "Gemini Realtime",
            limit: { context: 2_000_000 },
            tool_call: true,
            modalities: { input: ["audio"], output: ["audio"] },
          },
          // Capability fields absent entirely — fail closed.
          "gemini-unknown": { name: "Gemini Unknown", limit: { context: 3_000_000 } },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.models.map((m) => m.id)).toContain("gemini-3-pro");
    for (const excluded of [
      "gemini-image-1",
      "gemini-embedding-1",
      "gemini-realtime",
      "gemini-unknown",
    ]) {
      expect(result.models.map((m) => m.id)).not.toContain(excluded);
    }
    // Excluded entries advertise far larger windows; none may reach the
    // resolved value, which is why the filter runs before the aggregate.
    expect(result.contextWindow).toBe(1_000_000);
  });

  it("reads the capability fields by type, not by truthiness", async () => {
    const fetchImpl = mockFetch({
      google: {
        models: {
          // Text alongside another output modality is still text-capable.
          "gemini-multi": {
            name: "Gemini Multi",
            limit: { context: 500_000 },
            tool_call: true,
            modalities: { input: ["text"], output: ["image", "text"] },
          },
          // Truthy strings must not stand in for the real types.
          "gemini-stringy-tool": {
            name: "Gemini Stringy",
            limit: { context: 900_000 },
            tool_call: "true",
            modalities: { input: ["text"], output: ["text"] },
          },
          "gemini-stringy-output": {
            name: "Gemini Stringy Output",
            limit: { context: 900_000 },
            tool_call: true,
            modalities: { input: ["text"], output: "text" },
          },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.models.map((m) => m.id)).toContain("gemini-multi");
    expect(result.models.map((m) => m.id)).not.toContain("gemini-stringy-tool");
    expect(result.models.map((m) => m.id)).not.toContain("gemini-stringy-output");
  });

  it("keeps discovery alive for agents whose list is not curated", async () => {
    const fetchImpl = mockFetch({
      google: {
        models: {
          "gemini-4-pro": chatModel("Gemini 4 Pro", 2_000_000),
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    // A brand-new remote model reaches the picker for a discovery agent — the
    // capability filter is generic, not a curated-agent allowlist in disguise.
    expect(result.models.map((m) => m.id)).toContain("gemini-4-pro");
    expect(result.models.map((m) => m.id)).toEqual(expect.arrayContaining(bundledIdsFor("gemini")));
  });

  it("falls back to bundled when every remote entry fails the capability filter", async () => {
    const fetchImpl = mockFetch({
      google: {
        models: {
          "gemini-image-1": {
            name: "Gemini Image 1",
            limit: { context: 4_000_000 },
            tool_call: false,
            modalities: { input: ["text"], output: ["image"] },
          },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.source).toBe("bundled");
    expect(result.models.map((m) => m.id)).toEqual(bundledIdsFor("gemini"));
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
    expect(result.models.map((m) => m.id)).toContain("opus");
  });

  it("filters a disk cache written before the capability fields existed", async () => {
    // Pre-change caches hold bare `{name, limit}` entries. They stay within TTL
    // after an app update, so the filter has to run on every read — not only on
    // freshly fetched payloads — or the old unfiltered list survives the fix.
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        raw: {
          google: {
            models: {
              "gemini-legacy": { name: "Gemini Legacy", limit: { context: 900_000 } },
            },
          },
        },
      }),
      "utf-8"
    );

    const fetchImpl = mockFailingFetch(new Error("offline"));
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.models.map((m) => m.id)).not.toContain("gemini-legacy");
    expect(result.models.map((m) => m.id)).toEqual(bundledIdsFor("gemini"));
  });

  it("takes the codex CLI catalog as authoritative, dropping remote-only IDs", async () => {
    // Deliberately unequal to the remote catalog's 200_000 max, so reversing
    // the CLI-before-remote precedence would change the assertion below.
    const execFileImpl = mockCodexCli([
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", context_window: 512_000, ...LISTED(1) },
      { slug: "gpt-5.2", display_name: "GPT-5.2", context_window: 128_000, ...LISTED(29) },
    ]);

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch(makeCatalog()),
      execFileImpl,
      codexCommand: "codex",
    });

    const result = await service.getResolvedModels("codex");

    // `gpt-5.4` and `o3` are in the models.dev fixture and pass the capability
    // filter, but the CLI is the thing that will receive `--model`.
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.2"]);
    // Codex CLI's context window is preferred over the remote catalog's.
    expect(result.contextWindow).toBe(512_000);
  });

  it("offers only models the codex CLI marks visible", async () => {
    const execFileImpl = mockCodexCli([
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", context_window: 400_000, ...LISTED(1) },
      {
        slug: "gpt-5.4",
        display_name: "GPT-5.4",
        context_window: 900_000,
        visibility: "hide",
        priority: 16,
      },
      { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide", priority: 43 },
      // No visibility field at all — treated as hidden, not as opt-in.
      { slug: "gpt-mystery", display_name: "Mystery", context_window: 999_000 },
    ]);

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch({}),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
    // A hidden entry's context window must not leak into the resolved value.
    expect(result.contextWindow).toBe(400_000);
  });

  it("orders codex models by the CLI's priority, unranked entries last", async () => {
    const execFileImpl = mockCodexCli([
      { slug: "gpt-5.5", display_name: "GPT-5.5", ...LISTED(7) },
      { slug: "gpt-unranked", display_name: "Unranked", visibility: "list" },
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", ...LISTED(2) },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", ...LISTED(1) },
    ]);

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch({}),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-unranked",
    ]);
  });

  it("treats a non-numeric priority as unranked and keeps ties in CLI order", async () => {
    const execFileImpl = mockCodexCli([
      // Same priority: input order decides, so a non-stable sort would flip these.
      { slug: "gpt-tie-first", display_name: "Tie first", visibility: "list", priority: 5 },
      { slug: "gpt-tie-second", display_name: "Tie second", visibility: "list", priority: 5 },
      // A string priority must not be coerced into rank 1.
      { slug: "gpt-stringy", display_name: "Stringy", visibility: "list", priority: "1" },
      { slug: "gpt-ranked", display_name: "Ranked", ...LISTED(2) },
    ]);

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch({}),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual([
      "gpt-ranked",
      "gpt-tie-first",
      "gpt-tie-second",
      "gpt-stringy",
    ]);
  });

  it("falls back to the curated codex list when every CLI entry is hidden", async () => {
    const execFileImpl = mockCodexCli([
      { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide", priority: 43 },
    ]);

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFetch(makeCatalog()),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual(bundledIdsFor("codex"));
  });

  it("silently ignores codex CLI failure and keeps the curated list", async () => {
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

    expect(result.models.map((m) => m.id)).toEqual(bundledIdsFor("codex"));
    expect(result.source).toBe("merged");
  });

  it("uses the CLI catalog when the network is down", async () => {
    // Bare-array output (no `{models:[...]}` wrapper) is still a supported shape.
    const execFileImpl: ExecFn = vi.fn(async () => ({
      stdout: JSON.stringify([
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", context_window: 400_000, ...LISTED(1) },
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "hide", priority: 16 },
      ]),
      stderr: "",
    })) as unknown as ExecFn;

    const service = new AgentModelCatalogService({
      cachePath,
      fetchImpl: mockFailingFetch(new Error("offline")),
      execFileImpl,
    });

    const result = await service.getResolvedModels("codex");

    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
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
          { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 256_000, ...LISTED(7) },
          { slug: "gpt-5.4", display_name: "GPT-5.4", context_window: 128_000, ...LISTED(16) },
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
      google: {
        models: {
          "gemini-3-pro": chatModel("Gemini 3 Pro", 200_000),
          "gemini-experimental": {
            ...chatModel("Gemini Experimental", 0),
            limit: { context: "unlimited" },
          },
        },
      },
      // A whole separate provider with a malformed entry must not poison
      // the catalog for the well-formed google provider.
      openai: {
        models: {
          "gpt-5.4": { ...chatModel("GPT-5.4", 0), limit: { context: null } },
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    expect(result.source).toBe("merged");
    expect(result.models.map((m) => m.id)).toContain("gemini-3-pro");
    expect(result.models.map((m) => m.id)).toContain("gemini-experimental");
    expect(result.contextWindow).toBe(200_000);
  });

  it("dedupes concurrent codex CLI calls via singleflight", async () => {
    const execFileImpl: ExecFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        stdout: JSON.stringify({
          models: [
            { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 256_000, ...LISTED(7) },
          ],
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
      google: {
        models: {
          "gemini-new-model": chatModel("Gemini New (preview)", 200_000),
        },
      },
    });
    const service = new AgentModelCatalogService({ cachePath, fetchImpl });

    const result = await service.getResolvedModels("gemini");

    const newModel = result.models.find((m) => m.id === "gemini-new-model");
    expect(newModel).toBeDefined();
    // Trailing parenthetical is stripped to keep the label short.
    expect(newModel?.shortLabel).toBe("Gemini New");
  });
});
