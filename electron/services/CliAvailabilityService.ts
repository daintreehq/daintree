import { execFile, execFileSync } from "child_process";
import { access, constants } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type {
  CliAvailability,
  AgentAvailabilityState,
  AgentCliDetail,
  AgentCliDetails,
  AgentCliProbeSource,
} from "../../shared/types/ipc.js";
import {
  getEffectiveRegistry,
  type AgentConfig,
  type AgentAuthCheck,
} from "../../shared/config/agentRegistry.js";
import { refreshPath, expandWindowsEnvVars } from "../setup/environment.js";

interface ProbeSuccess {
  status: "found";
  path: string;
  via: AgentCliProbeSource;
  wslDistro?: string;
}

interface ProbeMissing {
  status: "missing";
}

interface ProbeBlocked {
  status: "blocked";
  reason: "security" | "permissions";
  /** Optional path that was found but could not be executed (e.g. which succeeded, then spawn EPERM). */
  path?: string;
  /** Which layer produced the block verdict. */
  via?: AgentCliProbeSource;
  message: string;
}

type ProbeResult = ProbeSuccess | ProbeMissing | ProbeBlocked;

interface AgentCheckOutcome {
  state: AgentAvailabilityState;
  detail: AgentCliDetail;
}

const SECURITY_ERROR_CODES = new Set(["EACCES", "EPERM"]);

export class CliAvailabilityService {
  private static readonly CHECK_TIMEOUT_MS = 10_000;
  private static readonly AUTH_CHECK_TIMEOUT_MS = 3_000;
  private static readonly WHICH_TIMEOUT_MS = 5_000;
  private static readonly NPX_TIMEOUT_MS = 4_000;
  private static readonly WSL_LIST_TIMEOUT_MS = 5_000;
  private static readonly WSL_PROBE_TIMEOUT_MS = 8_000;
  private static readonly VALID_COMMAND_RE = /^[a-zA-Z0-9._-]+$/;

  private availability: CliAvailability | null = null;
  private details: AgentCliDetails | null = null;
  private inFlightCheck: Promise<CliAvailability> | null = null;
  private checkId = 0;

  async checkAvailability(): Promise<CliAvailability> {
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    const currentCheckId = this.checkId;

    this.inFlightCheck = (async () => {
      try {
        if (this.availability === null) {
          await refreshPath();
        }

        const entries = Object.entries(getEffectiveRegistry());

        const checksPromise = Promise.allSettled(
          entries.map(async ([id, config]) => {
            const outcome = await this.checkAgent(config);
            return [id, outcome] as [string, AgentCheckOutcome];
          })
        );

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("CLI availability check timed out")),
            CliAvailabilityService.CHECK_TIMEOUT_MS
          );
        });

