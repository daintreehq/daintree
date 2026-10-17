import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../../exchange/AssistantExchangeJournal.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import { parseReceiverLane, toExchangeView, toExchangeViews } from "../exchangeOverview.js";

const NOW = 50_000;

function record(overrides: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    taskId: "t-1",
    senderId: "sender",
    messageId: "m-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    receiver: { hostId: "local", laneId: "proj-1\u00002", enrollmentGeneration: "g" },
    state: "submitted",
    outcome: null,
    bodyDigest: "d",
    bodyBytes: 4,
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
    createdAt: 1_000,
    updatedAt: 2_000,
    expiresAt: NOW + 10_000,
    terminalAt: null,
    tombstonedAt: null,
    revision: 1,
    ...overrides,
  };
}

function delivered(facts: Partial<ExchangeRecord["delivery"]>, overrides = {}): ExchangeRecord {
  const base = record(overrides);
  return { ...base, delivery: { ...base.delivery, ...facts } };
}

function entry(rec: ExchangeRecord | null, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    hostId: "studio-01",
    messageId: "m-1",
    sentAt: 1_000,
    unresolvedAt: null,
    lapsedAt: null,
    record: rec,
    updatedAt: 1_500,
    ...overrides,
  };
}

describe("toExchangeView delivery", () => {
  it("reads a send the host never answered as unconfirmed, with nothing to cancel", () => {
    const view = toExchangeView(entry(null, { unresolvedAt: 1_200 }), NOW);
    expect(view).toMatchObject({
      state: null,
      delivery: "unconfirmed",
      deliveryAt: 1_200,
      receiver: null,
      contextId: null,
      cancel: null,
    });
    expect(toExchangeView(entry(null, { lapsedAt: 9_000 }), NOW).delivery).toBe("unconfirmed");
  });

  it("reads an exchange the host expired as unconfirmed, not as a failure of delivery", () => {
    const view = toExchangeView(
      entry(record({ state: "failed", outcome: "expired", terminalAt: 7_000 })),
      NOW
    );
    expect(view).toMatchObject({ state: "failed", outcome: "expired", delivery: "unconfirmed" });
    expect(view.deliveryAt).toBe(7_000);
  });

  it("reads a live exchange past its expiry, before the host swept it, as unconfirmed", () => {
    const view = toExchangeView(entry(delivered({ acceptedAt: 1_100 }, { expiresAt: NOW })), NOW);
    expect(view.delivery).toBe("unconfirmed");
    expect(view.cancel).toBeNull();
  });

  it("reads an ambiguous delivery as unconfirmed until the lane is seen reading it", () => {
    const ambiguous = delivered({ attemptedAt: 1_050, acceptedAt: 1_100, ambiguousAt: 1_300 });
    expect(toExchangeView(entry(ambiguous), NOW)).toMatchObject({
      delivery: "unconfirmed",
      deliveryAt: 1_300,
      cancel: "request",
    });
    const read = delivered({ acceptedAt: 1_100, ambiguousAt: 1_300, inboxFetchedAt: 1_400 });
    expect(toExchangeView(entry(read), NOW)).toMatchObject({
      delivery: "inbox-fetched",
      deliveryAt: 1_400,
    });
  });

  it("keeps a reply that arrived before expiry", () => {
    const view = toExchangeView(
      entry(
        delivered(
          { acceptedAt: 1_100, replyReceivedAt: 1_900 },
          { state: "completed", terminalAt: 1_900, tombstonedAt: 9_000 }
        )
      ),
      NOW
    );
    expect(view).toMatchObject({ state: "completed", delivery: "reply-received", cancel: null });
  });

  it("reads an attempt with nothing after it as unconfirmed, since it may have landed", () => {
    expect(
      toExchangeView(entry(delivered({ acceptedAt: 1_100, attemptedAt: 1_150 })), NOW)
    ).toMatchObject({ delivery: "unconfirmed", deliveryAt: 1_150 });
  });

  it("lets expiry outweigh a fetch that no reply followed", () => {
    const view = toExchangeView(
      entry(
        delivered(
          { acceptedAt: 1_100, inboxFetchedAt: 1_400 },
          { state: "failed", outcome: "expired", terminalAt: 7_000 }
        )
      ),
      NOW
    );
    expect(view).toMatchObject({ delivery: "unconfirmed", deliveryAt: 7_000, expiresAt: null });
  });

  it("names the furthest fact short of reading, or accepted when the host only holds the record", () => {
    const held = record();
    expect(toExchangeView(entry(held), NOW)).toMatchObject({
      delivery: "accepted",
      deliveryAt: held.createdAt,
      expiresAt: NOW + 10_000,
    });
    expect(toExchangeView(entry(delivered({ acceptedAt: 1_100 })), NOW).delivery).toBe("accepted");
    expect(
      toExchangeView(entry(delivered({ acceptedAt: 1_100, wakeTypedAt: 1_200 })), NOW)
    ).toMatchObject({ delivery: "wake-typed", deliveryAt: 1_200 });
  });
});

