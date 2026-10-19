/**
 * Reading a newly started assistant's screen until it is ready for work, for
 * a start with no view (#13511, #13496). Pure: the screen and the keys are
 * the caller's.
 */

export const READY_POLL_MS = 1_000;
/** How long a new assistant gets to open its prompt, its trust question answered on the way. */
export const READY_WAIT_MS = 45_000;
/** How long, once its prompt is up, a new assistant gets to answer its greeting. */
export const GREETING_WAIT_MS = 20_000;
export const READY_SCREEN_LINES = 40;

/**
 * The folder-trust question each agent CLI asks before it opens in a folder
 * it hasn't seen, and the answer that opens it. Only ever answered for the
 * assistant's own session folder (userData/help-sessions/…), which Daintree
 * made: Codex is told to trust it at launch already, and Claude Code asks
 * once per project.
 */
const TRUST_ANSWERS: Readonly<Record<string, { question: RegExp; answer: string }>> = {
  claude: { question: /Yes, I trust this folder/, answer: "Yes, I trust this folder" },
  codex: { question: /Do you trust the contents of this directory/i, answer: "Yes, continue" },
};

/** What a CLI's footer shows once it's at its own prompt, ready for input. */
const READY_MARKERS =
  /\? for shortcuts|bypass permissions|⏵⏵|context left|Ask Codex to do anything/;

/** The greeting's first row as the CLI echoes it, behind its prompt glyph. */
const GREETING_ROW = /^\s*[❯›>]\s*Daintree started you\b/;
/** A row Claude Code (⏺) or Codex (•) starts its answer on. */
const ANSWER_ROW = /^\s*[⏺•]\s*\S/;
/** A tool call or progress line, drawn with the same glyphs as an answer but not one. */
const TOOL_ROW =
  /^\s*[⏺•]\s*(?:[A-Za-z][\w.:-]*\(|(?:Explored|Exploring|Ran|Running|Called|Calling|Edited|Editing|Read|Reading|Searched|Searching|Waited|Waiting|Working|Thinking)\b)|\(MCP\)|esc to interrupt/;
/** Claude Code's ⎿ row: a tool's output under its call, or the CLI's own note under a prompt. */
const RESULT_ROW = /^\s*⎿/;
/**
 * Claude Code's own diagnostic in place of an answer, never the model's prose:
 * the row starts with it ("⏺ Login expired · Please run /login",
 * "⏺ API Error: Request rejected (429) · …", "⎿ You've hit your limit · resets 10am").
 */
const CLAUDE_FAILURE =
  /^\s*[⏺⎿]\s*(?:API Error\b|Login expired\b|Not logged in\b|Invalid API key\b|Credit balance is too low\b|OAuth (?:token|authentication)\b|Please run \/login\b|You(?:'|’)ve hit your (?:[\w-]+ )?limit\b|You(?:'|’)re out of (?:extra )?usage\b|(?:\d+-hour|Session|Weekly) limit reached\b)/i;
/**
 * Codex draws its own errors on ■ rows; these say it can't reach its model at
 * all. Another MCP server failing to start says nothing about Codex itself.
 */
const CODEX_FAILURE =
  /^\s*■(?!.*\bMCP\b).*\b(?:sign(?:ed)? in|log(?:ged)? ?in|unauthori[sz]ed|401|403|access token|api key|usage limit|quota|insufficient|credits?|balance)\b/i;

/**
 * Whether a screen asks about the session folder itself. A wrapped path loses
 * its line breaks and indentation, so both sides are compared without spaces,
 * on the folder's last two segments (`help-sessions/<project hash>`).
 */
function namesFolder(screen: string, folder: string): boolean {
  const tail = folder.replace(/\/+$/, "").split("/").slice(-2).join("/");
  if (!tail.startsWith("help-sessions/")) return false;
  return screen.replace(/\s+/g, "").includes(tail.replace(/\s+/g, ""));
}

/** Whether the last lines of a screen are a CLI's own prompt footer. */
function atPrompt(screen: string): boolean {
  const lines = screen.split("\n").filter((line) => line.trim().length > 0);
  return READY_MARKERS.test(lines.slice(-8).join("\n"));
}

/**
 * How the new assistant answered its greeting, read from the rows under the
 * greeting: an answer, a CLI that couldn't answer at all, or nothing yet.
 * Rows above the greeting (a banner, another server's startup error) never count.
 */
function greetingAnswer(screen: string): "answered" | "failed" | null {
  const rows = screen.split("\n");
  let greeting = -1;
  for (let index = rows.length - 1; index >= 0 && greeting < 0; index--) {
    if (GREETING_ROW.test(rows[index]!)) greeting = index;
  }
  if (greeting < 0) return null;
  let answered = false;
  // Under a tool call, a ⎿ row is that tool's output, whatever it says.
  let underTool = false;
  for (const row of rows.slice(greeting + 1)) {
    if (ANSWER_ROW.test(row)) underTool = TOOL_ROW.test(row);
    const cliOwn = !RESULT_ROW.test(row) || !underTool;
    if ((cliOwn && CLAUDE_FAILURE.test(row)) || CODEX_FAILURE.test(row)) return "failed";
    if (ANSWER_ROW.test(row) && !underTool) answered = true;
  }
  return answered ? "answered" : null;
}

export type AssistantReadiness = "ready" | "timed-out" | "agent-error" | "consent-withdrawn";

export interface AssistantReadinessIo {
  agentId: string;
  /** The assistant's own session folder: the only one whose trust question is answered. */
  cwd: string;
  /** The latest screen, or null when it couldn't be read this time. */
  screen(): Promise<string | null>;
  /** Choose `answer` on the trust question now on screen. */
  answerTrust(answer: string): Promise<void>;
  /** Asked again before each look at the screen and before anything is typed; false stops the wait. */
  authorized(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Until the new assistant has answered its greeting, answering only its own
 * folder-trust question. A CLI that answers with a failure (signed out, its
 * account refused) is no assistant to hand work to; one at its prompt that
 * hasn't answered yet is given the benefit of the doubt once its time is up.
 */
export async function untilAssistantReady(io: AssistantReadinessIo): Promise<AssistantReadiness> {
  const trust = TRUST_ANSWERS[io.agentId];
  const deadline = io.now() + READY_WAIT_MS;
  let promptAt: number | null = null;
  // Ready is what the latest screen shows, never one seen earlier.
  let atPromptNow = false;
  while (io.now() < deadline) {
    if (!io.authorized()) return "consent-withdrawn";
    const screen = await io.screen();
    atPromptNow = false;
    if (screen !== null) {
      if (trust && trust.question.test(screen) && namesFolder(screen, io.cwd)) {
        if (!io.authorized()) return "consent-withdrawn";
        await io.answerTrust(trust.answer);
      } else {
        const answer = greetingAnswer(screen);
        if (answer === "failed") return "agent-error";
        if (atPrompt(screen)) {
          atPromptNow = true;
          promptAt ??= io.now();
          if (answer === "answered" || io.now() - promptAt >= GREETING_WAIT_MS) return "ready";
        }
      }
    }
    await io.sleep(READY_POLL_MS);
  }
  return atPromptNow ? "ready" : "timed-out";
}
