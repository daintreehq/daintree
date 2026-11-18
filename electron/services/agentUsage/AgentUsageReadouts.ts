/**
 * Every usage readout the sidebar can show (#17318): this machine's own
 * agents, from its watch, plus every linked host's, from the summaries those
 * hosts already send. One set per machine, whichever host a window shows.
 *
 * Wanted only while a view follows it, and sent only to views following it.
 * Following acquires this machine's watch; hosts are only listened to, never
 * dialled or kept linked for it.
 */

import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import type {
  AgentUsageReading,
  AgentUsageReadout,
  AgentUsageSnapshot,
} from "../../../shared/types/ipc/agentUsage.js";
import { getAgentUsageWatch, type AgentUsageWatch } from "./AgentUsageWatch.js";
import { webContents } from "electron";
import { CHANNELS } from "../../ipc/channels.js";

export interface RemoteAgentUsage {
  hostId: HostId;
  hostName: string;
  /** In this machine's clock. */
  readings: AgentUsageReading[];
}

/** What the linked hosts last reported. Installed by the remote runtime where it runs. */
export interface RemoteAgentUsageSource {
  list(): RemoteAgentUsage[];
  /** Told when any host's report or link may have changed. */
  watch(listener: () => void): () => void;
}

export interface AgentUsageReadoutsDeps {
  watch(): AgentUsageWatch;
  /** To the views following now: never a broadcast, which a host forwards to its Shells' views. */
  publish(snapshot: AgentUsageSnapshot, followers: ReadonlySet<number>): void;
}

export class AgentUsageReadouts {
  private readonly followers = new Set<number>();
  private remote: RemoteAgentUsageSource | null = null;
  private stopFollowing: (() => void) | null = null;
  private offRemote: (() => void) | null = null;
  private snapshot: AgentUsageSnapshot = { readouts: [], revision: 0 };
  private key = "[]";

  constructor(private readonly deps: AgentUsageReadoutsDeps) {}

  /** A view starts showing readouts: what's known now comes back at once. */
  follow(followerId: number): AgentUsageSnapshot {
    this.followers.add(followerId);
    if (this.stopFollowing === null) this.start();
    this.recompute();
    return this.snapshot;
  }

  unfollow(followerId: number): void {
    if (!this.followers.delete(followerId) || this.followers.size > 0) return;
    this.stop();
  }

  /** Where linked hosts' reports come from; the returned call takes it away again. */
  setRemoteSource(source: RemoteAgentUsageSource): () => void {
    this.offRemote?.();
    this.offRemote = null;
    this.remote = source;
    if (this.stopFollowing !== null) {
      this.offRemote = source.watch(() => this.recompute());
      this.recompute();
    }
    return () => {
      if (this.remote !== source) return;
      this.offRemote?.();
      this.offRemote = null;
      this.remote = null;
      this.recompute();
    };
  }

  dispose(): void {
    this.followers.clear();
    this.stop();
    this.remote = null;
  }

  private start(): void {
    const watch = this.deps.watch();
    const offChange = watch.onChange(() => this.recompute());
    const release = watch.acquire();
    this.stopFollowing = () => {
      offChange();
      release();
    };
    this.offRemote = this.remote?.watch(() => this.recompute()) ?? null;
  }

  private stop(): void {
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.offRemote?.();
    this.offRemote = null;
  }

  private recompute(): void {
    if (this.stopFollowing === null) return;
    const readouts: AgentUsageReadout[] = [
      ...this.deps
        .watch()
        .latest()
        .map((reading) => ({ hostId: LOCAL_HOST_ID, hostName: null, reading })),
      ...(this.remote?.list() ?? []).flatMap(({ hostId, hostName, readings }) =>
        readings.map((reading) => ({ hostId, hostName, reading }))
      ),
    ];
    const key = JSON.stringify(readouts);
    if (key === this.key) return;
    this.key = key;
    this.snapshot = { readouts, revision: this.snapshot.revision + 1 };
    this.deps.publish(this.snapshot, this.followers);
  }
}

let shared: AgentUsageReadouts | null = null;

/** This machine's one set, built on first use. */
export function getAgentUsageReadouts(): AgentUsageReadouts {
  shared ??= new AgentUsageReadouts({
    watch: getAgentUsageWatch,
    publish: (snapshot, followers) => {
      for (const id of followers) {
        const view = webContents.fromId(id);
        if (!view || view.isDestroyed()) continue;
        try {
          view.send(CHANNELS.AGENT_USAGE_CHANGED, snapshot);
        } catch {
          // A view on its way out takes the snapshot with it.
        }
      }
    },
  });
  return shared;
}
