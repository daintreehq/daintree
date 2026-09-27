// Before anything can write to a TT-gated DOM sink: Radix injects a `<style>`
// through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `emptyStatesPreview.tsx`, so the bridge stand-in is on
// `window` before any module that reads it evaluates.
installPreviewShims();
