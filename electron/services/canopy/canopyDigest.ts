import { redactSecrets } from "./canopyScreen.js";

/**
 * What an agent's history says above the screen: the requests the user typed,
 * and the plan the agent is working through. Read off a deeper slice of the
 * terminal than the screen the cards are written from, because both scroll out
 * of it within a minute of work — and both are what tell one agent from another
 * and how far along it is.
 *
 * Everything here is lifted verbatim from the terminal; nothing is inferred.
 */
export interface CanopyDigest {
  /**
   * The user's requests, oldest first, at most the last few; null for an agent
   * whose echo of the user's message Daintree cannot tell from its own output.
   */
  requests: string[] | null;
  /** The agent's own checklist, when it draws one, counted exactly. */
  todo: CanopyTodo | null;
  /** Plan lines the agent wrote in prose ("Plan:", "Plan update: …"), newest last. */
  plan: string[];
}

export interface CanopyTodo {
  done: number;
  total: number;
  /** The item marked in progress, verbatim; null when none is. */
  current: string | null;
}

const MAX_REQUESTS = 3;
const MAX_REQUEST_CHARS = 600;
const MAX_PLAN_LINES = 10;

/**
 * How each agent echoes the user's message at the start of a row: Claude
 * Code's `❯`, Codex's `›`, the `>` Gemini and its kin use, Kimi's mode glyphs.
 * Agents that echo in a bordered block (OpenCode, Crush) or whose echo is not
 * known have none, and their requests are not read.
 */
const ECHO: Readonly<Record<string, RegExp>> = {
  claude: /^❯\s+(\S.*)$/,
  codex: /^›\s+(\S.*)$/,
  grok: /^❯\s+(\S.*)$/,
  copilot: /^(?:❯|>)\s+(\S.*)$/,
  amp: /^(?:❯|>)\s+(\S.*)$/,
  gemini: /^>\s+(\S.*)$/,
  qwen: /^>\s+(\S.*)$/,
  antigravity: /^>\s+(\S.*)$/,
  aider: /^(?:ask|architect|help|multi)?>\s+(\S.*)$/,
  interpreter: /^>\s+(\S.*)$/,
  kiro: /^(?:\d+% )?!?>\s+(\S.*)$/,
  mistral: /^(?:❯|>)\s+(\S.*)$/,
  kimi: /^(?:\S*@\S*)?(?:✨|💫|📋)\s+(\S.*)$/,
  cursor: /^→\s+(\S.*)$/,
  goose: /^(?:\( O\)>|🪿)\s+(\S.*)$/,
};

/** Any agent's echo, for telling where a plan stops. */
const PROMPT = /^(?:❯|›|>|→)\s+(\S.*)$/;
/**
 * npm's script banner, which an agent's tool output prints at the start of a
 * row ("> pantry@0.3.0 test", then "> node --test …"): `>` that no user typed.
 */
const NPM_BANNER = /^>\s+\S+@\S+\s+\S+/;
/** An input box is drawn between rules; its contents are a draft, not a request. */
const RULE = /^\s*[─━╌]{8,}\s*$/;
/** Where an echoed request ends: agent output, a dialog, a status line. */
const BREAK = /^\s*(?:⏺|•|●|✦|■|⎿|└|✻|✢|✳|✶|✽|·|\*|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|◼|◻|✔|☐|☒)/;
/** Text an empty input box shows that is not something the user asked. */
const NOT_A_REQUEST =
  /^(?:Try ".*"|Ask Codex to do anything|Type your message|Explain this codebase|Summarize recent commits|Implement \{feature\}|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills|\d+\.\s)/;

/** Claude Code's checklist summary: "6 tasks (4 done, 1 in progress, 1 open)". */
const TODO_SUMMARY = /\b(\d+) tasks? \((\d+) done(?:, (\d+) in progress)?(?:, (\d+) open)?\)/;
const TODO_DONE = /^\s*(?:⎿\s*)?(?:✔|☒|✓|\[x\])\s+\S/;
const TODO_CURRENT = /^\s*(?:⎿\s*)?(?:◼|▣)\s+(\S.*)$/;
const TODO_OPEN = /^\s*(?:⎿\s*)?(?:◻|☐|□|\[ \])\s+\S/;
/** Claude folds a long checklist: "… +2 completed", "… +3 pending". */
const TODO_FOLDED = /^\s*…\s*\+(\d+)\s+(completed|pending|open|in progress)\b/;

const PLAN_HEAD = /^\s*(?:•\s*)?(?:Updated Plan|Plan(?: update)?:)/i;

