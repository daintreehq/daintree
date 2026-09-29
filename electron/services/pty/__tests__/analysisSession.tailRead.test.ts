import { afterEach, describe, expect, it } from "vitest";
import { AnalysisSession } from "../analysis/AnalysisSession.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../../shared/utils/artifactParser.js";

const sessions: AnalysisSession[] = [];

function makeSession(cols = 40): AnalysisSession {
  const session = new AnalysisSession(
    {
      terminalId: "tail",
      cols,
      rows: 10,
      scrollback: 5000,
      restore: false,
      spawnedAt: 1,
      epoch: 1,
    },
    () => {}
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

describe("AnalysisSession tail reads", () => {
  it("caps the payload and marks it partial when scrollback is left out", async () => {
    const session = makeSession();
    let text = "";
    for (let i = 0; i < 500; i++) text += `\x1b[3${i % 7}mline ${i}\x1b[0m\r\n`;
    feed(session, text);
    const full = await session.serialize();
    const tail = await session.serialize({ tailRows: 20 });
    expect(full?.partial).toBeUndefined();
    expect(tail?.partial).toBe(true);
    expect(tail!.data.length).toBeLessThan(full!.data.length / 5);
    expect(tailCapturedOutput(tail!.data, 20, true)).toEqual(
      tailCapturedOutput(full!.data, 20, true)
    );
  });

  it("is not partial when the buffer already fits", async () => {
    const session = makeSession();
    feed(session, "a\r\nb\r\nc\r\n");
    const tail = await session.serialize({ tailRows: 20 });
    expect(tail?.partial).toBeUndefined();
  });

  it("matches the full read for wrapped lines", async () => {
    const session = makeSession(20);
    let text = "";
    for (let i = 0; i < 300; i++) text += `${i} ${"w".repeat(22)}\r\n`;
    feed(session, text);
    const full = await session.serialize();
    const calls: Array<number | undefined> = [];
    const tail = await readTailSnapshot((options) => {
      calls.push(options?.tailRows);
      return session.serialize(options);
    }, 30);
    expect(calls).toEqual([60]);
    expect(tail?.partial).toBe(true);
    expect(tailCapturedOutput(tail!.data, 30, true)).toEqual(
      tailCapturedOutput(full!.data, 30, true)
    );
  });

  it("falls back to a full read when the capped tail is mostly blank", async () => {
    const session = makeSession();
    let text = "";
    for (let i = 0; i < 400; i++) text += `real ${i}\r\n`;
    text += "\r\n".repeat(200);
    feed(session, text);
    const full = await session.serialize();
    const calls: Array<number | undefined> = [];
    const tail = await readTailSnapshot((options) => {
      calls.push(options?.tailRows);
      return session.serialize(options);
    }, 30);
    expect(calls).toEqual([60, undefined]);
    expect(tailCapturedOutput(tail!.data, 30, true)).toEqual(
      tailCapturedOutput(full!.data, 30, true)
    );
  });

  it("keeps the capped read when it holds enough lines", async () => {
    const session = makeSession();
    let text = "";
    for (let i = 0; i < 400; i++) text += `real ${i}\r\n`;
    feed(session, text);
    const calls: Array<number | undefined> = [];
    const full = await session.serialize();
    const tail = await readTailSnapshot((options) => {
      calls.push(options?.tailRows);
      return session.serialize(options);
    }, 30);
    expect(calls).toEqual([60]);
    expect(tailCapturedOutput(tail!.data, 30, true)).toEqual(
      tailCapturedOutput(full!.data, 30, true)
    );
  });

  it("reads the newest rows while the alternate screen is active", async () => {
    const session = makeSession();
    let text = "";
    for (let i = 0; i < 300; i++) text += `main ${i}\r\n`;
    text += "\x1b[?1049hALT-SCREEN-TOP\r\nALT-SCREEN-NEXT";
    feed(session, text);
    const full = await session.serialize();
    const tail = await readTailSnapshot((options) => session.serialize(options), 10);
    expect(tailCapturedOutput(tail!.data, 10, true)).toEqual(
      tailCapturedOutput(full!.data, 10, true)
    );
    expect(tail!.data).toContain("ALT-SCREEN-NEXT");
  });

  it("returns null when there is nothing to read", async () => {
    const read = async () => null;
    expect(await readTailSnapshot(read, 10)).toBeNull();
  });
});
