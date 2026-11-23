import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_NOTIFICATIONS_MAX,
  ASSISTANT_NOTIFICATION_KEEP_MS,
  AssistantPluginNotifications,
  type AssistantPluginNotification,
} from "../assistantPluginNotifications.js";

describe("AssistantPluginNotifications (#18154)", () => {
  let now: number;
  let granted: boolean;
  let store: AssistantPluginNotifications;
  let count: number;

  const notification = (overrides: Partial<AssistantPluginNotification> = {}) => ({
    notificationId: `n-${++count}`,
    pluginId: "acme",
    pluginName: "Acme",
    projectId: "p1",
    dedupeKey: null,
    severity: "info" as const,
    createdAt: now,
    title: "t",
    body: "b",
    ...overrides,
  });

  beforeEach(() => {
    now = 1_000_000;
    granted = true;
    count = 0;
    store = new AssistantPluginNotifications({ mayHear: () => granted, now: () => now });
  });

  it("keeps and tells only what the person lets that project's assistant hear", () => {
    const heard = vi.fn();
    const off = store.subscribe(heard);
    granted = false;
    store.publish(notification());
    expect(heard).not.toHaveBeenCalled();
    granted = true;
    const kept = notification();
    store.publish(kept);
    expect(heard).toHaveBeenCalledWith(kept);
    off();
    store.publish(notification());
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.untaken({ projectId: null, pluginId: null })).toHaveLength(2);
  });

  it("gives each to one run, and only a hold's own watch frees or passes it on", () => {
    const one = notification();
    store.publish(one);
    expect(store.hold(one.notificationId, "w1")).toBe(true);
    expect(store.hold(one.notificationId, "w2")).toBe(false);
    expect(store.take(one.notificationId, null, "run-x")).toBe(false);
    expect(store.release(one.notificationId, "w2")).toBe(false);
    expect(store.take(one.notificationId, "w1", "run-a")).toBe(true);
    // Taken: no one frees it, holds it or takes it again.
    expect(store.release(one.notificationId, "w1")).toBe(false);
    expect(store.hold(one.notificationId, "w2")).toBe(false);
    expect(store.read(one.notificationId, "run-a")).toBe(one);
    expect(store.read(one.notificationId, "run-b")).toBeNull();
    granted = false;
    expect(store.read(one.notificationId, "run-a")).toBeNull();
  });

  it("forgets one past its time, but never one a notice still holds", () => {
    const held = notification();
    const waiting = notification();
    store.publish(held);
    store.publish(waiting);
    store.hold(held.notificationId, "w1");
    now += ASSISTANT_NOTIFICATION_KEEP_MS;
    expect(store.untaken({ projectId: null, pluginId: null })).toEqual([]);
    // Its taker reads it for the whole while from when it was taken.
    expect(store.take(held.notificationId, "w1", "run-a")).toBe(true);
    now += ASSISTANT_NOTIFICATION_KEEP_MS - 1;
    expect(store.read(held.notificationId, "run-a")).toBe(held);
    now += 1;
    expect(store.read(held.notificationId, "run-a")).toBeNull();
  });

  it("makes room from the oldest no one took, then the oldest taken, never one held", () => {
    const all = Array.from({ length: ASSISTANT_NOTIFICATIONS_MAX }, () => notification());
    for (const one of all) store.publish(one);
    store.hold(all[0]!.notificationId, "w1");
    store.take(all[1]!.notificationId, null, "run-a");
    store.publish(notification());
    const left = store.untaken({ projectId: null, pluginId: null }).map((n) => n.notificationId);
    expect(left).not.toContain(all[2]!.notificationId);
    expect(store.read(all[1]!.notificationId, "run-a")).toBe(all[1]);
    expect(store.release(all[0]!.notificationId, "w1")).toBe(true);
  });

  it("filters by project and plugin, oldest first", () => {
    const late = notification({ createdAt: now + 5 });
    const early = notification({ createdAt: now });
    store.publish(late);
    store.publish(early);
    store.publish(notification({ projectId: "p2" }));
    store.publish(notification({ pluginId: "other" }));
    expect(store.untaken({ projectId: "p1", pluginId: "acme" })).toEqual([early, late]);
  });
});
