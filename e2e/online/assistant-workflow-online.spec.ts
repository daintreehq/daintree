/* eslint-disable @typescript-eslint/no-explicit-any -- window globals and CLI transcripts are untyped */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalTextById } from "../helpers/terminal";
import { planChoice } from "../../shared/utils/terminalChoice";

/**
 * The Daintree Assistant running real workflows end to end. Every agent is the
 * installed CLI on its own subscription, so this is opt-in and never part of a
 * suite. Pick scenarios by id, comma separated, or `all`:
 *
 *   DAINTREE_E2E_ASSISTANT_WORKFLOW=facts-vote npx playwright test --project=online assistant-workflow
 *
 * `DAINTREE_E2E_ASSISTANT_AGENT` picks the assistant CLI (`codex` by default).
 * `DAINTREE_RUNBOOKS_MCP_URL` passes through, so a local runbook server can be
 * exercised. Each scenario writes a timeline, screenshots, every terminal's
 * final text, the assistant's transcript and a metrics.json into the test's
 * output folder.
 *
 * Worker CLIs meet a fresh fixture folder and ask whether to trust it. A user
 * running these in their own project has trusted it long ago, so the harness
 * answers those dialogs the way that user would, and logs each one.
 */

const SELECTED = (process.env.DAINTREE_E2E_ASSISTANT_WORKFLOW ?? "").trim();
const ASSISTANT_AGENT = process.env.DAINTREE_E2E_ASSISTANT_AGENT ?? "codex";
const POLL_MS = 5_000;
/** How long the assistant and every worker must sit still to call a turn over. */
const QUIET_MS = 45_000;
/**
 * Answer worker trust dialogs as the user would. Off by default, so a run
 * exercises the assistant's own dialog handling; on, it measures a user whose
 * project every CLI already trusts.
 */
const AUTO_TRUST = process.env.DAINTREE_E2E_AUTO_TRUST === "1";
const TRUST_LABELS = ["Yes, I trust this folder", "Trust and continue", "Yes, proceed"];
const TRUST_DIALOG =
  /Trust this folder\?|Trust and continue|do you trust|trust the files in this folder|Yes, I trust this folder/i;

interface ScenarioContext {
  page: Page;
  assistantId: string;
  workers: TerminalInfo[];
  finalText: string;
  worktreeCount: number;
  metrics: TurnMetrics;
}

interface Scenario {
  id: string;
  /** Files written into the fixture repo before it is opened. */
  project: Record<string, string>;
  /** The user's messages, in order; each waits for the previous turn to settle. */
  messages: string[];
  timeoutMs: number;
  check: (ctx: ScenarioContext) => void | Promise<void>;
}

const INVENTORY_PROJECT: Record<string, string> = {
  "README.md": `# stockroom

A small command-line tool that tracks warehouse stock levels. It reads a CSV of
items, applies receipts and shipments, and warns when an item falls below its
reorder point.

Run \`node src/cli.js report stock.csv\` to print the current levels.
`,
  "package.json": JSON.stringify(
    { name: "stockroom", version: "0.3.0", private: true, scripts: { test: "node --test" } },
    null,
    2
  ),
  "src/stock.js": `export function applyMovement(levels, movement) {
  const current = levels.get(movement.sku) ?? 0;
  // TODO: shipments larger than stock silently go negative
  levels.set(movement.sku, current + movement.quantity);
  return levels;
}

export function belowReorderPoint(levels, reorderPoints) {
  return [...levels].filter(([sku, qty]) => qty < (reorderPoints.get(sku) ?? 0));
}
`,
  "src/csv.js": `export function parseCsv(text) {
  // Naive: breaks on quoted commas.
  return text.trim().split("\\n").map((line) => line.split(","));
}
`,
  "src/cli.js": `import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.js";
import { applyMovement } from "./stock.js";

const [, , command, file] = process.argv;
if (command !== "report") {
  console.error("usage: cli.js report <file>");
  process.exit(1);
}
const levels = new Map();
for (const [sku, quantity] of parseCsv(readFileSync(file, "utf8"))) {
  applyMovement(levels, { sku, quantity: Number(quantity) });
}
for (const [sku, qty] of levels) console.log(sku, qty);
`,
  "stock.csv": "A-100,12\nB-200,4\nA-100,-3\nC-300,40\n",
  "test/stock.test.js": `import { test } from "node:test";
import assert from "node:assert";
import { applyMovement } from "../src/stock.js";

test("applies a receipt", () => {
  const levels = applyMovement(new Map(), { sku: "A", quantity: 5 });
  assert.equal(levels.get("A"), 5);
});
`,
};

