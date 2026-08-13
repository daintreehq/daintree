import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../../../../shared/theme/index.js";
import type { AppThemeConfig } from "../../../../shared/types/appTheme.js";
import type { RemoteEnvelope } from "../../../../shared/types/remote/index.js";
import { RemoteAppearanceSyncService } from "../RemoteAppearanceSyncService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";

class TestSource {
  config: Partial<AppThemeConfig> = { colorSchemeId: "daintree" };
  previewConfig: Partial<AppThemeConfig> | null = null;
  listeners = new Set<() => void>();

  get(): Partial<AppThemeConfig> {
    return this.config;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(config: Partial<AppThemeConfig>): void {
    this.config = config;
    for (const listener of this.listeners) listener();
  }

  preview(config: Partial<AppThemeConfig>): void {
    this.previewConfig = config;
  }
}

function session(id: string): RemoteSession {
  return {
    id: `session-${id}`,
    connection: {
      id,
      sourceAddress: "127.0.0.1",
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
    },
    state: "ready",
    deviceId: `device-${id}`,
    capabilities: ["observe-projects"],
    subscriptions: new Map(),
    pendingSubscriptions: new Set(),
    requestTimes: [],
  };
}

class TestSessions {
  values: RemoteSession[] = [];
  readyListeners = new Set<(value: RemoteSession) => void>();

  readySessions(): RemoteSession[] {
    return this.values;
  }

  onSessionReady(listener: (value: RemoteSession) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  markReady(value: RemoteSession): void {
    value.state = "ready";
    this.values.push(value);
    for (const listener of this.readyListeners) listener(value);
  }
}

describe("RemoteAppearanceSyncService", () => {
  it("publishes monotonic revisions for committed theme, system resolution, and accent changes", () => {
    const source = new TestSource();
    const sessions = new TestSessions();
    sessions.values = [session("phone")];
    const envelopes: RemoteEnvelope[] = [];
    const service = new RemoteAppearanceSyncService(source, sessions, {
      sendApplicationEnvelope: (_, envelope) => envelopes.push(envelope),
    });
    service.start();

    source.commit({ colorSchemeId: "bondi", followSystem: false });
    source.commit({ colorSchemeId: "daintree", followSystem: true });
    source.commit({
      colorSchemeId: "daintree",
      followSystem: true,
      accentColorOverride: "#ff8040",
    });

    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      "appearance.updated",
      "appearance.updated",
      "appearance.updated",
    ]);
    expect(
      envelopes.map((envelope) => ("revision" in envelope ? envelope.revision : null))
    ).toEqual([2, 3, 4]);
    expect(service.current().revision).toBe(4);
    expect(service.current().accent.primary).toBe("#ff8040ff");
  });

  it("does not publish renderer-only previews or semantic duplicates", () => {
    const source = new TestSource();
    const sessions = new TestSessions();
    sessions.values = [session("phone")];
    const sendApplicationEnvelope = vi.fn();
    const service = new RemoteAppearanceSyncService(source, sessions, { sendApplicationEnvelope });
    service.start();

    const preview = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === "bondi")!;
    source.preview({ colorSchemeId: preview.id });
    source.commit({ ...source.config, followSystem: false });

    expect(sendApplicationEnvelope).not.toHaveBeenCalled();
    expect(service.current().revision).toBe(1);
  });

  it("converges every ready session even when one delivery is interrupted", () => {
    const source = new TestSource();
    const sessions = new TestSessions();
    sessions.values = [session("closed"), session("tablet"), session("phone")];
    const delivered: string[] = [];
    const service = new RemoteAppearanceSyncService(source, sessions, {
      sendApplicationEnvelope: (connectionId) => {
        if (connectionId === "closed") throw new Error("disconnected");
        delivered.push(connectionId);
      },
    });
    service.start();

    source.commit({ colorSchemeId: "bondi" });

    expect(delivered).toEqual(["tablet", "phone"]);
    expect(service.current().themeId).toBe("bondi");
  });

  it("cleans up its committed-state subscription and does not duplicate after restart", () => {
    const source = new TestSource();
    const sessions = new TestSessions();
    sessions.values = [session("phone")];
    const sendApplicationEnvelope = vi.fn();
    const service = new RemoteAppearanceSyncService(source, sessions, { sendApplicationEnvelope });

    service.start();
    service.start();
    expect(source.listeners.size).toBe(1);
    service.dispose();
    expect(source.listeners.size).toBe(0);
    expect(sessions.readyListeners.size).toBe(0);
    source.commit({ colorSchemeId: "bondi" });
    expect(sendApplicationEnvelope).not.toHaveBeenCalled();

    service.start();
    source.commit({ colorSchemeId: "bondi" });
    expect(sendApplicationEnvelope).toHaveBeenCalledOnce();
  });

  it("catches up a session that becomes ready after a committed change", () => {
    const source = new TestSource();
    const sessions = new TestSessions();
    const delivered: RemoteEnvelope[] = [];
    const service = new RemoteAppearanceSyncService(source, sessions, {
      sendApplicationEnvelope: (_, envelope) => delivered.push(envelope),
    });
    service.start();
    const welcomeRevision = service.current().revision;

    source.commit({ colorSchemeId: "bondi" });
    expect(delivered).toEqual([]);
    sessions.markReady(session("late-phone"));

    expect(welcomeRevision).toBeLessThan(service.current().revision);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: "appearance.updated",
      revision: service.current().revision,
      payload: { themeId: "bondi" },
    });
  });
});
