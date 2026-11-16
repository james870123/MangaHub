# MangaHub v0.3.1 — Source Compatibility Diagnostic

## 更新方式
將 PATCH 內的檔案覆蓋到現有 v0.3 Repository 根目錄，Commit 後由 GitHub Actions 編譯。

新增側邊選單「來源診斷」。預設範例為 HAR 中的一筆 ComicBox `.b_0` 圖片分段請求。按下「執行診斷」，可確認 HTTP 狀態、Content-Type、CORS 回應標頭與檔案前 64 bytes 是否有一般圖片簽名。

## 限制
- 只允許已知的 ComicBox 圖片 CDN HTTPS 路徑，不支援任意外部網址，也不進行繞過、解密或 API 掃描。
- 透過 `Range: bytes=0-63` 提出請求，但伺服器可能忽略 Range；程式僅分析第一個回應 chunk 的前 64 bytes。
- 若伺服器拒絕 Rust 請求，會顯示 HTTP 403 等狀態；不代表 Edge 的請求也會被拒絕。
- Content-Type / Magic Bytes / CORS 都是線索，不代表使用許可。

## 建置驗證
本環境無 Rust/Cargo，Rust 部分請以 GitHub Actions `cargo test` 為準；Node TypeScript 編譯視安裝環境而定。
