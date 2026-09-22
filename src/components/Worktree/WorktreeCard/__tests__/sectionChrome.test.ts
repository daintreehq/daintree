import { describe, it, expect } from "vitest";
import { CARD_DENSITY } from "../sectionChrome";

const padY = (classes: string) => classes.match(/(?:^|\s)(py-[\w.[\]]+)/)?.[1];

describe("CARD_DENSITY session rows", () => {
  // A session row sits directly under the disclosure row that owns it. At a
  // different height the children read heavier than their parent, which is
  // how the list came to spend 40px a row against its trigger's 26.
  it.each(Object.entries(CARD_DENSITY))(
    "%s: a session row is padded like the disclosure row above it",
    (_name, density) => {
      expect(padY(density.rowBox)).toBeDefined();
      expect(density.sessionRowY).toBe(padY(density.rowBox));
    }
  );
});
