import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { execFileSync, execSync } from "child_process";
import { runTerminalCommand, waitForTerminalText } from "./terminal";

// ── Types ────────────────────────────────────────────────

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  comm: string;
}

export interface ProcessIdentity {
  comm: string;
  startTime: string;
}

export interface FrameProbeResult {
  sampleCount: number;
  maxGapMs: number;
  avgGapMs: number;
  p95GapMs: number;
}

export interface TerminalStats {
  terminalCount: number;
  withPty: number;
  terminals: Array<{ id: string; hasPty: boolean }>;
}

// Type for the Electron API available in page.evaluate contexts
interface ElectronTerminalAPI {
  getInfo(id: string): Promise<{ ptyPid?: number; hasPty?: boolean }>;
}

interface WindowWithElectron {
  electron: { terminal: ElectronTerminalAPI };
}

// ── Panel ID Resolution ──────────────────────────────────

async function getPanelId(panelLocator: Locator): Promise<string> {
  const panelId = await panelLocator.evaluate((el) => {
    const panel = el.closest("[data-panel-id]");
    return panel?.getAttribute("data-panel-id") ?? "";
  });
  if (!panelId) throw new Error("Could not resolve panel ID from locator");
  return panelId;
}

// ── PTY PID Extraction ───────────────────────────────────

export async function getPtyPid(page: Page, panelLocator: Locator): Promise<number> {
  const panelId = await getPanelId(panelLocator);
  const info = await page.evaluate(
    (id) => (window as unknown as WindowWithElectron).electron.terminal.getInfo(id),
    panelId
  );
  if (!info?.ptyPid) {
    throw new Error(`No ptyPid found for panel ${panelId}`);
  }
  return info.ptyPid;
}

// ── Memory Measurement ───────────────────────────────────

export async function measureMainMemory(
  app: ElectronApplication,
  opts: { forceGc?: boolean } = {}
): Promise<MemorySnapshot> {
  return app.evaluate(async (_, forceGc) => {
    if (forceGc) {
      const g = globalThis as unknown as Record<string, unknown>;
      const gcFn = (typeof g.__daintree_gc === "function" ? g.__daintree_gc : g.gc) as
        | (() => void)
        | undefined;
      if (gcFn) {
        gcFn();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const m = process.memoryUsage();
    return {
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    };
  }, opts.forceGc ?? false);
}

export async function measureRendererMemory(
  page: Page
): Promise<{ usedJSHeapSize: number; totalJSHeapSize: number } | null> {
  return page.evaluate(() => {
    const perf = performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    };
    if (!perf.memory) return null;
    return {
      usedJSHeapSize: perf.memory.usedJSHeapSize,
      totalJSHeapSize: perf.memory.totalJSHeapSize,
    };
  });
}

// ── OS-Level Process Verification ────────────────────────

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

export function getProcessInfo(pid: number): ProcessIdentity | null {
  if (process.platform === "win32") return null;
  try {
    const result = execFileSync("ps", ["-p", String(pid), "-o", "comm=,lstart="], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!result) return null;
    // comm is the first token, lstart is everything after
    const firstSpace = result.indexOf(" ");
    if (firstSpace === -1) return { comm: result, startTime: "" };
    return {
      comm: result.slice(0, firstSpace),
      startTime: result.slice(firstSpace + 1).trim(),
    };
  } catch {
    return null;
  }
}

export function verifyProcessIdentity(pid: number, baseline: ProcessIdentity): boolean {
  const current = getProcessInfo(pid);
  if (!current) return false;
  return current.comm === baseline.comm && current.startTime === baseline.startTime;
}

export function getProcessStartTime(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const result = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

export async function waitForProcessDeath(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getProcessInfo(pid) === null) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Process ${pid} still alive after ${timeoutMs}ms`);
}

export function getDescendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const result = execSync(`pgrep -P ${pid}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const children = result
      .trim()
      .split("\n")
      .map(Number)
      .filter((n) => n > 0);
    const all = [...children];
    for (const child of children) {
      all.push(...getDescendantPids(child));
    }
    return all;
  } catch {
    return [];
  }
}

