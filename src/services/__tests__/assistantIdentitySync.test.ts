// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantIdentities } from "@shared/types/displayIdentity";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const resync = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    onHostResync: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    fire: () => [...listeners].forEach((listener) => listener()),
    size: () => listeners.size,
  };
});
vi.mock("@/store/hostResyncSignal", () => ({ onHostResync: resync.onHostResync }));

import { initAssistantIdentitySync } from "../assistantIdentitySync";
import { useAssistantIdentityStore } from "@/store/assistantIdentityStore";
import { EMPTY_ASSISTANT_IDENTITIES } from "@shared/utils/displayIdentity";

let listener: ((identities: AssistantIdentities) => void) | null = null;
let resolveRead: (identities: AssistantIdentities) => void = () => {};
const bridge = {
  getIdentities: vi.fn(
    () =>
      new Promise<AssistantIdentities>((resolve) => {
        resolveRead = resolve;
      })
  ),
  onIdentitiesChanged: vi.fn((cb: (identities: AssistantIdentities) => void) => {
    listener = cb;
    return () => {
      listener = null;
    };
  }),
};

const named = (name: string): AssistantIdentities => ({ global: { name }, projects: {} });

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  useAssistantIdentityStore.setState({ identities: EMPTY_ASSISTANT_IDENTITIES });
  Object.defineProperty(window, "electron", {
    value: { helpAssistant: bridge },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("initAssistantIdentitySync (#16213)", () => {
  it("takes the first read, then every push", async () => {
    const dispose = initAssistantIdentitySync();
    resolveRead(named("Read"));
    await settle();
    expect(useAssistantIdentityStore.getState().identities.global.name).toBe("Read");

    listener?.(named("Pushed"));
    expect(useAssistantIdentityStore.getState().identities.global.name).toBe("Pushed");
    listener?.(named("Pushed again"));
    expect(useAssistantIdentityStore.getState().identities.global.name).toBe("Pushed again");
    dispose();
  });

  it("drops a read that a push overtook", async () => {
    const dispose = initAssistantIdentitySync();
    listener?.(named("Newer"));
    resolveRead(named("Older"));
    await settle();

    expect(useAssistantIdentityStore.getState().identities.global.name).toBe("Newer");
    dispose();
  });

  it("reads again when a remote view's link comes back, and only the latest read lands", async () => {
    const dispose = initAssistantIdentitySync();
    const first = resolveRead;
    resync.fire();
    const second = resolveRead;
    second(named("After resync"));
    first(named("Before resync"));
    await settle();

    expect(bridge.getIdentities).toHaveBeenCalledTimes(2);
    expect(useAssistantIdentityStore.getState().identities.global.name).toBe("After resync");
    dispose();
  });

  it("stops listening once disposed", async () => {
    const dispose = initAssistantIdentitySync();
    dispose();
    expect(listener).toBeNull();
    expect(resync.size()).toBe(0);
    resolveRead(named("Late"));
    await settle();

    expect(useAssistantIdentityStore.getState().identities).toEqual(EMPTY_ASSISTANT_IDENTITIES);
  });
});
