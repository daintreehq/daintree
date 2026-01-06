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

    it("should strip onerror event handlers", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <image onerror="alert('xss')" href="invalid.jpg"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("onerror");
        expect(result.svg).not.toContain("alert");
        expect(result.modified).toBe(true);
      }
    });

    it("should strip onmouseover event handlers", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <rect onmouseover="alert('xss')" width="100" height="100"/>
      </svg>`;
      const result = sanitizeSvg(svg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.svg).not.toContain("onmouseover");
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
});
