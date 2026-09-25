import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
}));

import type { ProjectAcrossHostsService } from "../../../services/projectAcrossHosts/index.js";
import { BundleStore } from "../../../services/projectAcrossHosts/bundles.js";
import type { LinkSession } from "../../link/session.js";
import { bytesTransferSource } from "../../link/transfer.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { attachProjectsHost } from "../../projects/hostInstall.js";
import { BUNDLE_SINK_PREFIX } from "../../projects/linkMethods.js";
import { ClientUploadTransport } from "../ClientUploadTransport.js";
import type { HostFileEndpoint } from "../HostFileService.js";
import { HostInbox } from "../hostInbox.js";
import { HostUploadService } from "../HostUploadService.js";

class FakeEndpoint implements HostFileEndpoint {
  readonly endpointId = "session-1:view-7";
  readonly clientEndpointId = "view-7";
  readonly clientId = "client-a";
  readonly projectId = "p1";
  isClosed() {
    return false;
  }
  onClose() {
    return { dispose: () => {} };
  }
}

let socketDir: string;
let root: string;
const sessions: LinkSession[] = [];

beforeEach(async () => {
  socketDir = await makeTempDir();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sink-compose-")));
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  await fs.rm(root, { recursive: true, force: true });
});

// Project bundles and uploads each claim their own destinations on one host
// session; neither install may silently disable the other.
describe.each([
  ["projects first", ["projects", "uploads"] as const],
  ["uploads first", ["uploads", "projects"] as const],
])("host transfer sinks, %s", (_label, order) => {
  it("accepts a bundle and an upload on the same session, and refuses anything else", async () => {
    const { host, client } = await openSessionPair(socketDir);
    sessions.push(host, client);
    const store = new BundleStore(() => path.join(root, "bundles"));
    const uploads = new HostUploadService({
      rootsFor: async () => [],
      isDriving: () => true,
      inbox: new HostInbox({ root: path.join(root, "daintree-inbox") }),
      freeBytes: async () => null,
    });
    for (const step of order) {
      if (step === "projects") {
        attachProjectsHost(host, { bundles: store } as unknown as ProjectAcrossHostsService);
      } else {
        uploads.attach(host, new FakeEndpoint());
      }
    }

    const slot = await store.expect();
    const sent = await client.transfers.send(bytesTransferSource(new Uint8Array([1, 2, 3])), {
      name: "repository.bundle",
      destination: { kind: "path", path: `${BUNDLE_SINK_PREFIX}${slot.token}` },
    });
    expect(sent.bytes).toBe(3);
    expect([...(await fs.readFile(slot.path))]).toEqual([1, 2, 3]);

    const transport = new ClientUploadTransport();
    transport.noteEndpointOpened("studio-01", {
      session: client,
      webContentsId: 7,
      endpointId: "view-7",
    });
    const uploaded = await transport.upload(
      "studio-01",
      bytesTransferSource(new Uint8Array(Buffer.from("notes"))),
      {
        webContentsId: 7,
        hostLabel: "studio-01",
        name: "notes.txt",
        destination: { kind: "inbox", bucket: "files" },
      }
    );
    expect(await fs.readFile(uploaded.hostPath, "utf8")).toBe("notes");

    await expect(
      client.transfers.send(bytesTransferSource(new Uint8Array([4])), {
        name: "stray",
        destination: { kind: "path", path: "daintree-download:nobody" },
      })
    ).rejects.toThrow();
    uploads.dispose();
  });
});
