import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOnnxRuntimeForLinux } from "./afterPack.cjs";

// The layout onnxruntime-node 1.x ships under node_modules/onnxruntime-node/bin.
const SHIPPED = [
  "napi-v6/darwin/arm64/onnxruntime_binding.node",
  "napi-v6/darwin/arm64/libonnxruntime.1.dylib",
  "napi-v6/win32/x64/onnxruntime_binding.node",
  "napi-v6/win32/arm64/onnxruntime_binding.node",
  "napi-v6/linux/arm64/onnxruntime_binding.node",
  "napi-v6/linux/arm64/libonnxruntime.so.1",
  "napi-v6/linux/x64/onnxruntime_binding.node",
  "napi-v6/linux/x64/libonnxruntime.so.1",
  "napi-v6/linux/x64/libonnxruntime_providers_shared.so",
  "napi-v6/linux/x64/libonnxruntime_providers_cuda.so",
  "napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so",
];

describe("pruneOnnxRuntimeForLinux", () => {
  let unpacked: string;
  const binRoot = () => path.join(unpacked, "node_modules", "onnxruntime-node", "bin");
  const remaining = () => SHIPPED.filter((rel) => fs.existsSync(path.join(binRoot(), rel))).sort();

  beforeEach(() => {
    unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "onnx-prune-"));
    for (const rel of SHIPPED) {
      const file = path.join(binRoot(), rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
  });

  afterEach(() => fs.rmSync(unpacked, { recursive: true, force: true }));

  it("keeps only the target arch's CPU runtime", () => {
    pruneOnnxRuntimeForLinux(unpacked, ["x64"]);
    expect(remaining()).toEqual(
      [
        "napi-v6/linux/x64/onnxruntime_binding.node",
        "napi-v6/linux/x64/libonnxruntime.so.1",
        "napi-v6/linux/x64/libonnxruntime_providers_shared.so",
      ].sort()
    );
  });

  it("keeps arm64 for an arm64 package", () => {
    pruneOnnxRuntimeForLinux(unpacked, ["arm64"]);
    expect(remaining()).toEqual(
      [
        "napi-v6/linux/arm64/onnxruntime_binding.node",
        "napi-v6/linux/arm64/libonnxruntime.so.1",
      ].sort()
    );
  });

  it("fails the package when the target's binding is missing", () => {
    fs.rmSync(path.join(binRoot(), "napi-v6/linux/x64/onnxruntime_binding.node"));
    expect(() => pruneOnnxRuntimeForLinux(unpacked, ["x64"])).toThrow(
      /binding missing for linux-x64/
    );
  });

  it("does nothing without onnxruntime-node", () => {
    fs.rmSync(path.join(unpacked, "node_modules"), { recursive: true, force: true });
    expect(() => pruneOnnxRuntimeForLinux(unpacked, ["x64"])).not.toThrow();
  });
});
