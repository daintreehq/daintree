import type { MaterializeResult, MaterializeSource } from "@shared/types/remoteHosts";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { materialize } from "@/services/materialize";
import { FILE_DRAG_MIME, decodeFileDragPaths, hasInternalFileDrag } from "./fileDragPayload";

/**
 * Where a dropped or pasted path came from. `local` is a file on this machine
 * (Finder, the OS clipboard, the attach dialog); `host` is one the window's own
 * file browser handed over, so it already lives wherever the agent runs.
 */
export type TransferSourceKind = "local" | "host";

/** A path and where it lives — all `materialize` needs. */
export interface TransferPath {
  kind: TransferSourceKind;
  path: string;
}

/**
 * A resolved drop or paste. An OS `File` also carries its untrimmed name and
 * size; an in-app drag is a bare path.
 */
export type TransferSource =
  { kind: "local"; path: string; name: string; size: number } | { kind: "host"; path: string };

/**
 * Paths for OS `File`s, in order. A file the OS declines to resolve to a path
 * (synthetic, or nothing on disk behind it) is not referenceable and is left
 * out.
 */
export function resolveLocalFileSources(
  files: readonly File[]
): Extract<TransferSource, { kind: "local" }>[] {
  if (files.length === 0) return [];
  const paths = window.electron.files.getDroppedFilePaths(Array.from(files));
  const sources: Extract<TransferSource, { kind: "local" }>[] = [];
  files.forEach((file, index) => {
    const path = paths[index];
    if (path) sources.push({ kind: "local", path, name: file.name, size: file.size });
  });
  return sources;
}

/**
 * The paths a drop carries, with their provenance. Must run synchronously in
 * the `drop` handler: the transfer's contents are unreadable once it returns.
 *
 * The in-app type wins when both are present; draining `files` as well would
 * insert every reference twice. An in-app payload that fails validation is a
 * no-op drop rather than a fallback to the OS files.
 */
export function resolveTransferSources(dataTransfer: {
  readonly types: readonly string[];
  getData(format: string): string;
  readonly files: ArrayLike<File>;
}): TransferSource[] {
  if (hasInternalFileDrag(dataTransfer.types)) {
    return (decodeFileDragPaths(dataTransfer.getData(FILE_DRAG_MIME)) ?? []).map(
      (path): TransferSource => ({ kind: "host", path })
    );
  }
  return resolveLocalFileSources(Array.from(dataTransfer.files));
}

/**
 * The `materialize` source for a transfer. The in-app drag payload does not
 * name its host yet, so a `host` path is attributed to the local host — right
 * for every window today, and the payload has to carry the host before a
 * remote window can drag from its tree.
 */
export function toMaterializeSource(source: TransferPath): MaterializeSource {
  return source.kind === "host"
    ? { kind: "host-file", path: source.path, hostId: LOCAL_HOST_ID }
    : { kind: "local-file", path: source.path };
}

/**
 * Runs every source through `materialize` together, keeping order. A source
 * that fails comes back `null` so the caller skips it exactly as it skips a
 * path that never resolved; the rest still land. Locally this is the identity.
 */
export async function materializeTransferSources(
  sources: readonly TransferPath[]
): Promise<(MaterializeResult | null)[]> {
  const settled = await Promise.allSettled(
    sources.map((source) => materialize(toMaterializeSource(source)))
  );
  return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
}
