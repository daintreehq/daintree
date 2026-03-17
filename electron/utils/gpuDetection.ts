export function isWebGLHardwareAccelerated(webgl2: unknown): boolean {
  if (typeof webgl2 !== "string") return true;
  return webgl2.startsWith("enabled") && webgl2 !== "enabled_readback";
}
