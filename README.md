# MangaHub v0.1

A clean, local-first manga reader prototype based on **Tauri 2 + React + TypeScript + Rust**. It is a standalone project inspired by the cross-platform HGhub build workflow, **not** a copy of its repository.

## Implemented

- ComicBox public chapter **metadata** inspection (title, chapter list, page node count) via Rust + reqwest + scraper.
- Input security: HTTPS, exact allowlisted host and numeric chapter IDs, no redirects, response size cap.
- Personal bookmarks stored in localStorage.
- Clean vertical/single-page reader for direct HTTPS image URLs you have permission to use.
- No third-party advertising scripts, browser embedding, or tracking SDK.
- Windows GitHub Actions build: raw EXE plus NSIS installer.

## Intentionally not implemented

ComicBox's current image pipeline downloads chunked binary data and performs image processing in JavaScript. This project does **not** decrypt, descramble, bypass access controls, or claim that ComicBox images can be rendered as ordinary JPEGs. The source inspector only identifies HTML nodes; the standalone reader accepts user-supplied accessible image URLs.

## Run locally (Windows)

Prerequisites: Node.js 22+, Rust stable (MSVC toolchain), Microsoft C++ Build Tools, WebView2 runtime.

```powershell
npm install
npm run tauri dev
```

To build a Windows executable and installer:

```powershell
npm run tauri build
```

Outputs:
- `src-tauri/target/release/mangahub.exe` (unpacked executable; WebView2 dependency, not a fully statically packaged app)
- `src-tauri/target/release/bundle/nsis/*.exe` (installer)

### GitHub Actions

1. Create a new repository (recommended: `MangaHub`).
2. Upload **the contents** of this folder to the repository root; use branch `main`.
3. Go to **Actions → Build Windows MangaHub → Run workflow**.
4. Download the output artifacts.

## iOS

The core Rust/React structure is compatible with the Tauri iOS pipeline, but **this v0.1 archive does not contain a working signed IPA workflow**. iOS needs a Mac/Xcode toolchain, an Apple signing team and matching provisioning profile/certificate. Start with `npx tauri ios init` on macOS before configuring a signed GitHub Actions build. Avoid claiming that unsigned builds can be sideloaded.

## Technical notes

- `src-tauri/src/lib.rs`: restricted ComicBox metadata parser and tests.
- `src/main.tsx`: interface, library, user-supplied image URL reader.
- `src/style.css`: responsive desktop/mobile dark UI.
- `.github/workflows/windows.yml`: Windows CI build.
- Browser-only `npm run dev` shows UI but cannot invoke Rust chapter inspection; use `npm run tauri dev` for live inspection.
- No account synchronization: localStorage is per device. A separate sync feature would need explicit design.
- Network inspection respects website policies; content rights and permitted usage must be checked for any source integration.
