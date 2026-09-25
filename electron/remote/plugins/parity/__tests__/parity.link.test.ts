// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallResult } from "../../../../../shared/types/plugin.js";
import { pluginIncompatibleError } from "../../../../services/plugin/parity/errors.js";
import { pluginInstallJobs } from "../../../../services/plugin/PluginInstallJobRegistry.js";
import { AppError } from "../../../../utils/errorTypes.js";
import type {
  PluginInventory,
  PluginInventoryEntry,
} from "../../../../services/plugin/parity/inventory.js";
import type { LinkSession } from "../../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
} from "../../../link/__tests__/linkTestUtils.js";
import { ClientPluginParity, type ParitySession } from "../ClientPluginParity.js";
import { HostPluginParity, type HostPluginParityPlugins } from "../HostPluginParity.js";
import { PluginParityLinkMethod, STAGE_CHUNK_BYTES } from "../linkMethods.js";

const HOST = "studio-01";

function entry(pluginId: string, patch: Partial<PluginInventoryEntry> = {}): PluginInventoryEntry {
  return {
    pluginId,
    displayName: pluginId === "acme.md" ? "Markdown Preview" : pluginId,
    version: "1.0.0",
    engine: null,
    platforms: null,
    remoteUnsupported: false,
    blocklisted: false,
    missingSecrets: [],
    ...patch,
  };
}

let dir: string;
let sessions: { host: LinkSession; client: LinkSession };
let localInventory: PluginInventory;
let hostInventory: PluginInventory;
let received: Array<{ sha256: string; size: number; expect: unknown }>;
let hostPlugins: HostPluginParityPlugins & {
  getPluginInventory: ReturnType<typeof vi.fn>;
  installPluginFromAnotherMachine: ReturnType<typeof vi.fn>;
};
let packageBytes: Buffer;
let pack: ReturnType<typeof vi.fn<(dir: string, out: string) => Promise<void>>>;
let host: HostPluginParity;
let client: ClientPluginParity;
let stagingRoot: string;

beforeEach(async () => {
  dir = await makeTempDir();
  stagingRoot = path.join(dir, "staging");
  await fs.mkdir(stagingRoot);
  sessions = await openSessionPair(dir);
  localInventory = { appVersion: "0.38.0", platform: "darwin", plugins: [] };
  hostInventory = { appVersion: "0.38.0", platform: "linux", plugins: [] };
  received = [];
  hostPlugins = {
    getPluginInventory: vi.fn(async () => hostInventory),
    installPluginFromAnotherMachine: vi.fn(
      async (archivePath: string, expect: unknown): Promise<PluginInstallResult> => {
        const bytes = await fs.readFile(archivePath);
        received.push({
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          expect,
        });
        return { status: "installed", pluginId: "acme.md" };
      }
    ),
  };
  host = new HostPluginParity({ plugins: async () => hostPlugins, stagingRoot });
  host.attach(sessions.host);
  packageBytes = randomBytes(STAGE_CHUNK_BYTES * 2 + 1234);
  pack = vi.fn(async (_dir: string, out: string) => fs.writeFile(out, packageBytes));
  client = new ClientPluginParity({
    sessionFor: (hostId) => (hostId === HOST ? sessions.client : null),
    isKnownHost: (hostId) => hostId === HOST,
    hostLabel: () => HOST,
    local: {
      inventory: async () => localInventory,
      installedDir: async (pluginId) =>
        localInventory.plugins.some((p) => p.pluginId === pluginId) ? dir : null,
    },
    pack,
    tmpDir: dir,
    pollMs: 5,
    reconcileTimeoutMs: 2_000,
  });
});

afterEach(async () => {
  sessions.host.close("test");
  sessions.client.close("test");
  host.dispose();
  await removeTempDir(dir);
});

