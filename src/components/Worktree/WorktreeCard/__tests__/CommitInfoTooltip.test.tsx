/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CommitInfoTooltip,
  exactTimePhrase,
  msUntilCardChanges,
  relativeTimePhrase,
} from "../CommitInfoTooltip";

const human = { name: "Jane Doe", email: "jane@example.com" };

describe("CommitInfoTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the author, commit time, and message", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 120_000}
        author={human}
        commitMessage="fix: resolve the navigation race"
      />
    );
    expect(screen.getByText("Jane Doe")).toBeDefined();
    expect(screen.getByText("Committed 2 minutes ago")).toBeDefined();
    expect(screen.getByText("fix: resolve the navigation race")).toBeDefined();
  });

  it("renders a Gravatar image with the d=404 probe for a human author", () => {
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("gravatar.com");
    expect(img!.getAttribute("src")).toContain("d=404");
  });

  it("falls through to coloured initials when Gravatar 404s", () => {
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("JD")).toBeDefined();
  });

  it("holds the avatar slot with initials until the picture has loaded", () => {
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} />
    );
    const img = container.querySelector("img")!;
    expect(screen.queryByText("JD")).not.toBeNull();
    fireEvent.load(img);
    expect(screen.queryByText("JD")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("renders a branded agent icon for an agent committer", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{ name: "Codex", email: "noreply@codex.openai.com" }}
      />
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never brands a human whose address merely contains an agent id", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{ name: "Claude Monet", email: "claude.monet@example.org" }}
      />
    );
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("brands a GitHub noreply commit whose login is an agent", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{ name: "Copilot", email: "198982749+Copilot@users.noreply.github.com" }}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders a square avatar for a bot author", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{
          name: "dependabot[bot]",
          email: "49699333+dependabot[bot]@users.noreply.github.com",
        }}
      />
    );
    const img = container.querySelector("img")!;
    // md and up are 8px+ corners — a full circle at the 16–24px this renders
    // at, which would paint the bot as a person.
    expect(img.className).not.toMatch(/rounded-(md|lg|xl|full)\b/);
    expect(img.className).toMatch(/rounded-/);
  });

  it("shows a generic header and no avatar when the author is absent", () => {
    const { container } = render(<CommitInfoTooltip lastCommitTimestampMs={Date.now() - 60_000} />);
    expect(screen.getByText("Last commit")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the Last active line only when an activity timestamp is given", () => {
    const { rerender } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now() - 600_000} author={human} />
    );
    expect(screen.queryByText(/Last active/)).toBeNull();

    rerender(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 600_000}
        author={human}
        lastActivityTimestamp={Date.now() - 120_000}
      />
    );
    expect(screen.getByText(/^Last active 2 minutes ago ·/)).toBeDefined();
  });

  it("renders activity detail when the repository has no commit", () => {
    const { container } = render(
      <CommitInfoTooltip lastActivityTimestamp={Date.now() - 120_000} />
    );

    expect(screen.getByText(/^Last active 2 minutes ago ·/)).toBeDefined();
    expect(screen.queryByText("Last commit")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps commit detail when activity comes from a later file change", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 3_600_000}
        author={human}
        commitMessage="fix: preserve commit context"
        lastActivityTimestamp={Date.now() - 120_000}
      />
    );

    expect(screen.getByText("Jane Doe")).toBeDefined();
    expect(screen.getByText("Committed 1 hour ago")).toBeDefined();
    expect(screen.getByText("fix: preserve commit context")).toBeDefined();
    expect(screen.getByText(/^Last active 2 minutes ago ·/)).toBeDefined();
  });

  it("does not repeat activity detail when the commit is the activity source", () => {
    const timestamp = Date.now() - 120_000;
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={timestamp}
        author={human}
        lastActivityTimestamp={timestamp}
      />
    );

    expect(screen.getByText("Committed 2 minutes ago")).toBeDefined();
    expect(screen.queryByText(/Last active/)).toBeNull();
  });

  it("lifts trailers out of the body and names co-authors in the byline", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 60_000}
        author={human}
        commitMessage="Resume dropped parts"
        commitBody={
          "Why it matters.\n\nCo-authored-by: Sam Okafor <sam@x.dev>\nSigned-off-by: Jane Doe <jane@example.com>"
        }
      />
    );
    expect(screen.getByText("Why it matters.")).toBeDefined();
    expect(screen.getByText("with Sam Okafor")).toBeDefined();
    expect(container.textContent).not.toMatch(/-by:/);
  });

  it("shows the subject before the author", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 60_000}
        author={human}
        commitMessage="fix: resolve the navigation race"
      />
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("fix: resolve")).toBeLessThan(text.indexOf("Jane Doe"));
  });

  it("abbreviates the SHA and keeps the full id available", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    render(<CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} commitSha={sha} />);
    const short = screen.getByText(sha.slice(0, 7));
    expect(short.getAttribute("title")).toBe(sha);
  });

  it("switches to an absolute date where the activity chip does", () => {
    const { rerender } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now() - 29 * 86_400_000} author={human} />
    );
    expect(screen.getByText(/Committed \d+ weeks? ago/)).toBeDefined();
    rerender(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now() - 3 * 365 * 86_400_000} author={human} />
    );
    expect(screen.queryByText(/ago/)).toBeNull();
    expect(screen.getByText(/^Committed on /)).toBeDefined();
  });

  it("omits the activity line when activity predates the commit", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 60_000}
        author={human}
        lastActivityTimestamp={Date.now() - 3_600_000}
      />
    );
    expect(screen.queryByText(/Last active/)).toBeNull();
  });

  it("gives a bot with no picture a glyph rather than person-like initials", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{
          name: "dependabot[bot]",
          email: "49699333+dependabot[bot]@users.noreply.github.com",
        }}
      />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("DE")).toBeNull();
  });

  it("renders nothing when both timestamps are invalid", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Number.NaN}
        lastActivityTimestamp={Date.now() + 1}
      />
    );
    expect(container.firstChild).toBeNull();
  });
  it("shows the exact commit time as visible text, not only a hover title", () => {
    const committedAt = Date.now() - 3 * 3_600_000;
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={committedAt} author={human} />
    );
    const times = [...container.querySelectorAll("time")];
    const commitTime = times.find(
      (t) => t.getAttribute("dateTime") === new Date(committedAt).toISOString()
    );
    expect(commitTime?.textContent).toBe(exactTimePhrase(committedAt, Date.now()));
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("shows the exact time of later activity beside its relative phrase", () => {
    const activeAt = Date.now() - 120_000;
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 3_600_000}
        author={human}
        lastActivityTimestamp={activeAt}
      />
    );
    const activityTime = [...container.querySelectorAll("time")].find(
      (t) => t.getAttribute("dateTime") === new Date(activeAt).toISOString()
    );
    expect(activityTime?.textContent).toBe(exactTimePhrase(activeAt, Date.now()));
  });

  it("does not truncate a long author name", () => {
    const longName = "Priya Raman-Oyelaran Castellanos-Whitfield";
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 60_000}
        author={{ name: longName, email: "priya@example.com" }}
      />
    );
    expect(screen.getByText(longName).className).not.toContain("truncate");
  });
});

