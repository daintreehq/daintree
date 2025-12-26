# Investigation: Direct DOM Snapshot for History Viewer

**Issue**: #1307
**Date**: 2025-12-26
**Status**: ❌ Not Recommended
**Decision**: Keep current ANSI → Anser approach

## Summary

Investigated whether cloning xterm's rendered DOM directly would be superior to the current ANSI serialization + Anser conversion approach for the history viewer. **Conclusion**: DOM cloning is fundamentally incompatible with the history viewer's requirements.

## Background

### Current Implementation

```
xterm buffer → SerializeAddon (ANSI) → Anser library → HTML spans → linkifyHtml → render
```

**Files**:

- `src/components/Terminal/HistoryOverlayTerminalView.tsx` - Main history viewer
- `src/components/Terminal/utils/historyUtils.ts` - Snapshot extraction using SerializeAddon
- `src/components/Terminal/utils/htmlUtils.ts` - ANSI→HTML conversion and URL linkification

**Process**:

1. Extract text from `term.buffer.active.getLine()` for up to 5000 lines
2. Serialize with ANSI codes via `SerializeAddon`
3. Convert ANSI → HTML using `Anser.ansiToHtml()`
4. Manually linkify URLs with regex
5. Render with `dangerouslySetInnerHTML`

### Proposed Alternative

```
xterm .xterm-rows → cloneNode(true) → attach click handlers → display
```

**Hypothesized benefits** (to be validated):

- Exact visual fidelity (same DOM as live terminal)
- No dependency on Anser library
- Links already rendered by WebLinksAddon/FileLinksAddon (hypothesis: invalidated, see findings below)
- No ANSI parsing overhead

## Investigation Findings

### Critical Limitation: Viewport-Only Rendering

After analyzing xterm.js 5.5.0 source code (`node_modules/@xterm/xterm/src/browser/renderer/dom/DomRenderer.ts`), we discovered:

**xterm's DOM renderer only contains viewport rows, NOT full scrollback:**

```typescript
// Line 70: Creates exactly `rows` number of DOM elements (viewport height)
this._refreshRowElements(this._bufferService.cols, this._bufferService.rows);

// Line 299-310: _refreshRowElements creates viewport-sized array
private _refreshRowElements(cols: number, rows: number): void {
  for (let i = this._rowElements.length; i <= rows; i++) {
    const row = this._document.createElement('div');
    this._rowContainer.appendChild(row);
    this._rowElements.push(row);
  }
  while (this._rowElements.length > rows) {
    this._rowContainer.removeChild(this._rowElements.pop()!);
  }
}

// Line 438-469: renderRows maps viewport index to buffer position
public renderRows(start: number, end: number): void {
  for (let y = start; y <= end; y++) {
    const row = y + buffer.ydisp;  // ydisp = scroll offset
    const rowElement = this._rowElements[y];  // y is 0 to rows-1
    // ... render buffer line `row` into viewport element `y`
  }
}
```

**What this means**:

1. `.xterm-rows` contains exactly `terminal.rows` child divs (typically 24-50 elements)
2. Each div represents one viewport row, not one buffer line
3. As you scroll, these divs are reused to display different buffer lines
4. The DOM is **viewport-relative**, not **buffer-absolute**

**Example**: For a 24-row terminal with 5000 lines of scrollback:

- `.xterm-rows` has 24 child divs (rows 0-23)
- When scrolled to top: div[0] shows buffer line 0, div[23] shows buffer line 23
- When scrolled to middle: div[0] shows buffer line 2488, div[23] shows buffer line 2511
- When scrolled to bottom: div[0] shows buffer line 4976, div[23] shows buffer line 4999

### Impact on DOM Clone Approach

Cloning `.xterm-rows` would only capture **24-50 visible lines**, not the **5000 lines** needed by history viewer.

**Alternatives considered**:

1. **Offscreen replay terminal**: Create hidden xterm, set rows=5000, feed buffer content, clone DOM
   - ❌ Massive overhead (rendering 5000 rows)
   - ❌ More complex than current approach
   - ❌ Still doing ANSI serialization (to feed the hidden terminal)

2. **Custom DOM renderer**: Walk `buffer.lines` and manually build DOM nodes
   - ❌ Re-implements DomRenderer's styling logic
   - ❌ Won't match xterm's exact rendering without copying internals
   - ❌ Much more complex than current approach

## Comparison Table

| Metric                | Current (ANSI→Anser)                                | DOM Clone                                |
| --------------------- | --------------------------------------------------- | ---------------------------------------- |
| **Scrollback access** | ✅ Full 5000 lines via buffer.lines                 | ❌ Only ~24-50 viewport lines            |
| **Visual fidelity**   | High (Anser output closely matches xterm rendering) | N/A (doesn't work)                       |
| **Code complexity**   | Medium (serialization + conversion)                 | N/A (not viable)                         |
| **Dependencies**      | Anser (8KB gzipped)                                 | None                                     |
| **Maintenance risk**  | Low (stable APIs)                                   | N/A (DOM structure is viewport-only)     |
| **Performance**       | Fast (direct buffer access)                         | N/A (cloning doesn't capture scrollback) |

## Additional Findings

### WebLinksAddon Implementation

Analyzed `node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts`:

- Uses `terminal.registerLinkProvider(new WebLinkProvider(...))` API
- Link provider adds hover/click handlers directly via xterm's linkifier
- Links are NOT marked in DOM with data attributes or classes
- Link detection happens in the linkifier, not in DOM rendering

This means even if DOM cloning worked, we'd need to:

1. Re-run link detection on cloned content, OR
2. Implement custom delegated click handling that duplicates linkifier logic

Both options add complexity without benefit.

### xterm CSS and Text Selection

The `.xterm` container has `user-select: none` by default. The `.xterm-rows` container itself doesn't disable selection, but individual spans may. For history overlay, we currently allow text selection, which works fine with the HTML rendering approach.

## Recommendation

**Keep the current ANSI → Anser approach** because:

1. ✅ **Only viable solution**: DOM cloning cannot access scrollback data
2. ✅ **Proven stability**: Current implementation works well, handles up to 5000 lines efficiently (configurable limit)
3. ✅ **Visual quality**: Anser output closely matches xterm rendering in practice
4. ✅ **Maintainable**: Well-understood conversion pipeline
5. ✅ **No better alternative**: DOM cloning is fundamentally incompatible

## Decision

**Status**: Investigation Complete
**Action**: No changes to implementation
**Rationale**: xterm's viewport-only DOM rendering makes DOM cloning non-viable for history viewer

## References

- Issue: #1307
- xterm.js version: 5.5.0
- Source code analyzed:
  - `node_modules/@xterm/xterm/src/browser/renderer/dom/DomRenderer.ts`
  - `node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts`
- Current implementation:
  - `src/components/Terminal/utils/historyUtils.ts`
  - `src/components/Terminal/utils/htmlUtils.ts`
  - `src/components/Terminal/HistoryOverlayTerminalView.tsx`
