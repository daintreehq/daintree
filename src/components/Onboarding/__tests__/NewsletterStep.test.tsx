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

  it("renders the email input and subscribe button", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeTruthy();
  });

  it("disables Subscribe button when email is empty", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", true);
  });

  it("disables Subscribe button for whitespace-only input", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", true);
  });

  it("enables Subscribe button after typing a valid email", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "test@example.com" },
    });
    expect(screen.getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", false);
  });

  it("calls openExternal with correct MailerLite URL and onDismiss(true) on subscribe", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(openExternalMock).toHaveBeenCalledOnce();
    const firstCall = openExternalMock.mock.calls[0] as unknown as [string];
    const calledUrl = new URL(firstCall[0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      "https://assets.mailerlite.com/jsonp/1076771/forms/182133737563097046/subscribe"
    );
    expect(calledUrl.searchParams.get("fields[email]")).toBe("test@example.com");
    expect(calledUrl.searchParams.get("ml-submit")).toBe("1");
    expect(calledUrl.searchParams.get("anticsrf")).toBe("true");
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it("trims whitespace from email before constructing the URL", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "  test@example.com  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    const firstCall = openExternalMock.mock.calls[0] as unknown as [string];
    const calledUrl = new URL(firstCall[0]);
    expect(calledUrl.searchParams.get("fields[email]")).toBe("test@example.com");
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
