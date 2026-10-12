import { beforeEach, describe, expect, it } from "vitest";
import {
  isHostLinkUp,
  selectHostBannerVariant,
  useHostConnectionStore,
} from "../hostConnectionStore";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
} as const;

const connected = { status: "connected", rttMs: 5, handshake: HANDSHAKE } as const;

beforeEach(() => {
  useHostConnectionStore.getState().reset();
});

describe("hostConnectionStore", () => {
  it("shows nothing and counts as up for a view that runs on this machine", () => {
    useHostConnectionStore.setState({
      connection: { status: "unreachable", lastSeenAt: 1, detail: null },
    });
    const state = useHostConnectionStore.getState();
    expect(selectHostBannerVariant(state)).toBeNull();
    expect(isHostLinkUp(state)).toBe(true);
  });

  it("tells a first dial from a lost link", () => {
    const store = useHostConnectionStore.getState();
    store.bindHost("studio-01", "studio-01");
    store.applyConnection({ status: "connecting", attempt: 1 });
    expect(selectHostBannerVariant(useHostConnectionStore.getState())).toBe("connecting");

    store.applyConnection(connected);
    store.applyConnection({ status: "connecting", attempt: 1 });
    expect(selectHostBannerVariant(useHostConnectionStore.getState())).toBe("reconnecting");
  });

  it("prefers the link's record of when it last heard from the host over noticing the drop", () => {
    const store = useHostConnectionStore.getState();
    store.bindHost("studio-01", "studio-01");
    store.applyConnection(connected, 1_000);
    store.applyConnection({ status: "connecting", attempt: 1 }, 5_000);
    expect(useHostConnectionStore.getState().lastSeenAt).toBe(5_000);

    store.applyConnection({ status: "unreachable", lastSeenAt: 3_000, detail: null }, 9_000);
    expect(useHostConnectionStore.getState().lastSeenAt).toBe(3_000);
    expect(selectHostBannerVariant(useHostConnectionStore.getState())).toBe("unreachable");
    store.applyConnection({ status: "connecting", attempt: 2 }, 11_000);
    expect(useHostConnectionStore.getState().lastSeenAt).toBe(3_000);

    store.applyConnection(connected, 10_000);
    expect(useHostConnectionStore.getState().lastSeenAt).toBeNull();
  });

  it("takes the host's record of when it was last seen when this view never saw it", () => {
    const store = useHostConnectionStore.getState();
    store.bindHost("studio-01", "studio-01");
    store.applyConnection({ status: "unreachable", lastSeenAt: 3_000, detail: null });
    expect(useHostConnectionStore.getState().lastSeenAt).toBe(3_000);
  });

  it("shows a check only while the link is up and one is pending", () => {
    const store = useHostConnectionStore.getState();
    store.bindHost("studio-01", "studio-01");
    store.applyConnection(connected);
    const end = store.beginCheck();
    expect(selectHostBannerVariant(useHostConnectionStore.getState())).toBe("checking");
    end();
    end();
    expect(useHostConnectionStore.getState().checking).toBe(0);
    expect(selectHostBannerVariant(useHostConnectionStore.getState())).toBeNull();
  });
});
