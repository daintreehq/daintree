import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `updateCwdPreview.tsx`, so the shim is on `window` before
// any store module evaluates.
//
// `system.checkDirectory` is the one call answered for real: the dialog's whole
// validation path, and its folder suggestions, hang off it. The inert shim's
// `undefined` would read as "doesn't exist" for every path, which is one state
// dressed up as all of them. The fixture folders' leaves are missing and their
// ancestors exist, as after a real worktree delete. `?check=` varies the rest:
// `hang` holds the project root's check open, `error` rejects submitted checks.
const params = new URLSearchParams(window.location.search);
const check = params.get("check") ?? "ok";
const MISSING = ["fix-auth-refresh", "fix-auth-refrsh", "handback-marker-contract"];
export const HANG_PATH = "/Users/greg/Projects/daintree/packages";

function checkDirectory(path: string): Promise<boolean> {
  if (check === "hang" && path === HANG_PATH) return new Promise<boolean>(() => undefined);
  if (check === "error" && path === HANG_PATH) {
    return Promise.reject(new Error("EACCES: permission denied"));
  }
  return Promise.resolve(!MISSING.some((leaf) => path.includes(leaf)));
}

const inertNamespace = new Proxy({}, { get: () => () => Promise.resolve(undefined) });

const isHarness = !Reflect.get(window, "electron");
installPreviewShims({
  system: new Proxy(
    {
      checkDirectory,
      getHomeDir: () => Promise.resolve("/Users/greg"),
    },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : Reflect.get(inertNamespace, key),
    }
  ),
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
