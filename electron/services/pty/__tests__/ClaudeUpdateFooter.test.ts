import { describe, expect, it } from "vitest";
import { scanClaudeUpdateFooter } from "../ClaudeUpdateFooter.js";

const COLS = 100;

/** A footer row as Claude draws it: hints on the left, notices flush right. */
const footer = (left: string, notice: string, cols = COLS) =>
  `${left}${" ".repeat(Math.max(2, cols - 1 - left.length - notice.length))}${notice}`;

/** The bottom of a Claude Code screen: the prompt box, then the footer row. */
const frame = (footerRow: string, cols = COLS) => [
  "⏺ Done. The tests pass.",
  "",
  "─".repeat(cols),
  "❯ ",
  "─".repeat(cols),
  footerRow,
];

const scan = (lines: string[], cols = COLS) => scanClaudeUpdateFooter(lines, cols);

// Rows as Claude Code 2.1.328 draws them, read from its shipped renderer: the
// native updater's "✔ Update installed · <offer>" (a server-set offer,
// "/restart to apply" by default, or "Restart to update" where /restart isn't
// offered), the npm updater's "✔ Update installed · restart to apply", and the
// package-manager updater's "✓ Update installed via <manager> · restart to
// apply".
describe("scanClaudeUpdateFooter", () => {
  it.each([
    ["the native updater's default offer", "✔ Update installed · /restart to apply", true],
    ["the offer where /restart isn't available", "✔ Update installed · Restart to update", false],
    ["the npm updater's lowercase offer", "✔ Update installed · restart to apply", false],
    [
      "a server-set offer that names /restart",
      "✔ Update installed · type /restart to pick it up",
      true,
    ],
    ["a server-set offer that doesn't", "✔ Update installed · reopen to apply", false],
    [
      "a server-set offer that names /restart in brackets",
      "✔ Update installed · apply (/restart)",
      true,
    ],
    ["an offer naming a longer command", "✔ Update installed · /restart-all to apply", false],
    ["an offer naming a path under it", "✔ Update installed · see /restart/notes", false],
    [
      "the package-manager updater's form",
      "✓ Update installed via homebrew · restart to apply",
      false,
    ],
    ["the Windows tick", "√ Update installed · Restart to update", false],
  ])("reads %s beside the shortcuts hint", (_name, notice, namesRestart) => {
    expect(scan(frame(footer("  ? for shortcuts", notice)))).toEqual({ namesRestart });
  });

  it("reads the footer on a row of its own", () => {
    expect(scan(frame("  ✔ Update installed · /restart to apply"))).toEqual({
      namesRestart: true,
    });
  });

  it("reads the footer appended to other hints behind a separator", () => {
    const row =
      "  ⏵⏵ accept edits on (shift+tab to cycle) · ✔ Update installed · /restart to apply";
    expect(scan(frame(row))).toEqual({ namesRestart: true });
  });

  it("reads the footer beside a mode hint and a usage warning", () => {
    const row = footer(
      "  ⏸ plan mode on (shift+tab to cycle)",
      "✔ Update installed · Restart to update  Approaching weekly limit"
    );
    expect(scan(frame(row))).toEqual({ namesRestart: false });
  });

  it.each([
    ["a separator", "✔ Update installed · Restart to update · /restart to apply"],
    ["a column gap", "✔ Update installed · Restart to update  /restart to apply"],
  ])("ends the offer at %s, so a neighbour naming /restart doesn't count", (_name, notice) => {
    expect(scan(frame(footer("  ? for shortcuts", notice)))).toEqual({ namesRestart: false });
  });

  it("ignores a footer quoted in the transcript above the composer", () => {
    const lines = [
      "⏺ The footer reads:",
      "  ✔ Update installed · /restart to apply",
      "─".repeat(COLS),
      "❯ ",
      "─".repeat(COLS),
      "  ? for shortcuts",
    ];
    expect(scan(lines)).toBeNull();
  });

  // A footer wider than the pane, as the terminal wraps it: the first row is
  // trimmed of the trailing spaces the read drops.
  const wrap = (row: string, cols: number) => [
    ...frame(row.slice(0, cols).trimEnd(), cols),
    row.slice(cols),
  ];

  it("reads an offer a narrow pane wrapped onto the next row", () => {
    const row = "  ? for shortcuts  ✔ Update installed · /restart to apply";
    expect(scan(wrap(row, 44), 44)).toEqual({ namesRestart: true });
  });

  it("doesn't join a row a column short of the edge, which a dropped blank row could fake", () => {
    // The read drops blank rows, so a head alone one column short of the edge
    // and a later row starting with the separator are not a wrapped footer.
    const head = "✔ Update installed".padStart(COLS - 1);
    expect(
      scan([...frame("  ? for shortcuts", COLS).slice(0, -1), head, " · /restart"])
    ).toBeNull();
  });

  it("misses a footer whose wrap fell on a space, rather than guess at a join", () => {
    // The trade for the case above: the space in the last column is trimmed,
    // so the row reads a column short and isn't joined. A repaint at another
    // width reads it.
    const row = "  ? for shortcuts  ✔ Update installed · /restart to apply";
    expect(row[39]).toBe(" ");
    expect(scan(wrap(row, 40), 40)).toBeNull();
  });

  it("reads a head a narrow pane wrapped mid-word", () => {
    const row = "  ? for shortcuts  ✔ Update installed · /restart to apply";
    expect(scan(wrap(row, 30), 30)).toEqual({ namesRestart: true });
  });

  it("doesn't join a row that stops short of the pane's edge", () => {
    const row = footer("  ? for shortcuts", "✔ Update installed · Restart to", COLS - 5);
    expect(scan([...frame(row), " /restart"])).toEqual({ namesRestart: false });
  });

  it("doesn't take a truncated /restart as naming it", () => {
    const row = footer("  ? for shortcuts", "✔ Update installed · /resta…");
    expect(scan(frame(row))).toEqual({ namesRestart: false });
  });

  it("strips colour before matching", () => {
    const row = "  \x1b[32m✔ Update installed · \x1b[1m/restart\x1b[22m to apply\x1b[39m";
    expect(scan(frame(row))).toEqual({ namesRestart: true });
  });

  it.each([
    ["the plugin install notice", "✔ typescript-lsp installed · restart to apply"],
    ["a plugin whose name ends in Update", "✔ Auto Update installed · restart to apply"],
    ["the settings reload notice", "settings.json changed; restart to apply"],
    ["a mod's unbound reload notice", "statusline.mjs; restart to apply"],
    ["the updater's progress", "Auto-updating…"],
    ["an update that failed", "✗ Auto-update failed · Run claude doctor"],
    ["the update-available notice", "Update available · run claude update"],
  ])("ignores %s", (_name, notice) => {
    expect(scan(frame(footer("  ? for shortcuts", notice)))).toBeNull();
  });

  it.each([
    ["prose about the footer", "  The footer says ✔ Update installed · /restart to apply"],
    ["the head without its tick", "  Update installed · /restart to apply"],
    ["the head without an offer", "  ✔ Update installed"],
    ["a quoted string in code", `  const notice = "✔ Update installed · /restart to apply";`],
  ])("ignores %s", (_name, row) => {
    expect(scan(frame(row))).toBeNull();
  });

  it("ignores a footer scrolled above the tail it reads", () => {
    const lines = ["  ✔ Update installed · /restart to apply", ...Array(12).fill("output")];
    expect(scan(lines)).toBeNull();
  });

  it("takes the lowest footer on screen", () => {
    const lines = [
      "  ✔ Update installed · /restart to apply",
      "output",
      footer("  ? for shortcuts", "✔ Update installed · Restart to update"),
    ];
    expect(scan(lines)).toEqual({ namesRestart: false });
  });

  it("reads a row on its own without the pane's width", () => {
    expect(scanClaudeUpdateFooter(frame("  ✔ Update installed · /restart to apply"))).toEqual({
      namesRestart: true,
    });
  });
});
