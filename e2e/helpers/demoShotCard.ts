import path from "path";
import type { BuiltScene, DemoScene, DemoSceneBeat } from "./demoScene";

/**
 * Render the shot card a person records from.
 *
 * Generated from the same scene that stages the app, never written by hand.
 * The card's whole value is that its "already true on screen" column is the
 * state the harness actually built — a card maintained separately drifts, and a
 * shot card that disagrees with the screen costs more than no card at all.
 */
export interface ShotCardOptions {
  /** Command that resets and relaunches, printed under "Between takes". */
  takeCommand?: string;
  /** Command that deletes the scene, snapshot and profiles when finished. */
  teardownCommand?: string;
  /** Warn when the beats add up past this. Omit to skip the check. */
  targetSeconds?: number;
}

/**
 * Wrap text in a code span that its own backticks cannot escape.
 *
 * A super is the literal text that goes on screen, so it routinely contains
 * backticks and punctuation. A naive single-backtick span lets that text close
 * the span early and take the rest of the line's formatting with it.
 */
function codeSpan(text: string): string {
  const longestRun = [...text.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function formatTimecode(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Beats with a running start time, so the card reads as a timeline. */
function withTimecodes(
  beats: DemoSceneBeat[]
): Array<{ beat: DemoSceneBeat; start: number; end: number }> {
  let cursor = 0;
  return beats.map((beat) => {
    const start = cursor;
    cursor += beat.seconds ?? 0;
    return { beat, start, end: cursor };
  });
}

function renderPreflight(scene: DemoScene, built: BuiltScene): string[] {
  const lines = [
    "## Before you roll",
    "",
    "Already on screen when the app opens — you do not set any of this up:",
    "",
    `- **Project** \`${path.basename(built.dir)}\` at \`${built.dir}\``,
  ];

  if (built.remotePath) {
    lines.push(
      `- **Remote** \`origin\` → \`${built.remotePath}\` (local bare repo: push and ahead/behind work offline, PR and CI chips do not)`
    );
  } else {
    lines.push("- **No remote** — push, ahead/behind counts and forge chips are all unavailable");
  }

  if (built.worktrees.length === 0) {
    lines.push("- **No worktrees** beyond the default branch");
  } else {
    const count = built.worktrees.length;
    lines.push(`- **${count} worktree${count === 1 ? "" : "s"}**:`);
    for (const worktree of built.worktrees) {
      const declared = scene.worktrees?.find((entry) => entry.branch === worktree.branch);
      const notes: string[] = [];
      const dirtyCount = Object.keys(declared?.uncommittedFiles ?? {}).length;
      if (dirtyCount > 0) {
        notes.push(`${dirtyCount} uncommitted file${dirtyCount === 1 ? "" : "s"}`);
      }
      const ahead = declared?.aheadCommits?.length ?? 0;
      if (ahead > 0) notes.push(`${ahead} ahead of origin`);
      if (declared?.push) notes.push("tracking origin");
      const suffix = notes.length > 0 ? ` — ${notes.join(", ")}` : "";
      lines.push(`  - \`${worktree.branch}\`${suffix}`);
    }
  }

  lines.push("");
  return lines;
}

function renderBeat(
  entry: { beat: DemoSceneBeat; start: number; end: number },
  index: number
): string[] {
  const { beat, start, end } = entry;
  const timed = beat.seconds !== undefined;
  const heading = timed
    ? `### ${index + 1}. ${beat.name} · ${formatTimecode(start)}–${formatTimecode(end)}`
    : `### ${index + 1}. ${beat.name}`;

  const lines = [heading, ""];
  if (beat.given) lines.push(`**Already true:** ${beat.given}`, "");
  lines.push(`**Do:** ${beat.action}`, "");
  if (beat.waitFor) lines.push(`**Wait for:** ${beat.waitFor}`, "");
  if (beat.expect) lines.push(`**Good take if:** ${beat.expect}`, "");
  if (beat.super) lines.push(`**Super:** ${codeSpan(beat.super)}`, "");
  return lines;
}

export function renderShotCard(
  scene: DemoScene,
  built: BuiltScene,
  options: ShotCardOptions = {}
): string {
  // Provenance: the preflight reads paths and branches from `built` but the
  // per-worktree notes from `scene`. That is only sound while the two describe
  // the same build. Mismatched inputs would render a card that is internally
  // consistent and wrong, which is the one failure this generator exists to
  // prevent.
  if (scene.slug !== built.slug) {
    throw new Error(
      `Cannot render a shot card: scene "${scene.slug}" does not match built scene "${built.slug}".`
    );
  }
  const declaredBranches = new Set((scene.worktrees ?? []).map((worktree) => worktree.branch));
  const builtBranches = new Set(built.worktrees.map((worktree) => worktree.branch));
  const missing = [...builtBranches].filter((branch) => !declaredBranches.has(branch));
  const extra = [...declaredBranches].filter((branch) => !builtBranches.has(branch));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Cannot render a shot card: the scene and the built scene disagree about worktrees ` +
        `(built only: ${missing.join(", ") || "none"}; declared only: ${extra.join(", ") || "none"}).`
    );
  }

  const beats = scene.beats ?? [];
  const timed = withTimecodes(beats);
  const total = timed.length > 0 ? timed[timed.length - 1]!.end : 0;

  const lines = [`# ${scene.slug} — shot card`, ""];

  if (beats.length === 0) {
    lines.push(
      "_This scene declares no beats._ Add a `beats` array to the scene file and regenerate — the card is rendered from the scene so the two cannot disagree.",
      ""
    );
  } else if (total > 0) {
    lines.push(
      `**${beats.length} beat${beats.length === 1 ? "" : "s"} · ${formatTimecode(total)} of material**`,
      ""
    );
    if (options.targetSeconds !== undefined && total > options.targetSeconds) {
      lines.push(
        `> Over target: ${formatTimecode(total)} against ${formatTimecode(options.targetSeconds)}. ` +
          `Cut a beat rather than rushing one — IPC latency means a take runs longer than the sum of its beats, not shorter.`,
        ""
      );
    }
  }

  lines.push(...renderPreflight(scene, built));

  if (beats.length > 0) {
    lines.push("## Beats", "");
    timed.forEach((entry, index) => lines.push(...renderBeat(entry, index)));
  }

  lines.push("## Between takes", "");
  if (options.takeCommand) {
    lines.push(`Reset and relaunch:`, "", "```bash", options.takeCommand, "```", "");
  }
  lines.push(
    "**What a new take resets:** the app profile — panels, layout, active worktree, everything the bake staged in the UI.",
    "",
    "**What it does not reset:** the repository. Commits, edits, pushes to the local origin and anything an agent wrote all survive into the next take. If a beat changes the repo — and in an agent demo most of them do — rebuild the scene before the next take, or you are recording against a tree that drifted.",
    "",
    "Quit the app fully before starting the next take. On macOS closing the window is not quitting; use Cmd+Q and wait for it to disappear from the Dock. A take started while the previous app still holds its profile will usually refuse, but that check is a courtesy rather than a lock — do not race it.",
    ""
  );

  lines.push("## When you are done", "");
  lines.push(
    options.teardownCommand
      ? `\`\`\`bash\n${options.teardownCommand}\n\`\`\``
      : "Tear the demo down — the scene, snapshot and work profile are all temporary and none of them should outlive the recording."
  );
  lines.push("");

  return lines.join("\n");
}
