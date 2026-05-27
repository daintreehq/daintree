// ariaNotify is a Chromium-only API (shipped in Chrome 141; available in
// Chromium 146 / Electron 41) that queues screen-reader announcements
// natively, bypassing the `aria-modal` subtree filter that suppresses
// out-of-modal `aria-live` regions on VoiceOver (Chromium issue 354736464).
// Declared optional so all call sites must feature-detect.

type AriaNotifyPriority = "normal" | "high";

interface AriaNotifyOptions {
  priority?: AriaNotifyPriority;
}

interface Document {
  ariaNotify?(message: string, options?: AriaNotifyOptions): void;
}
