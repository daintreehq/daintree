// Worker-side `PluginHostApi` implementation for the dev hot-reload worker
// (#9304). Plugin code running in the `utilityProcess.fork` child receives this
// proxy as its `host`. Every call is relayed over the parent MessagePort to
// `PluginDevWorkerMainBridge`, which forwards to the real host. Handlers the
// plugin registers (actions, IPC) stay HERE in the worker — main invokes them
// back over the port — so a reload (whole-worker respawn) discards them cleanly
// and there is no ESM module-cache leak (Vite #14438).
//
//
// The transport (request ids, pending calls, deadlines, invocation
// attribution) lives in `PluginDevWorkerRpcClient`; each domain of the host API
// is a facet that owns its own registrations and handles. This file composes
// the unchanged `PluginHostApi` from them and routes main's messages (#14331).

import type { PluginHostApi, PluginIdentity } from "../../../shared/types/plugin.js";
import { toRuntimePanelKindId } from "../../../shared/config/panelKindRegistry.js";
import type { PluginHostToWorkerMessage } from "../../../shared/types/pluginDevWorker.js";
import { PluginDevWorkerRpcClient, type Post } from "./pluginDevWorkerRpcClient.js";
import { PluginDevWorkerCapabilityFacet } from "./pluginDevWorkerCapabilityFacet.js";
import { PluginDevWorkerContributionFacet } from "./pluginDevWorkerContributionFacet.js";
import { PluginDevWorkerObservationFacet } from "./pluginDevWorkerObservationFacet.js";
import { PluginDevWorkerProcessFacet } from "./pluginDevWorkerProcessFacet.js";

export class PluginDevWorkerHostProxy {
  readonly host: PluginHostApi;
  private readonly pluginId: string;
  private readonly identity: PluginIdentity;

  private revoked = false;

  private readonly rpc: PluginDevWorkerRpcClient;
  private readonly contributions: PluginDevWorkerContributionFacet;
  private readonly observation: PluginDevWorkerObservationFacet;
  private readonly capabilities: PluginDevWorkerCapabilityFacet;
  private readonly processes: PluginDevWorkerProcessFacet;

  constructor(pluginId: string, post: Post, identity: PluginIdentity) {
    this.pluginId = pluginId;
    this.identity = identity;
    this.rpc = new PluginDevWorkerRpcClient(pluginId, post);
    const deps = {
      rpc: this.rpc,
      pluginId,
      identity,
      assertActivationOpen: (name: string) => this.assertActivationOpen(name),
    };
    this.contributions = new PluginDevWorkerContributionFacet(deps);
    this.observation = new PluginDevWorkerObservationFacet(deps);
    this.capabilities = new PluginDevWorkerCapabilityFacet(deps);
    this.processes = new PluginDevWorkerProcessFacet(deps);
    this.host = this.buildHost();
  }

  /** Revoke the host registration surface once `activate()` resolves/times out,
   * mirroring the real host's revoke semantics. */
  revoke(): void {
    this.revoked = true;
  }

  dispose(): void {
    // The transport first: it marks the proxy disposed and settles every
    // pending call before any facet aborts a signal a plugin listens to.
    this.rpc.dispose();
    this.contributions.dispose();
    this.observation.dispose();
    this.capabilities.dispose();
    this.processes.dispose();
  }

  /** Test seam: plain invokes whose result is still awaited. */
  runningInvokeCount(): number {
    return this.contributions.runningInvokeCount();
  }

  /** Route a message received from main. Returns true if it was consumed. */
  handleMessage(msg: PluginHostToWorkerMessage): boolean {
    switch (msg.type) {
      case "host-result":
        this.rpc.handleHostResult(msg);
        return true;
      case "invoke":
        this.contributions.handleInvoke(msg);
        return true;
      case "invoke-cancel":
        this.contributions.handleCancel(msg);
        return true;
      case "subscription-event":
        this.rpc.handleSubscriptionEvent(msg);
        return true;
      case "register-error":
        console.error(
          `[plugin-dev:${this.pluginId}] registration "${msg.registrationKey}" rejected by host: ${msg.error}`
        );
        return true;
      default:
        return false;
    }
  }

  private assertActivationOpen(name: string): void {
    if (this.revoked) {
      throw new Error(
        `Plugin "${this.pluginId}" host revoked: ${name} called after activate() returned or timed out`
      );
    }
  }

  private buildHost(): PluginHostApi {
    // Captured for the `pluginId` getter, whose own `this` would be the host
    // object literal, not this class instance. Every facet member is an arrow
    // function that closes over its facet's `this` lexically.
    const pluginId = this.pluginId;
    // The identity the main-process host computed, relayed verbatim in the
    // `start` message. Not reconstructed from `pluginId`: `projectRoot` lives on
    // the host's binding and cannot be recovered from an instance key, and a
    // project plugin — which reaches this worker like any other plugin with a
    // `main` — would otherwise report a project with no root.
    const pluginInfo = this.identity;
    const manifestId = pluginInfo.manifestId;
    const projectId = pluginInfo.projectId;
    const host: PluginHostApi = {
      get pluginId() {
        return pluginId;
      },
      pluginInfo,
      panelKindId: (bareId: string) => {
        if (typeof bareId !== "string" || bareId.length === 0) {
          throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
        }
        const qualified = toRuntimePanelKindId(
          { origin: pluginInfo.origin, pluginId: manifestId, kindId: bareId },
          projectId
        );
        if (qualified === null) {
          throw new Error(
            `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
          );
        }
        return qualified;
      },
      ...this.contributions.api,
      ...this.observation.api,
      ...this.capabilities.api,
      ...this.processes.api,
    };
    return host;
  }
}
