import { describe, expect, it } from "vitest";
import type { CloudHostCreatedFor } from "../../../../shared/types/cloudHosts.js";
import {
  CloudHostStore,
  cloudMachineClaim,
  madeInSendWindow,
  readConsoleUrl,
  type CloudHostsStoreBackend,
  type CloudHostsValue,
  type StoredCloudBinding,
  type StoredCreateOrder,
} from "../CloudHostStore.js";

/** A settings file: what goes in comes back out as JSON, and survives a new store over it. */
function disk() {
  let saved: unknown;
  let orders: unknown;
  return {
    get: (key: "cloudHosts" | "cloudCreateOrders" = "cloudHosts") =>
      key === "cloudHosts" ? saved : orders,
    set: (key: "cloudHosts" | "cloudCreateOrders", value: unknown) => {
      if (key === "cloudHosts") saved = JSON.parse(JSON.stringify(value));
      else orders = JSON.parse(JSON.stringify(value));
    },
    write(value: unknown) {
      saved = JSON.parse(JSON.stringify(value));
    },
    raw: () => saved as { bindings: Record<string, unknown>[] },
  };
}

const LOCAL_MARK: CloudHostCreatedFor = {
  hostId: null,
  projectId: "0f1e2d3c",
  worktreeId: "/Users/me/code/app-worktrees/feature-login",
  projectName: "app",
  worktreeName: "feature/login",
  hostName: null,
};

function binding(overrides: Partial<StoredCloudBinding> = {}): StoredCloudBinding {
  return {
    id: "cb_abcdefgh12",
    hostId: "build",
    accountId: "ca_0123456789",
    providerId: "boat",
    resourceId: null,
    ownership: "created-by-daintree",
    createdFor: LOCAL_MARK,
    worktreeCleanup: null,
    provisioning: null,
    creation: {
      operationId: "op",
      idempotencyKey: "key",
      sentAt: null,
      lastSentAt: null,
      name: "build",
      machineType: "default",
    },
    lifetimeSeconds: 7200,
    intent: "run",
    observation: null,
    access: null,
    trustedHostKey: null,
    offeredHostKey: null,
    lastError: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("CloudHostStore MCP server ask (#18187)", () => {
  it("keeps the ask across a restart until it is taken, and then never reads it again", () => {
    const backend = disk();
    new CloudHostStore(backend).putBinding(binding({ mcpServerOnConnect: true }));
    const store = new CloudHostStore(backend);
    expect(store.binding("cb_abcdefgh12")?.mcpServerOnConnect).toBe(true);

    store.updateBinding("cb_abcdefgh12", ({ mcpServerOnConnect: _taken, ...rest }) => rest);
    const reopened = new CloudHostStore(backend).binding("cb_abcdefgh12");
    expect(reopened?.id).toBe("cb_abcdefgh12");
    expect(reopened).not.toHaveProperty("mcpServerOnConnect");
  });

  it("reads anything but a plain yes, and a binding from before it, as no ask", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [
        { ...binding({ id: "cb_abcdefgh13" }), mcpServerOnConnect: "true" },
        { ...binding({ id: "cb_abcdefgh14" }), mcpServerOnConnect: 1 },
        { ...binding({ id: "cb_abcdefgh16" }), mcpServerOnConnect: false },
        { ...binding({ id: "cb_abcdefgh17" }), mcpServerOnConnect: null },
        binding({ id: "cb_abcdefgh15" }),
      ],
    });
    const read = new CloudHostStore(backend).bindings();
    expect(read).toHaveLength(5);
    for (const entry of read) expect(entry).not.toHaveProperty("mcpServerOnConnect");
  });
});

