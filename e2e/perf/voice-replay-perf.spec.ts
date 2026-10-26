/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
/**
 * Perf: dictation replay against the real transcription providers (#14624)
 *
 * Plays each fixture clip as the microphone through the whole pipeline (the
 * toggle chord, getUserMedia on Chromium's fake capture device, the worklet,
 * main, and the provider's real socket) and scores what came back against the
 * clip's reference: normalised WER, project-term recall, whether the first and
 * last words survived, and the session's timings.
 *
 * Costs money and needs keys, so it never runs in CI:
 *
 *   OPENAI_API_KEY=… DEEPGRAM_API_KEY=… npm run perf voice-replay
 *
 * Every session gets a fresh app: the WAV is a launch switch, and a fresh
 * process keeps one arm's connection state out of the next. Results go to
 * .tmp/perf-results/voice-replay/; `npm run perf voice-replay-compare` diffs
 * a run against the saved baseline. scripts/perf/README.md has the knobs.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync, execSync } from "child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import { getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { dismissBlockingPalette } from "../helpers/overlays";
import { ensureWindowFocused } from "../helpers/focus";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { VOICE_TOGGLE_CHORD } from "../helpers/shortcuts";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import {
  launchAppWithFakeMicrophone,
  stubNativeMicrophonePermission,
} from "../helpers/fakeMicrophone";
import { ipcSetSettings } from "../helpers/voice";
import { prepareClip, REPLAY_CLIPS, type PreparedClip } from "../helpers/voiceReplayFixtures";
import {
  providerKeyEnv,
  REPLAY_BASE_SETTINGS,
  resolveReplayConfigs,
  type ReplayConfig,
} from "../helpers/voiceReplayConfig";
import {
  deriveSession,
  installReplayCapture,
  micOpenedAfter,
  readReplayCapture,
  rendererNow,
  sessionIdAfter,
} from "../helpers/voiceReplayCapture";
import {
  contentHash,
  scoreClip,
  summariseConfig,
  VOICE_REPLAY_SCHEMA_VERSION,
  VOICE_REPLAY_SCORING_VERSION,
  type ConfigSummary,
  type VoiceReplayRun,
} from "../helpers/voiceReplayScore";

const OUTPUT_DIR = path.join(process.cwd(), ".tmp", "perf-results", "voice-replay");
const CLIP_CACHE_DIR = path.join(process.cwd(), ".tmp", "voice-replay", "clips");
const LABEL = (process.env.VOICE_REPLAY_LABEL ?? "run").replace(/[^\w.-]+/g, "-");
const REPEATS = Math.max(1, Number.parseInt(process.env.VOICE_REPLAY_REPEATS ?? "1", 10) || 1);
const STOP_TAIL_MS = Math.max(0, Number(process.env.VOICE_REPLAY_STOP_TAIL_MS ?? "0") || 0);
const MIC_OPEN_TIMEOUT_MS = 20_000;
// Past each provider's own drain backstop, so a hung drain shows up as a
// missing `session-ended` rather than as a timeout here.
const SESSION_END_TIMEOUT_MS = 30_000;
// Point either provider at a mock and the "real provider" numbers are the mock's.
const PROVIDER_URL_OVERRIDES = ["DAINTREE_REALTIME_WS_URL", "DAINTREE_DEEPGRAM_WS_URL"];

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Writes through a temp file, so an interrupted run leaves the last whole checkpoint. */
function writeRun(file: string, run: VoiceReplayRun): void {
  const temp = `${file}.partial`;
  writeFileSync(temp, JSON.stringify(run, null, 2) + "\n");
  renameSync(temp, file);
}

