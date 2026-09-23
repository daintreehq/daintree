// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  LiveRateLimitCountdown,
  RateLimitDetailsPanel,
  bucketLabel,
  formatRateLimitCountdown,
  formatRateLimitCountdownCoarse,
} from "../RateLimitDetails";
import type { RateLimitBucket } from "@shared/types/forge";

const NOW = 1_800_000_000_000;
const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;

const SAMPLES = [
  1,
  999,
  5 * second,
  59 * second,
  59 * second + 1,
  minute,
  minute + second,
  10 * minute,
  59 * minute + 59 * second,
  hour - 1,
  hour,
  hour + second,
  2 * hour + 5 * minute + 30 * second,
  25 * hour,
];

function bucket(name: string, limit: number, remaining: number, resetInMs: number) {
  return { name, limit, remaining, used: limit - remaining, resetAt: NOW + resetInMs };
}

function panel(props: Partial<Parameters<typeof RateLimitDetailsPanel>[0]> = {}) {
  return render(
    <RateLimitDetailsPanel
      providerName="GitHub"
      kind="primary"
      details={undefined}
      now={NOW}
      fallbackResetAt={NOW + 14 * minute}
      {...props}
    />
  );
}

afterEach(cleanup);

describe("formatRateLimitCountdown", () => {
  it("keeps every unit after the first at two digits", () => {
    for (const ms of SAMPLES) {
      const units = formatRateLimitCountdown(ms).split(" ");
      for (const unit of units.slice(1)) {
        expect(unit, `${ms}ms → ${formatRateLimitCountdown(ms)}`).toMatch(/^\d{2}[a-z]$/);
      }
    }
  });

  it("never shows a larger unit than the time left needs", () => {
    for (const ms of SAMPLES) {
      const label = formatRateLimitCountdown(ms);
      // Rounded up to the whole second, like the label itself.
      const seconds = Math.ceil(ms / second);
      if (seconds < 60) expect(label).toMatch(/^\d+s$/);
      else if (seconds < 3_600) expect(label).toMatch(/^\d+m \d{2}s$/);
      else expect(label).toMatch(/^\d+h \d{2}m$/);
    }
  });
});

describe("formatRateLimitCountdownCoarse", () => {
  it("never promises an earlier resume than the time left", () => {
    for (const ms of SAMPLES.filter((s) => s >= minute)) {
      const label = formatRateLimitCountdownCoarse(ms);
      const [, h, m] = /^(?:(\d+)h)? ?(?:(\d+)m)?$/.exec(label) ?? [];
      const shownMs = Number(h ?? 0) * hour + Number(m ?? 0) * minute;
      expect(shownMs, `${ms}ms → ${label}`).toBeGreaterThanOrEqual(ms);
    }
  });

  it("carries no seconds, since it only re-renders twice a minute", () => {
    for (const ms of SAMPLES) expect(formatRateLimitCountdownCoarse(ms)).not.toMatch(/\ds/);
  });
});

describe("LiveRateLimitCountdown", () => {
  function phrase(resetAt: number) {
    const { container } = render(
      <p>
        Resumes <LiveRateLimitCountdown resetAt={resetAt} />
      </p>
    );
    return container.querySelector("p")!;
  }

  it("completes 'Resumes …' grammatically before and after the deadline", () => {
    for (const offset of [-5 * second, 30 * second, 14 * minute, 2 * hour]) {
      const p = phrase(Date.now() + offset);
      const visible = Array.from(p.childNodes)
        .map((n) =>
          n instanceof HTMLElement && n.classList.contains("sr-only") ? "" : n.textContent
        )
        .join("")
        .trim();
      expect(visible).toMatch(/^Resumes (in \S.*|shortly)$/);
      cleanup();
    }
  });

  it("hides the ticking text from assistive tech while it counts down", () => {
    const p = phrase(Date.now() + 14 * minute);
    const ticking = Array.from(p.querySelectorAll("span")).find((s) =>
      s.textContent?.startsWith("in ")
    );
    expect(ticking?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("RateLimitDetailsPanel", () => {
  it("shows the governing resume time even when bucket details are present", () => {
    const { container } = panel({
      kind: "secondary",
      fallbackResetAt: NOW + 47 * second,
      details: {
        buckets: [bucket("core", 5_000, 3_904, 27 * minute)],
        fetchedAt: NOW,
      },
    });
    expect(container.textContent).toContain(formatRateLimitCountdown(47 * second));
  });

  it("tells a finished read with no details apart from one still in flight", () => {
    const answered = panel({ details: null }).container.textContent;
    cleanup();
    const pending = panel({ details: undefined }).container.textContent;
    expect(answered).not.toEqual(pending);
    expect(answered).not.toMatch(/loading|checking/i);
  });

  it("marks a spent bucket in text, not only colour", () => {
    // Same reset time, so the only differences left once names and numbers are
    // stripped are the words the row uses to say it is spent.
    const spent = bucket("core", 5_000, 0, 14 * minute);
    const nearlySpent = bucket("graphql", 5_000, 7, 14 * minute);
    const { container } = panel({ details: { buckets: [spent, nearlySpent], fetchedAt: NOW } });
    const rows = Array.from(container.querySelectorAll('[role="meter"]')).map(
      (m) => m.parentElement!
    );
    expect(rows).toHaveLength(2);
    const words = (row: Element, name: string) =>
      row.textContent!.replace(bucketLabel(name), "").replace(/[\d,.\s\u00a0\u202f]/g, "");
    expect(words(rows[0]!, "core")).not.toEqual(words(rows[1]!, "graphql"));
  });

  it("exposes each bucket as a meter with its bounds and a readable value", () => {
    const b: RateLimitBucket = bucket("graphql", 5_000, 4_212, 38 * minute);
    const { container } = panel({ details: { buckets: [b], fetchedAt: NOW } });
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe(String(b.limit));
    expect(meter.getAttribute("aria-valuenow")).toBe(String(b.used));
    expect(meter.getAttribute("aria-valuetext")).toContain((4_212).toLocaleString());
  });

  it("names the provider in the heading", () => {
    const { container } = panel({ providerName: "GitLab" });
    expect(container.textContent).toContain("GitLab");
  });
});

describe("bucketLabel", () => {
  it("spells known API acronyms in capitals", () => {
    for (const name of ["rest", "core", "graphql"]) {
      expect(bucketLabel(name)).toMatch(/REST|GraphQL/);
    }
  });
});
