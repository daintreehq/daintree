/**
 * Settings → CLI agents visual-review harness.
 *
 * The CLI agents page is where a user goes when an agent is missing, will not run, or
 * needs its launch changed, so its design questions are about states: does an installed
 * agent read differently from a missing one and from one that is installed but blocked,
 * does the scope editor say which preset it is editing, can a user tell a read-only
 * preset from their own. Those can only be judged on rendered pixels, across every
 * state the page carries weight in, so this harness drives each of them.
 *
 * Every state goes through a real seam:
 *   - navigation via the `daintree:open-settings-tab` deep link, `subtab` picking the
 *     agent;
 *   - agent availability and CLI details by stubbing the `system:*` IPC channels the
 *     detector answers on, so the page renders a mixed machine — ready, missing,
 *     unauthenticated and blocked agents — whatever this host has installed;
 *   - help output by stubbing `agent-help:get`, so the loaded state is deterministic;
 *   - presets through the real stores: custom presets written with
 *     `agentSettings.set`, a project preset as a `.daintree/presets/claude/*.json` file
 *     in the fixture repo, and a CCR route through the isolated CCR config file;
 *   - plugin agent tools by stubbing `plugin-agent-mcp:list-project-endpoints`.
 * Everything above the IPC boundary is shipping code.
 *
 *   DAINTREE_SHOT_AGENTS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots agent-settings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AGENTS      required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME       optional theme id (default: the app default)
 *   DAINTREE_SHOT_ONLY        comma-separated state filter (slugs below)
 *   DAINTREE_SHOT_MAX_SLICES  slice cap per page (default 6)
 *
 * A manifest.json beside the PNGs lists every file written, and the run fails unless
 * the files on disk match it and every planned state landed.
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
import { injectStub } from "../helpers/ipcFaults";
import { writeCcrConfig, removeCcrConfig } from "../helpers/presets";

const ENABLED = !!process.env.DAINTREE_SHOT_AGENTS;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const MAX_SLICES = Number(process.env.DAINTREE_SHOT_MAX_SLICES ?? "6");
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const PANEL = "#settings-panel-agents";
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

/** Every state the page can render for an agent, spread across the roster. */
const MIXED_AVAILABILITY: Record<string, string> = {
  claude: "ready",
  opencode: "unauthenticated",
  gemini: "ready",
  antigravity: "ready",
  codex: "ready",
  grok: "ready",
  cursor: "unauthenticated",
  goose: "ready",
  kimi: "ready",
  amp: "ready",
  crush: "blocked",
  aider: "ready",
  copilot: "missing",
  interpreter: "missing",
  kiro: "missing",
  mistral: "missing",
  qwen: "missing",
};

const CLI_DETAILS: Record<string, unknown> = {
  claude: { state: "ready", resolvedPath: "/opt/homebrew/bin/claude", via: "which" },
  opencode: {
    state: "unauthenticated",
    resolvedPath: "/Users/dev/.local/bin/opencode",
    via: "which",
    authConfirmed: false,
  },
  crush: {
    state: "blocked",
    resolvedPath: "/usr/local/bin/crush",
    via: "which",
    blockReason: "security",
    message:
      "macOS blocked this binary from running. Allow it in System Settings → Privacy & Security, then re-check.",
  },
};

