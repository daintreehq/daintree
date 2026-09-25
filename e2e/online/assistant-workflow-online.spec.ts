/* eslint-disable @typescript-eslint/no-explicit-any -- window globals and CLI transcripts are untyped */
import { test, expect, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalTextById } from "../helpers/terminal";

/**
 * The Daintree Assistant running a real multi-agent workflow end to end: the
 * assistant (Codex) is asked to poll five real agent CLIs for a fact, have them
 * vote, and tally the result. Nothing is faked — every agent is the installed
 * CLI on its own subscription — so this is opt-in and never part of a suite:
 *
 *   DAINTREE_E2E_ASSISTANT_WORKFLOW=1 npx playwright test --project=online assistant-workflow
 *
 * `DAINTREE_RUNBOOKS_MCP_URL` passes through, so a local runbook server can be
 * exercised. The run writes a timeline, every terminal's final text and the
 * assistant's runbook queries into the test's output folder.
 */

const ENABLED = process.env.DAINTREE_E2E_ASSISTANT_WORKFLOW === "1";
const WORKFLOW_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 15_000;
/** How long the whole fleet must sit still, assistant included, to call the run over. */
const QUIET_MS = 3 * 60_000;

const WORKERS = ["claude", "antigravity", "opencode", "grok", "codex"] as const;

const QUERY = `I need you to ask Claude, Anti-Gravity, OpenCode, Grok and Codex each to give you one interesting fact. You don't have to explore the codebase. Just ask each one to give you one interesting fact off the top of its head, not related to the codebase. Specifically say that.

Next you need to:

1.  Choose the two best and give them each one point.
2.  For each agent that you already have open, send it the interesting fact from the other agents and ask it to choose which is the best.
3.  Each one of those will give one of the agents another point.
4.  Tally everything up and tell me which agent gave the most interesting fact.

Encourage each agent to respond quite quickly and give something that is completely unique that it doesn't think that any of the other agents will give. And have each agent also choose a runner-up and use those runner-ups if you ever need to do a tiebreaker.`;

interface TerminalInfo {
  id: string;
  launchAgentId?: string;
  title?: string;
  cwd: string;
  agentState?: string;
  hasPty?: boolean;
  isTrashed?: boolean;
}

async function allTerminals(page: Page): Promise<TerminalInfo[]> {
  return page.evaluate(() => (window as any).electron.terminal.getAllTerminals());
}

async function dispatch(page: Page, actionId: string, args?: unknown): Promise<any> {
  return page.evaluate(
    async ([id, payload]) => {
      const run = (window as any).__daintreeDispatchAction;
      if (typeof run !== "function") throw new Error("Action dispatch hook not available");
      return run(id, payload, { source: "test" });
    },
    [actionId, args] as const
  );
}

/** Codex session files written since `since`, newest first. */
function codexSessionFiles(since: number): string[] {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) found.push(full);
    }
  };
  walk(root);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Every `search_runbooks` query the assistant's Codex session sent. */
function runbookQueries(sessionFile: string): string[] {
  const queries: string[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.includes("search_runbooks")) continue;
    const match = line.match(/\\?"query\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"/);
    if (match) queries.push(match[1]);
  }
  return [...new Set(queries)];
}

