// Before anything can write to a TT-gated DOM sink: Radix injects a `<style>`
// through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `clearLogsConfirmPreview.tsx`, so the bridge exists before
// `ActionService` and the stores it reaches evaluate.
installPreviewShims();
