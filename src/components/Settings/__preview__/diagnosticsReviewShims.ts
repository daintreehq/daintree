// The dev CSP requires Trusted Types; the app installs its default policy at boot.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `diagnosticsReviewDialogPreview.tsx`, so the bridge shim is
// on `window` before the diagnostics store and its clients evaluate.
installPreviewShims();
