import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExchangeReceiver, ExchangeRecord } from "../../exchange/types.js";
import { AssistantInbox, cleanProvenanceLabel } from "../AssistantInbox.js";

const RECEIVER: ExchangeReceiver = { hostId: "local", laneId: "lane-a", enrollmentGeneration: 7 };
const PROVENANCE = { sendingHost: "studio", sendingLane: "hub", hopCount: 1 };

let taskCounter = 0;
function record(body: string, overrides: Partial<ExchangeRecord> = {}): ExchangeRecord {
  const n = ++taskCounter;
  return {
    taskId: `task-${n}`,
    senderId: "shell-a",
    messageId: `msg-${n}`,
    contextId: "ctx",
    referenceTaskIds: [],
    receiver: { ...RECEIVER },
    state: "submitted",
    outcome: null,
    bodyDigest: createHash("sha256").update(body, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(body),
    replyDigest: null,
    replyBytes: null,
    delivery: {
      attemptedAt: null,
      acceptedAt: null,
      wakeTypedAt: null,
      inboxFetchedAt: null,
      replyReceivedAt: null,
      ambiguousAt: null,
    },
    cancelRequestedAt: null,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 10_000,
    terminalAt: null,
    tombstonedAt: null,
    revision: n,
    ...overrides,
  };
}

describe("AssistantInbox", () => {
  it("holds only the body its exchange measured", () => {
    const inbox = new AssistantInbox({ now: () => 0 });
    expect(() => inbox.admit(record("real"), { body: "forged", provenance: PROVENANCE })).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
  });

  it("admits the same envelope twice as one, and refuses a different one for that exchange", () => {
    const inbox = new AssistantInbox({ now: () => 0 });
    const rec = record("hello");
    const first = inbox.admit(rec, { body: "hello", provenance: PROVENANCE });
    expect(inbox.admit(rec, { body: "hello", provenance: PROVENANCE }).seq).toBe(first.seq);
    expect(() =>
      inbox.admit(rec, { body: "hello", provenance: { ...PROVENANCE, hopCount: 2 } })
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(inbox.list(RECEIVER, 0)).toHaveLength(1);
  });

  it("refuses a hop count outside its bounds", () => {
    const inbox = new AssistantInbox({ now: () => 0 });
    for (const hopCount of [0, 9, 1.5]) {
      expect(() =>
        inbox.admit(record("x"), { body: "x", provenance: { ...PROVENANCE, hopCount } })
      ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    }
  });

  it("refuses rather than evicts once a lane's inbox is full", () => {
    const inbox = new AssistantInbox({ now: () => 0, maxEntriesPerReceiver: 2 });
    inbox.admit(record("a"), { body: "a", provenance: PROVENANCE });
    inbox.admit(record("b"), { body: "b", provenance: PROVENANCE });
    expect(() => inbox.admit(record("c"), { body: "c", provenance: PROVENANCE })).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" })
    );
    expect(inbox.list(RECEIVER, 0).map((e) => e.body)).toEqual(["a", "b"]);
    // Another lane still has room.
    const other = record("d", { receiver: { ...RECEIVER, laneId: "lane-b" } });
    expect(() => inbox.admit(other, { body: "d", provenance: PROVENANCE })).not.toThrow();
  });

  it("forgets bodies and answers once their exchange expires", () => {
    let clock = 0;
    const inbox = new AssistantInbox({ now: () => clock });
    const entry = inbox.admit(record("a"), { body: "a", provenance: PROVENANCE });
    inbox.respond(entry, "completed", "done");
    expect(inbox.getResponses(entry.key)).toHaveLength(1);
    clock = 10_000;
    expect(inbox.list(RECEIVER, 0)).toEqual([]);
    expect(inbox.getResponses(entry.key)).toEqual([]);
  });

  it("finds an entry only for its own receiver", () => {
    const inbox = new AssistantInbox({ now: () => 0 });
    const entry = inbox.admit(record("a"), { body: "a", provenance: PROVENANCE });
    expect(inbox.find(RECEIVER, entry.taskId)?.body).toBe("a");
    expect(inbox.find({ ...RECEIVER, enrollmentGeneration: 8 }, entry.taskId)).toBeNull();
  });

  it("caps the answers one exchange holds", () => {
    const inbox = new AssistantInbox({ now: () => 0, maxResponsesPerTask: 1 });
    const entry = inbox.admit(record("a"), { body: "a", provenance: PROVENANCE });
    expect(inbox.canRespond(entry.taskId)).toBe(true);
    inbox.respond(entry, "input-required", "?");
    expect(inbox.canRespond(entry.taskId)).toBe(false);
  });

  it("strips control and bidi characters from a label another machine chose", () => {
    expect(cleanProvenanceLabel("evil\u001b]0;title\u0007‮host\n")).toBe("evil ]0;title host");
    expect(cleanProvenanceLabel("\u0000\u0001")).toBe("unknown");
    expect(cleanProvenanceLabel("x".repeat(500))).toHaveLength(120);
  });
});
