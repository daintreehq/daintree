import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants as fsConstants, readFileSync } from "fs";
import { mkdtemp, rename, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const fsHook = vi.hoisted(() => ({
  opened: [] as { fd: number }[],
  /** Bytes asked for by each read through an opened handle. */
  reads: [] as number[],
  beforeOpen: undefined as ((target: string) => Promise<void>) | undefined,
  noFollow: true,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NOFOLLOW() {
        return fsHook.noFollow ? actual.constants.O_NOFOLLOW : undefined;
      },
    },
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    open: async (target: string, flags?: string | number, mode?: number) => {
      await fsHook.beforeOpen?.(target);
      const handle = await actual.open(target, flags, mode);
      fsHook.opened.push(handle);
      const read = handle.read.bind(handle) as (...args: unknown[]) => unknown;
      handle.read = ((...args: unknown[]) => {
        if (typeof args[2] === "number") fsHook.reads.push(args[2]);
        return read(...args);
      }) as typeof handle.read;
      return handle;
    },
  };
});

import { readCodexContextUsage } from "../CodexRolloutReader.js";
import type { CodexRolloutIdentity } from "../CodexSessionFileProbe.js";

/**
 * Stretches of real rollouts written by codex-cli 0.165.0 and 0.166.0, with
 * long strings cut short and personal paths, ids and balances replaced. The
 * record envelopes and every token count are as Codex wrote them.
 */
function fixture(name: string): string[] {
  const text = readFileSync(path.join(__dirname, "fixtures", "rollouts", name), "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

const COMPACTION = fixture("codex-0.166.0-compaction.jsonl");

function ordinalOf(line: string): number {
  return (JSON.parse(line) as { ordinal: number }).ordinal;
}

/** The compaction stretch as it stood once the record at `ordinal` was written. */
function compactionUpTo(ordinal: number): string[] {
  return COMPACTION.filter((line) => ordinalOf(line) <= ordinal);
}

function tokenCount(
  info: Record<string, unknown> | null,
  timestamp: unknown = "2026-11-05T14:27:11.051Z"
): string {
  return JSON.stringify({
    timestamp,
    ordinal: 1,
    type: "event_msg",
    payload: { type: "token_count", info, rate_limits: null },
  });
}

function usage(total: number, parts: Partial<Record<string, number>> = {}) {
  return {
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 5,
    total_tokens: total,
    ...parts,
  };
}

function info(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_token_usage: usage(9_000),
    last_token_usage: usage(4_000),
    last_usage_includes_reasoning: true,
    model_context_window: 475_000,
    ...extra,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codex-rollout-"));
  fsHook.opened = [];
  fsHook.reads = [];
  fsHook.beforeOpen = undefined;
  fsHook.noFollow = true;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a rollout and names it the way the probe does: path, `lsof`'s hex device, decimal inode. */
async function seed(lines: string[], options: { tail?: string } = {}) {
  const file = path.join(dir, "rollout-2026-11-05T06-41-26-01a1aa03.jsonl");
  await writeFile(file, lines.map((line) => `${line}\n`).join("") + (options.tail ?? ""), "utf8");
  return identify(file);
}

async function identify(file: string): Promise<CodexRolloutIdentity> {
  const stats = await stat(file, { bigint: true });
  return { path: file, device: `0x${stats.dev.toString(16)}`, inode: stats.ino.toString() };
}

describe("readCodexContextUsage against real rollouts (#16408)", () => {
  it("reads the newest count and the window a 0.166.0 rollout states", async () => {
    const rollout = await seed(fixture("codex-0.166.0-turn-end.jsonl"));

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "ok",
      provider: "codex",
      contextTokens: 192_480,
      contextWindow: 475_000,
      recordedAt: Date.parse("2026-11-05T14:27:11.051Z"),
    });
  });

  it("reads a 0.165.0 rollout, written before the reasoning flag", async () => {
    const lines = fixture("codex-0.165.0-turn-end.jsonl");
    expect(lines.some((line) => line.includes("last_usage_includes_reasoning"))).toBe(false);
    const rollout = await seed(lines);

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "ok",
      provider: "codex",
      contextTokens: 93_090,
      contextWindow: 475_000,
      recordedAt: Date.parse("2026-10-29T09:03:04.734Z"),
    });
  });

  it("gives the same answer however the reads fall across lines", async () => {
    const rollout = await seed(fixture("codex-0.166.0-turn-end.jsonl"));

    expect(await readCodexContextUsage(rollout, { chunkBytes: 7 })).toMatchObject({
      contextTokens: 192_480,
    });
    expect(fsHook.reads.length).toBeGreaterThan(1);
    expect(Math.max(...fsHook.reads)).toBeLessThanOrEqual(7);
  });

  it("answers no-request before the session's first count", async () => {
    const rollout = await seed(fixture("codex-0.165.0-session-start.jsonl"));

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "no-request",
    });
  });

  it("answers no-request between a compaction and the count Codex writes after it", async () => {
    const rollout = await seed(compactionUpTo(1601));

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "no-request",
    });
  });

  it("reads Codex's own estimate of what a compaction left", async () => {
    const estimate = JSON.parse(COMPACTION.find((line) => ordinalOf(line) === 1602) ?? "{}");
    const { last_token_usage: last, last_usage_includes_reasoning: flag } = estimate.payload.info;
    expect(flag).toBe(true);
    expect(
      [
        last.input_tokens,
        last.cached_input_tokens,
        last.cache_write_input_tokens,
        last.output_tokens,
        last.reasoning_output_tokens,
      ].every((part: number) => part === 0)
    ).toBe(true);
    const rollout = await seed(compactionUpTo(1611));

    expect(await readCodexContextUsage(rollout)).toMatchObject({
      status: "ok",
      contextTokens: 25_757,
      contextWindow: 475_000,
    });
  });

  it("reads the first request after a compaction", async () => {
    const rollout = await seed(COMPACTION);

    expect(await readCodexContextUsage(rollout)).toMatchObject({
      status: "ok",
      contextTokens: 22_587,
    });
  });
});

