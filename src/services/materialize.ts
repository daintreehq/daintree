import type {
  MaterializeFn,
  MaterializeOptions,
  MaterializeResult,
  MaterializeSource,
} from "@shared/types/remoteHosts";
import { isLocalHostId } from "@shared/types/remoteHosts";
import { currentHostId, isRemoteWindow } from "@/hooks/useHostPlatform";

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Local mode: files are already where the agent runs, so a path is returned
 * exactly as given, and a clipboard image goes through today's temp-file save.
 * Local bytes have no temp-file path today and are refused.
 */
async function materializeLocally(source: MaterializeSource): Promise<MaterializeResult> {
  switch (source.kind) {
    case "host-file":
      if (!isLocalHostId(source.hostId)) {
        throw new Error("That file is on another host, and this window is on this machine");
      }
      return { hostPath: source.path, displayName: basename(source.path), bytes: null };
    case "local-file":
      return { hostPath: source.path, displayName: basename(source.path), bytes: null };
    case "clipboard-image": {
      const { filePath, thumbnailDataUrl } = await window.electron.clipboard.saveImage();
      return {
        hostPath: filePath,
        displayName: basename(filePath),
        bytes: null,
        thumbnail: thumbnailDataUrl,
      };
    }
    case "local-bytes":
      throw new Error("Pasting raw bytes needs a remote host to upload to");
  }
}

let remoteMaterializer: MaterializeFn | null = null;
let viewMaterializer: MaterializeFn | null = null;
let loadingViewMaterializer: Promise<MaterializeFn> | null = null;

/**
 * A view belongs to one host for its whole life, so a remote view loads its
 * materializer once, on first use. A local view never loads it at all.
 */
function loadViewMaterializer(): Promise<MaterializeFn> {
  loadingViewMaterializer ??= import("./remoteMaterializer").then(
    (module) => {
      viewMaterializer = module.createViewRemoteMaterializer(currentHostId());
      return viewMaterializer;
    },
    (error: unknown) => {
      loadingViewMaterializer = null;
      throw error;
    }
  );
  return loadingViewMaterializer;
}

/**
 * Installed for a window attached to a remote host, and cleared when it
 * returns to local. While set, every source is resolved to a path on the host.
 */
export function setRemoteMaterializer(fn: MaterializeFn | null): void {
  remoteMaterializer = fn;
}

/**
 * The one primitive every drop, paste and attach goes through before a path is
 * inserted. The insertion code never changes; only where the path comes from.
 */
export const materialize: MaterializeFn = (
  source: MaterializeSource,
  options?: MaterializeOptions
): Promise<MaterializeResult> => {
  const remote = remoteMaterializer ?? viewMaterializer;
  if (remote) return remote(source, options);
  if (isRemoteWindow()) return loadViewMaterializer().then((fn) => fn(source, options));
  return materializeLocally(source);
};
