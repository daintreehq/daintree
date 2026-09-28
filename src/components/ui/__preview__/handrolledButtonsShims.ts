import "@/components/Onboarding/__preview__/firstRunShims";
import { requireFixture } from "@/components/Terminal/__preview__/resumeSessionFixtures";

// Imported first by `handrolledButtonsPreview.tsx`. The first-run shim answers
// `system` (health-check specs, CLI availability), `onboarding` and
// `agentSettings` for real and degrades every other namespace to inert. The one
// more namespace this page needs is the session journal behind
// `ResumeSessionLine`: an inert answer there renders nothing at all.
//
// The installed bridge is a Proxy with no `set` trap, so assigning through it
// writes onto its override target, where its `get` trap then finds it.
const bridge: unknown = Reflect.get(window, "electron");
if (bridge && typeof bridge === "object" && !("agentSessionHistory" in bridge)) {
  const sessions = requireFixture("populated").sessions;
  Reflect.set(bridge, "agentSessionHistory", { list: () => Promise.resolve(sessions) });
}
