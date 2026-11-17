import { describe, expect, it } from "vitest";
import type { CloudHostCreatedFor } from "../../../../shared/types/cloudHosts.js";
import {
  CloudHostStore,
  type CloudHostsValue,
  type StoredCloudBinding,
} from "../CloudHostStore.js";

/** A settings file: what goes in comes back out as JSON, and survives a new store over it. */
function disk() {
  let saved: unknown;
  return {
    get: () => saved,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      saved = JSON.parse(JSON.stringify(value));
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
    provisioning: null,
    creation: {
      operationId: "op",
      idempotencyKey: "key",
      sentAt: null,
      name: "build",
      machineType: "default",
    },
    lifetimeSeconds: 7200,
    intent: "run",
    observation: null,
    access: null,
    lastError: null,
    createdAt: 1,
    ...overrides,
  };
}

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
          observedAt: 5,
        },
      })
    );
    expect(new CloudHostStore(backend).bindings()[0]?.observation?.name).toBe("feature-login-box");
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
