/**
 * E2E: Voice Input — no words lost at the start or the stop
 *
 * A WAV is the microphone, the real key starts and stops dictation, and the shared mock
 * records every audio byte the provider sends. A tap on the capture worklet's port records
 * every chunk the microphone produced, so each run checks that the provider received all of
 * them, from the first non-silent chunk through the chunk the stop flushed. Each run also
 * prints key press to first audio appended and stop to final text.
 */
import { test, expect, type Locator } from "@playwright/test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
} from "../../helpers/launch";
import type { AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import { VOICE_TOGGLE_CHORD } from "../../helpers/shortcuts";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import {
  createTranscriptionMock,
  type MockConnection,
  type TranscriptionMock,
  type TranscriptionProviderId,
} from "../../helpers/transcriptionMock";
import { fakeAgentEnv, installFakeAgent } from "../../helpers/fakeAgent";
import {
  launchAppWithFakeMicrophone,
  stubNativeMicrophonePermission,
  writeWav,
} from "../../helpers/fakeMicrophone";
import {
  clearCapturedEvents,
  focusDictationTarget,
  getCapturedEvents,
  installEventCapture,
  ipcSetSettings,
  openDictationTarget,
  seedVoiceConfig,
} from "../../helpers/voice";
import {
  glidingVoice,
  installCaptureTap,
  measureCoverage,
  readCaptureTap,
  resetCaptureTap,
  signalChunksTapped,
  type CaptureTapSnapshot,
} from "../../helpers/voiceCoverage";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";

// About 1.2s of speech: long enough to span many chunks, short like a push-to-talk phrase.
const SPEECH_CHUNKS = 12;
const TRANSCRIPT = "every word arrives";

const chordKeys = VOICE_TOGGLE_CHORD.split("+");
const TRIGGER_KEY = chordKeys.at(-1)!;
const MODIFIER_KEYS = chordKeys.slice(0, -1);

test.describe.serial("E2E: Voice Input — no words lost at start and stop", () => {
  let ctx: AppContext;
  let mock: TranscriptionMock;
  let userDataDir: string;
  let workDir: string;
  let fixtureCleanup: (() => void) | undefined;
  let binDir: string;
  let agent: Locator;

  test.beforeAll(async () => {
    mock = await createTranscriptionMock();
    workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-words-"));
    const wavPath = writeWav(workDir, "voice.wav", { seconds: 6, waveform: glidingVoice });
    binDir = installFakeAgent(workDir);

    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-words-ud-"));
    const first = await launchApp({ userDataDir });
    const pid = first.app.process().pid!;
    await closeApp(first.app);
    await waitForProcessExit(pid);

    seedVoiceConfig(userDataDir, {
      enabled: true,
      openaiApiKey: "sk-e2e-test-key-not-real",
      deepgramApiKey: "dg-e2e-test-key-not-real",
      language: "en",
      dictionary: [],
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-6-luna",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
      recordingMode: "toggle",
    });
    removeSingletonFiles(userDataDir);

    ctx = await launchAppWithFakeMicrophone({
      userDataDir,
      env: { ...mock.env(), ...fakeAgentEnv(binDir) },
      wavPath,
    });
    await stubNativeMicrophonePermission(ctx.app);
    const fixture = createFixtureRepo({ name: "voice-word-coverage" });
    fixtureCleanup = fixture.cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
    agent = await openDictationTarget(ctx.window, binDir);
    await installEventCapture(ctx.window);
    await installCaptureTap(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
    await mock?.close();
    fixtureCleanup?.();
    removePathSync(userDataDir);
    removePathSync(workDir);
  });

  test.beforeEach(async () => {
    mock.reset();
    await clearCapturedEvents(ctx.window);
    await resetCaptureTap(ctx.window);
    await ensureWindowFocused(ctx.app);
    await focusDictationTarget(agent);
  });

  /** Settings written over IPC reach the service through the event the settings page fires. */
  async function setVoiceSettings(patch: Record<string, unknown>): Promise<void> {
    await ipcSetSettings(ctx.window, patch);
    await ctx.window.evaluate(async (eventName) => {
      window.dispatchEvent(new Event(eventName));
      // The service's refresh reads the settings over the same IPC, and replies arrive in
      // order, so once this read returns the service has applied what it read.
      await window.electron.voiceInput.getSettings();
    }, VOICE_INPUT_SETTINGS_CHANGED_EVENT);
  }

  async function waitForSpeech(): Promise<void> {
    await expect
      .poll(() => signalChunksTapped(ctx.window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(SPEECH_CHUNKS);
  }

  async function waitForTranscript(): Promise<void> {
    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toContain(TRANSCRIPT);
  }

  /**
   * Every chunk the session's worklet delivered, from the first non-silent one through the
   * one its stop flushed, has to reach the provider: nothing lost at either end or between.
   */
  async function expectEveryWordKept(
    label: string,
    provider: TranscriptionProviderId,
    keys: { start: CaptureTapSnapshot["keys"][number]; stop: CaptureTapSnapshot["keys"][number] }
  ): Promise<void> {
    const tap = await readCaptureTap(ctx.window);
    expect(tap.nodes, "one capture graph per dictation").toHaveLength(1);
    const [node] = tap.nodes;
    expect(node.flushedAt, "the stop flushed the worklet").not.toBeNull();

    const received = mock.audio.filter((a) => a.provider === provider);
    const coverage = measureCoverage(
      node.chunks.map((c) => c.bytes),
      received.map((a) => a.bytes)
    );
    const finalText = tap.completes.find((c) => c.text === TRANSCRIPT && c.t >= keys.stop.t);
    const timings = {
      keyToFirstAudioMs: received.length ? received[0].t - keys.start.t : null,
      stopToFinalTextMs: finalText ? finalText.t - keys.stop.t : null,
    };
    const report = { ...timings, ...coverage };
    console.log(`[voice-words] ${label}: ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: "voice-words", description: JSON.stringify(report) });

    expect(coverage.capturedChunks).toBeGreaterThanOrEqual(SPEECH_CHUNKS);
    expect(coverage, "captured chunks that never reached the provider").toMatchObject({
      missingAtStart: 0,
      missingInside: 0,
      missingAtEnd: 0,
    });
    expect(finalText, "a final transcript after the stop").toBeDefined();
  }

  function triggerKeys(tap: CaptureTapSnapshot, type: "keydown" | "keyup") {
    return tap.keys.filter((k) => k.type === type && k.key === TRIGGER_KEY && !k.repeat);
  }

  for (const provider of ["openai", "deepgram"] as const) {
    test(`${provider}: a toggled dictation keeps every word at the start and the stop`, async () => {
      mock.script({ text: TRANSCRIPT });
      await setVoiceSettings({ transcriptionProvider: provider });

      await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
      await waitForSpeech();
      await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
      await waitForTranscript();

      const presses = triggerKeys(await readCaptureTap(ctx.window), "keydown");
      expect(presses).toHaveLength(2);
      await expectEveryWordKept(`${provider} toggle`, provider, {
        start: presses[0],
        stop: presses[1],
      });
    });
  }

  test("openai: releasing push-to-talk keeps every word at the start and the stop", async () => {
    mock.script({ text: TRANSCRIPT });
    await setVoiceSettings({ transcriptionProvider: "openai", recordingMode: "push-to-talk" });
    try {
      for (const key of MODIFIER_KEYS) await ctx.window.keyboard.down(key);
      await ctx.window.keyboard.down(TRIGGER_KEY);
      await waitForSpeech();
      await ctx.window.keyboard.up(TRIGGER_KEY);
      for (const key of [...MODIFIER_KEYS].reverse()) await ctx.window.keyboard.up(key);
      await waitForTranscript();
    } finally {
      await setVoiceSettings({ recordingMode: "toggle" });
    }

    const tap = await readCaptureTap(ctx.window);
    const [press] = triggerKeys(tap, "keydown");
    const [release] = triggerKeys(tap, "keyup");
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    await expectEveryWordKept("openai push-to-talk", "openai", { start: press, stop: release });
  });

  test("openai: a stop before the provider is ready keeps every word", async () => {
    mock.script({ text: TRANSCRIPT });
    await setVoiceSettings({ transcriptionProvider: "openai" });
    // The socket opens but the session never confirms, so the provider stays not ready
    // until the spec answers for it, after the stop.
    mock.setAutoHandshake(false);
    let pending: MockConnection | undefined;
    mock.hooks.onSessionUpdate = (conn) => {
      pending = conn;
    };

    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    await waitForSpeech();
    await expect.poll(() => pending !== undefined, { timeout: T_MEDIUM }).toBe(true);
    expect(mock.audio, "nothing reaches the provider before it is ready").toHaveLength(0);
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    // The provider takes the stop while still waiting on its session.
    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).statuses, { timeout: T_MEDIUM })
      .toContain("finishing");
    pending!.send({ type: "session.updated" });
    await waitForTranscript();

    const presses = triggerKeys(await readCaptureTap(ctx.window), "keydown");
    expect(presses).toHaveLength(2);
    await expectEveryWordKept("openai stop before ready", "openai", {
      start: presses[0],
      stop: presses[1],
    });
  });
});
