import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { BrowserWindow, Event as ElectronEvent, WebContents } from "electron";
import type { ProjectState, TerminalSnapshot } from "../types/index.js";
import type { PtyClient } from "./PtyClient.js";
import { projectStore } from "./ProjectStore.js";
import { getAppWebContents } from "../window/webContentsRegistry.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const execFileAsync = promisify(execFile);

export const SMOKE_BOOT_TIMEOUT_MS = 90_000;
const IS_WIN32 = process.platform === "win32";
const IS_DARWIN_X64 = process.platform === "darwin" && process.arch === "x64";
// The macOS release workflow runs the x64 package under Rosetta on arm64
// runners. Its renderer can cold-start as slowly as the Windows smoke path.
const USE_SLOW_SMOKE_TIMEOUTS = IS_WIN32 || IS_DARWIN_X64;
const SMOKE_RENDERER_LOAD_TIMEOUT_MS = USE_SLOW_SMOKE_TIMEOUTS ? 120_000 : 45_000;
const SMOKE_RENDERER_TIMEOUT_MS = USE_SLOW_SMOKE_TIMEOUTS ? 90_000 : 20_000;
const SMOKE_RENDERER_MOUNT_POLL_MS = USE_SLOW_SMOKE_TIMEOUTS ? 60_000 : 15_000;
const SMOKE_TERMINAL_TIMEOUT_MS = USE_SLOW_SMOKE_TIMEOUTS ? 30_000 : 20_000;
const SMOKE_PROJECT_TIMEOUT_MS = USE_SLOW_SMOKE_TIMEOUTS ? 75_000 : 45_000;
const SMOKE_GIT_TIMEOUT_MS = USE_SLOW_SMOKE_TIMEOUTS ? 30_000 : 15_000;
const SMOKE_STABILITY_SOAK_MS = USE_SLOW_SMOKE_TIMEOUTS ? 20_000 : 12_000;
const SMOKE_STABILITY_SOAK_STEP_MS = 2_000;
const SMOKE_STABILITY_PROBE_TIMEOUT_MS = 5_000;
const SMOKE_STABILITY_MAX_CONSECUTIVE_PROBE_TIMEOUTS = 2;
const SMOKE_TERMINAL_ROUNDS = USE_SLOW_SMOKE_TIMEOUTS ? 3 : 2;
const SMOKE_PERSISTENCE_ITERATIONS = USE_SLOW_SMOKE_TIMEOUTS ? 48 : 24;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runGitSmokeCommand(args: string[], cwd: string): Promise<void> {
  try {
    await withTimeout(
      execFileAsync("git", args, { cwd }),
      SMOKE_GIT_TIMEOUT_MS,
      `[SMOKE] git ${args.join(" ")} timed out`
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    if (code === "ENOENT") {
      throw new Error("git executable not found on PATH");
    }
    throw error;
  }
}

interface SmokeRendererCheckResult {
  readyState: string;
  hasRoot: boolean;
  rootChildCount: number;
  hasElectronApi: boolean;
  appVersionType: string;
  homeDirType: string;
  tmpDirType: string;
  projectCount: number;
}

async function waitForSmokeRendererLoad(appWc: WebContents): Promise<void> {
  if (!appWc.isLoading()) return;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        appWc.removeListener("did-finish-load", onFinish);
        appWc.removeListener("did-fail-load", onFail);
        appWc.removeListener("destroyed", onDestroyed);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const onFail = (
        _event: ElectronEvent,
        errorCode: number,
        errorDescription: string,
        validatedURL: string
      ) => {
        cleanup();
        reject(
          new Error(
            `renderer did-fail-load (${errorCode}): ${errorDescription || "unknown"}${
              validatedURL ? ` (${validatedURL})` : ""
            }`
          )
        );
      };
      const onDestroyed = () => {
        cleanup();
        reject(new Error("renderer webContents was destroyed before did-finish-load"));
      };

      appWc.once("did-finish-load", onFinish);
      appWc.once("did-fail-load", onFail);
      appWc.once("destroyed", onDestroyed);

      if (!appWc.isLoading()) {
        onFinish();
      }
    }),
    SMOKE_RENDERER_LOAD_TIMEOUT_MS,
    "[SMOKE] Renderer did-finish-load timed out"
  );
}

