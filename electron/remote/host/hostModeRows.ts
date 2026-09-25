import type { AttachedClientInfo, HostModeStatusRow } from "../../../shared/types/ipc/hostMode.js";
import type { AdvertiseState } from "./advertise.js";
import type { CommandResult } from "./hostCommands.js";
import type { KeychainCheck } from "./keychainPreflight.js";
import type { StartAtLoginObservation } from "./startAtLogin.js";

/**
 * The status rows under "Allow this machine to be a host". Each says what was
 * observed (a value read, a file found, a command's output), and a fix is
 * offered only as a command for the user to run themselves.
 */

export const PMSET_SLEEP_COMMAND = "sudo pmset -a sleep 0 disksleep 0";

export function socketRow(input: {
  enabled: boolean;
  listening: boolean;
  socketPath: string | null;
  listenError: string | null;
  advertise: AdvertiseState;
}): HostModeStatusRow {
  if (input.listening) {
    const where = input.socketPath ? `Listening at ${input.socketPath}` : "Listening";
    const advertised =
      input.advertise.status === "advertising"
        ? ` · advertised on the local network as ${input.advertise.instanceName}`
        : input.advertise.status === "unavailable"
          ? ` · not advertised on the local network (${input.advertise.reason})`
          : "";
    return { id: "socket", state: "ok", detail: `${where}${advertised}` };
  }
  if (input.listenError) {
    return { id: "socket", state: "unavailable", detail: `Not listening: ${input.listenError}` };
  }
  return {
    id: "socket",
    state: "unknown",
    detail: input.enabled ? "Starting" : "Not listening",
  };
}

export function startAtLoginRow(input: {
  consented: boolean;
  observation: StartAtLoginObservation | null;
  installError: string | null;
}): HostModeStatusRow {
  const obs = input.observation;
  if (input.installError) {
    return {
      id: "start-at-login",
      state: "unavailable",
      detail: `Couldn't set up start at login: ${input.installError}`,
    };
  }
  if (!obs) {
    return { id: "start-at-login", state: "unknown", detail: "Couldn't be read" };
  }
  if (!input.consented) {
    return obs.installed
      ? {
          id: "start-at-login",
          state: "warning",
          detail: `Off, but ${obs.path} is still on disk`,
        }
      : {
          id: "start-at-login",
          state: "unknown",
          detail: "Off — this machine serves other machines only while Daintree is open",
        };
  }
  if (!obs.installed) {
    return { id: "start-at-login", state: "warning", detail: `On, but ${obs.path} is missing` };
  }
  const stale = obs.current ? "" : " · it launches a different Daintree binary than this one";
  if (obs.kind === "launch-agent") {
    return {
      id: "start-at-login",
      state: obs.current ? "ok" : "warning",
      detail: `LaunchAgent at ${obs.path}${stale}`,
    };
  }
  const unit = obs.unitState ? `systemd user unit ${obs.unitState}` : "systemd user unit";
  const lingerCommand = obs.userName ? `loginctl enable-linger ${obs.userName}` : undefined;
  if (obs.unitState !== null && obs.unitState !== "enabled") {
    return { id: "start-at-login", state: "warning", detail: `${unit} (${obs.path})${stale}` };
  }
  if (obs.linger === "no") {
    return {
      id: "start-at-login",
      state: "warning",
      detail: `${unit}; linger is off, so it starts only once you log in${stale}`,
      command: lingerCommand,
    };
  }
  if (obs.linger === null) {
    return {
      id: "start-at-login",
      state: "unknown",
      detail: `${unit}; linger couldn't be read${stale}`,
      command: lingerCommand,
    };
  }
  return {
    id: "start-at-login",
    state: obs.current ? "ok" : "warning",
    detail: `${unit}; linger is on, so it starts at boot${stale}`,
  };
}

export function keychainRow(check: KeychainCheck): HostModeStatusRow {
  return { id: "keychain", state: check.state, detail: check.detail };
}

export interface PmsetValues {
  sleep: number | null;
  disksleep: number | null;
}

export function parsePmset(stdout: string): PmsetValues {
  const read = (key: string): number | null => {
    const match = new RegExp(`^\\s*${key}\\s+(\\d+)`, "m").exec(stdout);
    return match ? Number(match[1]) : null;
  };
  return { sleep: read("sleep"), disksleep: read("disksleep") };
}

function minutes(value: number): string {
  return value === 0 ? "never" : `after ${value} min`;
}

export function sleepRow(
  platform: NodeJS.Platform,
  pmset: CommandResult | null
): HostModeStatusRow {
  if (platform === "linux") {
    return {
      id: "sleep",
      state: "unknown",
      detail:
        "A suspended machine can't be reached. Hold suspend off with systemd-inhibit or your desktop's power settings",
    };
  }
  if (!pmset || pmset.code !== 0) {
    return {
      id: "sleep",
      state: "unknown",
      detail: "pmset -g couldn't be read",
      command: PMSET_SLEEP_COMMAND,
    };
  }
  const values = parsePmset(pmset.stdout);
  if (values.sleep === null) {
    return {
      id: "sleep",
      state: "unknown",
      detail: "pmset -g reported no sleep setting",
      command: PMSET_SLEEP_COMMAND,
    };
  }
  const observed = `System sleep ${minutes(values.sleep)}${
    values.disksleep === null ? "" : `, disk sleep ${minutes(values.disksleep)}`
  } (pmset -g)`;
  if (values.sleep === 0 && (values.disksleep ?? 0) === 0) {
    return { id: "sleep", state: "ok", detail: observed };
  }
  return { id: "sleep", state: "warning", detail: observed, command: PMSET_SLEEP_COMMAND };
}

export function driversRow(clients: readonly AttachedClientInfo[]): HostModeStatusRow {
  if (clients.length === 0) {
    return { id: "drivers", state: "unknown", detail: "No other machines attached" };
  }
  const names = clients.map((client) => {
    const driving = client.drivingProjectIds.length;
    return driving > 0
      ? `${client.clientName} (driving ${driving} project${driving === 1 ? "" : "s"})`
      : client.clientName;
  });
  return { id: "drivers", state: "ok", detail: names.join(", ") };
}
