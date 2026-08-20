/**
 * A fake `claude` binary that drives the real agent-state FSM.
 *
 * Extracted from `e2e/full/terminal/terminal-agent-state-status.spec.ts`, which
 * still owns the behavioural assertions. The theme tour needs the same thing for
 * a different reason: a theme that reserves its loudest colour for "an agent is
 * waiting on you" cannot be reviewed without an agent that is actually waiting,
 * and faking the CSS class would review a state the app never produces.
 *
 * The binary emits OSC 9;4 taskbar-progress on a heartbeat, which is what
 * `AgentStateService` reads. Heartbeat running = `working`; heartbeat stopped,
 * plus the idle debounce, = `waiting`.
 */

import { chmodSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { Page } from "@playwright/test";

export const FAKE_AGENT_STOP = "__DAINTREE_FAKE_CLAUDE_STOP__";
export const FAKE_AGENT_IDLE = "__DAINTREE_FAKE_CLAUDE_IDLE__";
export const FAKE_AGENT_READY = "FAKE_CLAUDE_READY";

/**
 * Write the fake CLI into `<repoDir>/.e2e bin` and return that directory.
 * The space in the directory name is deliberate — it keeps launches exercising
 * the quoted-absolute-path form that real resolved CLI paths can take.
 */
export function installFakeAgent(repoDir: string): string {
  const binDir = path.join(repoDir, ".e2e bin");
  mkdirSync(binDir, { recursive: true });

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const impl = path.join(binDir, implName);

  writeFileSync(
    impl,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      `const stopToken = ${JSON.stringify(FAKE_AGENT_STOP)};`,
      `const idleToken = ${JSON.stringify(FAKE_AGENT_IDLE)};`,
      // OSC 9;4 taskbar-progress: state 1 = working, state 0 = idle hint.
      "const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';",
      "const OSC_IDLE = '\\u001b]9;4;0;0\\u0007';",
      "console.log('Accessing workspace:');",
      "console.log('');",
      "console.log(' ' + process.cwd());",
      "console.log('');",
      "console.log(' Quick safety check: Is this a project you created or one you trust?');",
      "console.log('');",
      "console.log(' \\u276f 1. Yes, I trust this folder');",
      "console.log('   2. No, exit');",
      "console.log('');",
      "console.log(' Enter to confirm \\u00b7 Esc to cancel');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let trusted = false;",
      "let workingTimer = null;",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const startWorking = () => {",
      "  if (workingTimer) return;",
      "  process.stdout.write(OSC_WORKING);",
      "  workingTimer = setInterval(() => process.stdout.write(OSC_WORKING), 1000);",
      "};",
      "const stopWorking = () => {",
      "  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }",
      "  process.stdout.write(OSC_IDLE);",
      "};",
      "const shutdown = () => {",
      "  stopWorking();",
      "  console.log('FAKE_CLAUDE_EXIT');",
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "};",
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  if (!trusted && /[\\r\\n]/.test(input)) {",
      "    trusted = true;",
      `    console.log('${FAKE_AGENT_READY}');`,
      "    startWorking();",
      "    return;",
      "  }",
      "  if (!trusted) return;",
      "  if (input.includes(stopToken)) { shutdown(); return; }",
      "  if (input.includes(idleToken)) { stopWorking(); return; }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(impl, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  return binDir;
}

/** Launch env that puts the fake CLI ahead of any real one on PATH. */
export function fakeAgentEnv(binDir: string): Record<string, string> {
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: binDir,
    DAINTREE_IDENTITY_DEBUG_PASS: "1",
  };
}

/** Write straight to a panel's PTY. Returns false if the bridge is unavailable. */
export async function ptyWrite(page: Page, terminalId: string, data: string): Promise<boolean> {
  return page
    .evaluate(
      ([id, payload]) => {
        const w = window as unknown as {
          electron?: { terminal?: { write?: (id: string, data: string) => void } };
        };
        if (!w.electron?.terminal?.write) return false;
        w.electron.terminal.write(id, payload);
        return true;
      },
      [terminalId, data]
    )
    .catch(() => false);
}
