#!/usr/bin/env node
// "Fake Claude" — a stand-in agent TUI for reproducing the project-switch
// redraw bug WITHOUT a real CLI/API. Real coding agents (Claude, Codex, Gemini,
// …) render a full-screen UI in the ALTERNATE screen buffer and wrap each
// repaint in DEC 2026 synchronized output. Those are exactly the terminals the
// reflow/repaint guards skip (`!isAltBuffer && synchronizedOutputMode !== true`),
// so they're the ones left garbled after switching back to a backgrounded
// project until you click Redraw.
//
// MANUAL TEST:
//   1. Open a terminal in project A and run:  node e2e/fixtures/fake-claude-agent.cjs
//   2. It paints a full-width bordered box; every line is EXACTLY `cols` wide,
//      so a stale grid width shows as broken borders / wrapped rows = garble.
//   3. Switch to another project, resize the window, switch back to A.
//   4. WITHOUT the redraw fix the box stays garbled/stale until you click the
//      pane or the panel-menu Redraw. WITH the fix it re-fits/repaints on its
//      own within a few seconds (and at worst when the 10s resize suppression
//      clears).
//   Ctrl-C to quit (restores the normal screen).

const ESC = "\x1b";
const ALT_ON = `${ESC}[?1049h`; // enter alternate screen buffer
const ALT_OFF = `${ESC}[?1049l`; // leave it
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const SYNC_BEGIN = `${ESC}[?2026h`; // DEC 2026 begin synchronized update
const SYNC_END = `${ESC}[?2026l`; // DEC 2026 end synchronized update
const HOME = `${ESC}[H`;
const CLEAR = `${ESC}[2J`;

let frame = 0;

function pad(s, width) {
  if (s.length > width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function render() {
  const cols = Math.max(8, process.stdout.columns || 80);
  const rows = Math.max(4, process.stdout.rows || 24);
  frame += 1;

  const lines = [];
  lines.push("┌" + "─".repeat(cols - 2) + "┐");
  const title = ` ⏺ Fake Claude   cols=${cols} rows=${rows}   frame=${frame} `;
  lines.push("│" + pad(title, cols - 2) + "│");
  lines.push("├" + "─".repeat(cols - 2) + "┤");
  // Body rows: a width marker on each so a wrong grid wraps visibly. The trailing
  // column count and ┤ border only line up when the grid width matches the PTY.
  const bodyRows = rows - 5;
  for (let i = 0; i < bodyRows; i++) {
    const tag = ` row ${String(i).padStart(2, "0")}  `;
    const ruler =
      tag + "·".repeat(Math.max(0, cols - 2 - tag.length - 6)) + `[${pad(String(cols), 4)}]`;
    lines.push("│" + pad(ruler, cols - 2) + "│");
  }
  lines.push("└" + "─".repeat(cols - 2) + "┘");

  // One synchronized update so a partial paint is never shown — exactly how a
  // real agent repaints, and the mode that suppresses our reflow.
  process.stdout.write(SYNC_BEGIN + HOME + CLEAR + HOME + lines.join("\r\n") + SYNC_END);
}

function cleanup() {
  process.stdout.write(SYNC_END + CURSOR_SHOW + ALT_OFF);
}

process.stdout.write(ALT_ON + CURSOR_HIDE);
process.stdout.on("resize", render);
const timer = setInterval(render, 500);
render();

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    clearInterval(timer);
    cleanup();
    process.exit(0);
  });
}
process.on("exit", cleanup);