describe("readCodexContextUsage record shapes", () => {
  it.each([
    ["absent", { model_context_window: undefined }],
    ["null", { model_context_window: null }],
  ])("reads the count alone when the window is %s", async (_label, extra) => {
    const rollout = await seed([tokenCount(info(extra))]);

    const result = await readCodexContextUsage(rollout);
    expect(result).toMatchObject({ status: "ok", contextTokens: 4_000 });
    expect(result).not.toHaveProperty("contextWindow");
  });

  it("reads whatever window the record states", async () => {
    const rollout = await seed([tokenCount(info({ model_context_window: 200_000 }))]);

    expect(await readCodexContextUsage(rollout)).toMatchObject({
      contextTokens: 4_000,
      contextWindow: 200_000,
    });
  });

  it("reads a count written before Codex recorded cache writes", async () => {
    const last = usage(4_000);
    delete (last as Partial<typeof last>).cache_write_input_tokens;
    const rollout = await seed([tokenCount(info({ last_token_usage: last }))]);

    expect(await readCodexContextUsage(rollout)).toMatchObject({ contextTokens: 4_000 });
  });

  it("answers no-request for a count with no usage yet, never an older count", async () => {
    const rollout = await seed([tokenCount(info()), tokenCount(null)]);

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "no-request",
    });
  });

  it.each<[string, string]>([
    ["no info object", tokenCount("full" as unknown as Record<string, unknown>)],
    ["no last usage", tokenCount(info({ last_token_usage: undefined }))],
    [
      "a missing total",
      tokenCount(info({ last_token_usage: usage(1, { total_tokens: undefined }) })),
    ],
    ["a negative part", tokenCount(info({ last_token_usage: usage(4_000, { input_tokens: -1 }) }))],
    ["a fractional total", tokenCount(info({ last_token_usage: usage(4_000.5) }))],
    ["a window that isn't a number", tokenCount(info({ model_context_window: "475000" }))],
    ["a window of zero", tokenCount(info({ model_context_window: 0 }))],
    ["no time", tokenCount(info(), null)],
    ["a time that won't parse", tokenCount(info(), "yesterday")],
    ["a line that won't parse", '{"type":"event_msg","payload":{"type":"token_count"'],
    ["an event with no payload", JSON.stringify({ type: "event_msg", payload: "token_count" })],
  ])(
    "answers unrecognized for a newest count with %s, never an older one",
    async (_label, line) => {
      const rollout = await seed([tokenCount(info()), line]);

      expect(await readCodexContextUsage(rollout)).toEqual({
        status: "unavailable",
        reason: "unrecognized",
      });
    }
  );

  // `fill_to_context_window` writes the step up to the window as the last
  // usage, with every part zero and no reasoning flag: not the context. Only
  // Codex's own estimate carries the flag, set to true.
  it.each([
    ["absent", undefined],
    ["false", false],
    ["null", null],
    ["a string", "true"],
  ])(
    "answers unrecognized for a count with every part zero and the reasoning flag %s",
    async (_label, flag) => {
      const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
      const filled = info({
        total_token_usage: usage(475_000, { ...zero, reasoning_output_tokens: 0 }),
        last_token_usage: usage(1_200, { ...zero, reasoning_output_tokens: 0 }),
        last_usage_includes_reasoning: flag,
      });
      const rollout = await seed([tokenCount(info()), tokenCount(filled)]);

      expect(await readCodexContextUsage(rollout)).toEqual({
        status: "unavailable",
        reason: "unrecognized",
      });
    }
  );

  it("steps over records that say nothing about the context", async () => {
    const rollout = await seed([
      tokenCount(info()),
      JSON.stringify({ type: "token_usage_record", payload: { usage: usage(1) } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      "",
    ]);

    expect(await readCodexContextUsage(rollout)).toMatchObject({ contextTokens: 4_000 });
  });

  it("answers unrecognized while the newest line is still being written", async () => {
    const rollout = await seed([tokenCount(info())], { tail: '{"type":"compac' });

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "unrecognized",
    });
  });

  it("stops at its ceiling rather than reading the whole file", async () => {
    const filler = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4_096) } });
    const rollout = await seed([tokenCount(info()), filler]);

    expect(await readCodexContextUsage(rollout, { chunkBytes: 512, maxScanBytes: 2_048 })).toEqual({
      status: "unavailable",
      reason: "search-cap-reached",
    });
    expect(fsHook.reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(2_048);
  });
});

