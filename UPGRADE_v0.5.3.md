# MangaHub v0.5.3 — UI navigation update

Based on tested v0.5.2, updating four frontend files (main.tsx, NhCatalog.tsx, Reader.tsx, style.css) and two version files.

- Collapsible desktop sidebar; preference saved locally. On small screens, the navigation remains horizontal and scrollable.
- Gallery reader includes a back button, Esc and Alt+Left shortcuts. Returning to catalog restores the list tab, search, results, pagination and scroll position. Catalog is kept mounted while reading to avoid repeat API calls and lose state.
- Gallery reader hides the generic URL editing box to focus on reading, without affecting standalone image reader.
- Cover fallbacks: failing covers keep placeholders; opening Gallery details may refresh its cover from the detail API, as permitted, and restore saved history / favorites. No guessed CDN urls and no automatic network retry storms.
- Explicit keyboard focus states and improved card hover affordances.

## Updating GitHub
Copy the contents of PATCH zip into the repository root, replacing files. Build with GitHub Actions.

## Testing
1. Expand/collapse sidebar and restart app, checking preference.
2. Search or go to catalog page 3, scroll, open gallery, click Reader back; verify identical page and scroll.
3. Test Escape or Alt+Left; inspect recent history and favorites.
4. Inspect image covers on gallery list and after opening details; some CDN issues may remain.

This update does not bypass API 403/429 or guarantee every cover can load.
