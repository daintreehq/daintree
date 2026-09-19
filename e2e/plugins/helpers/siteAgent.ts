import { chmodSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

export const SITE_AGENT_READY = "SITE_AGENT_READY";
export const SITE_AGENT_EDITED = "SITE_AGENT_EDITED";

/**
 * A fake `claude` that does what a real agent would with a Site Builder task,
 * deterministically: it reads the submitted prompt, takes the source location
 * the Inspector put in it, and makes the requested text change in that file.
 *
 * It understands two instructions — `Change the text to "…"` and
 * `Add the classes "…"` — and edits
 * only the line the prompt names. That is the point: the edit can only land if
 * the prompt carried a correct, worktree-relative source location, so a passing
 * run proves the context packet, not a lucky search.
 *
 * Every prompt it receives is appended to `inbox.txt` beside the binary, and
 * the raw input chunks to `inbox.txt.raw`, so a failing run can show what
 * actually arrived.
 */
export function installSiteAgent(repoDir: string): { binDir: string; inbox: string } {
  const binDir = path.join(repoDir, ".e2e bin");
  mkdirSync(binDir, { recursive: true });
  const inbox = path.join(binDir, "inbox.txt");
  const impl = path.join(binDir, process.platform === "win32" ? "claude.js" : "claude");

  writeFileSync(
    impl,
    `#!/usr/bin/env node
// No require(): the fixture project is "type": "module", so Node loads this
// extensionless script as ESM there. getBuiltinModule works in both.
const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
if (process.argv.includes("--version")) {
  console.log("claude code v9.9.9");
  process.exit(0);
}
const INBOX = ${JSON.stringify(inbox)};
fs.appendFileSync(INBOX + ".raw", "started pid=" + process.pid + " node=" + process.version + "\\n");
const OSC_WORKING = "\\u001b]9;4;1;0\\u0007";
const OSC_IDLE = "\\u001b]9;4;0;0\\u0007";
const PASTE_START = "\\u001b[200~";
const PASTE_END = "\\u001b[201~";

console.log("Accessing workspace:");
console.log("");
console.log(" " + process.cwd());
console.log("");
console.log(" Quick safety check: Is this a project you created or one you trust?");
console.log("");
console.log(" \\u276f 1. Yes, I trust this folder");
console.log("   2. No, exit");
console.log("");
console.log(" Enter to confirm \\u00b7 Esc to cancel");

let trusted = false;
let buffer = "";
let settle = null;
setInterval(() => {}, 1000);
process.stdin.resume();
process.stdin.setEncoding("utf8");

function handlePrompt(prompt) {
  fs.appendFileSync(INBOX, prompt + "\\n----\\n");
  process.stdout.write(OSC_WORKING);
  const source = /^- Source: <([a-z0-9-]+)> at (.+):(\\d+):(\\d+)$/m.exec(prompt);
  const text = /Change the text to "([^"]+)"/.exec(prompt);
  const classes = /Add the classes "([^"]+)"/.exec(prompt);
  if (!source || (!text && !classes)) {
    console.log("SITE_AGENT_CONFUSED");
    process.stdout.write(OSC_IDLE);
    return;
  }
  const [, tag, file, line] = source;
  const target = path.join(process.cwd(), file);
  const lines = fs.readFileSync(target, "utf8").split("\\n");
  const index = Number(line) - 1;
  if (text) {
    const pattern = new RegExp("(<" + tag + "\\\\b[^>]*>)([^<]*)(</" + tag + ">)");
    lines[index] = lines[index].replace(pattern, (_m, open, _t, close) => open + text[1] + close);
  } else {
    const pattern = new RegExp("(<" + tag + "\\\\b[^>]*\\\\bclass=\\")([^\\"]*)(\\")");
    lines[index] = lines[index].replace(pattern, (_m, open, value, close) => open + value + " " + classes[1] + close);
  }
  fs.writeFileSync(target, lines.join("\\n"));
  console.log(${JSON.stringify(SITE_AGENT_EDITED)} + " " + file + ":" + line);
  setTimeout(() => process.stdout.write(OSC_IDLE), 300);
}

process.stdin.on("data", (chunk) => {
  if (!trusted) fs.appendFileSync(INBOX + ".raw", "pre-trust " + JSON.stringify(chunk) + "\\n");
  if (!trusted) {
    if (/[\\r\\n]/.test(chunk)) {
      trusted = true;
      console.log(${JSON.stringify(SITE_AGENT_READY)});
      // Real agent TUIs turn on bracketed paste; the host frames a multi-line
      // submission by it.
      process.stdout.write("\\u001b[?2004h" + OSC_IDLE);
    }
    return;
  }
  fs.appendFileSync(INBOX + ".raw", JSON.stringify(chunk) + "\\n");
  buffer += chunk;
  // Take whatever arrived once input goes quiet. How the host frames a
  // submission (bracketed paste, line-by-line, a separate Enter) is its own
  // business; the prompt's content is what this agent is here to check.
  clearTimeout(settle);
  settle = setTimeout(() => {
    const prompt = buffer
      .split(PASTE_START).join("")
      .split(PASTE_END).join("")
      .replace(/\\r\\n?/g, "\\n")
      .trim();
    buffer = "";
    if (prompt) handlePrompt(prompt);
  }, 500);
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`
  );
  chmodSync(impl, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }
  return { binDir, inbox };
}