const CLAUDE_HELP = {
  stdout: [
    "Usage: claude [options] [command] [prompt]",
    "",
    "Claude Code - starts an interactive session by default, use -p/--print for",
    "non-interactive output",
    "",
    "Options:",
    "  -d, --debug [filter]              Enable debug mode with optional category filtering",
    "  --verbose                         Override verbose mode setting from config",
    "  -p, --print                       Print response and exit (useful for pipes)",
    "  --output-format <format>          Output format: text, json, stream-json",
    "  --model <model>                   Model for the current session",
    "  --permission-mode <mode>          Permission mode to use for the session",
    "  --dangerously-skip-permissions    Bypass all permission checks",
    "  --add-dir <directories...>        Additional directories to allow tool access to",
    "  --mcp-config <configs...>         Load MCP servers from JSON files or strings",
    "  -c, --continue                    Continue the most recent conversation",
    "  -r, --resume [sessionId]          Resume a conversation",
    "  -v, --version                     Output the version number",
    "  -h, --help                        Display help for command",
  ].join("\n"),
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

const AGENT_TOOLS = {
  mcpServerEnabled: false,
  endpoints: [
    {
      pluginInstanceId: "linear-tools",
      pluginDisplayName: "Linear",
      endpointId: "issues",
      name: "Issue tracker",
      description: "Read, create and update Linear issues for this project's team",
      enabled: true,
      available: true,
    },
    {
      pluginInstanceId: "project__design-tokens",
      pluginDisplayName: "Design tokens",
      endpointId: "tokens",
      name: "Token lookup",
      description: "Resolve a design token name to its value in every theme",
      enabled: false,
      available: true,
    },
    {
      pluginInstanceId: "sentry",
      pluginDisplayName: "Sentry",
      endpointId: "errors",
      name: "Error search",
      enabled: true,
      available: false,
    },
  ],
};

const CUSTOM_PRESETS = [
  {
    id: "user-bedrock",
    name: "Sonnet via Bedrock",
    color: "#61afef",
    env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" },
    customFlags: "--model sonnet",
    dangerousMode: "off",
    fallbacks: ["user-vertex", "user-deleted-route"],
  },
  {
    id: "user-vertex",
    name: "Opus via Vertex",
    env: { CLAUDE_CODE_USE_VERTEX: "1" },
  },
];

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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-agent-settings-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".daintree", "presets", "claude"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  writeFileSync(
    path.join(dir, ".daintree", "presets", "claude", "team-review.json"),
    JSON.stringify(
      {
        id: "team-review",
        name: "Team review",
        description: "Read-only reviewer the whole team shares for pull request passes",
        env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16000" },
        dangerousMode: "off",
      },
      null,
      2
    )
  );
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

async function openSettingsAt(page: Page, target: { tab: string; subtab?: string }) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
  }, target);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem(target.tab))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(CLOSE)
    .click({ timeout: 3000 })
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

async function selectPreset(page: Page, optionTestId: string): Promise<void> {
  await page.locator(`${PANEL} [data-testid="preset-selector-trigger"]`).click();
  const option = page.locator(`[data-testid="${optionTestId}"]`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await settle(page, 500);
}

interface ManifestEntry {
  file: string;
  state: string;
  slice: number;
  slices: number;
}

const failures: string[] = [];
const manifest: ManifestEntry[] = [];

async function tagScroller(page: Page, panelId: string) {
  return page.evaluate((id) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const panel = document.getElementById(id);
    if (!panel) throw new Error(`no panel #${id}`);
    let el: HTMLElement | null = panel.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the tab panel");
    el.setAttribute("data-shot-scroller", "");
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, panelId);
}

async function shoot(page: Page, file: string): Promise<void> {
  await page
    .locator(CARD)
    .first()
    .screenshot({
      path: path.join(OUTPUT_DIR, file),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
}

/** The page sliced top to bottom down the real scrollport. */
async function capturePage(page: Page, slug: string, panelId: string): Promise<void> {
  const { scrollHeight, clientHeight } = await tagScroller(page, panelId);
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
    const file = `${slug}--p${i + 1}--${THEME_SLUG}.png`;
    await shoot(page, file);
    manifest.push({ file, state: slug, slice: i + 1, slices: total });
  }
}

/** One frame, scrolled so `anchor` sits in view — for popovers and dialogs. */
async function captureFrame(page: Page, slug: string): Promise<void> {
  await settle(page, 300);
  const file = `${slug}--${THEME_SLUG}.png`;
  await shoot(page, file);
  manifest.push({ file, state: slug, slice: 1, slices: 1 });
}

async function scrollIntoView(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ block: "start" });
  }, selector);
  await settle(page, 200);
}

