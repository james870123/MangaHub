# MangaHub v0.5 — 探索／搜尋／收藏／歷史

基於已驗證的 v0.4，保留 ComicBox、Reader、nHentai Gallery 與來源診斷。

## 新增
- 「漫畫探索」首頁：最新清單、今日熱門（API v2 `/galleries/popular`）
- 搜尋：關鍵字、排序（最新／全部熱門／今日／本週／本月）、分頁
- 漫畫封面卡、詳情、標籤及開啟 Reader
- 收藏與最近閱讀：資料只存在本機 localStorage；閱讀進度依單頁／長條模式記錄
- 成人內容選項：年齡確認、封面預設隱藏、隨時停用目錄
- 對 403／429 顯示錯誤，不自動重試

## GitHub 更新
將本壓縮包根目錄所有檔案覆蓋到 Repo 根目錄並 Commit；若使用 PATCH 需包含新增 `src/NhCatalog.tsx`。
GitHub Actions 使用現有 `.github/workflows/windows.yml`。先檢查 `npm run build` 與 `cargo test` 再產生 EXE。

## 測試
1. 執行 EXE →「漫畫探索」→ 勾選成人內容設定。
2. 在不顯示封面的情況測試「最新／熱門」，再自行選擇顯示封面。
3. 搜尋一般關鍵字；切換排序與下一頁，點作品卡片查看詳情。
4. 點收藏，前往「我的收藏」，確認本機保存。
5. 點「在 MangaHub 閱讀」，翻頁後回到「最近閱讀」確認紀錄。
6. 遇到 403／429 不重試，保留錯誤訊息以供分析。

## 限制
API 目前只根據公開的 v2 文件與第三方 Schema 實作，目錄 JSON 欄位、縮圖格式及來源是否可讀需實機驗證。封面 CDN 若禁止載入則呈現預設底圖。
「最近閱讀」紀錄是本機，不是帳號同步；API 不提供版權授權保證。漫畫圖片仍依來源使用權限。

## 技術
Rust `browse_nh_catalog` 只向固定 `https://nhentai.net` 公開 API 發送請求，沒有任意代理或驗證繞過。前端 `NhCatalog.tsx`，沿用既有 `fetch_nh_gallery`、`Reader.tsx`。