describe("plugin parity over a link", () => {
  it("compares nothing and copies nothing until asked", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hostPlugins.getPluginInventory).not.toHaveBeenCalled();
    expect(hostPlugins.installPluginFromAnotherMachine).not.toHaveBeenCalled();
    expect(pack).not.toHaveBeenCalled();
  });

  it("groups this machine's plugins against the host's", async () => {
    localInventory.plugins = [entry("acme.md"), entry("acme.a", { version: "1.3.0" })];
    hostInventory.plugins = [entry("acme.a", { version: "1.2.0" }), entry("acme.host")];
    const rows = await client.diff({ hostId: HOST });
    expect(rows.map((row) => [row.pluginId, row.group, row.action])).toEqual([
      ["acme.md", "only-here", "install-on-host"],
      ["acme.a", "version-differs", "update-on-host"],
      ["acme.host", "only-on-host", null],
    ]);
    expect(hostPlugins.getPluginInventory).toHaveBeenCalledWith({ includeSecrets: true });
  });

  it("installs one plugin on the host by copying this machine's package in pieces", async () => {
    localInventory.plugins = [entry("acme.md")];
    await client.installOnHost({ hostId: HOST, pluginId: "acme.md" });
    expect(received).toEqual([
      {
        sha256: createHash("sha256").update(packageBytes).digest("hex"),
        size: packageBytes.byteLength,
        expect: { pluginId: "acme.md", update: false },
      },
    ]);
    // The staged copy and this machine's packed copy are both gone.
    expect(await fs.readdir(stagingRoot)).toEqual([]);
    expect((await fs.readdir(dir)).filter((name) => name.startsWith("daintree-plugin"))).toEqual(
      []
    );
  });

  it("refuses a plugin with no build for the host's OS before copying anything", async () => {
    localInventory.plugins = [
      entry("acme.graph", { displayName: "Graph View", platforms: ["darwin"] }),
    ];
    const error = await client
      .installOnHost({ hostId: HOST, pluginId: "acme.graph" })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "PLUGIN_INCOMPATIBLE",
      details: {
        pluginId: "acme.graph",
        hostId: HOST,
        reason: { kind: "platform", hostPlatform: "linux", supported: ["darwin"] },
      },
    });
    expect((error as { userMessage: string }).userMessage).toBe(
      "Graph View has no build for Linux (only macOS); it can't run on studio-01."
    );
    expect(pack).not.toHaveBeenCalled();
    expect(hostPlugins.installPluginFromAnotherMachine).not.toHaveBeenCalled();
  });

  it("offers an update only for a plugin the host has", async () => {
    localInventory.plugins = [entry("acme.md", { version: "2.0.0" })];
    await expect(client.updateOnHost({ hostId: HOST, pluginId: "acme.md" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    hostInventory.plugins = [entry("acme.md")];
    await expect(client.installOnHost({ hostId: HOST, pluginId: "acme.md" })).rejects.toMatchObject(
      {
        userMessage: "Markdown Preview is already installed on studio-01.",
      }
    );
    await client.updateOnHost({ hostId: HOST, pluginId: "acme.md" });
    expect(received[0]!.expect).toEqual({ pluginId: "acme.md", update: true });
  });

  it("restates the host's typed refusal with the host's name and keeps its details", async () => {
    localInventory.plugins = [entry("acme.md")];
    hostPlugins.installPluginFromAnotherMachine.mockRejectedValueOnce(
      pluginIncompatibleError(
        "acme.md",
        { kind: "untrusted" },
        "Markdown Preview 1.0.0 is blocked: bad."
      )
    );
    const error = await client
      .installOnHost({ hostId: HOST, pluginId: "acme.md" })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "PLUGIN_INCOMPATIBLE",
      details: { pluginId: "acme.md", hostId: HOST, reason: { kind: "untrusted" } },
      userMessage: "That plugin is blocked on studio-01 by the plugin blocklist.",
    });
  });

  it("names the host when an install fails there, in its own words rather than the host's", async () => {
    localInventory.plugins = [entry("acme.md")];
    hostPlugins.installPluginFromAnotherMachine.mockResolvedValueOnce({
      status: "failed",
      errors: [
        {
          code: "archive_invalid",
          message: "Failed to extract archive: EACCES /home/host/.daintree/plugins/.install-tmp-1",
        },
      ],
    });
    const error = (await client
      .installOnHost({ hostId: HOST, pluginId: "acme.md" })
      .catch((err: unknown) => err)) as { userMessage: string; message: string };
    expect(error.userMessage).toBe(
      "studio-01 couldn't read this machine's package of Markdown Preview."
    );
    expect(`${error.userMessage} ${error.message}`).not.toMatch(/\/home|EACCES/);
  });

  it("restates a host's own error text by its code", async () => {
    localInventory.plugins = [entry("acme.md")];
    hostPlugins.installPluginFromAnotherMachine.mockRejectedValueOnce(
      new AppError({
        code: "PERMISSION",
        message: "EACCES /home/host/secret",
        userMessage: "Couldn't write /home/host/secret",
      })
    );
    const error = (await client
      .installOnHost({ hostId: HOST, pluginId: "acme.md" })
      .catch((err: unknown) => err)) as { userMessage: string };
    expect(error.userMessage).toBe("Couldn't install the plugin on studio-01.");
  });

  it("installs a .dntr from this machine on the host and refuses anything else", async () => {
    const archive = path.join(dir, "graph.dntr");
    const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), packageBytes]);
    await fs.writeFile(archive, zipBytes);
    await expect(client.installLocalPackageOnHost(HOST, archive)).resolves.toEqual({
      status: "installed",
      pluginId: "acme.md",
    });
    expect(received[0]!.expect).toEqual({ update: false });

    const text = path.join(dir, "notes.txt");
    await fs.writeFile(text, "hello");
    const notZip = path.join(dir, "fake.dntr");
    await fs.writeFile(notZip, "hello");
    const folder = path.join(dir, "folder.dntr");
    await fs.mkdir(folder);
    for (const candidate of [text, notZip, folder, "relative.dntr"]) {
      await expect(client.installLocalPackageOnHost(HOST, candidate)).resolves.toMatchObject({
        status: "failed",
      });
    }
    expect(received).toHaveLength(1);
  });

  it("says the host isn't connected rather than failing silently", async () => {
    sessions.client.close("test");
    await expect(client.diff({ hostId: HOST })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
      userMessage: expect.stringContaining(HOST),
    });
  });
});

