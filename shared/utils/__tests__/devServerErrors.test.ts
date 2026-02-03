import { describe, it, expect } from "vitest";
import {
  detectDevServerError,
  isRecoverableError,
  type DevServerError,
} from "../devServerErrors.js";

describe("devServerErrors", () => {
  describe("detectDevServerError", () => {
    describe("port conflicts", () => {
      it("detects EADDRINUSE error", () => {
        const output = "Error: listen EADDRINUSE: address already in use :::3000";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "port-conflict",
          message: "Port 3000 is already in use. Stop the other server or use a different port.",
          port: "3000",
        });
      });

      it("detects 'port already in use' message", () => {
        const output = "Error: port 5173 is already in use";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "port-conflict",
          message: "Port 5173 is already in use. Stop the other server or use a different port.",
          port: "5173",
        });
      });

      it("detects 'Something is already running' message", () => {
        const output = "Something is already running on port 8080";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "port-conflict",
          message: "Port 8080 is already in use. Stop the other server or use a different port.",
          port: "8080",
        });
      });

      it("detects Vite port in use message", () => {
        const output = "Port 5173 is in use, trying another one...";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "port-conflict",
          message: "Port 5173 is already in use. Stop the other server or use a different port.",
          port: "5173",
        });
      });
    });

    describe("missing dependencies", () => {
      it("detects Cannot find module error", () => {
        const output = "Error: Cannot find module 'vite'";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependency: vite. Installing dependencies...",
          module: "vite",
        });
      });

      it("detects MODULE_NOT_FOUND error", () => {
        const output = "Error [MODULE_NOT_FOUND]: Cannot locate module";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependencies detected. Installing...",
          module: undefined,
        });
      });

      it("detects ERR_MODULE_NOT_FOUND error", () => {
        const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependencies detected. Installing...",
          module: undefined,
        });
      });

      it("detects Cannot find package error", () => {
        const output = "Error: Cannot find package 'react' imported from";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependency: react. Installing dependencies...",
          module: "react",
        });
      });

      it("detects npm missing error", () => {
        const output = "npm ERR! missing: webpack@5.0.0";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependencies detected. Installing...",
          module: undefined,
        });
      });

      it("detects native module compilation error", () => {
        const output = "The module 'node-pty' was compiled against a different Node.js version";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependency: node-pty. Installing dependencies...",
          module: "node-pty",
        });
      });

      it("detects ENOENT node_modules error", () => {
        const output =
          "Error: ENOENT: no such file or directory, open 'node_modules/vite/package.json'";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "missing-dependencies",
          message: "Missing dependencies detected. Installing...",
          module: undefined,
        });
      });
    });

    describe("permission errors", () => {
      it("detects EACCES error", () => {
        const output = "Error: EACCES: permission denied, open '/etc/passwd'";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "permission",
          message: "Permission denied. Check file permissions or run with elevated privileges.",
        });
      });

      it("detects permission denied message", () => {
        const output = "Error: permission denied trying to access file";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "permission",
          message: "Permission denied. Check file permissions or run with elevated privileges.",
        });
      });

      it("detects EPERM error", () => {
        const output = "Error: EPERM: operation not permitted";
        const error = detectDevServerError(output);
        expect(error).toEqual({
          type: "permission",
          message: "Permission denied. Check file permissions or run with elevated privileges.",
        });
      });
    });

    describe("no error", () => {
      it("returns null for normal output", () => {
        const output = "Server started successfully at http://localhost:3000";
        const error = detectDevServerError(output);
        expect(error).toBeNull();
      });

      it("returns null for empty output", () => {
        const error = detectDevServerError("");
        expect(error).toBeNull();
      });

      it("returns null for generic errors without matching patterns", () => {
        const output = "Error: Something went wrong";
        const error = detectDevServerError(output);
        expect(error).toBeNull();
      });
    });
  });

  describe("isRecoverableError", () => {
    it("returns true for missing-dependencies errors", () => {
      const error: DevServerError = {
        type: "missing-dependencies",
        message: "Missing dependencies",
      };
      expect(isRecoverableError(error)).toBe(true);
    });

    it("returns false for port-conflict errors", () => {
      const error: DevServerError = {
        type: "port-conflict",
        message: "Port in use",
        port: "3000",
      };
      expect(isRecoverableError(error)).toBe(false);
    });

    it("returns false for permission errors", () => {
      const error: DevServerError = {
        type: "permission",
        message: "Permission denied",
      };
      expect(isRecoverableError(error)).toBe(false);
    });

    it("returns false for unknown errors", () => {
      const error: DevServerError = {
        type: "unknown",
        message: "Unknown error",
      };
      expect(isRecoverableError(error)).toBe(false);
    });
  });
});
