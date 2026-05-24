import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const DND_PROVIDER_PATH = path.resolve(__dirname, "../DndProvider.tsx");

// Static-source guard for issue #8942 — dnd-kit's DndContext unconditionally
// renders its own aria-live announcer, which competes with the sidebar's custom
// Alt+Arrow reorder live regions and drops announcements. The provider must
// portal that announcer into a STABLE detached node (via the accessibility
// `container` prop) so it never reaches the accessibility tree. A fresh element
// per render would re-portal the announcer and reintroduce the priming deficit,
// so the container must come from a useRef initialized once — never an inline
// document.createElement in the JSX prop. Full DndProvider mount requires
// mocking 10+ modules (see DndProvider.trashDrop.test.ts), so this guards the
// invariant statically like DndProvider.worktreeSortSnapshot.test.ts.
describe("DndProvider accessibility container — issue #8942", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(DND_PROVIDER_PATH, "utf-8");
  });

  it("declares a stable ref holding a detached element for dnd-kit's announcer", () => {
    expect(source).toMatch(
      /const\s+dndAccessibilityContainerRef\s*=\s*useRef<Element>\(\s*document\.createElement\("div"\)\s*\)/
    );
  });

  it("passes the ref's current element to the accessibility container prop", () => {
    expect(source).toMatch(/container:\s*dndAccessibilityContainerRef\.current/);
  });

  it("does not create the container inline in the accessibility prop", () => {
    // An inline document.createElement on the container line would be re-created
    // every render, defeating the fix. The createElement must live in the ref
    // initializer, not next to `container:`.
    expect(source).not.toMatch(/container:\s*document\.createElement/);
  });

  it("keeps the existing custom announcements and screen-reader instructions", () => {
    // The detached container silences dnd-kit's live region from the AT; the
    // custom announcement/instruction generation stays wired so behavior is
    // unchanged for any consumer that reads them.
    expect(source).toMatch(/announcements:\s*dragAnnouncements/);
    expect(source).toMatch(/screenReaderInstructions:\s*dragScreenReaderInstructions/);
  });
});
