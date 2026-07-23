/**
 * E2E: Voice Input — OpenAI Realtime Backend
 *
 * Covers the voice-input subsystem migrated to OpenAI in #7831/#7833/#7835.
 * The renderer's audio capture path requires `getUserMedia` + `AudioContext`
 * + AudioWorklet — out of reach for headless CI — so the WS protocol surface
 * is exercised via direct IPC (`window.electron.voiceInput.*`) against a
 * local `ws.WebSocketServer` mock. The transcript-handling integration in
 * `voiceInput.ts` (spoken-command paragraphing, complete event splitting)
 * still runs the same code path; only the audio source is skipped.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { WebSocketServer, type WebSocket } from "ws";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
  type AppContext,
} from "../../helpers/launch";
import { removePathSync } from "../../helpers/fixtures";
import { openSettings } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// ---------------------------------------------------------------------------
// Mock OpenAI Realtime WebSocket server
// ---------------------------------------------------------------------------

interface MockScenario {
  /** Send these events as soon as the client sends `session.update`. */
  onSessionUpdate?: (ws: WebSocket) => void;
  /** Send these events when the client sends `input_audio_buffer.commit`. */
  onCommit?: (ws: WebSocket) => void;
}

interface MockState {
  scenario: MockScenario;
  /** All non-audio messages received from the client, parsed. */
  received: Array<{ type: string; raw: Record<string, unknown> }>;
  /** Number of `input_audio_buffer.append` messages received. */
  audioAppendCount: number;
  sockets: Set<WebSocket>;
}

function createMockServer(state: MockState): WebSocketServer {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

  wss.on("connection", (ws) => {
    state.sockets.add(ws);
    ws.on("close", () => state.sockets.delete(ws));

    ws.on("message", (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof parsed.type === "string" ? parsed.type : "";

      if (type === "input_audio_buffer.append") {
        state.audioAppendCount += 1;
        return;
      }

      state.received.push({ type, raw: parsed });

      if (type === "session.update") {
        state.scenario.onSessionUpdate?.(ws);
      } else if (type === "input_audio_buffer.commit") {
        state.scenario.onCommit?.(ws);
      }
    });
  });

  return wss;
}

function send(ws: WebSocket, event: Record<string, unknown>): void {
  ws.send(JSON.stringify(event));
}

/**
 * Mimics the `?intent=transcription` endpoint: a committed segment's transcript
 * arrives as `conversation.item.done` with the text on the `input_audio`
 * content part (preceded by the `conversation.item.added` item shell).
 */
function sendTranscript(ws: WebSocket, transcript: string): void {
  send(ws, {
    type: "conversation.item.added",
    item: { content: [{ type: "input_audio" }] },
  });
  send(ws, {
    type: "conversation.item.done",
    item: { content: [{ type: "input_audio", transcript }] },
  });
}

function resetMockState(state: MockState): void {
  state.scenario = {};
  state.received = [];
  state.audioAppendCount = 0;
  for (const sock of state.sockets) {
    try {
      sock.close();
    } catch {
      // ignore
    }
  }
  state.sockets.clear();
}

// ---------------------------------------------------------------------------
// Renderer event capture — installs IPC listeners that buffer events on window
// ---------------------------------------------------------------------------

interface CapturedEvents {
  statuses: string[];
  deltas: string[];
  completes: Array<{ text: string; willCorrect: boolean }>;
  paragraphBoundaries: Array<{ rawText: string | null }>;
  errors: Array<string | { message?: string }>;
}

async function installEventCapture(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as any;
    if (w.__voiceCapture__) return;
    const captured = {
      statuses: [] as string[],
      deltas: [] as string[],
      completes: [] as Array<{ text: string; willCorrect: boolean }>,
      paragraphBoundaries: [] as Array<{ rawText: string | null }>,
      errors: [] as Array<string | { message?: string }>,
    };
    w.__voiceCapture__ = captured;
    const v = w.electron.voiceInput;
    v.onStatus((status: string) => captured.statuses.push(status));
    v.onTranscriptionDelta((delta: string) => captured.deltas.push(delta));
    v.onTranscriptionComplete((payload: { text: string; willCorrect: boolean }) =>
      captured.completes.push(payload)
    );
    v.onParagraphBoundary((payload: { rawText: string | null }) =>
      captured.paragraphBoundaries.push(payload)
    );
    v.onError((error: string | { message?: string }) => captured.errors.push(error));
  });
}

