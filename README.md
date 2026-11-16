# MangaHub v0.3

Tauri 2 + React + TypeScript application. Version 0.3 adds a standalone clean-image reader while retaining ComicBox metadata and chapter navigation from v0.2.

## New in v0.3

- Import image files (JPG/PNG/WebP/AVIF and other browser-supported formats) using **Select local images**. They remain local and are not uploaded. File selections are session-only.
- Paste one HTTPS image URL per line. The application does not load source HTML, trackers or advertising scripts into the clean reader. Some sites reject cross-origin direct image requests.
- Long vertical scroll, left-to-right single-page, and right-to-left single-page modes, with arrow-key navigation.
- Preload neighboring images, report per-image load failures and permit retries; use the zoom control.
- Remember URL-list reading progress and mode in local storage, up to 100 reading lists. No cloud sync.
- ComicBox metadata chapter navigation continues to work, including the original-site fallback. **ComicBox image segmentation/encryption is NOT implemented.** This release does not bypass access control or remove ads from an embedded source website.

## Build with GitHub Actions

1. Replace your v0.2 repository root files using the PATCH archive, preserving directories.
2. Commit and push to `main`.
3. Run Actions → Build Windows MangaHub; download artifact.
4. Open Image Reader, choose some images from disk, and test vertical and single-page modes.
5. Paste direct, authorized HTTPS images and check failure/retry behavior if they are blocked by the source host.

To build locally: `npm install`, `npm run build`, `npm run tauri build` (requires Tauri 2 prerequisites).

**Verification:** Archive was created and inspected here. Full npm and Rust compilation could not be completed in this environment due to unavailable dependency installation. GitHub Actions will provide compilation validation.