interface AgentState {
  slug: string;
  target: { tab: string; subtab?: string };
  /** Text that must be visible in the dialog before anything is written. */
  expectText: string[];
  arrange?: (page: Page) => Promise<void>;
  capture: "page" | "frame";
  panelId?: string;
}

const STATES: AgentState[] = [
  {
    slug: "01-general",
    target: { tab: "agents", subtab: "general" },
    expectText: ["Default agent"],
    capture: "page",
  },
  {
    slug: "01b-general-inventory-expanded",
    target: { tab: "agents", subtab: "general" },
    expectText: ["need attention"],
    arrange: async (page) => {
      for (const name of [/ready agents?$/, /installed$/]) {
        await page.locator(PANEL).getByRole("button", { name }).first().click();
      }
      await expect(page.locator(PANEL).getByText("Hide ready agents")).toBeVisible();
    },
    capture: "page",
  },
  {
    slug: "02-selector-open",
    target: { tab: "agents", subtab: "general" },
    expectText: ["Default agent"],
    arrange: async (page) => {
      await page.locator(`${PANEL} [data-testid="agent-selector-trigger"]`).click();
      await page.locator("#agent-selector-list").waitFor({ state: "visible", timeout: 10_000 });
    },
    capture: "frame",
  },
  {
    slug: "03-claude-ready-default",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Claude", "Launch preset"],
    capture: "page",
  },
  {
    slug: "04-claude-help-loaded",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Help output"],
    arrange: async (page) => {
      await page.locator(PANEL).getByRole("button", { name: "Load", exact: true }).click();
      await expect(page.locator(PANEL).getByText("--dangerously-skip-permissions")).toBeVisible({
        timeout: 10_000,
      });
      await scrollIntoView(page, `${PANEL} pre`);
    },
    capture: "frame",
  },
  {
    slug: "05-preset-selector-open",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await scrollIntoView(page, "#agents-presets");
      await page.locator(`${PANEL} [data-testid="preset-selector-trigger"]`).click();
      await page
        .locator('[data-testid="preset-selector-listbox"]')
        .waitFor({ state: "visible", timeout: 10_000 });
    },
    capture: "frame",
  },
  {
    slug: "05b-preset-selector-keyboard",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await scrollIntoView(page, "#agents-presets");
      const trigger = page.locator(`${PANEL} [data-testid="preset-selector-trigger"]`);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page
        .locator('[data-testid="preset-selector-listbox"]')
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
    },
    capture: "frame",
  },
  {
    slug: "06-claude-custom-preset",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await selectPreset(page, "preset-option-user-bedrock");
      await expect(page.locator(PANEL).getByText("Fallback presets")).toBeVisible();
    },
    capture: "page",
  },
  {
    slug: "06b-delete-preset-confirm",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await page
        .locator(PANEL)
        .getByRole("button", { name: /^Delete / })
        .first()
        .click();
      await expect(page.getByRole("button", { name: "Delete preset", exact: true })).toBeVisible({
        timeout: 10_000,
      });
    },
    capture: "frame",
  },
  {
    slug: "07-add-preset-dialog",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await page.locator(`${PANEL} [data-testid="preset-add-button"]`).click();
      await page
        .locator('[data-testid="add-preset-dialog"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
    },
    capture: "frame",
  },
  {
    slug: "08-claude-project-preset",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await selectPreset(page, "preset-option-project-team-review");
      await expect(
        page.locator(PANEL).getByText("Read-only", { exact: false }).first()
      ).toBeVisible();
      await scrollIntoView(page, "#agents-presets");
    },
    capture: "frame",
  },
  {
    slug: "09-claude-ccr-preset",
    target: { tab: "agents", subtab: "claude" },
    expectText: ["Launch preset"],
    arrange: async (page) => {
      await selectPreset(page, "preset-option-ccr-openrouter-sonnet");
      await expect(
        page.locator(PANEL).getByText("Read-only", { exact: false }).first()
      ).toBeVisible();
      await scrollIntoView(page, "#agents-presets");
      // Put the scope back so later boots start from Default.
    },
    capture: "frame",
  },
  {
    slug: "10-opencode-unauthenticated",
    target: { tab: "agents", subtab: "opencode" },
    expectText: ["OpenCode"],
    capture: "page",
  },
  {
    slug: "11-crush-blocked",
    target: { tab: "agents", subtab: "crush" },
    expectText: ["couldn't run"],
    capture: "page",
  },
  {
    slug: "12-copilot-missing",
    target: { tab: "agents", subtab: "copilot" },
    expectText: ["Not installed"],
    capture: "page",
  },
  {
    slug: "13-project-agent-tools",
    target: { tab: "project:plugins" },
    expectText: ["Agent tools"],
    arrange: async (page) => {
      await scrollIntoView(page, '[data-testid="project-agent-tools"]');
    },
    capture: "frame",
  },
];

