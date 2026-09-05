/**
 * Mechanism check: direct range-served media playback (#12242).
 *
 * Not part of any CI bucket and not in `playwright.config.ts` — it lives behind
 * `playwright.mechanism.config.ts` so a bare `npx playwright test` can never
 * pick it up. Run it deliberately:
 *
 *   npm run build:e2e
 *   npm run test:e2e:mechanism
 *
 * What it answers, which no unit test can: does Chromium's media loader issue
 * real follow-up byte ranges against a `standard: true` custom scheme? The whole
 * blob detour existed because it appeared not to. Everything here runs against
 * the app's own CSP and session, with real encoded fixtures.
 *
 * WHAT IS ASSERTED VS WHAT IS REPORTED — the distinction matters, because
 * getting it wrong once already produced a spec that would have failed a working
 * implementation. Requests are observed through `webRequest` listeners installed
 * in the main process at test time; the app ships no instrumentation for this.
 * That yields the *requested* `Range` headers exactly, so the range pattern is
 * asserted. It does NOT yield bytes actually transferred: an opening
 * `Range: bytes=0-` is answered with a `Content-Length` of the entire remainder
 * even if Chromium reads a megabyte and cancels. So byte totals are REPORTED as
 * advertised-length upper bounds, never asserted against a threshold — such a
 * threshold would fail precisely when cancellation works best.
 *
 * `onHeadersReceived` is deliberately untouched: the app registers its own CSP
 * overlay there and Electron allows one listener per event per session.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createMediaFixtures, type MediaFixture } from "../helpers/mediaFixtures";

interface MediaRequestRecord {
  id: number;
  url: string;
  /** The `Range` header Chromium actually sent, or null for an unranged GET. */
  requestedRange: string | null;
  status?: number;
  contentRange?: string | null;
  /** `Content-Length` of the response — an upper bound on bytes transferred. */
  advertisedBytes?: number;
}

let ctx: AppContext;
let fixtureRoot: string;
let fixtures: MediaFixture[];
let large: MediaFixture;
let ffmpegVersion: string;
let versions: { electron: string; chrome: string; platform: string };

let tokenSeq = 0;
/**
 * Every case gets its own token in the query string. The listener outlives each
 * test, and a late response start from a torn-down element would otherwise land
 * in the next case's tally — the two large-file cases reuse the same file, so
 * filtering on the path alone would not separate them.
 */
function nextToken(): string {
  tokenSeq += 1;
  return `t${tokenSeq}`;
}

function mediaUrl(fixture: MediaFixture, token: string): string {
  return (
    `daintree-media://load/?path=${encodeURIComponent(fixture.filePath)}` +
    `&root=${encodeURIComponent(fixtureRoot)}&t=${token}`
  );
}

/** Install the request recorder once; it accumulates for the whole run. */
async function installRecorder(): Promise<void> {
  await ctx.app.evaluate(({ session }) => {
    const g = globalThis as unknown as {
      __mediaRequests?: MediaRequestRecord[];
      __mediaArmed?: boolean;
    };
    g.__mediaRequests ??= [];
    if (g.__mediaArmed) return;
    g.__mediaArmed = true;

    const header = (headers: Record<string, string | string[]> | undefined, name: string) => {
      if (!headers) return null;
      const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
      if (!key) return null;
      const value = headers[key];
      return (Array.isArray(value) ? value[0] : value) ?? null;
    };

    // `<all_urls>` plus an explicit prefix test rather than a
    // `daintree-media://*/*` pattern: Chromium's match-pattern parser is built
    // around the schemes it knows, and the app's own CSP overlay already
    // demonstrates that `<all_urls>` reaches custom-scheme responses.
    const sessions = [session.defaultSession, session.fromPartition("persist:daintree")];
    for (const ses of new Set(sessions)) {
      ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        if (details.url.startsWith("daintree-media://")) {
          (g.__mediaRequests ??= []).push({
            id: details.id,
            url: details.url,
            requestedRange: header(details.requestHeaders, "range"),
          });
        }
        // Blocking listener: the request stalls unless this always runs.
        callback({});
      });
      ses.webRequest.onResponseStarted({ urls: ["<all_urls>"] }, (details) => {
        if (!details.url.startsWith("daintree-media://")) return;
        const record = (g.__mediaRequests ??= []).find((r) => r.id === details.id);
        if (!record) return;
        record.status = details.statusCode;
        record.contentRange = header(details.responseHeaders, "content-range");
        const length = header(details.responseHeaders, "content-length");
        record.advertisedBytes = length === null ? undefined : Number(length);
      });
    }
  });
}

