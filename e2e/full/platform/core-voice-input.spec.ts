/**
 * E2E: Voice Input — OpenAI Realtime Backend
 *
 * Covers the voice-input subsystem migrated to OpenAI in #7831/#7833/#7835.
 * The WS protocol surface is exercised via direct IPC (`window.electron.voiceInput.*`)
 * against the shared transcription mock (helpers/transcriptionMock.ts). The
 * transcript-handling integration in `voiceInput.ts` (spoken-command paragraphing,
 * complete event splitting) still runs the same code path; only the audio source
 * is skipped. The key-to-mock path with real capture is core-voice-fake-mic.spec.ts.
 */

import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "fs";
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
import { createTranscriptionMock, type TranscriptionMock } from "../../helpers/transcriptionMock";
import {
  installEventCapture,
  getCapturedEvents,
  clearCapturedEvents,
  getVoiceSessionId,
  ipcStart,
  ipcStop,
  ipcSendAudio,
  ipcSetSettings,
  ipcGetSettings,
  seedVoiceConfig,
} from "../../helpers/voice";
import { openSettings } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const PRE_SEEDED_KEY = "sk-e2e-test-key-not-real";

// ===========================================================================
// Section 1 — settings migration on cold start
// ===========================================================================

test.describe.serial("E2E: Voice Input — Settings migration on cold start", () => {
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
  async function runMigration(
    legacySeed: Record<string, unknown>,
    schemaVersion?: number
  ): Promise<{
    migrated: Record<string, unknown>;
    onDisk: { voiceInput: Record<string, unknown>; _schemaVersion?: number };
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

    seedVoiceConfig(activeUserDataDir, legacySeed, schemaVersion);
    removeSingletonFiles(activeUserDataDir);

    activeCtx = await launchApp({ userDataDir: activeUserDataDir });
    const migrated = await ipcGetSettings(activeCtx.window);
    const configPath = path.join(activeUserDataDir, "config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    return { migrated, onDisk };
  }

  // One backdated boot covers the real Electron path: the numbered migrations
  // run, the read-time normalizer folds the legacy key in, and nothing else in
  // voiceInput is lost. The per-branch migration rules are unit-tested
  // (voiceInput.paragraph.test.ts, StoreMigrations.test.ts).
  test("a schema-26 install with a legacy key and retired models comes back upgraded and intact", async () => {
    // Backdated to 26 — session 1 stamps the CURRENT version, and a store
    // already marked current skips every numbered migration.
    const { migrated, onDisk } = await runMigration(
      {
        enabled: true,
        correctionApiKey: "sk-legacy-correction-key",
        language: "en",
        customDictionary: ["Daintree"],
        transcriptionProvider: "deepgram",
        deepgramApiKey: "dg-existing",
        transcriptionModel: "gpt-realtime-whisper",
        correctionEnabled: false,
        correctionModel: "gpt-5-mini",
        correctionCustomInstructions: "",
        paragraphingStrategy: "spoken-command",
        resolveFileLinks: true,
      },
      26
    );

    expect(migrated.openaiApiKey).toBe("sk-legacy-correction-key");
    expect(migrated.correctionApiKey).toBeUndefined();
    expect(migrated.transcriptionModel).toBe("gpt-live-transcribe");
    // Migration 025 lands the retired gpt-5-mini on gpt-5.6-luna (#11365); the
    // read-time normalizer then carries it on to gpt-6.1-terra and persists it.
    expect(migrated.correctionModel).toBe("gpt-6.1-terra");

    expect(onDisk.voiceInput.openaiApiKey).toBe("sk-legacy-correction-key");
    expect(onDisk.voiceInput.correctionApiKey).toBeUndefined();
    expect(onDisk.voiceInput.transcriptionModel).toBe("gpt-live-transcribe");
    expect(onDisk.voiceInput.correctionModel).toBe("gpt-6.1-terra");
    // Advancement, not a hard-coded latest — the exact number moves with every
    // future migration.
    expect(onDisk._schemaVersion).toBeGreaterThan(26);

    // The provider — not the model — selects the backend, so a Deepgram user's
    // choice must survive the model upgrade untouched (#9175).
    expect(migrated.transcriptionProvider).toBe("deepgram");
    expect(migrated.deepgramApiKey).toBe("dg-existing");
    // Migration 036 turns the word list into structured entries (#14598).
    expect((migrated.dictionary as { term: string }[]).map((entry) => entry.term)).toEqual([
      "Daintree",
    ]);
    expect(onDisk.voiceInput.customDictionary).toBeUndefined();
  });
});

// ===========================================================================
// Section 2 — OpenAI Realtime IPC lifecycle (mock WebSocket backend) and the
// Settings UI, on one launch
// ===========================================================================

test.describe.serial("E2E: Voice Input — Realtime IPC and settings UI", () => {
  let ctx: AppContext;
  let mock: TranscriptionMock;
  let userDataDir: string;

  test.beforeAll(async () => {
    mock = await createTranscriptionMock();

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
      dictionary: [],
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-6.1-terra",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });
    removeSingletonFiles(userDataDir);

    ctx = await launchApp({
      userDataDir,
      env: mock.env(),
    });
    await installEventCapture(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
    await mock?.close();
    removePathSync(userDataDir);
  });

  test.describe.serial("IPC lifecycle", () => {
    test.beforeEach(async () => {
      mock.reset();
      await clearCapturedEvents(ctx.window);
      // Restore defaults so a failed/aborted prior test cannot leak settings state
      // (e.g. the "manual paragraphing" test below switching to manual mid-run).
      await ipcSetSettings(ctx.window, { paragraphingStrategy: "spoken-command" });
    });

    test("start → session.updated → status 'recording'; stop → commit → completed transcript", async () => {
      mock.script({ text: "hello world" });

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
      const types = mock.control.map((m) => m.type);
      expect(types).toContain("session.update");
      expect(types).toContain("input_audio_buffer.commit");
      expect(types.indexOf("session.update")).toBeLessThan(
        types.indexOf("input_audio_buffer.commit")
      );

      // session.update payload must carry the realtime contract the server expects.
      // Catches silent regressions if VoiceTranscriptionService drops a required field.
      const sessionUpdate = mock.control.find((m) => m.type === "session.update");
      expect(sessionUpdate).toBeDefined();
      const session = (sessionUpdate!.raw as { session: Record<string, unknown> }).session;
      expect(session.type).toBe("transcription");
      const audio = session.audio as { input: Record<string, unknown> };
      const transcription = audio.input.transcription as Record<string, unknown>;
      expect(transcription.model).toBe("gpt-live-transcribe");
      expect(transcription.languages).toEqual(["en"]);
      // Presence and validity are the contract; the exact tier is tuning.
      expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(transcription.delay);
      // `languages` (array) supersedes the deprecated singular `language`; the two
      // are mutually exclusive on the wire and must never both be sent.
      expect(transcription).not.toHaveProperty("language");
      // `turn_detection` must be EXPLICITLY null — omitting it makes the server
      // apply a default VAD and silently emit no transcription. Segmentation is
      // driven client-side by the Silero VAD worker (commit at end-of-speech,
      // with an 8s max-segment backstop).
      expect(audio.input.turn_detection).toBeNull();

      const captured = await getCapturedEvents(ctx.window);
      const sessionId = await getVoiceSessionId(ctx.window);
      expect(captured.completes).toEqual([{ sessionId, text: "hello world", willCorrect: false }]);
    });

    test("delta events surface to renderer as onTranscriptionDelta in order", async () => {
      mock.script({ text: "hello world" });
      mock.hooks.onSessionUpdate = (conn) => {
        for (const delta of ["hello ", "world"]) {
          conn.send({ type: "conversation.item.input_audio_transcription.delta", delta });
        }
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
      mock.script({ text: "hello new paragraph" });

      await ipcStart(ctx.window);
      await ipcSendAudio(ctx.window);
      await ipcStop(ctx.window);

      // The trailing command closes the utterance and emits a boundary after its text.
      await expect
        .poll(async () => (await getCapturedEvents(ctx.window)).completes.map((c) => c.text), {
          timeout: T_MEDIUM,
        })
        .toEqual(["hello"]);

      const captured = await getCapturedEvents(ctx.window);
      expect(captured.paragraphBoundaries).toEqual([
        { sessionId: captured.completes[0].sessionId, rawText: null, correctionId: null },
      ]);
    });

    test("paragraphing 'manual' strategy passes spoken commands through as literal text", async () => {
      await ipcSetSettings(ctx.window, { paragraphingStrategy: "manual" });

      mock.script({ text: "hello new paragraph world" });

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
      mock.script({ text: "drained transcript", delayMs: 300 });

      await ipcStart(ctx.window);
      await ipcSendAudio(ctx.window);

      const stopStartedAt = Date.now();
      await ipcStop(ctx.window);
      const stopReturnedAt = Date.now();

      const commitArrivedAt =
        mock.control.find((m) => m.type === "input_audio_buffer.commit")?.t ?? 0;
      const completeSentAt = mock.sent.find((m) => m.type === "conversation.item.done")?.t ?? 0;

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
      mock.hooks.onSessionUpdate = (conn) =>
        conn.send({
          type: "error",
          error: { message: "Invalid auth token", type: "invalid_request_error" },
        });

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

  // Runs after the IPC lifecycle on the same launch: the seeded key and the
  // enabled flag are reset here, and a renderer reload in the key test would
  // drop the IPC event capture the lifecycle tests rely on.
  test.describe.serial("Settings UI", () => {
    test.beforeAll(async () => {
      await ipcSetSettings(ctx.window, { enabled: false, openaiApiKey: "" });
    });

    test.afterEach(async () => {
      await ipcSetSettings(ctx.window, { enabled: false, openaiApiKey: "" });
      if (await ctx.window.locator(SEL.settings.heading).isVisible()) {
        await ctx.window.keyboard.press("Escape");
        await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({
          timeout: T_SHORT,
        });
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

      const toggle = window.getByRole("switch", { name: "Dictation", exact: true });
      await expect(toggle).toBeVisible({ timeout: T_SHORT });
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      await expect(window.getByText("Speech-to-text", { exact: true })).toBeVisible();
      await expect(
        window.getByText("Real-time transcription with your own provider API key.", { exact: true })
      ).toBeVisible();

      // While disabled, the API key field is not rendered. Pin the placeholder's
      // presence once enabled (next test) so this zero-count can't pass vacuously.
      await expect(window.getByPlaceholder("Paste an OpenAI API key", { exact: true })).toHaveCount(
        0
      );
      await expect(window.getByText("OpenAI API key", { exact: true })).toHaveCount(0);
    });

    test("enabling voice input reveals API key, language, paragraphing, and dictionary controls", async () => {
      const { window } = ctx;
      await openSettings(window);
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

      const toggle = window.getByRole("switch", { name: "Dictation", exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });

      await expect(window.getByPlaceholder("Paste an OpenAI API key", { exact: true })).toBeVisible(
        {
          timeout: T_SHORT,
        }
      );
      await expect(window.getByText("Language", { exact: true })).toBeVisible();
      await expect(window.getByText("Paragraph breaks", { exact: true }).first()).toBeVisible();
      await expect(window.getByText("Custom dictionary", { exact: true })).toBeVisible();
    });

    test("API key persists across settings dialog reopen and Remove key reverts the indicator", async () => {
      const { window } = ctx;
      // Pre-seed via IPC — avoids the validation/HTTP path the Save button triggers.
      await ipcSetSettings(window, { enabled: true, openaiApiKey: PRE_SEEDED_KEY });
      // The Settings dialog keeps visited tabs mounted between closes. Reload so
      // this assertion reads the pre-seeded value through the tab's mount path.
      await window.reload({ waitUntil: "domcontentloaded" });
      await window
        .locator(SEL.toolbar.toggleSidebar)
        .waitFor({ state: "visible", timeout: T_LONG });
      ctx.window = window;

      await openSettings(window);
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

      // Configured-state indicators: the replace placeholder, the masked "Saved ·"
      // accessory, and the Remove key button.
      const keyInput = window.getByPlaceholder("Paste a new key to replace the saved one", {
        exact: true,
      });
      await expect(keyInput).toBeVisible({ timeout: T_SHORT });
      await expect(window.getByText(/^Saved · /)).toBeVisible();
      const removeButton = window.getByRole("button", { name: "Remove key", exact: true });
      await expect(removeButton).toBeVisible();

      // Close + reopen — key must still be configured.
      await window.keyboard.press("Escape");
      await openSettings(window);
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Voice Input" }).click();

      await expect(keyInput).toBeVisible({ timeout: T_SHORT });
      await expect(removeButton).toBeVisible();

      // Remove key reverts to unconfigured (placeholder returns to the empty-state copy).
      await removeButton.click();
      await window
        .getByRole("alertdialog", { name: "Remove the OpenAI API key?" })
        .getByRole("button", { name: "Remove key" })
        .click();
      await expect(window.getByPlaceholder("Paste an OpenAI API key", { exact: true })).toBeVisible(
        {
          timeout: T_SHORT,
        }
      );
      await expect(window.getByText("Key removed", { exact: true })).toBeVisible();
      await expect(window.getByText("Not set", { exact: true })).toBeVisible();
      await expect(removeButton).not.toBeVisible({ timeout: T_SHORT });
      await expect(keyInput).toHaveCount(0);

      // And the underlying store now reflects the empty key.
      const settings = await ipcGetSettings(window);
      expect(settings.openaiApiKey).toBe("");
    });
  });
});
