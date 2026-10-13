import { describe, it, expect } from "vitest";
import { sanitizeSvg, validateSvg, isSvgSafe } from "../svgSanitizer.js";

describe("sanitizeSvg", () => {
  const validSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="40" fill="blue"/>
  </svg>`;

  describe("valid inputs", () => {
    it("should accept a valid SVG without modification", () => {
      const result = sanitizeSvg(validSvg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).toBe(validSvg.trim());
        expect(result.modified).toBe(false);
      }
    });

    it("should accept SVG with common elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="10" y="10" width="80" height="80" fill="red"/>
        <path d="M10 10 L90 90" stroke="black"/>
        <text x="50" y="50">Hello</text>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modified).toBe(false);
      }
    });

    it("should accept SVG with gradients and transforms", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad1">
            <stop offset="0%" style="stop-color:rgb(255,255,0)"/>
            <stop offset="100%" style="stop-color:rgb(255,0,0)"/>
          </linearGradient>
        </defs>
        <rect fill="url(#grad1)" width="100" height="100" transform="rotate(45)"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modified).toBe(false);
      }
    });

    it("should accept SVG with internal url() references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="pattern1" patternUnits="userSpaceOnUse" width="10" height="10">
            <circle cx="5" cy="5" r="3" fill="blue"/>
          </pattern>
        </defs>
        <rect fill="url(#pattern1)" width="100" height="100"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modified).toBe(false);
      }
    });

    it("should accept SVG with local href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <defs>
          <symbol id="icon">
            <circle cx="50" cy="50" r="40"/>
          </symbol>
        </defs>
        <use href="#icon"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modified).toBe(false);
      }
    });
  });

  describe("invalid inputs", () => {
    it("should reject empty input", () => {
      const result = sanitizeSvg("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("required");
      }
    });

    it("should reject null/undefined input", () => {
      const result = sanitizeSvg(null as unknown as string);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("required");
      }
    });

    it("should reject whitespace-only input", () => {
      const result = sanitizeSvg("   \n\t   ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("empty");
      }
    });

    it("should reject non-SVG content", () => {
      const result = sanitizeSvg("<html><body>Hello</body></html>");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("valid SVG");
      }
    });

    it("should reject oversized SVG", () => {
      const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg">
        <text>${"x".repeat(300 * 1024)}</text>
      </svg>`;
      const result = sanitizeSvg(largeSvg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("too large");
      }
    });
  });

  describe("script tag removal", () => {
    it("should strip script tags and their content", () => {
      const svgWithScript = `<svg xmlns="http://www.w3.org/2000/svg">
        <script>alert('xss')</script>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svgWithScript);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("script");
        expect(result.svg).not.toContain("alert");
        expect(result.svg).toContain("circle");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip self-closing script tags", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <script type="text/javascript"/>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("script");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip script tags with attributes", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <script type="text/javascript" src="evil.js"></script>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("script");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("foreignObject removal", () => {
    it("should strip foreignObject elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <foreignObject width="100" height="100">
          <div xmlns="http://www.w3.org/1999/xhtml">Hello</div>
        </foreignObject>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("foreignObject");
        expect(result.svg).not.toContain("div");
        expect(result.svg).toContain("circle");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("dangerous element removal", () => {
    it("should strip iframe elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <iframe src="https://evil.com"></iframe>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("iframe");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip embed elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <embed src="https://evil.com/malware.swf"/>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("embed");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip object elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <object data="https://evil.com/payload"></object>
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("object");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("event handler removal", () => {
    it("should strip onclick event handlers", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="40" onclick="alert('xss')"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("onclick");
        expect(result.svg).not.toContain("alert");
        expect(result.svg).toContain("circle");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip onload event handlers", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert('xss')">
        <circle cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("onload");
        expect(result.svg).not.toContain("alert");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip multiple event handlers", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="init()">
        <circle onclick="click()" onmouseover="hover()" cx="50" cy="50" r="40"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("onload");
        expect(result.svg).not.toContain("onclick");
        expect(result.svg).not.toContain("onmouseover");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("javascript URL removal", () => {
    it("should neutralize javascript: URLs in href", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <a href="javascript:alert('xss')">
          <circle cx="50" cy="50" r="40"/>
        </a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("javascript:");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize javascript: URLs in xlink:href", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <a xlink:href="javascript:alert('xss')">
          <circle cx="50" cy="50" r="40"/>
        </a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("javascript:");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize entity-encoded javascript: URLs", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <a href="java&#x73;cript:alert('xss')">
          <circle cx="50" cy="50" r="40"/>
        </a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("java&#x73;cript");
        expect(result.svg).toContain('href=""');
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("data URL removal", () => {
    it("should neutralize data: URLs", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="data:text/html,<script>alert(1)</script>"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("data:");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("external reference removal", () => {
    it("should neutralize external href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="https://evil.com/image.svg"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize external xlink:href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <use xlink:href="https://evil.com/sprites.svg#icon"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize external url() in CSS", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect style="fill: url(https://evil.com/pattern)" width="100" height="100"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize http references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="http://evil.com/image.svg"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("http://evil.com");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize protocol-relative url() in CSS", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect style="fill: url(//evil.com/pattern)" width="100" height="100"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("//evil.com");
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize protocol-relative href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="//evil.com/image.svg"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("//evil.com");
        expect(result.svg).toContain('href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize unquoted href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image href=https://evil.com/image.svg/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.svg).toContain('href=""');
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("css import removal", () => {
    it("should strip @import statements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <style>@import "https://evil.com/style.css"; .cls{fill:red;}</style>
        <rect class="cls" width="100" height="100"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("@import");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("complex attack vectors", () => {
    it("should handle SVG with multiple attack vectors", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="init()">
        <script>alert('xss')</script>
        <foreignObject width="100" height="100">
          <div onclick="alert('click')">Evil</div>
        </foreignObject>
        <a href="javascript:alert('link')">
          <circle onclick="alert('circle')" cx="50" cy="50" r="40"/>
        </a>
        <image href="https://evil.com/tracking.gif"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("script");
        expect(result.svg).not.toContain("foreignObject");
        expect(result.svg).not.toContain("onload");
        expect(result.svg).not.toContain("onclick");
        expect(result.svg).not.toContain("javascript:");
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.svg).toContain("<svg");
        expect(result.svg).toContain("circle");
        expect(result.modified).toBe(true);
      }
    });

    it("should preserve safe content while removing dangerous content", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="safe-grad">
            <stop offset="0%" stop-color="red"/>
            <stop offset="100%" stop-color="blue"/>
          </linearGradient>
        </defs>
        <script>malicious()</script>
        <rect fill="url(#safe-grad)" width="100" height="100"/>
        <circle cx="50" cy="50" r="30" fill="white"/>
        <text x="50" y="50" text-anchor="middle">Safe Text</text>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("script");
        expect(result.svg).not.toContain("malicious");
        expect(result.svg).toContain("linearGradient");
        expect(result.svg).toContain("safe-grad");
        expect(result.svg).toContain("rect");
        expect(result.svg).toContain("circle");
        expect(result.svg).toContain("text");
        expect(result.svg).toContain("Safe Text");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("SMIL animation element removal", () => {
    // Defense-in-depth: Chromium 146 already blocks animation of on* attributes,
    // but SMIL elements give attackers tag-based vectors (animating href, attributeName
    // injection, future browser bugs). The sanitizer must strip them outright.
    it("should strip <animate> elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100">
          <animate attributeName="onbegin" values="alert(1)"/>
        </rect>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("<animate");
        expect(result.svg).not.toContain("alert");
        expect(result.svg).toContain("rect");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip <set> elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100">
          <set attributeName="onmouseover" to="alert(1)"/>
        </rect>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("<set");
        expect(result.svg).not.toContain("alert");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip <animateTransform> elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100">
          <animateTransform attributeName="transform" type="rotate" values="0;360"/>
        </rect>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("<animateTransform");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip <animateMotion> elements", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="20">
          <animateMotion path="M0,0 L100,100"/>
        </circle>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("<animateMotion");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip namespace-prefixed SMIL elements bound to the SVG namespace", () => {
      // A prefix like `s` bound via xmlns:s="http://www.w3.org/2000/svg" makes
      // <s:animate> resolve to the same element as <animate> in a namespace-aware
      // SVG parser. The sanitizer must catch the prefixed form too.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg">
        <rect width="100" height="100">
          <s:animate attributeName="onbegin" values="alert(1)"/>
        </rect>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("s:animate");
        expect(result.svg).not.toContain("alert");
        expect(result.svg).toContain("rect");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip self-closing and paired SMIL element forms together", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100">
          <animate attributeName="x" from="0" to="100" dur="1s"></animate>
          <set attributeName="fill" to="red"/>
        </rect>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("<animate");
        expect(result.svg).not.toContain("<set");
        expect(result.svg).toContain("rect");
        expect(result.modified).toBe(true);
      }
    });
  });

  describe("namespace-prefixed href sanitization", () => {
    // Chromium's SVG parser is namespace-URI-aware: any prefix bound to the xlink
    // namespace (e.g. xmlns:alias="http://www.w3.org/1999/xlink") makes
    // alias:href behave identically to xlink:href. The sanitizer must catch
    // arbitrary `*:href` prefixes, not just the literal "xlink:" form.
    it("should neutralize external alias-prefixed href references", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <use alias:href="https://evil.com/sprites.svg#icon"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize javascript: URLs in alias-prefixed href", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <a alias:href="javascript:alert('xss')">
          <circle cx="50" cy="50" r="40"/>
        </a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("javascript:");
        expect(result.svg).not.toContain("alert");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize hyphenated prefix bound to xlink (foo-bar:href)", () => {
      // XML NCName prefixes can include hyphens and dots. A prefix like `foo-bar`
      // bound to the xlink namespace makes `foo-bar:href` exploitable; the pattern
      // must accept full NCName characters in the prefix.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:foo-bar="http://www.w3.org/1999/xlink">
        <use foo-bar:href="https://evil.com/sprites.svg#icon"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("https://evil.com");
        expect(result.svg).toContain('foo-bar:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should preserve safe local references for any prefix", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <defs>
          <symbol id="icon"><circle cx="50" cy="50" r="40"/></symbol>
        </defs>
        <use href="#icon"/>
        <use xlink:href="#icon"/>
        <use alias:href="#icon"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).toContain('href="#icon"');
        expect(result.svg).toContain('xlink:href="#icon"');
        expect(result.svg).toContain('alias:href="#icon"');
        expect(result.modified).toBe(false);
      }
    });
  });

  describe("control-character encoded javascript URLs in prefixed href", () => {
    // When a namespace-prefixed href carries a javascript: URL with a control
    // character splitting "javascript", the literal-keyword scan misses it.
    // The widened HREF_ATTRIBUTE_PATTERN routes the value through entity
    // decoding + isLocalReference, which treats anything not starting with
    // "#" as unsafe and zeroes the attribute.
    it("should neutralize tab-encoded javascript: in alias:href (executable in Chromium 146)", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <a alias:href="j&#9;avascript:alert(1)"><circle cx="50" cy="50" r="40"/></a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("alert(1)");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize newline-encoded javascript: in alias:href (executable in Chromium 146)", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <a alias:href="j&#10;avascript:alert(1)"><circle cx="50" cy="50" r="40"/></a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("alert(1)");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize CR-encoded javascript: in alias:href (executable in Chromium 146)", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <a alias:href="j&#13;avascript:alert(1)"><circle cx="50" cy="50" r="40"/></a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("alert(1)");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });

    it("should neutralize null-byte-encoded javascript: in alias:href (defense in depth; not executable in Chromium 146)", () => {
      // U+0000 invalidates URL scheme parsing in Chromium 146 per WHATWG URL
      // spec, so this is not an active execution bypass in this engine. The
      // sanitizer still strips it conservatively as a guard against other
      // parsers and future engine changes.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
        <a alias:href="j&#0;avascript:alert(1)"><circle cx="50" cy="50" r="40"/></a>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("alert(1)");
        expect(result.svg).toContain('alias:href=""');
        expect(result.modified).toBe(true);
      }
    });
  });
});

describe("validateSvg", () => {
  it("should return ok for clean SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateSvg(svg);
    expect(result.ok).toBe(true);
  });

  it("should return error for SVG with dangerous content", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateSvg(svg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });
});

describe("isSvgSafe", () => {
  it("should return true for safe SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(true);
  });

  it("should return false for SVG with script", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for SVG with event handler", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="init()">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for unquoted event handler", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload=alert(1)>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for entity-encoded javascript href", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <a href="java&#x73;cript:alert('xss')">
        <circle cx="50" cy="50" r="40"/>
      </a>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for empty input", () => {
    expect(isSvgSafe("")).toBe(false);
    expect(isSvgSafe(null as unknown as string)).toBe(false);
  });

  it("should return false for non-SVG content", () => {
    expect(isSvgSafe("<html></html>")).toBe(false);
  });

  it("should return false for SVG with <animate>", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100">
        <animate attributeName="onbegin" values="alert(1)"/>
      </rect>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for SVG with <set>", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100">
        <set attributeName="onmouseover" to="alert(1)"/>
      </rect>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for SVG with <animateTransform>", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100">
        <animateTransform attributeName="transform" type="rotate" values="0;360"/>
      </rect>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for SVG with <animateMotion>", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="20">
        <animateMotion path="M0,0 L100,100"/>
      </circle>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for external alias-prefixed href", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
      <use alias:href="https://evil.com/sprites.svg#icon"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for control-character javascript: in alias:href", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
      <a alias:href="j&#10;avascript:alert(1)"><circle cx="50" cy="50" r="40"/></a>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return true for safe local alias-prefixed href", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:alias="http://www.w3.org/1999/xlink">
      <defs><symbol id="icon"><circle cx="50" cy="50" r="40"/></symbol></defs>
      <use alias:href="#icon"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(true);
  });

  it("should return false for namespace-prefixed SMIL element", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg">
      <rect width="100" height="100">
        <s:animate attributeName="onbegin" values="alert(1)"/>
      </rect>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });

  it("should return false for hyphenated prefix bound to xlink", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:foo-bar="http://www.w3.org/1999/xlink">
      <use foo-bar:href="https://evil.com/sprites.svg#icon"/>
    </svg>`;
    expect(isSvgSafe(svg)).toBe(false);
  });
});
