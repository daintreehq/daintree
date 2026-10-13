// eager-import-allow: reads GPU info files via sync fs during detection
import { app } from "electron";
import fs from "node:fs";

/**
 * The WebGL entry of `app.getGPUFeatureStatus()`. Chromium 148 (Electron 42)
 * reports only `webgl`; older builds also reported `webgl2`. Reading `webgl2`
 * alone saw `undefined`, which counts as accelerated, so a machine with WebGL
 * blocklisted (no GPU, a VM, a blocklisted driver) kept retrying WebGL for every
 * terminal.
 */
export function getWebGLFeatureStatus(
  status: { webgl?: string; webgl2?: string } | null | undefined
): string | undefined {
  if (!status) return undefined;
  return status.webgl2 ?? status.webgl;
}

export function isWebGLHardwareAccelerated(webgl2: unknown): boolean {
  if (typeof webgl2 !== "string") return true;
  return webgl2.startsWith("enabled") && webgl2 !== "enabled_readback";
}

let cachedGpuFeatureStatus: ReturnType<typeof app.getGPUFeatureStatus> | null = null;
let gpuInfoSettled = false;

/**
 * The GPU process has reported (its gpu-info-update has gone quiet). Until
 * then `getGPUFeatureStatus()` is a provisional all-disabled status (seen on
 * Electron 42 with a working D3D12 GPU: webgl "disabled_off" before
 * "enabled"), which must not be kept for the session.
 */
export function markGpuInfoSettled(): void {
  gpuInfoSettled = true;
}

let gpuReported = false;
const gpuReportWaiters = new Set<() => void>();

/** The GPU process has sent its first gpu-info-update. */
export function noteGpuReported(): void {
  gpuReported = true;
  for (const wake of gpuReportWaiters) wake();
  gpuReportWaiters.clear();
}

/**
 * Resolves once the GPU process has reported, or after `timeoutMs`. Read the
 * feature status after this when the answer is handed to a renderer for good:
 * read earlier it is the provisional all-disabled status, and a view told
 * "WebGL isn't accelerated" keeps its terminals off WebGL for its lifetime.
 */
export function whenGpuReported(timeoutMs: number): Promise<void> {
  if (gpuReported) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      gpuReportWaiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    timer.unref?.();
    gpuReportWaiters.add(wake);
  });
}

/** The feature status, kept for the session once the GPU has been reported. */
export function getGpuFeatureStatus(): ReturnType<typeof app.getGPUFeatureStatus> {
  if (cachedGpuFeatureStatus) return cachedGpuFeatureStatus;
  const status = app.getGPUFeatureStatus();
  if (gpuInfoSettled) cachedGpuFeatureStatus = status;
  return status;
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
    const raw = fs.readFileSync(`${DRM_PATH}/${nodeName}/device/vendor`, "utf8");
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
