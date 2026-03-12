import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { app, screen } from "electron";
import { sanitizePath } from "./TelemetryService.js";
import { logBuffer } from "./LogBuffer.js";
import { getPtyManager } from "./PtyManager.js";
import { store } from "../store.js";
import type { HandlerDependencies } from "../ipc/types.js";

const execFileAsync = promisify(execFile);

const SECTION_TIMEOUT_MS = 5_000;
const GPU_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const SENSITIVE_KEY_PATTERN =
  /token|password|secret|apiKey|api_key|credential|authorization|private_key|passphrase/i;

function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let result = sanitizePath(value);
    result = result.replace(/https?:\/\/[^@\s]+@/g, "https://<redacted>@");
    return result;
  }

  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = redactDeep(val);
      }
    }
    return result;
  }

  return value;
}

async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = SECTION_TIMEOUT_MS
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: process.env,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function collectMetadata() {
  return {
    timestamp: new Date().toISOString(),
    collectorVersion: 1,
    appVersion: app.getVersion(),
    appName: app.getName(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
  };
}

async function collectRuntime() {
  return {
    platform: process.platform,
    arch: process.arch,
    execPath: sanitizePath(app.getPath("exe")),
    appPath: sanitizePath(app.getAppPath()),
    userData: sanitizePath(app.getPath("userData")),
    logs: sanitizePath(app.getPath("logs")),
    temp: sanitizePath(app.getPath("temp")),
    pid: process.pid,
    uptime: process.uptime(),
    argv: process.argv.map(sanitizePath),
    env: {
      NODE_ENV: process.env.NODE_ENV ?? null,
      CANOPY_DEBUG: process.env.CANOPY_DEBUG ?? null,
      SHELL: process.env.SHELL ?? null,
      TERM: process.env.TERM ?? null,
      PATH: process.env.PATH ? sanitizePath(process.env.PATH) : null,
      HOME: process.env.HOME ? sanitizePath(process.env.HOME) : null,
      LANG: process.env.LANG ?? null,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ? true : false,
    },
  };
}

async function collectOs() {
  return {
    type: os.type(),
    platform: os.platform(),
    release: os.release(),
    version: os.version(),
    arch: os.arch(),
    hostname: "<hostname>",
    cpus: os.cpus().map((cpu) => ({
      model: cpu.model,
      speed: cpu.speed,
    })),
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadavg: os.loadavg(),
  };
}

async function collectDisplay() {
  try {
    const displays = screen.getAllDisplays();
    return displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
      internal: d.internal,
    }));
  } catch {
    return { error: "Failed to get display info" };
  }
}

async function collectGpu() {
  return withTimeout(app.getGPUInfo("basic") as Promise<unknown>, GPU_TIMEOUT_MS, {
    error: "GPU info timed out",
  });
}

async function collectProcess() {
  const result: Record<string, unknown> = {};

  try {
    result.memoryUsage = process.memoryUsage();
  } catch {
    result.memoryUsage = { error: "Failed to get memory usage" };
  }

  try {
    result.cpuUsage = process.cpuUsage();
  } catch {
    result.cpuUsage = { error: "Failed to get CPU usage" };
  }

  try {
    result.appMetrics = app.getAppMetrics();
  } catch {
    result.appMetrics = { error: "Failed to get app metrics" };
  }

  try {
    const report = process.report?.getReport?.();
    if (report && typeof report === "object") {
      const r = report as Record<string, unknown>;
      result.nodeReport = {
        header: r.header,
        resourceUsage: r.resourceUsage,
        libuv: r.libuv,
        environmentVariables: "<redacted>",
      };
    }
  } catch {
    result.nodeReport = { error: "Failed to get process report" };
  }

  return result;
}

async function collectTools() {
  const tools = ["git", "node", "npm", "npx", "gh"];
  const checkCmd = process.platform === "win32" ? "where" : "which";

  const results = await Promise.allSettled(
    tools.map(async (tool) => {
      const path = await runCommand(checkCmd, [tool], 3000);
      if (!path) return { tool, available: false, path: null, version: null };

      const version = await runCommand(tool, ["--version"], 3000);
      return {
        tool,
        available: true,
        path: path ? sanitizePath(path) : null,
        version: version
          ? tool === "git"
            ? version.replace(/^git version\s+/, "")
            : version.replace(/^v/, "")
          : null,
      };
    })
  );

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { tool: "unknown", available: false, error: String(r.reason) }
  );
}