export function digestHistory(raw: string, agent: string): CanopyDigest {
  const lines = raw.replace(/\r/g, "").split("\n");
  const echo = ECHO[agent];
  const requests = echo === undefined ? null : findRequests(lines, echo);
  // A checklist or plan drawn before the newest request belongs to the work
  // before it: a finished task's 3/3 must not stand for the next one.
  const from = requests !== null && requests.length > 0 ? requests[requests.length - 1]!.row : 0;
  const todo = findTodo(lines, from);
  return {
    requests:
      requests === null
        ? null
        : requests.slice(-MAX_REQUESTS).map((request) => redactSecrets(request.text)),
    todo:
      todo === null
        ? null
        : {
            ...todo,
            current: todo.current === null ? null : redactSecrets(todo.current),
          },
    plan: findPlan(lines, from).map((line) => redactSecrets(line)),
  };
}

interface FoundRequest {
  text: string;
  /** The row the echo starts on. */
  row: number;
}

function findRequests(lines: readonly string[], echo: RegExp): FoundRequest[] {
  const requests: FoundRequest[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NPM_BANNER.test(lines[i]!)) {
      i++;
      continue;
    }
    const match = echo.exec(lines[i]!);
    if (!match) continue;
    if (NOT_A_REQUEST.test(match[1]!.trim())) continue;
    // A prompt drawn just under a rule is the input box: a draft, not sent.
    if (i > 0 && RULE.test(lines[i - 1]!)) continue;
    const row = i;
    const parts = [match[1]!.trim()];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === "" || RULE.test(next) || BREAK.test(next) || echo.test(next)) break;
      parts.push(next.trim());
    }
    i = j - 1;
    const text = parts.join(" ").replace(/\s+/g, " ").slice(0, MAX_REQUEST_CHARS);
    if (text.length >= 3 && requests[requests.length - 1]?.text !== text) {
      requests.push({ text, row });
    }
  }
  return requests;
}

/**
 * The agent's newest checklist at or below row `from`, counted exactly: from
 * Claude Code's summary line when it heads the block ("6 tasks (4 done, …)"),
 * else by its items, folded ones included.
 */
function findTodo(lines: readonly string[], from: number): CanopyTodo | null {
  let end = -1;
  for (let i = lines.length - 1; i >= from; i--) {
    if (isTodoItem(lines[i]!) || TODO_SUMMARY.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  while (start > from && isTodoItem(lines[start - 1]!)) start--;
  // The summary line sits directly above its items, or is the newest line itself.
  const summaryRow = TODO_SUMMARY.test(lines[end]!)
    ? end
    : start > from && TODO_SUMMARY.test(lines[start - 1]!)
      ? start - 1
      : -1;
  let current: string | null = null;
  const itemsFrom = summaryRow === end ? end + 1 : start;
  const itemsTo = summaryRow === end ? Math.min(lines.length - 1, end + 12) : end;
  for (let i = itemsFrom; i <= itemsTo; i++) {
    const item = TODO_CURRENT.exec(lines[i]!);
    if (item) {
      current = item[1]!.trim();
      break;
    }
  }
  if (summaryRow >= 0) {
    const summary = TODO_SUMMARY.exec(lines[summaryRow]!)!;
    const total = Number(summary[1]);
    const done = Number(summary[2]);
    return total > 0 && done <= total ? { done, total, current } : null;
  }
  let done = 0;
  let total = 0;
  for (let i = start; i <= end; i++) {
    const line = lines[i]!;
    const folded = TODO_FOLDED.exec(line);
    if (folded) {
      const count = Number(folded[1]);
      total += count;
      if (folded[2] === "completed") done += count;
      continue;
    }
    total++;
    if (TODO_DONE.test(line)) done++;
  }
  // One stray tick is not a checklist.
  return total >= 2 ? { done, total, current } : null;
}

function isTodoItem(line: string): boolean {
  return (
    TODO_DONE.test(line) ||
    TODO_CURRENT.test(line) ||
    TODO_OPEN.test(line) ||
    TODO_FOLDED.test(line)
  );
}

function findPlan(lines: readonly string[], from: number): string[] {
  let head = -1;
  for (let i = lines.length - 1; i >= from; i--) {
    if (PLAN_HEAD.test(lines[i]!)) {
      head = i;
      break;
    }
  }
  if (head < 0) return [];
  // Codex spaces its numbered steps with blank rows, so a blank row does not
  // end the plan; the agent's next action does.
  const plan: string[] = [];
  for (let i = head; i < lines.length && plan.length < MAX_PLAN_LINES; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (i > head && (BREAK.test(line) || PROMPT.test(line)) && !PLAN_ITEM.test(line)) break;
    plan.push(line.slice(0, 200));
  }
  return plan;
}

const PLAN_ITEM = /^(?:✔|□|☐|☒|◻|◼|└)/;
