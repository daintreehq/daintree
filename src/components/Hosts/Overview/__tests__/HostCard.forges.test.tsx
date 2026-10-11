// @vitest-environment jsdom
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { describe, expect, it } from "vitest";
import { HostCard } from "../HostCard";
import { makeRow, makeSummary } from "./fixtures";

// The app mounts one TooltipProvider at its root; truncated text discloses through it.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

describe("HostCard forge connections", () => {
  it("shows what the host reports for each forge, naming the host in full", async () => {
    const summary = makeSummary({
      forges: [
        {
          providerId: "daintree.github.github",
          name: "GitHub",
          hasCredential: true,
          account: "greg",
        },
        {
          providerId: "daintree.gitlab.gitlab",
          name: "GitLab",
          hasCredential: false,
          account: null,
        },
      ],
    });
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("Forges");
    expect(card.textContent).toContain("GitHub as greg · GitLab not connected");
    const value = [...card.querySelectorAll("dd")].find((dd) =>
      dd.textContent?.startsWith("GitHub")
    );
    fireEvent.focus(value!);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "GitHub: Signed in as greg on studio-01. GitLab: GitLab isn't connected on studio-01"
    );
    expect(value?.className).not.toMatch(/accent/);
  });

  it("shows no forge line for a host that doesn't report one", () => {
    const summary = makeSummary();
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    expect(screen.getByTestId("host-overview-card").textContent).not.toContain("Forges");
  });
});
