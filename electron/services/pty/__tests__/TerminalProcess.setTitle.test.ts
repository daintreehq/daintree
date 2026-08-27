/**
 * `setTitle` is the only writer of a renamed title on the authoritative record.
 * Its whole contract is that `title` and `titleMode` move together: a title
 * landing without its mode still reads as `"default"`, and the next agent
 * detection sweep overwrites the user's rename (#10794, #11830).
 *
 * Exercised through the prototype so the real mutator is under test without
 * standing up a PTY — `setTitle` touches nothing but `terminalInfo`.
 */
import { describe, it, expect } from "vitest";
import { TerminalProcess } from "../TerminalProcess.js";
import type { PanelTitleMode } from "../../../../shared/types/panel.js";

function applySetTitle(
  info: { title?: string; titleMode?: PanelTitleMode; lastObservedTitle?: string },
  title: string,
  titleMode: PanelTitleMode
) {
  TerminalProcess.prototype.setTitle.call({ terminalInfo: info } as never, title, titleMode);
  return info;
}

describe("TerminalProcess.setTitle", () => {
  it("writes the mode in the same call as the title", () => {
    const info = applySetTitle({ title: "claude", titleMode: "default" }, "Ship the fix", "user");

    expect(info).toMatchObject({ title: "Ship the fix", titleMode: "user" });
  });

  it("lowers the mode as readily as it raises it, so an unlock is not one-way", () => {
    const locked = applySetTitle({ title: "Mine", titleMode: "user" }, "Claude", "default");

    // An empty rename resets the panel to its identity default and drops the
    // lock; a mutator that only ever escalated would strand the terminal.
    expect(locked.titleMode).toBe("default");
  });

  it("leaves the observed OSC title alone — it is a separate ingredient", () => {
    const info = applySetTitle(
      { title: "old", titleMode: "default", lastObservedTitle: "agent task" },
      "Renamed",
      "user"
    );

    expect(info.lastObservedTitle).toBe("agent task");
  });
});

/**
 * `setWorktreeId` is the mirror of a renderer-side cross-worktree move onto the
 * authoritative record — the one the fleet palette groups by (#12060). Its
 * contract is that `null` genuinely un-files the run: the key comes off, rather
 * than being blanked to a string the palette would read as a worktree named "".
 */
function applySetWorktreeId(
  info: { worktreeId?: string; title?: string },
  worktreeId: string | null
) {
  TerminalProcess.prototype.setWorktreeId.call({ terminalInfo: info } as never, worktreeId);
  return info;
}

describe("TerminalProcess.setWorktreeId", () => {
  it("re-files a run onto the worktree it moved to", () => {
    const info = applySetWorktreeId({ worktreeId: "/repo" }, "/repo/.worktrees/feature");

    expect(info.worktreeId).toBe("/repo/.worktrees/feature");
  });

  it("files a run that had no worktree at all", () => {
    const info = applySetWorktreeId({}, "/repo");

    expect(info.worktreeId).toBe("/repo");
  });

  it("deletes the key on an explicit clear rather than blanking it", () => {
    // `worktreeKey` in the palette folds a blank id in with the absent one, so a
    // blank would land in the right bucket by luck — but every other reader
    // (session journal, worktree-scoped clears) would see a worktree whose id is
    // the empty string.
    const info = applySetWorktreeId({ worktreeId: "/repo", title: "claude" }, null);

    expect("worktreeId" in info).toBe(false);
    expect(info.title).toBe("claude");
  });

  it("stores the id exactly as given, without normalizing the path", () => {
    // Worktree ids are paths, and the same path has more than one spelling. A
    // record that re-spells it stops matching the renderer's own index.
    const spelling = "/Repo/../repo/.worktrees/feature/";
    const info = applySetWorktreeId({}, spelling);

    expect(info.worktreeId).toBe(spelling);
  });
});