const FACTS_QUERY = `I need you to ask Claude, Anti-Gravity, Grok and Codex each to give you one interesting fact. You don't have to explore the codebase. Just ask each one to give you one interesting fact off the top of its head, not related to the codebase. Specifically say that.

Next you need to:

1.  Choose the two best and give them each one point.
2.  For each agent that you already have open, send it the interesting fact from the other agents and ask it to choose which is the best.
3.  Each one of those will give one of the agents another point.
4.  Tally everything up and tell me which agent gave the most interesting fact.

Encourage each agent to respond quite quickly and give something that is completely unique that it doesn't think that any of the other agents will give. And have each agent also choose a runner-up and use those runner-ups if you ever need to do a tiebreaker.`;

const FACT_WORKERS = ["claude", "antigravity", "grok", "codex"];

const SCENARIOS: Scenario[] = [
  {
    id: "question",
    project: INVENTORY_PROJECT,
    messages: ["How do I switch Daintree to a light theme?"],
    timeoutMs: 5 * 60_000,
    check: ({ workers, metrics }) => {
      expect(workers, "a question launched agents").toEqual([]);
      expect(metrics.runbookQueries, "a question searched the runbooks").toEqual([]);
    },
  },
  {
    id: "ask-one",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude to read this project and tell me in one sentence what it does, then close it.",
    ],
    timeoutMs: 10 * 60_000,
    check: ({ finalText, metrics }) => {
      // Closed as asked, so it is gone from the terminal list by now.
      // A transcript is not always on disk; then the launch shows in the answer.
      if (metrics.toolCalls.length > 0) {
        expect(
          metrics.toolCalls.some(
            (c) => /agent[._]launch/.test(`${c.name} ${c.input}`) && /claude/.test(c.input)
          ),
          "Claude was never launched"
        ).toBe(true);
      }
      expect(finalText, "the answer never reached the user").toMatch(/stock|warehouse|inventor/i);
    },
  },
  {
    id: "same-question",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude and Codex the same question: which function in src/ is the most likely to cause a bug, and why? Bring both answers back side by side.",
    ],
    timeoutMs: 12 * 60_000,
    check: ({ finalText, metrics }) => {
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
      expect(finalText).toMatch(/applyMovement|parseCsv/);
    },
  },
  {
    id: "facts-vote",
    project: INVENTORY_PROJECT,
    messages: [FACTS_QUERY, "Great. Now close every agent except the winner."],
    timeoutMs: 30 * 60_000,
    check: ({ workers, finalText, metrics }) => {
      // Losers are closed by the follow-up, so launches come from the transcript.
      const launchCalls = metrics.toolCalls.filter((c) =>
        /agent[._]launch/.test(`${c.name} ${c.input}`)
      );
      for (const agent of FACT_WORKERS) {
        expect(
          launchCalls.some((c) => c.input.includes(`"${agent}"`) || c.input.includes(`'${agent}'`)),
          `no ${agent} agent was launched`
        ).toBe(true);
      }
      expect(finalText, "the assistant never reported a tally").toMatch(/point/i);
      expect(
        workers.filter((t) => !t.isTrashed).length,
        "more than the winner is still open"
      ).toBeLessThanOrEqual(2);
    },
  },
  {
    id: "worktree-task",
    project: INVENTORY_PROJECT,
    messages: [
      "Make a new worktree to stop shipments from taking stock below zero, and start Codex on it. Tell me when it has a fix.",
    ],
    timeoutMs: 25 * 60_000,
    check: ({ worktreeCount, metrics }) => {
      expect(worktreeCount, "no worktree was created").toBeGreaterThan(1);
      expect(metrics.launched).toContain("codex");
    },
  },
];

