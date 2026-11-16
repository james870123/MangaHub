# MangaHub v0.3.2 更新說明

以 v0.3.1 為基礎，覆蓋 PATCH 內對應檔案到 Repository 根目錄，再執行 GitHub Actions。

## 變更
- 新增雙分段比較命令 `probe_comicbox_pair`，保留原本 `probe_comicbox_image`。
- 單段診斷增加 Content-Range、Range 是否生效、分段完整大小資訊。
- 可以一鍵比較 `.b_0` 與 `.b_1`；僅比對標頭與前 64 bytes，並不下載或還原圖片。
- 提供 JSON 報告匯出（會移除 URL query string 以降低洩漏風險）。
- 增加 Rust 單元測試與版本標記。

## 驗證
1. GitHub Actions 成功。
2. 開啟「來源診斷」，按「比較 b_0／b_1」。
3. 檢查 HTTP 206、Content-Range、兩段的尺寸與格式。
4. 按「匯出 JSON 報告」；若下載被 WebView 安全限制阻擋，請回報，後續可換成 Tauri 儲存對話框。

注意：支援 Range 或 CORS 不代表圖片有授權可重製／重新散布；診斷不處理加密影像。
