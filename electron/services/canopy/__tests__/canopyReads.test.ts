import { describe, expect, it } from "vitest";
import {
  CANOPY_LOOK_LEASE_MS,
  CANOPY_OWN_START_MS,
  CANOPY_READ_DWELL_MS,
  CANOPY_TURN_HOLD_MS,
  isUnread,
  isWatched,
  look,
  lookingSince,
  markRead,
  markUnread,
  newReadTrack,
  observeAsk,
  observeFleet,
  observeTurn,
  readMarkOf,
  restoreRead,
  type ReadTrack,
  type TurnObservation,
} from "../canopyReads.js";

const T0 = 1_000_000;

function seen(extra: Partial<TurnObservation>): TurnObservation {
  return { busy: false, agentState: "waiting", since: null, hash: "h0", now: T0, ...extra };
}

/** A run first seen at work, which the user has nothing to read of yet. */
function working(): ReadTrack {
  const track = newReadTrack();
  observeTurn(track, seen({ busy: true, agentState: "working", hash: "w0" }));
  return track;
}

describe("observeTurn", () => {
  it("counts a run first seen stopped on something as unread, and one at work or idle as read", () => {
    const stopped = newReadTrack();
    expect(observeTurn(stopped, seen({ agentState: "waiting" })).kind).toBe("moved");
    expect(isUnread(stopped)).toBe(true);

    expect(isUnread(working())).toBe(false);

    const idle = newReadTrack();
    observeTurn(idle, seen({ agentState: "idle" }));
    expect(isUnread(idle)).toBe(false);
  });

  it("takes a stop the screen backs up as a turn the user hasn't read", () => {
    const track = working();
    expect(observeTurn(track, seen({ hash: "done" })).kind).toBe("moved");
    expect(isUnread(track)).toBe(true);
  });

  it("takes no turn when the state flips but the screen stayed put", () => {
    const track = working();
    expect(observeTurn(track, seen({ hash: "w0" })).kind).toBe("same");
    expect(isUnread(track)).toBe(false);
  });

  it("takes no turn for a screen that moves while the state holds", () => {
    const track = working();
    expect(observeTurn(track, seen({ busy: true, agentState: "working", hash: "w1" })).kind).toBe(
      "same"
    );
    expect(track.turn).toBe(0);
  });

  it("waits out a change until it has held, so a flicker is no turn", () => {
    const track = working();
    const since = T0 - 1_000;
    expect(observeTurn(track, seen({ hash: "done", since }))).toEqual({
      kind: "wait",
      at: since + CANOPY_TURN_HOLD_MS,
    });
    expect(track.turn).toBe(0);
    // Back at work before it held: nothing happened.
    expect(observeTurn(track, seen({ busy: true, hash: "w2", since: T0 })).kind).toBe("same");
    // A stop that holds counts.
    const later = T0 + CANOPY_TURN_HOLD_MS;
    expect(observeTurn(track, seen({ hash: "done", since: T0, now: later })).kind).toBe("moved");
    expect(isUnread(track)).toBe(true);
  });

  it("takes an unattended start as unread, but a start the user sent as read", () => {
    const unattended = working();
    observeTurn(unattended, seen({ hash: "done" }));
    markRead(unattended);
    observeTurn(unattended, seen({ busy: true, agentState: "working", hash: "again" }));
    expect(isUnread(unattended)).toBe(true);

    const own = working();
    observeTurn(own, seen({ hash: "done" }));
    markRead(own);
    own.userSentAt = T0;
    observeTurn(own, seen({ busy: true, agentState: "working", hash: "again", now: T0 + 1_000 }));
    expect(isUnread(own)).toBe(false);
  });

  it("never lets the user's own start hide a stop they hadn't read", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    track.userSentAt = T0;
    observeTurn(track, seen({ busy: true, agentState: "working", hash: "again" }));
    expect(isUnread(track)).toBe(true);
  });

  it("counts a start long after the user last sent something as theirs no longer", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    markRead(track);
    track.userSentAt = T0;
    const late = T0 + CANOPY_OWN_START_MS + 1;
    observeTurn(track, seen({ busy: true, hash: "again", since: late, now: late + 10_000 }));
    expect(isUnread(track)).toBe(true);
  });

  it("reads a turn taken while someone has been watching the run", () => {
    const track = working();
    look(track, "1:pane", true, T0 - CANOPY_READ_DWELL_MS);
    observeTurn(track, seen({ hash: "done" }));
    expect(isUnread(track)).toBe(false);
  });
});

describe("observeAsk", () => {
  it("takes an ask on the stop's own screen as that stop's, and a new one elsewhere as a turn", () => {
    const track = working();
    observeTurn(track, seen({ hash: "ask" }));
    markRead(track);
    expect(observeAsk(track, "run npm test?", "ask", T0)).toBe(false);
    // Read again, the same screen worded differently by the reader: still that stop's.
    expect(observeAsk(track, "run the tests?", "ask", T0)).toBe(false);
    expect(isUnread(track)).toBe(false);
    expect(observeAsk(track, "run npm build?", "ask2", T0)).toBe(true);
    expect(isUnread(track)).toBe(true);
  });

  it("takes the first question after a stop already read as a turn", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    markRead(track);
    expect(observeAsk(track, "which date format?", "question", T0)).toBe(true);
    expect(isUnread(track)).toBe(true);
  });

  it("takes the first question of a run first seen idle as a turn", () => {
    const track = newReadTrack();
    observeTurn(track, seen({ agentState: "idle", hash: "prompt" }));
    expect(isUnread(track)).toBe(false);
    expect(observeAsk(track, "trust this folder?", "trust", T0)).toBe(true);
    expect(isUnread(track)).toBe(true);
  });

  it("takes the same ask redrawn on another screen as no turn", () => {
    const track = working();
    observeTurn(track, seen({ hash: "ask" }));
    observeAsk(track, "run npm test?", "ask", T0);
    markRead(track);
    expect(observeAsk(track, "run npm test?", "ask-redrawn", T0)).toBe(false);
    expect(isUnread(track)).toBe(false);
  });
});

