import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisSession } from "../analysis/AnalysisSession.js";
import type { WorkerToHostMessage } from "../analysisWorkerProtocol.js";

const sessions: AnalysisSession[] = [];

function makeSession(messages: WorkerToHostMessage[]): AnalysisSession {
  const session = new AnalysisSession(
    {
      terminalId: "modes",
      cols: 40,
      rows: 10,
      scrollback: 100,
      restore: false,
      spawnedAt: 1,
      epoch: 1,
    },
    (message) => messages.push(message)
  );
  sessions.push(session);
  return session;
}

function lastViewport(messages: WorkerToHostMessage[]) {
  const viewports = messages.filter((message) => message.type === "viewport");
  return viewports[viewports.length - 1];
}

afterEach(() => {
  while (sessions.length) sessions.pop()?.free();
});

describe("AnalysisSession input modes (#15629)", () => {
  it("carries the parsed bracketed-paste mode on the viewport digest", async () => {
    const messages: WorkerToHostMessage[] = [];
    const session = makeSession(messages);

    session.feedChunk("\x1b[?2004h❯ ", { agentLive: true });
    await vi.waitFor(() => expect(lastViewport(messages)).toBeDefined());
    expect(lastViewport(messages)).toMatchObject({ bracketedPasteMode: true });

    messages.length = 0;
    session.feedChunk("\x1b[?2004l$ ", { agentLive: false });
    await vi.waitFor(() => expect(lastViewport(messages)).toBeDefined());
    expect(lastViewport(messages)).toMatchObject({ bracketedPasteMode: false });
  });

  it("reports each flip at once instead of folding them into one throttled digest", async () => {
    const messages: WorkerToHostMessage[] = [];
    const session = makeSession(messages);

    session.feedChunk("\x1b[?2004h", { agentLive: true });
    session.feedChunk("\x1b[?2004l", { agentLive: false });
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === "viewport" && !message.bracketedPasteMode)
      ).toHaveLength(1)
    );

    const modes = messages.flatMap((message) =>
      message.type === "viewport" ? [message.bracketedPasteMode] : []
    );
    expect(modes).toEqual([true, false]);
  });
});
