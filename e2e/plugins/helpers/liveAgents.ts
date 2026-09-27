import path from "path";
import type { Page } from "@playwright/test";
import { getTerminalTextById } from "../../helpers/terminal";

/**
 * Driving real agent CLIs inside the app: launch, answer the folder-trust
 * dialog each CLI raises as a user who trusts their own project would, wait
 * for the composer, submit a turn and wait for its effect. Shared by the live
 * specs; nothing here fakes an agent.
 */

const TRUST_LABELS = [
  "Yes, I trust this folder",
  "Trust and continue",
  "Yes, proceed",
  "Trust folder",
  "Yes",
];
const TRUST_DIALOG =
  /Trust this folder\?|Trust and continue|do you trust|trust the files in this folder|Yes, I trust this folder|Do you trust this folder/i;

/**
 * A CLI asking before it runs a tool. Codex asks for every MCP tool not
 * annotated read-only, even with approvals bypassed; Gemini asks for MCP and
 * shell tools in a folder it was only trusted for once. Answered for this
 * session only, never "always", which would write the user's own agent config.
 */
const TOOL_APPROVAL_LABELS = ["Allow for this session", "Allow once", "Allow"];
const TOOL_APPROVAL_DIALOG = /Allow the .{1,80} MCP server to run tool|Allow execution of/i;

/** A row that reads exactly `label`, after a highlight marker, a number and any box frame. */
function hasExactOption(screen: string, label: string): boolean {
  const wanted = label.toLowerCase();
  return screen.split("\n").some((row) => {
    const text = row
      .replace(/^\s*[│┃║]/, "")
      .replace(/[│┃║]\s*$/, "")
      .replace(/^\s*(?:[❯›>▶➜→●]\s*)?(?:\d+[.)]\s*)?/, "")
      .trim()
      .split(/\s{2,}/)[0]
      ?.toLowerCase();
    return text === wanted;
  });
}

export async function dispatch<T = unknown>(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<T> {
  const result = await page.evaluate(
    async ([id, payload]) => {
      const run = (window as unknown as Record<string, unknown>).__daintreeDispatchAction as (
        id: string,
        args?: unknown,
        options?: { source: string }
      ) => Promise<{ ok: boolean; result?: unknown; error?: unknown }>;
      return run(id, payload, { source: "user" });
    },
    [actionId, args] as const
  );
  if (!result.ok) throw new Error(`${actionId} failed: ${JSON.stringify(result.error)}`);
  return result.result as T;
}

/**
 * Run as if opened from the Dock: a harness started inside an agent session
 * would hand that session's variables to every agent it launches.
 */
export function stripAgentSessionEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_PID") {
      delete process.env[key];
    }
  }
}

/**
 * App launch env with `DAINTREE_E2E_LIVE_PATH_PREPEND` first on PATH: wrapper
 * CLIs for a machine where an installed one cannot start as-is.
 */
