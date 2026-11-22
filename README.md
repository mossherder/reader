# Reader

A minimal PDF reader for GitHub Pages. It pulls the text out of the PDF and reflows it so font size really changes. It starts in red night mode and remembers your place in every book.

- No build step: open `index.html` from any static server.
- `vendor/` holds pdf.js 4.10.38 (Apache-2.0), loaded only when you open a PDF. The worker has two small patches, marked `reader-patch`, so that "f" glyphs with broken font names come through as "f" instead of spaces or stray symbols. Re-apply them if you upgrade pdf.js.
- Only the current book's text is stored (IndexedDB). Other books keep just their title and position (localStorage), so loading the same PDF again resumes where you left off.
- Every deploy: bump `CACHE` in `sw.js`. Installed apps check for a new `sw.js` when they return to the foreground and reload themselves into the new version, keeping your place.
