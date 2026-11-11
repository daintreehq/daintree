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
import { AGY_MODELS_OFFLINE, agyModelsListing } from "./fixtures/agyModelsOutput.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentModelCatalogService>[0]>;
type ExecFn = NonNullable<Deps["execFileImpl"]>;
type ExecCall = [string, string[], { env?: Record<string, string>; timeout?: number }];

const DAY_MS = 24 * 60 * 60 * 1000;

const BUNDLED = getEffectiveAgentConfig("antigravity")!.models!;
const BUNDLED_IDS = BUNDLED.map((m) => m.id);

// What agy lists in these tests: deliberately not the bundled list, in a
// different order and with different names, so a fallback to the bundled list
// can never pass for an answer from the CLI.
const LISTED = [
  { id: "gemini-5-preview-high", name: "Gemini 5 Preview (High)" },
  { id: BUNDLED[1]!.id, name: "Argon, as agy names it" },
  { id: BUNDLED[0]!.id, name: "Carbon, as agy names it" },
];
const LISTED_IDS = LISTED.map((m) => m.id);
const LISTING = agyModelsListing(LISTED);

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

/** Pins `Date.now` to a clock the test moves; restore before any `vi.waitFor`. */
function frozenClock(): { advance: (ms: number) => void; restore: () => void } {
  let now = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    advance: (ms) => {
      now += ms;
    },
    restore: () => spy.mockRestore(),
  };
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

  /**
   * Waits for the background persist to land `ids`. Every test whose probe
   * succeeds waits on it, so no write is left racing the temp dir's removal.
   */
  async function persisted(ids: string[]): Promise<void> {
    await vi.waitFor(async () => {
      const written = JSON.parse(await fs.readFile(antigravityCachePath, "utf-8")) as {
        models: { id: string }[];
      };
      expect(written.models.map((m) => m.id)).toEqual(ids);
    });
  }

  it("lists what `agy models` prints, in its order, without reading models.dev", async () => {
    const exec = listing(LISTING);
    const result = await service(exec).getResolvedModels("antigravity");

    // Membership and order are the CLI's; agy's names win, and a bundled entry
    // keeps its short label.
    expect(result.models).toEqual([
      { id: LISTED[0]!.id, name: LISTED[0]!.name, shortLabel: "Gemini 5 Preview" },
      { id: LISTED[1]!.id, name: LISTED[1]!.name, shortLabel: BUNDLED[1]!.shortLabel },
      { id: LISTED[2]!.id, name: LISTED[2]!.name, shortLabel: BUNDLED[0]!.shortLabel },
    ]);
    expect(result.source).toBe("merged");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls(exec)[0]![1]).toEqual(["models"]);
    await persisted(LISTED_IDS);
  });

  it("falls back to the bundled list when agy isn't installed", async () => {
    const exec = failing(enoent());
    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
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
    const result = await service(listing("", LISTING)).getResolvedModels("antigravity");

    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    expect(result.source).toBe("merged");
    await persisted(LISTED_IDS);
  });

  it("waits a full minute after a failed probe before spawning agy again", async () => {
    let attempt = 0;
    const exec = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw offline();
      return { stdout: LISTING, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);
    const clock = frozenClock();
    try {
      expect((await svc.getResolvedModels("antigravity")).source).toBe("bundled");
      clock.advance(59_999);
      expect((await svc.getResolvedModels("antigravity")).source).toBe("bundled");
      expect(exec).toHaveBeenCalledTimes(1);

      clock.advance(1);
      const recovered = await svc.getResolvedModels("antigravity");
      expect(exec).toHaveBeenCalledTimes(2);
      expect(recovered.source).toBe("merged");
      expect(recovered.models.map((m) => m.id)).toEqual(LISTED_IDS);
    } finally {
      clock.restore();
    }
    await persisted(LISTED_IDS);
  });

  it("doesn't let a clock set back stretch the pause after a failed probe", async () => {
    const exec = failing(offline());
    const svc = service(exec);
    const clock = frozenClock();
    try {
      await svc.getResolvedModels("antigravity");
      clock.advance(-2 * 60 * 60 * 1000);
      await svc.getResolvedModels("antigravity");
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      clock.restore();
    }
  });

  it("spawns agy once for concurrent callers and gives each its answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exec = vi.fn(async () => {
      await gate;
      return { stdout: LISTING, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);

    const pending = [
      svc.getResolvedModels("antigravity"),
      svc.getResolvedModels("antigravity"),
      svc.getResolvedModels("antigravity"),
    ];
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(pending);

    expect(exec).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.source).toBe("merged");
      expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    }
    await persisted(LISTED_IDS);
  });

  it("persists a good listing so the next session reads it without spawning agy", async () => {
    const first = await service(listing(LISTING)).getResolvedModels("antigravity");
    await persisted(LISTED_IDS);

    const exec = failing(offline());
    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).not.toHaveBeenCalled();
    expect(result.source).toBe("merged");
    expect(result.models).toEqual(first.models);
  });

  it("keeps a day-old listing from disk when the refresh fails offline", async () => {
    await seedDisk(Date.now() - DAY_MS - 1_000, ["gemini-4-carbon-high", "gemini-legacy-high"]);
    const exec = failing(offline());

    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.models.map((m) => m.id)).toEqual(["gemini-4-carbon-high", "gemini-legacy-high"]);
  });

  it("replaces a day-old listing on disk when the refresh succeeds", async () => {
    await seedDisk(Date.now() - DAY_MS - 1_000, ["gemini-legacy-high"]);

    const result = await service(listing(LISTING)).getResolvedModels("antigravity");

    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    await persisted(LISTED_IDS);
  });

  it("keeps the stale disk listing, and pauses, when the probe throws unexpectedly", async () => {
    await seedDisk(Date.now() - DAY_MS - 1_000, ["gemini-legacy-high"]);
    // A result with no output at all is malformed, so reading it throws past
    // the probe's own error handling.
    const exec = vi.fn(async () => ({})) as unknown as ExecFn;
    const svc = service(exec);

    const first = await svc.getResolvedModels("antigravity");
    const second = await svc.getResolvedModels("antigravity");

    expect(first.models.map((m) => m.id)).toEqual(["gemini-legacy-high"]);
    expect(second.models.map((m) => m.id)).toEqual(["gemini-legacy-high"]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["an empty model list", JSON.stringify({ fetchedAt: Date.now(), models: [] })],
    ["a missing timestamp", JSON.stringify({ models: [{ id: "gemini-disk-high", name: "D" }] })],
    ["models that aren't a list", JSON.stringify({ fetchedAt: Date.now(), models: "x" })],
  ])("treats a cache file with %s as absent", async (_label, contents) => {
    await fs.writeFile(antigravityCachePath, contents, "utf-8");
    const exec = failing(offline());

    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("bundled");
    expect(result.models.map((m) => m.id)).toEqual(BUNDLED_IDS);
  });

  it("asks agy again over a cache file dated in the future", async () => {
    await seedDisk(Date.now() + DAY_MS, ["gemini-future-high"]);
    const exec = listing(LISTING);

    const result = await service(exec).getResolvedModels("antigravity");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    await persisted(LISTED_IDS);
  });

  it("keeps the last listing in memory when it couldn't be written and the refresh fails", async () => {
    // A path under a regular file can't be created, so the persist fails.
    await fs.writeFile(path.join(dir, "blocker"), "", "utf-8");
    antigravityCachePath = path.join(dir, "blocker", "antigravity-models.json");
    let attempt = 0;
    const exec = vi.fn(async () => {
      attempt += 1;
      if (attempt > 1) throw offline();
      return { stdout: LISTING, stderr: "" };
    }) as unknown as ExecFn;
    const svc = service(exec);

    await svc.getResolvedModels("antigravity");
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "[AgentModelCatalogService] antigravity disk write failed",
        expect.anything()
      )
    );
    const clock = frozenClock();
    try {
      clock.advance(DAY_MS + 1_000);
      const result = await svc.getResolvedModels("antigravity");
      expect(exec).toHaveBeenCalledTimes(2);
      expect(result.source).toBe("merged");
      expect(result.models.map((m) => m.id)).toEqual(LISTED_IDS);
    } finally {
      clock.restore();
    }
  });

  describe("which agy it runs", () => {
    it("runs the copy availability detection resolved, such as a native install off PATH", async () => {
      const exec = listing(LISTING);
      const getCliDetail = vi.fn(async () => ready("/home/u/.local/bin/agy"));
      await service(exec, { getCliDetail }).getResolvedModels("antigravity");

      expect(getCliDetail).toHaveBeenCalledWith("antigravity");
      expect(calls(exec)[0]![0]).toBe("/home/u/.local/bin/agy");
      await persisted(LISTED_IDS);
    });

    it("runs agy from PATH before availability detection has answered", async () => {
      const exec = listing(LISTING);
      await service(exec, { getCliDetail: async () => undefined }).getResolvedModels("antigravity");

      expect(calls(exec)[0]![0]).toBe("agy");
      await persisted(LISTED_IDS);
    });

    it.each<[string, AgentCliDetail]>([
      [
        "a chosen copy that is missing",
        { state: "missing", resolvedPath: null, via: null, chosenPath: "/opt/agy" },
      ],
      [
        "a chosen copy with no path to run",
        { state: "ready", resolvedPath: null, via: "chosen", chosenPath: "/opt/agy" },
      ],
      ["no copy at all", { state: "missing", resolvedPath: null, via: null }],
      ["a copy only inside WSL", ready("/usr/local/bin/agy", { via: "wsl", wslDistro: "Ubuntu" })],
    ])("runs nothing for %s and offers the bundled list", async (_label, detail) => {
      const exec = listing(LISTING);
      const result = await service(exec, { getCliDetail: async () => detail }).getResolvedModels(
        "antigravity"
      );

      expect(exec).not.toHaveBeenCalled();
      expect(result.source).toBe("bundled");
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
      const exec = listing(LISTING);
      await service(exec).getResolvedModels("antigravity");

      const env = calls(exec)[0]![2].env!;
      expect(env.GOOGLE_API_KEY).toBe("google-key");
      expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
    await persisted(LISTED_IDS);
  });
});
