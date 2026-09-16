// Before anything else can write to a TT-gated DOM sink. The composer's agent
// picker is a Radix Select, whose Popper sets `innerHTML` on an injected
// `<style>`; without the app's default policy the first render of it throws and
// the harness mounts blank. `main.tsx` imports this first for the same reason.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { createPreviewHost, type PreviewHostHandle } from "./previewHost.js";
import { fixtureFor, isFixtureName } from "./fixtures.js";

// Imported first by `preview.tsx`: ES modules run in import order, and a store
// that reads `window.electron` at module scope would otherwise throw before the
// harness could install anything.
const isHarness = !Reflect.get(window, "electron");

const host = createPreviewHost();

// The fixture reshapes main's answers BEFORE anything mounts: a controller that
// has already asked for the workspace cannot be told a different one later.
const fixtureParam = new URLSearchParams(window.location.search).get("fixture") ?? "element";
if (isFixtureName(fixtureParam)) fixtureFor(fixtureParam).arrange?.(host);

installPreviewShims({ sitePreview: host.sitePreview, plugin: host.plugin });

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

export function getPreviewHost(): PreviewHostHandle {
  return host;
}
