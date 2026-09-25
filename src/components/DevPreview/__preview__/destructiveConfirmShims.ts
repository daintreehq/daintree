// Before anything can write to a TT-gated DOM sink: Radix injects a `<style>`
// through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type {
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
} from "@shared/types/ipc/devPreview";
import {
  DESTRUCTIVE_FIXTURES,
  isDestructiveFixtureName,
  type DestructiveConfirmFixture,
} from "./destructiveConfirmFixtures";

/**
 * Answers the dialog's two bridge reads — directory metadata and the slower size
 * walk — from the `?fixture=` state, each able to hang or reject. Imported first by
 * `destructiveConfirmPreview.tsx`, so the bridge exists before any store module
 * evaluates.
 */

const fixtureParam = new URLSearchParams(window.location.search).get("fixture") ?? "";
export const fixture: DestructiveConfirmFixture =
  DESTRUCTIVE_FIXTURES[isDestructiveFixtureName(fixtureParam) ? fixtureParam : "cache-populated"];

const never = <T>() => new Promise<T>(() => {});

function resolveMeta(): Promise<DevPreviewDestructivePreviewMeta> {
  const spec = fixture.meta;
  if (spec === "hang") return never();
  if (spec === "error") {
    return Promise.reject(
      new Error("ENOENT: no such file or directory, scandir '/Users/you/code/orchid-studio'")
    );
  }
  const now = Date.now();
  const stamp = (age: number | null) => (age === null ? null : now - age);
  return Promise.resolve({
    cwd: spec.cwd,
    packageManager: spec.packageManager,
    lockfileName: spec.lockfileName,
    cacheDirs: spec.cacheDirs.map((d) => ({
      relPath: d.relPath,
      exists: d.age !== null,
      mtimeMs: stamp(d.age),
    })),
    nodeModules: {
      relPath: "node_modules",
      exists: spec.nodeModulesAge !== null,
      mtimeMs: stamp(spec.nodeModulesAge),
    },
  });
}

function resolveSizes(): Promise<DevPreviewDestructivePreviewSizes> {
  const spec = fixture.sizes;
  if (spec === "hang") return never();
  if (spec === "error") return Promise.reject(new Error("EACCES: permission denied"));
  return Promise.resolve(spec);
}

installPreviewShims({
  devPreview: new Proxy(
    { getDestructivePreviewMeta: resolveMeta, getDestructivePreviewSizes: resolveSizes },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
    }
  ),
});