async function getCapturedEvents(window: Page): Promise<CapturedEvents> {
  return await window.evaluate(() => {
    const w = window as any;
    return JSON.parse(JSON.stringify(w.__voiceCapture__)) as CapturedEvents;
  });
}

async function clearCapturedEvents(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as any;
    const c = w.__voiceCapture__;
    c.statuses.length = 0;
    c.deltas.length = 0;
    c.completes.length = 0;
    c.paragraphBoundaries.length = 0;
    c.errors.length = 0;
  });
}

// ---------------------------------------------------------------------------
// IPC wrappers (run in renderer context, where window.electron exists)
// ---------------------------------------------------------------------------

async function ipcStart(window: Page): Promise<{ ok: boolean; error?: string }> {
  return await window.evaluate(async () => {
    return await (window as any).electron.voiceInput.start();
  });
}

async function ipcStop(window: Page): Promise<void> {
  await window.evaluate(async () => {
    await (window as any).electron.voiceInput.stop();
  });
}

/**
 * Pushes one audio chunk above MIN_COMMIT_BYTES so the service's commit path
 * fires. E2E drives the voice IPC directly without real mic capture, so without
 * this the interval/stop commits are skipped as undersized and no transcript
 * is ever requested.
 */
async function ipcSendAudio(window: Page, bytes = 6_000): Promise<void> {
  await window.evaluate((n) => {
    (window as any).electron.voiceInput.sendAudioChunk(new ArrayBuffer(n));
  }, bytes);
}

async function ipcSetSettings(window: Page, patch: Record<string, unknown>): Promise<void> {
  await window.evaluate(async (p) => {
    await (window as any).electron.voiceInput.setSettings(p);
  }, patch);
}

async function ipcGetSettings(window: Page): Promise<Record<string, unknown>> {
  return await window.evaluate(async () => {
    return await (window as any).electron.voiceInput.getSettings();
  });
}

// ---------------------------------------------------------------------------
// Config seeding (electron-store config.json)
// ---------------------------------------------------------------------------

const PRE_SEEDED_KEY = "sk-e2e-test-key-not-real";

/**
 * Replaces the `voiceInput` object in electron-store's config.json. Must be
 * called AFTER an initial launch (electron-store creates the file lazily on
 * first .get/.set). Migration tests rely on the full-object replacement to
 * place legacy fields without defaults clobbering them.
 */
function seedVoiceConfig(userDataDir: string, voiceInput: Record<string, unknown>): void {
  const configPath = path.join(userDataDir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }
  config.voiceInput = voiceInput;
  writeFileSync(configPath, JSON.stringify(config));
}

// ===========================================================================
// Section 1 — Settings UI
// ===========================================================================

