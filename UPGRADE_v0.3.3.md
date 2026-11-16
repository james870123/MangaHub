# MangaHub v0.3.3 更新說明

- 新增 `sourceCapabilities.ts`：兩種來源的明確能力宣告（ComicBox 僅章節索引；直接圖片支援 Reader）。
- 新增 `SourceCapabilities.tsx`：來源能力介面和使用者授權圖片清單入口。
- Reader 支援從來源頁帶入圖片清單；保留原本本機圖片與直接網址閱讀功能。
- 章節閱讀入口提供來源相容性資訊，不會把 ComicBox 分段資料誤當成可閱讀的圖片。
- 未新增任何用於繞過 403、重組、解密圖片或探測私有 API 的程式。

## 安裝

將 PATCH 內容覆蓋到 v0.3.2 Repository 根目錄，確認隱藏的 `.github` 未被刪除，再 Commit 到 main，透過 Actions Build。

## 測試

1. ComicBox 第 1 話仍可從章節清單進入；此章節應顯示為「原站專用圖片處理」。
2. 左側新增「來源相容性」，可看到來源能力宣告。
3. 在「來源相容性」貼入自有或授權的 HTTPS 標準圖片網址，確認授權後點選「在 MangaHub 閱讀」。
4. Reader 應出現圖片清單，若圖片來源不允許載入，會顯示錯誤提示。

編譯尚需使用 GitHub Actions 正式驗證。
