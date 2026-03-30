import { describe, expect, it } from "vitest";
import { extractYouTubeVideoId } from "../useYouTubeEmbeds";

describe("extractYouTubeVideoId", () => {
  it("extracts ID from standard watch URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID from short youtu.be URL", () => {
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts ID from embed URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts ID from shorts URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts ID from live URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts ID from youtube-nocookie.com embed URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID when v= is not the first query parameter", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?list=PLtest&v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID from music.youtube.com", () => {
    expect(extractYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("returns null for non-YouTube URL", () => {
    expect(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(extractYouTubeVideoId("hello world")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractYouTubeVideoId("")).toBeNull();
  });

  it("extracts ID with extra query params after v=", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120")).toBe(
      "dQw4w9WgXcQ"
    );
  });
});
