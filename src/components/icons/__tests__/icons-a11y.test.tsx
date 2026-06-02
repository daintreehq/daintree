// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DaintreeIcon } from "../DaintreeIcon";
import {
  SpinnerCircle as DirectSpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
} from "../AgentStateCircles";
// Re-imported via the barrel to regression-test `export * from "./AgentStateCircles"`.
import { SpinnerCircle } from "../index";
import { ClaudeIcon } from "../brands/ClaudeIcon";
import { NpmIcon } from "../brands/NpmIcon";
import { InterpreterIcon } from "../brands/InterpreterIcon";
import { GooseIcon } from "../brands/GooseIcon";
import { PythonIcon } from "../brands/PythonIcon";
import { DockerIcon } from "../brands/DockerIcon";
import { AiderIcon } from "../brands/AiderIcon";

describe("DaintreeIcon a11y", () => {
  it("is decorative and exposes no aria-label", () => {
    const { container } = render(<DaintreeIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("aria-label")).toBe(false);
  });
});

describe("AgentStateCircles a11y", () => {
  it.each([
    ["SpinnerCircle", DirectSpinnerCircle],
    ["HollowCircle", HollowCircle],
    ["InteractingCircle", InteractingCircle],
    ["ExitedCircle", ExitedCircle],
  ])("%s defaults to aria-hidden='true'", (_name, Component) => {
    const { container } = render(<Component />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["SpinnerCircle", DirectSpinnerCircle],
    ["HollowCircle", HollowCircle],
    ["InteractingCircle", InteractingCircle],
    ["ExitedCircle", ExitedCircle],
  ])("%s allows callers to override aria-hidden and supply a label", (_name, Component) => {
    const { container } = render(
      <Component aria-hidden={undefined} role="img" aria-label="Working" />
    );
    const svg = container.querySelector("svg");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Working");
  });

  it("re-exports SpinnerCircle through the barrel", () => {
    expect(SpinnerCircle).toBe(DirectSpinnerCircle);
    const { container } = render(<SpinnerCircle />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Brand icon a11y", () => {
  it.each([
    ["ClaudeIcon", ClaudeIcon],
    ["NpmIcon", NpmIcon],
    ["InterpreterIcon", InterpreterIcon],
    ["GooseIcon", GooseIcon],
    ["PythonIcon", PythonIcon],
    ["DockerIcon", DockerIcon],
  ])("%s defaults to aria-hidden and forwards arbitrary SVG props", (_name, Icon) => {
    const { container } = render(<Icon className="size-4" data-testid="icon-under-test" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("size-4");
    expect(svg?.getAttribute("data-testid")).toBe("icon-under-test");
  });

  it.each([
    ["ClaudeIcon", ClaudeIcon],
    ["InterpreterIcon", InterpreterIcon],
    ["GooseIcon", GooseIcon],
  ])("%s allows overriding aria-hidden when used as the sole label", (_name, Icon) => {
    const { container } = render(
      <Icon aria-hidden={undefined} role="img" aria-label="Brand mark" />
    );
    const svg = container.querySelector("svg");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
    expect(svg?.getAttribute("aria-label")).toBe("Brand mark");
  });

  it("ClaudeIcon still honours brandColor after the type widening", () => {
    const { container } = render(<ClaudeIcon brandColor="#FF0000" />);
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("fill")).toBe("#FF0000");
  });

  it("AiderIcon preserves fill='none' (stroke-only icon)", () => {
    const { container } = render(<AiderIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });
});