        let outcomeEntries: [string, AgentCheckOutcome][];
        try {
          const results = await Promise.race([checksPromise, timeoutPromise]);
          outcomeEntries = results.map((result, index) => {
            if (result.status === "fulfilled") {
              return result.value;
            } else {
              console.warn(
                `[CliAvailabilityService] Check failed for ${entries[index][0]}:`,
                result.reason
              );
              return [
                entries[index][0],
                {
                  state: "missing" as AgentAvailabilityState,
                  detail: {
                    state: "missing" as AgentAvailabilityState,
                    resolvedPath: null,
                    via: null,
                  },
                },
              ];
            }
          });
        } catch (error) {
          console.warn("[CliAvailabilityService]", error instanceof Error ? error.message : error);
          outcomeEntries = entries.map(([id]) => [
            id,
            {
              state: "missing" as AgentAvailabilityState,
              detail: {
                state: "missing" as AgentAvailabilityState,
                resolvedPath: null,
                via: null,
              },
            },
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        const availability: CliAvailability = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.state])
        );
        const details: AgentCliDetails = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.detail])
        );

        if (this.checkId === currentCheckId) {
          this.availability = availability;
          this.details = details;
        }

        return availability;
      } finally {
        if (this.checkId === currentCheckId) {
          this.inFlightCheck = null;
        }
      }
    })();

    return this.inFlightCheck;
  }

  getAvailability(): CliAvailability | null {
    return this.availability;
  }

  getDetails(): AgentCliDetails | null {
    return this.details;
  }

  async refresh(): Promise<CliAvailability> {
    await refreshPath();
    this.checkId++;
    this.inFlightCheck = null;
    return this.checkAvailability();
  }

  private async checkAgent(config: AgentConfig): Promise<AgentCheckOutcome> {
    const probe = await this.probeCommand(config);

    if (probe.status === "blocked") {
      return {
        state: "blocked",
        detail: {
          state: "blocked",
          resolvedPath: probe.path ?? null,
          via: probe.via ?? null,
          blockReason: probe.reason,
          message: probe.message,
        },
      };
    }

    if (probe.status === "missing") {
      return {
        state: "missing",
        detail: { state: "missing", resolvedPath: null, via: null },
      };
    }

    // WSL-detected agents are "installed" but NEVER "ready". Daintree's PTY
    // host spawns binaries directly — we cannot yet launch through wsl.exe.
    // Promoting to "ready" (e.g. because OPENAI_API_KEY is set) would make
    // the user click Codex and hit a silent ENOENT. Cap at "installed" and
    // attach a clear diagnostic so the Settings UI explains the gap.
    if (probe.via === "wsl") {
      return {
        state: "installed",
        detail: {
          state: "installed",
          resolvedPath: probe.path,
          via: "wsl",
          wslDistro: probe.wslDistro,
          message:
            "Detected in WSL — direct launch from Daintree on Windows isn't supported yet. Install a native Windows binary if available.",
        },
      };
    }

    if (!config.authCheck) {
      return {
        state: "ready",
        detail: {
          state: "ready",
          resolvedPath: probe.path,
          via: probe.via,
        },
      };
    }

    const authState = await this.checkAuth(config.name, config.authCheck);
    return {
      state: authState,
      detail: {
        state: authState,
        resolvedPath: probe.path,
        via: probe.via,
      },
    };
  }

  private async checkAuth(
    agentName: string,
    authCheck: AgentAuthCheck
  ): Promise<AgentAvailabilityState> {
    // Shared flag so the checkPromise knows the timeoutPromise already won
    // the race. Without this, a slow fs.access can later resolve/reject and
    // emit a misleading "auth check fell through" log for an agent whose
    // state was actually determined by the timeout branch.
    let timedOut = false;
    // Track the timeout handle so we can clear it when checkPromise wins —
    // otherwise each fast-path success leaves an unresolved 3s timer pinned
    // to the event loop. Bounded leak per-refresh but worth avoiding.
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<AgentAvailabilityState>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve(authCheck.fallback ?? "installed");
      }, CliAvailabilityService.AUTH_CHECK_TIMEOUT_MS);
    });

    const checkPromise = (async (): Promise<AgentAvailabilityState> => {
      const checkedPaths: string[] = [];

      // Check environment variable first (positive signal only)
      if (authCheck.envVar) {
        const envVars = Array.isArray(authCheck.envVar) ? authCheck.envVar : [authCheck.envVar];
        for (const envVar of envVars) {
          if (process.env[envVar]) {
            return "ready";
          }
        }
      }

      const home = homedir();

      // Check platform-specific config paths
      const platform = process.platform as "darwin" | "linux" | "win32";
      const platformPaths = authCheck.configPaths?.[platform];
      if (platformPaths) {
        for (const relPath of platformPaths) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return "ready";
          } catch {
            // File not found, continue
          }
        }
      }

      // Check platform-independent config paths
      if (authCheck.configPathsAll) {
        for (const relPath of authCheck.configPathsAll) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return "ready";
          } catch {
            // File not found, continue
          }
        }
      }

      const fallbackState = authCheck.fallback ?? "installed";
      if (!timedOut) {
        console.log(
          `[CliAvailabilityService] ${agentName}: binary found, auth check fell through (checked: ${
            checkedPaths.join(", ") || "none"
          }) -> "${fallbackState}"`
        );
      }
      return fallbackState;
    })();

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Layered binary probe. Tries in order:
   * 1. `which`/`where` against PATH (existing behavior, now capturing resolved
   *    path and classifying EACCES/EPERM errors as `blocked` instead of
   *    `missing`).
   * 2. Absolute paths declared in `AgentConfig.nativePaths` — covers native
   *    installer locations not on Electron's PATH (e.g. `~/.local/bin/claude`).
   * 3. `npx --prefer-offline --no <pkg>` — detects CLIs present in the npx
   *    cache with no globally installed bin shim. Only fires when
   *    `AgentConfig.npxPackage` is set.
   * 4. WSL probe on Windows — only fires when `AgentConfig.supportsWsl` is
   *    true. Probes `wsl.exe --list --quiet` then `wsl.exe -d <distro> -e
   *    <cmd> --version` against the first listed distribution.
   *
   * A `blocked` result from the shell probe short-circuits the fallbacks:
   * the same endpoint security policy that blocked the PATH binary will
   * typically also block the native-path or npx binary, so probing them
   * would only mask the real problem.
   */
  private async probeCommand(config: AgentConfig): Promise<ProbeResult> {
    const command = config.command;
    if (typeof command !== "string" || !command.trim()) {
      return { status: "missing" };
    }
    if (!CliAvailabilityService.VALID_COMMAND_RE.test(command)) {
      console.warn(
        `[CliAvailabilityService] Command "${command}" contains invalid characters, rejecting`
      );
      return { status: "missing" };
    }

    const shellProbe = await this.probeViaShell(command);
    if (shellProbe.status !== "missing") {
      return shellProbe;
    }

    if (config.nativePaths && config.nativePaths.length > 0) {
      const nativeProbe = await this.probeNativePaths(config.nativePaths);
      if (nativeProbe.status !== "missing") {
        return nativeProbe;
      }
    }

    if (config.npxPackage) {
      const npxProbe = await this.probeNpx(config.npxPackage);
      if (npxProbe.status !== "missing") {
        return npxProbe;
      }
    }

    if (process.platform === "win32" && config.supportsWsl) {
      const wslProbe = await this.probeWsl(command);
      if (wslProbe.status !== "missing") {
        return wslProbe;
      }
    }

    return { status: "missing" };
  }

  private probeViaShell(command: string): Promise<ProbeResult> {
    return new Promise((resolve) => {
      setImmediate(() => {
        const checkCmd = process.platform === "win32" ? "where" : "which";
        try {
          // Capture stdout to expose the resolved absolute path in
          // diagnostics. `where` may print multiple candidates on Windows
          // (one per line) — the first line is the one `CreateProcess`
          // resolves to, so take that.
          const buffer = execFileSync(checkCmd, [command], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: CliAvailabilityService.WHICH_TIMEOUT_MS,
          });
          const output = buffer.toString("utf8").trim();
          const resolved = output.split(/\r?\n/)[0]?.trim() || command;
          resolve({ status: "found", path: resolved, via: "which" });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          // EACCES / EPERM from which/where itself is rare — most endpoint
          // security blocks surface on the spawn attempt. Still, when they
          // do, the binary clearly exists on disk (otherwise we'd have
          // ENOENT) so "blocked" is the correct classification.
          if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
            resolve({
              status: "blocked",
              reason: "security",
              via: "which",
              message: `${checkCmd} "${command}" failed with ${code} — likely blocked by security software or missing execute permission`,
            });
            return;
          }
          resolve({ status: "missing" });
        }
      });
    });
  }

  private async probeNativePaths(paths: string[]): Promise<ProbeResult> {
    const home = homedir();
    for (const raw of paths) {
      const expanded = this.expandPath(raw, home);
      if (!expanded) continue;
      try {
        await access(expanded, constants.X_OK);
        return { status: "found", path: expanded, via: "native" };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
          // File exists but cannot be executed — classify as blocked and
          // stop probing remaining native paths. Trying other paths would
          // likely hit the same policy.
          return {
            status: "blocked",
            reason: code === "EACCES" ? "permissions" : "security",
            path: expanded,
            via: "native",
            message: `${expanded} exists but execution failed with ${code} — check file permissions or security software allowlist`,
          };
        }
        // ENOENT (or any other error) — try the next candidate.
      }
    }
    return { status: "missing" };
  }

  private probeNpx(pkg: string): Promise<ProbeResult> {
    // Basic package-name sanity. npm allows scopes, dots, hyphens, and
    // underscores; we pass this through execFile (no shell) but still want
    // to reject anything surprising so CLI output in logs stays predictable.
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) {
      return Promise.resolve({ status: "missing" });
    }

    return new Promise((resolve) => {
      // `--no` (npm v9+) avoids any install prompt; `--prefer-offline` keeps
      // the probe off the network when the package is cached. Some older
      // npm versions expose the flag as `--no-install` — we pass both via
      // argument order so the modern version wins without erroring.
      execFile(
        "npx",
        ["--prefer-offline", "--no", pkg, "--version"],
        {
          timeout: CliAvailabilityService.NPX_TIMEOUT_MS,
          windowsHide: true,
        },
        (err) => {
          if (!err) {
            resolve({ status: "found", path: `npx:${pkg}`, via: "npx" });
            return;
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
            resolve({
              status: "blocked",
              reason: "security",
              via: "npx",
              message: `npx probe for "${pkg}" failed with ${code} — likely blocked by security software`,
            });
            return;
          }
          // Non-zero exit, ENOENT (npx not on PATH), timeout — treat as missing.
          resolve({ status: "missing" });
        }
      );
    });
  }

  private async probeWsl(command: string): Promise<ProbeResult> {
    const distro = await this.listFirstWslDistro();
    if (!distro) return { status: "missing" };

    return new Promise((resolve) => {
      execFile(
        "wsl.exe",
        ["-d", distro, "-e", command, "--version"],
        {
          timeout: CliAvailabilityService.WSL_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (err) => {
          if (!err) {
            resolve({
              status: "found",
              path: `wsl:${distro}`,
              via: "wsl",
              wslDistro: distro,
            });
            return;
          }
          resolve({ status: "missing" });
        }
      );
    });
  }

  private listFirstWslDistro(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        "wsl.exe",
        ["--list", "--quiet"],
        {
          // Buffers are returned untouched — we decode below. Setting
          // WSL_UTF8=1 asks WSL to emit UTF-8; older Windows builds still
          // produce UTF-16LE so we fall back if UTF-8 looks empty.
          env: { ...process.env, WSL_UTF8: "1" },
          timeout: CliAvailabilityService.WSL_LIST_TIMEOUT_MS,
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const buf = Buffer.isBuffer(stdout)
            ? stdout
            : Buffer.from(typeof stdout === "string" ? stdout : "", "utf8");

          // WSL has historically emitted UTF-16LE (with BOM) regardless of
          // `WSL_UTF8=1`; recent Windows builds honor the env var and emit
          // UTF-8. Pick the encoding heuristically: a UTF-16LE-encoded ASCII
          // string is roughly half null bytes, and will also be prefixed by
          // the FF FE BOM. Either signal is a strong indicator.
          const sample = buf.subarray(0, Math.min(buf.length, 64));
          let nullBytes = 0;
          for (const byte of sample) {
            if (byte === 0) nullBytes++;
          }
          const hasUtf16Bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
          const looksUtf16 = hasUtf16Bom || nullBytes > sample.length / 3;

          const decoded = looksUtf16
            ? buf.toString("utf16le").replace(/^\uFEFF/, "")
            : buf.toString("utf8");

          const lines = decoded
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          resolve(lines[0] ?? null);
        }
      );
    });
  }

  private expandPath(input: string, home: string): string | null {
    if (!input) return null;
    let expanded = input;
    if (expanded.startsWith("~")) {
      expanded = join(home, expanded.slice(1));
    }
    if (process.platform === "win32") {
      expanded = expandWindowsEnvVars(expanded);
      // On Windows, skip entries that still contain unexpanded %VAR% tokens
      // (env var not set) to avoid probing a literal path like
      // "%LOCALAPPDATA%\claude-code\bin\claude.exe".
      if (expanded.includes("%")) return null;
    } else if (expanded.includes("\\")) {
      // Windows-only candidates should not be probed on Unix.
      return null;
    }
    return expanded;
  }
}
