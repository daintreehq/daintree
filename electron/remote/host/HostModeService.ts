import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { HostModeStatus, SetHostModePayload } from "../../../shared/types/ipc/hostMode.js";
import type { HostModeObservation } from "../../../shared/types/ipc/remoteHosts.js";
import type { AdvertiseState } from "./advertise.js";
import type { CommandResult, CommandRunner } from "./hostCommands.js";
import type { HostListener } from "./hostListener.js";
import { driversRow, keychainRow, sleepRow, socketRow, startAtLoginRow } from "./hostModeRows.js";
import {
  classifyKeychainWithoutTrial,
  runKeychainPreflight,
  type KeychainCheck,
  type KeychainProbe,
} from "./keychainPreflight.js";
import type { StartAtLoginController, StartAtLoginObservation } from "./startAtLogin.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostMode: HostModeService;
  }
}

export interface HostModeSettings {
  enabled: boolean;
  startAtLogin: boolean;
}

export interface HostModeAdvertiser {
  start(): void;
  stop(): void;
  getState(): AdvertiseState;
}

export interface HostModeServiceDeps {
  platform: NodeJS.Platform;
  readSettings(): HostModeSettings;
  writeSettings(next: HostModeSettings): void;
  /** Where the socket lives (or would), known before anything listens. */
  socketPath: string | null;
  startListener(signal: AbortSignal): Promise<HostListener>;
  /** Null where this platform has no start-at-login support. */
  startAtLogin: StartAtLoginController | null;
  /** Built by the service so advertise changes reach its status pushes. */
  createAdvertiser(onChange: () => void): HostModeAdvertiser;
  keychain: KeychainProbe;
  run: CommandRunner;
  broadcast(status: HostModeStatus): void;
  keychainTimeoutMs?: number;
  /** Coalesce bursts of session changes into one push. */
  pushDelayMs?: number;
  /**
   * Record the setting where setup on another machine can read it back over
   * SSH (see hostModeStatusFile.ts). Written only when it changes.
   */
  writeStatus?(observation: Omit<HostModeObservation, "pid">): Promise<void>;
}

function messageOf(error: unknown): string {
  return formatErrorMessage(error, "unknown error");
}

/**
 * "Allow this machine to be a host". On: the socket listens, the host is
 * advertised on the local network, and (only with the user's explicit
 * consent) start at login is installed. Off: the socket closes, every
 * attached Shell's session is dropped, the discovery file goes, and the
 * start-at-login unit is removed. Quitting the app stops listening but keeps
 * the setting and the unit, so the next login brings the host back.
 */