/** The client's session, with one method's answer lost on the way back. */
function losingAnswerTo(method: string, forward: boolean): ParitySession {
  const real = sessions.client;
  return {
    get isOpen() {
      return real.isOpen;
    },
    call(m, payload, options) {
      if (m !== method) return real.call(m, payload, options);
      if (forward) void real.call(m, payload, options).catch(() => undefined);
      return Promise.reject(
        new AppError({ code: "OUTCOME_UNKNOWN", message: "Link closed before the peer answered" })
      );
    },
  };
}

function clientWith(session: ParitySession, patch: object = {}): ClientPluginParity {
  return new ClientPluginParity({
    sessionFor: () => session,
    isKnownHost: (hostId) => hostId === HOST,
    hostLabel: () => HOST,
    local: {
      inventory: async () => localInventory,
      installedDir: async () => dir,
    },
    pack,
    tmpDir: dir,
    pollMs: 5,
    reconcileTimeoutMs: 2_000,
    ...patch,
  });
}

describe("an install whose answer was lost", () => {
  it("asks the host what happened and reports the install it finished", async () => {
    localInventory.plugins = [entry("acme.md")];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hostPlugins.installPluginFromAnotherMachine.mockImplementationOnce(async () => {
      await gate;
      return { status: "installed", pluginId: "acme.md" };
    });
    const lossy = clientWith(losingAnswerTo(PluginParityLinkMethod.STAGE_INSTALL, true));
    const install = lossy.installOnHost({ hostId: HOST, pluginId: "acme.md" });
    await vi.waitFor(() => expect(hostPlugins.installPluginFromAnotherMachine).toHaveBeenCalled());
    release();
    await expect(install).resolves.toBeUndefined();
    expect(hostPlugins.installPluginFromAnotherMachine).toHaveBeenCalledTimes(1);
  });

  it("says nothing was installed when the host never received it", async () => {
    localInventory.plugins = [entry("acme.md")];
    const lossy = clientWith(losingAnswerTo(PluginParityLinkMethod.STAGE_INSTALL, false));
    await expect(lossy.installOnHost({ hostId: HOST, pluginId: "acme.md" })).rejects.toMatchObject({
      userMessage: expect.stringContaining("Nothing was installed"),
    });
    expect(hostPlugins.installPluginFromAnotherMachine).not.toHaveBeenCalled();
  });

  it("keeps saying the outcome is unknown while the host can't be asked", async () => {
    localInventory.plugins = [entry("acme.md")];
    const real = sessions.client;
    let open = true;
    const flaky: ParitySession = {
      get isOpen() {
        return open && real.isOpen;
      },
      call(m, payload, options) {
        if (m !== PluginParityLinkMethod.STAGE_INSTALL) return real.call(m, payload, options);
        open = false;
        return Promise.reject(new AppError({ code: "OUTCOME_UNKNOWN", message: "dropped" }));
      },
    };
    const lossy = clientWith(flaky, { reconcileTimeoutMs: 30 });
    await expect(lossy.installOnHost({ hostId: HOST, pluginId: "acme.md" })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      userMessage: expect.stringContaining("Check its plugin list"),
    });
  });

  it("runs one install per operation id on the host and answers a repeat with its outcome", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stageAndInstall = async () => {
      const { token } = (await sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
        size: 3,
        sha256,
      })) as { token: string };
      await sessions.client.call(PluginParityLinkMethod.STAGE_CHUNK, { token, offset: 0, bytes });
      return sessions.client.call(PluginParityLinkMethod.STAGE_INSTALL, {
        token,
        update: false,
        opId: "op-1",
      });
    };
    await expect(stageAndInstall()).resolves.toEqual({ status: "installed", pluginId: "acme.md" });
    await expect(stageAndInstall()).resolves.toEqual({ status: "installed", pluginId: "acme.md" });
    expect(hostPlugins.installPluginFromAnotherMachine).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(stagingRoot)).toEqual([]);
    await expect(
      sessions.client.call(PluginParityLinkMethod.INSTALL_STATUS, { opId: "op-1" })
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { status: "installed", pluginId: "acme.md" },
    });
    await expect(
      sessions.client.call(PluginParityLinkMethod.INSTALL_STATUS, { opId: "op-2" })
    ).resolves.toEqual({ status: "unknown" });
  });
});

