import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  DETERMINISTIC_PATTERNS,
  TRANSIENT_OVERRIDE_PATTERNS,
  TRANSIENT_PATTERNS,
} from "./npm-ci-retry.mjs";

describe("npm-ci-retry", () => {
  describe("DETERMINISTIC_PATTERNS", () => {
    it("matches gyp ERR! (uppercase, npm <10)", () => {
      const stderr = "gyp ERR! build error\nnpm ERR! code 1\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches gyp error (lowercase, npm >=10)", () => {
      const stderr = "gyp error: build failed\nnpm error code 1\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches node-gyp rebuild failures", () => {
      const stderr = "node-gyp rebuild failed with exit code 1\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches xcrun / xcode-select errors (macOS missing toolchain)", () => {
      const stderr = "xcrun: error: unable to find utility 'make'\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches MSBuild errors (Windows native compilation)", () => {
      const stderr = "MSBuild : error MSB3428: Could not load the Visual C++ component\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches MSBuild vcxproj errors", () => {
      const stderr =
        "binding.vcxproj : error MSB8020: The build tools for Windows SDK cannot be found\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches EACCES / permission denied", () => {
      const stderr = "npm ERR! code EACCES\nnpm ERR! permission denied\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches E404 package not found", () => {
      const stderr =
        "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/no-such-pkg\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches E404 with lowercase npm error", () => {
      const stderr = "npm error code E404\nnpm error 404 Not Found\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches ERESOLVE dependency conflicts", () => {
      const stderr = "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches ERESOLVE with lowercase npm error", () => {
      const stderr =
        "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve dependency tree\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("matches EPEERINVALID", () => {
      const stderr = "npm ERR! code EPEERINVALID\nnpm ERR! peer dependency mismatch\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });
  });

  describe("TRANSIENT_PATTERNS", () => {
    it("matches ECONNRESET", () => {
      expect(classifyFailure("ECONNRESET\n")).toBe("transient");
    });

    it("matches ETIMEDOUT", () => {
      expect(classifyFailure("ETIMEDOUT\n")).toBe("transient");
    });

    it("matches EAI_AGAIN DNS failure", () => {
      expect(classifyFailure("EAI_AGAIN\n")).toBe("transient");
    });

    it("matches ENOTFOUND from npm registry lookup", () => {
      expect(classifyFailure("ENOTFOUND registry.npmjs.org\n")).toBe("transient");
    });

    it("matches EHOSTUNREACH", () => {
      expect(classifyFailure("EHOSTUNREACH\n")).toBe("transient");
    });

    it("matches ENETUNREACH", () => {
      expect(classifyFailure("ENETUNREACH\n")).toBe("transient");
    });

    it("matches onnxruntime NuGet timeout output", () => {
      const stderr = `
npm error path /home/runner/work/daintree/daintree/node_modules/onnxruntime-node
npm error command sh -c node ./script/install
npm error Downloading https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/1.26.0/microsoft.ml.onnxruntime.gpu.linux.1.26.0.nupkg
npm error AggregateError [ETIMEDOUT]:
npm error Error: connect ENETUNREACH 2603:1061:14:e3::1:443 - Local (:::0)
`;
      expect(classifyFailure(stderr)).toBe("transient");
    });

    it("matches socket hang up", () => {
      expect(classifyFailure("socket hang up\n")).toBe("transient");
    });

    it("matches HTTP 429 rate limit", () => {
      expect(classifyFailure("HTTP 429 Too Many Requests\n")).toBe("transient");
    });

    it("matches HTTP 502 bad gateway", () => {
      expect(classifyFailure("HTTP 502 Bad Gateway\n")).toBe("transient");
    });

    it("matches HTTP 503 service unavailable", () => {
      expect(classifyFailure("HTTP 503 Service Unavailable\n")).toBe("transient");
    });

    it("matches HTTP 504 gateway timeout", () => {
      expect(classifyFailure("HTTP 504 Gateway Timeout\n")).toBe("transient");
    });

    it("matches fetch failed", () => {
      expect(classifyFailure("fetch failed\n")).toBe("transient");
    });

    it("matches npm network error", () => {
      expect(
        classifyFailure(
          "npm ERR! network\nnpm ERR! network request to https://registry.npmjs.org/ failed\n"
        )
      ).toBe("transient");
    });
  });

  describe("classifyFailure", () => {
    it("returns unknown for empty stderr", () => {
      expect(classifyFailure("")).toBe("unknown");
    });

    it("returns unknown for null/undefined", () => {
      expect(classifyFailure(null)).toBe("unknown");
      expect(classifyFailure(undefined)).toBe("unknown");
    });

    it("returns unknown for unrecognized text", () => {
      expect(classifyFailure("some random output\n")).toBe("unknown");
    });

    it("deterministic beats transient when both patterns appear", () => {
      const stderr = "gyp ERR! build error\nECONNRESET\nnpm ERR! code 1\n";
      expect(classifyFailure(stderr)).toBe("deterministic");
    });

    it("treats node-gyp undici parser assertions as retryable infrastructure failures", () => {
      const stderr = `
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert(!this.paused)

    at Parser.finish (D:\\a\\daintree\\daintree\\node_modules\\node-gyp\\node_modules\\undici\\lib\\dispatcher\\client-h1.js:302:5)
    at TLSSocket.<anonymous> (D:\\a\\daintree\\daintree\\node_modules\\node-gyp\\node_modules\\undici\\lib\\dispatcher\\client-h1.js:741:32)

Rebuild failures (1/5):
  node-pty: node-gyp failed to rebuild 'D:\\a\\daintree\\daintree\\node_modules\\node-pty'
`;
      expect(classifyFailure(stderr)).toBe("transient");
    });

    it("treats node-gyp undici connect timeouts as retryable infrastructure failures", () => {
      const stderr = `
ConnectTimeoutError: Connect Timeout Error (attempted addresses: 104.18.17.205:443, timeout: 10000ms)
    at onConnectTimeout (D:\\a\\daintree\\daintree\\node_modules\\node-gyp\\node_modules\\undici\\lib\\core\\connect.js:237:24) {
  code: 'UND_ERR_CONNECT_TIMEOUT',
  [Symbol(undici.error.UND_ERR_CONNECT_TIMEOUT)]: true
}

Postinstall failures (1):
  node-pty: node-gyp failed to rebuild 'D:\\a\\daintree\\daintree\\node_modules\\node-pty'
`;
      expect(classifyFailure(stderr)).toBe("transient");
    });

    it("treats node-gyp aggregate network timeouts as retryable infrastructure failures", () => {
      const stderr = `
AggregateError [ETIMEDOUT]:
    at internalConnectMultiple (node:net:1134:18) {
  code: 'ETIMEDOUT',
  [errors]: [
    Error: connect ETIMEDOUT 104.18.17.205:443,
    Error: connect ENETUNREACH 2606:4700::6812:10cd:443 - Local (:::0)
  ]
}

Postinstall failures (2):
  node-pty: node-gyp failed to rebuild '/home/runner/work/daintree/daintree/node_modules/node-pty'
  win-job-object: node-gyp failed to rebuild '/home/runner/work/daintree/daintree/electron/native/win-job-object'
`;
      expect(classifyFailure(stderr)).toBe("transient");
    });

    it("handles case-insensitive matching", () => {
      expect(classifyFailure("Gyp Err! build failed\neconnreset\n")).toBe("deterministic");
    });
  });

  describe("pattern coverage", () => {
    const allDeterministic = DETERMINISTIC_PATTERNS.map((p) => p.source);
    const allTransientOverride = TRANSIENT_OVERRIDE_PATTERNS.map((p) => p.source);
    const allTransient = TRANSIENT_PATTERNS.map((p) => p.source);

    it("covers every deterministic pattern", () => {
      expect(DETERMINISTIC_PATTERNS).toHaveLength(10);
    });

    it("covers every transient pattern", () => {
      expect(TRANSIENT_PATTERNS).toHaveLength(13);
    });

    it("covers every transient override pattern", () => {
      expect(TRANSIENT_OVERRIDE_PATTERNS).toHaveLength(3);
    });

    it("has no overlap between deterministic and transient patterns", () => {
      for (const dp of allDeterministic) {
        for (const tp of allTransient) {
          expect(dp).not.toBe(tp);
        }
        for (const top of allTransientOverride) {
          expect(dp).not.toBe(top);
        }
      }
    });
  });
});