describe("CommitInfoTooltip while open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0).getTime());
  });
  afterEach(() => vi.useRealTimers());

  it("keeps its phrases current instead of freezing when it opened", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 3_600_000}
        author={human}
        lastActivityTimestamp={Date.now() - 20_000}
      />
    );
    expect(screen.getByText(/^Last active just now ·/)).toBeDefined();
    // One act() per minute, so each flip re-arms the next as it does live.
    for (let minute = 0; minute < 3; minute++) {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    }
    expect(screen.getByText(/^Last active 3 minutes ago ·/)).toBeDefined();
  });

  it("wakes exactly when a phrase or the day changes", () => {
    const now = new Date(2025, 5, 15, 23, 10, 17).getTime();
    const cases: number[][] = [
      [now - 20_000],
      [now - 5 * 60_000 - 3_000],
      [now - 2 * 3_600_000 - 9_000, now - 50_000],
      [now - 3 * 86_400_000 - 7_000],
      [now - 40 * 60_000 - 5_000],
    ];
    const view = (ts: number[], at: number) =>
      ts.map((t) => relativeTimePhrase(at - t) + exactTimePhrase(t, at)).join("|");
    for (const ts of cases) {
      const delay = msUntilCardChanges(ts, now);
      expect(delay).toBeGreaterThan(0);
      expect(view(ts, now + delay - 1)).toBe(view(ts, now));
      expect(view(ts, now + delay)).not.toBe(view(ts, now));
    }
  });
});

describe("relativeTimePhrase", () => {
  const DAY = 86_400_000;
  const now = new Date("2025-06-15T12:00:00Z").getTime();
  const phraseAt = (age: number) => relativeTimePhrase(age, now - age);

  it("keeps the count in each unit below the size of the next unit up", () => {
    const limits: Record<string, number> = {
      minute: 60,
      hour: 24,
      day: 7,
      week: 5,
    };
    for (let d = 0; d < 3 * 365; d += 1) {
      const phrase = phraseAt(d * DAY + 1_000);
      const match = /^(\d+) (minute|hour|day|week)s? ago$/.exec(phrase);
      if (!match) continue;
      const limit = limits[match[2]!];
      if (limit !== undefined) expect(Number(match[1])).toBeLessThan(limit);
    }
  });

  it("never goes backwards as the age grows", () => {
    const order = ["just", "minute", "hour", "day", "week"];
    const rank = (p: string) =>
      p.startsWith("on ") ? order.length : order.findIndex((u) => p.includes(u));
    let previous = -1;
    for (let d = 0; d < 3 * 365; d += 3) {
      const r = rank(phraseAt(d * DAY + 5 * 3_600_000));
      expect(r).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });
});

describe("exactTimePhrase", () => {
  const now = new Date("2025-06-15T12:00:00Z").getTime();
  const year = (t: number) => String(new Date(t).getFullYear());

  it("names the year only when it differs from the current one", () => {
    const thisYear = new Date(2025, 2, 3, 9, 14).getTime();
    const lastYear = new Date(2024, 10, 3, 9, 14).getTime();
    expect(exactTimePhrase(thisYear, now)).not.toContain(year(thisYear));
    expect(exactTimePhrase(lastYear, now)).toContain(year(lastYear));
  });

  it("is shorter for today than for an earlier day", () => {
    const today = new Date(now).setHours(9, 14, 0, 0);
    const earlier = today - 3 * 86_400_000;
    expect(exactTimePhrase(today, now).length).toBeLessThan(exactTimePhrase(earlier, now).length);
  });
});
