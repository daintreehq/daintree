import { describe, it, expect } from "vitest";
import { detectWslPath } from "../wsl.js";

describe("detectWslPath", () => {
  it("returns null for plain Windows drive paths", () => {
    expect(detectWslPath("C:\\repos\\project")).toBeNull();
  });

  it("returns null for POSIX paths", () => {
    expect(detectWslPath("/home/user/project")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectWslPath("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(detectWslPath(undefined as unknown as string)).toBeNull();
    expect(detectWslPath(null as unknown as string)).toBeNull();
  });

  it("parses \\\\wsl$\\<distro>\\<path>", () => {
    const result = detectWslPath("\\\\wsl$\\Ubuntu\\home\\user\\project");
    expect(result).toEqual({ distro: "Ubuntu", posixPath: "/home/user/project" });
  });

  it("parses \\\\wsl.localhost\\<distro>\\<path>", () => {
    const result = detectWslPath("\\\\wsl.localhost\\Debian\\home\\dev\\app");
    expect(result).toEqual({ distro: "Debian", posixPath: "/home/dev/app" });
  });

  it("preserves distro name case", () => {
    const result = detectWslPath("\\\\wsl$\\Ubuntu-22.04\\repos\\app");
    expect(result?.distro).toBe("Ubuntu-22.04");
  });

  it("matches case-insensitively on the wsl prefix", () => {
    expect(detectWslPath("\\\\WSL$\\Ubuntu\\home")).toEqual({
      distro: "Ubuntu",
      posixPath: "/home",
    });
    expect(detectWslPath("\\\\Wsl.LocalHost\\Ubuntu\\home")).toEqual({
      distro: "Ubuntu",
      posixPath: "/home",
    });
  });

  it("returns / for the distro root", () => {
    expect(detectWslPath("\\\\wsl$\\Ubuntu")).toEqual({
      distro: "Ubuntu",
      posixPath: "/",
    });
    expect(detectWslPath("\\\\wsl$\\Ubuntu\\")).toEqual({
      distro: "Ubuntu",
      posixPath: "/",
    });
  });

  it("translates separators inside subpaths", () => {
    expect(detectWslPath("\\\\wsl$\\Ubuntu\\home\\user\\my repo\\src")).toEqual({
      distro: "Ubuntu",
      posixPath: "/home/user/my repo/src",
    });
  });
});
