// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeInTheDocument();
  });

  it("disables Subscribe button when email is empty", () => {
    render(<NewsletterStep onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();
  });

  it("disables Subscribe button for whitespace-only input", async () => {
    const user = userEvent.setup();
    render(<NewsletterStep onDismiss={onDismiss} />);
    await user.type(screen.getByLabelText("Email address"), "   ");
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();
  });

  it("enables Subscribe button after typing a valid email", async () => {
    const user = userEvent.setup();
    render(<NewsletterStep onDismiss={onDismiss} />);
    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();
  });

  it("calls openExternal with correct MailerLite URL and onDismiss(true) on subscribe", async () => {
    const user = userEvent.setup();
    render(<NewsletterStep onDismiss={onDismiss} />);
    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(openExternalMock).toHaveBeenCalledOnce();
    const calledUrl = new URL(openExternalMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      "https://assets.mailerlite.com/jsonp/1076771/forms/182133737563097046/subscribe"
    );
    expect(calledUrl.searchParams.get("fields[email]")).toBe("test@example.com");
    expect(calledUrl.searchParams.get("ml-submit")).toBe("1");
    expect(calledUrl.searchParams.get("anticsrf")).toBe("true");
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it("calls onDismiss(false) on 'No thanks' without calling openExternal", async () => {
    const user = userEvent.setup();
    render(<NewsletterStep onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "No thanks" }));

    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("calls onDismiss(false) on dismiss X button without calling openExternal", async () => {
    const user = userEvent.setup();
    render(<NewsletterStep onDismiss={onDismiss} />);
    await user.click(screen.getByLabelText("Dismiss"));

    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});