async function launchFakeAgent(page: Page): Promise<Locator> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  await expect
    .poll(async () => (await getGridPanelIds(page)).some((id) => !before.has(id)), {
      timeout: T_LONG,
      intervals: [250],
    })
    .toBe(true);
  const panelId = (await getGridPanelIds(page)).find((id) => !before.has(id))!;
  const panel = page.locator(`[data-panel-id="${panelId}"]`);

  // The fake agent asks for trust first unless the folder is already trusted.
  await expect
    .poll(
      async () => {
        const text = (await getTerminalText(panel)).toLowerCase();
        if (text.includes("enter to confirm")) {
          await writeTerminalInput(page, panel, "\r");
          return "confirmed";
        }
        return text.includes("fake_claude_ready") ? "ready" : "waiting";
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .not.toBe("waiting");
  await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);
  // Dictation lands in the composer, which only an agent pane renders.
  await expect
    .poll(() => panel.getAttribute("data-detected-agent-id"), { timeout: 60_000 })
    .toBe("claude");
  await expect(panel.locator(SEL.terminal.cmEditor)).toBeVisible({ timeout: T_LONG });
  return panel;
}

const shouldRun = process.env.RUN_PERF_VOICE_REPLAY === "1" && !process.env.CI;
const perfDescribe = shouldRun ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: dictation replay against real providers", () => {
  test("scores every clip on every configuration", async () => {
    for (const name of PROVIDER_URL_OVERRIDES) {
      if (process.env[name])
        throw new Error(`${name} is set: unset it to benchmark the real provider`);
    }

    const requested = resolveReplayConfigs(process.env, (file) => readFileSync(file, "utf8"));
    const skippedConfigs: VoiceReplayRun["skippedConfigs"] = [];
    const runnable: Array<{ config: ReplayConfig; keyEnv: Record<string, string> }> = [];
    for (const config of requested) {
      const keyEnv = providerKeyEnv(config.provider, process.env);
      if (keyEnv) runnable.push({ config, keyEnv });
      else {
        const variable = config.provider === "openai" ? "OPENAI_API_KEY" : "DEEPGRAM_API_KEY";
        skippedConfigs.push({ id: config.id, reason: `${variable} is not set` });
      }
    }
    for (const skipped of skippedConfigs) {
      console.log(`[voice-replay] skipping ${skipped.id}: ${skipped.reason}`);
    }
    expect(runnable.length, "no configuration has a key to run with").toBeGreaterThan(0);

    const clipFilter = new Set(
      (process.env.VOICE_REPLAY_CLIPS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );
    const unknown = [...clipFilter].filter((id) => !REPLAY_CLIPS.some((clip) => clip.id === id));
    expect(unknown, "VOICE_REPLAY_CLIPS names clips that don't exist").toEqual([]);
    const clips: PreparedClip[] = REPLAY_CLIPS.filter(
      (clip) => clipFilter.size === 0 || clipFilter.has(clip.id)
    ).map((clip) =>
      prepareClip(clip, {
        cacheDir: CLIP_CACHE_DIR,
        recordingsDir: process.env.VOICE_REPLAY_RECORDINGS_DIR,
        voice: process.env.VOICE_REPLAY_VOICE,
      })
    );

    // Launch, onboarding, the agent and the drain take about two minutes at
    // worst; the clip and the tail are on top of that.
    const playbackMs = clips.reduce((sum, clip) => sum + clip.audioMs + STOP_TAIL_MS, 0);
    test.setTimeout(120_000 + runnable.length * REPEATS * (clips.length * 150_000 + playbackMs));

    const fixture = createFixtureRepo({ name: "voice-replay-perf" });
    const fakeBinDir = installFakeAgent(fixture.dir);
    execSync("git add -A && git commit -m voice-replay-fixture", {
      cwd: fixture.dir,
      stdio: "ignore",
    });

    mkdirSync(OUTPUT_DIR, { recursive: true });
    const resultFile = path.join(
      OUTPUT_DIR,
      `${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    const run: VoiceReplayRun = {
      schemaVersion: VOICE_REPLAY_SCHEMA_VERSION,
      scoringVersion: VOICE_REPLAY_SCORING_VERSION,
      label: LABEL,
      createdAt: new Date().toISOString(),
      complete: false,
      gitSha: gitSha(),
      platform: `${process.platform}-${process.arch}`,
      repeats: REPEATS,
      stopTailMs: STOP_TAIL_MS,
      configs: runnable.map(({ config }) => ({
        id: config.id,
        provider: config.provider,
        settings: {
          ...REPLAY_BASE_SETTINGS,
          transcriptionProvider: config.provider,
          ...config.settings,
        },
        dictionary: config.dictionary,
      })),
      skippedConfigs,
      clips: clips.map((prepared) => ({
        id: prepared.clip.id,
        source: prepared.source,
        audioMs: prepared.audioMs,
        longestUtteranceMs: prepared.longestUtteranceMs,
        audioHash: contentHash(readFileSync(prepared.wavPath)),
        referenceHash: contentHash([prepared.clip.reference, ...prepared.clip.terms].join("\n")),
      })),
      sessions: [],
      failures: [],
      summaries: [],
    };

    try {
      // Repeats outermost and configs innermost, so a run cut short still has
      // every arm on the clips it reached.
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (const prepared of clips) {
          for (const { config, keyEnv } of runnable) {
            const tag = `${config.id} · ${prepared.clip.id} · #${repeat + 1}`;
            try {
              const session = await dictateOnce(prepared, config, keyEnv, fixture.dir, fakeBinDir);
              const score = scoreClipFor(session.hypothesis, prepared);
              run.sessions.push({
                clip: prepared.clip.id,
                config: config.id,
                repeat,
                hypothesis: session.hypothesis,
                draft: session.draft,
                score,
                timing: session.timing,
                statuses: session.statuses,
                endReason: session.endReason,
                errors: session.errors,
              });
              console.log(
                `[voice-replay] ${tag}: WER ${(score.wer * 100).toFixed(1)}%, ` +
                  `terms ${score.termsRecalled}/${score.termsTotal}, ` +
                  `first ${score.firstWordKept ? "kept" : "lost"}, last ${score.lastWordKept ? "kept" : "lost"}, ` +
                  `end ${session.endReason ?? "none"}`
              );
            } catch (error) {
              const message = formatErrorMessage(error, "session failed");
              run.failures.push({ clip: prepared.clip.id, config: config.id, repeat, message });
              console.log(`[voice-replay] ${tag}: harness failure: ${message.split("\n")[0]}`);
            }
            run.summaries = run.configs.map((c) => summariseConfig(c.id, run.sessions));
            writeRun(resultFile, run);
          }
        }
      }
      run.complete = true;
      writeRun(resultFile, run);
    } finally {
      fixture.cleanup();
    }

    printSummaries(run.summaries);
    console.log(`[voice-replay] results: ${path.relative(process.cwd(), resultFile)}`);
    expect(
      run.sessions.length,
      "no session dictated; see the harness failures above"
    ).toBeGreaterThan(0);
  });
});

