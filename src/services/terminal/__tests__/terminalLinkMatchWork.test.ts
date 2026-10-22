import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/utils/pluginTerminalLinks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/utils/pluginTerminalLinks")>();
  return {
    ...actual,
    findTerminalLinkMatches: (regex: RegExp, ...rest: [string, number?]) => {
      if (regex.source === "THROWS") throw new Error("runtime failure");
      return actual.findTerminalLinkMatches(regex, ...rest);
    },
  };
});

import { TERMINAL_LINK_MAX_MATCHES_PER_ROW } from "@shared/utils/pluginTerminalLinks";
import {
  SLOW_TERMINAL_LINK_MATCHER_MS,
  createTerminalLinkMatchHandler,
  type TerminalLinkMatchMessage,
} from "../terminalLinkMatchWork";

describe("createTerminalLinkMatchHandler", () => {
  it("announces each pattern before running it, then reports every match by key", () => {
    const posted: TerminalLinkMatchMessage[] = [];
    const handle = createTerminalLinkMatchHandler((message) => posted.push(message));
    handle({
      id: 7,
      text: "INV-42 and pr 9",
      matchers: [
        { key: "a::inv", pattern: "INV-(\\d{1,4})", ignoreCase: false },
        { key: "b::pr", pattern: "PR (\\d{1,4})", ignoreCase: true },
      ],
    });
    expect(posted).toEqual([
      { id: 7, type: "start", key: "a::inv" },
      { id: 7, type: "start", key: "b::pr" },
      {
        id: 7,
        type: "done",
        matches: {
          "a::inv": [{ index: 0, text: "INV-42", groups: ["42"] }],
          "b::pr": [{ index: 11, text: "pr 9", groups: ["9"] }],
        },
        slowKeys: [],
      },
    ]);
  });

  it("never runs a pattern that fails the safety check", () => {
    const posted: TerminalLinkMatchMessage[] = [];
    const handle = createTerminalLinkMatchHandler((message) => posted.push(message));
    handle({
      id: 1,
      text: "aaaab",
      matchers: [{ key: "x", pattern: "(a+)+b", ignoreCase: false }],
    });
    expect(posted).toEqual([{ id: 1, type: "done", matches: {}, slowKeys: [] }]);
  });

  it("switches off only the pattern that threw, and runs the rest", () => {
    const posted: TerminalLinkMatchMessage[] = [];
    const handle = createTerminalLinkMatchHandler((message) => posted.push(message));
    handle({
      id: 3,
      text: "A-1",
      matchers: [
        { key: "bad", pattern: "THROWS", ignoreCase: false },
        { key: "good", pattern: "A-\\d", ignoreCase: false },
      ],
    });
    expect(posted.at(-1)).toEqual({
      id: 3,
      type: "done",
      matches: { good: [{ index: 0, text: "A-1", groups: [] }] },
      slowKeys: ["bad"],
    });
  });

  it("returns every match in the row, leaving the row cap to the overlap settlement", () => {
    const posted: TerminalLinkMatchMessage[] = [];
    const handle = createTerminalLinkMatchHandler((message) => posted.push(message));
    const count = TERMINAL_LINK_MAX_MATCHES_PER_ROW + 8;
    handle({
      id: 4,
      text: "a ".repeat(count),
      matchers: [{ key: "a", pattern: "a", ignoreCase: false }],
    });
    const done = posted.at(-1);
    expect(done?.type === "done" && done.matches.a).toHaveLength(count);
  });

  it("reports a pattern that finished slowly", () => {
    const posted: TerminalLinkMatchMessage[] = [];
    const clock = [0, SLOW_TERMINAL_LINK_MATCHER_MS + 1];
    const handle = createTerminalLinkMatchHandler(
      (message) => posted.push(message),
      () => clock.shift() ?? 0
    );
    handle({
      id: 2,
      text: "S-1",
      matchers: [{ key: "slow", pattern: "S-\\d", ignoreCase: false }],
    });
    expect(posted.at(-1)).toMatchObject({ type: "done", slowKeys: ["slow"] });
  });
});