/** Everything recorded for one case, identified by its token. */
async function requestsFor(token: string): Promise<MediaRequestRecord[]> {
  return ctx.app.evaluate((t) => {
    const g = globalThis as unknown as { __mediaRequests?: MediaRequestRecord[] };
    return (g.__mediaRequests ?? []).filter((r) => r.url.includes(`t=${t}`));
  }, token);
}

/** Start offset of a `Range: bytes=<start>-…` header, or null. */
function rangeStart(range: string | null | undefined): number | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-/.exec(range.trim());
  if (!match || match[1] === "") return null;
  return Number(match[1]);
}

function advertisedTotal(records: MediaRequestRecord[]): number {
  return records.reduce((sum, r) => sum + (r.advertisedBytes ?? 0), 0);
}

type FirstFrame = { timeToFirstFrameMs: number; duration: number; playing: boolean };

/**
 * Mount a real media element in the app document and drive it to first frame.
 *
 * Resolves to an `{ error }` shape rather than throwing, so a failing container
 * is reported as that container failing — the issue asks for the failing case by
 * name if this does not work, not for an undiagnosed timeout.
 */
async function playToFirstFrame(
  url: string,
  tag: "video" | "audio"
): Promise<FirstFrame | { error: string }> {
  return ctx.window.evaluate(
    ([src, kind]) =>
      new Promise<FirstFrame | { error: string }>((resolve) => {
        const started = performance.now();
        const el = document.createElement(kind as "video" | "audio");
        el.id = "mechanism-media";
        el.preload = "metadata";
        el.muted = true;
        el.style.position = "fixed";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";

        let timer = 0;
        let playRejection: string | null = null;
        const done = (value: FirstFrame | { error: string }) => {
          window.clearTimeout(timer);
          resolve(value);
        };
        el.addEventListener("loadeddata", () =>
          done({
            timeToFirstFrameMs: performance.now() - started,
            duration: el.duration,
            // `loadeddata` can fire on a still-paused element, so whether
            // playback actually started is reported rather than assumed.
            playing: !el.paused && playRejection === null,
          })
        );
        el.addEventListener("error", () =>
          done({ error: el.error ? `code ${el.error.code}: ${el.error.message}` : "unknown" })
        );
        timer = window.setTimeout(
          () =>
            done({
              error: playRejection
                ? `timed out before loadeddata; play() rejected: ${playRejection}`
                : "timed out before loadeddata",
            }),
          30_000
        );
        el.src = src as string;
        document.body.appendChild(el);
        // A rejected play() is recorded, not swallowed — autoplay policy is a
        // plausible reason for a confusing result and should be visible.
        // `String(err)` rather than the shared formatErrorMessage helper: this
        // closure is serialized and evaluated in the renderer, so it cannot
        // reference an import. A DOMException stringifies to "Name: message".
        void el.play().catch((err: unknown) => {
          playRejection = String(err);
        });
      }),
    [url, tag] as const
  );
}

/** Seek the mounted element and report where it actually landed. */
async function seekTo(
  fraction: number
): Promise<{ currentTime: number; target: number } | { error: string }> {
  return ctx.window.evaluate(
    (f) =>
      new Promise<{ currentTime: number; target: number } | { error: string }>((resolve) => {
        const el = document.getElementById("mechanism-media") as HTMLMediaElement | null;
        if (!el) return resolve({ error: "element gone" });
        if (!Number.isFinite(el.duration)) return resolve({ error: "duration not known" });
        const target = el.duration * f;
        let timer = 0;
        const done = (v: { currentTime: number; target: number } | { error: string }) => {
          window.clearTimeout(timer);
          resolve(v);
        };
        // Listener before the assignment: a seek that completed synchronously
        // would otherwise resolve before anything was listening.
        el.addEventListener("seeked", () => done({ currentTime: el.currentTime, target }), {
          once: true,
        });
        el.addEventListener("error", () => done({ error: "element errored during seek" }), {
          once: true,
        });
        timer = window.setTimeout(() => done({ error: "timed out before seeked" }), 30_000);
        el.currentTime = target;
      }),
    fraction
  );
}

