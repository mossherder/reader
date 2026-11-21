# Reader

A minimal PDF reader for GitHub Pages. It pulls the text out of the PDF and reflows it so font size really changes. It starts in red night mode and remembers your place in every book.

- No build step: open `index.html` from any static server.
- `vendor/` holds pdf.js 4.10.38 (Apache-2.0), loaded only when you open a PDF.
- Only the current book's text is stored (IndexedDB). Other books keep just their title and position (localStorage), so loading the same PDF again resumes where you left off.
- When you change files, bump `CACHE` in `sw.js` so installed copies pick up the update.
