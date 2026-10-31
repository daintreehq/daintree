import { describe, expect, it } from "vitest";
import { RelayNoticeSchema, RelayNoticesPayloadSchema } from "../linkMethods.js";

const AT = Date.parse("2026-10-18T09:58:12.345Z");

const relayed = (extra: Record<string, unknown> = {}) => ({
  noticeId: "n-1",
  helpSessionId: "help-1",
  callId: "call-1",
  terminalId: "t-1",
  observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
  ...extra,
});

describe("a relayed notice's transition on the wire (#15726)", () => {
  it("takes a host's transition, null for none, and a notice from a host that predates it", () => {
    const parsed = RelayNoticesPayloadSchema.parse({
      notices: [
        relayed({ lastTransitionAt: AT }),
        relayed({ noticeId: "n-2", observation: { kind: "closed" }, lastTransitionAt: null }),
        relayed({ noticeId: "n-3" }),
      ],
    });
    expect(parsed.notices.map((n) => n.lastTransitionAt)).toEqual([AT, null, undefined]);
    expect(parsed.notices[2]).not.toHaveProperty("lastTransitionAt");
  });

  it("lets a Shell that predates it read a newer host's notice, dropping only the transition", () => {
    // The schema an older Shell parses with: the same, without the field.
    const older = RelayNoticeSchema.omit({ lastTransitionAt: true });
    const parsed = older.parse(relayed({ lastTransitionAt: AT, awaitingHandback: true }));
    expect(parsed).toEqual({ ...relayed(), awaitingHandback: true });
    expect(parsed).not.toHaveProperty("lastTransitionAt");
  });

  it("drops a transition that is not a time and keeps the notices around it", () => {
    const parsed = RelayNoticesPayloadSchema.parse({
      notices: [
        relayed({ lastTransitionAt: "10:00" }),
        relayed({ noticeId: "n-2", lastTransitionAt: Number.NaN }),
        relayed({ noticeId: "n-3", lastTransitionAt: AT }),
      ],
    });
    expect(parsed.notices.map((n) => [n.noticeId, n.lastTransitionAt])).toEqual([
      ["n-1", undefined],
      ["n-2", undefined],
      ["n-3", AT],
    ]);
  });
});