async function teardownElement(): Promise<void> {
  await ctx.window.evaluate(() => {
    const el = document.getElementById("mechanism-media") as HTMLMediaElement | null;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.remove();
  });
}

test.describe.serial("Mechanism: direct range-served media (#12242)", () => {
  test.beforeAll(async () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "daintree-media-mechanism-"));
    const generated = createMediaFixtures(fixtureRoot, {
      largeTargetBytes: Number(process.env.DAINTREE_MECHANISM_LARGE_BYTES ?? 600 * 1024 * 1024),
    });
    fixtures = generated.fixtures;
    large = generated.large;
    ffmpegVersion = generated.ffmpegVersion;

    ctx = await launchApp();
    versions = await ctx.app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: `${process.platform}/${process.arch}`,
    }));
    await installRecorder();

    // The premise is version-specific; record it rather than let a result be
    // quoted against the wrong build.
    console.log(
      `[mechanism] Electron ${versions.electron} / Chromium ${versions.chrome} on ${versions.platform}`
    );
    console.log(`[mechanism] fixtures via ${ffmpegVersion}`);
    for (const f of [...fixtures, large]) {
      console.log(
        `[mechanism] fixture ${f.name}: ${f.size} bytes${f.moov ? ` (moov ${f.moov})` : ""}`
      );
    }
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app);
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("a large trailing-moov mp4 plays and issues a follow-up range", async () => {
    // The decisive case, and it has to be the LARGE fixture. A three-second clip
    // fits in one response, so Chromium could satisfy a trailing index and every
    // seek from its buffer without ever issuing a second request — and a working
    // implementation would then fail this test for the wrong reason.
    expect(large.moov, "the fixture must really have a trailing moov").toBe("trailing");
    const token = nextToken();

    const first = await playToFirstFrame(mediaUrl(large, token), "video");
    expect(
      first,
      `large trailing-moov mp4 failed on Electron ${versions.electron}`
    ).not.toHaveProperty("error");

    // Seek far outside anything buffered at startup, forcing a real range.
    const seek = await seekTo(0.95);
    expect(seek, "seek to 95%").not.toHaveProperty("error");
    if ("currentTime" in seek) {
      expect(Math.abs(seek.currentTime - seek.target)).toBeLessThanOrEqual(1);
    }

    const records = await requestsFor(token);
    console.log(
      `[mechanism] large trailing-moov: ${records.length} requests — ` +
        records.map((r) => `${r.requestedRange ?? "no-range"}→${r.status ?? "?"}`).join(", ")
    );

    // More than one request for the same resource, at least one at a non-zero
    // offset, IS the disproof of the single-shot behaviour the blob detour was
    // built around. Asserted on the requested Range headers, which are observed
    // exactly — unlike transferred bytes.
    expect(records.length, "no daintree-media requests recorded").toBeGreaterThan(1);
    const offsets = records
      .map((r) => rangeStart(r.requestedRange))
      .filter((n): n is number => n !== null);
    expect(
      offsets.some((n) => n > 0),
      `no follow-up range at a non-zero offset: ${JSON.stringify(records.map((r) => r.requestedRange))}`
    ).toBe(true);
    expect(records.every((r) => r.status === undefined || r.status < 400)).toBe(true);

    await teardownElement();
  });

  for (const name of ["trailing-moov mp4", "leading-moov mp4", "webm", "m4a", "mp3"]) {
    test(`${name} reaches loadeddata, seeks to 95% and seeks backwards`, async () => {
      const fixture = fixtures.find((f) => f.name === name)!;
      const token = nextToken();

      const first = await playToFirstFrame(mediaUrl(fixture, token), fixture.kind);
      expect(first, `${name} failed on Electron ${versions.electron}`).not.toHaveProperty("error");

      const forward = await seekTo(0.95);
      expect(forward, `${name} forward seek`).not.toHaveProperty("error");
      if ("currentTime" in forward) {
        expect(Math.abs(forward.currentTime - forward.target)).toBeLessThanOrEqual(1);
      }

      const backward = await seekTo(0.1);
      expect(backward, `${name} backward seek`).not.toHaveProperty("error");
      if ("currentTime" in backward) {
        expect(Math.abs(backward.currentTime - backward.target)).toBeLessThanOrEqual(1);
      }

      const records = await requestsFor(token);
      console.log(
        `[mechanism] ${name}: ${fixture.size} bytes, ${records.length} requests, ` +
          `first frame ${"timeToFirstFrameMs" in first ? first.timeToFirstFrameMs.toFixed(0) : "?"}ms`
      );

      await teardownElement();
    });
  }

  test("reports startup cost for a large recording", async () => {
    // The headline number for the PR table. Reported, not gated: an opening
    // `bytes=0-` is answered with the whole remaining length regardless of how
    // little Chromium consumes, so no threshold on this figure would mean what
    // it appears to mean. The assertion here is the honest one — a large file
    // reaches its first frame promptly, which the blob path could not do.
    const token = nextToken();
    const first = await playToFirstFrame(mediaUrl(large, token), "video");
    expect(first).not.toHaveProperty("error");

    const records = await requestsFor(token);
    const advertised = advertisedTotal(records);
    console.log(
      `[mechanism] startup: file ${large.size} bytes; ` +
        `${records.length} requests; advertised ${advertised} bytes ` +
        `(${((advertised / large.size) * 100).toFixed(2)}% — UPPER BOUND, not bytes transferred); ` +
        `first frame ${"timeToFirstFrameMs" in first ? first.timeToFirstFrameMs.toFixed(0) : "?"}ms; ` +
        `playing=${"playing" in first ? first.playing : "?"}`
    );

    expect(records.length, "no daintree-media requests recorded").toBeGreaterThan(0);
    if ("timeToFirstFrameMs" in first) {
      // The blob path had to read the entire file first; anything in this range
      // is categorically different behaviour, without over-claiming a target.
      expect(first.timeToFirstFrameMs).toBeLessThan(10_000);
    }

    await teardownElement();
  });

  test("reports what a preview closed after two seconds costs", async () => {
    const token = nextToken();
    const first = await playToFirstFrame(mediaUrl(large, token), "video");
    expect(first).not.toHaveProperty("error");

    await ctx.window.waitForTimeout(2000);
    await teardownElement();
    // Let any cancelled request settle before reading the tally.
    await ctx.window.waitForTimeout(500);

    const records = await requestsFor(token);
    const advertised = advertisedTotal(records);
    console.log(
      `[mechanism] quick close: file ${large.size} bytes; ${records.length} requests; ` +
        `advertised ${advertised} bytes (${((advertised / large.size) * 100).toFixed(2)}% — ` +
        `UPPER BOUND; cancellation is not observable through response starts)`
    );

    expect(records.length, "no daintree-media requests recorded").toBeGreaterThan(0);
  });

  test("two previews reach loadeddata at once without disturbing each other", async () => {
    const a = fixtures.find((f) => f.name === "leading-moov mp4")!;
    const b = fixtures.find((f) => f.name === "webm")!;
    const token = nextToken();

    const result = await ctx.window.evaluate(
      ([urlA, urlB]) =>
        new Promise<{ ready: number; errored: number }>((resolve) => {
          let ready = 0;
          let errored = 0;
          let timer = 0;
          const settle = () => {
            if (ready + errored === 2) {
              window.clearTimeout(timer);
              resolve({ ready, errored });
            }
          };
          for (const src of [urlA, urlB]) {
            const el = document.createElement("video");
            el.className = "mechanism-pair";
            el.preload = "metadata";
            el.muted = true;
            el.style.position = "fixed";
            el.style.opacity = "0";
            el.addEventListener("loadeddata", () => {
              ready += 1;
              settle();
            });
            el.addEventListener("error", () => {
              errored += 1;
              settle();
            });
            el.src = src;
            document.body.appendChild(el);
            void el.play().catch(() => {});
          }
          timer = window.setTimeout(() => resolve({ ready, errored }), 30_000);
        }),
      [mediaUrl(a, token), mediaUrl(b, token)] as const
    );

    expect(result).toEqual({ ready: 2, errored: 0 });

    await ctx.window.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll("video.mechanism-pair"))) {
        const media = el as HTMLVideoElement;
        media.pause();
        media.removeAttribute("src");
        media.load();
        media.remove();
      }
    });
  });
});
