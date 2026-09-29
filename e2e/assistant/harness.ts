/* eslint-disable @typescript-eslint/no-explicit-any -- window globals and CLI transcripts are untyped */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalTextById } from "../helpers/terminal";
import { planChoice } from "../../shared/utils/terminalChoice";

/**
 * The Daintree Assistant running real workflows end to end: the kit behind
 * `workflows.spec.ts`. Every agent is the installed CLI on its own
 * subscription, so this lives under its own config and never runs in a suite
 * or gates a release. Build first, then pick scenarios by id, comma
 * separated, or `all`:
 *
 *   npm run build:e2e
 *   DAINTREE_E2E_ASSISTANT_WORKFLOW=facts-vote npm run test:e2e:assistant
 *
 * `DAINTREE_E2E_ASSISTANT_AGENT` picks the assistant CLI (`codex` by default,
 * or `claude`). `DAINTREE_E2E_AUTO_TRUST=1` answers worker trust dialogs as a
 * user whose project every CLI already trusts. `DAINTREE_RUNBOOKS_MCP_URL`
 * passes through, so a local runbook server can be exercised, and
 * `DAINTREE_E2E_ASSISTANT_ARGS` adds CLI flags to the assistant. Each
 * scenario writes a timeline, screenshots, every terminal's final text, the
 * assistant's instructions and transcript, the raw session files and a
 * metrics.json (with every reply a wait returned) into the test's output
 * folder.
 *
 * A new workflow is one entry in `scenarios.ts`: the project files, the
 * user's messages and a check against what the run left behind.
 */

const SELECTED = (process.env.DAINTREE_E2E_ASSISTANT_WORKFLOW ?? "").trim();
const ASSISTANT_AGENT = process.env.DAINTREE_E2E_ASSISTANT_AGENT ?? "codex";
const POLL_MS = 5_000;
/** How long the assistant and every worker must sit still to call a turn over. */
const QUIET_MS = 45_000;
/** A turn nobody is seen working in settles on quiet once this has passed. */
const FIRST_WORK_MS = 3 * 60_000;
/**
 * Answer worker trust dialogs as the user would. Off by default, so a run
 * exercises the assistant's own dialog handling; on, it measures a user whose
 * project every CLI already trusts.
 */
const AUTO_TRUST = process.env.DAINTREE_E2E_AUTO_TRUST === "1";
const TRUST_LABELS = ["Yes, I trust this folder", "Trust and continue", "Yes, proceed"];
const TRUST_DIALOG =
  /Trust this folder\?|Trust and continue|do you trust|trust the files in this folder|Yes, I trust this folder/i;

// A permission prompt on the assistant's own pane needs a user, so a run that
// meets one fails at once instead of idling out its whole budget.
const PERMISSION_PROMPT =
  /Do you want to proceed\?|don't ask again|Would you like to run the following command|Allow Codex to/i;

export interface ScenarioContext {
  page: Page;
  assistantId: string;
  /** Agent panes still open when the last message settled. */
  workers: TerminalInfo[];
  /** The assistant's terminal text at the end, the user's own prompts included. */
  finalText: string;
  /** What the assistant said, from its transcript; never the user's echoed prompt. */
  answer: string;
  /** The assistant session's CLAUDE.md or AGENTS.md as provisioned. */
  instructions: string;
  worktreeCount: number;
  metrics: TurnMetrics;
}

export interface Scenario {
  id: string;
  /** Files written into the fixture repo before it is opened. */
  project: Record<string, string>;
  /** The user's messages, in order; each waits for the previous turn to settle. */
  messages: string[];
  timeoutMs: number;
  /** Approve Daintree's confirm dialogs, as the user who asked for the action would. */
  approveConfirms?: boolean;
  /**
   * Send the next message once the assistant is idle, even while workers run.
   * By default a turn waits for every agent, so notices land inside it.
   */
  settleOnAssistant?: boolean;
  check: (ctx: ScenarioContext) => void | Promise<void>;
}