test.describe.serial("E2E: Voice Input — Settings UI", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test.afterEach(async () => {
    // Reset to disabled so each test starts from a clean slate.
    await ipcSetSettings(ctx.window, { enabled: false, openaiApiKey: "" });
    if (
      await ctx.window
        .locator(SEL.settings.heading)
        .isVisible()
        .catch(() => false)
    ) {
      await ctx.window.keyboard.press("Escape");
    }
  });

  test("voice settings tab renders Speech-to-Text section with disabled defaults", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();
    await expect(window.locator("h3", { hasText: "Voice Input" })).toBeVisible({
      timeout: T_SHORT,
    });

    const toggle = window.locator('[aria-label="Toggle voice input"]');
    await expect(toggle).toBeVisible({ timeout: T_SHORT });

    await expect(window.getByText("Speech-to-text", { exact: true })).toBeVisible();
    await expect(
      window.getByText(
        "Real-time transcription. Requires a provider API key and microphone access."
      )
    ).toBeVisible();

    // While disabled, the API key field is not rendered.
    await expect(window.locator('input[placeholder="sk-..."]')).toHaveCount(0);
  });

  test("enabling voice input reveals API key, language, paragraphing, and dictionary controls", async () => {
    const { window } = ctx;
    await openSettings(window);
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

    const toggle = window.locator('[aria-label="Toggle voice input"]');
    await toggle.click();

    await expect(window.locator('input[placeholder="sk-..."]')).toBeVisible({ timeout: T_SHORT });
    await expect(window.getByText("Language", { exact: true })).toBeVisible();
    await expect(window.getByText("Paragraph Breaks")).toBeVisible();
    await expect(window.getByText("Custom Dictionary")).toBeVisible();
  });

  test("API key persists across settings dialog reopen and Clear reverts the indicator", async () => {
    const { window } = ctx;
    // Pre-seed via IPC — avoids the validation/HTTP path the Save button triggers.
    await ipcSetSettings(window, { enabled: true, openaiApiKey: PRE_SEEDED_KEY });
    // The Settings dialog keeps visited tabs mounted between closes. Reload so
    // this assertion reads the pre-seeded value through the tab's mount path.
    await window.reload({ waitUntil: "domcontentloaded" });
    await window.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
    ctx.window = window;

    await openSettings(window);
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

    // Configured-state indicators: "Enter new key to replace" placeholder + "Configured" badge + Clear button.
    const keyInput = window.locator('input[placeholder="Enter new key to replace"]');
    await expect(keyInput).toBeVisible({ timeout: T_SHORT });
    await expect(window.getByText("Configured", { exact: true })).toBeVisible();
    const clearButton = window.getByRole("button", { name: "Clear", exact: true });
    await expect(clearButton).toBeVisible();

    // Close + reopen — key must still be configured.
    await window.keyboard.press("Escape");
    await openSettings(window);
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

    await expect(keyInput).toBeVisible({ timeout: T_SHORT });
    await expect(window.getByText("Configured", { exact: true })).toBeVisible();

    // Clear reverts to unconfigured (placeholder returns to "sk-...").
    await clearButton.click();
    await expect(window.locator('input[placeholder="sk-..."]')).toBeVisible({ timeout: T_SHORT });
    await expect(window.getByText("Configured", { exact: true })).not.toBeVisible({
      timeout: T_SHORT,
    });

    // And the underlying store now reflects the empty key.
    const settings = await ipcGetSettings(window);
    expect(settings.openaiApiKey).toBe("");
  });
});

// ===========================================================================
// Section 2 — `correctionApiKey` → `openaiApiKey` migration on cold start
// ===========================================================================