interface TerminalInfo {
  id: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  title?: string;
  cwd: string;
  agentState?: string;
  hasPty?: boolean;
  isTrashed?: boolean;
}

interface ToolCall {
  at: number;
  name: string;
  input: string;
  outputBytes: number;
}

interface TurnMetrics {
  /** Calls that reached an MCP server, however the CLI wrapped them. */
  mcpCalls: number;
  /** Tool-surface lookups (ALL_TOOLS, getSchema, ToolSearch), which reach nothing. */
  lookups: number;
  seconds: number;
  turns: number;
  notices: number;
  toolCalls: ToolCall[];
  runbookQueries: string[];
  launched: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  largestOutputs: Array<{ name: string; bytes: number }>;
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

function seedProject(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed project"], { cwd: dir });
}

/** Codex session files for `sessionDir` written since `since`. */
function codexSessionFiles(sessionDir: string, since: number): string[] {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const marker = path.basename(sessionDir);
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
      else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) {
        const head = readFileSync(full, "utf8").slice(0, 4000);
        if (head.includes(marker)) found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

/** Tool calls, tokens and notices from the assistant's Codex transcript since `since`. */
function readCodexTranscript(
  sessionDir: string,
  since: number,
  outFile: string
): Omit<TurnMetrics, "seconds" | "launched" | "mcpCalls" | "lookups"> {
  const metrics: Omit<TurnMetrics, "seconds" | "launched" | "mcpCalls" | "lookups"> = {
    turns: 0,
    notices: 0,
    toolCalls: [],
    runbookQueries: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    largestOutputs: [],
  };
  const lines: string[] = [];
  const pendingNames = new Map<string, string>();
  const baseline = { input: 0, cached: 0, output: 0, seen: false };
  for (const file of codexSessionFiles(sessionDir, since - 60_000)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      let entry: any;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const at = Date.parse(entry.timestamp);
      const payload = entry.payload ?? {};
      if (entry.type === "event_msg" && payload.type === "token_count") {
        const total = payload.info?.total_token_usage;
        if (!total) continue;
        if (at < since) {
          baseline.input = total.input_tokens ?? 0;
          baseline.cached = total.cached_input_tokens ?? 0;
          baseline.output = total.output_tokens ?? 0;
          continue;
        }
        metrics.inputTokens = (total.input_tokens ?? 0) - baseline.input;
        metrics.cachedInputTokens = (total.cached_input_tokens ?? 0) - baseline.cached;
        metrics.outputTokens = (total.output_tokens ?? 0) - baseline.output;
        continue;
      }
      if (at < since) continue;
      const rel = ((at - since) / 1000).toFixed(1).padStart(7);
      if (entry.type === "event_msg" && payload.type === "task_started") {
        metrics.turns++;
        lines.push(`${rel} == turn started`);
      } else if (
        entry.type === "response_item" &&
        (payload.type === "custom_tool_call" || payload.type === "function_call")
      ) {
        const input = String(payload.input ?? payload.arguments ?? "");
        const name = String(payload.name);
        pendingNames.set(payload.call_id, name);
        metrics.toolCalls.push({
          at: at - since,
          name,
          input: input.slice(0, 2000),
          outputBytes: 0,
        });
        for (const match of input.matchAll(
          /search_runbooks\s*\(\s*\{[^}]*?query\s*:\s*"([^"]+)"/g
        )) {
          metrics.runbookQueries.push(match[1]);
        }
        if (name.includes("search_runbooks")) {
          const q = input.match(/"query"\s*:\s*"([^"]+)"/);
          if (q) metrics.runbookQueries.push(q[1]);
        }
        lines.push(`${rel} CALL ${name}: ${input.slice(0, 1500)}`);
      } else if (
        entry.type === "response_item" &&
        (payload.type === "custom_tool_call_output" || payload.type === "function_call_output")
      ) {
        const text =
          typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output);
        const call = [...metrics.toolCalls].reverse().find((c) => c.outputBytes === 0);
        if (call) call.outputBytes = text.length;
        lines.push(`${rel}   OUT ${text.length}B: ${text.slice(0, 600)}`);
      } else if (entry.type === "event_msg" && payload.type === "item_completed") {
        const item = payload.item ?? {};
        if (item.type === "UserMessage" || item.type === "AgentMessage") {
          const text = (item.content ?? []).map((c: any) => c.text ?? "").join("");
          if (item.type === "UserMessage" && text.startsWith("Daintree:")) metrics.notices++;
          lines.push(`${rel} ${item.type}: ${text}`);
        }
      }
    }
  }
  metrics.runbookQueries = [...new Set(metrics.runbookQueries)];
  metrics.largestOutputs = [...metrics.toolCalls]
    .sort((a, b) => b.outputBytes - a.outputBytes)
    .slice(0, 5)
    .map((c) => ({ name: c.input.slice(0, 80), bytes: c.outputBytes }));
  writeFileSync(outFile, lines.join("\n") + "\n");
  return metrics;
}

