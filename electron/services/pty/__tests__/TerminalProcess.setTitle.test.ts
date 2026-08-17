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
