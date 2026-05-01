import fs from "node:fs";
import path from "node:path";

export function isWebGLHardwareAccelerated(webgl2: unknown): boolean {
  if (typeof webgl2 !== "string") return true;
  return webgl2.startsWith("enabled") && webgl2 !== "enabled_readback";
}

const VENDOR_NVIDIA = "0x10de";
const VENDOR_AMD = "0x1002";
const VENDOR_INTEL = "0x8086";
const DRM_PATH = "/sys/class/drm";

export interface LinuxGpuInfo {
  isMultiGpu: boolean;
  hasNvidia: boolean;
  hasAmd: boolean;
  hasIntel: boolean;
}

function readVendorId(nodeName: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(DRM_PATH, nodeName, "device", "vendor"), "utf8");
    return raw.trim().toLowerCase();
  } catch {
    return null;
  }
}

function listDrmNodes(filter: RegExp): string[] {
  try {
    return fs.readdirSync(DRM_PATH).filter((n) => filter.test(n));
  } catch {
    return [];
  }
}

export function detectLinuxGpus(): LinuxGpuInfo | null {
  if (process.platform !== "linux") return null;
  try {
    if (!fs.existsSync(DRM_PATH)) return null;
  } catch {
    return null;
  }

  // Union render and card nodes: some NVIDIA driver configurations expose a
  // `card1` for the dGPU without a corresponding `renderD129`, which would
  // make a render-only scan miss the second vendor and falsely report
  // single-GPU. Reading both kinds and deduping by vendor ID is safe — we
  // only care about the set of distinct vendors.
  const renderNodes = listDrmNodes(/^renderD\d+$/);
  const cardNodes = listDrmNodes(/^card\d+$/);
  const nodes = [...renderNodes, ...cardNodes];
  if (nodes.length === 0) return null;

  const vendors = new Set<string>();
  for (const node of nodes) {
    const v = readVendorId(node);
    if (v) vendors.add(v);
  }

  return {
    isMultiGpu: vendors.size >= 2,
    hasNvidia: vendors.has(VENDOR_NVIDIA),
    hasAmd: vendors.has(VENDOR_AMD),
    hasIntel: vendors.has(VENDOR_INTEL),
  };
}

export function isLinuxWaylandHybridGpu(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.XDG_SESSION_TYPE !== "wayland") return false;
  const info = detectLinuxGpus();
  if (!info) return false;
  return info.hasNvidia && (info.hasIntel || info.hasAmd);
}
