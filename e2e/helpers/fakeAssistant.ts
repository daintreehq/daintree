/**
 * A fake `daintree-assistant` CLI.
 *
 * The Assistant's conversation is not React — it is a PTY running an external
 * agent CLI, and the real one talks to a hosted backend. So the only way to
 * photograph a live session offline is to be that CLI.
 *
 * The binary does three things the surrounding UI reacts to:
 *
 *  1. Prints a scripted exchange, so the transcript is not empty.
 *  2. Heartbeats OSC 9;4, which is what drives the header's state indicator —
 *     the same mechanism `fakeAgent.ts` uses for ordinary agents.
 *  3. Calls the MCP server over the credentials Daintree injects into its own
 *     environment (`DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN`), which is what
 *     puts real rows in the footer activity strip and, for the figure rail,
 *     what pins documentation images into the panel.
 *
 * Nothing here fabricates UI. Every surface in the resulting screenshots is
 * the app responding to a client that behaved like the real one.
 */

import { chmodSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

export interface FakeAssistantOptions {
  /**
   * Image URLs to pin via `help.displayImage`. The tool validates the origin,
   * so these must be https on daintree.org or a subdomain — and the machine
   * needs network, because the rail renders real thumbnails.
   */
  figures?: Array<{ url: string; caption: string }>;
}

/**
 * Write the fake assistant into `<binDir>` and return the directory.
 * Pass the same dir to `fakeAgentEnv` so it lands on PATH.
 */
export function installFakeAssistant(binDir: string, options: FakeAssistantOptions = {}): string {
  mkdirSync(binDir, { recursive: true });
  const impl = path.join(binDir, "daintree-assistant");
  const figures = options.figures ?? [];

  const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('daintree-assistant 0.9.0');
  process.exit(0);
}

const MCP_URL = process.env.DAINTREE_MCP_URL;
const MCP_TOKEN = process.env.DAINTREE_MCP_TOKEN;
const FIGURES = ${JSON.stringify(figures)};

let sessionId = null;

async function rpc(body) {
  if (!MCP_URL || !MCP_TOKEN) return null;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + MCP_TOKEN,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  try {
    const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    const line = text.split('\\n').find((l) => l.startsWith('data:')) || text;
    try { return JSON.parse(line.replace(/^data:\\s*/, '')); } catch { return null; }
  } catch { return null; }
}

async function handshake() {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'daintree-assistant', version: '0.9.0' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function call(name, args) {
  return rpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
    params: { name, arguments: args || {} } });
}

const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';
let beat = null;
const startWorking = () => {
  if (beat) return;
  process.stdout.write(OSC_WORKING);
  beat = setInterval(() => process.stdout.write(OSC_WORKING), 1000);
};

async function main() {
  console.log('\\u001b[2mDaintree Assistant · connected\\u001b[0m');
  console.log('');
  console.log('\\u001b[1m▌ How do I get a review going on the reconciliation branch?\\u001b[0m');
  console.log('');
  startWorking();
  await handshake();

  const list = await call('worktree.list');
  const count = (() => {
    try {
      const text = list && list.result && list.result.content && list.result.content[0].text;
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.length : (parsed.worktrees || []).length;
    } catch { return 0; }
  })();

  console.log('\\u001b[32m⏺\\u001b[0m worktree.list  \\u001b[2m→ ' + count + ' worktrees\\u001b[0m');
  console.log('');
  console.log('Open the Review Hub on that worktree and Daintree stages what the');
  console.log('agent touched, so you read the diff before anything is committed.');
  console.log('');

  for (let i = 0; i < FIGURES.length; i++) {
    await call('help.displayImage', { url: FIGURES[i].url, caption: FIGURES[i].caption });
  }
  if (FIGURES.length) {
    console.log('The worktree card is shown in [image #1], and the Review Hub it');
    console.log('opens in [image #2].');
    console.log('');
  }

  process.stdin.resume();
  setInterval(() => {}, 1000);
}

main();
`;

  writeFileSync(impl, script);
  chmodSync(impl, 0o755);
  return binDir;
}