export interface TerminalInfo {
  id: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  title?: string;
  cwd: string;
  agentState?: string;
  hasPty?: boolean;
  isTrashed?: boolean;
}

export interface ToolCall {
  /** Ms since the scenario started. */
  at: number;
  name: string;
  input: string;
  outputBytes: number;
  /** The call's output as text, capped; what reply parsing reads. */
  output: string;
}

/** One `waitForReply` result the assistant received, single or batched. */
export interface ReplySeen {
  at: number;
  terminalId: string;
  /** The wait's outcome, or `unread` when a call asked for replies and none could be parsed. */
  outcome: string;
  /** The summary in the agent's done marker, when it printed one. */
  handback?: string;
  /** The quoted screen's last lines. */
  replyTail?: string;
}

export interface TurnMetrics {
  /** Calls that reached an MCP server, however the CLI wrapped them. */
  mcpCalls: number;
  /** Tool-surface lookups (ALL_TOOLS, getSchema, ToolSearch), which reach nothing. */
  lookups: number;
  seconds: number;
  turns: number;
  notices: number;
  toolCalls: ToolCall[];
  replies: ReplySeen[];
  runbookQueries: string[];
  /** The assistant's own messages, in order. */
  answers: string[];
  launched: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  largestOutputs: Array<{ name: string; bytes: number }>;
}

type TranscriptMetrics = Omit<
  TurnMetrics,
  "seconds" | "launched" | "mcpCalls" | "lookups" | "replies"
>;

/** Output kept per tool call for reply parsing: enough for a batch of replies. */
const TOOL_OUTPUT_KEEP = 60_000;

/** A tool result's text, whichever shape the CLI stored it in. */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("\n");
  }
  return JSON.stringify(output ?? "");
}

/**
 * Every awaited reply in the calls' outputs: objects carrying a `terminalId`
 * and a wait `outcome`, found in the JSON each output holds. Codex prints its
 * script's output after a preamble, so the JSON is read from the first brace,
 * or line by line when a script printed several values. A call that asked
 * for replies and yielded none is reported as `unread`, so a parse gap or an
 * output past the cap shows up instead of passing as "no replies".
 */
export function collectReplies(toolCalls: readonly ToolCall[]): ReplySeen[] {
  const outcomes = new Set(["handback", "settled", "exited", "closed", "timeout"]);
  const found: ReplySeen[] = [];
  const walk = (value: unknown, at: number) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, at);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.terminalId === "string" &&
      typeof record.outcome === "string" &&
      outcomes.has(record.outcome)
    ) {
      const reply = record.reply as { text?: string } | undefined;
      found.push({
        at,
        terminalId: record.terminalId,
        outcome: record.outcome,
        ...(typeof record.handback === "string" ? { handback: record.handback } : {}),
        ...(typeof reply?.text === "string" ? { replyTail: reply.text.slice(-200) } : {}),
      });
      return;
    }
    for (const child of Object.values(record)) walk(child, at);
  };
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  for (const call of toolCalls) {
    const before = found.length;
    const start = call.output.indexOf("{");
    const end = call.output.lastIndexOf("}");
    const whole =
      start === -1 || end <= start ? undefined : parse(call.output.slice(start, end + 1));
    if (whole !== undefined) walk(whole, call.at);
    else {
      for (const line of call.output.split("\n")) {
        if (line.trimStart().startsWith("{")) walk(parse(line.trim()), call.at);
      }
    }
    if (found.length === before && /waitForReply\\?"?\s*:\s*true/.test(call.input)) {
      found.push({ at: call.at, terminalId: "?", outcome: "unread" });
    }
  }
  return found;
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

/**
 * This run's assistant session folder as a CLI records it: the fresh profile's
 * random folder name plus the session's own, so no other session can match.
 * Claude names its project folder after the cwd with every separator as `-`.
 */
function sessionMarker(sessionDir: string, separator: string): string {
  const profile = path.basename(path.dirname(path.dirname(sessionDir)));
  return [profile, "help-sessions", path.basename(sessionDir)].join(separator);
}

