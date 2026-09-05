/**
 * Mechanism check: direct range-streamed media playback (#12242).
 *
 * Not part of any CI bucket and not in `playwright.config.ts` — it lives behind
 * `playwright.mechanism.config.ts` so a bare `npx playwright test` can never
 * pick it up. Run it deliberately:
 *
 *   npm run build:e2e
 *   npm run test:e2e:mechanism
 *
 * What it answers, which no unit test can: does Chromium's media loader issue
 * real follow-up byte ranges against a `standard: true` custom scheme? The
 * whole blob detour existed because it appeared not to. Everything here is
 * measured against the app's own CSP and session, with real encoded fixtures.
 *
 * Byte counts come from `webRequest` listeners installed in the main process at
 * test time — the app ships no instrumentation for this. `onHeadersReceived` is
 * deliberately not used: the app registers its own CSP overlay there and
 * Electron allows one listener per event, so taking it would disable that
 * overlay mid-test.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createMediaFixtures, type MediaFixture } from "../helpers/mediaFixtures";

interface RangeRecord {
  url: string;
  range: string | null;
  bytes: number;
  at: number;
}

let ctx: AppContext;
let fixtureRoot: string;
let fixtures: MediaFixture[];
let large: MediaFixture;
let ffmpegVersion: string;
let versions: { electron: string; chrome: string; platform: string };

function mediaUrl(fixture: MediaFixture): string {
  return `daintree-media://load/?path=${encodeURIComponent(fixture.filePath)}&root=${encodeURIComponent(fixtureRoot)}`;
}

/** Arm the main-process recorder, clearing anything a previous case left. */
async function armRecorder(): Promise<void> {
  await ctx.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __mediaRanges?: RangeRecord[]; __mediaArmed?: boolean };
    g.__mediaRanges = [];
    if (g.__mediaArmed) return;
    g.__mediaArmed = true;
    const sessions = [session.defaultSession, session.fromPartition("persist:daintree")];
    for (const ses of new Set(sessions)) {
      // `<all_urls>` plus an explicit prefix test rather than a
      // `daintree-media://*/*` pattern: Chromium's match-pattern parser is
      // built around the schemes it knows, and the app's own CSP overlay
      // already demonstrates that `<all_urls>` reaches custom-scheme responses.
      ses.webRequest.onResponseStarted({ urls: ["<all_urls>"] }, (details) => {
        if (!details.url.startsWith("daintree-media://")) return;
        const headers = details.responseHeaders ?? {};
        const key = Object.keys(headers).find((h) => h.toLowerCase() === "content-length");
        const raw = key ? headers[key] : undefined;
        const value = Array.isArray(raw) ? raw[0] : raw;
        (g.__mediaRanges ??= []).push({
          url: details.url,
          // The request's own Range header is not exposed here; Content-Range
          // on the response carries the same fact and is enough to tell a
          // follow-up range from an opening read.
          range: (() => {
            const k = Object.keys(headers).find((h) => h.toLowerCase() === "content-range");
            const v = k ? headers[k] : undefined;
            return (Array.isArray(v) ? v[0] : v) ?? null;
          })(),
          bytes: Number(value ?? 0),
          at: Date.now(),
        });
      });
    }
  });
}

async function readRanges(): Promise<RangeRecord[]> {
  return ctx.app.evaluate(() => {
    const g = globalThis as unknown as { __mediaRanges?: RangeRecord[] };
    return g.__mediaRanges ?? [];
  });
}

/**
 * Mount a real media element in the app document and drive it to first frame.
 *
 * Returns null when the element errors, so a failing shape is reported as a
 * failing shape rather than a timeout with no diagnosis — the issue asks for
 * the failing case by name if this doesn't work.
 */
