import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionQuestionImagePartResult,
  DecisionQuestionList,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let decisionsClient: typeof import("../decisionsClient").decisionsClient;
let push: (state: PaneDecisionState) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let getPaneState: ReturnType<typeof vi.fn>;
let resolveRead: (state: PaneDecisionState | null) => void;
let rejectRead: (err: Error) => void;
const order: string[] = [];

function emptyState(revision: number, terminalId = "pane-a"): PaneDecisionState {
  return { terminalId, openQuestions: [], waitingAnswers: [], needsAttention: [], revision };
}

function state(revision: number, terminalId = "pane-a"): PaneDecisionState {
  return {
    terminalId,
    openQuestions: [
      {
        questionId: `qid-${revision}`,
        alias: revision,
        status: "open",
        askedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ],
    waitingAnswers: [],
    needsAttention: [],
    revision,
  };
}

describe("decisionsClient.watchPaneState", () => {
  beforeEach(async () => {
    vi.resetModules();
    order.length = 0;
    unsubscribe = vi.fn();
    getPaneState = vi.fn(() => {
      order.push("read");
      return new Promise<PaneDecisionState | null>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
    });
    typedGlobal.window = {
      electron: {
        decisions: { getPaneState },
        terminal: {
          onDecisionState: vi.fn((callback: (state: PaneDecisionState) => void) => {
            order.push("subscribe");
            push = callback;
            return unsubscribe;
          }),
        },
      },
    };
    ({ decisionsClient } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("subscribes before it reads, and shows what the read finds", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    resolveRead(state(3));
    await Promise.resolve();

    expect(order).toEqual(["subscribe", "read"]);
    expect(getPaneState).toHaveBeenCalledWith("pane-a");
    expect(seen.map((s) => s.revision)).toEqual([3]);
  });

  it.each([
    ["older", 4, [5]],
    ["the same", 5, [5]],
    ["newer", 6, [5, 6]],
  ])("after a push, takes a read with %s revision only if it is newer", async (_l, read, want) => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(5));
    resolveRead(state(read));
    await Promise.resolve();

    expect(seen.map((s) => s.revision)).toEqual(want);
  });

  it("calls nothing for a repeated push", () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(5));
    push(state(5));

    expect(seen.map((s) => s.revision)).toEqual([5]);
  });

  it("shows the empty state Decisions sends when turned off, then what follows when it is back on", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(1));
    push(emptyState(2));
    resolveRead(state(1));
    await Promise.resolve();
    push(state(3));

    expect(seen).toEqual([state(1), emptyState(2), state(3)]);
  });

  it("keeps a push when the read finds nothing", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(2));
    resolveRead(null);
    await Promise.resolve();

    expect(seen.map((s) => s.revision)).toEqual([2]);
  });

  it("keeps watching when the read fails", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(2));
    rejectRead(new Error("host gone"));
    await Promise.resolve();
    await Promise.resolve();
    push(state(3));

    expect(seen.map((s) => s.revision)).toEqual([2, 3]);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("ignores other panes' pushes, and their revisions", () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(9, "pane-b"));
    push(state(1));

    expect(seen.map((s) => [s.terminalId, s.revision])).toEqual([["pane-a", 1]]);
  });

  it("stops listening, and ignores a read still in flight, once stopped", async () => {
    const seen: PaneDecisionState[] = [];
    const stop = decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    stop();
    resolveRead(state(1));
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });
});

