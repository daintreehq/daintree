import { beforeEach, describe, expect, it } from "vitest";
import { EXCHANGE_TTL_MS } from "../../exchange/AssistantExchangeStore.js";
import { AssistantShellRoutes, SHELL_ROUTES_MAX } from "../AssistantShellRoutes.js";

const REMOTE = { projectId: "web", slot: 0 };
const ASKER = { projectId: "proj-1", slot: 0 };
const OTHER_ASKER = { projectId: "proj-3", slot: 2 };

describe("AssistantShellRoutes (#13468)", () => {
  let clock: number;
  let routes: AssistantShellRoutes;

  beforeEach(() => {
    clock = 1_000_000;
    routes = new AssistantShellRoutes({ now: () => clock });
  });

  it("answers the lane that last spoke to a host lane, and null for one nobody did", () => {
    expect(routes.askerFor("studio", REMOTE)).toBeNull();
    routes.remember("studio", REMOTE, ASKER);
    expect(routes.askerFor("studio", REMOTE)).toEqual(ASKER);
  });

  it("keeps the lane only, not the run that asked", () => {
    routes.remember("studio", REMOTE, {
      ...ASKER,
      sessionId: "s",
      terminalId: "t",
      launchGeneration: 3,
    } as typeof ASKER);
    expect(routes.askerFor("studio", REMOTE)).toEqual(ASKER);
  });

  it("keeps each host and each remote lane apart", () => {
    routes.remember("studio", REMOTE, ASKER);
    routes.remember("laptop", REMOTE, OTHER_ASKER);
    routes.remember("studio", { projectId: "web", slot: 1 }, OTHER_ASKER);
    expect(routes.askerFor("studio", REMOTE)).toEqual(ASKER);
    expect(routes.askerFor("laptop", REMOTE)).toEqual(OTHER_ASKER);
    expect(routes.askerFor("studio", { projectId: "web", slot: 1 })).toEqual(OTHER_ASKER);
    expect(routes.askerFor("studio", { projectId: "api", slot: 0 })).toBeNull();
  });

  it("follows the latest asker of a host lane", () => {
    routes.remember("studio", REMOTE, ASKER);
    routes.remember("studio", REMOTE, OTHER_ASKER);
    expect(routes.askerFor("studio", REMOTE)).toEqual(OTHER_ASKER);
  });

  it("lapses with the exchange TTL, and a fresh remember restarts it", () => {
    routes.remember("studio", REMOTE, ASKER);
    clock += EXCHANGE_TTL_MS;
    expect(routes.askerFor("studio", REMOTE)).toEqual(ASKER);
    clock += 1;
    expect(routes.askerFor("studio", REMOTE)).toBeNull();

    routes.remember("studio", REMOTE, ASKER);
    clock += EXCHANGE_TTL_MS - 1;
    routes.remember("studio", REMOTE, OTHER_ASKER);
    clock += 2;
    expect(routes.askerFor("studio", REMOTE)).toEqual(OTHER_ASKER);
  });

  it("forgets the oldest route past its cap", () => {
    for (let i = 0; i < SHELL_ROUTES_MAX; i++) {
      routes.remember("studio", { projectId: `p-${i}`, slot: 0 }, ASKER);
    }
    // Refreshing the first moves it to the newest, so the second is the oldest now.
    routes.remember("studio", { projectId: "p-0", slot: 0 }, OTHER_ASKER);
    routes.remember("studio", { projectId: "overflow", slot: 0 }, ASKER);
    expect(routes.askerFor("studio", { projectId: "p-1", slot: 0 })).toBeNull();
    expect(routes.askerFor("studio", { projectId: "p-0", slot: 0 })).toEqual(OTHER_ASKER);
    expect(routes.askerFor("studio", { projectId: "p-2", slot: 0 })).toEqual(ASKER);
    expect(routes.askerFor("studio", { projectId: "overflow", slot: 0 })).toEqual(ASKER);
  });

  it("drops every host but the ones this Shell still has", () => {
    routes.remember("studio", REMOTE, ASKER);
    routes.remember("laptop", REMOTE, OTHER_ASKER);
    routes.retainHosts(new Set(["laptop"]));
    expect(routes.askerFor("studio", REMOTE)).toBeNull();
    expect(routes.askerFor("laptop", REMOTE)).toEqual(OTHER_ASKER);
  });

  it("clears every route", () => {
    routes.remember("studio", REMOTE, ASKER);
    routes.remember("laptop", REMOTE, OTHER_ASKER);
    routes.clear();
    expect(routes.askerFor("studio", REMOTE)).toBeNull();
    expect(routes.askerFor("laptop", REMOTE)).toBeNull();
  });
});
