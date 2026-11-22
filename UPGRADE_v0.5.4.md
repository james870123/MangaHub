# MangaHub v0.5.4 — Reader & public API update

## 修正
- 「返回漫畫列表」不再使用 CSS sticky；向下捲漫畫時按鈕會自然捲出畫面，不再覆蓋漫畫。可用 Esc / Alt+Left 返回。
- 保留原本的列表分頁、搜尋及捲動位置。

## 新增公開閱讀功能
- 隨機作品（GET /api/v2/galleries/random）
- 相關作品（GET /api/v2/galleries/{id}/related），在詳情彈窗顯示
- 搜尋進階條件：作者、語言、標籤、角色、社團、作品來源，使用既有 /api/v2/search 的查詢語法
- 詳情標籤可點擊搜尋、指定頁碼跳頁

## 不包含
新版 OpenAPI 還有登入、帳號收藏同步、發表評論、建議修改、檢舉、下載與後台管理等端點。這些要求登入/特定角色/授權，並非適合直接加入本機匿名閱讀器的功能。未使用繞過權限措施。部分新公開端點的實際回應格式需 GitHub Actions 及實機驗證。

## 安裝
以 FULL zip 或 PATCH 覆蓋原專案根目錄；GitHub Actions Windows Build 驗證。不要直接將 FULL zip 作為單一檔案放進 Repository。