describe("CloudHostStore worktree marks", () => {
  it("keeps a mark across a restart, before and after the machine exists", () => {
    const backend = disk();
    new CloudHostStore(backend).putBinding(binding());
    expect(new CloudHostStore(backend).bindings()[0]?.createdFor).toEqual(LOCAL_MARK);

    const remote: CloudHostCreatedFor = {
      ...LOCAL_MARK,
      hostId: "studio",
      hostName: "Studio",
    };
    new CloudHostStore(backend).updateBinding("cb_abcdefgh12", (current) => ({
      ...current,
      createdFor: remote,
      resourceId: "bx_23456789",
      creation: null,
    }));
    const reopened = new CloudHostStore(backend).binding("cb_abcdefgh12");
    expect(reopened?.creation).toBeNull();
    expect(reopened?.createdFor).toEqual(remote);
  });

  it("keeps the mark through unrelated writes", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putBinding(binding());
    store.updateBinding("cb_abcdefgh12", (current) => ({ ...current, intent: "stop" }));
    store.removeAccount("ca_9999999999");
    expect(new CloudHostStore(backend).binding("cb_abcdefgh12")?.createdFor).toEqual(LOCAL_MARK);
  });

  it("reads a binding saved before marks existed as unmarked", () => {
    const backend = disk();
    const { createdFor: _dropped, ...legacy } = binding();
    backend.write({ version: 1, accounts: [], bindings: [legacy] });
    const read = new CloudHostStore(backend).bindings();
    expect(read).toHaveLength(1);
    expect(read[0]?.createdFor).toBeNull();
  });

  it("drops a mark missing part of the worktree's identity, keeping the binding", () => {
    for (const broken of [
      { ...LOCAL_MARK, projectId: "" },
      { ...LOCAL_MARK, projectName: "" },
      { ...LOCAL_MARK, worktreeId: 42 },
      { ...LOCAL_MARK, hostId: undefined },
      { ...LOCAL_MARK, hostId: "local" },
      { ...LOCAL_MARK, worktreeName: null },
      "app",
    ]) {
      const backend = disk();
      backend.write({ version: 1, accounts: [], bindings: [{ ...binding(), createdFor: broken }] });
      const read = new CloudHostStore(backend).bindings();
      expect(read.map((entry) => entry.id)).toEqual(["cb_abcdefgh12"]);
      expect(read[0]?.createdFor).toBeNull();
    }
  });

  it("never reads a mark on an imported machine", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [{ ...binding({ ownership: "imported", creation: null }), createdFor: LOCAL_MARK }],
    });
    expect(new CloudHostStore(backend).bindings()[0]?.createdFor).toBeNull();
  });

  it("keeps the machine's reported name with its observation", () => {
    const backend = disk();
    new CloudHostStore(backend).putBinding(
      binding({
        observation: {
          machine: "running",
          name: "feature-login-box",
          rawState: "ready",
          machineType: "default",
          vcpu: 4,
          memoryGB: 8,
          autoStopAt: null,
          lifetimeSeconds: 7200,
          stoppedAt: null,
          stop: null,
          lastSnapshotAt: null,
          dataExpired: false,
          asleep: false,
          idleSleep: null,
          snapshotsDisabled: false,
          observedAt: 5,
        },
      })
    );
    expect(new CloudHostStore(backend).bindings()[0]?.observation?.name).toBe("feature-login-box");
  });

  it("keeps whether the provider slept the machine, and its own idle sleep (#17347)", () => {
    const backend = disk();
    const observation = {
      machine: "stopped",
      name: "build",
      rawState: "sleeping",
      machineType: "2x4",
      vcpu: 2,
      memoryGB: 4,
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      asleep: true,
      idleSleep: { enabled: true, idleSeconds: 600 },
      snapshotsDisabled: false,
      observedAt: 5,
    };
    new CloudHostStore(backend).putBinding(binding({ observation }));
    expect(new CloudHostStore(backend).bindings()[0]?.observation).toMatchObject({
      asleep: true,
      idleSleep: { enabled: true, idleSeconds: 600 },
    });
    // A record from before either existed reads as awake, with nothing reported.
    const { asleep: _asleep, idleSleep: _idleSleep, ...older } = observation;
    backend.write({
      version: 1,
      accounts: [],
      bindings: [binding({ observation: older as never })],
    });
    expect(new CloudHostStore(backend).bindings()[0]?.observation).toMatchObject({
      asleep: false,
      idleSleep: null,
    });
    // Sleep turned off reads as off; an idle time that isn't one reads as unreported.
    backend.write({
      version: 1,
      accounts: [],
      bindings: [
        binding({
          observation: { ...observation, idleSleep: { enabled: false, idleSeconds: -5 } } as never,
        }),
      ],
    });
    expect(new CloudHostStore(backend).bindings()[0]?.observation?.idleSleep).toEqual({
      enabled: false,
      idleSeconds: null,
    });
  });

  it("keeps whether snapshots are off on the machine, and reads a record from before it as unknown (#17923)", () => {
    const backend = disk();
    const observation = {
      machine: "running",
      name: "build",
      rawState: "running",
      machineType: "2x4",
      vcpu: 2,
      memoryGB: 4,
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      asleep: false,
      idleSleep: null,
      snapshotsDisabled: true,
      observedAt: 5,
    };
    new CloudHostStore(backend).putBinding(binding({ observation }));
    expect(new CloudHostStore(backend).bindings()[0]?.observation?.snapshotsDisabled).toBe(true);
    const { snapshotsDisabled: _snapshots, ...older } = observation;
    for (const [stored, read] of [
      [older, null],
      [{ ...older, snapshotsDisabled: "yes" }, null],
      [{ ...older, snapshotsDisabled: false }, false],
    ] as const) {
      backend.write({
        version: 1,
        accounts: [],
        bindings: [binding({ observation: stored as never })],
      });
      expect(new CloudHostStore(backend).bindings()[0]?.observation?.snapshotsDisabled).toBe(read);
    }
  });
});

