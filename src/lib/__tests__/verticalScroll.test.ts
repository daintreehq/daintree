import { describe, it, expect } from "vitest";
import { getVerticalScrollState } from "../verticalScroll";

describe("getVerticalScrollState", () => {
  describe("isOverflowing", () => {
    it("should return false when content fits (scrollHeight <= clientHeight)", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 500,
        clientHeight: 500,
      });
      expect(result.isOverflowing).toBe(false);
    });

    it("should return false when content fits with epsilon tolerance", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 501,
        clientHeight: 500,
      });
      expect(result.isOverflowing).toBe(false);
    });

    it("should return true when content overflows", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.isOverflowing).toBe(true);
    });
  });

  describe("canScrollUp", () => {
    it("should return false when at scroll start", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollUp).toBe(false);
    });

    it("should return false when within epsilon of scroll start", () => {
      const result = getVerticalScrollState({
        scrollTop: 0.5,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollUp).toBe(false);
    });

    it("should return true when scrolled past start", () => {
      const result = getVerticalScrollState({
        scrollTop: 50,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollUp).toBe(true);
    });

    it("should return false when no overflow even if scrollTop is set", () => {
      const result = getVerticalScrollState({
        scrollTop: 10,
        scrollHeight: 500,
        clientHeight: 500,
      });
      expect(result.canScrollUp).toBe(false);
    });
  });

  describe("canScrollDown", () => {
    it("should return true when at scroll start with overflow", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollDown).toBe(true);
    });

    it("should return true when partially scrolled with more content", () => {
      const result = getVerticalScrollState({
        scrollTop: 100,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollDown).toBe(true);
    });

    it("should return false when scrolled to end", () => {
      const result = getVerticalScrollState({
        scrollTop: 300,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollDown).toBe(false);
    });

    it("should return false when within epsilon of scroll end", () => {
      const result = getVerticalScrollState({
        scrollTop: 299.5,
        scrollHeight: 800,
        clientHeight: 500,
      });
      expect(result.canScrollDown).toBe(false);
    });

    it("should return false when no overflow", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 500,
        clientHeight: 500,
      });
      expect(result.canScrollDown).toBe(false);
    });
  });

  describe("combined states", () => {
    it("should return all false when no overflow", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 500,
      });
      expect(result).toEqual({
        isOverflowing: false,
        canScrollUp: false,
        canScrollDown: false,
      });
    });

    it("should allow scroll down only when at start with overflow", () => {
      const result = getVerticalScrollState({
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 500,
      });
      expect(result).toEqual({
        isOverflowing: true,
        canScrollUp: false,
        canScrollDown: true,
      });
    });

    it("should allow both directions when in middle", () => {
      const result = getVerticalScrollState({
        scrollTop: 250,
        scrollHeight: 1000,
        clientHeight: 500,
      });
      expect(result).toEqual({
        isOverflowing: true,
        canScrollUp: true,
        canScrollDown: true,
      });
    });

    it("should allow scroll up only when at end", () => {
      const result = getVerticalScrollState({
        scrollTop: 500,
        scrollHeight: 1000,
        clientHeight: 500,
      });
      expect(result).toEqual({
        isOverflowing: true,
        canScrollUp: true,
        canScrollDown: false,
      });
    });
  });
});