function scoreClipFor(hypothesis: string, prepared: PreparedClip) {
  return scoreClip(prepared.clip.reference, hypothesis, prepared.clip.terms);
}

interface DictatedSession {
  hypothesis: string;
  draft: string | null;
  timing: ReturnType<typeof deriveSession>["timing"];
  statuses: string[];
  endReason: string | null;
  errors: string[];
}

async function dictateOnce(
  prepared: PreparedClip,
  config: ReplayConfig,
  keyEnv: Record<string, string>,
  repoDir: string,
  fakeBinDir: string
): Promise<DictatedSession> {
  let ctx: AppContext | null = null;
  try {
    ctx = await launchAppWithFakeMicrophone({
      wavPath: prepared.wavPath,
      loop: false,
      env: { ...fakeAgentEnv(fakeBinDir), ...keyEnv },
    });
    await stubNativeMicrophonePermission(ctx.app);
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoDir, "Voice Replay");
    const page = ctx.window;

    await ipcSetSettings(page, {
      ...REPLAY_BASE_SETTINGS,
      transcriptionProvider: config.provider,
      ...config.settings,
    });
    for (const term of config.dictionary) {
      await page.evaluate(
        (t) => (window as any).electron.voiceDictionary.add({ term: t, source: "manual" }),
        term
      );
    }

    const panel = await launchFakeAgent(page);
    await installReplayCapture(page);
    await ensureWindowFocused(ctx.app);
    await panel.locator(SEL.terminal.cmEditor).click();

    const startAt = await rendererNow(page);
    await page.keyboard.press(VOICE_TOGGLE_CHORD);

    let micOpenAt: number | null = null;
    await expect
      .poll(
        async () => {
          micOpenAt = micOpenedAfter(await readReplayCapture(page), startAt);
          return micOpenAt !== null;
        },
        { timeout: MIC_OPEN_TIMEOUT_MS, intervals: [20] }
      )
      .toBe(true);

    const sessionEnded = async () => {
      const capture = await readReplayCapture(page);
      const id = sessionIdAfter(capture, startAt);
      return capture.events.some((e) => e.kind === "ended" && e.sessionId === id);
    };

    // The clip starts playing when the device opens; stop when it runs out.
    // A session the provider already ended (a rejected key, a dropped socket)
    // gets no stop press: the chord would start a second session instead.
    const plannedStopAt = micOpenAt! + prepared.audioMs + STOP_TAIL_MS;
    let endedEarly = false;
    for (;;) {
      if (await sessionEnded()) {
        endedEarly = true;
        break;
      }
      const remaining = plannedStopAt - (await rendererNow(page));
      if (remaining <= 0) break;
      await sleep(Math.min(remaining, 250));
    }
    let stopAt: number | null = null;
    if (!endedEarly) {
      stopAt = await rendererNow(page);
      await page.keyboard.press(VOICE_TOGGLE_CHORD);
    }

    await expect
      .poll(sessionEnded, { timeout: SESSION_END_TIMEOUT_MS, intervals: [100] })
      .toBe(true)
      .catch(() => {
        // Scored as it stands: a session that never ended is a result, with
        // `endReason: null` saying so.
      });

    const derived = deriveSession(await readReplayCapture(page), {
      startAt,
      stopAt,
      plannedStopAt,
      audioMs: prepared.audioMs,
    });
    const draft = await panel
      .locator(SEL.terminal.cmEditor)
      .textContent()
      .catch(() => null);
    return {
      hypothesis: derived.hypothesis,
      draft,
      timing: derived.timing,
      statuses: derived.statuses,
      endReason: derived.endReason,
      errors: derived.errors,
    };
  } finally {
    if (ctx?.app) {
      // process() throws once the app has already died; that must not mask
      // the session's own error or skip closeApp's descendant cleanup.
      let pid: number | undefined;
      try {
        pid = ctx.app.process()?.pid;
      } catch {
        pid = undefined;
      }
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
  }
}

function printSummaries(summaries: readonly ConfigSummary[]): void {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const ms = (value: number | null) => (value === null ? "—" : `${Math.round(value)}`);
  console.log(
    "\n| Config | Sessions | Pooled WER | Term recall | First kept | Last kept | Errored | Mic open | First final | Stop→last final | Stop→ended |"
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of summaries) {
    console.log(
      `| ${s.config} | ${s.sessions} | ${pct(s.pooledWer)} | ${pct(s.termRecall)} | ` +
        `${pct(s.firstWordKeptRate)} | ${pct(s.lastWordKeptRate)} | ${s.erroredSessions} | ` +
        `${ms(s.timing.micOpenMs.median)} | ${ms(s.timing.firstFinalMs.median)} | ` +
        `${ms(s.timing.stopToLastFinalMs.median)} | ${ms(s.timing.stopToEndedMs.median)} |`
    );
  }
  console.log(
    "Medians in ms: mic open and first final from the start press, the last two from the stop press.\n"
  );
}
