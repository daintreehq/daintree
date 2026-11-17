import { describe, expect, it } from "vitest";
import {
  deploymentOf,
  normalizeCloudSiteUrl,
  normalizeDataCenterUrl,
  normalizeEmail,
  normalizeSiteUrl,
  siteHostOf,
  siteIdOf,
} from "../connection.js";

describe("normalizeCloudSiteUrl", () => {
  it.each([
    ["https://acme.atlassian.net", "https://acme.atlassian.net"],
    ["acme.atlassian.net", "https://acme.atlassian.net"],
    ["  HTTPS://Acme.Atlassian.NET/  ", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net/jira/your-work?x=1#y", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net:443", "https://acme.atlassian.net"],
    ["my-team-2.atlassian.net", "https://my-team-2.atlassian.net"],
    ["acme.atlassian.net:443", "https://acme.atlassian.net"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeCloudSiteUrl(input)).toBe(expected);
  });

  it.each([
    ["an http site", "http://acme.atlassian.net"],
    ["a non-default port", "https://acme.atlassian.net:8443"],
    ["embedded credentials", "https://me:pw@acme.atlassian.net"],
    ["a lookalike suffix", "https://acme.atlassian.net.evil.example"],
    ["a lookalike prefix", "https://evilatlassian.net"],
    ["a host hidden in a fragment", "https://evil.example#acme.atlassian.net"],
    ["a host hidden in userinfo", "https://acme.atlassian.net@evil.example"],
    ["a nested tenant", "https://a.b.atlassian.net"],
    ["the apex", "https://atlassian.net"],
    ["a self-hosted Jira", "https://jira.example.com"],
    ["an IP address", "https://127.0.0.1"],
    ["another scheme", "file://acme.atlassian.net"],
    ["an empty value", "   "],
    ["a non-string", 42],
  ])("rejects %s", (_name, input) => {
    expect(normalizeCloudSiteUrl(input)).toBeNull();
  });
});

describe("normalizeDataCenterUrl", () => {
  it.each([
    ["https://jira.example.com", "https://jira.example.com"],
    ["jira.example.com", "https://jira.example.com"],
    ["  HTTPS://Jira.Example.COM/  ", "https://jira.example.com"],
    ["https://jira.example.com:443", "https://jira.example.com"],
    ["https://jira.example.com:8443", "https://jira.example.com:8443"],
    ["https://example.com/jira", "https://example.com/jira"],
    ["https://example.com/Jira/", "https://example.com/Jira"],
    ["https://example.com/tools/jira?x=1#y", "https://example.com/tools/jira"],
    ["https://example.com/jira/browse/ENG-12", "https://example.com/jira"],
    ["https://jira.example.com/browse/ENG-12", "https://jira.example.com"],
    ["https://jira.example.com/secure/Dashboard.jspa", "https://jira.example.com"],
    ["https://jira.example.com/issues/?jql=project%20%3D%20ENG", "https://jira.example.com"],
    ["https://example.com/jira/projects/ENG/issues/ENG-1", "https://example.com/jira"],
    ["https://example.com/jira/login.jsp", "https://example.com/jira"],
    // Context paths that share a name with a Jira page are kept as typed.
    ["https://example.com/issues", "https://example.com/issues"],
    ["https://example.com/tools/projects/jira", "https://example.com/tools/projects/jira"],
    ["https://example.com/browse", "https://example.com/browse"],
    [
      "https://example.com/jira/browse/ENG-12-tools",
      "https://example.com/jira/browse/ENG-12-tools",
    ],
    ["https://example.com/teams/issues?theme=dark", "https://example.com/teams/issues"],
    ["https://example.com/tools/projects/Jira", "https://example.com/tools/projects/Jira"],
    ["https://example.com/gateway/rest/api", "https://example.com/gateway/rest/api"],
    ["https://example.com/gateway/plugins/servlet", "https://example.com/gateway/plugins/servlet"],
    ["https://example.com/gateway/login.jsp/jira", "https://example.com/gateway/login.jsp/jira"],
    ["https://example.com/jira/issues?return=/x?jql=ENG", "https://example.com/jira/issues"],
    ["https://example.com/jira/rest/api/2/myself", "https://example.com/jira"],
    ["https://example.com/jira/plugins/servlet/desk", "https://example.com/jira"],
    [
      "https://example.com/gateway/plugins/servlet/browse/ENG-12",
      "https://example.com/gateway/plugins/servlet",
    ],
    ["jira.example.com:8443/jira", "https://jira.example.com:8443/jira"],
    ["https://10.0.0.5:8443/jira", "https://10.0.0.5:8443/jira"],
    ["https://[::1]:8443", "https://[::1]:8443"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeDataCenterUrl(input)).toBe(expected);
  });

  it.each([
    ["an http site", "http://jira.example.com"],
    ["embedded credentials", "https://me:pw@jira.example.com"],
    ["a Cloud tenant", "https://acme.atlassian.net"],
    ["a Cloud tenant on a port", "https://acme.atlassian.net:8443"],
    ["Atlassian's apex", "https://atlassian.net"],
    ["a Cloud tenant behind a trailing dot", "https://acme.atlassian.net."],
    ["any host behind a trailing dot", "https://jira.example.com."],
    ["a scheme missing a slash", "https:/jira.example.com"],
    ["a backslash in the path", "https://jira.example.com\\jira"],
    ["an encoded slash in the path", "https://example.com/a%2Fb"],
    ["an encoded character in the path", "https://example.com/j%69ra"],
    ["another scheme", "file://jira.example.com"],
    ["a base too long to name a link", `https://example.com/${"a".repeat(200)}`],
    ["an empty value", "   "],
    ["a non-string", 42],
  ])("rejects %s", (_name, input) => {
    expect(normalizeDataCenterUrl(input)).toBeNull();
  });
});

describe("normalizeSiteUrl", () => {
  it("reads an atlassian.net tenant as Cloud and anything else as Data Center", () => {
    expect(normalizeSiteUrl("acme.atlassian.net/jira/your-work")).toBe(
      "https://acme.atlassian.net"
    );
    expect(normalizeSiteUrl("https://example.com/jira/")).toBe("https://example.com/jira");
    expect(deploymentOf("https://acme.atlassian.net")).toBe("cloud");
    expect(deploymentOf("https://example.com/jira")).toBe("dataCenter");
    expect(deploymentOf("https://jira.example.com")).toBe("dataCenter");
  });

  it.each([
    "http://acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "https://a.b.atlassian.net",
  ])("rejects %s, which is neither", (input) => {
    expect(normalizeSiteUrl(input)).toBeNull();
  });
});

describe("siteHostOf and siteIdOf", () => {
  it("names a Cloud site by its host alone", () => {
    expect(siteHostOf("https://acme.atlassian.net")).toBe("acme.atlassian.net");
    expect(siteIdOf("https://acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("keeps a Data Center site's port and context path", () => {
    expect(siteHostOf("https://jira.example.com:8443/jira")).toBe("jira.example.com:8443");
    expect(siteIdOf("https://jira.example.com:8443/jira")).toBe("jira.example.com:8443/jira");
  });
});

describe("normalizeEmail", () => {
  it("trims a usable address", () => {
    expect(normalizeEmail("  ada@example.com ")).toBe("ada@example.com");
  });

  it.each(["", "ada", "ada@", "@example.com", "a b@example.com", "ada:pw@example.com", 7])(
    "rejects %s",
    (input) => {
      expect(normalizeEmail(input)).toBeNull();
    }
  );
});
