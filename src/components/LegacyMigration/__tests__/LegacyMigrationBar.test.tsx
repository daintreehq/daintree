// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LegacyMigrationBar } from "../LegacyMigrationBar";

const openExternalMock = vi.fn<(url: string) => Promise<void>>();

vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    openExternal: (url: string) => openExternalMock(url),
  },
}));

describe("LegacyMigrationBar", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    openExternalMock.mockResolvedValue(undefined);
  });

  it("renders a migration message and Download + Why? actions", () => {
    render(<LegacyMigrationBar />);

    expect(screen.getByTestId("legacy-migration-bar")).toBeTruthy();
    expect(screen.getByRole("region", { name: /migrate to daintree/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /download daintree/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /why\?/i })).toBeTruthy();
  });

  it("opens the Daintree download page when the CTA is clicked", () => {
    render(<LegacyMigrationBar />);

    fireEvent.click(screen.getByRole("button", { name: /download daintree/i }));

    expect(openExternalMock).toHaveBeenCalledWith("https://daintree.org");
  });

  it("opens the migration explainer when Why? is clicked", () => {
    render(<LegacyMigrationBar />);

    fireEvent.click(screen.getByRole("button", { name: /why\?/i }));

    expect(openExternalMock).toHaveBeenCalledWith("https://daintree.org/canopy-migration");
  });

  it("has no dismiss control (bar is permanent)", () => {
    render(<LegacyMigrationBar />);

    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn.getAttribute("aria-label") ?? "").not.toMatch(/dismiss|close/i);
      expect(btn.textContent ?? "").not.toMatch(/dismiss|close/i);
    }
  });
});
