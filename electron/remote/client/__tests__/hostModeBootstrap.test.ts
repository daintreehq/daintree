import { describe, expect, it } from "vitest";
import { systemdUnitFor } from "../../host/startAtLogin.js";
import type { CommandInput, CommandResult } from "../commandRunner.js";
import {
  bootstrapHostMode,
  detachedAliveScript,
  detachedStartScript,
  detachedStopScript,
  ENABLE_LINGER_SCRIPT,
  parseDetachedAlive,
  parseDetachedLaunch,
  hostModeConfirmed,
  DROP_UNIT_BACKUP_SCRIPT,
  lastRunError,
  REMOVE_UNIT_SCRIPT,
  restoreUnitScript,
  SAVE_UNIT_SCRIPT,
  SERVICE_JOURNAL_SCRIPT,
  SERVICE_STATE_SCRIPT,
  linuxHandoffScript,
  MAC_ENABLE_SCRIPT,
  macEnableScript,
  START_UNIT_SCRIPT,
  writeUnitScript,
} from "../hostModeBootstrap.js";
import { probeHost, type ProbeOutcome } from "../hostProbe.js";
import type { HostCommandChannel } from "../remoteShell.js";

const CLIENT = { version: "1.4.0", commit: "abcdef0123" };
const BUILD = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
  spawnError: null,
  timedOut: false,
});

function state(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    daintreeHostMode: 1,
    pid: 4242,
    enabled: true,
    startAtLogin: true,
    startAtLoginInstalled: true,
    startAtLoginError: null,
    keychain: {
      state: "ok",
      detail: "Keychain answered a test encrypt and decrypt",
      checked: true,
    },
    ...overrides,
  });
}

function mac(opts: { listening?: boolean; running?: boolean; agent?: boolean; state?: string }) {
  return [
    "@@dt:uname Darwin arm64",
    "@@dt:install app-bundle /Applications/Daintree.app",
    "@@dt:version 1.4.0",
    `@@dt:buildinfo ${BUILD}`,
    ...(opts.running || opts.listening ? ["@@dt:running yes"] : []),
    `@@dt:launchagent ${opts.agent ? "yes" : "no"}`,
    ...(opts.listening ? ["@@dt:listening yes", "@@dt:hostpid 4242"] : []),
    ...(opts.state ? [`@@dt:hostmodestate ${opts.state}`] : []),
    "@@dt:end",
  ].join("\n");
}

function linux(opts: {
  install?: "deb" | "appimage";
  listening?: boolean;
  running?: boolean;
  unit?: "enabled" | "missing";
  linger?: "yes" | "no";
  fuse?: boolean;
  state?: string;
  settings?: "yes" | "no";
}) {
  const image = "/home/greg/Applications/Daintree.AppImage";
  return [
    "@@dt:uname Linux x86_64",
    ...(opts.settings ? [`@@dt:settings ${opts.settings}`] : []),
    ...(opts.install === "appimage"
      ? [`@@dt:appimage ${image}`, `@@dt:appimageinfo ${BUILD}`]
      : ["@@dt:install deb /opt/Daintree", "@@dt:version 1.4.0", `@@dt:buildinfo ${BUILD}`]),
    ...(opts.running || opts.listening ? ["@@dt:running yes"] : []),
    ...(opts.unit === "enabled" ? ["@@dt:unit yes", "@@dt:unitenabled enabled"] : ["@@dt:unit no"]),
    `@@dt:linger Linger=${opts.linger ?? "no"}`,
    `@@dt:fuse ${opts.fuse === false ? "no" : "yes"}`,
    ...(opts.listening ? ["@@dt:listening yes", "@@dt:hostpid 4242"] : []),
    ...(opts.state ? [`@@dt:hostmodestate ${opts.state}`] : []),
    "@@dt:end",
  ].join("\n");
}

interface Recorded {
  script: string;
  input?: CommandInput;
}

/** A running Daintree takes the handoff; there was no unit before; anything else succeeds quietly. */
const handedOver = (script: string) =>
  script.includes("--host-mode-handoff")
    ? ok("@@dt:handoff 0\n")
    : script === SAVE_UNIT_SCRIPT
      ? ok("@@dt:unitsaved no\n")
      : ok();

function scripted(answer: (script: string) => CommandResult = handedOver) {
  const calls: Recorded[] = [];
  const channel: HostCommandChannel = {
    exec: async (script) => {
      calls.push({ script });
      return answer(script);
    },
    execWithInput: async (script, input) => {
      calls.push({ script, input });
      return answer(script);
    },
    sendFile: async () => ok(),
  };
  return { channel, calls };
}

