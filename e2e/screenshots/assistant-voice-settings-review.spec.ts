/**
 * Settings → Daintree Assistant and Settings → Voice input, state by state.
 *
 * `settings-pages-review` walks every tab at rest, which is the right question for
 * "do the pages share one grammar" and the wrong one for these two: both pages are
 * mostly conditional. Voice input is a switch until it is on, then a provider, a key
 * that may be missing, invalid or legacy, and a microphone that may be denied. The
 * assistant page changes with the chosen agent, the MCP server's state, and a save
 * that can fail. This harness reuses that spec's navigation and slicing and adds the
 * states, each driven through a real seam:
 *   - persisted settings through the app's own `voice-input:*` / `help-assistant:*`
 *     IPC channels, stubbed at the boundary by the fault registry
 *     (`DAINTREE_E2E_FAULT_MODE=1`), so the real client, hook and component render on
 *     top of a settings blob this machine does not have;
 *   - failures (load, save, key validation) as thrown faults on those same channels;
 *   - the preferred assistant agent through the help panel's persisted localStorage
 *     blob, which the store rehydrates on reload.
 *
 *   DAINTREE_SHOT_ASSISTANT_VOICE=1 DAINTREE_SHOT_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots assistant-voice-settings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANT_VOICE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME            optional theme id (default: the app default)
 *   DAINTREE_SHOT_ONLY             comma-separated slug filter
 *   DAINTREE_SHOT_SWEEP            only the states marked `sweep` (theme sweep)
 *   DAINTREE_SHOT_MAX_SLICES       slice cap per state (default 5)
 *
 * A manifest.json beside the PNGs lists every file written, and the run fails unless
 * the files on disk match it and every state's expected text was on screen.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectFault, injectStub, clearAllFaults } from "../helpers/ipcFaults";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANT_VOICE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const MAX_SLICES = Number(process.env.DAINTREE_SHOT_MAX_SLICES ?? "5");
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

const CH = {
  voiceGet: "voice-input:get-settings",
  voiceSet: "voice-input:set-settings",
  voiceMic: "voice-input:check-mic-permission",
  voiceValidate: "voice-input:validate-api-key",
  assistantGet: "help-assistant:get-settings",
  assistantSet: "help-assistant:set-settings",
  mcpRuntime: "mcp-server:get-runtime-state",
  mcpStatus: "mcp-server:get-status",
  agentVersion: "system:get-agent-version",
} as const;

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const VOICE_BASE = {
  enabled: false,
  openaiApiKey: "",
  deepgramApiKey: "",
  language: "en",
  customDictionary: [] as string[],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-5.6-luna",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [] as { word: string; utterance?: string }[],
  learnFromCorrections: true,
};

const ASSISTANT_BASE = {
  docSearch: true,
  daintreeControl: true,
  tier: "action",
  bypassPermissions: false,
  auditRetention: 7,
  modelId: "",
  customArgs: "",
  idleHibernateMinutes: 5,
  debugLogging: false,
};

const MCP_RUNNING = { enabled: true, state: "ready", port: 45454, lastError: null };
const MCP_OFF = { enabled: false, state: "disabled", port: null, lastError: null };
const MCP_FAILED = {
  enabled: true,
  state: "failed",
  port: null,
  lastError: "listen EADDRINUSE: address already in use 127.0.0.1:45454",
};
const MCP_STATUS = { enabled: true, port: 45454, apiKey: "dtk_0123456789abcdef" };

interface ShotState {
  slug: string;
  tab: "assistant" | "voice";
  expectText?: string[];
  expectNoText?: string[];
  sweep?: boolean;
  /** Stubs and faults on the IPC boundary, keyed by channel. */
  stubs?: Record<string, unknown>;
  faults?: Record<string, string>;
  /** The help panel's persisted preferred agent; `null` clears it. */
  preferredAgent?: string | null;
  /** Interaction after the tab renders — the state is what it leaves on screen. */
  act?: (page: Page) => Promise<void>;
}