export class HostModeService {
  private readonly advertiser: HostModeAdvertiser;
  private listener: HostListener | null = null;
  private offListener: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private listenError: string | null = null;
  private installError: string | null = null;
  private keychainCheck: KeychainCheck | null = null;
  private preflight: Promise<void> | null = null;
  private observation: StartAtLoginObservation | null = null;
  private pmset: CommandResult | null = null;
  private observed: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private recordedStatus: string | null = null;
  private statusWrite: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HostModeServiceDeps) {
    this.advertiser = deps.createAdvertiser(() => this.pushSoon());
  }

  /** Listen for Shells; used at boot and by the switch. Concurrent calls share one start. */
  startListening(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.listener?.isListening()) return Promise.resolve();
    const abort = new AbortController();
    this.abort = abort;
    this.listenError = null;
    const start = (async () => {
      try {
        const listener = await this.deps.startListener(abort.signal);
        if (abort.signal.aborted) {
          await listener.stop();
          return;
        }
        this.listener = listener;
        this.offListener = listener.onChange(() => this.pushSoon());
        this.advertiser.start();
      } catch (error) {
        if (abort.signal.aborted) return;
        this.listenError = messageOf(error);
        throw error;
      }
    })();
    this.starting = start;
    // Registered before any caller's await, so they see it settled.
    const settle = (): void => {
      if (this.starting === start) this.starting = null;
      this.push();
    };
    start.then(settle, settle);
    return start;
  }

  /** Close the socket and drop every session. Leaves the setting and start at login alone. */
  async stopListening(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    this.advertiser.stop();
    await this.starting?.catch(() => {});
    const listener = this.listener;
    this.listener = null;
    this.offListener?.();
    this.offListener = null;
    await listener?.stop();
    this.listenError = null;
    this.push();
  }

  getStatus(): Promise<HostModeStatus> {
    return this.observe().then(() => this.snapshot());
  }

  setEnabled(payload: SetHostModePayload): Promise<HostModeStatus> {
    const run = this.queue.then(() => this.applyEnabled(payload));
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Setup on another machine asked for Host mode (`--enable-host-mode`): it is
   * switched on exactly as the Settings switch does it, with start at login
   * (the person confirmed both there), and the keychain is checked here.
   */
  async enableFromSetup(): Promise<HostModeStatus> {
    const status = await this.setEnabled({ enabled: true, startAtLogin: true });
    void this.runKeychainPreflight();
    return status;
  }

  /** Run the keychain or keyring check now, from this (GUI) session. */
  async runKeychainPreflight(): Promise<HostModeStatus> {
    this.preflight ??= runKeychainPreflight(
      this.deps.platform,
      this.deps.keychain,
      this.deps.keychainTimeoutMs
    )
      .then(
        (check) => {
          this.keychainCheck = check;
        },
        (error: unknown) => {
          this.keychainCheck = { state: "unknown", detail: `Check failed: ${messageOf(error)}` };
        }
      )
      .finally(() => {
        this.preflight = null;
        this.push();
      });
    await this.preflight;
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.advertiser.stop();
    // A change in flight sees `disposed` at its next step and stops there.
    await this.queue;
    await this.starting?.catch(() => {});
    const listener = this.listener;
    this.listener = null;
    this.offListener?.();
    this.offListener = null;
    await listener?.stop();
  }

  private async applyEnabled(payload: SetHostModePayload): Promise<HostModeStatus> {
    // Quitting: no change to the setting or the login unit after this point.
    if (this.disposed) return this.snapshot();
    const previous = this.deps.readSettings();
    if (!payload.enabled) {
      this.deps.writeSettings({ enabled: false, startAtLogin: false });
      await this.stopListening();
      // A unit left behind would bring the host back at the next login, so
      // this one is reported rather than swallowed.
      await this.removeStartAtLogin({ strict: true });
      await this.observe();
      this.push();
      return this.snapshot();
    }

    // Start at login needs the user's explicit yes: an omitted value keeps
    // what they chose before, and never turns it on by itself.
    const startAtLogin = payload.startAtLogin ?? previous.startAtLogin;
    this.deps.writeSettings({ enabled: true, startAtLogin });
    try {
      await this.startListening();
    } catch (error) {
      this.deps.writeSettings(previous);
      throw error;
    }
    if (this.disposed) return this.snapshot();

    this.installError = null;
    if (startAtLogin) {
      try {
        if (!this.deps.startAtLogin) throw new Error("not supported on this platform");
        await this.deps.startAtLogin.install();
      } catch (error) {
        this.installError = messageOf(error);
        this.deps.writeSettings({ enabled: true, startAtLogin: false });
        // Don't leave a half-installed unit behind a setting that says off.
        await this.removeStartAtLogin();
      }
    } else {
      await this.removeStartAtLogin();
    }

    // The check can prompt; it runs from here, at the machine, never from a
    // remote session, and it reports back when done rather than holding this call.
    if (!previous.enabled) void this.runKeychainPreflight();
    await this.observe();
    this.push();
    return this.snapshot();
  }

  private async removeStartAtLogin(options: { strict?: boolean } = {}): Promise<void> {
    const controller = this.deps.startAtLogin;
    if (!controller) return;
    try {
      if (await controller.isInstalled()) await controller.remove();
    } catch (error) {
      if (options.strict) {
        throw new Error(
          `Start at login couldn't be removed from ${controller.path}: ${messageOf(error)}`,
          { cause: error }
        );
      }
      console.warn("[RemoteHosts] Removing start at login failed:", messageOf(error));
    }
  }

  /** Re-read what the system says; the pushes in between reuse it. */
  private async observe(): Promise<void> {
    const [observation, pmset] = await Promise.all([
      this.deps.startAtLogin ? this.deps.startAtLogin.observe().catch(() => null) : null,
      this.deps.platform === "darwin"
        ? this.deps.run("pmset", ["-g"]).catch(() => null)
        : Promise.resolve(null),
    ]);
    this.observation = observation;
    this.pmset = pmset;
    this.observed ??= Promise.resolve();
  }

  private recordStatus(): void {
    const write = this.deps.writeStatus;
    if (!write) return;
    const settings = this.deps.readSettings();
    const keychain =
      this.keychainCheck ?? classifyKeychainWithoutTrial(this.deps.platform, this.deps.keychain);
    const observation: Omit<HostModeObservation, "pid"> = {
      enabled: settings.enabled,
      startAtLogin: settings.startAtLogin,
      startAtLoginInstalled: this.observation?.installed ?? null,
      startAtLoginError: this.installError,
      keychain: {
        state: keychain.state,
        detail: keychain.detail,
        checked: this.keychainCheck !== null,
      },
    };
    const text = JSON.stringify(observation);
    if (text === this.recordedStatus) return;
    this.recordedStatus = text;
    this.statusWrite = this.statusWrite
      .then(() => write(observation))
      .catch((error: unknown) => {
        // Written again on the next change.
        this.recordedStatus = null;
        console.warn("[RemoteHosts] Recording Host mode status failed:", messageOf(error));
      });
  }

  private snapshot(): HostModeStatus {
    const settings = this.deps.readSettings();
    const listening = this.listener?.isListening() === true;
    const attachedClients = listening ? (this.listener?.attachedClients() ?? []) : [];
    const keychain =
      this.keychainCheck ?? classifyKeychainWithoutTrial(this.deps.platform, this.deps.keychain);
    return {
      supported: true,
      enabled: settings.enabled,
      startAtLogin: settings.startAtLogin,
      socketPath: this.deps.socketPath,
      listening,
      attachedClients,
      rows: [
        socketRow({
          enabled: settings.enabled,
          listening,
          socketPath: this.deps.socketPath,
          listenError: this.listenError,
          advertise: this.advertiser.getState(),
        }),
        startAtLoginRow({
          consented: settings.startAtLogin,
          observation: this.observation,
          installError: this.installError,
        }),
        keychainRow(keychain),
        sleepRow(this.deps.platform, this.pmset),
        driversRow(attachedClients),
      ],
    };
  }

  private push(): void {
    if (this.disposed) return;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    // The first push waits for one read of the system, so no view is told
    // "couldn't be read" about something that was simply never asked.
    this.observed ??= this.observe();
    void this.observed.then(() => {
      if (this.disposed) return;
      try {
        this.deps.broadcast(this.snapshot());
      } catch (error) {
        console.warn("[RemoteHosts] Host mode status push failed:", messageOf(error));
      }
      this.recordStatus();
    });
  }

  private pushSoon(): void {
    if (this.disposed || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, this.deps.pushDelayMs ?? 100);
    this.pushTimer.unref?.();
  }
}
