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

export interface LoafProbeScript {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  invokerType?: string;
  duration?: number;
  executionStart?: number;
  forcedStyleAndLayoutDuration?: number;
}

export interface LoafProbeEntry {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  forcedStyleAndLayoutDuration?: number;
  scripts: LoafProbeScript[];
}

export interface LoafProbeResult {
  supported: boolean;
  count: number;
  maxDurationMs: number;
  entries: LoafProbeEntry[];
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
        (() => void) | undefined;
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
  page: Page,
  opts: { forceGc?: boolean } = {}
): Promise<{ usedJSHeapSize: number; totalJSHeapSize: number } | null> {
  return page.evaluate(async (forceGc) => {
    if (forceGc) {
      // window.gc is exposed via the renderer `--expose-gc` js-flag
      // (electron/main.ts). Run twice — the first pass frees the bulk, the
      // second collects objects whose finalizers were queued by the first.
      const gcFn = (window as unknown as { gc?: () => void }).gc;
      if (gcFn) {
        gcFn();
        await new Promise((r) => setTimeout(r, 50));
        gcFn();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const perf = performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    };
    if (!perf.memory) return null;
    return {
      usedJSHeapSize: perf.memory.usedJSHeapSize,
      totalJSHeapSize: perf.memory.totalJSHeapSize,
    };
  }, opts.forceGc ?? false);
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

interface WindowsProcessRow {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
}

function getWindowsProcessEntries(): ProcessEntry[] {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }
    ).trim();
    if (!output) return [];

    const parsed = JSON.parse(output) as WindowsProcessRow | WindowsProcessRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        comm: String(row.Name ?? ""),
      }))
      .filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid));
  } catch {
    return [];
  }
}

function collectDescendantsFromEntries(pid: number, entries: ProcessEntry[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ppid);
    if (children) {
      children.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(pid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const child = queue.shift();
    if (child === undefined || seen.has(child)) continue;
    seen.add(child);
    descendants.push(child);
    queue.push(...(childrenByParent.get(child) ?? []));
  }
  return descendants;
}

export function getDescendantPids(pid: number): number[] {
  if (process.platform === "win32") {
    return collectDescendantsFromEntries(pid, getWindowsProcessEntries());
  }
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

// ── Renderer Responsiveness Probe ────────────────────────

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const timestamps: number[] = [];
    let running = true;
    const loop = () => {
      if (!running) return;
      timestamps.push(performance.now());
      // rAF can stop sampling in throttled CI windows; a short timer still
      // catches renderer stalls without requiring visible-frame cadence.
      window.setTimeout(loop, 16);
    };
    window.setTimeout(loop, 16);
    const w = window as unknown as Record<string, unknown>;
    w.__daintreeFrameProbe = { timestamps, stop: () => (running = false) };
  });

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const sampleCount = await page
      .evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w.__daintreeFrameProbe as { timestamps: number[] } | undefined;
        return probe?.timestamps.length ?? 0;
      })
      .catch(() => 0);
    if (sampleCount > 0) return;
    await page.waitForTimeout(50);
  }
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

export async function startLoafProbe(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    if (!("PerformanceObserver" in window)) {
      w.__daintreeLoafProbe = { supported: false, entries: [], stop: () => {} };
      return false;
    }
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    if (!supported.includes("long-animation-frame")) {
      w.__daintreeLoafProbe = { supported: false, entries: [], stop: () => {} };
      return false;
    }

    const entries: Array<Record<string, unknown>> = [];
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceEntry & {
          blockingDuration?: number;
          forcedStyleAndLayoutDuration?: number;
          scripts?: Array<Record<string, unknown>>;
        };
        entries.push({
          startTime: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          forcedStyleAndLayoutDuration: entry.forcedStyleAndLayoutDuration,
          scripts: (entry.scripts ?? []).map((script) => ({
            sourceURL: script.sourceURL,
            sourceFunctionName: script.sourceFunctionName,
            invoker: script.invoker,
            invokerType: script.invokerType,
            duration: script.duration,
            executionStart: script.executionStart,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          })),
        });
      }
    });
    observer.observe({ type: "long-animation-frame" } as PerformanceObserverInit);
    w.__daintreeLoafProbe = {
      supported: true,
      entries,
      stop: () => observer.disconnect(),
    };
    return true;
  });
}

export async function stopLoafProbe(page: Page): Promise<LoafProbeResult> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const probe = w.__daintreeLoafProbe as
      { supported: boolean; entries: LoafProbeEntry[]; stop: () => void } | undefined;
    if (!probe) {
      return { supported: false, count: 0, maxDurationMs: 0, entries: [] };
    }

    probe.stop();
    delete w.__daintreeLoafProbe;

    const entries = probe.entries;
    const maxDurationMs = entries.reduce((max, entry) => Math.max(max, entry.duration), 0);
    return {
      supported: probe.supported,
      count: entries.length,
      maxDurationMs,
      entries,
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
