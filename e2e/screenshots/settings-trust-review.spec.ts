/**
 * Settings trust, data and diagnostics pages — populated and empty, plus the dialogs
 * those pages open.
 *
 * `settings-pages-review.spec.ts` walks every tab of a fresh profile, which is the
 * right view of the page grammar but shows every log on these pages empty: no MCP
 * dispatches, no plugin actions, no runs. The pages exist to be read when something
 * went wrong, so the populated state is the one that matters. This companion seeds
 * the real stores and walks only these tabs:
 *
 *   - the audit rings (`mcpAuditLog`, `mcpTurnOutcomeLog`, `pluginAuditLog`,
 *     `runHistoryRecords`) are written into the profile's `daintree.db` between an
 *     init launch and the capture launch, so the services hydrate them the way they
 *     hydrate a real profile;
 *   - the MCP server is enabled through its own switch, and a real client connects
 *     over streamable HTTP with the server's key, so the external-client list and its
 *     audit rows come from the server itself;
 *   - clears go through the real confirm dialogs, which is also how the empty-log
 *     states are reached.
 *
 *   DAINTREE_SHOT_SETTINGS_TRUST=1 DAINTREE_SHOT_DIR=/tmp/x \
 *     npx playwright test --project=screenshots settings-trust-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SETTINGS_TRUST  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME           optional theme id (default: the app default)
 *
 * Needs the `sqlite3` CLI (stock on macOS). A manifest.json beside the PNGs lists
 * every file written, and the run fails unless the files on disk match it.
 */

import { test, expect, type Page, type Locator, type ElectronApplication } from "@playwright/test";
import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_SETTINGS_TRUST;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };
const LAUNCH_ARGS = ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"];

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

type Ring = "mcpAuditLog" | "mcpTurnOutcomeLog" | "pluginAuditLog" | "runHistoryRecords";

