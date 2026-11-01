import { describe, expect, it } from "vitest";
import {
  RESTORE_MATCH_EARLY_SLACK_MS,
  RESTORE_MATCH_LATE_WINDOW_MS,
  hashPromptText,
  matchRestorePanes,
  promptHashesForFirstMessage,
  type RestoreMatchPane,
  type RestoreMatchThread,
} from "../codexRestoreMatch.js";
import {
  generateAgentCommand,
  launchPromptArgText,
} from "../../../../shared/types/agentSettings.js";
import { appendHandbackInstruction } from "../../../../shared/utils/handback.js";

const AT = 1_800_000_000_000;

/** What the renderer sends for a recorded launch prompt. */
function paneHash(text: string): string {
  return hashPromptText(launchPromptArgText(text));
}

function thread(
  sessionId: string,
  firstMessage: string,
  createdAtMs = AT + 2_000
): RestoreMatchThread {
  return { sessionId, createdAtMs, promptHashes: promptHashesForFirstMessage(firstMessage) };
}

function pane(
  key: string,
  text: string,
  overrides: Partial<RestoreMatchPane> = {}
): RestoreMatchPane {
  return { key, promptHash: paneHash(text), at: AT, resolve: true, ...overrides };
}

describe("promptHashesForFirstMessage", () => {
  it("recognizes a launch prompt in the single-line form the CLI received", () => {
    const written = "  Triage #12\n\nRead the logs\r\nthen report  \n";
    // What the CLI got, spelled out rather than derived: trimmed, each line
    // break one space, and the launch command carries exactly this.
    const received = "Triage #12  Read the logs then report";

    expect(
      generateAgentCommand("codex", {}, "codex", { initialPrompt: written }).endsWith(
        `'${received}'`
      )
    ).toBe(true);
    expect(promptHashesForFirstMessage(received)).toContain(paneHash(written));
  });

  it("keeps a lone carriage return, as the launch command does", () => {
    expect(promptHashesForFirstMessage("Line one\rline two")).toContain(
      paneHash("Line one\rline two")
    );
    expect(promptHashesForFirstMessage("Line one line two")).not.toContain(
      paneHash("Line one\rline two")
    );
  });

  it("recognizes the written prompt under the handback instruction appended at launch", () => {
    const written = "Review the parser\nand fix what you find  \n";
    const delivered = launchPromptArgText(appendHandbackInstruction(written, "ab12cd"));

    expect(promptHashesForFirstMessage(delivered)).toContain(paneHash(written));
  });

  it("recognizes the written prompt under a scheduled run's instruction (#15982)", () => {
    const written = "Triage the new issues\n";
    const delivered = launchPromptArgText(appendHandbackInstruction(written, "ab12cd", "run"));

    expect(promptHashesForFirstMessage(delivered)).toContain(paneHash(written));
    // Every marker must carry the one code.
    const mixed = delivered.replace(/NEEDS-YOU-ab12cd/, "NEEDS-YOU-zz99zz");
    expect(promptHashesForFirstMessage(mixed)).not.toContain(paneHash(written));
  });

  it("does not strip an instruction whose two markers disagree", () => {
    const delivered = launchPromptArgText(appendHandbackInstruction("Fix it", "ab12cd")).replace(
      /END-ab12cd$/,
      "END-zz99zz"
    );

    expect(promptHashesForFirstMessage(delivered)).not.toContain(paneHash("Fix it"));
  });

  it("never treats a longer message as its opening words", () => {
    expect(promptHashesForFirstMessage("Fix the bug in the parser")).not.toContain(
      paneHash("Fix the bug")
    );
  });

  it("offers nothing for a thread with no first message", () => {
    expect(promptHashesForFirstMessage("")).toEqual([]);
  });
});

