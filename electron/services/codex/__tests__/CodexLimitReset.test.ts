import { describe, expect, it, vi } from "vitest";
import type {
  CodexLimitAnswer,
  CodexLimitEvidence,
  CodexLimitQuery,
  CodexLimitReset,
} from "../../../../shared/types/codexLimitReset.js";
import {
  readCodexLimitReset,
  type CodexLimitResetDeps,
  type CodexLimitTerminalRead,
} from "../CodexLimitReset.js";

const HOME = "/Users/me/.codex-work";
const launched: CodexLimitTerminalRead = {
  hasPty: true,
  isExited: false,
  launchAgentId: "codex",
  detectedAgentId: "codex",
  agentIncarnation: 0,
  codexHome: HOME,
};
const evidence: CodexLimitEvidence = { requestedAt: 2_000, buckets: [] };
const known: CodexLimitReset = {
  status: "known",
  resetsAt: 9_000,
  precision: "second",
  source: "quota",
  observedAt: 1_000,
};

type Reply = CodexLimitAnswer | "gone" | "timeout";

/** A host holding pane `t1`; each read takes the next reply. */
function deps(replies: Reply[], terminal: CodexLimitTerminalRead = launched) {
  const reads: Array<[string, CodexLimitQuery]> = [];
  const homes: Array<[string, number]> = [];
  const fake: CodexLimitResetDeps = {
    readTerminal: vi.fn(async (id: string, query: CodexLimitQuery) => {
      reads.push([id, query]);
      if (id !== "t1") return null;
      const reply = replies.shift();
      if (reply === "timeout") throw new Error("timed out");
      return reply === undefined || reply === "gone" ? null : { ...terminal, codexLimit: reply };
    }),
    readEvidence: vi.fn(async (home: string, notBefore: number) => {
      homes.push([home, notBefore]);
      return evidence;
    }),
  };
  return { fake, reads, homes };
}

describe("readCodexLimitReset", () => {
  it("reads the pane's own home after its banner and hands the reading to the same pane", async () => {
    const { fake, reads, homes } = deps([
      { stamp: { seq: 4, run: "r1", observedAt: 1_000 } },
      { reset: known },
    ]);
    expect(await readCodexLimitReset("t1", fake)).toEqual(known);
    expect(homes).toEqual([[HOME, 1_000]]);
    expect(reads).toEqual([
      ["t1", {}],
      ["t1", { seq: 4, run: "r1", evidence }],
    ]);
  });

  it("asks about the pane it was given", async () => {
    const { fake, reads } = deps([{ reset: known }]);
    expect(await readCodexLimitReset("t2", fake)).toEqual({
      status: "unknown",
      reason: "no-banner",
    });
    expect(reads).toEqual([["t2", {}]]);
  });

  it("takes an answer the first read already settled without reading quota", async () => {
    const noReset: CodexLimitReset = { status: "unknown", reason: "no-reset", observedAt: 1_000 };
    const { fake, homes } = deps([{ reset: noReset }]);
    expect(await readCodexLimitReset("t1", fake)).toEqual(noReset);
    expect(homes).toEqual([]);
  });

  it("reads no quota for a Codex the launch can't vouch for", async () => {
    const { fake, reads, homes } = deps(
      [{ stamp: { seq: 1, run: "r1", observedAt: 1_000 } }, { reset: known }],
      { ...launched, agentIncarnation: 1 }
    );
    await readCodexLimitReset("t1", fake);
    expect(homes).toEqual([]);
    expect(reads[1]).toEqual(["t1", { seq: 1, run: "r1", evidence: null }]);
  });

  it("reads a banner replaced between the reads once more, against the new one", async () => {
    const changed: CodexLimitAnswer = { reset: { status: "unknown", reason: "banner-changed" } };
    const { fake, reads, homes } = deps([
      { stamp: { seq: 1, run: "r1", observedAt: 1_000 } },
      changed,
      { stamp: { seq: 2, run: "r2", observedAt: 1_500 } },
      { reset: known },
    ]);
    expect(await readCodexLimitReset("t1", fake)).toEqual(known);
    expect(homes.map(([, notBefore]) => notBefore)).toEqual([1_000, 1_500]);
    expect(reads[3]).toEqual(["t1", { seq: 2, run: "r2", evidence }]);
  });

  it("gives up after the second replacement rather than chase the screen", async () => {
    const changed: CodexLimitAnswer = { reset: { status: "unknown", reason: "banner-changed" } };
    const stamp: CodexLimitAnswer = { stamp: { seq: 1, run: "r1", observedAt: 1_000 } };
    const { fake, reads } = deps([stamp, changed, stamp, changed, stamp, { reset: known }]);
    expect(await readCodexLimitReset("t1", fake)).toEqual(changed.reset);
    expect(reads).toHaveLength(4);
  });

  it("tells a pane that is gone from a host that didn't answer", async () => {
    expect(await readCodexLimitReset("t1", deps(["gone"]).fake)).toEqual({
      status: "unknown",
      reason: "no-banner",
    });
    expect(await readCodexLimitReset("t1", deps(["timeout"]).fake)).toEqual({
      status: "unknown",
      reason: "not-observed",
    });
    expect(
      await readCodexLimitReset(
        "t1",
        deps([{ stamp: { seq: 1, run: "r1", observedAt: 1_000 } }, "timeout"]).fake
      )
    ).toEqual({ status: "unknown", reason: "not-observed" });
  });

  it("resolves without a reading when quota can't be read", async () => {
    const { fake, reads } = deps([
      { stamp: { seq: 1, run: "r1", observedAt: 1_000 } },
      { reset: known },
    ]);
    fake.readEvidence = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await readCodexLimitReset("t1", fake)).toEqual(known);
    expect(reads[1]).toEqual(["t1", { seq: 1, run: "r1", evidence: null }]);
  });
});
