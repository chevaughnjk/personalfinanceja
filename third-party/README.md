# vendor/

This folder holds the pdf.js library used for on-device PDF reading:

- `pdf.min.mjs`
- `pdf.worker.min.mjs`

They are **not** committed. They are copied here automatically from
`node_modules/pdfjs-dist` when you run `npm install` (via the `postinstall`
step), or any time with:

```
npm run vendor
```

Keeping pdf.js out of the repository keeps it lean; the app is still fully
offline once dependencies are installed, because the service worker caches
these two files as part of the application shell.
