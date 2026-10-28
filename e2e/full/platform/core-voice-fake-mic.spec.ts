/**
 * E2E: Voice Input — key to mock, with a WAV as the microphone
 *
 * The whole capture path runs for real: the toggle chord, getUserMedia (Chromium's
 * fake capture device reading a generated WAV), the AudioWorklet and the provider
 * socket. Only the transcription server is the shared mock, which records every
 * audio byte so a spec can tell real audio from zero-fill.
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
import { createTranscriptionMock, type TranscriptionMock } from "../../helpers/transcriptionMock";
import { fakeAgentEnv, installFakeAgent } from "../../helpers/fakeAgent";
import {
  launchAppWithFakeMicrophone,
  pcmPeak,
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

// 24 kHz s16le: one second of audio. Half a second clears the service's commit minimum.
const BYTES_PER_SECOND = 48_000;

test.describe.serial("E2E: Voice Input — fake microphone smoke", () => {
  let ctx: AppContext;
  let mock: TranscriptionMock;
  let userDataDir: string;
  let workDir: string;
  let fixtureCleanup: (() => void) | undefined;
  let binDir: string;
  let agent: Locator;

  test.beforeAll(async () => {
    mock = await createTranscriptionMock();
    workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-mic-"));
    const wavPath = writeWav(workDir, "tone.wav", { seconds: 4, frequency: 440, amplitude: 0.5 });
    binDir = installFakeAgent(workDir);

    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-mic-ud-"));
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
      correctionModel: "gpt-6.1-terra",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });
    removeSingletonFiles(userDataDir);

    ctx = await launchAppWithFakeMicrophone({
      userDataDir,
      env: { ...mock.env(), ...fakeAgentEnv(binDir) },
      wavPath,
    });
    await stubNativeMicrophonePermission(ctx.app);
    const fixture = createFixtureRepo({ name: "voice-fake-mic" });
    fixtureCleanup = fixture.cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
    agent = await openDictationTarget(ctx.window, binDir);
    await installEventCapture(ctx.window);
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
  });

  async function dictate(): Promise<void> {
    await ensureWindowFocused(ctx.app);
    await focusDictationTarget(agent);
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
    await mock.waitForAudioBytes(BYTES_PER_SECOND / 2, T_LONG);
    await ctx.window.keyboard.press(VOICE_TOGGLE_CHORD);
  }

  test("OpenAI: the key starts dictation and the fake microphone's audio reaches the mock", async () => {
    mock.script({ text: "hello from the fake microphone" });
    await ipcSetSettings(ctx.window, { transcriptionProvider: "openai" });

    await dictate();

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toContain("hello from the fake microphone");
    expect(mock.connections.map((c) => c.provider)).toEqual(["openai"]);
    // A tone, not the zero-fill the IPC-driven specs send.
    expect(pcmPeak(mock.pcm("openai"))).toBeGreaterThan(1_000);
  });

  test("Deepgram: the same key and audio reach the Deepgram protocol", async () => {
    mock.script({ text: "hello from deepgram" });
    await ipcSetSettings(ctx.window, { transcriptionProvider: "deepgram" });

    await dictate();

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toContain("hello from deepgram");
    expect(mock.connections.map((c) => c.provider)).toEqual(["deepgram"]);
    expect(mock.control.map((m) => m.type)).toContain("CloseStream");
    expect(pcmPeak(mock.pcm("deepgram"))).toBeGreaterThan(1_000);
  });
});