function buildFixtures(now: number): Record<Ring, Record<string, unknown>[]> {
  const helpA = "help-7f3a";
  const helpB = "help-19c2";
  const audit = (
    id: string,
    agoMs: number,
    toolId: string,
    result: string,
    durationMs: number,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    timestamp: now - agoMs,
    startedAt: now - agoMs - durationMs,
    toolId,
    sessionId: extra.helpSessionId ? `mcp-${extra.helpSessionId as string}` : "mcp-ext-01",
    tier: extra.helpSessionId ? "workbench" : "external",
    argsSummary: "{}",
    result,
    durationMs,
    ...extra,
  });

  const mcpAuditLog = [
    audit("a01", 26 * HOUR, "worktree.list", "success", 42, {
      argsSummary: '{"projectId":"<id>"}',
    }),
    audit("a02", 3 * HOUR, "terminal.getOutput", "success", 184, {
      argsSummary: '{"terminalId":"<id>","lines":200}',
      helpSessionId: helpA,
      turnId: "turn-1",
    }),
    audit("a03", 3 * HOUR - 20_000, "terminal.sendKeys", "unauthorized", 3, {
      argsSummary: '{"terminalId":"<id>","keys":"<redacted:24 chars>"}',
      helpSessionId: helpA,
      turnId: "turn-1",
      tierHint: "action",
    }),
    audit("a04", 2 * HOUR, "git.getDiff", "error", 2410, {
      argsSummary:
        '{"worktreeId":"<id>","staged":false,"paths":["src/components/Settings/McpServerSettingsTab.tsx"]}',
      helpSessionId: helpA,
      turnId: "turn-2",
      errorCode: "TIMEOUT",
    }),
    audit("a05", 2 * HOUR - 30_000, "git.getDiff", "success", 6120, {
      argsSummary: '{"worktreeId":"<id>","staged":false}',
      helpSessionId: helpA,
      turnId: "turn-2",
    }),
    audit("a06", 90 * MIN, "app.settings.set", "unauthorized", 2, {
      argsSummary: '{"key":"<redacted>"}',
      helpSessionId: helpB,
      turnId: "turn-3",
      tierHint: null,
    }),
    audit("a07", 40 * MIN, "terminal.list", "success", 12),
    audit("a08", 38 * MIN, "terminal.list", "dedup", 1),
    audit("a09", 20 * MIN, "project.getSettings", "rate_limited", 1, {
      resultMeta: { retryAfter: 12 },
    }),
    audit("a10", 12 * MIN, "action.dispatch", "confirmation-pending", 640, {
      argsSummary: '{"actionId":"worktree.delete","args":{"worktreeId":"<id>"}}',
      helpSessionId: helpB,
      turnId: "turn-4",
    }),
    audit("a11", 11 * MIN, "terminal.getOutput", "success", 96, {
      argsSummary: '{"terminalId":"<id>","lines":50}',
      helpSessionId: helpB,
      turnId: "turn-4",
    }),
    audit("a12", 4 * MIN, "worktree.create", "collision", 4, {
      argsSummary: '{"branch":"feature/settings-trust-review-long-branch-name","base":"develop"}',
    }),
    {
      type: "grant.issued",
      id: "g01",
      timestamp: now - 12 * MIN + 5_000,
      sessionId: `mcp-${helpB}`,
      toolId: "action.dispatch",
      ttlMs: 15 * MIN,
      expiresAt: now + 3 * MIN,
    },
    {
      type: "tier.elevated",
      id: "g02",
      timestamp: now - 3 * HOUR + 60_000,
      sessionId: `mcp-${helpA}`,
      toolId: "terminal.sendKeys",
      ttlMs: 10 * MIN,
      tier: "action",
      previousTier: "workbench",
    },
    {
      type: "grant.revoked",
      id: "g03",
      timestamp: now - 7 * MIN,
      sessionId: "mcp-orphan",
      toolId: "worktree.delete",
      ttlMs: 15 * MIN,
      revokedReason: "user",
    },
  ];

  const turn = (
    id: string,
    agoMs: number,
    outcome: string,
    sessionId: string | null,
    turnId?: string
  ) => ({ id, timestamp: now - agoMs, terminalId: "term-help", sessionId, outcome, turnId });

  const mcpTurnOutcomeLog = [
    turn("t01", 3 * HOUR - 10_000, "tier-rejected", helpA, "turn-1"),
    turn("t02", 2 * HOUR - 10_000, "tool-error", helpA, "turn-2"),
    turn("t03", 90 * MIN - 5_000, "refused", helpB, "turn-3"),
    turn("t04", 11 * MIN - 5_000, "answered", helpB, "turn-4"),
    turn("t05", 9 * MIN, "answered", helpB),
    turn("t06", 6 * MIN, "agent-stuck", helpA),
    turn("t07", 5 * MIN, "hedged", helpB),
    turn("t08", 2 * MIN, "mcp-not-ready", null),
  ];

  const plugin = (
    id: string,
    agoMs: number,
    pluginId: string,
    actionId: string,
    result: string,
    durationMs: number,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    ts: now - agoMs,
    pluginId,
    actionId,
    recordType: "action-dispatch",
    source: "user",
    argsHash: "9f2c4e81a07b3d56e2f1c8a94b0d7e3f5a6c1b2d3e4f5a6b7c8d9e0f1a2b3c4d",
    durationMs,
    result,
    ...extra,
  });

  const pluginAuditLog = [
    plugin("p01", 5 * HOUR, "daintree.github", "github.openPullRequest", "success", 212),
    plugin("p02", 4 * HOUR, "daintree.github", "github.syncIssues", "error", 30_012, {
      errorMessage:
        "Request to api.github.com timed out after 30s while listing issues for daintreehq/daintree — check your network or proxy settings",
    }),
    plugin("p03", 2 * HOUR, "acme.linear-bridge", "linear.createIssue", "restricted", 1, {
      source: "agent",
      errorMessage: "Blocked: this action needs the network capability, which you haven't granted",
    }),
    plugin("p04", 50 * MIN, "acme.linear-bridge", "linear.refresh", "disabled", 0, {
      source: "keybinding",
    }),
    plugin("p05", 30 * MIN, "daintree.github", "plugin:invoke", "error", 4, {
      recordType: "ipc-invoke",
      source: undefined,
      channel: "plugin:invoke",
      argsHash: "",
      errorMessage: "Untrusted sender",
    }),
    plugin("p06", 8 * MIN, "acme.git-lens", "git-lens.fileBadges", "error", 2000, {
      recordType: "decoration-failure",
      source: undefined,
      errorMessage: "Provider timed out after 2000ms",
    }),
    plugin("p07", 3 * MIN, "daintree.github", "github.openPullRequest", "success", 188),
  ];

  const runHistoryRecords = [
    {
      id: "r01",
      schemaVersion: 1,
      kind: "recipe",
      timestamp: now - 26 * HOUR,
      recipeName: "Full-stack dev",
      worktreeName: "develop",
      totalTerminals: 4,
      spawned: [
        { index: 0, terminalId: "t-a", title: "Vite" },
        { index: 1, terminalId: "t-b", title: "API" },
        { index: 2, terminalId: "t-c", title: "Claude" },
        { index: 3, terminalId: "t-d", title: "Tests" },
      ],
      failed: [],
    },
    {
      id: "r02",
      schemaVersion: 1,
      kind: "fleet",
      timestamp: now - 3 * HOUR,
      draftPreview:
        "Rebase onto develop, run the full test suite, and report anything that fails with the file and line",
      targetCount: 5,
      successCount: 3,
      failureCount: 2,
      cancelled: false,
      status: "completed",
      perTarget: [
        {
          terminalId: "f1",
          title: "Claude · settings-trust",
          status: "fulfilled",
          finalAgentState: "waiting",
        },
        { terminalId: "f2", title: "Codex · settings-general", status: "fulfilled" },
        { terminalId: "f3", title: "Claude · settings-shell", status: "fulfilled" },
        {
          terminalId: "f4",
          title: "Gemini · docs",
          status: "rejected",
          reason: "Terminal exited",
          failureKind: "permanent",
        },
        {
          terminalId: "f5",
          title: "Claude · flaky",
          status: "rejected",
          reason: "Write timed out after 5s",
          failureKind: "transient",
        },
      ],
    },
    {
      id: "r03",
      schemaVersion: 1,
      kind: "fleet",
      timestamp: now - 2 * HOUR - 50 * MIN,
      draftPreview: "Rebase onto develop, run the full test suite, and report anything that fails",
      targetCount: 1,
      successCount: 1,
      failureCount: 0,
      cancelled: false,
      status: "completed",
      isRetry: true,
      perTarget: [{ terminalId: "f5", title: "Claude · flaky", status: "fulfilled" }],
    },
    {
      id: "r04",
      schemaVersion: 1,
      kind: "recipe",
      timestamp: now - 40 * MIN,
      recipeName: "Review stack",
      worktreeName: "feature/settings-trust-review",
      totalTerminals: 3,
      spawned: [{ index: 0, terminalId: "t-e", title: "Claude" }],
      failed: [
        { index: 1, error: "Command not found: codex" },
        { index: 2, error: "Working directory no longer exists" },
      ],
    },
    {
      id: "r05",
      schemaVersion: 1,
      kind: "fleet",
      timestamp: now - 6 * MIN,
      draftPreview: "Stop and summarise what you changed",
      targetCount: 4,
      successCount: 0,
      failureCount: 0,
      cancelled: true,
      status: "cancelled",
      perTarget: [],
    },
  ];

  // Rings are append-only, so a real profile holds them oldest first.
  const byTime =
    (key: "timestamp" | "ts") => (a: Record<string, unknown>, b: Record<string, unknown>) =>
      (a[key] as number) - (b[key] as number);
  return {
    mcpAuditLog: mcpAuditLog.sort(byTime("timestamp")),
    mcpTurnOutcomeLog: mcpTurnOutcomeLog.sort(byTime("timestamp")),
    pluginAuditLog: pluginAuditLog.sort(byTime("ts")),
    runHistoryRecords: runHistoryRecords.sort(byTime("timestamp")),
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function seedAuditRings(userDataDir: string): void {
  const db = path.join(userDataDir, "daintree.db");
  if (!existsSync(db)) throw new Error(`init launch left no database at ${db}`);
  const tables = execFileSync("sqlite3", [db, "SELECT name FROM sqlite_master WHERE type='table';"])
    .toString()
    .split("\n");
  if (!tables.includes("audit_rings")) throw new Error("daintree.db has no audit_rings table");

  const fixtures = buildFixtures(Date.now());
  const lines = ["BEGIN;"];
  for (const [ring, records] of Object.entries(fixtures)) {
    lines.push(`DELETE FROM audit_rings WHERE ring = ${sqlString(ring)};`);
    for (const record of records) {
      lines.push(
        `INSERT INTO audit_rings (ring, record, created_at) VALUES (${sqlString(ring)}, ${sqlString(JSON.stringify(record))}, ${Date.now()});`
      );
    }
  }
  lines.push("COMMIT;");
  execFileSync("sqlite3", [db], { input: lines.join("\n") });

  for (const [ring, records] of Object.entries(fixtures)) {
    const count = Number(
      execFileSync("sqlite3", [
        db,
        `SELECT COUNT(*) FROM audit_rings WHERE ring = ${sqlString(ring)};`,
      ])
        .toString()
        .trim()
    );
    if (count !== records.length)
      throw new Error(`seeded ${count}/${records.length} rows into ${ring}`);
  }
}

// ── Plumbing (mirrors settings-pages-review) ─────────────────────────────────

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-settings-trust-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(app: ElectronApplication, size: typeof WIDE): Promise<void> {
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
  await settle(page, 700);
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

async function reopenSettingsAt(page: Page, target: { tab: string; subtab?: string }) {
  await closeSettings(page);
  await openSettingsAt(page, target);
}

function panel(tab: string): string {
  return `${DIALOG} #settings-panel-${tab.replace(/:/g, "\\:")}`;
}

/** Tags the element that scrolls the active page, as settings-pages-review does. */
async function tagScroller(page: Page, tab: string) {
  return page.evaluate((panelId) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const p = document.getElementById(panelId);
    if (!p) throw new Error(`no panel #${panelId}`);
    let el: HTMLElement | null = p.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the tab panel");
    el.setAttribute("data-shot-scroller", "");
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, `settings-panel-${tab}`);
}

interface ManifestEntry {
  file: string;
  state: string;
}
const manifest: ManifestEntry[] = [];
const failures: string[] = [];

async function writeShot(page: Page, state: string, target: "card" | "window"): Promise<void> {
  const file = `${state}--${THEME_SLUG}.png`;
  await settle(page, 250);
  const locator = target === "card" ? page.locator(CARD).first() : page.locator("body");
  await locator.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
  manifest.push({ file, state });
}

/** The whole page, in viewport slices down the scrollport. */
async function capturePage(page: Page, tab: string, state: string, maxSlices = 8) {
  const { scrollHeight, clientHeight } = await tagScroller(page, tab);
  const step = Math.max(200, Math.floor(clientHeight * 0.85));
  const total = Math.min(
    maxSlices,
    Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1)
  );
  for (let i = 0; i < total; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * step);
    await writeShot(page, `${state}.p${i + 1}`, "card");
  }
}

