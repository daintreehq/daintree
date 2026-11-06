// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { hasAppModal, isInAppModal } from "../appModal";

describe("appModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["dialog", "alertdialog"])("counts a modal %s", (role) => {
    document.body.innerHTML = `<div role="${role}" aria-modal="true"><button id="b"></button></div><button id="out"></button>`;
    expect(hasAppModal()).toBe(true);
    expect(isInAppModal(document.getElementById("b"))).toBe(true);
    expect(isInAppModal(document.getElementById("out"))).toBe(false);
  });

  it.each(["dialog", "alertdialog"])("ignores a non-modal %s", (role) => {
    document.body.innerHTML = `<div role="${role}"><button id="b"></button></div>`;
    expect(hasAppModal()).toBe(false);
    expect(isInAppModal(document.getElementById("b"))).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isInAppModal(null)).toBe(false);
  });
});
