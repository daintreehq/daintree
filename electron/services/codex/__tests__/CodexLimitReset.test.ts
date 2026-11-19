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

function deps(
  answers: CodexLimitAnswer[],
  terminal: CodexLimitTerminalRead = launched
): CodexLimitResetDeps & { queries: CodexLimitQuery[]; homes: Array<[string, number]> } {
  const queries: CodexLimitQuery[] = [];
  const homes: Array<[string, number]> = [];
  return {
    queries,
    homes,
    readTerminal: vi.fn(async (_id: string, query: CodexLimitQuery) => {
      queries.push(query);
      const codexLimit = answers.shift();
      return codexLimit === undefined ? null : { ...terminal, codexLimit };
    }),
    readEvidence: vi.fn(async (home: string, notBefore: number) => {
      homes.push([home, notBefore]);
      return evidence;
    }),
  };
}

describe("readCodexLimitReset", () => {
  it("reads the pane's own home after its banner and hands the reading in", async () => {
    const d = deps([{ stamp: { seq: 4, observedAt: 1_000 } }, { reset: known }]);
    expect(await readCodexLimitReset("t1", d)).toEqual(known);
    expect(d.homes).toEqual([[HOME, 1_000]]);
    expect(d.queries).toEqual([{}, { seq: 4, evidence }]);
  });

  it("takes an answer the first read already settled without reading quota", async () => {
    const noReset: CodexLimitReset = { status: "unknown", reason: "no-reset", observedAt: 1_000 };
    const d = deps([{ reset: noReset }]);
    expect(await readCodexLimitReset("t1", d)).toEqual(noReset);
    expect(d.homes).toEqual([]);
  });

  it("reads no quota for a Codex the launch can't vouch for", async () => {
    const d = deps([{ stamp: { seq: 1, observedAt: 1_000 } }, { reset: known }], {
      ...launched,
      agentIncarnation: 1,
    });
    await readCodexLimitReset("t1", d);
    expect(d.homes).toEqual([]);
    expect(d.queries[1]).toEqual({ seq: 1, evidence: null });
  });

  it("reads a banner replaced between the reads once more", async () => {
    const changed: CodexLimitAnswer = { reset: { status: "unknown", reason: "banner-changed" } };
    const d = deps([
      { stamp: { seq: 1, observedAt: 1_000 } },
      changed,
      { stamp: { seq: 2, observedAt: 1_500 } },
      { reset: known },
    ]);
    expect(await readCodexLimitReset("t1", d)).toEqual(known);
    expect(d.homes.map(([, notBefore]) => notBefore)).toEqual([1_000, 1_500]);
  });

  it("answers no banner for a pane that is gone or a host that doesn't answer", async () => {
    expect(await readCodexLimitReset("t1", deps([]))).toEqual({
      status: "unknown",
      reason: "no-banner",
    });
    const failing = deps([{ stamp: { seq: 1, observedAt: 1_000 } }]);
    failing.readEvidence = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await readCodexLimitReset("t1", failing)).toEqual({
      status: "unknown",
      reason: "no-banner",
    });
    expect(failing.queries[1]).toEqual({ seq: 1, evidence: null });
  });
});
