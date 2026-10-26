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
  captureFlushed,
  glidingVoice,
  installCaptureTap,
  measureCoverage,
  readCaptureTap,
  readTapEvents,
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
    // Long enough that no session reaches the loop point, where chunks would start repeating.
    const wavPath = writeWav(workDir, "voice.wav", { seconds: 30, waveform: glidingVoice });
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

  type KeyEvent = CaptureTapSnapshot["keys"][number];

  function triggerKeys(keys: readonly KeyEvent[], type: KeyEvent["type"]): KeyEvent[] {
    return keys.filter((k) => k.type === type && k.key === TRIGGER_KEY && !k.repeat);
  }

  /**
   * Queues the transcript for more than one boundary: on a synthetic voice the provider's VAD
   * may commit mid-session and take one early, and the final text is the session's last.
   */
  function scriptTranscript(): void {
    mock.script(...Array.from({ length: 3 }, () => ({ text: TRANSCRIPT })));
  }

  /** The provider closing its socket, then every transcript the mock played reaching the view. */
  async function finishSession(): Promise<void> {
    await expect
      .poll(() => mock.connections.every((c) => c.closedAt !== undefined), { timeout: T_MEDIUM })
      .toBe(true);
    const played = mock.sent.filter(
      (m) => m.type === "conversation.item.done" || m.type === "Results"
    ).length;
    expect(played, "the mock played a transcript").toBeGreaterThan(0);
    await expect
      .poll(async () => (await readTapEvents(ctx.window)).completes.length, { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(played);
  }

  /**
   * Every chunk the session's worklet delivered, from the first non-silent one through the
   * one its stop flushed, has to reach the provider in order: nothing lost at either end or
   * between.
   */
  async function expectEveryWordKept(
    label: string,
    provider: TranscriptionProviderId,
    start: KeyEvent,
    stop: KeyEvent
  ): Promise<void> {
    const tap = await readCaptureTap(ctx.window);
    expect(tap.nodes, "one capture graph per dictation").toHaveLength(1);
    const [node] = tap.nodes;
    const received = mock.audio.filter((a) => a.provider === provider);
    const coverage = measureCoverage(
      node.chunks.map((c) => c.bytes),
      received.map((a) => a.bytes)
    );
    const finalText = tap.completes.at(-1);
    const report = {
      keyToFirstAudioMs: received.length ? received[0].t - start.t : null,
      stopToFinalTextMs: finalText ? finalText.t - stop.t : null,
      ...coverage,
    };
    console.log(`[voice-words] ${label}: ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: "voice-words", description: JSON.stringify(report) });

    expect(node.flushedAfter, "the stop flushed the worklet, and no audio followed").toBe(
      node.chunks.length
    );
    expect(mock.connections, "one connection, so no reconnect replayed audio").toHaveLength(1);
    expect(finalText?.text).toBe(TRANSCRIPT);
    expect(
      report.stopToFinalTextMs,
      "the final transcript follows the stop"
    ).toBeGreaterThanOrEqual(0);
    expect(report.keyToFirstAudioMs).toBeGreaterThanOrEqual(0);
    expect(coverage.capturedChunks).toBeGreaterThanOrEqual(SPEECH_CHUNKS);
    expect(coverage.repeatedChunks, "voiced chunks are distinct, so arrival is unambiguous").toBe(
      0
    );
    expect(coverage, "captured chunks that never reached the provider").toMatchObject({
      missingAtStart: 0,
      missingInside: 0,
      missingAtEnd: 0,
    });
  }

  for (const provider of ["openai", "deepgram"] as const) {
    test(`${provider}: a toggled dictation keeps every word at the start and the stop`, async () => {
      scriptTranscript();
      await setVoiceSettings({ transcriptionProvider: provider });

      await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
      await waitForSpeech();
      await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);

      const presses = triggerKeys((await readTapEvents(ctx.window)).keys, "keydown");
      expect(presses).toHaveLength(2);
      const [start, stop] = presses;
      await finishSession();
      await expectEveryWordKept(`${provider} toggle`, provider, start, stop);
    });
  }

  test("openai: releasing push-to-talk keeps every word at the start and the stop", async () => {
    scriptTranscript();
    await setVoiceSettings({ transcriptionProvider: "openai", recordingMode: "push-to-talk" });
    const held: string[] = [];
    try {
      for (const key of [...MODIFIER_KEYS, TRIGGER_KEY]) {
        await ctx.window.keyboard.down(key);
        held.push(key);
      }
      await waitForSpeech();
      await ctx.window.keyboard.up(TRIGGER_KEY);
      held.pop();
      // The trigger's release has to end the session by itself, before the modifier's
      // release (which also stops push-to-talk on macOS) could cover for it.
      await expect.poll(() => captureFlushed(ctx.window), { timeout: T_MEDIUM }).toBe(true);
    } finally {
      for (const key of held.reverse()) await ctx.window.keyboard.up(key);
      await setVoiceSettings({ recordingMode: "toggle" });
    }

    const { keys } = await readTapEvents(ctx.window);
    const [start] = triggerKeys(keys, "keydown");
    const [stop] = triggerKeys(keys, "keyup");
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    await finishSession();
    await expectEveryWordKept("openai push-to-talk", "openai", start, stop);
  });

  /**
   * Leaves the OpenAI session unconfirmed, as a slow connect does: the socket is open but the
   * provider isn't ready, and holds what it captures, until the spec sends `session.updated`.
   */
  function holdSessionReady(): () => MockConnection | undefined {
    mock.setAutoHandshake(false);
    let pending: MockConnection | undefined;
    mock.hooks.onSessionUpdate = (conn) => {
      pending = conn;
    };
    return () => pending;
  }

  async function confirmSession(held: () => MockConnection | undefined): Promise<void> {
    await expect.poll(() => held() !== undefined, { timeout: T_MEDIUM }).toBe(true);
    expect(mock.audio, "nothing reaches the provider before it is ready").toHaveLength(0);
    held()!.send({ type: "session.updated" });
  }

  test("openai: speech captured while the provider connects keeps every word", async () => {
    scriptTranscript();
    await setVoiceSettings({ transcriptionProvider: "openai" });
    const held = holdSessionReady();

    // The real service takes 1.5-2s to connect, and the speaker doesn't wait for it.
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    await expect
      .poll(() => signalChunksTapped(ctx.window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(SPEECH_CHUNKS / 2);
    await confirmSession(held);
    // Speech keeps coming once the provider has flushed what it held, so the stop lands on a
    // ready session rather than collapsing into a stop before ready.
    await expect.poll(() => mock.audio.length, { timeout: T_MEDIUM }).toBeGreaterThan(0);
    const atReady = await signalChunksTapped(ctx.window);
    await expect
      .poll(() => signalChunksTapped(ctx.window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(atReady + SPEECH_CHUNKS / 2);
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);

    const presses = triggerKeys((await readTapEvents(ctx.window)).keys, "keydown");
    expect(presses).toHaveLength(2);
    const [start, stop] = presses;
    await finishSession();
    await expectEveryWordKept("openai slow connect", "openai", start, stop);
  });

  test("openai: a stop before the provider is ready keeps every word", async () => {
    scriptTranscript();
    await setVoiceSettings({ transcriptionProvider: "openai" });
    const held = holdSessionReady();

    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    await waitForSpeech();
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    // The provider takes the stop while still waiting on its session.
    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).statuses, { timeout: T_MEDIUM })
      .toContain("finishing");
    await confirmSession(held);

    const presses = triggerKeys((await readTapEvents(ctx.window)).keys, "keydown");
    expect(presses).toHaveLength(2);
    const [start, stop] = presses;
    await finishSession();
    await expectEveryWordKept("openai stop before ready", "openai", start, stop);
  });
});
