import { describe, expect, it } from "vitest";
import { scanConflictMarkerText } from "../conflictMarkerScan.js";

const REGION = "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n";

describe("scanConflictMarkerText", () => {
  it("reports a clean file as having no markers", () => {
    expect(scanConflictMarkerText("const a = 1;\n// <<<<<<< not at a line start\n")).toEqual({
      hunkCount: 0,
      hasMarkers: false,
      firstMarkerLine: null,
    });
  });

  it("counts one region per opener and points at the first", () => {
    expect(scanConflictMarkerText(`line 1\n${REGION}middle\n${REGION}`)).toEqual({
      hunkCount: 2,
      hasMarkers: true,
      firstMarkerLine: 2,
    });
  });

  it("counts a diff3 region once", () => {
    const diff3 = "<<<<<<< ours\nleft\n||||||| base\norig\n=======\nright\n>>>>>>> theirs\n";
    expect(scanConflictMarkerText(diff3)).toMatchObject({ hunkCount: 1, hasMarkers: true });
  });

  it.each([
    ["a closing marker", "kept\n>>>>>>> theirs\n", 2],
    ["a base marker", "kept\n||||||| base\n", 2],
    [
      "a separator and closer whose opener was deleted",
      "kept\n=======\nright\n>>>>>>> theirs\n",
      4,
    ],
  ])("finds markers left behind with no opener: %s", (_name, content, line) => {
    expect(scanConflictMarkerText(content)).toEqual({
      hunkCount: 0,
      hasMarkers: true,
      firstMarkerLine: line,
    });
  });

  it("points at a stray closer before a later intact region, and still counts the region", () => {
    expect(scanConflictMarkerText(`a\nb\nc\n>>>>>>> theirs\n${REGION}`)).toEqual({
      hunkCount: 1,
      hasMarkers: true,
      firstMarkerLine: 4,
    });
  });

  it("reads a marker on the first line past a BOM, with CRLF endings, and with no final newline", () => {
    expect(scanConflictMarkerText("﻿>>>>>>> theirs\r\n")).toEqual({
      hunkCount: 0,
      hasMarkers: true,
      firstMarkerLine: 1,
    });
    expect(scanConflictMarkerText("a\r\nb\r\n>>>>>>> theirs\r\n")).toMatchObject({
      hasMarkers: true,
      firstMarkerLine: 3,
    });
    expect(scanConflictMarkerText("a\n>>>>>>>")).toMatchObject({
      hasMarkers: true,
      firstMarkerLine: 2,
    });
  });

  it("counts a bare CR as a line break, and CRLF as one", () => {
    expect(scanConflictMarkerText("first\rsecond\r\n>>>>>>> theirs")).toMatchObject({
      hasMarkers: true,
      firstMarkerLine: 3,
    });
    expect(scanConflictMarkerText("a\rb\n>>>>>>> theirs\r")).toMatchObject({
      hasMarkers: true,
      firstMarkerLine: 3,
    });
  });

  // Git splits lines only at LF, so it never writes a marker straight after a
  // bare CR, and the commit scan passes one there.
  it("matches the commit scan in ignoring a run that follows only a bare CR", () => {
    expect(scanConflictMarkerText("a\r>>>>>>> theirs\r")).toEqual({
      hunkCount: 0,
      hasMarkers: false,
      firstMarkerLine: null,
    });
  });

  // Review Hub asks about exactly what the commit scan would refuse: a run of
  // at least seven opener, base or closer characters standing alone at a line start.
  it("matches the commit scan's reading of wider runs, dividers and glued text", () => {
    expect(scanConflictMarkerText("a\n<<<<<<<<< ours\nb\n>>>>>>>>> theirs\n")).toEqual({
      hunkCount: 1,
      hasMarkers: true,
      firstMarkerLine: 2,
    });
    for (const content of [
      "kept\n=======\nright\n",
      "Title\n==========\n",
      "<<<<<<<HEAD\n>>>>>>>theirs\n",
      "<<<<<< six\n",
    ]) {
      expect(scanConflictMarkerText(content)).toEqual({
        hunkCount: 0,
        hasMarkers: false,
        firstMarkerLine: null,
      });
    }
  });
});