describe("toExchangeView cancel", () => {
  it("cancels outright only while nothing has left for the lane", () => {
    expect(toExchangeView(entry(record()), NOW).cancel).toBe("cancel");
    // An attempt alone may have delivered it: the host only records a request.
    expect(toExchangeView(entry(delivered({ attemptedAt: 1_050 })), NOW).cancel).toBe("request");
    expect(toExchangeView(entry(delivered({ inboxFetchedAt: 1_400 })), NOW).cancel).toBe("request");
  });

  it("offers nothing more once a request is recorded, or once the exchange ended", () => {
    expect(
      toExchangeView(entry(delivered({ acceptedAt: 1_100 }, { cancelRequestedAt: 3_000 })), NOW)
        .cancel
    ).toBe("requested");
    expect(
      toExchangeView(entry(record({ state: "canceled", cancelRequestedAt: 3_000 })), NOW).cancel
    ).toBeNull();
    expect(toExchangeView(entry(record({ state: "rejected" })), NOW).cancel).toBeNull();
    expect(toExchangeView(entry(record({ tombstonedAt: 9_000 })), NOW).cancel).toBeNull();
  });
});

describe("toExchangeView provenance", () => {
  it("files the exchange under the journal's host, not the receiver's own name for itself", () => {
    const view = toExchangeView(entry(record()), NOW);
    expect(view.hostId).toBe("studio-01");
    expect(view).toMatchObject({
      sendingLane: "hub",
      hopCount: 1,
      contextId: "ctx-1",
      receiver: { projectId: "proj-1", slot: 2 },
    });
  });

  it("carries no digest, size or sender id", () => {
    const view = toExchangeView(entry(record()), NOW) as unknown as Record<string, unknown>;
    for (const key of ["bodyDigest", "bodyBytes", "replyDigest", "senderId", "taskId"]) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it("parses lane ids, keeping an unfamiliar one whole", () => {
    expect(parseReceiverLane("/home/g/api\u00000")).toEqual({ projectId: "/home/g/api", slot: 0 });
    expect(parseReceiverLane("a\u0000b\u00001")).toEqual({ projectId: "a\u0000b", slot: 1 });
    expect(parseReceiverLane("plain")).toEqual({ projectId: "plain", slot: null });
    expect(parseReceiverLane("p\u0000x")).toEqual({ projectId: "p\u0000x", slot: null });
    expect(parseReceiverLane("p\u0000999")).toEqual({ projectId: "p\u0000999", slot: null });
  });

  it("lists newest send first", () => {
    const views = toExchangeViews(
      [
        entry(null, { messageId: "a", sentAt: 1 }),
        entry(null, { messageId: "c", sentAt: 3 }),
        entry(null, { messageId: "b", sentAt: 3 }),
      ],
      NOW
    );
    expect(views.map((view) => view.messageId)).toEqual(["b", "c", "a"]);
  });
});