describe("CloudHostStore worktree cleanup (#17360)", () => {
  const CLEANUP = {
    attemptId: "attempt-1",
    mutationId: "mutation-1",
    choice: "delete" as const,
    resourceId: "bx_23456789",
    worktree: { hostId: null, projectId: LOCAL_MARK.projectId, worktreeId: LOCAL_MARK.worktreeId },
    phase: "waiting" as const,
    error: null,
    requestedAt: 5,
  };
  const exists = { resourceId: "bx_23456789", creation: null };

  it("keeps a choice across a restart, with a failure's error", () => {
    const backend = disk();
    new CloudHostStore(backend).putBinding(binding({ ...exists, worktreeCleanup: CLEANUP }));
    expect(new CloudHostStore(backend).bindings()[0]?.worktreeCleanup).toEqual(CLEANUP);

    const failed = {
      ...CLEANUP,
      phase: "failed" as const,
      error: { code: "failed" as const, message: "Upstream exploded", at: 9 },
    };
    new CloudHostStore(backend).updateBinding("cb_abcdefgh12", (current) => ({
      ...current,
      worktreeCleanup: failed,
    }));
    expect(new CloudHostStore(backend).bindings()[0]?.worktreeCleanup).toEqual(failed);
  });

  it("reads a binding saved before choices existed as having none", () => {
    const backend = disk();
    const { worktreeCleanup: _dropped, ...older } = binding(exists);
    backend.write({ version: 1, accounts: [], bindings: [older] });
    expect(new CloudHostStore(backend).bindings()[0]?.worktreeCleanup).toBeNull();
  });

  it("never reads a choice for another machine, another worktree, or a machine without the mark", () => {
    const cases: Array<Partial<StoredCloudBinding>> = [
      { ...exists, resourceId: "bx_99999999", worktreeCleanup: CLEANUP },
      { ...exists, resourceId: null, worktreeCleanup: CLEANUP },
      {
        ...exists,
        worktreeCleanup: {
          ...CLEANUP,
          worktree: { ...CLEANUP.worktree, worktreeId: "/elsewhere" },
        },
      },
      {
        ...exists,
        worktreeCleanup: { ...CLEANUP, worktree: { ...CLEANUP.worktree, hostId: "studio" } },
      },
      {
        ...exists,
        worktreeCleanup: { ...CLEANUP, worktree: { ...CLEANUP.worktree, projectId: "aaaaaaaa" } },
      },
      { ...exists, worktreeCleanup: { ...CLEANUP, attemptId: "" } },
      { ...exists, createdFor: null, worktreeCleanup: CLEANUP },
      { ...exists, ownership: "imported", worktreeCleanup: CLEANUP },
      { ...exists, worktreeCleanup: { ...CLEANUP, choice: "keep" as never } },
      { ...exists, worktreeCleanup: { ...CLEANUP, phase: "done" as never } },
    ];
    for (const overrides of cases) {
      const backend = disk();
      backend.write({ version: 1, accounts: [], bindings: [binding(overrides)] });
      const read = new CloudHostStore(backend).bindings()[0];
      expect(read?.id).toBe("cb_abcdefgh12");
      expect(read?.worktreeCleanup).toBeNull();
    }
  });
});

describe("CloudHostStore provisioning", () => {
  const PICKS = {
    location: { label: "Region", id: "eu-west-1", value: "Europe (Ireland)" },
    image: { label: "AMI", id: "ami-euw1", value: "Ubuntu 24.04" },
    network: { label: "Subnet", id: null, value: "Chosen by Acme" },
  };

  it("keeps what a create named after the machine exists, through unrelated writes", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putBinding(binding({ provisioning: PICKS }));
    store.updateBinding("cb_abcdefgh12", (current) => ({
      ...current,
      resourceId: "i-0123",
      creation: null,
    }));
    store.removeAccount("ca_9999999999");
    expect(new CloudHostStore(backend).binding("cb_abcdefgh12")?.provisioning).toEqual(PICKS);
  });

  it("reads a binding saved before provisioning existed as naming nothing", () => {
    const backend = disk();
    const { provisioning: _dropped, ...legacy } = binding();
    backend.write({ version: 1, accounts: [], bindings: [legacy] });
    expect(new CloudHostStore(backend).bindings()[0]?.provisioning).toBeNull();
  });

  it("reads a choice it can't make sense of as unreadable, never as the provider's defaults", () => {
    for (const broken of [
      "eu-west-1",
      { ...PICKS, location: { label: "Region", id: 5, value: "Europe" } },
      { ...PICKS, image: { label: "", id: "ami-euw1", value: "Ubuntu" } },
      { ...PICKS, network: "subnet-a" },
      { location: PICKS.location, image: PICKS.image },
      [PICKS.location, PICKS.image, PICKS.network],
    ]) {
      const backend = disk();
      backend.write({
        version: 1,
        accounts: [],
        bindings: [{ ...binding(), provisioning: broken }],
      });
      const read = new CloudHostStore(backend).bindings();
      expect(read.map((entry) => entry.id)).toEqual(["cb_abcdefgh12"]);
      expect(read[0]?.provisioning).toBe("unreadable");
    }
  });

  it("never reads a choice on an imported machine", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [{ ...binding({ ownership: "imported", creation: null }), provisioning: PICKS }],
    });
    expect(new CloudHostStore(backend).bindings()[0]?.provisioning).toBeNull();
  });

  it("remembers an account's last choice whole, or not at all", () => {
    const account = {
      id: "ca_0123456789",
      providerId: "acme.clouds.ec2",
      displayName: "Acme",
      identity: null,
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://api.acme.test",
      keyHint: null,
      addedAt: 1,
      validation: { status: "valid", checkedAt: 1 },
    };
    const last = { location: "eu-west-1", image: "ami-euw1", network: null };
    const read = (lastProvisioning: unknown) => {
      const backend = disk();
      backend.write({ version: 1, accounts: [{ ...account, lastProvisioning }], bindings: [] });
      return new CloudHostStore(backend).accounts()[0]?.lastProvisioning;
    };
    expect(read(last)).toEqual(last);
    expect(read(undefined)).toBeNull();
    expect(read({ ...last, image: 7 })).toBeNull();
    expect(read({ location: "eu-west-1" })).toBeNull();
  });
});