/** One frame with `target` scrolled to the top of the page's scrollport. */
async function captureAt(page: Page, tab: string, target: Locator, state: string) {
  await tagScroller(page, tab);
  await target.first().waitFor({ state: "visible", timeout: 10_000 });
  await target.first().evaluate((el) => {
    const scroller = document.querySelector<HTMLElement>("[data-shot-scroller]");
    if (!scroller) throw new Error("no tagged scroller");
    const top =
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - 24);
  });
  await writeShot(page, state, "card");
}

/**
 * Confirms a ConfirmDialog and proves it closed. A confirm that leaves its dialog up
 * would otherwise be captured as the "empty" state behind a scrim.
 */
async function confirmAndClose(page: Page, confirmLabel: string, state: string) {
  // The Settings dialog is a dialog too, and holds the button that opened this one.
  const dialog = page
    .locator('[role="dialog"]:not(:has(.settings-sidebar)), [role="alertdialog"]')
    .filter({ has: page.getByRole("button", { name: confirmLabel, exact: true }) });
  await dialog.last().waitFor({ state: "visible", timeout: 10_000 });
  await writeShot(page, state, "window");
  await dialog.last().getByRole("button", { name: confirmLabel, exact: true }).click();
  try {
    await dialog.last().waitFor({ state: "hidden", timeout: 8_000 });
  } catch {
    await page.keyboard.press("Escape");
    throw new Error(`"${confirmLabel}" left its confirm dialog open`);
  }
  await settle(page, 500);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const before = manifest.length;
  try {
    await fn();
  } catch (error) {
    manifest.splice(before);
    failures.push(`${name}: ${String(error).slice(0, 400)}`);
  }
}