async function runSmokeRendererChecks(window: BrowserWindow): Promise<void> {
  const appWc = getAppWebContents(window);
  await waitForSmokeRendererLoad(appWc);
  const script = `(async () => {
    const root = document.getElementById("root");
    const hasRoot = Boolean(root);

    // React bootstrap is async (font loading + dynamic import), so poll until mounted
    let rootChildCount = root ? root.childElementCount : 0;
    if (hasRoot && rootChildCount === 0) {
      const deadline = Date.now() + ${SMOKE_RENDERER_MOUNT_POLL_MS};
      while (rootChildCount === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
        rootChildCount = root.childElementCount;
      }
    }

    const hasElectronApi = typeof window.electron === "object" && window.electron !== null;
    const appVersion = hasElectronApi ? await window.electron.app.getVersion() : null;
    const homeDir = hasElectronApi ? await window.electron.system.getHomeDir() : null;
    const tmpDir = hasElectronApi ? await window.electron.system.getTmpDir() : null;
    const projects = hasElectronApi ? await window.electron.project.getAll() : null;

    return {
      readyState: document.readyState,
      hasRoot,
      rootChildCount,
      hasElectronApi,
      appVersionType: typeof appVersion,
      homeDirType: typeof homeDir,
      tmpDirType: typeof tmpDir,
      projectCount: Array.isArray(projects) ? projects.length : -1,
    };
  })()`;

  const result = (await withTimeout(
    appWc.executeJavaScript(script, true) as Promise<unknown>,
    SMOKE_RENDERER_TIMEOUT_MS,
    "[SMOKE] Renderer + IPC checks timed out"
  )) as SmokeRendererCheckResult;

  if (!result.hasRoot) {
    throw new Error("renderer root element not found");
  }
  if (result.rootChildCount < 1) {
    throw new Error("renderer root exists but has no rendered child elements");
  }
  if (!result.hasElectronApi) {
    throw new Error("preload API missing (window.electron not available)");
  }
  if (result.appVersionType !== "string") {
    throw new Error(`app.getVersion returned ${result.appVersionType}`);
  }
  if (result.homeDirType !== "string" || result.tmpDirType !== "string") {
    throw new Error("system IPC calls did not return string paths");
  }
  if (result.projectCount < 0) {
    throw new Error("project.getAll returned an invalid result");
  }
}

async function runSmokeTerminalRoundTrip(
  smokeClient: PtyClient,
  terminalId: string,
  command: string,
  token: string,
  cwd: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let sawToken = false;
    let killRequested = false;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`terminal roundtrip timed out for ${terminalId}`));
    }, SMOKE_TERMINAL_TIMEOUT_MS);
    timeout.unref();

    const writeTimer = setTimeout(() => {
      smokeClient.write(terminalId, command);
    }, 600);
    writeTimer.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(writeTimer);
      smokeClient.removeListener("data", onData);
      smokeClient.removeListener("exit", onExit);
      smokeClient.removeListener("error", onError);
    };

    const onData = (id: string, data: string) => {
      if (id !== terminalId) return;
      if (!sawToken && data.includes(token)) {
        sawToken = true;
      }
      if (sawToken && !killRequested) {
        killRequested = true;
        smokeClient.kill(terminalId, "smoke-roundtrip-complete");
      }
    };

    const onExit = (id: string) => {
      if (id !== terminalId) return;
      cleanup();
      if (!sawToken) {
        reject(new Error(`terminal exited before emitting token (${terminalId})`));
        return;
      }
      resolve();
    };

    const onError = (id: string, error: string) => {
      if (id !== terminalId) return;
      cleanup();
      reject(new Error(`terminal error (${terminalId}): ${error}`));
    };

    smokeClient.on("data", onData);
    smokeClient.on("exit", onExit);
    smokeClient.on("error", onError);

    try {
      smokeClient.spawn(terminalId, {
        cwd,
        cols: 80,
        rows: 24,
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
  });
}

