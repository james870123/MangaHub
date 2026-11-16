# MangaHub v0.2 更新說明

此壓縮包以 v0.1 成功編譯版本為基礎，包含完整專案；將內部檔案覆蓋 GitHub Repository 根目錄即可。請不要把最外層的資料夾當作 Repository 根目錄。

## 變更

- 章節點擊會進入「章節閱讀入口」，不再清空解析好的章節清單。
- 對成功取得的章節中繼資料採用 localStorage 快取（按章節 ID 分開）；提供明確的「重新取得」按鈕。
- 遇到 403 仍保留舊資料，並顯示 HTTP 狀態和請求 URL。
- 使用 Tauri opener plugin 將章節網址交給系統預設瀏覽器開啟；不在內嵌頁面載入原站廣告。
- 保留原本的「貼入直接圖片 URL」純淨閱讀器，未支援 ComicBox 特殊圖片分段解碼。
- 補入 Windows 必要的 icon.ico。

## 測試

1. Actions → Build Windows MangaHub → Run workflow。
2. 打開 v0.2，解析 https://www.comicbox.xyz/free-chapter/42682?t=20260415 。
3. 點第一話：應進入「章節閱讀入口」，遇到 403 不會丟失上一頁的章節清單。
4. 點「使用 Edge／預設瀏覽器閱讀」：系統會將章節連結交給預設瀏覽器（不保證一定是 Edge）。
5. 再點已成功解析過的章節，應直接使用索引快取；需要刷新時按「重新取得章節資訊」。

注意：v0.2 並未提供內嵌 WebView 模式。外部瀏覽器可用性優先，內嵌網站涉及廣告、WebView 相容性與安全限制，後續再獨立規劃。
