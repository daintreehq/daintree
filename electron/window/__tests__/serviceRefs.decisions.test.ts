import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetDecisionsModuleForTesting,
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