// ── Process Snapshot & Diff ──────────────────────────────

export function snapshotProcesses(filterFn?: (entry: ProcessEntry) => boolean): ProcessEntry[] {
  if (process.platform === "win32") return [];
  try {
    const output = execSync("ps -eo pid,ppid,comm", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = output.trim().split("\n").slice(1); // skip header
    const entries: ProcessEntry[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const entry: ProcessEntry = {
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        comm: parts.slice(2).join(" "),
      };
      if (Number.isNaN(entry.pid) || Number.isNaN(entry.ppid)) continue;
      if (filterFn && !filterFn(entry)) continue;
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

export function diffProcessSnapshots(
  before: ProcessEntry[],
  after: ProcessEntry[]
): { added: ProcessEntry[]; removed: ProcessEntry[] } {
  const beforePids = new Set(before.map((e) => e.pid));
  const afterPids = new Set(after.map((e) => e.pid));
  return {
    added: after.filter((e) => !beforePids.has(e.pid)),
    removed: before.filter((e) => !afterPids.has(e.pid)),
  };
}

// ── Terminal Flood ───────────────────────────────────────

export async function floodTerminal(
  page: Page,
  panelLocator: Locator,
  opts: { lines?: number; sentinel?: string } = {}
): Promise<void> {
  const lines = opts.lines ?? 2000;
  const sentinel = opts.sentinel ?? `__FLOOD_DONE_${Date.now()}__`;
  const cmd = `node -e "for(let i=0;i<${lines};i++) console.log('L'+i); console.log('${sentinel}')"`;
  await runTerminalCommand(page, panelLocator, cmd);
  await waitForTerminalText(panelLocator, sentinel, 60_000);
}

// ── Frame-Time Responsiveness Probe ──────────────────────

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const timestamps: number[] = [];
    let running = true;
    const loop = () => {
      if (!running) return;
      timestamps.push(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const w = window as unknown as Record<string, unknown>;
    w.__daintreeFrameProbe = { timestamps, stop: () => (running = false) };
  });
}

export async function stopFrameProbe(page: Page): Promise<FrameProbeResult> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const probe = w.__daintreeFrameProbe as { timestamps: number[]; stop: () => void } | undefined;
    if (!probe) return { sampleCount: 0, maxGapMs: 0, avgGapMs: 0, p95GapMs: 0 };

    probe.stop();
    const ts = probe.timestamps;
    delete w.__daintreeFrameProbe;

    if (ts.length < 2) return { sampleCount: ts.length, maxGapMs: 0, avgGapMs: 0, p95GapMs: 0 };

    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) {
      gaps.push(ts[i] - ts[i - 1]);
    }
    gaps.sort((a, b) => a - b);

    const sum = gaps.reduce((a, b) => a + b, 0);
    const p95Index = Math.floor(gaps.length * 0.95);

    return {
      sampleCount: ts.length,
      maxGapMs: gaps[gaps.length - 1],
      avgGapMs: sum / gaps.length,
      p95GapMs: gaps[p95Index],
    };
  });
}

// ── Terminal Stats (Best-Effort Pool Proxy) ──────────────

export async function getTerminalStats(page: Page): Promise<TerminalStats> {
  return page.evaluate(async () => {
    const w = window as unknown as WindowWithElectron;
    const api = w.electron?.terminal;
    if (!api?.getInfo) {
      return { terminalCount: 0, withPty: 0, terminals: [] };
    }

    const panelEls = document.querySelectorAll("[data-panel-id]");
    const terminals: Array<{ id: string; hasPty: boolean }> = [];

    for (const el of panelEls) {
      const id = el.getAttribute("data-panel-id");
      if (!id) continue;
      try {
        const info = await api.getInfo(id);
        if (info) {
          terminals.push({ id, hasPty: info.hasPty ?? false });
        }
      } catch {
        // Panel may not be a terminal
      }
    }

    return {
      terminalCount: terminals.length,
      withPty: terminals.filter((t) => t.hasPty).length,
      terminals,
    };
  });
}