describe("matchRestorePanes", () => {
  it("names the one thread each pane's prompt points at", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [thread("t-a", "Task A"), thread("t-b", "Task B"), thread("t-c", "Task C")],
          panes: [pane("a", "Task A"), pane("b", "Task B")],
        },
      ],
      new Set()
    );

    expect(matches).toEqual([
      { key: "a", sessionId: "t-a" },
      { key: "b", sessionId: "t-b" },
    ]);
  });

  it("accepts a thread created from just before the launch to the end of the window", () => {
    const early = AT - RESTORE_MATCH_EARLY_SLACK_MS;
    const late = AT + RESTORE_MATCH_LATE_WINDOW_MS;
    const matches = matchRestorePanes(
      [
        { threads: [thread("t-a", "Task A", early)], panes: [pane("a", "Task A")] },
        { threads: [thread("t-b", "Task B", late)], panes: [pane("b", "Task B")] },
      ],
      new Set()
    );

    expect(matches.map((match) => match.key)).toEqual(["a", "b"]);
  });

  it("refuses a thread created outside the launch window", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [
            thread("t-a", "Task A", AT - RESTORE_MATCH_EARLY_SLACK_MS - 1_000),
            thread("t-b", "Task B", AT + RESTORE_MATCH_LATE_WINDOW_MS + 1_000),
          ],
          panes: [pane("a", "Task A"), pane("b", "Task B")],
        },
      ],
      new Set()
    );

    expect(matches).toEqual([]);
  });

  it("holds two panes launched with one prompt, even with a thread each", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [thread("t-1", "Same task"), thread("t-2", "Same task", AT + 4_000)],
          panes: [pane("a", "Same task"), pane("b", "Same task", { at: AT + 1_000 })],
        },
      ],
      new Set()
    );

    expect(matches).toEqual([]);
  });

  it("holds a pane whose prompt fits two threads, even when one is held", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [thread("t-held", "Same task"), thread("t-free", "Same task")],
          panes: [pane("a", "Same task")],
        },
      ],
      new Set(["t-held"])
    );

    expect(matches).toEqual([]);
  });

  it("never hands out a thread another pane holds", () => {
    const matches = matchRestorePanes(
      [{ threads: [thread("t-a", "Task A")], panes: [pane("a", "Task A")] }],
      new Set(["t-a"])
    );

    expect(matches).toEqual([]);
  });

  it("counts a pane that isn't asking as a claimant without answering it", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [thread("t-a", "Task A")],
          panes: [pane("a", "Task A"), pane("winner", "Task A", { resolve: false })],
        },
      ],
      new Set()
    );

    expect(matches).toEqual([]);
  });

  it("never answers a pane that isn't asking, even with a unique match", () => {
    const matches = matchRestorePanes(
      [
        {
          threads: [thread("t-a", "Task A"), thread("t-w", "Task W")],
          panes: [pane("a", "Task A"), pane("winner", "Task W", { resolve: false })],
        },
      ],
      new Set()
    );

    expect(matches).toEqual([{ key: "a", sessionId: "t-a" }]);
  });

  it("matches one broadcast prompt in each folder it went to", () => {
    const matches = matchRestorePanes(
      [
        { threads: [thread("t-1", "Broadcast")], panes: [pane("a", "Broadcast")] },
        { threads: [thread("t-2", "Broadcast")], panes: [pane("b", "Broadcast")] },
      ],
      new Set()
    );

    expect(matches).toEqual([
      { key: "a", sessionId: "t-1" },
      { key: "b", sessionId: "t-2" },
    ]);
  });

  it("holds both panes when two spellings of one folder list the same thread", () => {
    const shared = thread("t-1", "Task");
    const matches = matchRestorePanes(
      [
        { threads: [shared], panes: [pane("a", "Task")] },
        { threads: [shared], panes: [pane("b", "Task")] },
      ],
      new Set()
    );

    expect(matches).toEqual([]);
  });

  it("answers the same whatever order the panes and threads arrive in", () => {
    const threads = [thread("t-a", "Task A"), thread("t-b", "Task B"), thread("t-x", "Shared")];
    const panes = [
      pane("a", "Task A"),
      pane("b", "Task B"),
      pane("x", "Shared"),
      pane("y", "Shared"),
    ];

    const forward = matchRestorePanes([{ threads, panes }], new Set());
    const reversed = matchRestorePanes(
      [{ threads: [...threads].reverse(), panes: [...panes].reverse() }],
      new Set()
    );

    const byKey = (list: Array<{ key: string; sessionId: string }>) =>
      [...list].sort((left, right) => left.key.localeCompare(right.key));
    expect(byKey(reversed)).toEqual(byKey(forward));
    expect(byKey(forward)).toEqual([
      { key: "a", sessionId: "t-a" },
      { key: "b", sessionId: "t-b" },
    ]);
  });
});
