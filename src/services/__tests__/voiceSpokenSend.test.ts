import { describe, expect, it } from "vitest";
import { isSpokenSendable } from "../voiceSpokenSend";

describe("isSpokenSendable", () => {
  it("needs three words, a command, or more", () => {
    expect(isSpokenSendable("fix the bug")).toBe(true);
    expect(isSpokenSendable("fix it")).toBe(false);
    expect(isSpokenSendable("  ...  ")).toBe(false);
  });

  it("counts the words of a Chinese or Japanese passage, which has no spaces between them", () => {
    expect(isSpokenSendable("请把登录页面上的错误提示改成中文。")).toBe(true);
    expect(isSpokenSendable("テストを直してください")).toBe(true);
    expect(isSpokenSendable("好")).toBe(false);
  });

  it("counts mixed passages word by word across scripts", () => {
    expect(isSpokenSendable("请修复 useShallow 的问题")).toBe(true);
    expect(isSpokenSendable("修复 useShallow")).toBe(false);
  });
});
