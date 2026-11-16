# Upgrade v0.2 → v0.3

Unzip the PATCH into the repository root (not as an extra nested folder), overwriting matching files. Add the new `src/Reader.tsx`. Do not replace local `node_modules` or `src-tauri/target`. Commit and push. The existing `.github/workflows/windows.yml` still builds Windows.

Changed: `src/Reader.tsx` (new), `src/main.tsx`, `src/style.css`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`, and `README.md`.

Test first with images you own using the reader's local file import, then with publicly accessible direct HTTPS image URLs. ComicBox protected/segmented chapter images remain unsupported.
