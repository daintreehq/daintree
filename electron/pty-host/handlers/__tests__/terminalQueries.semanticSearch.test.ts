import { describe, it, expect, vi } from "vitest";
import { createTerminalQueryHandlers } from "../terminalQueries.js";
import type { HostContext } from "../types.js";
import type { SemanticSearchMatch } from "../../../../shared/types/ipc/terminal.js";

function search(buffers: Record<string, string[]>, query: string, isRegex = false) {
  const sendEvent = vi.fn();
  const ctx = {
    sendEvent,
    ptyManager: {
      getAll: () => Object.entries(buffers).map(([id, semanticBuffer]) => ({ id, semanticBuffer })),
    },
  } as unknown as HostContext;
  const handler = createTerminalQueryHandlers(ctx)["search-semantic-buffers"];
  handler?.({ type: "search-semantic-buffers", requestId: "r1", query, isRegex });
  const [[event]] = sendEvent.mock.calls;
  return event as { matches: SemanticSearchMatch[]; error?: string };
}

describe("search-semantic-buffers match ranges", () => {
  it("highlights the matched word after a length-changing prefix (#17515)", () => {
    const { matches } = search({ t1: ["İSTANBUL: done"] }, "done");
    expect(matches).toHaveLength(1);
    const [m] = matches;
    expect(m).toMatchObject({ matchStart: 10, matchEnd: 14 });
    expect(m?.line.slice(m.matchStart, m.matchEnd)).toBe("done");
  });

  it("highlights a query that contains the length-changing character", () => {
    const { matches } = search({ t1: ["İSTANBUL: done"] }, "İstanbul");
    const [m] = matches;
    expect(m).toMatchObject({ matchStart: 0, matchEnd: 8 });
    expect(m?.line.slice(m.matchStart, m.matchEnd)).toBe("İSTANBUL");
  });

  it("measures offsets against the trimmed, ANSI-stripped line it returns", () => {
    const { matches } = search({ t1: ["  \x1b[31mİSTANBUL\x1b[0m: done  "] }, "DONE");
    const [m] = matches;
    expect(m?.line).toBe("İSTANBUL: done");
    expect(m?.line.slice(m.matchStart, m.matchEnd)).toBe("done");
  });

  it("keeps regex matches in original coordinates", () => {
    const { matches } = search({ t1: ["İSTANBUL: done"] }, "d.ne", true);
    const [m] = matches;
    expect(m?.line.slice(m.matchStart, m.matchEnd)).toBe("done");
  });

  it("still returns the newest matching line per terminal", () => {
    const { matches } = search({ t1: ["old done", "İ newest done", "unrelated"] }, "done");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.line).toBe("İ newest done");
  });

  it("returns one range per matching terminal, each in its own line's coordinates", () => {
    const { matches } = search(
      {
        t1: ["old done", "İ newest done"],
        t2: ["plain done now", "İİ second done"],
        t3: ["nothing here"],
      },
      "done"
    );
    expect(matches.map((m) => [m.terminalId, m.line.slice(m.matchStart, m.matchEnd)])).toEqual([
      ["t1", "done"],
      ["t2", "done"],
    ]);
    expect(matches.map((m) => m.line)).toEqual(["İ newest done", "İİ second done"]);
  });
});
