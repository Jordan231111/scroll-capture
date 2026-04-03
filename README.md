# Scroll Capture

Scroll Capture is a Firefox MV3 extension that treats capture as a screenshot problem, not an HTML serialization problem.

It supports:

- `Visible PNG`: captures the current viewport exactly as rendered.
- `Visible PDF`: captures the current viewport and wraps it in a single-page PDF.
- `Expanded PDF`: walks the full page from top to bottom, expands nested vertical and horizontal scroll containers, flattens sticky and fixed overlays, and captures the result as a tiled PDF.

## Why this rewrite exists

The previous approach tried to save live application DOM as standalone HTML. That fails on too many modern sites because layout depends on runtime JS, reparsing, font metrics, portals, virtualization, and sticky positioning. This rewrite captures pixels from the live page instead.

## Expanded capture model

Expanded capture makes a temporary set of reversible changes before tiling:

- scrolls the page back to the top
- expands nested scrollable containers to reveal hidden content
- resets nested container scroll offsets to zero
- flattens `position: sticky` and `position: fixed` elements so they do not repeat in every tile
- disables animations and transitions during capture
- tiles both vertical and horizontal overflow instead of relying on one huge canvas

After capture, the page is restored to its original scroll position and inline styles.

## Limits

This is more reliable than standalone HTML capture, but it is still not magic:

- extremely large documents will produce many PDF pages
- cross-origin video, canvas, or DRM-backed content still depends on what the browser can visibly render
- carousels or transform-driven “fake scrollers” are not the same thing as native scroll containers
- expanded capture favors completeness over preserving the exact live layout

## Development

```bash
npm install
npm run build
```

The built extension zip is written to `dist/`.

## Repo layout

- [manifest.json](/Users/jordan/Documents/temp/page-view-capture/manifest.json)
- [background/background.js](/Users/jordan/Documents/temp/page-view-capture/background/background.js)
- [content/capture.js](/Users/jordan/Documents/temp/page-view-capture/content/capture.js)
- [popup/popup.html](/Users/jordan/Documents/temp/page-view-capture/popup/popup.html)
- [popup/popup.css](/Users/jordan/Documents/temp/page-view-capture/popup/popup.css)
- [popup/popup.js](/Users/jordan/Documents/temp/page-view-capture/popup/popup.js)
- [vendor/pdf-lib.esm.min.js](/Users/jordan/Documents/temp/page-view-capture/vendor/pdf-lib.esm.min.js)