export function liveLaunchEnv(): Record<string, string> {
  const prepend = process.env.DAINTREE_E2E_LIVE_PATH_PREPEND;
  return prepend
    ? {
        PATH: `${prepend}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: prepend,
      }
    : {};
}

export interface AgentRun {
  agentId: string;
  terminalId: string;
  outcomes: Record<string, string>;
  seconds: Record<string, number>;
  launchedAt: number;
  /** False once `ready()` gave up: its turns are recorded as not run, never typed into a dialog. */
  ready?: boolean;
}

export class LiveAgents {
  constructor(
    private readonly page: Page,
    private readonly log: (line: string) => void,
    private readonly turnTimeoutMs: number
  ) {}

  /** Tool calls must not stop for approval: these are throwaway projects. */
  async skipPermissions(agentIds: readonly string[]): Promise<void> {
    for (const agentId of agentIds) {
      await this.page.evaluate(
        (id) => window.electron.agentSettings.set(id, { dangerousEnabled: true }),
        agentId
      );
    }
  }

  async launch(agentId: string): Promise<AgentRun> {
    const { terminalId } = await dispatch<{ terminalId: string }>(this.page, "agent.launch", {
      agentId,
      location: "grid",
    });
    this.log(`${agentId}: launched ${terminalId}`);
    return { agentId, terminalId, outcomes: {}, seconds: {}, launchedAt: Date.now() };
  }

  async screen(terminalId: string): Promise<string> {
    return (await getTerminalTextById(this.page, terminalId).catch(() => "")).trimEnd();
  }

  /** Answer a trust dialog or a tool approval on screen; true when one was answered. */
  private readonly answered = new Map<string, { tail: string; at: number }>();

  private async answerTrust(run: AgentRun): Promise<boolean> {
    const text = await this.screen(run.terminalId);
    const tail = text.split("\n").slice(-30).join("\n");
    const labels = TRUST_DIALOG.test(tail)
      ? TRUST_LABELS
      : TOOL_APPROVAL_DIALOG.test(tail)
        ? TOOL_APPROVAL_LABELS
        : null;
    if (labels === null) return false;
    // The dialog just answered can linger on screen while the CLI redraws;
    // pressing again then would type into whatever took its place. A CLI that
    // asks the same question again (Gemini, for a repeated tool call) is
    // answered once the redraw has had time to land.
    const last = this.answered.get(run.terminalId);
    if (last?.tail === tail && Date.now() - last.at < 4000) return false;
    for (const label of labels) {
      // Only a row that is exactly this option, so "Yes" can never land on
      // "Yes, and remember…" when the plain answer is missing.
      if (!hasExactOption(tail, label)) continue;
      const ok = await dispatch(this.page, "terminal.sendKeys", {
        terminalId: run.terminalId,
        choose: label,
      }).then(
        () => true,
        () => false
      );
      if (ok) {
        this.answered.set(run.terminalId, { tail, at: Date.now() });
        this.log(`${run.agentId}: answered "${label}"`);
        return true;
      }
    }
    this.log(`${run.agentId}: dialog with no known option:\n${text.slice(-800)}`);
    return false;
  }

  /**
   * No dialog on screen, the agent at its prompt, and the screen unchanged for
   * three polls running, at least five seconds after launch. A CLI that boots
   * slowly (Gemini takes ~15 s) reads as idle while it is still drawing, and
   * raises its trust dialog after the others are already working, so each
   * agent waits on its own screen rather than on the group.
   */
  async ready(run: AgentRun, timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let settled = 0;
    let previous = "";
    while (Date.now() < deadline) {
      if (await this.answerTrust(run)) {
        settled = 0;
      } else {
        const text = await this.screen(run.terminalId);
        const terminals = await this.page.evaluate(() =>
          window.electron.terminal.getAllTerminals()
        );
        const state = terminals.find((t) => t.id === run.terminalId)?.agentState;
        const dialog = TRUST_DIALOG.test(text.split("\n").slice(-30).join("\n"));
        const quiet =
          !dialog &&
          (state === "idle" || state === "waiting") &&
          text === previous &&
          Date.now() - run.launchedAt >= 5000;
        settled = quiet ? settled + 1 : 0;
        previous = text;
        if (settled >= 3) {
          this.log(`${run.agentId}: ready`);
          run.ready = true;
          return true;
        }
      }
      await this.page.waitForTimeout(2000);
    }
    this.log(
      `${run.agentId}: never settled at its prompt\n${(await this.screen(run.terminalId)).slice(-1500)}`
    );
    run.ready = false;
    return false;
  }

  /** Submit a prompt and wait until `done()` holds, answering trust dialogs meanwhile. */
  async turn(
    run: AgentRun,
    name: string,
    prompt: string,
    done: () => Promise<boolean> | boolean
  ): Promise<boolean> {
    if (run.ready === false) {
      run.outcomes[name] = "not-ready";
      run.seconds[name] = 0;
      return false;
    }
    const started = Date.now();
    this.log(`${run.agentId}: ${name} ← ${prompt}`);
    await dispatch(this.page, "terminal.sendCommand", {
      terminalId: run.terminalId,
      command: prompt,
    });
    const deadline = started + this.turnTimeoutMs;
    while (Date.now() < deadline) {
      await this.answerTrust(run);
      if (await done()) {
        run.outcomes[name] = "ok";
        run.seconds[name] = Math.round((Date.now() - started) / 1000);
        this.log(`${run.agentId}: ${name} ok in ${run.seconds[name]}s`);
        return true;
      }
      await this.page.waitForTimeout(2000);
    }
    run.outcomes[name] = "timeout";
    run.seconds[name] = Math.round((Date.now() - started) / 1000);
    this.log(
      `${run.agentId}: ${name} TIMED OUT\n${(await this.screen(run.terminalId)).slice(-2500)}`
    );
    return false;
  }
}

export function summarize(runs: readonly AgentRun[]): Array<Record<string, string>> {
  return runs.map((run) => ({
    agent: run.agentId,
    ...Object.fromEntries(
      Object.entries(run.outcomes).map(([k, v]) => [k, `${v} (${run.seconds[k]}s)`])
    ),
  }));
}
