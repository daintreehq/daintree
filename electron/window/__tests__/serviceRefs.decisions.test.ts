import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetDecisionsModuleForTesting,
  decisionsHostServes,
  decisionsServesPanes,
  decisionsWantedAtStartup,
  loadDecisionsModule,
  sealDecisionsModule,
} from "../serviceRefs.js";

type DecisionsModule = typeof import("../../services/decisions/index.js");

const fakeModule = {} as DecisionsModule;

describe("Decisions module loader", () => {
  afterEach(() => {
    _resetDecisionsModuleForTesting();
  });

  it("loads once and hands every later caller the same load", async () => {
    const load = vi.fn(async () => fakeModule);

    const first = loadDecisionsModule(load);
    const second = loadDecisionsModule(load);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(fakeModule);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps a finished load, so a later caller neither loads again nor gets a new promise", async () => {
    const first = loadDecisionsModule(async () => fakeModule);
    await first;

    const later = vi.fn(async () => fakeModule);
    expect(loadDecisionsModule(later)).toBe(first);
    expect(later).not.toHaveBeenCalled();
  });

  it("forgets a failed load, so the next caller retries", async () => {
    const failing = vi.fn(async (): Promise<DecisionsModule> => {
      throw new Error("chunk missing");
    });
    await expect(loadDecisionsModule(failing)).rejects.toThrow("chunk missing");

    const load = vi.fn(async () => fakeModule);
    await expect(loadDecisionsModule(load)).resolves.toBe(fakeModule);
    expect(load).toHaveBeenCalledOnce();
  });

  it("returns nothing to seal when nothing loaded it", () => {
    expect(sealDecisionsModule()).toBeNull();
  });

  it("hands quit the load already under way, then refuses every new one", async () => {
    const loading = loadDecisionsModule(async () => fakeModule);

    expect(sealDecisionsModule()).toBe(loading);

    const late = vi.fn(async () => fakeModule);
    expect(loadDecisionsModule(late)).toBeNull();
    expect(late).not.toHaveBeenCalled();
  });
});

describe("what Decisions runs, read before it loads (#16022)", () => {
  const RECORD = { deviceId: "dev_host_0001", ownerOffAt: null, revokedAt: null };

  it("serves panes with the owner's switch on, or as an enrolled Host its owner hasn't turned off", () => {
    expect(decisionsServesPanes(undefined, undefined)).toBe(false);
    expect(decisionsServesPanes({ enabled: true }, undefined)).toBe(true);
    expect(decisionsServesPanes({ enabled: false }, RECORD)).toBe(true);
    expect(decisionsServesPanes(undefined, { ...RECORD, ownerOffAt: 5 })).toBe(false);
    expect(decisionsServesPanes(undefined, { ...RECORD, revokedAt: 5 })).toBe(false);
    expect(decisionsHostServes({ ownerOffAt: null })).toBe(false);
    expect(decisionsHostServes("dev_host_0001")).toBe(false);
  });

  it("starts at boot to finish removing a revoked Host's keys, and never once they are gone", () => {
    expect(decisionsWantedAtStartup(undefined, { ...RECORD, revokedAt: 5 })).toBe(true);
    expect(
      decisionsWantedAtStartup(undefined, { ...RECORD, revokedAt: 5, credentialsRemovedAt: 6 })
    ).toBe(false);
    expect(decisionsWantedAtStartup(undefined, { ...RECORD, ownerOffAt: 5 })).toBe(false);
    expect(decisionsWantedAtStartup({ enabled: true }, undefined)).toBe(true);
  });
});
