# MangaHub v0.4 — nhentai API v2 Adapter

更新自 v0.3.3 FIXED 版本。

## 功能
- 左側 `nHentai Gallery`：輸入作品 URL 或數字 ID，讀取官方公開 Gallery Metadata。
- 使用 v2 `pages[].path` 形成 `https://i.nhentai.net/` 標準圖片 URL，再交給既有 Reader。
- 不下載完整圖片、不儲存帳號／Cookie／API Key、不繞過 403／429。
- 圖片是否顯示取決於來源 CDN，不能保證成功。

## 更新方式
使用 PATCH 複製檔案至 GitHub repo 根目錄，保留原有的 `.github` workflow。

## 測試
1. GitHub Actions Windows Build。
2. App 開啟 nHentai Gallery，輸入自己有權閱讀的作品 `/g/數字/` 網址。
3. 勾選年齡與存取聲明，按取得資料。
4. 讀取成功後確認頁數，再按在 MangaHub 閱讀。
5. 若無法載入圖片，檢查來源 CDN 的 HTTP 回應，不要密集重試。

## 開發狀態
此環境沒有 Cargo，也未能安裝 npm 依賴，尚未完成真實 TypeScript/Rust Build；請以 Actions 為準。