test.describe("Daintree Assistant: real multi-agent workflow", () => {
  let ctx: AppContext;
  let cleanup: (() => void) | undefined;

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanup?.();
  });

  test("Codex assistant polls five agents for facts, runs the vote and tallies it", async ({}, testInfo) => {
    test.skip(!ENABLED, "set DAINTREE_E2E_ASSISTANT_WORKFLOW=1 to run the real-agent workflow");
    test.setTimeout(WORKFLOW_TIMEOUT_MS + 5 * 60_000);

    const outDir = testInfo.outputPath("workflow");
    mkdirSync(outDir, { recursive: true });
    const timeline = path.join(outDir, "timeline.log");
    const log = (line: string) => {
      const stamped = `[${new Date().toISOString()}] ${line}`;
      appendFileSync(timeline, stamped + "\n");
      console.log(stamped);
    };
    const startedAt = Date.now();

    const repo = createFixtureRepo({ name: "assistant-workflow" });
    cleanup = repo.cleanup;
    const env: Record<string, string> = {};
    if (process.env.DAINTREE_RUNBOOKS_MCP_URL) {
      env.DAINTREE_RUNBOOKS_MCP_URL = process.env.DAINTREE_RUNBOOKS_MCP_URL;
    }
    ctx = await launchApp({ env });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "assistant-workflow");
    ctx.window = page;
    log(`app up; runbooks endpoint ${env.DAINTREE_RUNBOOKS_MCP_URL ?? "(production default)"}`);

    await page.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port, {
        timeout: 30_000,
      })
      .toBeTruthy();
    const settings = await page.evaluate(() => (window as any).electron.helpAssistant.getSettings());
    log(`assistant settings: ${JSON.stringify(settings)}`);
    expect(settings.runbookSearch).toBe(true);

    // The assistant runs Codex, stored the way the agent picker stores it.
    await page.evaluate(() => {
      const key = "help-panel-storage";
      let blob: { state?: Record<string, unknown>; version?: number };
      try {
        blob = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      } catch {
        blob = {};
      }
      blob.state = { ...(blob.state ?? {}), preferredAgentId: "codex" };
      blob.version = blob.version ?? 6;
      window.localStorage.setItem(key, JSON.stringify(blob));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[aria-label="Toggle Sidebar"]')).toBeVisible({ timeout: 30_000 });

    await dispatch(page, "help.togglePanel");
    await page.locator('[data-testid="help-start-assistant"]').click({ timeout: 30_000 });

    let assistantId = "";
    await expect
      .poll(
        async () => {
          const found = (await allTerminals(page)).find(
            // The session folder lives under userData; compared by its folder
            // name, since macOS reports temp paths through /private.
            (t) => t.launchAgentId === "codex" && t.cwd.includes(`${path.sep}help-sessions${path.sep}`)
          );
          assistantId = found?.id ?? "";
          return assistantId;
        },
        { timeout: 60_000, intervals: [500, 1000] }
      )
      .not.toBe("");
    log(`assistant terminal ${assistantId}`);

    // The session's instructions must open with the runbook rule.
    const sessionDir = (await allTerminals(page)).find((t) => t.id === assistantId)!.cwd;
    const agentsMd = readFileSync(path.join(sessionDir, "AGENTS.md"), "utf8");
    writeFileSync(path.join(outDir, "session-AGENTS.md"), agentsMd);
    expect(agentsMd).toContain("## Runbooks First");
    expect(agentsMd.indexOf("## Runbooks First")).toBeLessThan(agentsMd.indexOf("## What You Can Do"));

    // Codex asks whether to trust a new folder before it reads anything; the
    // user would accept its highlighted default for the session folder.
    const trustPrompt = /Trust this folder\?|Trust and continue|do you trust/i;
    await expect
      .poll(() => getTerminalTextById(page, assistantId), { timeout: 90_000, intervals: [1000] })
      .toMatch(/trust|›|OpenAI Codex|Ask Codex/i);
    if (trustPrompt.test(await getTerminalTextById(page, assistantId))) {
      log("codex trust prompt shown; accepting 'Trust and continue'");
      await page.evaluate((id) => (window as any).electron.terminal.write(id, "\r"), assistantId);
      await expect
        .poll(async () => trustPrompt.test(await getTerminalTextById(page, assistantId)), {
          timeout: 30_000,
          intervals: [500, 1000],
        })
        .toBe(false);
    }
    await expect
      .poll(async () => (await allTerminals(page)).find((t) => t.id === assistantId)?.agentState, {
        timeout: 120_000,
        intervals: [1000, 2000],
      })
      .toMatch(/idle|waiting/);
    await page.screenshot({ path: path.join(outDir, "01-assistant-ready.png") });

    await page.evaluate(
      ([id, text]) => (window as any).electron.terminal.submit(id, text),
      [assistantId, QUERY] as const
    );
    log("query submitted");

    // Watch until the whole fleet has been still for QUIET_MS, or time runs out.
    let lastChange = Date.now();
    let lastSnapshot = "";
    let shot = 2;
    while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
      await page.waitForTimeout(POLL_MS);
      const terminals = (await allTerminals(page)).filter((t) => !t.isTrashed);
      const snapshot = terminals
        .map((t) => `${t.id.slice(-8)} ${t.launchAgentId ?? "shell"} ${t.agentState ?? "-"} ${t.title ?? ""}`)
        .join(" | ");
      const tail = (await getTerminalTextById(page, assistantId)).trimEnd().split("\n").slice(-3).join(" / ");
      const fingerprint = snapshot + tail;
      if (fingerprint !== lastSnapshot) {
        lastSnapshot = fingerprint;
        lastChange = Date.now();
        log(`fleet: ${snapshot}`);
        log(`assistant: ${tail.slice(0, 400)}`);
        await page.screenshot({ path: path.join(outDir, `${String(shot++).padStart(2, "0")}-progress.png`) });
      }
      const workers = terminals.filter((t) => t.id !== assistantId);
      const assistantState = terminals.find((t) => t.id === assistantId)?.agentState;
      if (
        workers.length > 0 &&
        assistantState !== "working" &&
        workers.every((t) => t.agentState !== "working") &&
        Date.now() - lastChange > QUIET_MS
      ) {
        log("fleet quiet; ending the watch");
        break;
      }
    }

    // Evidence, whatever the outcome.
    const terminals = await allTerminals(page);
    for (const t of terminals) {
      const text = await getTerminalTextById(page, t.id);
      writeFileSync(path.join(outDir, `terminal-${t.launchAgentId ?? "shell"}-${t.id.slice(-8)}.txt`), text);
    }
    await page.screenshot({ path: path.join(outDir, "99-final.png") });
    const sessionFile = codexSessionFiles(startedAt).find((file) =>
      readFileSync(file, "utf8").includes("search_runbooks")
    );
    const queries = sessionFile ? runbookQueries(sessionFile) : [];
    log(`runbook queries: ${JSON.stringify(queries)}`);
    writeFileSync(path.join(outDir, "runbook-queries.json"), JSON.stringify(queries, null, 2));

    const launched = terminals
      .filter((t) => t.id !== assistantId && t.launchAgentId)
      .map((t) => t.launchAgentId!);
    log(`launched agents: ${JSON.stringify(launched)}`);

    expect(queries.length, "the assistant never searched the runbooks").toBeGreaterThan(0);
    for (const agent of WORKERS) {
      expect(launched, `no ${agent} agent was launched`).toContain(agent);
    }
    const finalText = await getTerminalTextById(page, assistantId);
    expect(finalText, "the assistant never reported a tally").toMatch(/point/i);
  });
});
