import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ failXterm: false }));

vi.mock("@xterm/xterm", () => ({ Terminal: class FakeTerminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FakeFit {} }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class FakeSerialize {} }));
vi.mock("@xterm/addon-web-links", () => ({
  get WebLinksAddon() {
    if (m.failXterm) throw new Error("chunk load failed");
    return class FakeWebLinks {};
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { __testing, getLoadedXtermCore, loadXtermCore } from "../xtermCore";

describe("xtermCore", () => {
  beforeEach(() => {
    __testing.reset();
    m.failXterm = false;
  });

  it("refuses synchronous use before the core has loaded", () => {
    expect(() => getLoadedXtermCore()).toThrow(/before loadXtermCore/);
  });

  it("shares one load between concurrent callers and caches the result", async () => {
    const [a, b] = await Promise.all([loadXtermCore(), loadXtermCore()]);
    expect(a).toBe(b);
    expect(await loadXtermCore()).toBe(a);
    expect(getLoadedXtermCore()).toBe(a);
    expect(a.Terminal.name).toBe("FakeTerminal");
    expect(a.FitAddon.name).toBe("FakeFit");
    expect(a.SerializeAddon.name).toBe("FakeSerialize");
    expect(a.WebLinksAddon.name).toBe("FakeWebLinks");
  });

  it("lets a later call retry after a failed load", async () => {
    m.failXterm = true;
    await expect(loadXtermCore()).rejects.toThrow("chunk load failed");
    expect(() => getLoadedXtermCore()).toThrow();

    m.failXterm = false;
    const core = await loadXtermCore();
    expect(core.WebLinksAddon.name).toBe("FakeWebLinks");
  });
});