describe("CloudHostStore accounts", () => {
  const account = {
    id: "ca_0123456789",
    providerId: "boat",
    displayName: "Personal",
    identity: "octocat",
    scope: { kind: "personal" as const, id: "personal", name: "Personal" },
    apiUrl: "https://boat.dev/api/v1",
    keyHint: "abcd",
    addedAt: 1,
    validation: { status: "valid" as const, checkedAt: 1 },
  };

  it("keeps the credential revision across a restart and unrelated writes", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putAccount({
      ...account,
      credentialRevision: "0011223344556677",
      lastProvisioning: null,
      pluginProvider: null,
    });
    store.putBinding(binding({ accountId: account.id }));
    store.removeBinding("cb_abcdefgh12");
    expect(new CloudHostStore(backend).account(account.id)?.credentialRevision).toBe(
      "0011223344556677"
    );
  });

  it("keeps an account that bills a cloud project across a restart", () => {
    const backend = disk();
    const project = {
      ...account,
      providerId: "gce",
      scope: { kind: "project" as const, id: "daintree-build", name: "daintree-build" },
      apiUrl: "https://compute.googleapis.com/compute/v1",
      credentialRevision: "0011223344556677",
      lastProvisioning: null,
      pluginProvider: null,
    };
    new CloudHostStore(backend).putAccount(project);
    expect(new CloudHostStore(backend).account(account.id)?.scope).toEqual(project.scope);
  });

  it("keeps an AWS account's scope across a restart", () => {
    const backend = disk();
    const aws = {
      ...account,
      id: "ca_aws0000001",
      providerId: "aws",
      scope: { kind: "account" as const, id: "123456789012", name: "AWS account 123456789012" },
      apiUrl: "https://amazonaws.com",
    };
    new CloudHostStore(backend).putAccount({
      ...aws,
      credentialRevision: null,
      lastProvisioning: null,
      pluginProvider: null,
    });
    expect(new CloudHostStore(backend).account(aws.id)?.scope).toEqual(aws.scope);
  });

  it("reads an account saved before revisions existed as having none", () => {
    const backend = disk();
    backend.write({ version: 1, accounts: [account], bindings: [] });
    expect(new CloudHostStore(backend).account(account.id)).toMatchObject({
      keyHint: "abcd",
      credentialRevision: null,
      pluginProvider: null,
    });
  });

  it("keeps what a plugin's provider was called across a restart, as one plain line each (#17353)", () => {
    const backend = disk();
    const plugin = {
      ...account,
      providerId: "acme.clouds.ec2",
      credentialRevision: null,
      lastProvisioning: null,
      pluginProvider: {
        pluginName: "Acme\u202e Clouds\n",
        providerName: "EC2",
        dashboardUrl: "https://console.example.com/ec2",
      },
    };
    new CloudHostStore(backend).putAccount(plugin);
    expect(new CloudHostStore(backend).account(account.id)?.pluginProvider).toEqual({
      pluginName: "Acme Clouds",
      providerName: "EC2",
      dashboardUrl: "https://console.example.com/ec2",
    });
  });

  it("cuts a long name short rather than losing the label and its console link", () => {
    const backend = disk();
    new CloudHostStore(backend).putAccount({
      ...account,
      providerId: "acme.clouds.ec2",
      credentialRevision: null,
      lastProvisioning: null,
      pluginProvider: {
        // Outside the BMP: cut by code point, never through a surrogate pair.
        pluginName: "😀".repeat(200),
        providerName: "EC2",
        dashboardUrl: "https://console.example.com/ec2",
      },
    });
    const label = new CloudHostStore(backend).account(account.id)?.pluginProvider;
    expect(label!.pluginName).toBe(`${"😀".repeat(127)}…`);
    expect(label!.dashboardUrl).toBe("https://console.example.com/ec2");
  });

  it("drops a kept console link that isn't a public https URL, and a label missing a name", () => {
    const backend = disk();
    const label = (id: string, overrides: Record<string, unknown>) => ({
      ...account,
      id,
      providerId: "acme.clouds.ec2",
      pluginProvider: { pluginName: "Acme Clouds", providerName: "EC2", ...overrides },
    });
    backend.write({
      version: 1,
      accounts: [
        label("ca_link000001", { dashboardUrl: "javascript:alert(1)" }),
        label("ca_link000002", { dashboardUrl: "https://user:pw@console.example.com" }),
        label("ca_link000003", { providerName: "  " }),
      ],
      bindings: [],
    });
    const store = new CloudHostStore(backend);
    expect(store.account("ca_link000001")?.pluginProvider).toEqual({
      pluginName: "Acme Clouds",
      providerName: "EC2",
      dashboardUrl: null,
    });
    expect(store.account("ca_link000002")?.pluginProvider?.dashboardUrl).toBeNull();
    expect(store.account("ca_link000003")?.pluginProvider).toBeNull();
  });

  it("opens only a public https link with a dotted host", () => {
    expect(readConsoleUrl("https://console.example.com/ec2")).toBe(
      "https://console.example.com/ec2"
    );
    for (const value of [
      "http://console.example.com",
      "https://intranet/console",
      "https://*.example.com",
      "file:///etc/passwd",
      `https://example.com/${"a".repeat(2048)}`,
      "https://127.0.0.1/console",
      "https://10.0.0.5/console",
      "https://192.168.1.20/console",
      "https://[::1]/console",
      "https://169.254.169.254/latest",
      42,
    ]) {
      expect(readConsoleUrl(value)).toBeNull();
    }
  });
});

