import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The formatting rules the UI consistency audit settled (component-contract.md,
 * "Formatting"). Each one had drifted into private copies that disagreed:
 *
 * - Ages, durations, sizes and token counts come from the shared formatters,
 *   not a local `formatBytes` / `formatDuration` / `relativeTime` that prints
 *   "1.0 KB" in one row and "1 KB" in the next.
 * - A relative age in a row renders through `TimeAgo` (or `LiveTimeAgo`) so the
 *   exact time is one hover away.
 * - Line churn renders through `DiffStat`: "+12 -3", success and error inks, no
 *   "/" separator, no U+2212, nothing when both sides are zero.
 * - Task progress renders through `ProgressBar`, one track and one fill.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "__tests__", "__preview__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|bench)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const sources = walk(path.join(REPO_ROOT, "src")).map((file) => ({
  file: rel(file),
  text: fs.readFileSync(file, "utf8"),
}));

function offenders(pattern: RegExp, allow: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const { file, text } of sources) {
    if (file in allow) continue;
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

const LOCAL_FORMATTER =
  /\bfunction (format(Bytes|FileSize|Duration|Elapsed|Uptime|RelativeTime|TimeSince|TimeAgo|Remaining|AuditAge|SnapshotAge|TokenEstimate)\w*|relativeTime)\s*\(/;

describe("formatting contract", () => {
  it("has no private copies of the shared time, duration, size or token formatters", () => {
    expect(
      offenders(LOCAL_FORMATTER, {
        "src/utils/timeAgo.ts": "canonical compact age",
        "src/lib/formatRelativeTime.ts": "canonical verbose age",
        "src/utils/formatElapsedDuration.ts": "canonical elapsed duration",
        "src/utils/formatCountdown.ts": "canonical time remaining",
        "src/lib/formatBytes.ts": "canonical size",
        "src/utils/formatTokenCount.ts": "canonical token count",
        "src/components/Worktree/LiveTimeAgo.tsx":
          "the ticking label: its bucket boundaries drive the wake schedule",
        "src/components/Layout/FreshnessUtils.tsx":
          "formatTimeSince is formatTimeAgo behind a null/future guard",
        "src/components/Layout/VoiceRecordingToolbarButton.tsx":
          "a recording timer reads as a stopwatch face (0:42), the platform convention",
      })
    ).toEqual([]);
  });

  it("renders relative ages through TimeAgo so the exact time is one hover away", () => {
    // A bare `{formatTimeAgo(...)}` / `{formatRelativeTime(...)}` JSX child is an age
    // with no absolute time behind it. Template strings (`${...}`) feed labels
    // that carry their own title, tooltip or accessible name.
    expect(
      offenders(/(?<!\$)\{\s*format(TimeAgo|RelativeTime)\(/, {
        "src/components/Sidebar/WorktreesReconnectingBadge.tsx": "the age is tooltip content",
        "src/components/Terminal/TerminalAgentIndicator.tsx": "the age is tooltip content",
        "src/components/Terminal/TerminalRateLimitBadge.tsx":
          "the clock time is printed beside the age",
        "src/components/Layout/LocalCommitsDropdown.tsx":
          "the age is a tooltip trigger whose content is the full date",
      })
    ).toEqual([]);
  });

  it("renders line churn through DiffStat", () => {
    expect(
      offenders(/(text-status-success|text-diff-gutter-insert)[^"]*"\s*>\s*\+\{/, {
        "src/components/ui/DiffStat.tsx": "the primitive",
        "src/components/Tour/scenes/ReviewScene.tsx":
          "tour scenes may not import host components (#12769); it spells DiffStat inline",
      })
    ).toEqual([]);
    expect(offenders(/>\s*−\{/, {})).toEqual([]);
  });

  it("renders task progress through ProgressBar", () => {
    expect(
      offenders(/role="progressbar"/, {
        "src/components/ui/ProgressBar.tsx": "the primitive",
        "src/components/Fleet/FleetArmingRibbon.tsx":
          "a text counter (3/5 sent) with no track, not a bar",
      })
    ).toEqual([]);
  });

  it("truncates paths with middleTruncatePath, which keeps the filename", () => {
    expect(
      offenders(/\bmiddleTruncate\([^)]*[pP]ath/, {
        "src/utils/textParsing.ts": "the helpers themselves",
      })
    ).toEqual([]);
  });
});
