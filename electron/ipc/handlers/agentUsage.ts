import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { getAgentUsageReadouts } from "../../services/agentUsage/AgentUsageReadouts.js";
import {
  isAgentUsageTrackingEnabled,
  onAgentUsageTrackingChanged,
  readAgentUsageTracking,
  setAgentUsageTracking,
} from "../../services/agentUsage/AgentUsageTracking.js";
import { AGENT_USAGE_METHOD_CHANNELS } from "./agentUsage.preload.js";
import type {
  AgentUsageSnapshot,
  AgentUsageTrackingSnapshot,
} from "../../../shared/types/ipc/agentUsage.js";

const setFollowingSchema = z.object({ following: z.boolean() }).strict();
const setTrackingSchema = z.object({ enabled: z.boolean() }).strict();

/** Each following view's watch for going away without saying so, by WebContents id. */
const followers = new Map<number, () => void>();

function stopFollowing(webContentsId: number): void {
  const unwatch = followers.get(webContentsId);
  if (!unwatch) return;
  followers.delete(webContentsId);
  unwatch();
  getAgentUsageReadouts().unfollow(webContentsId);
}

/**
 * A view whose document is replaced, that crashes or that closes never sends
 * its release, so its demand goes with it here. Only a navigation that
 * commits counts.
 */
function startFollowing(ctx: IpcContext): AgentUsageSnapshot | null {
  const sender = ctx.event?.sender;
  // With tracking off nothing is watched, whoever asks (#17981).
  if (!sender || !isAgentUsageTrackingEnabled()) return null;
  const id = sender.id;
  if (!followers.has(id)) {
    const onGone = () => stopFollowing(id);
    const onFailedLoad = (
      _event: unknown,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean
    ) => {
      if (isMainFrame) stopFollowing(id);
    };
    sender.on("did-navigate", onGone);
    sender.on("did-fail-provisional-load", onFailedLoad);
    sender.on("render-process-gone", onGone);
    const unwatchDestroyed = onWebContentsDestroyed(sender, onGone);
    followers.set(id, () => {
      sender.removeListener("did-navigate", onGone);
      sender.removeListener("did-fail-provisional-load", onFailedLoad);
      sender.removeListener("render-process-gone", onGone);
      unwatchDestroyed();
    });
  }
  return getAgentUsageReadouts().follow(id);
}

export const agentUsageNamespace = defineIpcNamespace({
  name: "agentUsage",
  ops: {
    /**
     * Whether this view shows the sidebar's usage readout now (#17318). This
     * machine watches its agents' usage only while some view does; following
     * answers with what's known, and changes arrive on `agent-usage:changed`.
     */
    setFollowing: opValidated(
      AGENT_USAGE_METHOD_CHANNELS.setFollowing,
      setFollowingSchema,
      async (
        ctx: IpcContext,
        payload: { following: boolean }
      ): Promise<AgentUsageSnapshot | null> => {
        if (payload.following) return startFollowing(ctx);
        if (ctx.event?.sender) stopFollowing(ctx.event.sender.id);
        return null;
      },
      { withContext: true }
    ),
    /** This machine's tracking switch (#17981), pushed on `agent-usage:tracking-changed`. */
    getTracking: op(
      AGENT_USAGE_METHOD_CHANNELS.getTracking,
      async (): Promise<AgentUsageTrackingSnapshot> => readAgentUsageTracking()
    ),
    setTracking: opValidated(
      AGENT_USAGE_METHOD_CHANNELS.setTracking,
      setTrackingSchema,
      async (payload: { enabled: boolean }): Promise<AgentUsageTrackingSnapshot> =>
        setAgentUsageTracking(payload.enabled)
    ),
  },
});

function stopAllFollowing(): void {
  for (const webContentsId of [...followers.keys()]) stopFollowing(webContentsId);
}

export function registerAgentUsageHandlers(): () => void {
  const unregister = agentUsageNamespace.register();
  // Off takes every view's demand at once, before any of them hears of it.
  const offTracking = onAgentUsageTrackingChanged((enabled) => {
    if (!enabled) stopAllFollowing();
  });
  return () => {
    offTracking();
    unregister();
    stopAllFollowing();
  };
}
