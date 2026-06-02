import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

// Issue #9641: focus-mode gesture and the toolbar toggle are independent gates
// over Assistant visibility. AppLayout must snapshot the toolbar preference
// (helpPanelStore.isOpen) on gesture entry and restore it on exit — symmetric
// with the sidebar — without collapsing the two gates into one flag.
describe("AppLayout focus-mode assistant reconciliation — issue #9641", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("captures the toolbar isOpen preference at gesture entry and passes it to toggleFocusMode", () => {
    // The capture must read from the store imperatively (synchronously) at
    // entry so the value can't drift before the exit restores it.
    expect(source).toContain("const assistantWasOpen = useHelpPanelStore.getState().isOpen");
  });

  it("restores the assistant via helpPanelStore.setOpen on gesture exit", () => {
    expect(source).toContain("useHelpPanelStore.getState().setOpen(assistantWasOpen)");
  });

  it("gates the exit restore on the gesture having hidden the assistant", () => {
    // Symmetric with the sidebar revert ("the snapshot only owns the deltas it
    // caused"): an assistant the gesture never hid must not be touched on exit.
    expect(source).toContain("const restoreAssistant = snapshot.hidAssistant");
    expect(source).toMatch(/if \(restoreAssistant\) \{\s*\n\s*useHelpPanelStore\.getState\(\)\.setOpen/);
  });

  it("keeps the two visibility gates independent — showAssistant stays a compound predicate", () => {
    // The fix must not collapse helpPanelOpen and gestureAssistantHidden into a
    // single source of truth (locked decision on the issue).
    expect(source).toContain(
      "const showAssistant = !layout.gestureAssistantHidden && layout.helpPanelOpen"
    );
  });
});
