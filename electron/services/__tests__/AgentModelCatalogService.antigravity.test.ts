vi.mock("../../utils/windowsCliSpawn.js", () => ({
  cliSpawnTarget: (command: string, args: string[]) => ({ command, args, shell: false }),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

import { AgentModelCatalogService } from "../AgentModelCatalogService.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { AgentCliDetail } from "../../../shared/types/ipc/system.js";
import {
  AGY_MODELS,
  AGY_MODELS_OFFLINE,
  AGY_MODELS_SPINNER_CLEARED,
} from "./fixtures/agyModelsOutput.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentModelCatalogService>[0]>;
type ExecFn = NonNullable<Deps["execFileImpl"]>;
type ExecCall = [string, string[], { env?: Record<string, string>; timeout?: number }];

const DAY_MS = 24 * 60 * 60 * 1000;

const BUNDLED = getEffectiveAgentConfig("antigravity")!.models!;
const BUNDLED_IDS = BUNDLED.map((m) => m.id);
const LISTED_IDS = AGY_MODELS.map((m) => m.id);

function listing(stdout: string, stderr = ""): ExecFn {
  return vi.fn(async () => ({ stdout, stderr })) as unknown as ExecFn;
}

function failing(err: Error & { code?: unknown }): ExecFn {
  return vi.fn(async () => {
    throw err;
  }) as unknown as ExecFn;
}

function enoent(): Error {
  return Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
}

function offline(): Error {
  return Object.assign(new Error("Command failed: agy models"), {
    code: 1,
    stdout: AGY_MODELS_OFFLINE,
    stderr: "",
  });
}

function calls(exec: ExecFn): ExecCall[] {
  return (exec as unknown as { mock: { calls: ExecCall[] } }).mock.calls;
}

function ready(resolvedPath: string, extra: Partial<AgentCliDetail> = {}): AgentCliDetail {
  return { state: "ready", resolvedPath, via: "native", ...extra };
}

function at(offsetMs: number): () => void {
  const realNow = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + offsetMs);
  return () => spy.mockRestore();
}

describe("AgentModelCatalogService — Antigravity", () => {
  let dir: string;
  let antigravityCachePath: string;
  let fetchImpl: NonNullable<Deps["fetchImpl"]>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-catalog-test-"));
    antigravityCachePath = path.join(dir, "antigravity-models.json");
    fetchImpl = vi.fn(async () => {
      throw new Error("models.dev must not be read for Antigravity");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function service(execFileImpl: ExecFn, extra: Partial<Deps> = {}): AgentModelCatalogService {
    return new AgentModelCatalogService({
      cachePath: path.join(dir, "models-catalog.json"),
      antigravityCachePath,
      fetchImpl,
      execFileImpl,
      ...extra,
    });
  }

  async function seedDisk(fetchedAt: number, ids: string[]): Promise<void> {
    await fs.writeFile(
      antigravityCachePath,
      JSON.stringify({ fetchedAt, models: ids.map((id) => ({ id, name: `Disk ${id}` })) }),
      "utf-8"
    );
  }

  it("lists what `agy models` prints, in its order, without reading models.dev", async () => {
    const exec = listing(AGY_MODELS_SPINNER_CLEARED);
    const result = await service(exec).getResolvedModels("antigravity");

    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    expect(result.models.map((m) => m.name)).toEqual(AGY_MODELS.map((m) => m.name));
    expect(result.source).toBe("merged");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls(exec)[0]![1]).toEqual(["models"]);
  });

  it("lets the CLI decide membership while bundled entries keep their short labels", async () => {
    const exec = listing(
      [
        `${BUNDLED[0]!.id}  Gemini Carbon, renamed`,
        "gemini-5-preview-high  Gemini 5 Preview (High)",
      ].join("\n")
    );
    const result = await service(exec).getResolvedModels("antigravity");

    expect(result.models).toEqual([
      { id: BUNDLED[0]!.id, name: "Gemini Carbon, renamed", shortLabel: BUNDLED[0]!.shortLabel },
      {
        id: "gemini-5-preview-high",
        name: "Gemini 5 Preview (High)",
        shortLabel: "Gemini 5 Preview",
      },
    ]);
  });

  it("falls back to the bundled list when agy isn't installed", async () => {
    const result = await service(failing(enoent())).getResolvedModels("antigravity");

    expect(result.models.map((m) => m.id)).toEqual(BUNDLED_IDS);
    expect(result.source).toBe("bundled");
  });

  it("falls back to the bundled list when an offline agy prints only a spinner and an error", async () => {
    for (const exec of [failing(offline()), listing(AGY_MODELS_OFFLINE)]) {
      const result = await service(exec).getResolvedModels("antigravity");
      expect(result.models.map((m) => m.id)).toEqual(BUNDLED_IDS);
      expect(result.source).toBe("bundled");
    }
  });

  it("reads rows from stderr when stdout has none", async () => {
    const exec = listing("", AGY_MODELS_SPINNER_CLEARED);
    const result = await service(exec).getResolvedModels("antigravity");
    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
  });

  it("waits a minute after a failed probe before spawning agy again", async () => {
    let attempt = 0;
    const exec = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw offline();
      return { stdout: AGY_MODELS_SPINNER_CLEARED, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);

    expect((await svc.getResolvedModels("antigravity")).source).toBe("bundled");
    expect((await svc.getResolvedModels("antigravity")).source).toBe("bundled");
    expect(exec).toHaveBeenCalledTimes(1);

    const restore = at(61_000);
    try {
      const recovered = await svc.getResolvedModels("antigravity");
      expect(exec).toHaveBeenCalledTimes(2);
      expect(recovered.models.map((m) => m.id)).toEqual(LISTED_IDS);
    } finally {
      restore();
    }
  });

  it("spawns agy once for concurrent callers", async () => {
    const exec = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { stdout: AGY_MODELS_SPINNER_CLEARED, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);

    const results = await Promise.all([
      svc.getResolvedModels("antigravity"),
      svc.getResolvedModels("antigravity"),
      svc.getResolvedModels("antigravity"),
    ]);

    expect(exec).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
  });

  it("persists a good listing so the next session reads it without spawning agy", async () => {
    await service(listing(AGY_MODELS_SPINNER_CLEARED)).getResolvedModels("antigravity");
    await vi.waitFor(async () => {
      const written = JSON.parse(await fs.readFile(antigravityCachePath, "utf-8"));
      expect(written.models.map((m: { id: string }) => m.id)).toEqual(LISTED_IDS);
    });

    const exec = failing(offline());
    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).not.toHaveBeenCalled();
    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
  });

  it("keeps a day-old listing from disk when the refresh fails offline", async () => {
    await seedDisk(Date.now() - DAY_MS - 1_000, ["gemini-4-carbon-high", "gemini-legacy"]);
    const exec = failing(offline());

    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.models.map((m) => m.id)).toEqual(["gemini-4-carbon-high", "gemini-legacy"]);
  });

  it("replaces a day-old listing on disk when the refresh succeeds", async () => {
    await seedDisk(Date.now() - DAY_MS - 1_000, ["gemini-legacy"]);

    const result = await service(listing(AGY_MODELS_SPINNER_CLEARED)).getResolvedModels(
      "antigravity"
    );

    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    await vi.waitFor(async () => {
      const written = JSON.parse(await fs.readFile(antigravityCachePath, "utf-8"));
      expect(written.models.map((m: { id: string }) => m.id)).toEqual(LISTED_IDS);
    });
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["an empty model list", JSON.stringify({ fetchedAt: Date.now(), models: [] })],
    ["a missing timestamp", JSON.stringify({ models: [{ id: "x", name: "X" }] })],
    [
      "a timestamp from the future",
      JSON.stringify({ fetchedAt: Date.now() + DAY_MS, models: [{ id: "x", name: "X" }] }),
    ],
  ])("asks agy again over a cache file with %s", async (_label, contents) => {
    await fs.writeFile(antigravityCachePath, contents, "utf-8");
    const exec = listing(AGY_MODELS_SPINNER_CLEARED);

    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
  });

  it("keeps the last listing in memory when it couldn't be written and the refresh fails", async () => {
    // A path under a regular file can't be created, so the persist fails.
    await fs.writeFile(path.join(dir, "blocker"), "", "utf-8");
    antigravityCachePath = path.join(dir, "blocker", "antigravity-models.json");
    let attempt = 0;
    const exec = vi.fn(async () => {
      attempt += 1;
      if (attempt > 1) throw offline();
      return { stdout: AGY_MODELS_SPINNER_CLEARED, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);

    await svc.getResolvedModels("antigravity");
    const restore = at(DAY_MS + 1_000);
    try {
      const result = await svc.getResolvedModels("antigravity");
      expect(exec).toHaveBeenCalledTimes(2);
      expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    } finally {
      restore();
    }
  });

  describe("which agy it runs", () => {
    it("runs the copy availability detection resolved, such as a native install off PATH", async () => {
      const exec = listing(AGY_MODELS_SPINNER_CLEARED);
      await service(exec, {
        getCliDetail: async () => ready("/home/u/.local/bin/agy"),
      }).getResolvedModels("antigravity");

      expect(calls(exec)[0]![0]).toBe("/home/u/.local/bin/agy");
    });

    it("runs agy from PATH before availability detection has answered", async () => {
      const exec = listing(AGY_MODELS_SPINNER_CLEARED);
      await service(exec, { getCliDetail: async () => undefined }).getResolvedModels("antigravity");

      expect(calls(exec)[0]![0]).toBe("agy");
    });

    it.each<[string, AgentCliDetail]>([
      [
        "a chosen copy that is missing",
        { state: "missing", resolvedPath: null, via: null, chosenPath: "/opt/agy" },
      ],
      ["no copy at all", { state: "missing", resolvedPath: null, via: null }],
      ["a copy only inside WSL", ready("/usr/local/bin/agy", { via: "wsl", wslDistro: "Ubuntu" })],
    ])("runs nothing for %s and offers the bundled list", async (_label, detail) => {
      const exec = listing(AGY_MODELS_SPINNER_CLEARED);
      const result = await service(exec, { getCliDetail: async () => detail }).getResolvedModels(
        "antigravity"
      );

      expect(exec).not.toHaveBeenCalled();
      expect(result.models.map((m) => m.id)).toEqual(BUNDLED_IDS);
    });
  });

  it("passes Antigravity's API key and proxy settings, and no other credential", async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      GOOGLE_API_KEY: "google-key",
      HTTPS_PROXY: "http://proxy:8080",
      OPENAI_API_KEY: "sk-x",
    };
    try {
      const exec = listing(AGY_MODELS_SPINNER_CLEARED);
      await service(exec).getResolvedModels("antigravity");

      const env = calls(exec)[0]![2].env!;
      expect(env.GOOGLE_API_KEY).toBe("google-key");
      expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
});
