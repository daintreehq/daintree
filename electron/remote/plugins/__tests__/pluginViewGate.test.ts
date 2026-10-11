import { describe, expect, it, vi } from "vitest";
import { createMemoryPluginViewConsent } from "../pluginViewConsent.js";
import {
  PluginViewGate,
  manifestDigest,
  type PluginViewManifest,
  type PluginViewQuestion,
} from "../pluginViewGate.js";

const HOST = "studio-01";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function manifest(files: Record<string, string>, pluginId = "acme.graph"): PluginViewManifest {
  return { pluginId, files: new Map(Object.entries(files)) };
}

function setup(ask: (q: PluginViewQuestion) => Promise<boolean>) {
  const consent = createMemoryPluginViewConsent();
  const asked = vi.fn(ask);
  const gate = new PluginViewGate({ consent, ask: asked });
  let listed = manifest({ "dist/view.js": SHA_A });
  const request = {
    hostId: HOST,
    authority: "pi-1",
    webContentsId: 7,
    loadManifest: async () => listed,
  };
  const file = (path: string, sha256: string, pluginId = "acme.graph") => ({
    ...request,
    pluginId,
    path,
    sha256,
  });
  return { gate, consent, asked, request, file, list: (m: PluginViewManifest) => (listed = m) };
}

describe("PluginViewGate", () => {
  it("refuses bytes the host labels as another plugin than the bundle allowed", async () => {
    const { gate, file, request } = setup(async () => true);
    expect(await gate.prepare(request)).toBe(true);
    expect(await gate.admit(file("dist/view.js", SHA_A))).toBe(true);
    expect(await gate.admit(file("dist/view.js", SHA_A, "acme.other"))).toBe(false);
  });

  it("refuses a file whose bytes differ from the list, even under an allowed bundle", async () => {
    const { gate, file, asked, request } = setup(async () => true);
    expect(await gate.prepare(request)).toBe(true);
    expect(await gate.admit(file("dist/view.js", SHA_A))).toBe(true);
    expect(await gate.admit(file("dist/view.js", SHA_B))).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks as changed, from prepare only, when the host's list no longer matches", async () => {
    const { gate, file, asked, list, consent, request } = setup(async () => true);
    await gate.prepare(request);
    list(manifest({ "dist/view.js": SHA_B }));
    // The file path never asks: the new code is refused until the view prepares again.
    expect(await gate.admit(file("dist/view.js", SHA_B))).toBe(false);
    expect(await gate.prepare(request)).toBe(true);
    expect(await gate.admit(file("dist/view.js", SHA_B))).toBe(true);
    expect(asked.mock.calls.map(([q]) => q.kind)).toEqual(["new", "changed"]);
    expect(consent.allowedDigest(HOST, "acme.graph")).toBe(
      manifestDigest(manifest({ "dist/view.js": SHA_B }))
    );
  });

  it("treats a question that throws as a no", async () => {
    const { gate, request } = setup(async () => {
      throw new Error("no window");
    });
    expect(await gate.prepare(request)).toBe(false);
    expect(gate.refusals(HOST)).toEqual(["acme.graph"]);
  });

  it("lets a reset void a question still open, whatever its answer", async () => {
    let answer!: (yes: boolean) => void;
    const { gate, file, consent, request } = setup(
      () => new Promise((resolve) => (answer = resolve))
    );
    const pending = gate.prepare(request);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    gate.revoke(HOST);
    answer(true);
    expect(await pending).toBe(false);
    expect(consent.allowedDigest(HOST, "acme.graph")).toBeNull();
    expect(gate.refusals(HOST)).toEqual([]);
    // Nothing was decided, so the next load asks afresh.
    void file;
  });

  it("forgets this run's no on revoke, so the plugin asks again", async () => {
    const { gate, request, asked } = setup(async () => false);
    expect(await gate.prepare(request)).toBe(false);
    expect(await gate.prepare(request)).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
    gate.revoke(HOST, "acme.graph");
    asked.mockImplementation(async () => true);
    expect(await gate.prepare(request)).toBe(true);
  });

  it("holds a no for the plugin whatever authority the host serves it under", async () => {
    const { gate, request, asked } = setup(async () => false);
    expect(await gate.prepare(request)).toBe(false);
    expect(await gate.prepare({ ...request, authority: "pi-2" })).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks one question for the same bundle loaded under two authorities at once", async () => {
    let answer!: (yes: boolean) => void;
    const { gate, request, asked } = setup(() => new Promise((resolve) => (answer = resolve)));
    const first = gate.prepare(request);
    const second = gate.prepare({ ...request, authority: "pi-2" });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    answer(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("refuses when the host can't list the bundle", async () => {
    const { gate, request } = setup(async () => true);
    expect(await gate.prepare({ ...request, loadManifest: async () => null })).toBe(false);
  });
});
