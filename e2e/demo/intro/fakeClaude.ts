/**
 * A scriptable fake `claude` for the intro video. It renders a Claude Code-like
 * transcript and drives the real agent-state FSM with the same OSC 9;4 heartbeat
 * the e2e fake uses (heartbeat on = working, off + debounce = waiting).
 *
 * Control commands arrive on stdin framed as \x01<json>\x02 so nothing echoes;
 * stdin runs in raw mode and anything else is treated as the user typing.
 */

import { chmodSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { Page } from "@playwright/test";

export interface AgentTask {
  /** Prompt shown as if the user typed it. Omit to continue silently. */
  prompt?: string;
  title?: string;
  /** Transcript lines emitted one by one while working. */
  steps?: string[];
  stepMs?: number;
  /** What happens after the steps: keep looping, ask a question, or finish. */
  then?: "loop" | "ask" | "done";
  question?: string;
  options?: string[];
  summary?: string;
  spin?: string;
  /** Task to continue with after the user answers a question. */
  after?: AgentTask;
  /** Overrides applied when the user types a free-form reply. */
  onReply?: Partial<AgentTask>;
}

const SCRIPT = String.raw`#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const out = (s) => process.stdout.write(s);
const ORANGE = '\x1b[38;2;215;119;87m', GREY = '\x1b[38;2;140;140;140m', DIM = '\x1b[2m', R = '\x1b[0m', B = '\x1b[1m', GREEN = '\x1b[38;2;78;186;101m', RED = '\x1b[38;2;255;107;128m', BLUE = '\x1b[38;2;177;185;249m';
const OSC_WORKING = '\x1b]9;4;1;0\x07', OSC_IDLE = '\x1b]9;4;0;0\x07';
const title = (t) => out('\x1b]0;' + t + '\x07');
const cols = () => 58;
const cwd = process.env.DEMO_CWD_LABEL || process.cwd();
function box(lines, colour) {
  const w = cols() - 2;
  const c = colour || GREY;
  out(c + '╭' + '─'.repeat(w - 2) + '╮' + R + '\r\n');
  for (const l of lines) {
    const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, w - 4 - [...plain].length);
    out(c + '│' + R + ' ' + l + ' '.repeat(pad) + ' ' + c + '│' + R + '\r\n');
  }
  out(c + '╰' + '─'.repeat(w - 2) + '╯' + R + '\r\n');
}
const fmt = (line) => line
  .replace(/^• /, ORANGE + '⏺' + R + ' ')
  .replace(/^\+ /, GREEN + '+ ' )
  .replace(/^- /, RED + '- ')
  .replace(/^> /, GREY + '> ' + R)
  .replace(/^\| /, '  ' + GREY + '⎿  ' + R + DIM) + R;

let heartbeat = null;
function working(on) {
  if (on && !heartbeat) { out(OSC_WORKING); heartbeat = setInterval(() => out(OSC_WORKING), 1000); }
  if (!on) { if (heartbeat) clearInterval(heartbeat); heartbeat = null; out(OSC_IDLE); }
}
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽'];
let spinTimer = null, spinLabel = '', spinStart = 0, spinI = 0;
function spinner(label) {
  stopSpinner();
  spinLabel = label; spinStart = Date.now();
  const draw = () => {
    const s = Math.floor((Date.now() - spinStart) / 1000);
    out('\r\x1b[2K' + ORANGE + SPIN[spinI++ % SPIN.length] + ' ' + spinLabel + '…' + R + GREY + ' (' + s + 's · esc to interrupt)' + R);
  };
  draw(); spinTimer = setInterval(draw, 120);
}
function stopSpinner() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; out('\r\x1b[2K'); } }
function print(line) { const wasSpinning = !!spinTimer; stopSpinner(); out(fmt(line) + '\r\n'); if (wasSpinning) spinner(spinLabel); }

let run = 0;
let current = null;
const GENERIC = ['• Read(src/index.ts)', '| Read 88 lines', '• Search(pattern: "TODO", path: "src")', '| Found 4 files', '• Update(src/index.ts)', '| Updated src/index.ts with 12 additions and 3 removals', '• Bash(npm test -- --run)', '| ✓ 42 tests passed'];
async function startTask(task) {
  const my = ++run;
  current = task;
  stopSpinner();
  if (task.prompt) out('\r\n' + GREY + '> ' + R + B + task.prompt + R + '\r\n\r\n');
  if (task.title) title('✳ ' + task.title);
  working(true);
  const steps = task.steps ? task.steps : GENERIC;
  const ms = task.stepMs || 1400;
  spinner(task.spin || 'Working');
  let i = 0;
  while (my === run && steps.length) {
    await new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6)));
    if (my !== run) return;
    print(steps[i % steps.length]);
    i++;
    if (i >= steps.length && task.then !== 'loop') break;
  }
  if (my !== run) return;
  stopSpinner();
  if (task.then === 'ask') {
    out('\r\n');
    const opts = task.options || ['Yes', "Yes, and don't ask again this session", 'No, and tell Claude what to do differently'];
    box([B + (task.question || 'Do you want to proceed?') + R, '', ...opts.map((o, n) => (n === 0 ? BLUE + '❯ ' : '  ') + (n + 1) + '. ' + o + R)], BLUE);
    out(GREY + '  Esc to cancel' + R + '\r\n');
    working(false);
  } else {
    if (task.summary) out('\r\n' + ORANGE + '⏺' + R + ' ' + task.summary + '\r\n');
    out('\r\n');
    working(false);
  }
  prompt();
}
function prompt() { out(GREY + '> ' + R); }

let typed = '';
let buf = '';
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  buf += String(chunk).replace(/\x1b\[20[01]~/g, '');
  for (;;) {
    const s = buf.indexOf('\x01');
    if (s < 0) { handleTyped(buf); buf = ''; return; }
    if (s > 0) { handleTyped(buf.slice(0, s)); buf = buf.slice(s); continue; }
    const e = buf.indexOf('\x02');
    if (e < 0) return;
    const payload = buf.slice(1, e); buf = buf.slice(e + 1);
    try { command(JSON.parse(payload)); } catch (err) { /* ignore */ }
  }
});
function handleTyped(text) {
  for (const ch of text) {
    if (ch === '\x03') { process.exit(0); }
    if (ch === '\r' || ch === '\n') {
      const line = typed.trim(); typed = '';
      out('\r\n');
      if (!line) { prompt(); continue; }
      if (current && current.then === 'ask') {
        const next = Object.assign({}, current.after || current, { prompt: undefined, then: (current.after && current.after.then) || 'loop' });
        startTask(next);
      } else {
        const next = Object.assign({}, current || {}, current && current.onReply ? current.onReply : {}, { prompt: undefined, then: 'loop' });
        startTask(next);
      }
      continue;
    }
    if (ch === '\x7f') { if (typed.length) { typed = typed.slice(0, -1); out('\b \b'); } continue; }
    if (ch < ' ') continue;
    if (!typed.length) { stopSpinner(); if (!spinTimer) out('\r\x1b[2K' + GREY + '> ' + R); }
    typed += ch; out(B + ch + R);
  }
}
function command(c) {
  if (c.type === 'task') startTask(c.task);
  else if (c.type === 'idle') { run++; stopSpinner(); working(false); prompt(); }
  else if (c.type === 'clear') { out('\x1b[2J\x1b[H'); }
  else if (c.type === 'print') { for (const l of c.lines) print(l); }
}

title('✳ Claude Code');
out('\r\n');
box([ORANGE + '✻' + R + ' Welcome to ' + B + 'Claude Code' + R + '!', '', GREY + '  /help for help, /status for your current setup' + R, '', GREY + '  cwd: ' + (cwd.length > 44 ? '…' + cwd.slice(-43) : cwd) + R], ORANGE);
out('\r\n');
out(GREY + ' Tip: Use git worktrees to run multiple Claude sessions in parallel' + R + '\r\n\r\n');
prompt();
setInterval(() => {}, 1 << 30);
`;

export function installRichFakeClaude(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const impl = path.join(binDir, "claude");
  writeFileSync(impl, SCRIPT);
  chmodSync(impl, 0o755);
  return binDir;
}

export function fakeClaudeEnv(binDir: string): Record<string, string> {
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: binDir,
  };
}

function frame(obj: unknown): string {
  return `\x01${JSON.stringify(obj)}\x02`;
}

export async function agentCommand(page: Page, terminalId: string, obj: unknown): Promise<void> {
  await page.evaluate(
    ([id, data]) => {
      (
        window as unknown as { electron: { terminal: { write: (i: string, d: string) => void } } }
      ).electron.terminal.write(id, data);
    },
    [terminalId, frame(obj)] as const
  );
}

export const startTask = (page: Page, id: string, task: AgentTask) =>
  agentCommand(page, id, { type: "task", task });
