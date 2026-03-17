// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NewsletterStep } from "../NewsletterStep";

const openExternalMock = vi.fn(() => Promise.resolve());

vi.stubGlobal("window", {
  ...window,
  electron: {
    system: { openExternal: openExternalMock },
  },
});

describe("NewsletterStep", () => {
  const onDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the subscribe button without an email input", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeTruthy();
  });

  it("subscribe button is enabled by default", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", false);
  });

  it("calls openExternal with hosted subscribe URL and onDismiss(true) on subscribe", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(openExternalMock).toHaveBeenCalledOnce();
    expect(openExternalMock).toHaveBeenCalledWith("https://subscribepage.io/canopy");
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it("calls onDismiss(false) on 'No thanks' without calling openExternal", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("calls onDismiss(false) on dismiss X button without calling openExternal", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));

    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});
