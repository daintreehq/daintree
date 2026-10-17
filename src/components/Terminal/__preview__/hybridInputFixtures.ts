/**
 * Fixtures for the hybrid-input layout harness.
 *
 * The composer's layout is decided by two things the component itself cannot be
 * asked for: how wide its column is, and how many lines the draft wraps to. In
 * the app both come from the grid — a pane's width is whatever the splits leave
 * it, and the wrap point follows from that width. So the fixtures here are
 * (width × draft) pairs rather than component states.
 */

/** Column widths, in px, spanning the range the content grid actually produces. */
export const WIDTHS = [1100, 720, 520, 420, 360, 300, 260, 220] as const;

export type Width = (typeof WIDTHS)[number];

/**
 * The draft from the reported screenshot. Long enough to wrap to three lines at
 * a middling width, which is the case where centred trailing buttons sit beside
 * the middle line and the first and last lines run into dead space.
 */
export const REPORTED_DRAFT =
  "Thisa dias dasd naslknf asdkljnf kdlsjan klajsnd vclkjnasd cklnjsdc klsdanc sldknc sdlkacn sadlknc dssdc sdnalcds";

export const DRAFTS = {
  empty: "",
  short: "Fix the test",
  /** Exactly the reported case. */
  reported: REPORTED_DRAFT,
  /** Past the 160px / 8-line autosize cap, so the editor scrolls internally. */
  overflow: Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long standing draft`).join(
    "\n"
  ),
  /** The second reported case, from the Daintree Assistant sidebar: three lines at ~430px. */
  sidebar:
    "afsJ FDASLJHF ADSKJHF SDA F JDSKAFH SAD FSADH FKJDSHAF DSKJFH SDAKJFHSD KAFHKDSJ FHKJASDFHDSAK JFHAKSDJFH DSAKHF DSKJFHASDKFH DASKFA",
  /**
   * The third reported case: an ordinary prose prompt that wraps to two lines in
   * a ~700px pane with a short last line, where the controls took a row of
   * their own beneath it and left the end of that line empty.
   */
  prose:
    "And when you're done please give me an idea of how much the performance overall improved.",
  /** Hard newlines whose last line is short, the way a pasted list ends. */
  list: "Before you push:\n- rebase onto develop\n- rerun the flaky worktree test\n- ok",
  /**
   * Ends on an `@file` chip long enough to wrap inside itself at the narrow
   * widths. The chip paints only its text, so the empty right of its box is
   * room for the controls.
   */
  path: "Check the fixtures in @src/components/Terminal/__preview__/hybridInputFixtures.ts",
} as const;

export type DraftName = keyof typeof DRAFTS;

/**
 * The typing strip: one prompt shown at a run of lengths, as if typed, so a
 * single picture shows what the composer does on each keystroke around a wrap
 * — whether the controls move, and whether the height steps evenly.
 */
export const TYPING_DRAFT = `${DRAFTS.prose} Then rerun the flaky worktree test and tell me what changed.`;

export const TYPING_WIDTH = 360;

/** Draft lengths for the strip: two and a half lines at `TYPING_WIDTH`, every five characters. */
export const TYPING_LENGTHS = Array.from({ length: 20 }, (_, i) => 20 + i * 5);

/**
 * The pills case: a prompt that ends on a pasted screenshot's chip. The chip
 * is a tinted pill whose label wraps once the pane is narrower than it, which
 * is the one shape a column beside the text can beat the corner on.
 */
export const PILL_DRAFT = "Why does this pane render blank? ";

export const PILL_WIDTHS = [520, 420, 360, 300, 260, 220] as const;

/**
 * Narrow panes where the draft ends on the pill itself, with the space the
 * paste leaves after it deleted. In a pane narrower than its label the pill
 * wraps to the full width, and that is the shape where giving up a column
 * beside the text can be shorter than a row beneath it. The dropped file's
 * longer label is the one that keeps its row count when narrowed.
 */
export const PILL_PANES = [
  ...PILL_WIDTHS.map((width) => ({ id: `pills-${width}`, width, tight: false, file: false })),
  { id: "pills-220-tight", width: 220, tight: true, file: false },
  { id: "pills-300-file", width: 300, tight: true, file: true },
  { id: "pills-270-file", width: 270, tight: true, file: true },
] as const;

/** Resolves a `?draft=` query value, falling back to the reported case. */
export function resolveDraft(name: string | null): string {
  const byName: Record<string, string | undefined> = DRAFTS;
  return (name === null ? undefined : byName[name]) ?? DRAFTS.reported;
}

/**
 * Agents for the tile view, so the placeholders differ the way they do in a real
 * fleet. Ten distinct ones: two tiles reading the same placeholder is a fixture
 * artefact that reads as a rendering bug in review.
 */
export const TILE_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "aider",
  "opencode",
  "grok",
  "copilot",
  "goose",
  "amp",
] as const;

/**
 * Agents for the whole-pane cases. Mostly Claude on purpose: the report is a
 * row of composers that all read "Ask Claude", where the placeholder can say
 * nothing about which pane is live.
 */
export const PANE_AGENTS = ["claude", "claude", "claude", "codex", "claude", "gemini"] as const;

export const PANE_TITLES = [
  "Fix flaky worktree test",
  "Refactor panel store",
  "Add host switcher",
  "Review IPC handlers",
  "Theme contrast pass",
  "Upgrade xterm",
] as const;

/** A settled agent transcript, so the terminal body reads as one without stealing the eye. */
export const TERMINAL_LINES = [
  "● Read src/store/panelStore.ts (412 lines)",
  "● Update src/components/Terminal/TerminalPane.tsx",
  "  ⎿ Updated with 3 additions and 1 removal",
  "● Bash(npm test -- src/store/__tests__/panelStore.test.ts)",
  "  ⎿ 48 passed",
  "",
  "Done. The focus handoff now waits for the pane to mount.",
] as const;

/**
 * The chips case: a draft carrying every token-driven chip — a slash command,
 * an `@file`, a diff, the terminal buffer and the terminal selection — so the
 * attachments the spec adds land beside each kind they are judged against.
 */
export const CHIP_DRAFT =
  "/compact then check @src/components/Terminal/HybridInputBar.tsx against @diff:staged with @terminal and @selection";

/**
 * What the chips case attaches through `insertFileAttachments`: a pasted
 * screenshot (named the way a host inbox stamps one, so its label is
 * deterministic) and a file dropped from outside the project, with a size.
 */
export const CHIP_ATTACHMENTS = [
  {
    source: "local",
    filePath: "/var/folders/xy/T/daintree-clipboard/clipboard-20261015-143210-a1b2.png",
    rawName: "clipboard-20261015-143210-a1b2.png",
    fileName: "clipboard-20261015-143210-a1b2.png",
    fileSize: 184_320,
  },
  {
    source: "local",
    filePath: "/Users/dev/Downloads/quarterly-report-q3.pdf",
    rawName: "quarterly-report-q3.pdf",
    fileName: "quarterly-report-q3.pdf",
    fileSize: 2_457_600,
  },
] as const;