describe("a window's install job on the host", () => {
  const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  async function localArchive(): Promise<string> {
    const archive = path.join(dir, "graph.dntr");
    await fs.writeFile(
      archive,
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), packageBytes])
    );
    return archive;
  }

  it("hands the job to the host's installer and relays its phases", async () => {
    const phases: string[] = [];
    hostPlugins.installPluginFromAnotherMachine.mockImplementationOnce(
      async (_path: string, expect: { jobId?: string }) => {
        pluginInstallJobs.setPhase(expect.jobId, "extracting");
        await new Promise((resolve) => setTimeout(resolve, 60));
        pluginInstallJobs.setPhase(expect.jobId, "activating");
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: "installed", pluginId: "acme.md" };
      }
    );
    await expect(
      client.installLocalPackageOnHost(HOST, await localArchive(), {
        jobId: JOB,
        onPhase: (phase) => phases.push(phase),
      })
    ).resolves.toEqual({ status: "installed", pluginId: "acme.md" });
    expect(hostPlugins.installPluginFromAnotherMachine.mock.calls[0]![1]).toEqual({
      update: false,
      jobId: JOB,
    });
    expect(phases).toEqual(["extracting", "activating"]);
    // The job lives exactly as long as its slot.
    expect(pluginInstallJobs.size).toBe(0);
  });

  it("refuses a job id that is already running here", async () => {
    const begin = () =>
      sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
        size: 1,
        sha256: "0".repeat(64),
        jobId: JOB,
      });
    await begin();
    await expect(begin()).rejects.toBeTruthy();
    expect(await fs.readdir(stagingRoot)).toHaveLength(1);
  });

  it("stops the transfer and removes the staged package when the window cancels", async () => {
    const real = sessions.client;
    let chunks = 0;
    const cancelling: ParitySession = {
      get isOpen() {
        return real.isOpen;
      },
      async call(m, payload, options) {
        if (m === PluginParityLinkMethod.STAGE_CHUNK) chunks++;
        const answer = await real.call(m, payload, options);
        if (m === PluginParityLinkMethod.STAGE_CHUNK && chunks === 1) {
          // The window's Cancel, which it sends to the host.
          expect(pluginInstallJobs.cancel(JOB)).toBe(true);
        }
        return answer;
      },
    };
    await expect(
      clientWith(cancelling).installLocalPackageOnHost(HOST, await localArchive(), { jobId: JOB })
    ).resolves.toEqual({ status: "cancelled" });
    // The chunk after the Cancel was refused; the rest were never sent.
    expect(chunks).toBe(2);
    expect(hostPlugins.installPluginFromAnotherMachine).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await fs.readdir(stagingRoot)).toEqual([]));
    expect(pluginInstallJobs.size).toBe(0);
  });
});