describe("decisionsClient.getQuestionImage", () => {
  type Payload = { terminalId: string; questionId: string; attachmentId: string; offset: number };
  let getQuestionImage: ReturnType<
    typeof vi.fn<(payload: Payload) => Promise<DecisionQuestionImagePartResult>>
  >;
  let DecisionImagePartsError: typeof import("../decisionsClient").DecisionImagePartsError;

  const SHA = "d".repeat(64);
  const IMAGE = Uint8Array.from({ length: 10 }, (_, i) => i + 1);

  /** Main's reads of `image`, `partBytes` at a time, as `questionImage` answers them. */
  function servedInParts(image: Uint8Array, partBytes: number) {
    return async ({ attachmentId, offset }: Payload): Promise<DecisionQuestionImagePartResult> => ({
      result: "read",
      part: {
        attachmentId,
        mime: "image/png",
        sha256: SHA,
        size: image.length,
        offset,
        bytes: image.slice(offset, offset + partBytes),
      },
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    getQuestionImage = vi.fn<(payload: Payload) => Promise<DecisionQuestionImagePartResult>>();
    typedGlobal.window = { electron: { decisions: { getQuestionImage } } };
    ({ decisionsClient, DecisionImagePartsError } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("takes an image that comes whole in one read", async () => {
    getQuestionImage.mockImplementation(servedInParts(IMAGE, 64));

    await expect(decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001")).resolves.toEqual(
      {
        result: "read",
        image: { attachmentId: "attach_0001", mime: "image/png", sha256: SHA, bytes: IMAGE },
      }
    );
    expect(getQuestionImage).toHaveBeenCalledExactlyOnceWith({
      terminalId: "pane-a",
      questionId: "q-1",
      attachmentId: "attach_0001",
      offset: 0,
    });
  });

  it("puts a larger image together from its parts, asking for each where the last ended", async () => {
    getQuestionImage.mockImplementation(servedInParts(IMAGE, 4));

    const read = await decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001");

    expect(read).toEqual({
      result: "read",
      image: { attachmentId: "attach_0001", mime: "image/png", sha256: SHA, bytes: IMAGE },
    });
    expect(getQuestionImage.mock.calls.map(([payload]) => payload.offset)).toEqual([0, 4, 8]);
  });

  it("hands back what main said when a part can't be read", async () => {
    const serve = servedInParts(IMAGE, 4);
    getQuestionImage
      .mockImplementationOnce(serve)
      .mockResolvedValueOnce({ result: "unavailable", reason: "digest-mismatch" });

    await expect(decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001")).resolves.toEqual(
      { result: "unavailable", reason: "digest-mismatch" }
    );
  });

  it.each([
    ["is empty before the image ends", { bytes: new Uint8Array() }],
    ["starts somewhere else", { offset: 3 }],
    ["claims another image's digest", { sha256: "e".repeat(64) }],
    ["claims another size", { size: 11 }],
    ["names another attachment", { attachmentId: "attach_0002" }],
  ])("refuses an image whose later part %s", async (_label, change) => {
    const serve = servedInParts(IMAGE, 4);
    getQuestionImage.mockImplementationOnce(serve).mockImplementationOnce(async (payload) => {
      const read = await serve(payload);
      return read.result === "read" ? { ...read, part: { ...read.part, ...change } } : read;
    });

    await expect(
      decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001")
    ).rejects.toBeInstanceOf(DecisionImagePartsError);
  });

  it("refuses a part claiming an image larger than the protocol allows, allocating nothing", async () => {
    getQuestionImage.mockResolvedValueOnce({
      result: "read",
      part: {
        attachmentId: "attach_0001",
        mime: "image/png",
        sha256: SHA,
        size: 20 * 1024 * 1024 + 1,
        offset: 0,
        bytes: IMAGE,
      },
    });

    await expect(
      decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001")
    ).rejects.toBeInstanceOf(DecisionImagePartsError);
  });

  it.each([
    ["bytes that aren't bytes", { bytes: { length: 1 } as unknown as Uint8Array<ArrayBuffer> }],
    ["a size that isn't a whole number", { size: 4.5 }],
    ["a size that isn't a number", { size: Number.NaN }],
  ])("refuses a part with %s at once, allocating nothing", async (_label, change) => {
    const serve = servedInParts(IMAGE, 4);
    getQuestionImage.mockImplementation(async (payload) => {
      const read = await serve(payload);
      return read.result === "read" ? { ...read, part: { ...read.part, ...change } } : read;
    });

    await expect(
      decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001")
    ).rejects.toBeInstanceOf(DecisionImagePartsError);
    expect(getQuestionImage).toHaveBeenCalledOnce();
  });

  it("asks for no more parts once its signal aborts", async () => {
    const controller = new AbortController();
    const serve = servedInParts(IMAGE, 4);
    getQuestionImage.mockImplementation(async (payload) => {
      controller.abort(new Error("closed"));
      return serve(payload);
    });

    await expect(
      decisionsClient.getQuestionImage("pane-a", "q-1", "attach_0001", controller.signal)
    ).rejects.toThrow("closed");
    expect(getQuestionImage).toHaveBeenCalledOnce();
  });
});

describe("decisionsClient.watchStatus read failure (#17231)", () => {
  let rejectStatus: (err: Error) => void;
  let pushStatus: (status: DecisionsStatus) => void;

  beforeEach(async () => {
    vi.resetModules();
    typedGlobal.window = {
      electron: {
        decisions: {
          getStatus: vi.fn(
            () => new Promise<DecisionsStatus>((_resolve, reject) => (rejectStatus = reject))
          ),
        },
        events: {
          on: vi.fn((name: string, callback: (status: DecisionsStatus) => void) => {
            if (name === "decisions:status-changed") pushStatus = callback;
            return () => {};
          }),
        },
      },
    };
    ({ decisionsClient } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("says a failed read only while no status has arrived, and never once stopped", async () => {
    const failed = vi.fn();
    decisionsClient.watchStatus(() => {}, failed);
    rejectStatus(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();

    const late = vi.fn();
    decisionsClient.watchStatus(() => {}, late);
    pushStatus({ state: "connected", revision: 1 });
    rejectStatus(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();

    const stoppedFirst = vi.fn();
    const stop = decisionsClient.watchStatus(() => {}, stoppedFirst);
    stop();
    rejectStatus(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stoppedFirst).not.toHaveBeenCalled();
  });
});

describe("decisionsClient.watchQuestions (#17229)", () => {
  let pushList: (list: DecisionQuestionList) => void;
  let listQuestions: ReturnType<typeof vi.fn>;
  let off: ReturnType<typeof vi.fn>;
  let resolveList: (list: DecisionQuestionList) => void;
  let rejectList: (err: Error) => void;
  const steps: string[] = [];

  const list = (revision: number): DecisionQuestionList => ({ revision, questions: [] });

  beforeEach(async () => {
    vi.resetModules();
    steps.length = 0;
    off = vi.fn();
    listQuestions = vi.fn(() => {
      steps.push("read");
      return new Promise<DecisionQuestionList>((resolve, reject) => {
        resolveList = resolve;
        rejectList = reject;
      });
    });
    typedGlobal.window = {
      electron: {
        decisions: { listQuestions },
        events: {
          on: vi.fn((name: string, callback: (list: DecisionQuestionList) => void) => {
            if (name === "decisions:questions-changed") {
              steps.push("subscribe");
              pushList = callback;
            }
            return off;
          }),
        },
      },
    };
    ({ decisionsClient } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("subscribes before it reads, and never lets a late read roll a push back", async () => {
    const seen: number[] = [];
    decisionsClient.watchQuestions((l) => seen.push(l.revision));
    expect(steps).toEqual(["subscribe", "read"]);

    pushList(list(5));
    pushList(list(5));
    resolveList(list(4));
    await Promise.resolve();
    pushList(list(6));

    expect(seen).toEqual([5, 6]);
  });

  it("shows the read when nothing was pushed, and keeps watching when it fails", async () => {
    const seen: number[] = [];
    decisionsClient.watchQuestions((l) => seen.push(l.revision));
    resolveList(list(0));
    await Promise.resolve();
    expect(seen).toEqual([0]);

    decisionsClient.watchQuestions((l) => seen.push(l.revision * 10));
    rejectList(new Error("gone"));
    await Promise.resolve();
    pushList(list(2));
    expect(seen).toEqual([0, 20]);
  });

  it("says a failed read only while no list has arrived (#17231)", async () => {
    const failed = vi.fn();
    decisionsClient.watchQuestions(() => {}, failed);
    rejectList(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();

    const late = vi.fn();
    decisionsClient.watchQuestions(() => {}, late);
    pushList(list(1));
    rejectList(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();

    const stoppedFirst = vi.fn();
    const stop = decisionsClient.watchQuestions(() => {}, stoppedFirst);
    stop();
    rejectList(new Error("gone"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stoppedFirst).not.toHaveBeenCalled();
  });

  it("stops listening, and ignores a read still in flight, once stopped", async () => {
    const seen: number[] = [];
    const stop = decisionsClient.watchQuestions((l) => seen.push(l.revision));
    stop();
    resolveList(list(3));
    await Promise.resolve();
    expect(off).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });
});

describe("decisionsClient reads by reference (#17229)", () => {
  type Payload = {
    reference: DecisionQuestionReference;
    attachmentId: string;
    offset: number;
  };
  const REFERENCE: DecisionQuestionReference = {
    hostId: "host_1",
    projectId: "project-b",
    terminalId: "pane-closed",
    questionId: "q-1",
  };
  const IMAGE = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
  let getQuestionImageByReference: ReturnType<
    typeof vi.fn<(payload: Payload) => Promise<DecisionQuestionImagePartResult>>
  >;

  beforeEach(async () => {
    vi.resetModules();
    getQuestionImageByReference = vi.fn(async ({ attachmentId, offset }: Payload) => ({
      result: "read" as const,
      part: {
        attachmentId,
        mime: "image/png" as const,
        sha256: "d".repeat(64),
        size: IMAGE.length,
        offset,
        bytes: IMAGE.slice(offset, offset + 4),
      },
    }));
    typedGlobal.window = { electron: { decisions: { getQuestionImageByReference } } };
    ({ decisionsClient } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("puts an image together from parts read by the question's reference", async () => {
    await expect(
      decisionsClient.getQuestionImageByReference(REFERENCE, "attach_0001")
    ).resolves.toEqual({
      result: "read",
      image: {
        attachmentId: "attach_0001",
        mime: "image/png",
        sha256: "d".repeat(64),
        bytes: IMAGE,
      },
    });
    expect(getQuestionImageByReference.mock.calls.map(([payload]) => payload)).toEqual([
      { reference: REFERENCE, attachmentId: "attach_0001", offset: 0 },
      { reference: REFERENCE, attachmentId: "attach_0001", offset: 4 },
      { reference: REFERENCE, attachmentId: "attach_0001", offset: 8 },
    ]);
  });
});