/** Tool calls, tokens and notices from the assistant's Claude Code transcript since `since`. */
function readClaudeTranscript(
  sessionDir: string,
  since: number,
  outFile: string
): Omit<TurnMetrics, "seconds" | "launched" | "mcpCalls" | "lookups"> {
  const metrics: Omit<TurnMetrics, "seconds" | "launched" | "mcpCalls" | "lookups"> = {
    turns: 0,
    notices: 0,
    toolCalls: [],
    runbookQueries: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    largestOutputs: [],
  };
  const root = path.join(os.homedir(), ".claude", "projects");
  const marker = path.basename(sessionDir);
  const lines: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((name) => name.includes(marker));
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    for (const name of readdirSync(path.join(root, dir))) {
      if (!name.endsWith(".jsonl")) continue;
      for (const raw of readFileSync(path.join(root, dir, name), "utf8").split("\n")) {
        let entry: any;
        try {
          entry = JSON.parse(raw);
        } catch {
          continue;
        }
        const at = Date.parse(entry.timestamp);
        if (!(at >= since)) continue;
        const rel = ((at - since) / 1000).toFixed(1).padStart(7);
        const content = entry.message?.content;
        if (entry.type === "assistant") {
          const usage = entry.message?.usage;
          if (usage) {
            metrics.inputTokens +=
              (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
            metrics.cachedInputTokens += usage.cache_read_input_tokens ?? 0;
            metrics.outputTokens += usage.output_tokens ?? 0;
          }
          for (const part of Array.isArray(content) ? content : []) {
            if (part.type === "tool_use") {
              const input = JSON.stringify(part.input ?? {});
              metrics.toolCalls.push({ at: at - since, name: part.name, input, outputBytes: 0 });
              if (String(part.name).includes("search_runbooks") && part.input?.query) {
                metrics.runbookQueries.push(part.input.query);
              }
              lines.push(`${rel} CALL ${part.name}: ${input.slice(0, 1500)}`);
            } else if (part.type === "text" && part.text) {
              lines.push(`${rel} AgentMessage: ${part.text}`);
            }
          }
        } else if (entry.type === "user") {
          const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
          for (const part of Array.isArray(parts) ? parts : []) {
            if (part.type === "tool_result") {
              const text = JSON.stringify(part.content ?? "");
              const call = [...metrics.toolCalls].reverse().find((c) => c.outputBytes === 0);
              if (call) call.outputBytes = text.length;
              lines.push(`${rel}   OUT ${text.length}B: ${text.slice(0, 600)}`);
            } else if (part.type === "text" && part.text) {
              metrics.turns++;
              // Claude receives a multi-line notice as a paste, wrapped in a tag.
              if (/(^|\n)Daintree: /.test(part.text)) metrics.notices++;
              lines.push(`${rel} UserMessage: ${part.text}`);
            }
          }
        }
      }
    }
  }
  metrics.runbookQueries = [...new Set(metrics.runbookQueries)];
  metrics.largestOutputs = [...metrics.toolCalls]
    .sort((a, b) => b.outputBytes - a.outputBytes)
    .slice(0, 5)
    .map((c) => ({ name: c.input.slice(0, 80), bytes: c.outputBytes }));
  writeFileSync(outFile, lines.join("\n") + "\n");
  return metrics;
}

