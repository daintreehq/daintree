// Before anything can write to a TT-gated DOM sink: Radix menus inject a
// `<style>` through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FIXTURES, isFixtureName } from "./fixtures";

// Imported first by `preview.tsx`, so the bridge answers with the fixture's dev
// sessions before `allDevSessionsStore` subscribes. Only ever a harness: with a
// real bridge on the window this page is running inside the app.
const isHarness = !Reflect.get(window, "electron");
const requested = new URLSearchParams(window.location.search).get("fixture") ?? "";
const sessions = isFixtureName(requested) ? (FIXTURES[requested].devSessions ?? []) : [];

installPreviewShims({
  devPreview: new Proxy(
    {
      getAllSessions: () => Promise.resolve(sessions),
      onAllSessionsChanged: () => () => {},
    },
    {
      get: (target, key) =>
        key in target
          ? Reflect.get(target, key)
          : () =>
              Object.assign(() => undefined, { then: (r: (v: unknown) => void) => r(undefined) }),
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
