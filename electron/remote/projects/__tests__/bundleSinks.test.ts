import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransferBeginMessage } from "../../link/messages.js";
import { BundleStore } from "../../../services/projectAcrossHosts/bundles.js";
import { tempRoot } from "../../../services/projectAcrossHosts/__tests__/gitFixtures.js";
import {
  acceptClientBundleTransfer,
  expectClientBundle,
  hostBundleSinkFactory,
} from "../bundleSinks.js";
import { BUNDLE_SINK_PREFIX } from "../linkMethods.js";

let root: string;

beforeAll(() => {
  root = tempRoot("pah-sink-");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function begin(destination: string): TransferBeginMessage {
  return {
    transferId: 1,
    name: "repository.bundle",
    size: 3,
    sha256: "0".repeat(64),
    destination: { kind: "path", path: destination },
  };
}

describe("host bundle sink", () => {
  it("accepts one bundle into a slot it minted and refuses anything else", async () => {
    const store = new BundleStore(() => path.join(root, "host"));
    const factory = hostBundleSinkFactory(store);
    const slot = await store.expect();
    const sink = await factory(begin(`${BUNDLE_SINK_PREFIX}${slot.token}`));
    await sink.write(new Uint8Array([1, 2, 3]));
    expect(await sink.commit()).toBe(slot.path);
    expect(fs.readFileSync(slot.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.statSync(slot.path).mode & 0o777).toBe(0o600);

    expect(() => factory(begin(`${BUNDLE_SINK_PREFIX}${slot.token}`))).toThrow();
    expect(() => factory(begin(`${BUNDLE_SINK_PREFIX}${"f".repeat(32)}`))).toThrow();
    expect(() => factory(begin("daintree-download:abc"))).toThrow();
  });

  it("removes a partial bundle when the transfer aborts", async () => {
    const store = new BundleStore(() => path.join(root, "host-abort"));
    const slot = await store.expect();
    const sink = await hostBundleSinkFactory(store)(begin(`${BUNDLE_SINK_PREFIX}${slot.token}`));
    await sink.write(new Uint8Array([9]));
    await sink.abort("cancelled");
    expect(fs.existsSync(slot.path)).toBe(false);
  });
});

describe("client bundle sink", () => {
  it("takes only bundles this Shell asked for, and leaves other destinations alone", async () => {
    const target = path.join(root, "client.bundle");
    const token = "a".repeat(32);
    const release = expectClientBundle(token, target);
    expect(acceptClientBundleTransfer(begin("daintree-stream:abc"))).toBeNull();
    const sink = acceptClientBundleTransfer(begin(`${BUNDLE_SINK_PREFIX}${token}`))!;
    await sink.write(new Uint8Array([4]));
    expect(await sink.commit()).toBe(target);
    expect(() => acceptClientBundleTransfer(begin(`${BUNDLE_SINK_PREFIX}${token}`))).toThrow();
    release();
  });
});
