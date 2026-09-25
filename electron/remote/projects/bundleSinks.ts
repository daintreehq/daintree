import fs from "node:fs/promises";
import type { TransferBeginMessage } from "../link/messages.js";
import type { TransferSink, TransferSinkFactory } from "../link/transfer.js";
import type { BundleStore } from "../../services/projectAcrossHosts/bundles.js";
import { OWNER_RW_FILE_MODE } from "../../utils/fs.js";
import { BUNDLE_SINK_PREFIX } from "./linkMethods.js";

/**
 * Writes one incoming bundle to a private path that must not exist yet. The
 * transfer layer verifies the sha256 before `commit`; an abort removes the
 * partial file.
 */
export function bundleFileSink(target: string): TransferSink {
  let handle: fs.FileHandle | null = null;
  let chain: Promise<void> = Promise.resolve();
  const open = async (): Promise<fs.FileHandle> => {
    handle ??= await fs.open(target, "wx", OWNER_RW_FILE_MODE);
    return handle;
  };
  return {
    write(chunk) {
      chain = chain.then(async () => {
        const file = await open();
        await file.write(chunk);
      });
      return chain;
    },
    async commit() {
      await chain;
      const file = await open();
      await file.close();
      handle = null;
      return target;
    },
    async abort() {
      await chain.catch(() => {});
      await handle?.close().catch(() => {});
      handle = null;
      await fs.rm(target, { force: true }).catch(() => {});
    },
  };
}

function bundleToken(begin: TransferBeginMessage): string | null {
  const destination = begin.destination;
  if (destination.kind !== "path" || !destination.path.startsWith(BUNDLE_SINK_PREFIX)) return null;
  return destination.path.slice(BUNDLE_SINK_PREFIX.length);
}

/**
 * Host side: a bundle is accepted only into a slot this host minted
 * (`projects.bundle-expect`), and only once. Returns null for any other
 * destination so a composed factory can hand it to its own sinks.
 */
export function hostBundleSinkFor(
  store: BundleStore,
  received: Set<string>
): (begin: TransferBeginMessage) => TransferSink | null {
  return (begin) => {
    const token = bundleToken(begin);
    if (token === null) return null;
    const entry = store.get(token);
    if (!entry || received.has(token))
      throw new Error("No bundle was expected for this destination");
    received.add(token);
    return bundleFileSink(entry.path);
  };
}

export function hostBundleSinkFactory(store: BundleStore): TransferSinkFactory {
  const accept = hostBundleSinkFor(store, new Set());
  return (begin) => {
    const sink = accept(begin);
    if (!sink) throw new Error("Unexpected transfer destination");
    return sink;
  };
}

const clientSlots = new Map<string, string>();

/** Shell side: accept one bundle for `token`, written to `targetPath`. */
export function expectClientBundle(token: string, targetPath: string): () => void {
  clientSlots.set(token, targetPath);
  return () => {
    if (clientSlots.get(token) === targetPath) clientSlots.delete(token);
  };
}

/**
 * Shell side: the sink for a host's bundle transfer, or null when the
 * destination isn't a bundle's. The Shell's transfer factory (the host file
 * client's) consults this before refusing a destination it didn't mint.
 */
export function acceptClientBundleTransfer(begin: TransferBeginMessage): TransferSink | null {
  const token = bundleToken(begin);
  if (token === null) return null;
  const target = clientSlots.get(token);
  if (!target) throw new Error("No bundle was requested for this destination");
  clientSlots.delete(token);
  return bundleFileSink(target);
}