async function collectGit() {
  const result: Record<string, unknown> = {};

  const configOutput = await runCommand("git", ["config", "--list", "--show-origin"]);
  if (configOutput) {
    const lines = configOutput.split("\n").filter(Boolean);
    const safeConfig: string[] = [];
    for (const line of lines) {
      if (SENSITIVE_KEY_PATTERN.test(line)) {
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
          safeConfig.push(line.slice(0, eqIdx + 1) + "<redacted>");
        } else {
          safeConfig.push("<redacted>");
        }
      } else {
        safeConfig.push(sanitizePath(line));
      }
    }
    result.config = safeConfig;
  } else {
    result.config = { error: "Failed to get git config" };
  }

  const remoteOutput = await runCommand("git", ["remote", "-v"]);
  if (remoteOutput) {
    result.remotes = remoteOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return sanitizePath(line.replace(/https?:\/\/[^@\s]+@/g, "https://<redacted>@"));
      });
  }

  const versionOutput = await runCommand("git", ["--version"]);
  result.version = versionOutput;

  return result;
}

const SAFE_STORE_KEYS = [
  "developerMode",
  "hibernation",
  "terminalConfig",
  "keybindingOverrides",
  "worktreeConfig",
  "notificationSettings",
  "windowState",
  "onboarding",
  "voiceInput",
  "appTheme",
  "crashRecovery",
] as const;

async function collectStoreConfig() {
  try {
    const result: Record<string, unknown> = {};
    for (const key of SAFE_STORE_KEYS) {
      try {
        result[key] = store.get(key);
      } catch {
        result[key] = { error: `Failed to read ${key}` };
      }
    }
    return redactDeep(result);
  } catch {
    return { error: "Failed to read store config" };
  }
}

async function collectTerminals() {
  try {
    const ptyManager = getPtyManager();
    const terminals = ptyManager.getAll();
    return terminals.map((t) => ({
      id: t.id,
      worktreeId: t.worktreeId,
      kind: t.kind,
      agentState: t.agentState,
      cwd: t.cwd ? sanitizePath(t.cwd) : null,
      isExited: t.isExited,
    }));
  } catch {
    return { error: "Failed to get terminal info" };
  }
}

async function collectLogs() {
  try {
    const entries = logBuffer.getAll();
    const recent = entries.slice(-100);
    return {
      totalEntries: entries.length,
      recentEntries: recent.map((e) => ({
        ...e,
        message: sanitizePath(e.message),
        context: e.context ? redactDeep(e.context) : undefined,
      })),
    };
  } catch {
    return { error: "Failed to get logs" };
  }
}

async function collectEvents(deps: HandlerDependencies) {
  try {
    if (!deps.eventBuffer) {
      return { error: "Event buffer not available" };
    }
    const events = deps.eventBuffer.getAll();
    const recent = events.slice(-100);
    return {
      totalEvents: events.length,
      recentEvents: recent.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        category: e.category,
        source: e.source,
      })),
    };
  } catch {
    return { error: "Failed to get events" };
  }
}

export async function collectDiagnostics(deps: HandlerDependencies): Promise<unknown> {
  const sections = [
    { key: "metadata", fn: collectMetadata },
    { key: "runtime", fn: collectRuntime },
    { key: "os", fn: collectOs },
    { key: "display", fn: collectDisplay },
    { key: "gpu", fn: collectGpu },
    { key: "process", fn: collectProcess },
    { key: "tools", fn: collectTools },
    { key: "git", fn: collectGit },
    { key: "config", fn: collectStoreConfig },
    { key: "terminals", fn: collectTerminals },
    { key: "logs", fn: collectLogs },
    { key: "events", fn: () => collectEvents(deps) },
  ];

  const results = await Promise.allSettled(
    sections.map(async (section) => ({
      key: section.key,
      value: await withTimeout(
        section.fn(),
        section.key === "gpu" ? GPU_TIMEOUT_MS : SECTION_TIMEOUT_MS,
        { error: "timed out" }
      ),
    }))
  );

  const payload: Record<string, unknown> = {};
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const key = sections[i].key;
    if (result.status === "fulfilled") {
      payload[result.value.key] = result.value.value;
    } else {
      payload[key] = { error: String(result.reason) };
    }
  }

  return redactDeep(payload);
}
