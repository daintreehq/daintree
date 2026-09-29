import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export const RECORDER_READY = "LAUNCH_RECORDER_READY";

/** Env a recorder keeps: everything that could carry MCP wiring. */
const ENV_PATTERN = "^(DAINTREE_|GEMINI_CLI_|OPENCODE_CONFIG|QWEN_CODE_|VIBE_MCP_SERVERS$)";

export interface RecordedLaunch {
  agent: string;
  paneId: string | null;
  argv: string[];
  env: Record<string, string>;
  /** Contents of every file the launch pointed at (`--mcp-config`, a settings env var), by path. */
  files: Record<string, string>;
  at: number;
}

/**
 * Stand-in CLIs for the named agents that record exactly what Daintree
 * launched them with — argv, the MCP-carrying env, and the contents of any
 * config file those point at, read while the launch is live — then sit at a
 * prompt until killed. Everything an agent would need to reach its servers is
 * in the record, so a spec can connect exactly as the agent would have.
 */
export function installLaunchRecorders(repoDir: string, agents: readonly string[]): string {
  const binDir = path.join(repoDir, ".e2e bin");
  mkdirSync(binDir, { recursive: true });
  for (const agent of agents) {
    const file = path.join(binDir, agent);
    writeFileSync(
      file,
      `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("${agent} 99.0.0");
  process.exit(0);
}
const argv = process.argv.slice(2);
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (new RegExp(${JSON.stringify(ENV_PATTERN)}).test(key)) env[key] = value;
}
const files = {};
const grab = (p) => { try { if (p && fs.statSync(p).isFile()) files[p] = fs.readFileSync(p, "utf8"); } catch {} };
argv.forEach((arg, i) => { if (arg === "--mcp-config" || arg === "--additional-mcp-config") grab(String(argv[i + 1]).replace(/^@/, "")); });
for (const value of Object.values(env)) if (value.startsWith("/") || /^[A-Za-z]:\\\\/.test(value)) grab(value);
const pane = String(process.env.DAINTREE_PANE_ID || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
fs.writeFileSync(
  path.join(__dirname, "launch.${agent}." + pane + ".json"),
  JSON.stringify({ agent: ${JSON.stringify(agent)}, paneId: process.env.DAINTREE_PANE_ID || null, argv, env, files, at: Date.now() }),
  { mode: 0o600 }
);
console.log(${JSON.stringify(RECORDER_READY)} + " ${agent}");
process.stdin.resume();
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));
`
    );
    chmodSync(file, 0o755);
  }
  return binDir;
}

export function readRecordedLaunches(binDir: string, agent?: string): RecordedLaunch[] {
  if (!existsSync(binDir)) return [];
  return readdirSync(binDir)
    .filter((name) => name.startsWith("launch.") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(binDir, name), "utf8")) as RecordedLaunch)
    .filter((launch) => agent === undefined || launch.agent === agent)
    .sort((a, b) => a.at - b.at);
}

export interface LaunchedServer {
  key: string;
  url: string;
  bearer: string;
}

function bearerFromHeaders(headers: unknown): string {
  const auth = (headers as Record<string, string> | undefined)?.Authorization ?? "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) throw new Error(`no bearer in headers ${JSON.stringify(headers)}`);
  return match[1];
}

type ServerEntry = { url?: string; httpUrl?: string; headers?: unknown };

/** Every dialect's server map: `mcpServers` when wrapped, else the object itself (Amp). */
function serverMap(parsed: { mcpServers?: Record<string, ServerEntry> }): LaunchedServer[] {
  const map = parsed.mcpServers ?? (parsed as Record<string, ServerEntry>);
  return Object.entries(map)
    .filter(([key]) => isDaintreeKey(key))
    .map(([key, entry]) => {
      const url = entry.url ?? entry.httpUrl;
      if (!url) throw new Error(`server ${key} has no url`);
      return { key, url, bearer: bearerFromHeaders(entry.headers) };
    });
}

function unquoteToml(value: string): string {
  return JSON.parse(value) as string;
}

