// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WorkspaceTile } from "../WorkspaceTile";

afterEach(cleanup);

describe("WorkspaceTile", () => {
  it.each(["scratch", "unknown"] as const)(
    "inks the %s glyph tile with the icon-contrast token",
    (kind) => {
      const { container } = render(
        <WorkspaceTile group={{ kind, emoji: undefined, color: undefined } as never} />
      );
      const tile = container.firstElementChild!;
      expect(tile.getAttribute("class")).toContain("text-text-secondary");
      expect(tile.getAttribute("class")).not.toContain("text-muted-foreground");
    }
  );
});
