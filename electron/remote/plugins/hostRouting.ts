import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import type { EndpointRegistry } from "../../ipc/endpoint.js";
import { getDriveLeaseService, type DriveLeaseService } from "../../services/DriveLeaseService.js";
import {
  getPluginInvokeOrigin,
  setPluginFrontendRouter,
  type PluginFrontend,
  type PluginFrontendRouter,
} from "../../services/plugin/pluginFrontendRouting.js";
import { projectIdFromPluginInstanceKey } from "../../services/plugin/projectPluginIdentity.js";
import {
  resolveAmbientWebContents,
  resolveProjectWebContents,
} from "../../services/plugin/rendererTargeting.js";

export interface PluginHostRoutingDeps {
  lease?: Pick<DriveLeaseService, "getDriveTarget" | "onChange">;
  registry?: Pick<EndpointRegistry, "onChange">;
  hasLocalProjectView?: (projectId: string) => boolean;
  hasLocalView?: () => boolean;
}

/**
 * The router Host mode installs: a plugin's person-facing calls go to the
 * frontend that drives the plugin's project.
 *
 * - A project the drive lease gives to a window on this machine is answered
 *   here, the way it always was.
 * - A project driven from another machine is answered there.
 * - A project nobody drives is answered by a window here showing it, if there
 *   is one; otherwise nobody can answer.
 *
 * An app-global plugin has no project of its own, so it follows the project of
 * the invocation it is answering. Work that belongs to no invocation (a timer,
 * a subscription) goes to a window here if there is one, and to nobody
 * otherwise: it never borrows another caller's project.
 */
export function createPluginFrontendRouter(deps: PluginHostRoutingDeps = {}): PluginFrontendRouter {
  const lease = deps.lease ?? getDriveLeaseService();
  const registry = deps.registry ?? getEndpointRegistry();
  const hasLocalProjectView =
    deps.hasLocalProjectView ?? ((projectId) => resolveProjectWebContents(projectId) !== null);
  const hasLocalView = deps.hasLocalView ?? (() => resolveAmbientWebContents() !== null);

  const forProject = (projectId: string): PluginFrontend => {
    const target = lease.getDriveTarget(projectId);
    switch (target.kind) {
      case "live":
        return target.endpoint.kind === "local-view"
          ? { kind: "local" }
          : { kind: "remote", endpoint: target.endpoint, leaseId: target.holder.leaseId };
      case "reserved":
        // A window here stepping away leaves the project with this machine's
        // other windows; a remote driver stepping away holds it for its grace.
        return target.holder.isHostLocal && hasLocalProjectView(projectId)
          ? { kind: "local" }
          : { kind: "none", reason: "reserved" };
      case "vacant":
        return hasLocalProjectView(projectId)
          ? { kind: "local" }
          : { kind: "none", reason: "vacant" };
    }
  };

  return {
    resolve({ projectId, pluginId }) {
      const bound = projectId ?? projectIdFromPluginInstanceKey(pluginId);
      if (bound !== null) return forProject(bound);
      const origin = getPluginInvokeOrigin(pluginId);
      if (origin?.projectId) return forProject(origin.projectId);
      if (origin) {
        // A caller with no project: its own view answers, or nobody does.
        if (origin.endpoint.kind === "local-view") return { kind: "local" };
        return origin.endpoint.isClosed()
          ? { kind: "none", reason: "vacant" }
          : { kind: "remote", endpoint: origin.endpoint };
      }
      if (hasLocalView()) return { kind: "local" };
      return { kind: "none", reason: "vacant" };
    },
    onChange(listener) {
      const offLease = lease.onChange(() => listener());
      const offRegistry = registry.onChange(listener);
      return () => {
        offLease();
        offRegistry();
      };
    },
  };
}

/** Host-mode boot hook: route plugin prompts, consent and clipboard by drive lease. */
export function installPluginHostRouting(deps: PluginHostRoutingDeps = {}): () => void {
  return setPluginFrontendRouter(createPluginFrontendRouter(deps));
}