describe("readCodexContextUsage file checks", () => {
  it("refuses a file that is no longer the one the probe saw", async () => {
    const rollout = await seed([tokenCount(info())]);
    const replacement = path.join(dir, "replacement.jsonl");
    await writeFile(replacement, `${tokenCount(info({ last_token_usage: usage(9) }))}\n`);
    await rename(replacement, rollout.path);

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "rollout-unknown",
    });
    expect(fsHook.opened).toHaveLength(0);
  });

  it("refuses a file swapped in between its check and its open", async () => {
    const rollout = await seed([tokenCount(info())]);
    const replacement = path.join(dir, "replacement.jsonl");
    await writeFile(replacement, `${tokenCount(info({ last_token_usage: usage(9) }))}\n`);
    fsHook.beforeOpen = () => rename(replacement, rollout.path);

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "rollout-unknown",
    });
    expect(fsHook.opened.map((handle) => handle.fd)).toEqual([-1]);
  });

  // The link leads back to the observed file, so identity alone cannot
  // reject it. Neither the native flag nor its fallback may read through it.
  it.each([true, false])(
    "refuses a symlink swapped before open (O_NOFOLLOW=%s)",
    async (noFollow) => {
      fsHook.noFollow = noFollow;
      const rollout = await seed([tokenCount(info())]);
      const moved = path.join(dir, "moved.jsonl");
      fsHook.beforeOpen = async () => {
        await rename(rollout.path, moved);
        await symlink(moved, rollout.path);
      };

      expect(await readCodexContextUsage(rollout)).toMatchObject({ status: "unavailable" });
      expect(fsHook.reads).toHaveLength(0);
      if (fsConstants.O_NOFOLLOW) expect(fsHook.opened).toHaveLength(0);
      else expect(fsHook.opened.map((handle) => handle.fd)).toEqual([-1]);
    }
  );

  it("refuses a symlink at the rollout's path", async () => {
    const real = await seed([tokenCount(info())]);
    const link = path.join(dir, "link.jsonl");
    await symlink(real.path, link);

    expect(await readCodexContextUsage({ ...real, path: link })).toEqual({
      status: "unavailable",
      reason: "rollout-unknown",
    });
  });

  it.each([
    ["a device lsof never prints", { device: "16777232" }],
    ["an inode that isn't decimal", { inode: "0x10" }],
  ])("refuses %s", async (_label, change) => {
    const rollout = await seed([tokenCount(info())]);

    expect(await readCodexContextUsage({ ...rollout, ...change })).toEqual({
      status: "unavailable",
      reason: "rollout-unknown",
    });
  });

  it("answers rollout-unknown for a rollout that has gone", async () => {
    const rollout = await seed([tokenCount(info())]);
    await rm(rollout.path);

    expect(await readCodexContextUsage(rollout)).toEqual({
      status: "unavailable",
      reason: "rollout-unknown",
    });
  });

  it("closes the file it opened", async () => {
    const rollout = await seed([tokenCount(info())]);

    await readCodexContextUsage(rollout);

    expect(fsHook.opened.map((handle) => handle.fd)).toEqual([-1]);
  });

  it("stops when asked to", async () => {
    const rollout = await seed([tokenCount(info())]);
    const controller = new AbortController();
    controller.abort();

    await expect(readCodexContextUsage(rollout, { signal: controller.signal })).rejects.toThrow();
    expect(fsHook.opened).toHaveLength(0);
  });
});
