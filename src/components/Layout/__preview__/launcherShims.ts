import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";

// Imported first by `preview.tsx`, so the shim is on `window` before any store module
// below it evaluates. ES modules run in import order, and a store that reads
// `window.electron` at module scope would otherwise throw before the harness could
// install anything.
// Only ever a harness: with a real bridge on the window this page is running
// inside the app, and clearing that origin's storage would be clearing the
// user's own persisted state.
const isHarness = !Reflect.get(window, "electron");
// Every agent already seen: the "new" dot is first-run discovery state, and with
// an empty onboarding record it would sit beside every name in every capture.
const onboarding = {
  get: async () => ({
    seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
    availabilityFirstSeen: {},
    welcomeCardDismissed: true,
    setupBannerDismissed: true,
  }),
};
installPreviewShims({
  onboarding: new Proxy(onboarding, {
    get: (target, key) => Reflect.get(target, key) ?? (async () => undefined),
  }),
});

// A harness page must never inherit persisted state. Several stores persist to
// localStorage, and one fixture's preference (pinned agents, the MRU)
// would otherwise ride into every page the same browser context loads after it.
if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
