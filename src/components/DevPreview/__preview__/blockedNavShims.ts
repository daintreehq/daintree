import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported ahead of `./installShims` (which is a no-op once a bridge exists) so
// the one fixture that needs the system browser to refuse a link can say so.
// Every other `system` call answers the way the generic shim would.
const openExternalFails =
  new URLSearchParams(window.location.search).get("openExternal") === "reject";

if (openExternalFails) {
  installPreviewShims({
    system: new Proxy(
      { openExternal: () => Promise.reject(new Error("No application to open the link")) },
      {
        get: (target, key) =>
          key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
      }
    ),
  });
}