test.describe.serial("E2E: Voice Input — Settings Migration", () => {
  let activeUserDataDir: string | null = null;
  let activeCtx: AppContext | null = null;

  test.afterEach(async () => {
    if (activeCtx?.app) {
      const pid = activeCtx.app.process().pid;
      await closeApp(activeCtx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      activeCtx = null;
    }
    if (activeUserDataDir) {
      removePathSync(activeUserDataDir);
      activeUserDataDir = null;
    }
  });

  /**
   * Helper: launch → close → seed legacy `voiceInput` config → relaunch.
   * Returns the merged settings as observed via IPC and the post-migration
   * on-disk shape so callers can assert both layers.
   */
  async function runMigration(legacySeed: Record<string, unknown>): Promise<{
    migrated: Record<string, unknown>;
    onDisk: { voiceInput: Record<string, unknown> };
  }> {
    activeUserDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-migrate-"));

    // Session 1: initialize the file so we can mutate it between sessions.
    activeCtx = await launchApp({ userDataDir: activeUserDataDir });
    await expect(activeCtx.window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({
      timeout: T_MEDIUM,
    });
    const pid = activeCtx.app.process().pid!;
    await closeApp(activeCtx.app);
    await waitForProcessExit(pid);
    activeCtx = null;

    seedVoiceConfig(activeUserDataDir, legacySeed);
    removeSingletonFiles(activeUserDataDir);

    activeCtx = await launchApp({ userDataDir: activeUserDataDir });
    const migrated = await ipcGetSettings(activeCtx.window);
    const configPath = path.join(activeUserDataDir, "config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    return { migrated, onDisk };
  }

  test("legacy correctionApiKey migrates into openaiApiKey on first read after upgrade", async () => {
    const { migrated, onDisk } = await runMigration({
      enabled: false,
      correctionApiKey: "sk-legacy-correction-key",
      language: "en",
      customDictionary: [],
      transcriptionModel: "nova-3",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });

    expect(migrated.openaiApiKey).toBe("sk-legacy-correction-key");
    expect(migrated.transcriptionModel).toBe("gpt-realtime-whisper");
    expect(migrated.correctionApiKey).toBeUndefined();
    // The retired gpt-5-mini correction model migrates to gpt-5.6-luna (#11365).
    expect(migrated.correctionModel).toBe("gpt-5.6-luna");

    expect(onDisk.voiceInput.openaiApiKey).toBe("sk-legacy-correction-key");
    expect(onDisk.voiceInput.correctionApiKey).toBeUndefined();
    expect(onDisk.voiceInput.transcriptionModel).toBe("gpt-realtime-whisper");
    expect(onDisk.voiceInput.correctionModel).toBe("gpt-5.6-luna");
  });

  test("legacy apiKey field migrates into openaiApiKey when no correctionApiKey is present", async () => {
    // Covers the second branch in voiceInput.ts: when correctionApiKey is absent
    // but the older top-level `apiKey` exists, the migration falls through to it.
    const { migrated, onDisk } = await runMigration({
      enabled: false,
      apiKey: "sk-original-key",
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-realtime-whisper",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });

    expect(migrated.openaiApiKey).toBe("sk-original-key");
    expect(migrated.apiKey).toBeUndefined();
    expect(onDisk.voiceInput.openaiApiKey).toBe("sk-original-key");
    expect(onDisk.voiceInput.apiKey).toBeUndefined();
  });
});

// ===========================================================================
// Section 3 — OpenAI Realtime IPC lifecycle (mock WebSocket backend)
// ===========================================================================

test.describe.serial("E2E: Voice Input — OpenAI Realtime IPC Lifecycle", () => {
  let ctx: AppContext;
  let mockServer: WebSocketServer;
  let mockState: MockState;
  let userDataDir: string;
  let mockPort: number;

  test.beforeAll(async () => {
    mockState = {
      scenario: {},
      received: [],
      audioAppendCount: 0,
      sockets: new Set(),
    };
    mockServer = createMockServer(mockState);
    await new Promise<void>((resolve) => {
      if (mockServer.address()) {
        resolve();
        return;
      }
      mockServer.on("listening", () => resolve());
    });
    const addr = mockServer.address();
    if (!addr || typeof addr === "string") throw new Error("Mock server failed to bind");
    mockPort = addr.port;

    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-voice-ipc-"));

    // First launch initializes config.json. Subsequent launches reuse the same userDataDir.
    ctx = await launchApp({ userDataDir });
    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);

    seedVoiceConfig(userDataDir, {
      enabled: true,
      openaiApiKey: PRE_SEEDED_KEY,
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-realtime-whisper",
      correctionEnabled: false,
      correctionModel: "gpt-5.6-luna",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });
    removeSingletonFiles(userDataDir);

    ctx = await launchApp({
      userDataDir,
      env: {
        DAINTREE_REALTIME_WS_URL: `ws://127.0.0.1:${mockPort}`,
      },
    });
    await installEventCapture(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    removePathSync(userDataDir);
  });

  test.beforeEach(async () => {
    resetMockState(mockState);
    await clearCapturedEvents(ctx.window);
    // Restore defaults so a failed/aborted prior test cannot leak settings state
    // (e.g. the "manual paragraphing" test below switching to manual mid-run).
    await ipcSetSettings(ctx.window, { paragraphingStrategy: "spoken-command" });
  });

  test("start → session.updated → status 'recording'; stop → commit → completed transcript", async () => {
    mockState.scenario = {
      onSessionUpdate: (ws) => send(ws, { type: "session.updated" }),
      onCommit: (ws) => sendTranscript(ws, "hello world"),
    };

    const startResult = await ipcStart(ctx.window);
    expect(startResult).toEqual({ ok: true });

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).statuses, { timeout: T_MEDIUM })
      .toContain("recording");

    await ipcSendAudio(ctx.window);
    await ipcStop(ctx.window);

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toContain("hello world");

    // Protocol-level proof: session.update arrived before commit.
    const types = mockState.received.map((m) => m.type);
    expect(types).toContain("session.update");
    expect(types).toContain("input_audio_buffer.commit");
    expect(types.indexOf("session.update")).toBeLessThan(
      types.indexOf("input_audio_buffer.commit")
    );

    // session.update payload must carry the realtime contract the server expects.
    // Catches silent regressions if VoiceTranscriptionService drops a required field.
    const sessionUpdate = mockState.received.find((m) => m.type === "session.update");
    expect(sessionUpdate).toBeDefined();
    const session = (sessionUpdate!.raw as { session: Record<string, unknown> }).session;
    expect(session.type).toBe("transcription");
    const audio = session.audio as { input: Record<string, unknown> };
    const transcription = audio.input.transcription as { model: string; language: string };
    expect(transcription.model).toBe("gpt-realtime-whisper");
    expect(transcription.language).toBe("en");
    // `gpt-realtime-whisper` does not support server VAD. `turn_detection` must
    // be EXPLICITLY null — omitting it makes the server apply a default VAD and
    // silently emit no transcription. Segmentation is driven client-side via
    // interval `input_audio_buffer.commit` calls.
    expect(audio.input.turn_detection).toBeNull();

    const captured = await getCapturedEvents(ctx.window);
    expect(captured.completes).toEqual([{ text: "hello world", willCorrect: false }]);
  });

  test("delta events surface to renderer as onTranscriptionDelta in order", async () => {
    mockState.scenario = {
      onSessionUpdate: (ws) => {
        send(ws, { type: "session.updated" });
        send(ws, {
          type: "conversation.item.input_audio_transcription.delta",
          delta: "hello ",
        });
        send(ws, {
          type: "conversation.item.input_audio_transcription.delta",
          delta: "world",
        });
      },
      onCommit: (ws) => sendTranscript(ws, "hello world"),
    };

    await ipcStart(ctx.window);

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).deltas, { timeout: T_MEDIUM })
      .toEqual(["hello ", "world"]);

    await ipcSendAudio(ctx.window);
    await ipcStop(ctx.window);

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.length, {
        timeout: T_MEDIUM,
      })
      .toBe(1);
  });

  test("spoken-command paragraphing strips a trailing 'new paragraph' command", async () => {
    mockState.scenario = {
      onSessionUpdate: (ws) => send(ws, { type: "session.updated" }),
      onCommit: (ws) => sendTranscript(ws, "hello new paragraph"),
    };

    await ipcStart(ctx.window);
    await ipcSendAudio(ctx.window);
    await ipcStop(ctx.window);

    // The IPC handler applies applyDictationCommands → "hello\n\n", then
    // split + filter(Boolean) drops the trailing empty paragraph.
    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toEqual(["hello"]);

    const captured = await getCapturedEvents(ctx.window);
    expect(captured.paragraphBoundaries).toEqual([]);
  });

  test("paragraphing 'manual' strategy passes spoken commands through as literal text", async () => {
    await ipcSetSettings(ctx.window, { paragraphingStrategy: "manual" });

    mockState.scenario = {
      onSessionUpdate: (ws) => send(ws, { type: "session.updated" }),
      onCommit: (ws) => sendTranscript(ws, "hello new paragraph world"),
    };

    await ipcStart(ctx.window);
    await ipcSendAudio(ctx.window);
    await ipcStop(ctx.window);

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toEqual(["hello new paragraph world"]);
    // No inline restore — `beforeEach` resets paragraphingStrategy to "spoken-command".
  });

  test("graceful drain: stop awaits server completed before resolving", async () => {
    let commitArrivedAt = 0;
    let completeSentAt = 0;

    mockState.scenario = {
      onSessionUpdate: (ws) => send(ws, { type: "session.updated" }),
      onCommit: (ws) => {
        commitArrivedAt = Date.now();
        setTimeout(() => {
          completeSentAt = Date.now();
          sendTranscript(ws, "drained transcript");
        }, 300);
      },
    };

    await ipcStart(ctx.window);
    await ipcSendAudio(ctx.window);

    const stopStartedAt = Date.now();
    await ipcStop(ctx.window);
    const stopReturnedAt = Date.now();

    // The commit and the delayed completed must both be observed before stop() returns.
    expect(commitArrivedAt).toBeGreaterThan(0);
    expect(completeSentAt).toBeGreaterThan(commitArrivedAt);
    expect(stopReturnedAt).toBeGreaterThanOrEqual(completeSentAt);
    expect(stopReturnedAt - stopStartedAt).toBeGreaterThanOrEqual(250);

    await expect
      .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
        timeout: T_MEDIUM,
      })
      .toContain("drained transcript");
  });

  test("server 'error' event surfaces as onError; stop afterwards is idempotent", async () => {
    mockState.scenario = {
      onSessionUpdate: (ws) => {
        send(ws, { type: "session.updated" });
        send(ws, {
          type: "error",
          error: { message: "Invalid auth token", type: "invalid_request_error" },
        });
      },
    };

    await ipcStart(ctx.window);

    await expect
      .poll(
        async () =>
          (await getCapturedEvents(ctx.window)).errors.map((error) =>
            typeof error === "string" ? error : (error.message ?? "")
          ),
        { timeout: T_LONG }
      )
      .toContain("Invalid auth token");

    // No throw — handler tolerates stop() on an already-cleaned session.
    await ipcStop(ctx.window);
  });
});
