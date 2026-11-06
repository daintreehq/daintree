import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisSession } from "../analysis/AnalysisSession.js";
import type { WorkerToHostMessage } from "../analysisWorkerProtocol.js";

/**
 * #16210 in the worker's session: a capture starts behind every byte fed
 * before its message and ahead of every byte after it, even when a resize
 * drains the mirror synchronously in between.
 */

const sessions: AnalysisSession[] = [];

type CaptureEvent = Extract<WorkerToHostMessage, { type: "submission-capture" }>;

function makeSession(events: CaptureEvent[]): AnalysisSession {
  const session = new AnalysisSession(
    {
      terminalId: "t1",
      cols: 40,
      rows: 6,
      scrollback: 1000,
      restore: false,
      spawnedAt: 1,
      epoch: 1,
    },
    (msg) => {
      if (msg.type === "submission-capture") events.push(msg);
    }
  );
  sessions.push(session);
  return session;
}

function feed(session: AnalysisSession, data: string): void {
  session.feedChunk(data, { agentLive: false });
}

afterEach(() => {
  while (sessions.length) sessions.pop()?.free();
});

describe("AnalysisSession submission capture", () => {
  it("starts behind the output fed before it, even across a resize drain", async () => {
    const events: CaptureEvent[] = [];
    const session = makeSession(events);
    feed(session, "before 1\r\nbefore 2\r\n$ ");
    session.startSubmissionCapture(1, "ask");
    feed(session, "ask\r\n");
    session.resize(41, 6);
    for (let index = 1; index <= 10; index += 1) feed(session, `answer ${index}\r\n`);
    session.closeSubmissionCapture();

    await vi.waitFor(() =>
      expect(events.some((event) => event.output.state !== "capturing")).toBe(true)
    );
    const final = events.find((event) => event.output.state !== "capturing")!;
    expect(final.captureId).toBe(1);
    const lines = final.output.text.split("\n");
    expect(lines[0]).toBe("$ ask");
    expect(lines).toContain("answer 10");
    expect(final.output.text).not.toContain("before");
  });

  it("closes behind the output fed before the close and ahead of what follows", async () => {
    const events: CaptureEvent[] = [];
    const session = makeSession(events);
    feed(session, "$ ");
    session.startSubmissionCapture(1, "first");
    feed(session, "first\r\nfirst answer\r\n$ ");
    session.closeSubmissionCapture();
    feed(session, "second\r\nsecond answer\r\n");

    await vi.waitFor(() =>
      expect(events.some((event) => event.output.state === "closed")).toBe(true)
    );
    const final = events.find((event) => event.output.state === "closed")!;
    expect(final.output.text).toContain("first answer");
    expect(final.output.text).not.toContain("second");
  });
});