const STATES: ShotState[] = [
  {
    // First contact: the feature is off. The whole page is one switch.
    slug: "v01-off",
    tab: "voice",
    stubs: { [CH.voiceGet]: VOICE_BASE, [CH.voiceMic]: "not-determined" },
    expectText: ["Dictation"],
    sweep: true,
  },
  {
    // On, nothing configured: no key, mic never asked. The page has to say what is
    // missing before dictation can work.
    slug: "v02-missing-key",
    tab: "voice",
    stubs: {
      [CH.voiceGet]: { ...VOICE_BASE, enabled: true },
      [CH.voiceMic]: "not-determined",
    },
    expectText: ["OpenAI API key"],
    sweep: true,
  },
  {
    // The key the user pasted was rejected by the provider.
    slug: "v03-key-invalid",
    tab: "voice",
    stubs: {
      [CH.voiceGet]: { ...VOICE_BASE, enabled: true },
      [CH.voiceMic]: "granted",
      [CH.voiceValidate]: {
        valid: false,
        error: "Incorrect API key provided. Check the key and try again.",
      },
    },
    act: async (page) => {
      const row = page.locator("#voice-stt-openai-key");
      await row.locator("input").fill("sk-proj-not-a-real-key-000000");
      await row.getByRole("button", { name: "Check and save" }).click();
    },
    expectText: ["Incorrect API key provided"],
    sweep: true,
  },
  {
    // Fully configured and in daily use: project key, mic granted, dictionary with
    // suggestions waiting, AI correction on with its dependents.
    slug: "v04-configured",
    tab: "voice",
    stubs: {
      [CH.voiceGet]: {
        ...VOICE_BASE,
        enabled: true,
        openaiApiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        customDictionary: ["Daintree", "Zustand", "xterm", "worktree", "node-pty", "Vite"],
        suggestedDictionary: [
          { word: "drizzle", utterance: "drizzel" },
          { word: "Tailwind", utterance: "tail wind" },
        ],
        correctionEnabled: true,
        correctionCustomInstructions: "Always write ProjectView as one word.",
      },
      [CH.voiceMic]: "granted",
    },
    expectText: ["Custom dictionary", "Clean up transcriptions"],
    sweep: true,
  },
  {
    // Mic denied at the OS, legacy user key (shows the org/project disclosure),
    // non-English language (spoken paragraph commands fall back).
    slug: "v05-mic-denied-legacy-key",
    tab: "voice",
    stubs: {
      [CH.voiceGet]: {
        ...VOICE_BASE,
        enabled: true,
        openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        language: "de",
      },
      [CH.voiceMic]: "denied",
    },
    expectText: ["Organization ID"],
  },
  {
    // Deepgram transcription with AI correction switched on but no OpenAI key: the
    // correction has nothing to run on.
    slug: "v06-deepgram-correction-no-openai-key",
    tab: "voice",
    stubs: {
      [CH.voiceGet]: {
        ...VOICE_BASE,
        enabled: true,
        transcriptionProvider: "deepgram",
        deepgramApiKey: "dg_0123456789abcdef",
        correctionEnabled: true,
      },
      [CH.voiceMic]: "granted",
    },
    expectText: ["Deepgram API key"],
  },
  {
    slug: "v07-load-error",
    tab: "voice",
    faults: { [CH.voiceGet]: "ENOENT: no such file or directory, open 'config.json'" },
    expectText: ["Retry"],
    sweep: true,
  },
  {
    // Nobody has set the assistant up: no agent chosen, MCP server off.
    slug: "a01-signed-out",
    tab: "assistant",
    preferredAgent: null,
    stubs: {
      [CH.assistantGet]: { ...ASSISTANT_BASE, daintreeControl: false },
      [CH.mcpRuntime]: MCP_OFF,
      [CH.mcpStatus]: { enabled: false, port: null, apiKey: "" },
    },
    expectText: ["Choose an agent"],
    sweep: true,
  },
  {
    // Set up and in use: Claude chosen, MCP running, a non-default tier and bypass on.
    slug: "a02-signed-in",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: {
        ...ASSISTANT_BASE,
        tier: "system",
        bypassPermissions: true,
        customArgs: "--verbose",
        idleHibernateMinutes: 30,
      },
      [CH.mcpRuntime]: MCP_RUNNING,
      [CH.mcpStatus]: MCP_STATUS,
    },
    expectText: ["Running on port 45454"],
    sweep: true,
  },
  {
    // The tier's action inventory open.
    slug: "a03-disclosures-open",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: ASSISTANT_BASE,
      [CH.mcpRuntime]: MCP_RUNNING,
      [CH.mcpStatus]: MCP_STATUS,
    },
    act: async (page) => {
      await page.getByRole("button", { name: /What this tier allows/ }).click();
    },
  },
  {
    // The diagnostics disclosure open, scrolled into its own shot.
    slug: "a08-diagnostics-open",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: ASSISTANT_BASE,
      [CH.mcpRuntime]: MCP_RUNNING,
      [CH.mcpStatus]: MCP_STATUS,
    },
    act: async (page) => {
      await page.getByRole("button", { name: /Advanced diagnostics/ }).click();
    },
  },
  {
    slug: "a04-mcp-failed",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: ASSISTANT_BASE,
      [CH.mcpRuntime]: MCP_FAILED,
      [CH.mcpStatus]: MCP_STATUS,
    },
    expectText: ["EADDRINUSE"],
    sweep: true,
  },
  {
    slug: "a05-load-error",
    tab: "assistant",
    preferredAgent: "claude",
    faults: { [CH.assistantGet]: "EACCES: permission denied, open 'settings.json'" },
    stubs: { [CH.mcpRuntime]: MCP_RUNNING, [CH.mcpStatus]: MCP_STATUS },
    expectText: ["EACCES"],
    sweep: true,
  },
  {
    // A change that failed to save: the behaviour group carries the error and Retry.
    slug: "a06-save-error",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: ASSISTANT_BASE,
      [CH.mcpRuntime]: MCP_RUNNING,
      [CH.mcpStatus]: MCP_STATUS,
    },
    faults: { [CH.assistantSet]: "EROFS: read-only file system" },
    act: async (page) => {
      await page.locator("#assistant-doc-search").getByRole("switch").click();
    },
    expectText: ["Couldn't save that change"],
  },
  {
    // The chosen agent's CLI is too old, and a previously chosen agent was dropped.
    slug: "a07-agent-warnings",
    tab: "assistant",
    preferredAgent: "claude",
    stubs: {
      [CH.assistantGet]: ASSISTANT_BASE,
      [CH.mcpRuntime]: MCP_RUNNING,
      [CH.mcpStatus]: MCP_STATUS,
      [CH.agentVersion]: { installedVersion: "0.0.1" },
    },
  },
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-assistant-voice-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

