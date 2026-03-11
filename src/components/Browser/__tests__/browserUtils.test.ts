import { describe, it, expect } from "vitest";
import {
  normalizeBrowserUrl,
  isLocalhostUrl,
  isValidBrowserUrl,
  getDisplayUrl,
  extractHostPort,
} from "../browserUtils";

describe("normalizeBrowserUrl", () => {
  it("should normalize localhost URLs", () => {
    expect(normalizeBrowserUrl("localhost:3000").url).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("http://localhost:5173").url).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("https://localhost:8080").url).toBe("https://localhost:8080/");
  });

  it("should normalize 127.0.0.1 URLs", () => {
    expect(normalizeBrowserUrl("127.0.0.1:3000").url).toBe("http://127.0.0.1:3000/");
    expect(normalizeBrowserUrl("http://127.0.0.1:5173").url).toBe("http://127.0.0.1:5173/");
  });

  it("should handle IPv6 loopback hostname", () => {
    const result = normalizeBrowserUrl("http://::1:3000");
    expect(result.error).toBeTruthy();
  });

  it("should map 0.0.0.0 to localhost", () => {
    expect(normalizeBrowserUrl("0.0.0.0:3000").url).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("http://0.0.0.0:5173").url).toBe("http://localhost:5173/");
  });

  it("should auto-prepend http:// if no protocol", () => {
    expect(normalizeBrowserUrl("localhost:3000").url).toBe("http://localhost:3000/");
  });

  it("should reject non-localhost URLs", () => {
    expect(normalizeBrowserUrl("example.com").error).toBeTruthy();
    expect(normalizeBrowserUrl("http://example.com").error).toBeTruthy();
    expect(normalizeBrowserUrl("192.168.1.1").error).toBeTruthy();
  });

  it("should reject non-http(s) protocols", () => {
    expect(normalizeBrowserUrl("file:///path/to/file").error).toBeTruthy();
    expect(normalizeBrowserUrl("javascript:alert(1)").error).toBeTruthy();
    expect(normalizeBrowserUrl("ftp://localhost").error).toBeTruthy();
  });

  it("should strip username and password for security", () => {
    const result = normalizeBrowserUrl("http://user:pass@localhost:3000");
    expect(result.url).toBe("http://localhost:3000/");
    expect(result.url).not.toContain("user");
    expect(result.url).not.toContain("pass");
  });

  it("should reject empty URLs", () => {
    expect(normalizeBrowserUrl("").error).toBeTruthy();
    expect(normalizeBrowserUrl("   ").error).toBeTruthy();
  });

  it("should handle URLs with paths and query strings", () => {
    expect(normalizeBrowserUrl("localhost:3000/path?query=value").url).toBe(
      "http://localhost:3000/path?query=value"
    );
  });
});

describe("isLocalhostUrl", () => {
  it("should return true for localhost URLs", () => {
    expect(isLocalhostUrl("http://localhost:3000")).toBe(true);
    expect(isLocalhostUrl("https://localhost:8080")).toBe(true);
    expect(isLocalhostUrl("http://localhost/")).toBe(true);
  });

  it("should return true for 127.0.0.1 URLs", () => {
    expect(isLocalhostUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalhostUrl("https://127.0.0.1:8080")).toBe(true);
  });

  it("should handle IPv6 loopback hostname parsing", () => {
    expect(isLocalhostUrl("http://::1")).toBe(false);
  });

  it("should return false for non-localhost URLs", () => {
    expect(isLocalhostUrl("http://example.com")).toBe(false);
    expect(isLocalhostUrl("http://192.168.1.1")).toBe(false);
  });

  it("should return false for non-http(s) protocols", () => {
    expect(isLocalhostUrl("file:///path")).toBe(false);
    expect(isLocalhostUrl("ftp://localhost")).toBe(false);
  });

  it("should return false for invalid URLs", () => {
    expect(isLocalhostUrl("not a url")).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
  });
});

describe("isValidBrowserUrl", () => {
  it("should return true for valid localhost URLs", () => {
    expect(isValidBrowserUrl("localhost:3000")).toBe(true);
    expect(isValidBrowserUrl("http://localhost:5173")).toBe(true);
    expect(isValidBrowserUrl("127.0.0.1:8080")).toBe(true);
  });

  it("should return false for invalid URLs", () => {
    expect(isValidBrowserUrl("example.com")).toBe(false);
    expect(isValidBrowserUrl("http://example.com")).toBe(false);
    expect(isValidBrowserUrl("")).toBe(false);
    expect(isValidBrowserUrl(null)).toBe(false);
    expect(isValidBrowserUrl(undefined)).toBe(false);
  });

  it("should return false for non-http(s) protocols", () => {
    expect(isValidBrowserUrl("file:///path")).toBe(false);
    expect(isValidBrowserUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("getDisplayUrl", () => {
  it("should return clean display format", () => {
    expect(getDisplayUrl("http://localhost:3000/")).toBe("localhost:3000");
    expect(getDisplayUrl("http://localhost:3000/path")).toBe("localhost:3000/path");
    expect(getDisplayUrl("http://localhost:3000/?query=value")).toBe("localhost:3000?query=value");
  });

  it("should handle invalid URLs gracefully", () => {
    expect(getDisplayUrl("not a url")).toBe("not a url");
  });

  it("should preserve URL hash fragments", () => {
    expect(getDisplayUrl("http://localhost:3000/#/dashboard")).toBe("localhost:3000#/dashboard");
    expect(getDisplayUrl("http://localhost:3000/app#section")).toBe("localhost:3000/app#section");
  });
});

describe("extractHostPort", () => {
  it("should extract host and port", () => {
    expect(extractHostPort("http://localhost:3000/path")).toBe("localhost:3000");
    expect(extractHostPort("https://127.0.0.1:8080")).toBe("127.0.0.1:8080");
  });

  it("should handle URLs without explicit port", () => {
    expect(extractHostPort("http://localhost/")).toBe("localhost");
  });

  it("should fallback to localhost for invalid URLs", () => {
    expect(extractHostPort("not a url")).toBe("localhost");
  });
});