describe("CloudHostStore host keys", () => {
  const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
  const OTHER = `ssh-ed25519 ${Buffer.alloc(51, 7).toString("base64")}`;

  it("keeps a trusted key and an offered one across a restart", () => {
    const backend = disk();
    new CloudHostStore(backend).putBinding(
      binding({ trustedHostKey: { key: KEY, at: 5 }, offeredHostKey: { key: OTHER, at: 9 } })
    );
    const read = new CloudHostStore(backend).bindings()[0]!;
    expect(read.trustedHostKey).toEqual({ key: KEY, at: 5 });
    expect(read.offeredHostKey).toEqual({ key: OTHER, at: 9 });
  });

  it("reads a binding saved before host keys were confirmed as trusting none", () => {
    const backend = disk();
    const { trustedHostKey: _t, offeredHostKey: _o, ...legacy } = binding();
    backend.write({ version: 1, accounts: [], bindings: [legacy] });
    const read = new CloudHostStore(backend).bindings()[0]!;
    expect(read.trustedHostKey).toBeNull();
    expect(read.offeredHostKey).toBeNull();
  });

  it("drops a hand-edited key that isn't one, keeping the binding", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [
        {
          ...binding(),
          trustedHostKey: { key: "ssh-ed25519 AAAA", at: 1 },
          offeredHostKey: "ssh-ed25519",
        },
      ],
    });
    const read = new CloudHostStore(backend).bindings()[0]!;
    expect(read.id).toBe("cb_abcdefgh12");
    expect(read.trustedHostKey).toBeNull();
    expect(read.offeredHostKey).toBeNull();
  });
});

describe("CloudHostStore keep-awake (#17918)", () => {
  const RESOURCE = "ab12cd34ef";

  it("keeps what the host said it holds across a restart, for the machine it was said of", () => {
    const backend = disk();
    const held = {
      resourceId: RESOURCE,
      expiresAt: 1_800_604_800_000,
      confirmedAt: 1_800_000_000_000,
      reached: true as const,
    };
    new CloudHostStore(backend).putBinding(binding({ resourceId: RESOURCE, keepAwake: held }));
    expect(new CloudHostStore(backend).bindings()[0]!.keepAwake).toEqual(held);
    // Not yet reached reads back as such, and anything but true is not reached.
    const { reached: _reached, ...untried } = held;
    for (const reached of [undefined, "yes", "true", 1]) {
      backend.write({
        version: 1,
        accounts: [],
        bindings: [{ ...binding({ resourceId: RESOURCE }), keepAwake: { ...untried, reached } }],
      });
      expect(new CloudHostStore(backend).bindings()[0]!.keepAwake).toEqual(untried);
    }

    // Said of another machine, or unreadable: as if nothing were held.
    for (const keepAwake of [
      { ...held, resourceId: "zz12cd34ef" },
      { ...held, expiresAt: "soon" },
      { ...held, confirmedAt: "then" },
      "held",
    ]) {
      backend.write({
        version: 1,
        accounts: [],
        bindings: [{ ...binding({ resourceId: RESOURCE }), keepAwake }],
      });
      const read = new CloudHostStore(backend).bindings()[0]!;
      expect(read.keepAwake).toBeUndefined();
      expect(read.resourceId).toBe(RESOURCE);
    }
  });
});

describe("CloudHostStore SSH access", () => {
  const PINNED = {
    user: "user",
    host: "203.0.113.10",
    port: 22001,
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    obtainedAt: 5,
  };

  it("keeps a pinned key and a tunnel's explicit no-key across a restart", () => {
    for (const access of [PINNED, { ...PINNED, hostKey: null }]) {
      const backend = disk();
      new CloudHostStore(backend).putBinding(binding({ access }));
      expect(new CloudHostStore(backend).binding("cb_abcdefgh12")?.access).toEqual(access);
    }
  });

  it("never reads a missing or empty key as one the tunnel vouched for", () => {
    const { hostKey: _dropped, ...keyless } = PINNED;
    for (const access of [keyless, { ...PINNED, hostKey: "" }, { ...PINNED, hostKey: 42 }]) {
      const backend = disk();
      backend.write({ version: 1, accounts: [], bindings: [{ ...binding(), access }] });
      expect(new CloudHostStore(backend).binding("cb_abcdefgh12")?.access).toBeNull();
    }
  });
});

