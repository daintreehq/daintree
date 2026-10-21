import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PairingCodes,
  digestsEqual,
  formatPairingCode,
  hashDeviceToken,
  isAllowedHost,
  isSameOriginRequest,
  newDeviceToken,
  normalizeTailnetHost,
} from "../deviceAuth.js";

describe("isAllowedHost", () => {
  it("takes loopback only at the listener's own port, as ssh -L delivers it", () => {
    expect(isAllowedHost("127.0.0.1:7421", 7421, null)).toBe(true);
    expect(isAllowedHost("localhost:7421", 7421, null)).toBe(true);
    expect(isAllowedHost("[::1]:7421", 7421, null)).toBe(true);
    expect(isAllowedHost("localhost:8080", 7421, null)).toBe(false);
    expect(isAllowedHost("localhost", 7421, null)).toBe(false);
  });

  it("takes the tailnet name the user gave, on any port, and nothing like it", () => {
    const host = "mac.tail1234.ts.net";
    expect(isAllowedHost("mac.tail1234.ts.net", 7421, host)).toBe(true);
    expect(isAllowedHost("MAC.tail1234.ts.net:443", 7421, host)).toBe(true);
    expect(isAllowedHost("evil.mac.tail1234.ts.net", 7421, host)).toBe(false);
    expect(isAllowedHost("mac.tail1234.ts.net.evil.com", 7421, host)).toBe(false);
    expect(isAllowedHost("mac.tail1234.ts.net", 7421, null)).toBe(false);
  });

  it("refuses a rebound name, a missing Host and a malformed one", () => {
    expect(isAllowedHost("attacker.example:7421", 7421, null)).toBe(false);
    expect(isAllowedHost(undefined, 7421, null)).toBe(false);
    expect(isAllowedHost("", 7421, null)).toBe(false);
    expect(isAllowedHost("a:b:c", 7421, null)).toBe(false);
  });
});

describe("isSameOriginRequest", () => {
  it("refuses a browser that says the request came from another site", () => {
    expect(isSameOriginRequest({ host: "localhost:7421", "sec-fetch-site": "cross-site" })).toBe(
      false
    );
    expect(isSameOriginRequest({ host: "localhost:7421", "sec-fetch-site": "same-site" })).toBe(
      false
    );
    expect(isSameOriginRequest({ host: "localhost:7421", "sec-fetch-site": "same-origin" })).toBe(
      true
    );
  });

  it("takes an Origin only when it is this very host", () => {
    expect(isSameOriginRequest({ host: "localhost:7421", origin: "http://localhost:7421" })).toBe(
      true
    );
    expect(isSameOriginRequest({ host: "mac.ts.net", origin: "https://mac.ts.net" })).toBe(true);
    expect(isSameOriginRequest({ host: "localhost:7421", origin: "http://evil.example" })).toBe(
      false
    );
    expect(isSameOriginRequest({ host: "localhost:7421", origin: "null" })).toBe(false);
  });

  it("leaves a request with neither header to the token check", () => {
    expect(isSameOriginRequest({ host: "localhost:7421" })).toBe(true);
  });
});

describe("PairingCodes", () => {
  it("pairs once with the open code, typed in any case and with or without the dash", () => {
    const codes = new PairingCodes(() => 0);
    const { code } = codes.issue();
    expect(codes.redeem(formatPairingCode(code).toLowerCase())).toBe("ok");
    expect(codes.redeem(code)).toBe("none");
  });

  it("closes after its TTL", () => {
    let now = 0;
    const codes = new PairingCodes(() => now);
    const { code } = codes.issue();
    now = PAIRING_CODE_TTL_MS;
    expect(codes.openUntil()).toBeNull();
    expect(codes.redeem(code)).toBe("none");
  });

  it("closes for good after a few wrong guesses, even if the right code follows", () => {
    const codes = new PairingCodes(() => 0);
    const { code } = codes.issue();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) expect(codes.redeem("WRONGONE")).toBe("wrong");
    expect(codes.redeem(code)).toBe("none");
  });

  it("replaces the open code when a new one is asked for", () => {
    const codes = new PairingCodes(() => 0);
    const first = codes.issue().code;
    const second = codes.issue().code;
    if (first !== second) expect(codes.redeem(first)).toBe("wrong");
    expect(codes.redeem(second)).toBe("ok");
  });
});

describe("tokens", () => {
  it("matches a token's digest and nothing else, and never a malformed digest", () => {
    const token = newDeviceToken();
    const digest = hashDeviceToken(token);
    expect(digestsEqual(digest, hashDeviceToken(token))).toBe(true);
    expect(digestsEqual(digest, hashDeviceToken(newDeviceToken()))).toBe(false);
    expect(digestsEqual("abc", "abc")).toBe(false);
  });
});

describe("normalizeTailnetHost", () => {
  it("reduces what the user pasted to a bare host name", () => {
    expect(normalizeTailnetHost(" https://Mac.tail1234.ts.net:443/ ")).toBe("mac.tail1234.ts.net");
    expect(normalizeTailnetHost("mac.tail1234.ts.net.")).toBe("mac.tail1234.ts.net");
  });

  it("refuses anything that isn't a host name", () => {
    expect(normalizeTailnetHost("*.ts.net")).toBeNull();
    expect(normalizeTailnetHost("user@mac")).toBeNull();
    expect(normalizeTailnetHost("")).toBeNull();
    expect(normalizeTailnetHost(undefined)).toBeNull();
  });
});
