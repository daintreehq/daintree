/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import { dispatchAction } from "./actions";
import { FAKE_AGENT_READY, ptyWrite, readFakeAgentLaunchLog } from "./fakeAgent";
import { expectInputBarFocused } from "./focus";
import { SEL } from "./selectors";
import { getTerminalTextById } from "./terminal";
import { T_LONG } from "./timeouts";

/**
 * Dictation types into a composer, and only agent panes have one. Launches the fake Claude
 * CLI (the app must run with `fakeAgentEnv(binDir)`), accepts its trust prompt and returns
 * the pane, whose composer then holds focus for the dictation key.
 */
export async function openDictationTarget(page: Page, binDir: string): Promise<Locator> {
  const launches = readFakeAgentLaunchLog(binDir).length;
  const launched = await dispatchAction(
    page,
    "agent.launch",
    { agentId: "claude", location: "grid" },
    { source: "test" }
  );
  expect(launched.ok, JSON.stringify(launched)).toBe(true);
  await expect
    .poll(() => readFakeAgentLaunchLog(binDir).length, { timeout: T_LONG * 2 })
    .toBe(launches + 1);
  const paneId = readFakeAgentLaunchLog(binDir)[launches].paneId;
  expect(paneId, "the fake agent was started without a pane id").toBeTruthy();
  await expect
    .poll(() => getTerminalTextById(page, paneId!), { timeout: T_LONG })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, paneId!, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, paneId!), { timeout: T_LONG })
    .toContain(FAKE_AGENT_READY);
  const pane = page.locator(`[data-panel-id="${paneId}"]`);
  await focusDictationTarget(pane);
  return pane;
}

export async function focusDictationTarget(pane: Locator): Promise<void> {
  await pane.locator(SEL.terminal.cmEditor).first().click();
  await expectInputBarFocused(pane);
}

// ---------------------------------------------------------------------------
// Renderer event capture — installs IPC listeners that buffer events on window
// ---------------------------------------------------------------------------

export interface CapturedEvents {
  statuses: string[];
  deltas: string[];
  completes: Array<{ sessionId: string; text: string; willCorrect: boolean }>;
  paragraphBoundaries: Array<{ rawText: string | null }>;
  errors: Array<string | { message?: string }>;
}

export async function installEventCapture(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as any;
    if (w.__voiceCapture__) return;
    const captured = {
      statuses: [] as string[],
      deltas: [] as string[],
      completes: [] as Array<{ sessionId: string; text: string; willCorrect: boolean }>,
      paragraphBoundaries: [] as Array<{ rawText: string | null }>,
      errors: [] as Array<string | { message?: string }>,
    };
    w.__voiceCapture__ = captured;
    const v = w.electron.voiceInput;
    v.onStatus((payload: { status: string }) => captured.statuses.push(payload.status));
    v.onTranscriptionDelta((payload: { text: string }) => captured.deltas.push(payload.text));
    v.onTranscriptionComplete(
      (payload: { sessionId: string; text: string; willCorrect: boolean }) =>
        captured.completes.push(payload)
    );
    v.onParagraphBoundary((payload: { rawText: string | null }) =>
      captured.paragraphBoundaries.push(payload)
    );
    v.onError((payload: { error: { message?: string } }) => captured.errors.push(payload.error));
  });
}

export async function getCapturedEvents(window: Page): Promise<CapturedEvents> {
  return await window.evaluate(() => {
    const w = window as any;
    return JSON.parse(JSON.stringify(w.__voiceCapture__)) as CapturedEvents;
  });
}

export async function clearCapturedEvents(window: Page): Promise<void> {
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

// Each start mints the session id that its audio and stop then carry, as the
// renderer service does; main ignores audio and stops for any other id.
export async function ipcStart(window: Page): Promise<{ ok: boolean; error?: string }> {
  return await window.evaluate(async () => {
    const w = window as any;
    w.__voiceSessionId__ = crypto.randomUUID();
    try {
      const outcome = await w.electron.voiceInput.start(w.__voiceSessionId__);
      if (outcome.status === "started") return { ok: true };
      return { ok: false, error: outcome.status === "failed" ? outcome.error : outcome.status };
    } catch (error) {
      return { ok: false, error: String((error as { message?: unknown })?.message ?? error) };
    }
  });
}

/** The session id the last `ipcStart` minted, or undefined before any start. */
export async function getVoiceSessionId(window: Page): Promise<string | undefined> {
  return await window.evaluate(() => (window as any).__voiceSessionId__ as string | undefined);
}

export async function ipcStop(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const w = window as any;
    if (w.__voiceSessionId__) await w.electron.voiceInput.stop(w.__voiceSessionId__);
  });
}

/**
 * Pushes one audio chunk above MIN_COMMIT_BYTES so the service's commit path
 * fires. E2E drives the voice IPC directly without real mic capture, so without
 * this the interval/stop commits are skipped as undersized and no transcript
 * is ever requested.
 */
export async function ipcSendAudio(window: Page, bytes = 6_000): Promise<void> {
  await window.evaluate((n) => {
    const w = window as any;
    w.electron.voiceInput.sendAudioChunk(w.__voiceSessionId__ ?? "", new ArrayBuffer(n));
  }, bytes);
}

export async function ipcSetSettings(window: Page, patch: Record<string, unknown>): Promise<void> {
  await window.evaluate(async (p) => {
    await (window as any).electron.voiceInput.setSettings(p);
  }, patch);
}

export async function ipcGetSettings(window: Page): Promise<Record<string, unknown>> {
  return await window.evaluate(async () => {
    return await (window as any).electron.voiceInput.getSettings();
  });
}

// ---------------------------------------------------------------------------
// Config seeding (electron-store config.json)
// ---------------------------------------------------------------------------

/**
 * Replaces the `voiceInput` object in electron-store's config.json. Must be
 * called AFTER an initial launch (electron-store creates the file lazily on
 * first .get/.set). Migration tests rely on the full-object replacement to
 * place legacy fields without defaults clobbering them.
 */
export function seedVoiceConfig(
  userDataDir: string,
  voiceInput: Record<string, unknown>,
  schemaVersion?: number
): void {
  const configPath = path.join(userDataDir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }
  config.voiceInput = voiceInput;
  // Session 1 wrote the CURRENT schema version, so a seed that leaves it alone
  // exercises only the read-time safety net — every store migration is skipped
  // as already-applied. Backdating makes the numbered migrations actually run.
  if (schemaVersion !== undefined) config._schemaVersion = schemaVersion;
  writeFileSync(configPath, JSON.stringify(config));
}