/** Copy the assistant's raw session files for `transcript_digest.py`. */
function saveRawTranscripts(sessionDir: string, since: number, outDir: string): void {
  let files: string[] = [];
  if (ASSISTANT_AGENT === "claude") {
    const root = path.join(os.homedir(), ".claude", "projects");
    const marker = sessionMarker(sessionDir, "-");
    try {
      for (const dir of readdirSync(root).filter((name) => name.includes(marker))) {
        for (const name of readdirSync(path.join(root, dir))) {
          const full = path.join(root, dir, name);
          if (name.endsWith(".jsonl") && statSync(full).mtimeMs >= since) files.push(full);
        }
      }
    } catch {
      files = [];
    }
  } else {
    files = codexSessionFiles(sessionDir, since);
  }
  files.forEach((file, index) => copyFileSync(file, path.join(outDir, `raw-${index}.jsonl`)));
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
  const marker = sessionMarker(sessionDir, "/");
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
): TranscriptMetrics {
  const metrics: TranscriptMetrics = {
    turns: 0,
    notices: 0,
    toolCalls: [],
    runbookQueries: [],
    answers: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    largestOutputs: [],
  };
  const lines: string[] = [];
  // Outputs are matched to calls by id: parallel calls can finish in any order.
  const callsById = new Map<string, ToolCall>();
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
        const call: ToolCall = {
          at: at - since,
          name,
          input: input.slice(0, 2000),
          outputBytes: 0,
          output: "",
        };
        metrics.toolCalls.push(call);
        if (payload.call_id) callsById.set(String(payload.call_id), call);
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
        const text = toolOutputText(payload.output);
        const call = callsById.get(String(payload.call_id));
        if (call) {
          call.outputBytes = text.length;
          call.output = text.slice(0, TOOL_OUTPUT_KEEP);
        }
        lines.push(`${rel}   OUT ${text.length}B: ${text.slice(0, 600)}`);
      } else if (entry.type === "event_msg" && payload.type === "item_completed") {
        const item = payload.item ?? {};
        if (item.type === "UserMessage" || item.type === "AgentMessage") {
          const text = (item.content ?? []).map((c: any) => c.text ?? "").join("");
          if (item.type === "UserMessage" && text.startsWith("Daintree:")) metrics.notices++;
          if (item.type === "AgentMessage" && text) metrics.answers.push(text);
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
): TranscriptMetrics {
  const metrics: TranscriptMetrics = {
    turns: 0,
    notices: 0,
    toolCalls: [],
    runbookQueries: [],
    answers: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    largestOutputs: [],
  };
  const root = path.join(os.homedir(), ".claude", "projects");
  const marker = sessionMarker(sessionDir, "-");
  const lines: string[] = [];
  // Outputs are matched to calls by id: parallel calls can finish in any order.
  const callsById = new Map<string, ToolCall>();
  // Claude writes one record per content block, each repeating its message's usage.
  const countedMessages = new Set<string>();
  let dirs: string[];
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
          const messageId = entry.message?.id;
          if (usage && !(messageId && countedMessages.has(messageId))) {
            if (messageId) countedMessages.add(messageId);
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
              const call: ToolCall = {
                at: at - since,
                name: part.name,
                input,
                outputBytes: 0,
                output: "",
              };
              metrics.toolCalls.push(call);
              if (part.id) callsById.set(String(part.id), call);
              if (String(part.name).includes("search_runbooks") && part.input?.query) {
                metrics.runbookQueries.push(part.input.query);
              }
              lines.push(`${rel} CALL ${part.name}: ${input.slice(0, 1500)}`);
            } else if (part.type === "text" && part.text) {
              metrics.answers.push(part.text);
              lines.push(`${rel} AgentMessage: ${part.text}`);
            }
          }
        } else if (entry.type === "user") {
          const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
          for (const part of Array.isArray(parts) ? parts : []) {
            if (part.type === "tool_result") {
              const text = toolOutputText(part.content);
              const call = callsById.get(String(part.tool_use_id));
              if (call) {
                call.outputBytes = text.length;
                call.output = text.slice(0, TOOL_OUTPUT_KEEP);
              }
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

/** Register each scenario as its own opt-in test. */
export function registerScenarios(scenarios: readonly Scenario[]): void {
  // A mistyped id would otherwise skip every scenario and report success.
  if (SELECTED && SELECTED !== "all" && SELECTED !== "1") {
    const known = new Set(scenarios.map((s) => s.id));
    const unknown = SELECTED.split(",")
      .map((s) => s.trim())
      .filter((id) => id && !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown DAINTREE_E2E_ASSISTANT_WORKFLOW scenario: ${unknown.join(", ")}. Known: ${[...known].join(", ")}`
      );
    }
  }
  for (const scenario of scenarios) {
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
        try {
          if (ctx?.app) await closeApp(ctx.app);
        } finally {
          cleanup?.();
          // The fresh profile holds the assistant's session folder.
          if (ctx?.userDataDir) removePathSync(ctx.userDataDir);
        }
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
        // Extra CLI flags for the assistant, such as a reasoning effort, so one
        // workflow can be measured at several settings.
        const assistantArgs = process.env.DAINTREE_E2E_ASSISTANT_ARGS;
        if (assistantArgs) {
          await page.evaluate(
            (customArgs) => (window as any).electron.helpAssistant.setSettings({ customArgs }),
            assistantArgs
          );
          log(`assistant custom args: ${assistantArgs}`);
        }

        await dispatch(page, "help.togglePanel");
        // A fresh profile has no assistant preference, so the panel asks which
        // agent runs it — pick the one under test the way a user would.
        const chooser = page.locator(`[data-testid="help-choose-agent-${ASSISTANT_AGENT}"]`);
        await expect(chooser.or(page.locator('[data-testid="help-start-assistant"]'))).toBeVisible({
          timeout: 30_000,
        });
        await page.screenshot({ path: path.join(outDir, "00-assistant-chooser.png") });
        if (await chooser.isVisible()) await chooser.click();
        else await page.locator('[data-testid="help-start-assistant"]').click();

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
        // Every agent pane seen during the run (id → agent); the ones not open at the end were closed.
        const seenAgents = new Map<string, string>();
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
              await page.evaluate(
                ([id, data]) => (window as any).electron.terminal.write(id, data),
                [t.id, key === "Enter" ? "\r" : key === "Down" ? "\x1b[B" : "\x1b[A"] as const
              );
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
              const state = (await allTerminals(page)).find(
                (t) => t.id === assistantId
              )?.agentState;
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
        let shot = 1;
        for (const [index, message] of scenario.messages.entries()) {
          const turnStarted = Date.now();
          await submitViaHybridInput(page, assistantId, message);
          log(`message ${index + 1} submitted: ${message.slice(0, 120)}`);

          let lastChange = Date.now();
          let lastFingerprint = "";
          let sawWork = false;
          let settled = false;
          while (Date.now() - scenarioStarted < scenario.timeoutMs) {
            await page.waitForTimeout(POLL_MS);
            const terminals = (await allTerminals(page)).filter((t) => !t.isTrashed);
            for (const t of terminals) {
              const agent = t.launchAgentId ?? t.detectedAgentId;
              if (t.id !== assistantId && agent) seenAgents.set(t.id, agent);
            }
            await answerTrustDialogs(terminals);
            if (scenario.approveConfirms) {
              const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
              if (await dialog.isVisible().catch(() => false)) {
                log(`approving: ${(await dialog.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
                await dialog.getByRole("button").last().click();
              }
            }
            const fleet = terminals
              .map(
                (t) =>
                  `${t.id.slice(-8)} ${t.launchAgentId ?? t.detectedAgentId ?? "shell"} ${t.agentState ?? "-"}`
              )
              .join(" | ");
            const screen = (await getTerminalTextById(page, assistantId)).trimEnd();
            const tail = screen.split("\n").slice(-4).join(" / ");
            const recent = screen.split("\n").slice(-15).join("\n");
            if (PERMISSION_PROMPT.test(recent) && !TRUST_DIALOG.test(recent)) {
              await page.screenshot({ path: path.join(outDir, "98-permission-prompt.png") });
              throw new Error(`the assistant stopped on a permission prompt:\n${recent}`);
            }
            const fingerprint = fleet + tail;
            const busy = terminals.some(
              (t) =>
                t.agentState === "working" && (!scenario.settleOnAssistant || t.id === assistantId)
            );
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
            // A reply faster than one poll never shows as working, so a turn
            // with no work seen settles on quiet once the first window passes.
            const started = sawWork || Date.now() - turnStarted > FIRST_WORK_MS;
            if (started && !busy && Date.now() - lastChange > QUIET_MS) {
              settled = true;
              break;
            }
          }
          if (!settled) {
            await page.screenshot({ path: path.join(outDir, "97-timeout.png") });
            throw new Error(
              `message ${index + 1} never settled within the ${scenario.timeoutMs / 60_000} min budget; last fleet and screen are in timeline.log`
            );
          }
          log(
            `message ${index + 1} settled after ${Math.round((Date.now() - turnStarted) / 1000)}s`
          );
        }
        // Each turn ends with one quiet window that is not work.
        const seconds = Math.round(
          (Date.now() - scenarioStarted - QUIET_MS * scenario.messages.length) / 1000
        );

        const terminals = await allTerminals(page);
        for (const t of terminals) {
          const text = await getTerminalTextById(page, t.id);
          writeFileSync(
            path.join(outDir, `terminal-${t.launchAgentId ?? "shell"}-${t.id.slice(-8)}.txt`),
            text
          );
        }
        const finalText = await getTerminalTextById(page, assistantId);
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
        saveRawTranscripts(sessionDir, scenarioStarted - 60_000, outDir);
        const mcpCalls = transcript.toolCalls.reduce(
          (n, c) =>
            n +
            (c.name.startsWith("mcp__") ? 1 : (c.input.match(/tools\.mcp__\w+\(/g) ?? []).length),
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
          // Includes agents the assistant closed before the run ended.
          launched: [...seenAgents.values()],
          replies: collectReplies(transcript.toolCalls),
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
          replies: metrics.replies,
        };
        writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(summary, null, 2));
        log(`metrics: ${JSON.stringify(summary)}`);

        const worktrees = await dispatch(page, "worktree.list").catch(() => null);
        const worktreeCount = Array.isArray(worktrees?.result?.worktrees)
          ? worktrees.result.worktrees.length
          : Array.isArray(worktrees?.result)
            ? worktrees.result.length
            : 0;

        // Every check reads the transcript, so a run whose session files were
        // not found fails here rather than passing on the screen alone.
        expect(
          metrics.turns,
          `no ${ASSISTANT_AGENT} transcript for ${sessionMarker(sessionDir, ASSISTANT_AGENT === "claude" ? "-" : "/")}`
        ).toBeGreaterThan(0);

        await scenario.check({
          page,
          assistantId,
          workers: workers.filter((t) => !t.isTrashed),
          finalText,
          answer: metrics.answers.join("\n\n"),
          instructions,
          worktreeCount,
          metrics,
        });

        // A close sends the pane to the trash, whose expiry kills the process
        // 20 s later: an agent the assistant closed must actually be gone.
        const stillOpen = new Set(workers.filter((t) => !t.isTrashed).map((t) => t.id));
        const closed = [...seenAgents.keys()].filter((id) => !stillOpen.has(id));
        if (closed.length > 0) {
          await expect
            .poll(
              async () => {
                const live = await allTerminals(page);
                return closed.filter((id) => live.some((t) => t.id === id && t.hasPty !== false));
              },
              { timeout: 45_000, intervals: [2_000] }
            )
            .toEqual([]);
          log(`closed agents ended: ${closed.length}`);
        }
      });
    });
  }
}