// ── MCP client ───────────────────────────────────────────────────────────────

/** Connects like an external client would, so the server lists it and audits its call. */
async function connectExternalClient(page: Page): Promise<void> {
  const { port, apiKey } = await page.evaluate(async () => {
    const s = await window.electron.mcpServer.getStatus();
    return { port: s.port, apiKey: s.apiKey };
  });
  if (!port || !apiKey) throw new Error("MCP server has no port or key");
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "user-agent": "Cursor/1.7.2 (darwin arm64) mcp-client",
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor", version: "1.7.2" },
      },
    }),
  });
  if (!init.ok) throw new Error(`initialize → HTTP ${init.status}`);
  await init.text();
  const sid = init.headers.get("mcp-session-id");
  if (sid) headers["mcp-session-id"] = sid;
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  for (const [id, name] of [
    [2, "terminal.list"],
    [3, "worktree.list"],
  ] as const) {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    }).then((r) => r.text());
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

test("settings trust pages — populated, empty, and their dialogs", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SETTINGS_TRUST is required for the settings-trust capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SETTINGS_TRUST to run the settings-trust capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(20 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-settingstrustshot-"));
  let ctx: AppContext | undefined;

  try {
    // Init launch: the database and its migrations exist only once the app has run.
    ctx = await launchApp({ userDataDir, windowSize: WIDE, extraArgs: LAUNCH_ARGS });
    await closeApp(ctx.app);
    ctx = undefined;
    seedAuditRings(userDataDir);

    ctx = await launchApp({ userDataDir, windowSize: WIDE, extraArgs: LAUNCH_ARGS });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 600);

    // ── MCP server ──
    await step("mcp-off", async () => {
      await openSettingsAt(page, { tab: "mcp" });
      await capturePage(page, "mcp", "mcp.off");
    });

    await step("mcp-populated", async () => {
      await openSettingsAt(page, { tab: "mcp" });
      const toggle = page.locator(
        `${panel("mcp")} [role="switch"][aria-label="Enable MCP server"]`
      );
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
      await page
        .locator(`${panel("mcp")} >> text=/Running on port/`)
        .waitFor({ state: "visible", timeout: 30_000 });
      await connectExternalClient(page);
      // The tab reads bearers and records on mount; reopen so it sees the client.
      await reopenSettingsAt(page, { tab: "mcp" });
      const clients = page.locator(`${panel("mcp")} button:has-text("External clients")`);
      await clients.waitFor({ state: "visible", timeout: 15_000 });
      await clients.click();
      await capturePage(page, "mcp", "mcp.populated");
    });

    await step("mcp-grouped", async () => {
      await page.locator(`${panel("mcp")} button:has-text("Group by turn")`).click();
      await captureAt(
        page,
        "mcp",
        page.locator(`${panel("mcp")} input[aria-label="Filter audit by tool name"]`),
        "mcp.audit-grouped"
      );
      await page.locator(`${panel("mcp")} button:has-text("Group by turn")`).click();
    });

    await step("mcp-filtered-empty", async () => {
      const filter = page.locator(`${panel("mcp")} input[aria-label="Filter audit by tool name"]`);
      await filter.fill("no-such-tool");
      await captureAt(page, "mcp", filter, "mcp.audit-filtered-empty");
      await filter.fill("");
    });

    await step("mcp-turn-outcomes-open", async () => {
      const disclosures = page.locator(`${panel("mcp")} button[aria-expanded="false"]`, {
        hasText: /Outcomes by class|by tool the session used/,
      });
      const n = await disclosures.count();
      for (let i = 0; i < n; i++) await disclosures.first().click();
      await captureAt(
        page,
        "mcp",
        page.locator(`${panel("mcp")} button:has-text("Outcomes by class")`),
        "mcp.turn-outcomes-open"
      );
    });

    // ── Latency table: rendered only by the Assistant tab's advanced diagnostics, so read it before the MCP log is cleared ──
    await step("assistant-latency", async () => {
      await reopenSettingsAt(page, { tab: "assistant" });
      const advanced = page.locator(
        `${panel("assistant")} button:has-text("Advanced diagnostics")`
      );
      await advanced.waitFor({ state: "visible", timeout: 15_000 });
      if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
      await settle(page, 500);
      await captureAt(
        page,
        "assistant",
        page.locator(`${panel("assistant")} button:has-text("Latency by tool")`),
        "assistant.latency-table"
      );
    });

    await reopenSettingsAt(page, { tab: "mcp" });

    await step("mcp-clear-confirm", async () => {
      await page
        .locator(`${panel("mcp")} button:has-text("Clear audit log")`)
        .first()
        .click();
      await confirmAndClose(page, "Clear audit log", "mcp.clear-confirm");
      await captureAt(
        page,
        "mcp",
        page.locator(`${panel("mcp")} input[aria-label="Filter audit by tool name"]`),
        "mcp.audit-cleared"
      );
    });

    // ── Plugin actions ──
    await step("plugin-actions-populated", async () => {
      await openSettingsAt(page, { tab: "plugin-actions" });
      await capturePage(page, "plugin-actions", "plugin-actions.populated");
    });
    await step("plugin-actions-all-results", async () => {
      await page
        .locator(`${panel("plugin-actions")} select[aria-label="Filter audit by result"]`)
        .selectOption("success");
      await capturePage(page, "plugin-actions", "plugin-actions.success-filter", 1);
      await page
        .locator(`${panel("plugin-actions")} select[aria-label="Filter audit by result"]`)
        .selectOption("all");
    });
    await step("plugin-actions-clear", async () => {
      await page.locator(`${panel("plugin-actions")} button:has-text("Clear audit log")`).click();
      await confirmAndClose(page, "Clear audit log", "plugin-actions.clear-confirm");
      await capturePage(page, "plugin-actions", "plugin-actions.empty", 1);
    });

    // ── Run history ──
    await step("run-history-populated", async () => {
      await openSettingsAt(page, { tab: "run-history" });
      await capturePage(page, "run-history", "run-history.populated");
    });
    await step("run-history-clear", async () => {
      await page.locator(`${panel("run-history")} button:has-text("Clear history")`).click();
      await confirmAndClose(page, "Clear history", "run-history.clear-confirm");
      await capturePage(page, "run-history", "run-history.empty", 1);
    });

    // ── Privacy & data ──
    await step("privacy-telemetry", async () => {
      await openSettingsAt(page, { tab: "privacy", subtab: "telemetry" });
      await capturePage(page, "privacy", "privacy.telemetry");
    });
    await step("privacy-storage", async () => {
      await openSettingsAt(page, { tab: "privacy", subtab: "storage" });
      await capturePage(page, "privacy", "privacy.storage");
    });
    await step("privacy-clear-history-confirm", async () => {
      await page.locator(`${panel("privacy")} button:has-text("Clear history")`).click();
      const confirm = page
        .locator('[role="dialog"]:not(:has(.settings-sidebar)), [role="alertdialog"]')
        .filter({ has: page.getByRole("button", { name: "Clear history", exact: true }) });
      await confirm.last().waitFor({ state: "visible", timeout: 10_000 });
      await writeShot(page, "privacy.clear-history-confirm", "window");
      await confirm.last().getByRole("button", { name: "Cancel" }).click();
      await confirm.last().waitFor({ state: "hidden", timeout: 8_000 });
      await settle(page, 400);
    });
    await step("privacy-reset-confirm", async () => {
      await page.locator(`${panel("privacy")} button:has-text("Reset all data")`).click();
      const confirm = page
        .locator('[role="dialog"]:not(:has(.settings-sidebar)), [role="alertdialog"]')
        .filter({ has: page.getByRole("button", { name: "Reset and restart", exact: true }) });
      await confirm.last().waitFor({ state: "visible", timeout: 10_000 });
      await writeShot(page, "privacy.reset-confirm", "window");
      await confirm.last().getByRole("button", { name: "Cancel" }).click();
      await confirm.last().waitFor({ state: "hidden", timeout: 8_000 });
    });
    await step("privacy-shorten-retention-confirm", async () => {
      await page
        .getByRole("radiogroup", { name: "Keep session history for" })
        .getByRole("radio", { name: "7 days" })
        .click();
      const confirm = page
        .locator('[role="dialog"]:not(:has(.settings-sidebar)), [role="alertdialog"]')
        .filter({ has: page.getByRole("button", { name: "Shorten and delete", exact: true }) });
      await confirm.last().waitFor({ state: "visible", timeout: 10_000 });
      await writeShot(page, "privacy.shorten-retention-confirm", "window");
      await confirm.last().getByRole("button", { name: "Cancel" }).click();
      await confirm.last().waitFor({ state: "hidden", timeout: 8_000 });
    });

    // ── Troubleshooting ──
    await step("troubleshooting-rest", async () => {
      await openSettingsAt(page, { tab: "troubleshooting" });
      await capturePage(page, "troubleshooting", "troubleshooting.rest");
    });
    await step("troubleshooting-active", async () => {
      await page.locator(`${panel("troubleshooting")} button:has-text("Run health check")`).click();
      await page
        .locator(`${panel("troubleshooting")} [aria-label="Health check results"]`)
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .locator(`${panel("troubleshooting")} [role="switch"][aria-label="Developer Mode Toggle"]`)
        .click();
      const verbose = page.locator(
        `${panel("troubleshooting")} #troubleshooting-verbose-logging [role="switch"], ${panel("troubleshooting")} [role="switch"][aria-label*="Verbose"]`
      );
      if (await verbose.count()) await verbose.first().click();
      await settle(page, 500);
      await capturePage(page, "troubleshooting", "troubleshooting.active");
    });
    await step("diagnostics-review-dialog", async () => {
      await page
        .locator(`${panel("troubleshooting")} button:has-text("Download diagnostics")`)
        .click();
      const review = page.locator('[data-testid="diagnostics-review-dialog"]');
      await review.first().waitFor({ state: "visible", timeout: 60_000 });
      await settle(page, 600);
      await writeShot(page, "diagnostics-review.rest", "window");
      await review.getByRole("button", { name: /^Sections/ }).click();
      await settle(page, 400);
      await writeShot(page, "diagnostics-review.sections", "window");
      await review.getByRole("button", { name: "Preview the report" }).click();
      await review.getByLabel("Report preview").scrollIntoViewIfNeeded();
      await settle(page, 500);
      await writeShot(page, "diagnostics-review.preview", "window");
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    await closeSettings(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[settings-trust-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`settings-trust capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