async function playToFirstFrame(
  url: string,
  tag: "video" | "audio"
): Promise<{ timeToFirstFrameMs: number; duration: number } | { error: string }> {
  return ctx.window.evaluate(
    ([src, kind]) =>
      new Promise<{ timeToFirstFrameMs: number; duration: number } | { error: string }>(
        (resolve) => {
          const started = performance.now();
          const el = document.createElement(kind as "video" | "audio");
          el.id = "mechanism-media";
          el.preload = "metadata";
          el.muted = true;
          el.style.position = "fixed";
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
          const done = (
            value: { timeToFirstFrameMs: number; duration: number } | { error: string }
          ) => {
            resolve(value);
          };
          el.addEventListener("loadeddata", () =>
            done({ timeToFirstFrameMs: performance.now() - started, duration: el.duration })
          );
          el.addEventListener("error", () =>
            done({ error: el.error ? `code ${el.error.code}: ${el.error.message}` : "unknown" })
          );
          setTimeout(() => done({ error: "timed out before loadeddata" }), 30_000);
          el.src = src as string;
          document.body.appendChild(el);
          void el.play().catch(() => {});
        }
      ),
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
        // Listener before the assignment: a seek that completes synchronously
        // would otherwise resolve before anything was listening.
        el.addEventListener("seeked", () => resolve({ currentTime: el.currentTime, target }), {
          once: true,
        });
        el.addEventListener("error", () => resolve({ error: "element errored during seek" }), {
          once: true,
        });
        setTimeout(() => resolve({ error: "timed out before seeked" }), 30_000);
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

test.describe.serial("Mechanism: direct range-streamed media (#12242)", () => {
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
    await armRecorder();

    // The premise of the whole experiment is version-specific; record it rather
    // than let a result be quoted against the wrong build.
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

  test("the trailing-moov mp4 that motivated the blob detour plays and seeks", async () => {
    // The decisive case. Its index sits at EOF, so it cannot reach a first
    // frame without the loader fetching the end and then coming back — the
    // follow-up range a non-standard scheme never issued.
    const fixture = fixtures.find((f) => f.name === "trailing-moov mp4")!;
    expect(fixture.moov, "fixture must actually have a trailing moov to prove anything").toBe(
      "trailing"
    );

    await armRecorder();
    const first = await playToFirstFrame(mediaUrl(fixture), "video");
    expect(first, `trailing-moov mp4 failed on Electron ${versions.electron}`).not.toHaveProperty(
      "error"
    );

    const seek = await seekTo(0.95);
    expect(seek).not.toHaveProperty("error");
    if ("currentTime" in seek) {
      expect(Math.abs(seek.currentTime - seek.target)).toBeLessThanOrEqual(1);
    }

    const ranges = await readRanges();
    // More than one response for the same resource IS the disproof of the
    // single-shot behaviour the blob detour was built around.
    expect(ranges.length).toBeGreaterThan(1);
    console.log(`[mechanism] trailing-moov mp4: ${ranges.length} responses`);
    await teardownElement();
  });

  for (const name of ["leading-moov mp4", "webm", "m4a", "mp3"]) {
    test(`${name} plays, seeks to 95% and seeks backwards`, async () => {
      const fixture = fixtures.find((f) => f.name === name)!;
      await armRecorder();

      const first = await playToFirstFrame(mediaUrl(fixture), fixture.kind);
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

      await teardownElement();
    });
  }

  test("a large recording reaches its first frame on a fraction of the file", async () => {
    // The headline claim. The blob path read every byte of this file before
    // showing anything; this asserts the streamed path does not.
    await armRecorder();
    const first = await playToFirstFrame(mediaUrl(large), "video");
    expect(first).not.toHaveProperty("error");

    const atFirstFrame = await readRanges();
    const bytesBeforeFirstFrame = atFirstFrame.reduce((sum, r) => sum + r.bytes, 0);

    console.log(
      `[mechanism] large fixture: ${large.size} bytes on disk, ` +
        `${bytesBeforeFirstFrame} bytes served before first frame ` +
        `(${((bytesBeforeFirstFrame / large.size) * 100).toFixed(2)}%), ` +
        `${"timeToFirstFrameMs" in first ? first.timeToFirstFrameMs.toFixed(0) : "?"}ms, ` +
        `${atFirstFrame.length} responses`
    );

    // Content-Length counts what the handler offered, not what Chromium
    // consumed before cancelling, so this is an upper bound — which is the
    // conservative direction for the claim being made.
    expect(bytesBeforeFirstFrame).toBeLessThan(large.size / 2);
    await teardownElement();
  });

  test("closing a preview after two seconds abandons the rest of the file", async () => {
    await armRecorder();
    const first = await playToFirstFrame(mediaUrl(large), "video");
    expect(first).not.toHaveProperty("error");

    await ctx.window.waitForTimeout(2000);
    await teardownElement();
    // Let any cancelled range settle before reading the tally.
    await ctx.window.waitForTimeout(500);

    const ranges = await readRanges();
    const bytesOnClose = ranges.reduce((sum, r) => sum + r.bytes, 0);
    console.log(
      `[mechanism] quick close: ${bytesOnClose} bytes served of ${large.size} ` +
        `(${((bytesOnClose / large.size) * 100).toFixed(2)}%)`
    );
    expect(bytesOnClose).toBeLessThan(large.size);
  });

  test("two previews play at once without disturbing each other", async () => {
    const a = fixtures.find((f) => f.name === "leading-moov mp4")!;
    const b = fixtures.find((f) => f.name === "webm")!;
    await armRecorder();

    const result = await ctx.window.evaluate(
      ([urlA, urlB]) =>
        new Promise<{ ready: number; errored: number }>((resolve) => {
          let ready = 0;
          let errored = 0;
          const settle = () => {
            if (ready + errored === 2) resolve({ ready, errored });
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
          setTimeout(() => resolve({ ready, errored }), 30_000);
        }),
      [mediaUrl(a), mediaUrl(b)] as const
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
