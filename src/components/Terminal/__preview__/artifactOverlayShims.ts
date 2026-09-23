import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { ArtifactDetectedPayload } from "@shared/types";
import { APPLY_ERROR_MESSAGE } from "./artifactOverlayFixtures";

// Imported first by `artifactOverlay.tsx`, so the bridge is on `window` before
// any store or hook module evaluates.
//
// The artifact namespace is answered for real, because it IS the seam: the
// overlay's hook subscribes through `artifact.onDetected` exactly as it does in
// the app, and the harness delivers its fixtures by calling that subscription
// with an `artifact:detected` payload. Save and apply resolve or reject the way
// the preload's unwrapping invoke does, chosen by `?apply=` and `?save=`.

const params = new URLSearchParams(window.location.search);
const applyMode = params.get("apply") ?? "success";
const saveMode = params.get("save") ?? "success";

// A real `git apply` takes a beat; the delay lets the in-flight state paint.
const APPLY_LATENCY_MS = 60;

let detected: ((payload: ArtifactDetectedPayload) => void) | null = null;

export function emitArtifactsDetected(payload: ArtifactDetectedPayload): boolean {
  if (!detected) return false;
  detected(payload);
  return true;
}

function modifiedFilesFor(patchContent: string): string[] {
  const files = new Set<string>();
  for (const line of patchContent.split("\n")) {
    if (line.startsWith("+++ b/")) files.add(line.slice(6));
  }
  return [...files];
}

installPreviewShims({
  artifact: {
    onDetected: (callback: (payload: ArtifactDetectedPayload) => void) => {
      detected = callback;
      return () => {
        if (detected === callback) detected = null;
      };
    },
    saveToFile: (options: { suggestedFilename?: string }) =>
      saveMode === "error"
        ? Promise.reject(new Error("Save dialog could not be opened"))
        : Promise.resolve({
            filePath: `/Users/dev/Downloads/${options.suggestedFilename ?? "artifact.txt"}`,
          }),
    applyPatch: (options: { patchContent: string }) =>
      new Promise((resolve, reject) => {
        window.setTimeout(() => {
          if (applyMode === "error") reject(new Error(APPLY_ERROR_MESSAGE));
          else resolve({ modifiedFiles: modifiedFilesFor(options.patchContent) });
        }, APPLY_LATENCY_MS);
      }),
  },
});

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
