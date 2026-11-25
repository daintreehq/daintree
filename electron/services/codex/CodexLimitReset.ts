import type {
  CodexLimitAnswer,
  CodexLimitEvidence,
  CodexLimitQuery,
  CodexLimitReset,
  CodexLimitStamp,
  CodexLimitStopSkip,
  CodexLimitUnknownReason,
} from "../../../shared/types/codexLimitReset.js";
import { liveAgentOf, type LiveAgentTerminal } from "../agentUsage/AgentUsageWatch.js";

/** A pane's record as a targeted read returns it, as far as this reads it. */
export interface CodexLimitTerminalRead extends LiveAgentTerminal {
  codexLimit?: CodexLimitAnswer;
}

export interface CodexLimitResetDeps {
  /** Null for a pane that is gone; rejects when its host didn't answer. */
  readTerminal(terminalId: string, query: CodexLimitQuery): Promise<CodexLimitTerminalRead | null>;
  /** A new reading of `home`, asked for now; null when there is none. */
  readEvidence(home: string): Promise<CodexLimitEvidence | null>;
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
    async readEvidence(home) {
      const { readCodexHomeLimitEvidence } = await import("./CodexQuotaService.js");
      return readCodexHomeLimitEvidence(home);
    },
  };
}

/** A reset answer, and the sighting of the banner it is about when one is held. */
export interface CodexLimitStop {
  reset: CodexLimitReset;
  /** Null when no banner answered: the reset is then unknown. */
  stamp: CodexLimitStamp | null;
  /** Set when the stamped stop isn't Daintree's to continue (#18192). */
  skipAtStop?: CodexLimitStopSkip;
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
  return (await readCodexLimitStop(terminalId, deps)).reset;
}

/**
 * {@link readCodexLimitReset}, naming the banner sighting the answer is about,
 * so a wait timed by it can be tied to that stop (#17909).
 */
export async function readCodexLimitStop(
  terminalId: string,
  deps: CodexLimitResetDeps = defaultDeps()
): Promise<CodexLimitStop> {
  const read = (query: CodexLimitQuery) =>
    deps.readTerminal(terminalId, query).catch(() => "unanswered" as const);
  const unknown = (reason: CodexLimitUnknownReason): CodexLimitStop => ({
    reset: { status: "unknown", reason },
    stamp: null,
  });
  let answer: CodexLimitStop = unknown("no-banner");
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const first = await read({});
    if (first === "unanswered") return unknown("not-observed");
    const asked = first?.codexLimit;
    if (!first || !asked) return unknown("no-banner");
    if ("reset" in asked) {
      const stop: CodexLimitStop = { reset: asked.reset, stamp: asked.stamp ?? null };
      if (asked.skipAtStop !== undefined) stop.skipAtStop = asked.skipAtStop;
      return stop;
    }
    const home = liveAgentOf(first) === "codex" ? first.codexHome : undefined;
    // Asked for only now, after the stamp read: so after the banner showed.
    const evidence = home ? await deps.readEvidence(home).catch(() => null) : null;
    const second = await read({ seq: asked.stamp.seq, run: asked.stamp.run, evidence });
    if (second === "unanswered") return unknown("not-observed");
    const resolved = second?.codexLimit;
    if (!resolved || !("reset" in resolved)) return unknown("no-banner");
    answer = { reset: resolved.reset, stamp: resolved.stamp ?? null };
    if (answer.reset.status === "known" || answer.reset.reason !== "banner-changed") return answer;
  }
  return answer;
}
