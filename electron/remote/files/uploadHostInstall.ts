import { setThumbnailInboxRoot } from "../../ipc/handlers/clipboard.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { HostInbox } from "./hostInbox.js";
import { projectFileRoots } from "./hostInstall.js";
import type { HostFileEndpoint } from "./HostFileService.js";
import { HostUploadService } from "./HostUploadService.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostUploadService: HostUploadService;
  }
}

/**
 * Start accepting uploads from remote windows on this host. The inbox is
 * created (owner-only) and swept once now; each placed upload sweeps it again.
 */
export function installHostUploadService(options: { inbox?: HostInbox } = {}): {
  service: HostUploadService;
  dispose(): void;
} {
  const lease = getDriveLeaseService();
  const inbox = options.inbox ?? new HostInbox();
  const service = new HostUploadService({
    rootsFor: projectFileRoots,
    isDriving: (projectId, endpoint) => lease.isDriving(projectId, endpoint),
    leaseIdFor: (projectId) => lease.getHolder(projectId)?.leaseId ?? null,
    inbox,
  });
  void inbox
    .ensure()
    .then(() => inbox.cleanup())
    .catch((error: unknown) => {
      console.warn("[RemoteHosts] Couldn't prepare the host inbox:", error);
    });
  const unregister = registerRemoteService("hostUploadService", service);
  const unwatchLease = lease.onChange((state) => service.onLeaseChanged(state.projectId));
  // Thumbnails for host inbox paths are built here, on the host, for remote windows.
  const releaseThumbnailRoot = setThumbnailInboxRoot(inbox.root);
  return {
    service,
    dispose() {
      releaseThumbnailRoot();
      unwatchLease();
      unregister();
      service.dispose();
    },
  };
}

/** Boot hook: accept this endpoint's uploads on the link it rides now. */
export function attachHostUploads(session: LinkSession, endpoint: HostFileEndpoint): void {
  getRemoteService("hostUploadService")?.attach(session, endpoint);
}
