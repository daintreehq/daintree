import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readdirSync: vi.fn<(p: string) => string[]>(),
  readFileSync: vi.fn<(p: string, enc: string) => string>(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: fsMock.existsSync,
    readdirSync: fsMock.readdirSync,
    readFileSync: fsMock.readFileSync,
  },
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  readFileSync: fsMock.readFileSync,
}));

const originalPlatform = process.platform;
const originalSessionType = process.env.XDG_SESSION_TYPE;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, writable: true });
}

describe("isWebGLHardwareAccelerated", () => {
  it("treats unknown values as accelerated (preserves prior behavior)", async () => {
    const { isWebGLHardwareAccelerated } = await import("../gpuDetection.js");
    expect(isWebGLHardwareAccelerated(undefined)).toBe(true);
    expect(isWebGLHardwareAccelerated("enabled")).toBe(true);
    expect(isWebGLHardwareAccelerated("enabled_readback")).toBe(false);
    expect(isWebGLHardwareAccelerated("disabled_software")).toBe(false);
  });
});

describe("detectLinuxGpus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("returns null on non-Linux platforms", async () => {
    setPlatform("darwin");
    const { detectLinuxGpus } = await import("../gpuDetection.js");
    expect(detectLinuxGpus()).toBeNull();
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it("returns null when /sys/class/drm does not exist", async () => {
    fsMock.existsSync.mockReturnValue(false);
    const { detectLinuxGpus } = await import("../gpuDetection.js");
    expect(detectLinuxGpus()).toBeNull();
  });

  it("detects NVIDIA + Intel hybrid via render nodes", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm") return ["card0", "renderD128", "renderD129"];
      return [];
    });
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info).toEqual({
      isMultiGpu: true,
      hasNvidia: true,
      hasAmd: false,
      hasIntel: true,
    });
  });

  it("detects NVIDIA + AMD hybrid via render nodes", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x1002\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info).toEqual({
      isMultiGpu: true,
      hasNvidia: true,
      hasAmd: true,
      hasIntel: false,
    });
  });

  it("falls back to card nodes when render nodes are absent", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["card0", "card1"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/card0/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/card1/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info?.isMultiGpu).toBe(true);
    expect(info?.hasNvidia).toBe(true);
    expect(info?.hasIntel).toBe(true);
  });

  it("unions render and card nodes when render-node visibility is partial", async () => {
    // Some NVIDIA driver setups expose card1 for the dGPU without a matching
    // renderD129. A render-only scan would miss the dGPU vendor entirely.
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["card0", "card1", "renderD128"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/card0/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/card1/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info).toEqual({
      isMultiGpu: true,
      hasNvidia: true,
      hasAmd: false,
      hasIntel: true,
    });
  });

  it("returns single-GPU info when only one vendor is present", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128"]);
    fsMock.readFileSync.mockReturnValue("0x8086\n");

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info).toEqual({
      isMultiGpu: false,
      hasNvidia: false,
      hasAmd: false,
      hasIntel: true,
    });
  });

  it("normalizes uppercase hex vendor IDs", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0X8086\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0X10DE\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info?.hasIntel).toBe(true);
    expect(info?.hasNvidia).toBe(true);
  });

  it("survives a malformed vendor file by skipping that node", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") {
        throw new Error("ENOENT");
      }
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    const info = detectLinuxGpus();
    expect(info).toEqual({
      isMultiGpu: false,
      hasNvidia: true,
      hasAmd: false,
      hasIntel: false,
    });
  });

  it("returns null when the drm directory exists but has no nodes", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([]);

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    expect(detectLinuxGpus()).toBeNull();
  });

  it("returns null when readdirSync throws", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    expect(detectLinuxGpus()).toBeNull();
  });

  it("returns null when existsSync itself throws (does not propagate)", async () => {
    fsMock.existsSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { detectLinuxGpus } = await import("../gpuDetection.js");
    expect(detectLinuxGpus()).toBeNull();
  });
});

describe("isLinuxWaylandHybridGpu", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    setPlatform("linux");
    process.env.XDG_SESSION_TYPE = "wayland";
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalSessionType === undefined) {
      delete process.env.XDG_SESSION_TYPE;
    } else {
      process.env.XDG_SESSION_TYPE = originalSessionType;
    }
  });

  it("returns false on macOS regardless of XDG_SESSION_TYPE", async () => {
    setPlatform("darwin");
    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it("returns false on Linux X11 (XDG_SESSION_TYPE != wayland)", async () => {
    process.env.XDG_SESSION_TYPE = "x11";
    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it("returns true on NVIDIA + Intel Wayland hybrid", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(true);
  });

  it("returns true on NVIDIA + AMD Wayland hybrid", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x1002\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x10de\n";
      throw new Error("unexpected read: " + p);
    });

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(true);
  });

  it("returns false on Intel-only Wayland", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128"]);
    fsMock.readFileSync.mockReturnValue("0x8086\n");

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
  });

  it("returns false on NVIDIA-only Wayland (not hybrid)", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128"]);
    fsMock.readFileSync.mockReturnValue("0x10de\n");

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
  });

  it("returns false on Intel + AMD (no NVIDIA, not the hybrid pattern we target)", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["renderD128", "renderD129"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/drm/renderD128/device/vendor") return "0x8086\n";
      if (p === "/sys/class/drm/renderD129/device/vendor") return "0x1002\n";
      throw new Error("unexpected read: " + p);
    });

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
  });

  it("returns false when DRM is unavailable (containers, missing /sys)", async () => {
    fsMock.existsSync.mockReturnValue(false);

    const { isLinuxWaylandHybridGpu } = await import("../gpuDetection.js");
    expect(isLinuxWaylandHybridGpu()).toBe(false);
  });
});
