import { afterEach, describe, expect, it } from "vitest";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { validateHostFolderName } from "../validateHostFolderName";

const threeHundredBytes = "あ".repeat(100);

describe("validateHostFolderName", () => {
  afterEach(() => {
    _resetHostPlatformForTests();
  });

  it("applies Linux's byte limit in a view bound to a Linux host", () => {
    setHostPlatformInfo({ platform: "linux" });
    expect(validateHostFolderName(threeHundredBytes)).toMatch(/too long.*255.*byte/i);
  });

  it("counts characters in a view bound to a macOS host", () => {
    setHostPlatformInfo({ platform: "darwin" });
    expect(validateHostFolderName(threeHundredBytes)).toBeNull();
  });

  it("counts characters in a view bound to a Windows host", () => {
    setHostPlatformInfo({ platform: "win32" });
    expect(validateHostFolderName(threeHundredBytes)).toBeNull();
  });

  it("keeps every other rule", () => {
    setHostPlatformInfo({ platform: "linux" });
    expect(validateHostFolderName("foo/bar")).toBe("Folder name must not contain path separators");
  });
});