describe("CloudHostStore machine keys (#17361)", () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    id: "mk_1",
    bindingId: "cb_abcdefgh12",
    accountId: "ca_abcdefgh",
    providerId: "boat" as const,
    resourceId: "bx_23456789",
    name: "daintree-mk_1",
    keyId: "sak_1",
    expiresAt: 1_800_000_000_000,
    state: "active" as const,
    createdAt: 1_700_000_000_000,
    ...overrides,
  });

  it("keeps what a key needs to be revoked across a restart, and a file from before them reads as none", () => {
    const backend = disk();
    backend.write({ version: 1, accounts: [], bindings: [binding()] });
    expect(new CloudHostStore(backend).machineKeys()).toEqual([]);
    new CloudHostStore(backend).putMachineKey(key());
    expect(new CloudHostStore(backend).machineKeys()).toEqual([key()]);
    // Unrelated writes carry it through.
    new CloudHostStore(backend).updateBinding("cb_abcdefgh12", (current) => ({
      ...current,
      intent: "stop",
    }));
    expect(new CloudHostStore(backend).machineKey("mk_1")).toEqual(key());
  });

  it("marks every key a removed binding's machine was given for revoking, in the same write", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putBinding(binding());
    store.putMachineKey(key());
    store.putMachineKey(key({ id: "mk_2", state: "issuing", keyId: null }));
    store.putMachineKey(key({ id: "mk_3", bindingId: "cb_otherother1" }));
    let writes = 0;
    store.onChange(() => (writes += 1));
    store.removeBinding("cb_abcdefgh12");
    expect(writes).toBe(1);
    expect(store.bindings()).toEqual([]);
    expect(store.machineKeys().map((entry) => [entry.id, entry.state])).toEqual([
      ["mk_1", "revoke"],
      ["mk_2", "revoke"],
      ["mk_3", "active"],
    ]);
  });

  it("tells its listeners when settings were read from disk again, with nothing written", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    let changes = 0;
    store.onChange(() => (changes += 1));
    backend.write({
      version: 1,
      accounts: [],
      bindings: [],
      machineKeys: [key({ state: "revoke" })],
    });
    store.reloaded();
    expect(changes).toBe(1);
    expect(store.machineKeys().map((entry) => entry.state)).toEqual(["revoke"]);
  });

  it("skips a record that doesn't read, and keeps it on disk", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [],
      machineKeys: [key({ state: "someday" }), key({ id: "mk_2" })],
    });
    const store = new CloudHostStore(backend);
    expect(store.machineKeys().map((entry) => entry.id)).toEqual(["mk_2"]);
    store.removeMachineKey("mk_2");
    expect((backend.raw() as unknown as { machineKeys: unknown[] }).machineKeys).toHaveLength(1);
  });
});

describe("CloudHostStore plugin provider consents", () => {
  const consent = { pluginId: "acme.clouds", fingerprint: "fp-1", approvedAt: 5 };

  it("keeps one per plugin through every other write, and across a new store over the file", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putProviderConsent(consent);
    store.putBinding(binding());
    expect(new CloudHostStore(backend).providerConsent("acme.clouds")).toEqual(consent);
    store.removeBinding("cb_abcdefgh12");
    expect(new CloudHostStore(backend).providerConsent("acme.clouds")).toEqual(consent);
    store.putProviderConsent({ ...consent, fingerprint: "fp-2" });
    const reopened = new CloudHostStore(backend);
    expect(reopened.providerConsent("acme.clouds")).toEqual({ ...consent, fingerprint: "fp-2" });
    expect(
      (backend.raw() as unknown as { providerConsents: unknown[] }).providerConsents
    ).toHaveLength(1);
  });

  it("reads one that doesn't name a plugin and a fingerprint as none, and leaves the value alone without one", () => {
    const backend = disk();
    backend.write({
      version: 1,
      accounts: [],
      bindings: [],
      providerConsents: [{ pluginId: "acme.clouds" }, { fingerprint: "fp-1" }, null],
    });
    const store = new CloudHostStore(backend);
    expect(store.providerConsent("acme.clouds")).toBeNull();

    const empty = disk();
    new CloudHostStore(empty).putBinding(binding());
    expect(Object.keys(empty.raw())).not.toContain("providerConsents");
  });

  it("forgets one plugin's consent only, and writes nothing when it had none", () => {
    const backend = disk();
    const store = new CloudHostStore(backend);
    store.putProviderConsent(consent);
    store.putProviderConsent({ ...consent, pluginId: "other.clouds" });
    store.removeProviderConsent("acme.clouds");
    expect(store.providerConsent("acme.clouds")).toBeNull();
    expect(store.providerConsent("other.clouds")).not.toBeNull();
    let writes = 0;
    const counting = new CloudHostStore({
      get: backend.get,
      set: (key, value) => {
        writes += 1;
        backend.set(key, value);
      },
    });
    counting.removeProviderConsent("acme.clouds");
    expect(writes).toBe(0);
  });
});