async function runSmokeTerminalChecks(smokeClient: PtyClient): Promise<void> {
  const cwd = os.homedir();

  for (let i = 0; i < SMOKE_TERMINAL_ROUNDS; i++) {
    const token = `DAINTREE_SMOKE_TERM_${i}_${Date.now()}`;
    const command =
      process.platform === "win32" ? `echo ${token} && cd\r\n` : `echo ${token} && pwd\n`;
    const terminalId = `smoke-test-terminal-${i}`;
    await runSmokeTerminalRoundTrip(smokeClient, terminalId, command, token, cwd);
    console.error("[SMOKE] CHECK: Terminal roundtrip %d — OK", i + 1);
  }
}

function buildSmokeTerminalSnapshot(id: string, cwd: string, title: string): TerminalSnapshot {
  return {
    id,
    kind: "terminal",
    title,
    cwd,
    location: "grid",
    command: `echo ${title}`,
  };
}

async function runSmokeProjectPersistenceChecks(window: BrowserWindow): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "daintree-smoke-project-"));
  const repoPath = path.join(tempRoot, "repo");

  let createdProjectId: string | null = null;

  try {
    await mkdir(repoPath, { recursive: true });
    await writeFile(path.join(repoPath, "README.md"), "# Smoke Project\n", "utf8");
    await runGitSmokeCommand(["init"], repoPath);

    const project = await projectStore.addProject(repoPath);
    createdProjectId = project.id;

    const rendererSnapshot = buildSmokeTerminalSnapshot(
      "smoke-renderer-terminal",
      repoPath,
      "Smoke Renderer Terminal"
    );
    const projectIdJson = JSON.stringify(project.id);
    const terminalsJson = JSON.stringify([rendererSnapshot]);

    const appWc = getAppWebContents(window);
    const rendererResult = (await withTimeout(
      appWc.executeJavaScript(
        `(async () => {
          const projectId = ${projectIdJson};
          const terminals = ${terminalsJson};
          await window.electron.project.setTerminals(projectId, terminals);
          const saved = await window.electron.project.getTerminals(projectId);
          return {
            count: Array.isArray(saved) ? saved.length : -1,
            firstId: Array.isArray(saved) && saved[0] ? saved[0].id : null,
          };
        })()`,
        true
      ) as Promise<unknown>,
      SMOKE_PROJECT_TIMEOUT_MS,
      "[SMOKE] Renderer project persistence check timed out"
    )) as { count: number; firstId: string | null };

    if (rendererResult.count < 1 || rendererResult.firstId !== rendererSnapshot.id) {
      throw new Error("renderer set/get terminals roundtrip returned unexpected data");
    }

    for (let i = 0; i < SMOKE_PERSISTENCE_ITERATIONS; i++) {
      const snapshot = buildSmokeTerminalSnapshot(
        `smoke-main-terminal-${i}`,
        repoPath,
        `Smoke Main Terminal ${i}`
      );
      const state: ProjectState = {
        projectId: project.id,
        sidebarWidth: 320 + (i % 20),
        terminals: [snapshot],
        tabGroups: [],
      };

      await projectStore.saveProjectState(project.id, state);

      if ((i + 1) % 12 === 0) {
        await Promise.all(
          [0, 1, 2].map(async (burst) => {
            const burstSnapshot = buildSmokeTerminalSnapshot(
              `smoke-burst-${i}-${burst}`,
              repoPath,
              `Smoke Burst ${i}-${burst}`
            );
            await projectStore.saveProjectState(project.id, {
              ...state,
              terminals: [burstSnapshot],
              sidebarWidth: 280 + ((i + burst) % 30),
            });
          })
        );
      }
    }

    const finalState = await projectStore.getProjectState(project.id);
    if (!finalState || finalState.projectId !== project.id) {
      throw new Error("project state could not be read after persistence stress");
    }
    if (!Array.isArray(finalState.terminals) || finalState.terminals.length === 0) {
      throw new Error("terminal snapshots were not persisted");
    }
  } finally {
    if (createdProjectId) {
      try {
        await projectStore.removeProject(createdProjectId);
      } catch (error) {
        console.error("[SMOKE] Failed to remove smoke project during cleanup:", error);
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function logSmokeFailure(context: string, error: unknown): void {
  console.error(`[SMOKE] FAILED — ${context}:`, formatErrorMessage(error, "Smoke test failed"));
}

interface SmokeStabilitySoakOptions {
  durationMs?: number;
  stepMs?: number;
  probeTimeoutMs?: number;
  maxConsecutiveProbeTimeouts?: number;
}

function isSmokeReadinessTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "[SMOKE] Renderer readiness probe timed out during soak"
  );
}

export async function runSmokeStabilitySoak(
  mainWindow: BrowserWindow,
  isRendererUnresponsive: () => boolean,
  options: SmokeStabilitySoakOptions = {}
): Promise<void> {
  const durationMs = options.durationMs ?? SMOKE_STABILITY_SOAK_MS;
  const stepMs = options.stepMs ?? SMOKE_STABILITY_SOAK_STEP_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? SMOKE_STABILITY_PROBE_TIMEOUT_MS;
  const maxConsecutiveProbeTimeouts =
    options.maxConsecutiveProbeTimeouts ?? SMOKE_STABILITY_MAX_CONSECUTIVE_PROBE_TIMEOUTS;
  const soakSteps = Math.max(1, Math.ceil(durationMs / stepMs));
  let consecutiveProbeTimeouts = 0;

  for (let i = 0; i < soakSteps; i++) {
    await delay(stepMs);
    if (isRendererUnresponsive()) {
      throw new Error("renderer became unresponsive");
    }

    let readyState: unknown;
    try {
      readyState = await withTimeout(
        getAppWebContents(mainWindow).executeJavaScript(
          "document.readyState",
          true
        ) as Promise<unknown>,
        probeTimeoutMs,
        "[SMOKE] Renderer readiness probe timed out during soak"
      );
      consecutiveProbeTimeouts = 0;
    } catch (error) {
      if (!isSmokeReadinessTimeout(error)) {
        throw error;
      }

      consecutiveProbeTimeouts += 1;
      if (consecutiveProbeTimeouts > maxConsecutiveProbeTimeouts) {
        throw error;
      }

      console.error(
        "[SMOKE] WARN: Renderer readiness probe timed out during soak (%d/%d)",
        consecutiveProbeTimeouts,
        maxConsecutiveProbeTimeouts
      );
      continue;
    }

    if (readyState !== "complete" && readyState !== "interactive") {
      throw new Error(`unexpected document.readyState: ${String(readyState)}`);
    }
  }
}

export async function runSmokeFunctionalChecks(
  mainWindow: BrowserWindow,
  smokeClient: PtyClient,
  isRendererUnresponsive: () => boolean
): Promise<boolean> {
  let allPassed = true;

  try {
    await runSmokeRendererChecks(mainWindow);
    console.error("[SMOKE] CHECK: Renderer + IPC bridge — OK");
  } catch (error) {
    allPassed = false;
    logSmokeFailure("renderer + IPC bridge", error);
  }

  if (allPassed) {
    try {
      console.error("[SMOKE] Running terminal stress checks (%d rounds)...", SMOKE_TERMINAL_ROUNDS);
      await runSmokeTerminalChecks(smokeClient);
      console.error("[SMOKE] CHECK: Terminal stress rounds — OK");
    } catch (error) {
      allPassed = false;
      logSmokeFailure("terminal stress rounds", error);
    }
  }

  if (allPassed) {
    try {
      console.error(
        "[SMOKE] Running project persistence stress (%d iterations)...",
        SMOKE_PERSISTENCE_ITERATIONS
      );
      await withTimeout(
        runSmokeProjectPersistenceChecks(mainWindow),
        SMOKE_PROJECT_TIMEOUT_MS * 2,
        "[SMOKE] Project persistence stress timed out"
      );
      console.error("[SMOKE] CHECK: Project persistence stress — OK");
    } catch (error) {
      allPassed = false;
      logSmokeFailure("project persistence stress", error);
    }
  }

  if (allPassed && isRendererUnresponsive()) {
    allPassed = false;
    logSmokeFailure("renderer responsiveness", "renderer became unresponsive during checks");
  }

  if (allPassed) {
    console.error(
      "[SMOKE] All checks passed — holding for %ds stability soak...",
      SMOKE_STABILITY_SOAK_MS / 1000
    );
    try {
      await runSmokeStabilitySoak(mainWindow, isRendererUnresponsive);
      console.error("[SMOKE] Stability soak complete — no crashes detected");
    } catch (error) {
      allPassed = false;
      logSmokeFailure("stability soak", error);
    }
  }

  if (!allPassed) {
    console.error("[SMOKE] FAILED — functional checks did not pass");
  }

  return allPassed;
}