/** Daintree's own server names; anything else in a carried-forward config is the user's. */
function isDaintreeKey(key: string): boolean {
  return key === "daintree" || key.startsWith("daintree-");
}

/**
 * A record safe to print or attach: which args, env names and files a launch
 * had, never their values — they hold live bearers, and a carried-forward
 * config can hold the user's own credentials.
 */
export function redactLaunch(launch: RecordedLaunch): Record<string, unknown> {
  return {
    agent: launch.agent,
    paneId: launch.paneId,
    // Flags only: a value could be anything the launch was given.
    argv: launch.argv.map((arg) => (arg.startsWith("-") ? arg : "<value>")),
    envKeys: Object.keys(launch.env).sort(),
    files: Object.keys(launch.files),
  };
}

/**
 * The servers a launch handed its agent, read back out of that agent's own
 * dialect — the inverse of each `launchMcp` format. An agent that could not
 * find a server's URL and bearer here could not have connected either. Only
 * Daintree's own entries: the rest of a carried-forward config is the user's.
 */
export function serversFromLaunch(launch: RecordedLaunch): LaunchedServer[] {
  const servers: LaunchedServer[] = [];
  // A config file handed over by flag: `--mcp-config <file>` (Claude, Qwen,
  // Amp) or `--additional-mcp-config @<file>` (Copilot).
  launch.argv.forEach((arg, i) => {
    if (arg !== "--mcp-config" && arg !== "--additional-mcp-config") return;
    const target = launch.argv[i + 1]?.replace(/^@/, "");
    const file = target === undefined ? undefined : launch.files[target];
    if (file === undefined) throw new Error(`${arg} names a file that did not exist`);
    servers.push(...serverMap(JSON.parse(file)));
  });

  const codex = new Map<string, { url?: string; envVar?: string }>();
  launch.argv.forEach((arg, i) => {
    if (launch.argv[i - 1] !== "-c") return;
    const match = /^mcp_servers\.([A-Za-z0-9_-]+)\.(url|bearer_token_env_var)=(.+)$/.exec(arg);
    if (!match) return;
    const entry = codex.get(match[1]) ?? {};
    if (match[2] === "url") entry.url = unquoteToml(match[3]);
    else entry.envVar = unquoteToml(match[3]);
    codex.set(match[1], entry);
  });
  for (const [key, entry] of codex) {
    if (!entry.url || !entry.envVar)
      throw new Error(`codex server ${key} is missing a url or bearer`);
    const bearer = launch.env[entry.envVar];
    if (!bearer) throw new Error(`codex server ${key} reads ${entry.envVar}, which is not set`);
    servers.push({ key, url: entry.url, bearer });
  }

  for (const [name, value] of Object.entries(launch.env)) {
    if (/^GEMINI_CLI_SYSTEM_DEFAULTS_PATH$|^QWEN_CODE_SYSTEM_DEFAULTS_PATH$/.test(name)) {
      const file = launch.files[value];
      if (file === undefined) throw new Error(`${name} names a file that did not exist`);
      servers.push(...serverMap(JSON.parse(file)));
    }
    if (name === "OPENCODE_CONFIG_CONTENT") {
      const parsed = JSON.parse(value) as {
        mcp: Record<string, { url: string; headers: unknown }>;
      };
      for (const [key, entry] of Object.entries(parsed.mcp)) {
        if (!isDaintreeKey(key)) continue;
        servers.push({ key, url: entry.url, bearer: bearerFromHeaders(entry.headers) });
      }
    }
    if (name === "VIBE_MCP_SERVERS") {
      const list = JSON.parse(value) as Array<{
        name: string;
        url: string;
        auth?: { api_key_env?: string };
      }>;
      for (const entry of list) {
        if (!isDaintreeKey(entry.name)) continue;
        const envVar = entry.auth?.api_key_env;
        const bearer = envVar ? launch.env[envVar] : undefined;
        if (!bearer) throw new Error(`vibe server ${entry.name} has no bearer in the env`);
        servers.push({ key: entry.name, url: entry.url, bearer });
      }
    }
  }
  return servers;
}