describe("CloudHostStore machine claims (#17927)", () => {
  const SENT = Date.parse("2026-11-17T10:00:00.000Z");
  const at = (minutes: number) => new Date(SENT + minutes * 60_000).toISOString();
  const pending = binding({ creation: { ...binding().creation!, sentAt: SENT, lastSentAt: SENT } });
  const labels = { "daintree-binding": pending.id };

  it("places a machine in a send's window by its create time, inclusively", () => {
    expect(madeInSendWindow(SENT, at(-5))).toBe(true);
    expect(madeInSendWindow(SENT, at(15))).toBe(true);
    expect(madeInSendWindow(SENT, at(-5.01))).toBe(false);
    expect(madeInSendWindow(SENT, at(15.01))).toBe(false);
    expect(madeInSendWindow(SENT, null)).toBeNull();
    expect(madeInSendWindow(SENT, "not a time")).toBeNull();
    expect(madeInSendWindow(null, at(0))).toBe(false);
  });

  it("reserves a machine any send may have made, from the first send's window to the latest's", () => {
    const replayed = binding({
      creation: { ...binding().creation!, sentAt: SENT, lastSentAt: SENT + 60 * 60_000 },
    });
    const claim = (minutes: number) =>
      cloudMachineClaim([replayed], "boat", {
        resourceId: "bx_late00001",
        labels: { "daintree-binding": replayed.id },
        createdAt: at(minutes),
      });
    expect(claim(61)).toEqual({ binding: replayed, pending: true });
    expect(claim(1)).toEqual({ binding: replayed, pending: true });
    expect(claim(30)).toEqual({ binding: replayed, pending: true });
    expect(claim(-6)).toBeNull();
    expect(claim(76)).toBeNull();
    const setBack = {
      ...replayed,
      creation: { ...replayed.creation!, lastSentAt: SENT - 60 * 60_000 },
    };
    expect(
      cloudMachineClaim([setBack], "boat", {
        resourceId: "bx_late00001",
        labels: { "daintree-binding": replayed.id },
        createdAt: at(-59),
      })
    ).toEqual({ binding: setBack, pending: true });
  });

  it("gives a labelled machine to the pending create that may have made it, and a copy made later to nobody", () => {
    expect(
      cloudMachineClaim([pending], "boat", { resourceId: "bx_orig00001", labels, createdAt: at(1) })
    ).toEqual({ binding: pending, pending: true });
    expect(
      cloudMachineClaim([pending], "boat", { resourceId: "bx_orig00001", labels, createdAt: null })
    ).toEqual({ binding: pending, pending: true });
    expect(
      cloudMachineClaim([pending], "boat", {
        resourceId: "bx_fork00001",
        labels,
        createdAt: at(120),
      })
    ).toBeNull();
    expect(
      cloudMachineClaim([pending], "boat", {
        resourceId: "bx_orig00001",
        labels: { "daintree-binding": "cb_someone0001" },
        createdAt: at(1),
      })
    ).toBeNull();
  });

  it("lets the binding that holds a machine win over a pending label, and ignores other providers and the asker", () => {
    const holder = binding({ id: "cb_holder0001", hostId: "other", resourceId: "bx_orig00001" });
    const machine = { resourceId: "bx_orig00001", labels, createdAt: at(1) };
    expect(cloudMachineClaim([pending, holder], "boat", machine)).toEqual({
      binding: holder,
      pending: false,
    });
    expect(cloudMachineClaim([pending, holder], "boat", machine, holder.id)).toEqual({
      binding: pending,
      pending: true,
    });
    expect(cloudMachineClaim([pending, holder], "agent37", machine)).toBeNull();
  });

  it("gives no claim to a create that was never sent or already holds another machine", () => {
    const machine = { resourceId: "bx_orig00001", labels, createdAt: at(1) };
    expect(cloudMachineClaim([binding()], "boat", machine)).toBeNull();
    expect(
      cloudMachineClaim([{ ...pending, resourceId: "bx_other0001" }], "boat", machine)
    ).toBeNull();
  });
});

describe("CloudHostStore lease rates (#18233)", () => {
  const RESOURCE = "dseq-41";

  it("keeps a machine's lease rate across a restart, a free lease's too", () => {
    const backend = disk();
    for (const hourlyDollars of [0.37, 0]) {
      new CloudHostStore(backend).putBinding(
        binding({ resourceId: RESOURCE, leaseRate: { resourceId: RESOURCE, hourlyDollars } })
      );
      expect(new CloudHostStore(backend).bindings()[0]!.leaseRate).toEqual({
        resourceId: RESOURCE,
        hourlyDollars,
      });
    }
  });

  it("reads a rate said of another machine, or one that isn't a rate, as none", () => {
    const backend = disk();
    for (const [resourceId, leaseRate] of [
      [RESOURCE, { resourceId: "dseq-99", hourlyDollars: 0.37 }],
      [null, { resourceId: RESOURCE, hourlyDollars: 0.37 }],
      [RESOURCE, { resourceId: RESOURCE, hourlyDollars: -0.1 }],
      [RESOURCE, { resourceId: RESOURCE, hourlyDollars: "0.37" }],
      [RESOURCE, { resourceId: RESOURCE, hourlyDollars: null }],
      [RESOURCE, 0.37],
    ] as const) {
      backend.write({
        version: 1,
        accounts: [],
        bindings: [{ ...binding({ resourceId }), leaseRate }],
      });
      const read = new CloudHostStore(backend).bindings()[0]!;
      expect(read.leaseRate).toBeUndefined();
      expect(read.resourceId).toBe(resourceId);
    }
  });
});