describe("observeFleet", () => {
  it("counts work that started and ended between two reads of a stopped screen as a stop", () => {
    const track = newReadTrack();
    observeTurn(track, seen({ agentState: "idle", hash: "prompt" }));
    observeFleet(track, true, T0);
    observeFleet(track, false, T0 + CANOPY_TURN_HOLD_MS);
    expect(observeTurn(track, seen({ hash: "done", now: T0 + 10_000 })).kind).toBe("moved");
    expect(isUnread(track)).toBe(true);
  });

  it("takes no turn for a flicker of work between reads", () => {
    const track = newReadTrack();
    observeTurn(track, seen({ agentState: "idle", hash: "prompt" }));
    observeFleet(track, true, T0);
    observeFleet(track, false, T0 + 500);
    expect(observeTurn(track, seen({ hash: "redrawn", now: T0 + 10_000 })).kind).toBe("same");
    expect(isUnread(track)).toBe(false);
  });
});

describe("markRead", () => {
  it("never reads past the turn the user was shown", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    observeTurn(track, seen({ busy: true, hash: "again" }));
    markRead(track, { throughTurn: 1 });
    expect(track.readTurn).toBe(1);
    expect(isUnread(track)).toBe(true);
  });

  it("keeps a run marked unread through a look that began before the mark", () => {
    const track = working();
    markUnread(track, T0);
    expect(markRead(track, { lookedSince: T0 - 1 })).toBe(false);
    expect(isUnread(track)).toBe(true);
    // A look begun after it — the user came back — reads it.
    expect(markRead(track, { lookedSince: T0 + 1 })).toBe(true);
    expect(isUnread(track)).toBe(false);
  });

  it("clears a mark by hand at once when read by hand", () => {
    const track = working();
    markUnread(track, T0);
    markRead(track);
    expect(isUnread(track)).toBe(false);
  });
});

describe("restoreRead", () => {
  it("puts back what the user had, while the run is as the change left it", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    const before = readMarkOf("a", 1, track);
    markRead(track);
    expect(restoreRead(track, before, track.version)).toBe(true);
    expect(isUnread(track)).toBe(true);
  });

  it("refuses once the run did something since, or another view changed it", () => {
    const track = working();
    observeTurn(track, seen({ hash: "done" }));
    const before = readMarkOf("a", 1, track);
    markRead(track);
    const left = track.version;
    // Another view marks it unread within the same turn.
    markUnread(track, T0);
    expect(restoreRead(track, before, left)).toBe(false);
    expect(track.markedUnreadAt).toBe(T0);

    markRead(track);
    observeTurn(track, seen({ busy: true, hash: "again" }));
    expect(restoreRead(track, before, track.version)).toBe(false);
  });
});

describe("look", () => {
  it("reads a look that ends after the dwell, and nothing on one cut short", () => {
    const track = working();
    expect(look(track, "1:pane", true, T0)).toEqual({
      readsAt: T0 + CANOPY_READ_DWELL_MS,
      ended: null,
    });
    expect(look(track, "1:pane", true, T0 + 100)).toEqual({ readsAt: null, ended: null });
    expect(look(track, "1:pane", false, T0 + 200).ended).toBeNull();

    look(track, "1:pane", true, T0 + 1_000);
    expect(look(track, "1:pane", false, T0 + 1_000 + CANOPY_READ_DWELL_MS).ended).toBe(T0 + 1_000);
  });

  it("keeps each view's look apart", () => {
    const track = working();
    look(track, "1:pane", true, T0);
    look(track, "2:pane", true, T0 + 500);
    look(track, "1:pane", false, T0 + 600);
    expect([...track.lookers.keys()]).toEqual(["2:pane"]);
  });
});

describe("looks", () => {
  it("lets a look go that has not been told again within the lease", () => {
    const track = working();
    look(track, "1:pane", true, T0);
    expect(isWatched(track, T0 + CANOPY_READ_DWELL_MS)).toBe(true);
    // Its ending was never heard: past the lease it counts for nothing.
    expect(isWatched(track, T0 + CANOPY_LOOK_LEASE_MS + 1)).toBe(false);
    expect(track.lookers.size).toBe(0);
  });

  it("keeps a look told again each minute", () => {
    const track = working();
    look(track, "1:pane", true, T0);
    look(track, "1:pane", true, T0 + 60_000);
    look(track, "1:pane", true, T0 + 120_000);
    expect(lookingSince(track, T0 + CANOPY_LOOK_LEASE_MS + 1)).toBe(T0);
  });

  it("reads through a look begun after a mark by hand, though an older one still goes on", () => {
    const track = working();
    look(track, "1:panel", true, T0);
    markUnread(track, T0 + 1_000);
    look(track, "1:pane", true, T0 + 2_000);
    expect(lookingSince(track, T0 + 5_000)).toBe(T0 + 2_000);
  });
});