async function outcomeOf(stdout: string): Promise<ProbeOutcome> {
  return probeHost({
    connection: { kind: "ssh", target: "studio" },
    client: CLIENT,
    shell: {
      exec: async () => ok(stdout),
      execWithInput: async () => ok(),
      sendFile: async () => ok(),
    },
  });
}

/** Probe answers in order; the last one repeats. */
function probes(outputs: string[]) {
  const queue = [...outputs];
  let count = 0;
  return {
    probe: async () => {
      count++;
      return outcomeOf(queue.length > 1 ? queue.shift()! : queue[0]!);
    },
    count: () => count,
  };
}

function clock() {
  let t = 0;
  return () => (t += 1_000);
}

describe("bootstrapHostMode on a Mac", () => {
  it("launches through the logged-in session with --enable-host-mode and succeeds only on read-back", async () => {
    const { channel, calls } = scripted();
    const seen = probes([
      mac({ listening: false }),
      mac({ listening: true, agent: false, state: state({ enabled: false, startAtLogin: false }) }),
      mac({ listening: true, agent: true, state: state() }),
    ]);
    const result = await bootstrapHostMode(
      { kind: "ssh", target: "studio" },
      await outcomeOf(mac({})),
      {
        channel,
        probe: seen.probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(calls.map((c) => c.script)).toEqual([MAC_ENABLE_SCRIPT]);
    expect(MAC_ENABLE_SCRIPT).toBe(
      "open -n -g -a '/Applications/Daintree.app' --args --host-mode --enable-host-mode"
    );
    expect(macEnableScript("nightly")).toBe(
      "open -n -g -a '/Applications/Daintree.app' --args --host-mode --enable-host-mode --update-channel=nightly"
    );
    expect(seen.count()).toBe(3);
    expect(result.probe.hostModeState).toMatchObject({ enabled: true, startAtLogin: true });
    expect(result.lingerRefused).toBeNull();
  });

  it("fails, naming what it saw, when Host mode listens but the setting never reads back", async () => {
    const { channel } = scripted();
    const listeningOnly = mac({ listening: true, state: state({ enabled: false }) });
    await expect(
      bootstrapHostMode({ kind: "ssh", target: "studio" }, await outcomeOf(mac({})), {
        channel,
        probe: probes([listeningOnly]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/listening on studio, but its setting there didn't read back as on/);
  });

  it("reports the host's own reason when start at login couldn't be installed", async () => {
    const { channel } = scripted();
    const failed = mac({
      listening: true,
      state: state({
        startAtLogin: false,
        startAtLoginInstalled: false,
        startAtLoginError: "EACCES: permission denied, open '~/Library/LaunchAgents'",
      }),
    });
    await expect(
      bootstrapHostMode({ kind: "ssh", target: "studio" }, await outcomeOf(mac({})), {
        channel,
        probe: probes([failed]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/start at login couldn't be installed there: EACCES/);
  });

  it("doesn't trust a status file left by an earlier process", () => {
    return outcomeOf(mac({ listening: true, agent: true, state: state({ pid: 1111 }) })).then(
      (outcome) => expect(hostModeConfirmed(outcome)).toBe(false)
    );
  });

  it("does nothing on a host already switched on", async () => {
    const { channel, calls } = scripted();
    const result = await bootstrapHostMode(
      { kind: "ssh", target: "studio" },
      await outcomeOf(mac({ listening: true, agent: true, state: state() })),
      { channel, probe: probes([mac({})]).probe, sleep: async () => {}, now: clock() }
    );
    expect(calls).toEqual([]);
    expect(result.probe.hostModeListening).toBe(true);
  });

  it("turns Host mode on for a host on another build as it is: that build connects best effort", async () => {
    const { channel, calls } = scripted();
    const otherBuild = (stdout: string) =>
      stdout.replace(BUILD, BUILD.replace("abcdef0123", "0000000000"));
    const other = otherBuild(mac({}));
    const seen = probes([
      otherBuild(mac({ listening: false })),
      otherBuild(mac({ listening: true, agent: true, state: state() })),
    ]);
    const before = await outcomeOf(other);
    expect(before.result.matchesClient).toBe(false);
    const result = await bootstrapHostMode({ kind: "ssh", target: "studio" }, before, {
      channel,
      probe: seen.probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(calls.map((c) => c.script)).toEqual([MAC_ENABLE_SCRIPT]);
    expect(result.probe.hostModeState).toMatchObject({ enabled: true, startAtLogin: true });
  });
});

describe("bootstrapHostMode on a headless Linux host", () => {
  it("writes and enables the Daintree unit, asks for linger, starts it, then hands over --enable-host-mode", async () => {
    const { channel, calls } = scripted();
    const target = { executable: "/opt/Daintree/daintree", appPath: null };
    const result = await bootstrapHostMode(
      { kind: "ssh", target: "bigbox" },
      await outcomeOf(linux({})),
      {
        channel,
        probe: probes([
          linux({ unit: "enabled" }),
          linux({ unit: "enabled", listening: true }),
          linux({ unit: "enabled", listening: true, linger: "yes", state: state() }),
        ]).probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(calls.map((c) => c.script)).toEqual([
      ENABLE_LINGER_SCRIPT,
      SAVE_UNIT_SCRIPT,
      writeUnitScript(),
      START_UNIT_SCRIPT,
      // The restart count when it started, and again while it hadn't listened yet.
      SERVICE_STATE_SCRIPT,
      SERVICE_STATE_SCRIPT,
      linuxHandoffScript({ ...target, appImageExtractAndRun: false }),
    ]);
    // The very text the host writes for itself, so it finds its unit current.
    expect(calls[2]!.input).toEqual({ text: systemdUnitFor(target) });
    expect(writeUnitScript()).toBe(
      'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/daintree-host.service.tmp" && chmod 644 "$HOME/.config/systemd/user/daintree-host.service.tmp" && mv -f "$HOME/.config/systemd/user/daintree-host.service.tmp" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && systemctl --user enable daintree-host.service'
    );
    expect(calls.at(-1)!.script).toBe(
      "'/opt/Daintree/daintree' --host-mode --enable-host-mode --host-mode-handoff </dev/null >/dev/null 2>&1; echo \"@@dt:handoff $?\""
    );
    expect(result).toMatchObject({ lingerRefused: null, probe: { hostModeListening: true } });
  });

  it("says in the host's words why lingering was refused, and still switches Host mode on", async () => {
    const { channel } = scripted((script) =>
      script === ENABLE_LINGER_SCRIPT
        ? fail("Could not enable linger: Interactive authentication required.")
        : script.includes("--host-mode-handoff")
          ? ok("@@dt:handoff 0\n")
          : handedOver(script)
    );
    const result = await bootstrapHostMode(
      { kind: "ssh", target: "bigbox" },
      await outcomeOf(linux({})),
      {
        channel,
        probe: probes([
          linux({ unit: "enabled", listening: true }),
          linux({ unit: "enabled", listening: true, state: state() }),
        ]).probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(result.lingerRefused).toBe(
      "Could not enable linger: Interactive authentication required."
    );
  });

  it("doesn't ask a WSL distro for lingering: its login lasts as long as the distro runs", async () => {
    const { channel, calls } = scripted();
    const result = await bootstrapHostMode(
      { kind: "wsl", distro: "Debian" },
      await outcomeOf(linux({ linger: "no" })),
      {
        channel,
        probe: probes([
          linux({ unit: "enabled", linger: "no" }),
          linux({ unit: "enabled", listening: true, linger: "no" }),
          linux({ unit: "enabled", listening: true, linger: "no", state: state() }),
        ]).probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(calls.some((c) => c.script === ENABLE_LINGER_SCRIPT)).toBe(false);
    expect(calls[0]!.script).toBe(SAVE_UNIT_SCRIPT);
    expect(result).toMatchObject({ lingerRefused: null, probe: { hostModeListening: true } });
  });

  it("hands this machine's update channel to a host whose Daintree has never run, and only to one", async () => {
    const handoffFor = async (settings: "yes" | "no" | undefined) => {
      const { channel, calls } = scripted();
      await bootstrapHostMode(
        { kind: "wsl", distro: "Debian" },
        await outcomeOf(linux({ settings })),
        {
          channel,
          probe: probes([
            linux({ unit: "enabled" }),
            linux({ unit: "enabled", listening: true }),
            linux({ unit: "enabled", listening: true, state: state() }),
          ]).probe,
          sleep: async () => {},
          now: clock(),
          updateChannel: "nightly",
        }
      );
      return calls.at(-1)!.script;
    };
    expect(await handoffFor("no")).toBe(
      "'/opt/Daintree/daintree' --host-mode --enable-host-mode --update-channel=nightly --host-mode-handoff </dev/null >/dev/null 2>&1; echo \"@@dt:handoff $?\""
    );
    // Daintree has run there: whoever set its channel, it stays.
    expect(await handoffFor("yes")).not.toContain("--update-channel");
    expect(await handoffFor(undefined)).not.toContain("--update-channel");
  });

  it("runs an AppImage unpacked, in the unit and the handoff, where there is no FUSE", async () => {
    const { channel, calls } = scripted();
    const before = linux({ install: "appimage", fuse: false, linger: "yes" });
    await bootstrapHostMode({ kind: "ssh", target: "bigbox" }, await outcomeOf(before), {
      channel,
      probe: probes([
        linux({
          install: "appimage",
          fuse: false,
          listening: true,
          unit: "enabled",
          linger: "yes",
        }),
        linux({
          install: "appimage",
          fuse: false,
          listening: true,
          unit: "enabled",
          linger: "yes",
          state: state(),
        }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
    });
    const unit = calls.find((c) => c.input)!.input as { text: string };
    expect(unit.text).toContain(
      'ExecStart="/home/greg/Applications/Daintree.AppImage" "--host-mode" "--ozone-platform=headless"'
    );
    expect(unit.text).toContain("Environment=APPIMAGE_EXTRACT_AND_RUN=1");
    expect(calls.at(-1)!.script).toMatch(
      /^APPIMAGE_EXTRACT_AND_RUN=1 '\/home\/greg\/Applications\/Daintree\.AppImage' --host-mode --enable-host-mode --host-mode-handoff /
    );
    // Linger was already on: not asked again.
    expect(calls.some((c) => c.script === ENABLE_LINGER_SCRIPT)).toBe(false);
  });

  it("hands over to a Daintree already running there without installing or starting a unit", async () => {
    const { channel, calls } = scripted((script) =>
      script.includes("--host-mode-handoff") ? ok("@@dt:handoff 0\n") : ok()
    );
    await bootstrapHostMode(
      { kind: "ssh", target: "bigbox" },
      await outcomeOf(linux({ running: true, linger: "yes" })),
      {
        channel,
        probe: probes([linux({ unit: "enabled", listening: true, linger: "yes", state: state() })])
          .probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(calls.map((c) => c.script)).toEqual([
      linuxHandoffScript({
        executable: "/opt/Daintree/daintree",
        appPath: null,
        appImageExtractAndRun: false,
      }),
    ]);
  });

  it("stops when the handoff finds nothing running, rather than start a backend under SSH", async () => {
    const { channel } = scripted((script) =>
      script.includes("--host-mode-handoff") ? ok("@@dt:handoff 3\n") : ok()
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ running: true, linger: "yes" })),
        {
          channel,
          probe: probes([linux({ running: true })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/stopped running on bigbox/);
  });

  it("reports systemctl's own words when the user's service manager can't be reached", async () => {
    const { channel } = scripted((script) =>
      script === writeUnitScript()
        ? fail("Failed to connect to bus: No medium found")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes" })),
        {
          channel,
          probe: probes([linux({})]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/Host mode service \(systemctl --user\): Failed to connect to bus/);
  });

  it("stops waiting on a service that keeps exiting, and says what its last run printed", async () => {
    let restarts = 3;
    const journal = [
      "Started daintree-host.service - Daintree host (serves Daintree windows on other machines over SSH).",
      "[GPU] Headless Host mode: ozone-platform=headless, GPU disabled",
      "[8093:1012/053606.113380:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY",
      "[8093:1012/053606.113490:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.",
      "Main process exited, code=dumped, status=5/TRAP",
      "Failed with result 'core-dump'.",
      "Scheduled restart job, restart counter is at 4.",
    ].join("\n");
    const { channel, calls } = scripted((script) =>
      script === SERVICE_STATE_SCRIPT
        ? ok(`@@dt:restarts ${restarts++}\n`)
        : script === SERVICE_JOURNAL_SCRIPT
          ? ok(journal)
          : handedOver(script)
    );
    const seen = probes([linux({ unit: "enabled", linger: "yes" })]);
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes" })),
        { channel, probe: seen.probe, sleep: async () => {}, now: clock() }
      )
    ).rejects.toThrow(
      "Daintree's Host mode service on bigbox keeps exiting as it starts: Missing X server or $DISPLAY (more in journalctl --user -u daintree-host.service there)"
    );
    // Restarts left from before (3) don't count: it gave up at the second
    // probe, once two more of its own had happened, not at the 60 s limit.
    expect(seen.count()).toBe(2);
    expect(calls.at(-1)!.script).toBe(REMOVE_UNIT_SCRIPT);
  });

  it("removes the unit it wrote when Host mode never reads back, so nothing starts at the next login", async () => {
    const { channel, calls } = scripted();
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", listening: true, linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/didn't record that it was switched on/);
    expect(calls.at(-1)!.script).toBe(REMOVE_UNIT_SCRIPT);
  });

  it("puts back a disabled, stopped unit that was there before, as it was, when setup fails", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : script === START_UNIT_SCRIPT
          ? fail("Job failed")
          : handedOver(script)
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/Couldn't start the Host mode service/);
    const restore = restoreUnitScript({ existed: true, wanted: false, active: false });
    expect(calls.map((c) => c.script)).toEqual([
      SAVE_UNIT_SCRIPT,
      writeUnitScript(),
      START_UNIT_SCRIPT,
      restore,
    ]);
    expect(restore).toBe(
      'rm -f "$HOME/.config/systemd/user/default.target.wants/daintree-host.service" && mv -f "$HOME/.config/systemd/user/daintree-host.service.daintree-setup-backup" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && { systemctl --user stop daintree-host.service >/dev/null 2>&1; true; }'
    );
    expect(calls.some((c) => c.script === REMOVE_UNIT_SCRIPT)).toBe(false);
  });

  it("puts back an enabled, running unit without touching its links, and running", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted yes\n@@dt:unitactive active\n")
        : script.includes("--host-mode-handoff")
          ? ok("@@dt:handoff 1\n")
          : ok()
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", listening: true, linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/didn't take the request/);
    const restore = restoreUnitScript({ existed: true, wanted: true, active: true });
    expect(calls.at(-1)!.script).toBe(restore);
    expect(restore).toBe(
      'mv -f "$HOME/.config/systemd/user/daintree-host.service.daintree-setup-backup" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && systemctl --user start daintree-host.service'
    );
  });

  it("drops its copy of the earlier unit once Host mode reads back on", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : handedOver(script)
    );
    await bootstrapHostMode(
      { kind: "ssh", target: "bigbox" },
      await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
      {
        channel,
        probe: probes([linux({ unit: "enabled", listening: true, linger: "yes", state: state() })])
          .probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    expect(calls.at(-1)!.script).toBe(DROP_UNIT_BACKUP_SCRIPT);
  });

  it("touches nothing when it can't keep a copy of the unit already there", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved failed\n@@dt:unitwanted yes\n@@dt:unitactive inactive\n")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/Couldn't keep a copy of the Host mode service/);
    expect(calls.map((c) => c.script)).toEqual([SAVE_UNIT_SCRIPT]);
  });

  it("touches nothing when it can't tell whether the unit already there was running", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted yes\n@@dt:unitactive \n")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(/Couldn't keep a copy of the Host mode service/);
    expect(calls.map((c) => c.script)).toEqual([SAVE_UNIT_SCRIPT]);
  });

  it("says where the earlier unit's copy is when it can't be put back", async () => {
    const { channel } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : script === START_UNIT_SCRIPT
          ? fail("Job failed")
          : script.startsWith("rm -f")
            ? fail("mv: cannot move: Read-only file system")
            : handedOver(script)
    );
    await expect(
      bootstrapHostMode(
        { kind: "ssh", target: "bigbox" },
        await outcomeOf(linux({ linger: "yes", unit: "enabled" })),
        {
          channel,
          probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
          sleep: async () => {},
          now: clock(),
        }
      )
    ).rejects.toThrow(
      /Couldn't start the Host mode service: Job failed\. Setup couldn't put back the Host mode service that was already on bigbox: its copy is at ~\/\.config\/systemd\/user\/daintree-host\.service\.daintree-setup-backup there \(mv: cannot move: Read-only file system\)/
    );
  });

  it("doesn't take a host whose listener pid wasn't seen alive as switched on", async () => {
    const stale = await outcomeOf(
      linux({ unit: "enabled", listening: true, state: state() }).replace("@@dt:hostpid 4242\n", "")
    );
    expect(hostModeConfirmed(stale)).toBe(false);
  });
});

describe("lastRunError", () => {
  it("takes the first error of the last run, not one from an earlier run", () => {
    const journal = [
      "Started daintree-host.service - Daintree host.",
      "[1:1:ERROR:a.cc:1] An old failure",
      "Main process exited, code=exited, status=1/FAILURE",
      "Started daintree-host.service - Daintree host.",
      "[INFO] [main:default] resource-profile-service-started",
      "/opt/Daintree/daintree: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory",
      "Main process exited, code=exited, status=127/n/a",
    ].join("\n");
    expect(lastRunError(journal)).toBe(
      "/opt/Daintree/daintree: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory"
    );
  });

  it("finds nothing in a run that printed no error", () => {
    expect(lastRunError("Started daintree-host.service.\n[INFO] starting\n")).toBeNull();
    expect(lastRunError("")).toBeNull();
  });
});

describe("bootstrapHostMode on a Linux machine with no init system", () => {
  const onConnect = (opts: Parameters<typeof linux>[0]) =>
    linux(opts).replace("@@dt:end", "@@dt:init docker-init\n@@dt:end");
  const onConnectState = (overrides: Record<string, unknown> = {}) =>
    state({
      startMethod: "on-connect",
      startAtLogin: false,
      startAtLoginInstalled: null,
      ...overrides,
    });
  /** Starts answer with `launch`, a launch asked about is `alive`, and the log holds `log`. */
  const detached =
    (launch: string, alive = true, log = "") =>
    (script: string) =>
      script.includes("nohup")
        ? ok(`@@dt:launched ${launch}\n`)
        : script.includes("alive yes")
          ? ok(alive ? "@@dt:alive yes\n" : "")
          : script.includes("host.log")
            ? ok(log)
            : handedOver(script);

  it("starts Daintree in a session of its own with the enable request, and confirms it started on connect", async () => {
    const { channel, calls } = scripted(detached("777 123456 new"));
    const before = await outcomeOf(onConnect({ install: "appimage", fuse: false, settings: "no" }));
    expect(before.result.startsOnConnect).toBe(true);
    const result = await bootstrapHostMode({ kind: "ssh", target: "box" }, before, {
      channel,
      probe: probes([
        onConnect({ install: "appimage", fuse: false }),
        onConnect({ install: "appimage", fuse: false, listening: true, state: onConnectState() }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
      updateChannel: "nightly",
    });
    const scripts = calls.map((c) => c.script);
    const start = scripts.find((script) => script.includes("nohup"))!;
    expect(start).toBe(
      detachedStartScript(
        {
          executable: "/home/greg/Applications/Daintree.AppImage",
          appPath: null,
          appImageExtractAndRun: true,
        },
        ["--enable-host-mode", "--update-channel=nightly"]
      )
    );
    expect(start).toContain(
      "'/home/greg/Applications/Daintree.AppImage' '--host-mode' '--ozone-platform=headless' '--enable-host-mode' '--update-channel=nightly'"
    );
    expect(start).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
    // No service, lingering, unit backup or handoff: there is nothing for any of them.
    expect(scripts).not.toContain(ENABLE_LINGER_SCRIPT);
    expect(scripts).not.toContain(SAVE_UNIT_SCRIPT);
    expect(scripts.some((script) => script.includes("systemctl"))).toBe(false);
    expect(scripts.some((script) => script.includes("--host-mode-handoff"))).toBe(false);
    expect(result.probe.hostModeState).toMatchObject({ enabled: true, startMethod: "on-connect" });
    expect(result.lingerRefused).toBeNull();
  });

  it("hands the request to a Daintree already running there, starting nothing", async () => {
    const { channel, calls } = scripted(detached("777 123456 new"));
    await bootstrapHostMode(
      { kind: "cloud", bindingId: "b1" },
      await outcomeOf(onConnect({ running: true })),
      {
        channel,
        probe: probes([onConnect({ listening: true, state: onConnectState() })]).probe,
        sleep: async () => {},
        now: clock(),
      }
    );
    const scripts = calls.map((c) => c.script);
    expect(scripts.some((script) => script.includes("nohup"))).toBe(false);
    expect(scripts.filter((script) => script.includes("--host-mode-handoff"))).toHaveLength(1);
  });

  it("hands the request over once an earlier start still unpacking listens", async () => {
    const { channel, calls } = scripted(detached("555 99 running"));
    await bootstrapHostMode({ kind: "ssh", target: "box" }, await outcomeOf(onConnect({})), {
      channel,
      probe: probes([
        onConnect({}),
        onConnect({ listening: true, state: onConnectState({ enabled: false }) }),
        onConnect({ listening: true, state: onConnectState() }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
    });
    const scripts = calls.map((c) => c.script);
    const startAt = scripts.findIndex((script) => script.includes("nohup"));
    const handoffAt = scripts.findIndex((script) => script.includes("--host-mode-handoff"));
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(handoffAt).toBeGreaterThan(startAt);
    // Not this setup's start, so not this setup's to stop.
    expect(scripts.some((script) => script.includes("kill -TERM"))).toBe(false);
  });

  it("gives up as soon as the start exits, with the log's first error, and leaves nothing running", async () => {
    const log = [
      "Started Daintree host Thu Nov 19 2026",
      "/home/greg/Applications/Daintree.AppImage: error while loading shared libraries: libnss3.so: cannot open shared object file",
    ].join("\n");
    const { channel, calls } = scripted(detached("777 123456 new", false, log));
    const seen = probes([onConnect({})]);
    await expect(
      bootstrapHostMode({ kind: "ssh", target: "box" }, await outcomeOf(onConnect({})), {
        channel,
        probe: seen.probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(
      /Daintree exited on box as it started: .*libnss3\.so.* \(more in ~\/\.cache\/daintree\/host\.log there\)/
    );
    // Seen gone at the first look, not after the whole wait.
    expect(seen.count()).toBe(1);
    expect(calls.map((c) => c.script)).toContain(
      detachedStopScript({ pid: 777, startedAt: "123456", fresh: true })
    );
  });

  it("stops its own start when Daintree there never records starting on connect", async () => {
    const { channel, calls } = scripted(detached("777 123456 new"));
    await expect(
      bootstrapHostMode({ kind: "ssh", target: "box" }, await outcomeOf(onConnect({})), {
        channel,
        probe: probes([onConnect({ listening: true, state: state() })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/didn't record that it runs without systemd/);
    expect(calls.map((c) => c.script)).toContain(
      detachedStopScript({ pid: 777, startedAt: "123456", fresh: true })
    );
  });

  it("confirms on the on-connect record alone where no init system runs, and never there otherwise", async () => {
    const live = await outcomeOf(onConnect({ listening: true, state: onConnectState() }));
    expect(hostModeConfirmed(live)).toBe(true);
    // The same record on a systemd machine says nothing about its login item.
    const systemdHost = await outcomeOf(
      linux({ listening: true, unit: "missing", state: onConnectState() })
    );
    expect(hostModeConfirmed(systemdHost)).toBe(false);
    expect(hostModeConfirmed(await outcomeOf(onConnect({ listening: true, state: state() })))).toBe(
      false
    );
    expect(
      hostModeConfirmed(
        await outcomeOf(onConnect({ listening: true, state: onConnectState({ pid: 1 }) }))
      )
    ).toBe(false);
  });
});

describe("detached start reports", () => {
  it("reads what a start said, and nothing that only looks like it", () => {
    expect(parseDetachedLaunch("noise\n@@dt:launched 42 9001 new\n")).toEqual({
      pid: 42,
      startedAt: "9001",
      fresh: true,
    });
    expect(parseDetachedLaunch("@@dt:launched 42  running")).toEqual({
      pid: 42,
      startedAt: null,
      fresh: false,
    });
    expect(parseDetachedLaunch("@@dt:launched 42; rm -rf ~ new")).toBeNull();
    expect(parseDetachedLaunch("")).toBeNull();
    expect(parseDetachedAlive("@@dt:alive yes\n")).toBe(true);
    expect(parseDetachedAlive("")).toBe(false);
  });

  it("signals a launch only while it is still the process that was started", () => {
    expect(detachedStopScript({ pid: 42, startedAt: "9001", fresh: true })).toContain(
      `[ "$n" = '9001' ]`
    );
    // Without a start time there is nothing to tell it from a stranger given its pid.
    expect(detachedStopScript({ pid: 42, startedAt: null, fresh: true })).toContain(
      `if [ -n "$n" ] && [ "$n" = '' ]; then`
    );
    expect(detachedAliveScript({ pid: 42, startedAt: null, fresh: true })).toMatch(
      /^p=42; if kill -0 "\$p" 2>\/dev\/null; then /
    );
  });
});