describe("CloudHostStore create orders (#18230)", () => {
  /** A settings file holding each key on its own, as the app's store does. */
  function keyedDisk() {
    const saved = new Map<string, unknown>();
    return {
      get: (key: string) => saved.get(key),
      set: (key: string, value: unknown) => {
        saved.set(key, JSON.parse(JSON.stringify(value)));
      },
      saved,
    } as CloudHostsStoreBackend & { saved: Map<string, unknown> };
  }

  function order(overrides: Partial<StoredCreateOrder> = {}): StoredCreateOrder {
    return {
      id: "co_1",
      bindingId: "cb_abcdefgh12",
      accountId: "ca_0123456789",
      providerId: "boat",
      labels: { daintree: "1", "daintree-binding": "cb_abcdefgh12" },
      idempotencyKey: "key-1",
      state: "open",
      orderIds: ["dseq-1"],
      placedAt: 1_000,
      waitingSince: 1_500,
      offerId: null,
      ...overrides,
    };
  }

  it("keeps an order across a restart, apart from the hosts", () => {
    const backend = keyedDisk();
    new CloudHostStore(backend).putCreateOrder(order());
    new CloudHostStore(backend).putCreateOrder(order({ state: "leasing", offerId: "bid-7" }));
    expect(new CloudHostStore(backend).createOrders()).toEqual([
      order({ state: "leasing", offerId: "bid-7" }),
    ]);
    expect(backend.saved.has("cloudHosts")).toBe(false);
  });

  it("writes no order key for a store that never had one", () => {
    const backend = keyedDisk();
    const store = new CloudHostStore(backend);
    store.putBinding(binding());
    store.removeBinding("cb_abcdefgh12");
    expect(backend.saved.has("cloudCreateOrders")).toBe(false);
  });

  it("marks a removed host's orders for closing, and keeps them, before the host goes", () => {
    const backend = keyedDisk();
    const store = new CloudHostStore(backend);
    store.putBinding(binding());
    store.putCreateOrder(order({ state: "leasing", offerId: "bid-7" }));
    store.putCreateOrder(order({ id: "co_2", bindingId: "cb_other00001" }));
    store.putCreateOrder(order({ id: "co_3", state: "placing", orderIds: null }));
    const writes: string[] = [];
    const set = backend.set.bind(backend);
    backend.set = ((key: "cloudHosts", value: CloudHostsValue) => {
      writes.push(key);
      set(key, value);
    }) as CloudHostsStoreBackend["set"];
    store.removeBinding("cb_abcdefgh12");
    expect(writes).toEqual(["cloudCreateOrders", "cloudHosts"]);
    expect(store.bindings()).toEqual([]);
    expect(store.createOrders().map((entry) => [entry.id, entry.state, entry.offerId])).toEqual([
      ["co_1", "close", null],
      ["co_2", "open", null],
      ["co_3", "close", null],
    ]);
    // A placement whose answer is unknown is still looked for by its key once it closes, and
    // one whose order is known keeps it to close.
    expect(store.createOrder("co_3")?.orderIds).toBeNull();
    expect(store.createOrder("co_1")?.orderIds).toEqual(["dseq-1"]);
  });

  it("never acts on an order that doesn't read, and keeps it on disk through every write", () => {
    const backend = keyedDisk();
    backend.set("cloudCreateOrders", [
      order({ id: "co_bad", state: "open", orderIds: null }),
      { ...order({ id: "co_odd" }), state: "someday" },
      order({ id: "co_lease", state: "leasing", offerId: null }),
      order(),
    ] as StoredCreateOrder[]);
    const store = new CloudHostStore(backend);
    expect(store.createOrders().map((entry) => entry.id)).toEqual(["co_1"]);
    expect(store.unreadableOrdersFor("ca_0123456789")).toBe(3);
    store.updateCreateOrder("co_1", (current) => ({ ...current, state: "close" }));
    expect(store.createOrder("co_1")?.state).toBe("close");
    store.removeCreateOrder("co_1");
    expect(backend.saved.get("cloudCreateOrders")).toHaveLength(3);
  });

  it("reads a placement whose answer is unknown, and keeps an offer only while leasing or closing", () => {
    const backend = keyedDisk();
    backend.set("cloudCreateOrders", [
      order({ state: "placing", orderIds: null, waitingSince: null, offerId: "bid-0" }),
      // Closing after its lease went out: the close checks a lease it finds against the offer.
      order({ id: "co_2", state: "close", orderIds: null, offerId: "bid-1" }),
      order({ id: "co_3", offerId: "bid-2" }),
    ]);
    expect(new CloudHostStore(backend).createOrders()).toEqual([
      order({ state: "placing", orderIds: null, waitingSince: null, offerId: null }),
      order({ id: "co_2", state: "close", orderIds: null, offerId: "bid-1" }),
      order({ id: "co_3", offerId: null }),
    ]);
  });
});
