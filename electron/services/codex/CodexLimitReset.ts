import type {
  CodexLimitAnswer,
  CodexLimitEvidence,
  CodexLimitQuery,
  CodexLimitReset,
} from "../../../shared/types/codexLimitReset.js";
import { liveAgentOf, type LiveAgentTerminal } from "../agentUsage/AgentUsageWatch.js";

/** A pane's record as a targeted read returns it, as far as this reads it. */
export interface CodexLimitTerminalRead extends LiveAgentTerminal {
  codexLimit?: CodexLimitAnswer;
}

export interface CodexLimitResetDeps {
  /** Null for a pane that is gone; rejects when its host didn't answer. */
  readTerminal(terminalId: string, query: CodexLimitQuery): Promise<CodexLimitTerminalRead | null>;
  readEvidence(home: string, notBefore: number): Promise<CodexLimitEvidence | null>;
}

/** A banner replaced between the two reads is read again, once. */
const ATTEMPTS = 2;

function defaultDeps(): CodexLimitResetDeps {
  return {
    async readTerminal(terminalId, query) {
      const { getPtyClient } = await import("../../window/serviceRefs.js");
      const pty = getPtyClient();
      return pty
        ? pty.getTerminalAsync(terminalId, undefined, { strict: true, codexLimit: query })
        : null;
    },
    async readEvidence(home, notBefore) {
      const { readCodexHomeLimitEvidence } = await import("./CodexQuotaService.js");
      return readCodexHomeLimitEvidence(home, notBefore);
    },
  };
}

/**
 * When the Codex pane `terminalId` on this machine can go on: the reset of the
 * window its stop banner says is spent, or why that can't be told (#17906).
 *
 * The pty host holds the banner and judges it; this reads the quota of the
 * pane's own Codex home, asked for after the banner showed, and hands it in.
 * A pane the launch can't vouch for (a Codex run in a shell rather than the
 * one Daintree started) gets no reading. Never rejects.
 */
export async function readCodexLimitReset(
  terminalId: string,
  deps: CodexLimitResetDeps = defaultDeps()
): Promise<CodexLimitReset> {
  const read = (query: CodexLimitQuery) =>
    deps.readTerminal(terminalId, query).catch(() => "unanswered" as const);
  let answer: CodexLimitReset = { status: "unknown", reason: "no-banner" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const first = await read({});
    if (first === "unanswered") return { status: "unknown", reason: "not-observed" };
    const asked = first?.codexLimit;
    if (!first || !asked) return { status: "unknown", reason: "no-banner" };
    if ("reset" in asked) return asked.reset;
    const home = liveAgentOf(first) === "codex" ? first.codexHome : undefined;
    const evidence = home
      ? await deps.readEvidence(home, asked.stamp.observedAt).catch(() => null)
      : null;
    const second = await read({ seq: asked.stamp.seq, run: asked.stamp.run, evidence });
    if (second === "unanswered") return { status: "unknown", reason: "not-observed" };
    const resolved = second?.codexLimit;
    if (!resolved || !("reset" in resolved)) return { status: "unknown", reason: "no-banner" };
    answer = resolved.reset;
    if (answer.status === "known" || answer.reason !== "banner-changed") return answer;
  }
  return answer;
}