describe("host staging", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  it("refuses a chunk out of order and discards the slot", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { token } = (await sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
      size: 4,
      sha256: sha(bytes),
    })) as { token: string };
    await expect(
      sessions.client.call(PluginParityLinkMethod.STAGE_CHUNK, {
        token,
        offset: 2,
        bytes: bytes.subarray(0, 2),
      })
    ).rejects.toBeTruthy();
    expect(await fs.readdir(stagingRoot)).toEqual([]);
    await expect(
      sessions.client.call(PluginParityLinkMethod.STAGE_INSTALL, { token, update: false })
    ).rejects.toBeTruthy();
  });

  it("never installs a package whose digest doesn't match what was announced", async () => {
    const { token } = (await sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
      size: 3,
      sha256: sha(new Uint8Array([9, 9, 9])),
    })) as { token: string };
    await sessions.client.call(PluginParityLinkMethod.STAGE_CHUNK, {
      token,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(
      sessions.client.call(PluginParityLinkMethod.STAGE_INSTALL, { token, update: false })
    ).rejects.toBeTruthy();
    expect(hostPlugins.installPluginFromAnotherMachine).not.toHaveBeenCalled();
    expect(await fs.readdir(stagingRoot)).toEqual([]);
  });

  it("keeps each staged package private and removes it when the session closes", async () => {
    await sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
      size: 10,
      sha256: "0".repeat(64),
    });
    const [slot] = await fs.readdir(stagingRoot);
    const slotDir = path.join(stagingRoot, slot!);
    expect((await fs.stat(slotDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(slotDir, "package.dntr"))).mode & 0o777).toBe(0o600);
    sessions.client.close("test");
    await vi.waitFor(async () => expect(await fs.readdir(stagingRoot)).toEqual([]));
  });
});

describe("host staging limits", () => {
  it("holds concurrent reservations to the per-session cap", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        sessions.client.call(PluginParityLinkMethod.STAGE_BEGIN, {
          size: 1,
          sha256: "0".repeat(64),
        })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(await fs.readdir(stagingRoot)).toHaveLength(4);
  });

  it("removes a slot nobody writes to", async () => {
    host.dispose();
    const idle = new HostPluginParity({
      plugins: async () => hostPlugins,
      stagingRoot,
      idleMs: 20,
    });
    const pair = await openSessionPair(dir);
    idle.attach(pair.host);
    await pair.client.call(PluginParityLinkMethod.STAGE_BEGIN, { size: 1, sha256: "0".repeat(64) });
    expect(await fs.readdir(stagingRoot)).toHaveLength(1);
    await vi.waitFor(async () => expect(await fs.readdir(stagingRoot)).toEqual([]));
    pair.host.close("test");
    pair.client.close("test");
  });
});

describe("switch notice", () => {
  it("is claimed once per switch of a window to a host", () => {
    expect(client.claimSwitchNotice(1, { hostId: HOST })).toBe(true);
    expect(client.claimSwitchNotice(1, { hostId: HOST })).toBe(false);
    expect(client.claimSwitchNotice(2, { hostId: HOST })).toBe(true);
  });
});