test("CLI agents settings review — roster, scope editor, presets, install and help states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AGENTS is required for the CLI agents settings capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_AGENTS to run the CLI agents settings capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-agentsettingsshot-"));
  let ctx: AppContext | undefined;
  const planned = STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.slug));
  const landed = new Set<string>();

  writeCcrConfig([
    {
      id: "openrouter-sonnet",
      name: "OpenRouter Sonnet",
      model: "anthropic/claude-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  ]);

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
    });
    await setWindowSize(ctx.app, WIDE);

    const app = ctx.app;
    await injectStub(app, "system:get-cli-availability", MIXED_AVAILABILITY);
    await injectStub(app, "system:refresh-cli-availability", MIXED_AVAILABILITY);
    await injectStub(app, "system:get-agent-cli-details", CLI_DETAILS);
    await injectStub(app, "agent-help:get", CLAUDE_HELP);
    await injectStub(app, "plugin-agent-mcp:list-project-endpoints", AGENT_TOOLS);

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    await page.evaluate(async (presets) => {
      type Entry = Record<string, unknown>;
      const settings = (await window.electron.agentSettings.get()) as {
        agents?: Record<string, Entry | undefined>;
      };
      const entry = settings.agents?.claude ?? {};
      await window.electron.agentSettings.set("claude", {
        ...entry,
        customPresets: presets,
        presetId: undefined,
      } as never);
      window.localStorage.removeItem("daintree:cliAvailability:v3");
    }, CUSTOM_PRESETS);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('[aria-label="Toggle Sidebar"]')
      .waitFor({ state: "visible", timeout: 30_000 });
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 800);

    for (const state of planned) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const before = manifest.length;
        try {
          await closeSettings(page);
          await openSettingsAt(page, state.target);
          await settle(page, 900);
          for (const text of state.expectText) {
            await expect(
              page
                .locator(DIALOG)
                .getByText(text, { exact: false })
                .filter({ visible: true })
                .first(),
              `${state.slug}: expected "${text}" on screen`
            ).toBeVisible({ timeout: 15_000 });
          }
          if (state.arrange) await state.arrange(page);
          await settle(page, 400);
          if (state.capture === "page") {
            const tab = state.target.tab;
            await capturePage(page, state.slug, state.panelId ?? `settings-panel-${tab}`);
          } else {
            await captureFrame(page, state.slug);
          }
          landed.add(state.slug);
          break;
        } catch (error) {
          manifest.splice(before);
          if (attempt === 2) failures.push(`${state.slug}: ${String(error).slice(0, 400)}`);
        }
      }
    }

    // Leave Claude on its Default scope — the next boot shares nothing, but a rerun of
    // one state against a reused profile should not start inside a preset.
    await closeSettings(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    removeCcrConfig();
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  const unlanded = planned.filter((s) => !landed.has(s.slug)).map((s) => s.slug);
  console.log(
    `[agent-settings-shots] ${manifest.length - missing.length}/${manifest.length} PNGs, ${landed.size}/${planned.length} states → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (unlanded.length > 0) failures.push(`states that never landed: ${unlanded.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`agent-settings capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
