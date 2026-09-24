import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `updateCwdPreview.tsx`, so the shim is on `window` before
// any store module evaluates.
//
// `system.checkDirectory` is the one call answered for real: the dialog's whole
// validation path hangs off it, and the inert shim's `undefined` would read as
// "doesn't exist" for every path, which is one state dressed up as all of them.
// `?check=` picks the answer: `ok` (default), `missing`, or `hang`.
const params = new URLSearchParams(window.location.search);
const check = params.get("check") ?? "ok";

const inertNamespace = new Proxy({}, { get: () => () => Promise.resolve(undefined) });

const isHarness = !Reflect.get(window, "electron");
installPreviewShims({
  system: new Proxy(
    {
      checkDirectory: () =>
        check === "hang"
          ? new Promise<boolean>(() => undefined)
          : Promise.resolve(check !== "missing"),
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