async function openSettingsAt(page: Page, tab: string): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    { tab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem(tab))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
}

/** Seed (or clear) the help panel's persisted preferred agent, merged into what is there. */
async function seedPreferredAgent(page: Page, agentId: string | null): Promise<void> {
  await page.evaluate((id) => {
    const key = "help-panel-storage";
    let blob: { state?: Record<string, unknown>; version?: number };
    try {
      blob = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    } catch {
      blob = {};
    }
    blob.state = { ...(blob.state ?? {}), preferredAgentId: id };
    blob.version = blob.version ?? 6;
    window.localStorage.setItem(key, JSON.stringify(blob));
  }, agentId);
}

/** Reload the project view so every tab and store mounts fresh against the new stubs. */
async function reloadRenderer(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator('[aria-label="Toggle Sidebar"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  await dismissBlockingPalette(page);
  await page.addStyleTag({ content: POLISH_CSS });
  await settle(page, 500);
}

async function tagScroller(
  page: Page,
  tab: string
): Promise<{ scrollHeight: number; clientHeight: number }> {
  return page.evaluate((panelId) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const panel = document.getElementById(panelId);
    if (!panel) throw new Error(`no panel #${panelId}`);
    let el: HTMLElement | null = panel.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the tab panel");
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, `settings-panel-${tab}`);
}

interface ManifestEntry {
  file: string;
  slug: string;
  slice: number;
  slices: number;
}

const failures: string[] = [];
const manifest: ManifestEntry[] = [];

async function capture(page: Page, state: ShotState): Promise<void> {
  const { scrollHeight, clientHeight } = await tagScroller(page, state.tab);
  await settle(page, 250);
  const step = Math.max(200, Math.floor(clientHeight * 0.85));
  const total = Math.min(
    MAX_SLICES,
    Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1)
  );
  for (let i = 0; i < total; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * step);
    await settle(page, 200);
    const file = `${state.slug}--p${i + 1}--${THEME_SLUG}.png`;
    await page
      .locator(CARD)
      .first()
      .screenshot({
        path: path.join(OUTPUT_DIR, file),
        type: "png",
        animations: "disabled",
        caret: "hide",
      });
    manifest.push({ file, slug: state.slug, slice: i + 1, slices: total });
  }
}

async function verifyText(page: Page, state: ShotState): Promise<void> {
  const panel = page.locator(`${DIALOG} #settings-panel-${state.tab}`);
  for (const text of state.expectText ?? []) {
    await expect(panel.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  }
  for (const text of state.expectNoText ?? []) {
    await expect(panel.getByText(text, { exact: false })).toHaveCount(0);
  }
}

test("assistant and voice settings — every design-bearing state", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANT_VOICE is required for this capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_ASSISTANT_VOICE to run the assistant/voice capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(20 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-assistantvoiceshot-"));
  let ctx: AppContext | undefined;

  const planned = STATES.filter(
    (s) => (ONLY.length === 0 || ONLY.includes(s.slug)) && (!SWEEP_ONLY || s.sweep)
  );

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const { app } = ctx;
    await setWindowSize(app, WIDE);

    const page = await openAndOnboardProject(app, ctx.window, repo.dir, PROJECT_NAME);
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 600);

    for (const state of planned) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const before = manifest.length;
        try {
          await closeSettings(page);
          await clearAllFaults(app);
          for (const [channel, value] of Object.entries(state.stubs ?? {})) {
            await injectStub(app, channel, value);
          }
          for (const [channel, message] of Object.entries(state.faults ?? {})) {
            await injectFault(app, channel, message);
          }
          if (state.preferredAgent !== undefined) {
            await seedPreferredAgent(page, state.preferredAgent);
          }
          await reloadRenderer(page);
          await openSettingsAt(page, state.tab);
          await settle(page, 1200);
          if (state.act) {
            await state.act(page);
            await settle(page, 800);
          }
          await verifyText(page, state);
          await capture(page, state);
          break;
        } catch (error) {
          manifest.splice(before);
          if (attempt === 2) failures.push(`${state.slug}: ${String(error).slice(0, 400)}`);
        }
      }
    }
    await clearAllFaults(app);
    await closeSettings(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  const captured = new Set(manifest.map((m) => m.slug));
  const uncaptured = planned.filter((s) => !captured.has(s.slug)).map((s) => s.slug);
  console.log(
    `[assistant-voice-shots] ${manifest.length - missing.length}/${manifest.length} PNGs, ${captured.size}/${planned.length} states → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (uncaptured.length > 0) failures.push(`states not captured: ${uncaptured.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`assistant/voice capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