async function submitViaHybridInput(page: Page, terminalId: string, text: string): Promise<void> {
  const editor = page.locator(`[data-hybrid-input-root="${terminalId}"] .cm-content`);
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  // One line at a time: a multi-line insert does not reach CodeMirror, and
  // Shift+Enter is how a user breaks a line without submitting.
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    if (line.length > 0) await page.keyboard.insertText(line);
  }
  await expect
    .poll(() => editor.innerText(), { timeout: 10_000 })
    .toContain(text.split("\n")[0].slice(0, 40));
  await page.keyboard.press("Enter");
  // Submitted once the draft is gone; the empty editor shows its placeholder.
  const prefix = text.split("\n")[0].slice(0, 40);
  await expect
    .poll(async () => (await editor.innerText()).includes(prefix), { timeout: 15_000 })
    .toBe(false);
}

for (const scenario of SCENARIOS) {
  const enabled =
    SELECTED === "all" ||
    SELECTED.split(",")
      .map((s) => s.trim())
      .includes(scenario.id) ||
    (SELECTED === "1" && scenario.id === "facts-vote");

  test.describe(`Daintree Assistant workflow: ${scenario.id}`, () => {
    let ctx: AppContext | undefined;
    let cleanup: (() => void) | undefined;

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      cleanup?.();
    });

    // eslint-disable-next-line no-empty-pattern -- Playwright requires an object-destructured fixture argument even when this Electron test uses none
    test(`${ASSISTANT_AGENT} assistant runs "${scenario.id}"`, async ({}, testInfo) => {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "opt-in: real agent CLIs on the user's own subscriptions",
      });
      test.skip(!enabled, "set DAINTREE_E2E_ASSISTANT_WORKFLOW to this scenario id or `all`");
      test.setTimeout(scenario.timeoutMs + 5 * 60_000);

      const outDir = testInfo.outputPath("workflow");
      mkdirSync(outDir, { recursive: true });
      const timeline = path.join(outDir, "timeline.log");
      const log = (line: string) => {
        const stamped = `[${new Date().toISOString()}] ${line}`;
        appendFileSync(timeline, stamped + "\n");
        console.log(`[${scenario.id}] ${stamped}`);
      };

      const repo = createFixtureRepo({ name: `assistant-${scenario.id}` });
      cleanup = repo.cleanup;
      seedProject(repo.dir, scenario.project);

      const env: Record<string, string> = {};
      if (process.env.DAINTREE_RUNBOOKS_MCP_URL) {
        env.DAINTREE_RUNBOOKS_MCP_URL = process.env.DAINTREE_RUNBOOKS_MCP_URL;
      }
      // Run as if opened from the Dock: a harness started inside an agent
      // session would otherwise hand that session's variables (its messaging
      // socket, transcript settings) to every agent the assistant launches.
      for (const key of Object.keys(process.env)) {
        if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_PID") {
          delete process.env[key];
        }
      }
      ctx = await launchApp({ env });
      const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, scenario.id);
      ctx.window = page;
      log(`app up; runbooks ${env.DAINTREE_RUNBOOKS_MCP_URL ?? "(production default)"}`);

      await page.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port,
          { timeout: 30_000 }
        )
        .toBeTruthy();
      const settings = await page.evaluate(() =>
        (window as any).electron.helpAssistant.getSettings()
      );
      expect(settings.runbookSearch).toBe(true);

      await page.evaluate((agentId) => {
        const key = "help-panel-storage";
        let blob: { state?: Record<string, unknown>; version?: number };
        try {
          blob = JSON.parse(window.localStorage.getItem(key) ?? "{}");
        } catch {
          blob = {};
        }
        blob.state = { ...(blob.state ?? {}), preferredAgentId: agentId };
        blob.version = blob.version ?? 6;
        window.localStorage.setItem(key, JSON.stringify(blob));
      }, ASSISTANT_AGENT);
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
              (t) =>
                t.launchAgentId === ASSISTANT_AGENT &&
                t.cwd.includes(`${path.sep}help-sessions${path.sep}`)
            );
            assistantId = found?.id ?? "";
            return assistantId;
          },
          { timeout: 60_000, intervals: [500, 1000] }
        )
        .not.toBe("");
      const sessionDir = (await allTerminals(page)).find((t) => t.id === assistantId)!.cwd;
      log(`assistant terminal ${assistantId} in ${sessionDir}`);
      const instructions = readFileSync(
        path.join(sessionDir, ASSISTANT_AGENT === "claude" ? "CLAUDE.md" : "AGENTS.md"),
        "utf8"
      );
      writeFileSync(path.join(outDir, "session-instructions.md"), instructions);
      expect(instructions).toContain("## Runbooks First");

      // Trust dialogs, answered the way a user who trusts their own project would.
      const trusted = new Set<string>();
      let assistantBusy = false;
      const answerTrustDialogs = async (terminals: TerminalInfo[]) => {
        for (const t of terminals) {
          if (t.isTrashed || trusted.has(t.id)) continue;
          // The assistant only before its first message: after that its screen
          // quotes workers' dialogs, and Enter there would submit its draft.
          if (t.id === assistantId ? assistantBusy : !AUTO_TRUST) continue;
          // A tall pane leaves blank rows under the dialog.
          const text = (await getTerminalTextById(page, t.id).catch(() => "")).trimEnd();
          if (!TRUST_DIALOG.test(text.split("\n").slice(-30).join("\n"))) continue;
          // Each CLI highlights a different default (Claude's is "No, exit"),
          // so pick the trusting option by its label, as a user would.
          const plan = TRUST_LABELS.map((label) => planChoice(text, label)).find((p) => p.ok);
          if (plan === undefined || !plan.ok) {
            log(`trust dialog in ${t.id.slice(-8)} but no option to pick:\n${text.slice(-600)}`);
            continue;
          }
          trusted.add(t.id);
          log(`trust dialog in ${t.launchAgentId ?? "shell"} ${t.id.slice(-8)}; accepting`);
          for (const key of plan.keys) {
            await page.evaluate(([id, data]) => (window as any).electron.terminal.write(id, data), [
              t.id,
              key === "Enter" ? "\r" : key === "Down" ? "\x1b[B" : "\x1b[A",
            ] as const);
            await page.waitForTimeout(150);
          }
        }
      };

      // Ready means the CLI's own composer is on screen with no dialog over it;
      // agent state alone reads a dialog as waiting.
      let lastUnready = "";
      const composer =
        ASSISTANT_AGENT === "claude"
          ? /\? for shortcuts|shift\+tab to cycle|^\s*❯/m
          : /Ask Codex|›/;
      await expect
        .poll(
          async () => {
            await answerTrustDialogs(await allTerminals(page));
            const text = await getTerminalTextById(page, assistantId);
            const state = (await allTerminals(page)).find((t) => t.id === assistantId)?.agentState;
            const ready =
              /idle|waiting/.test(state ?? "") && composer.test(text) && !TRUST_DIALOG.test(text);
            if (!ready) lastUnready = `${state} :: ${text.slice(-500)}`;
            return ready;
          },
          { timeout: 120_000, intervals: [1000, 2000] }
        )
        .toBe(true)
        .catch((err: unknown) => {
          log(`assistant never became ready; last seen: ${lastUnready}`);
          throw err;
        });
      await page.screenshot({ path: path.join(outDir, "00-assistant-ready.png") });

      assistantBusy = true;
      const scenarioStarted = Date.now();
      let finalText = "";
      let shot = 1;
      for (const [index, message] of scenario.messages.entries()) {
        const turnStarted = Date.now();
        await submitViaHybridInput(page, assistantId, message);
        log(`message ${index + 1} submitted: ${message.slice(0, 120)}`);

        let lastChange = Date.now();
        let lastFingerprint = "";
        let sawWork = false;
        while (Date.now() - scenarioStarted < scenario.timeoutMs) {
          await page.waitForTimeout(POLL_MS);
          const terminals = (await allTerminals(page)).filter((t) => !t.isTrashed);
          await answerTrustDialogs(terminals);
          const fleet = terminals
            .map(
              (t) =>
                `${t.id.slice(-8)} ${t.launchAgentId ?? t.detectedAgentId ?? "shell"} ${t.agentState ?? "-"}`
            )
            .join(" | ");
          const tail = (await getTerminalTextById(page, assistantId))
            .trimEnd()
            .split("\n")
            .slice(-4)
            .join(" / ");
          const fingerprint = fleet + tail;
          const busy = terminals.some((t) => t.agentState === "working");
          if (busy) sawWork = true;
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            lastChange = Date.now();
            log(`fleet: ${fleet}`);
            log(`assistant: ${tail.slice(0, 400)}`);
            await page.screenshot({
              path: path.join(outDir, `${String(shot++).padStart(2, "0")}-progress.png`),
            });
          }
          if (sawWork && !busy && Date.now() - lastChange > QUIET_MS) break;
        }
        log(`message ${index + 1} settled after ${Math.round((Date.now() - turnStarted) / 1000)}s`);
      }
      const seconds = Math.round((Date.now() - scenarioStarted - QUIET_MS) / 1000);

      const terminals = await allTerminals(page);
      for (const t of terminals) {
        const text = await getTerminalTextById(page, t.id);
        writeFileSync(
          path.join(outDir, `terminal-${t.launchAgentId ?? "shell"}-${t.id.slice(-8)}.txt`),
          text
        );
      }
      finalText = await getTerminalTextById(page, assistantId);
      await page.screenshot({ path: path.join(outDir, "99-final.png") });

      // Agents only: the project opens with a plain shell nobody launched.
      const workers = terminals.filter(
        (t) => t.id !== assistantId && (t.launchAgentId ?? t.detectedAgentId) !== undefined
      );
      const transcriptFile = path.join(outDir, "transcript.txt");
      const transcript =
        ASSISTANT_AGENT === "claude"
          ? readClaudeTranscript(sessionDir, scenarioStarted, transcriptFile)
          : readCodexTranscript(sessionDir, scenarioStarted, transcriptFile);
      // Codex wraps MCP calls in `exec` scripts, several to a script; Claude
      // names each one `mcp__…`.
      const mcpCalls = transcript.toolCalls.reduce(
        (n, c) =>
          n + (c.name.startsWith("mcp__") ? 1 : (c.input.match(/tools\.mcp__\w+\(/g) ?? []).length),
        0
      );
      const lookups = transcript.toolCalls.filter((c) =>
        /ALL_TOOLS|actions_getSchema|ToolSearch/.test(`${c.name} ${c.input}`)
      ).length;
      const metrics: TurnMetrics = {
        ...transcript,
        mcpCalls,
        lookups,
        seconds,
        launched: workers.map((t) => (t.launchAgentId ?? t.detectedAgentId)!),
      };
      const summary = {
        scenario: scenario.id,
        assistant: ASSISTANT_AGENT,
        seconds: metrics.seconds,
        turns: metrics.turns,
        notices: metrics.notices,
        toolCallCount: metrics.toolCalls.length,
        mcpCalls: metrics.mcpCalls,
        lookups: metrics.lookups,
        runbookQueries: metrics.runbookQueries,
        launched: metrics.launched,
        inputTokens: metrics.inputTokens,
        cachedInputTokens: metrics.cachedInputTokens,
        outputTokens: metrics.outputTokens,
        largestOutputs: metrics.largestOutputs,
        trustDialogsAnswered: trusted.size,
      };
      writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(summary, null, 2));
      log(`metrics: ${JSON.stringify(summary)}`);

      const worktrees = await dispatch(page, "worktree.list").catch(() => null);
      const worktreeCount = Array.isArray(worktrees?.result?.worktrees)
        ? worktrees.result.worktrees.length
        : Array.isArray(worktrees?.result)
          ? worktrees.result.length
          : 0;

      await scenario.check({
        page,
        assistantId,
        workers: workers.filter((t) => !t.isTrashed),
        finalText,
        worktreeCount,
        metrics,
      });
    });
  });
}
