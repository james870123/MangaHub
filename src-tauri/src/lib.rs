use scraper::{Html, Selector};
use serde::Serialize;
use serde_json::Value;
use tauri::command;
use url::Url;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Chapter { id: String, title: String, url: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterInfo {
    title: String,
    url: String,
    chapter_id: String,
    pages: usize,
    chapters: Vec<Chapter>,
    encrypted_image_pipeline: bool,
}

// Restrict network access to explicitly supported public chapter pages only.
fn validate_chapter_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "網址格式錯誤".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("www.comicbox.xyz")
        || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("僅支援 https://www.comicbox.xyz/free-chapter/{id}".into());
    }
    let segments: Vec<_> = url.path_segments().ok_or("網址格式錯誤")?.collect();
    if segments.len() != 2 || segments[0] != "free-chapter"
        || segments[1].is_empty() || !segments[1].bytes().all(|b| b.is_ascii_digit()) {
        return Err("請貼上 ComicBox 章節閱讀頁，而非首頁或漫畫詳情頁".into());
    }
    Ok(url)
}

// v0.6.4: opt-in, bounded on-device image cache. Only existing, validated
// public image URLs are accepted. No cookies, redirects or anti-bot bypass.
use tauri::Manager;

const IMAGE_CACHE_MAX_ITEM: usize = 12 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCacheStats { bytes: u64, files: usize, rouman_bytes: u64, nhentai_bytes: u64 }

// Keep chapter parsing and the optional disk cache on the same explicit CDN allowlist.
// Do not accept arbitrary domains from an untrusted chapter HTML document.
fn validate_rouman_image_source(u: &Url) -> Result<(), &'static str> {
    if u.scheme() != "https" { return Err("不是 HTTPS 網址"); }
    if u.port().is_some() || !u.username().is_empty() || u.password().is_some() {
        return Err("包含自訂連接埠或帳號資訊");
    }
    if !matches!(u.host_str().unwrap_or(""),
        "v1.towm85.xyz" | "v2.towm85.xyz" | "v3.towm85.xyz" | "v4.towm85.xyz"
        | "v1.kelv47.xyz" | "kelv47.xyz") {
        return Err("圖片主機不在已驗證的 CDN 清單");
    }
    if !u.path().starts_with("/m/") { return Err("圖片路徑不是 /m/ 開頭"); }
    Ok(())
}

fn image_cache_url(input: &str) -> Result<(Url, &'static str), String> {
    let u = Url::parse(input).map_err(|_| "無效圖片網址")?;
    if u.scheme() != "https" || u.port().is_some() || !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() {
        return Err("快取只允許不含帳密的 HTTPS 圖片網址".into());
    }
    let host = u.host_str().unwrap_or("");
    let source = if validate_rouman_image_source(&u).is_ok() { "rouman" }
    else if host == "i.nhentai.net" && u.path().starts_with("/galleries/") { "nhentai" }
    else { return Err("來源未列入圖片快取允許清單".into()); };
    Ok((u, source))
}

fn cache_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in s.as_bytes() { h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}

fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_cache_dir().map(|p| p.join("image-cache-v1"))
        .map_err(|e| format!("無法取得快取路徑：{e}"))
}

fn cache_stats_at(base: &std::path::Path) -> ImageCacheStats {
    let mut out = ImageCacheStats {bytes: 0, files: 0, rouman_bytes: 0, nhentai_bytes: 0};
    for (source, sub) in [("rouman", true), ("nhentai", false)] {
        if let Ok(entries) = std::fs::read_dir(base.join(source)) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if !meta.is_file() { continue; }
                    out.files += 1;
                    out.bytes = out.bytes.saturating_add(meta.len());
                    if sub { out.rouman_bytes += meta.len(); } else { out.nhentai_bytes += meta.len(); }
                }
            }
        }
    }
    out
}

fn trim_cache(base: &std::path::Path, limit_bytes: u64) {
    let mut files = Vec::<(std::time::SystemTime, u64, std::path::PathBuf)>::new();
    let mut total = 0_u64;
    for source in ["rouman", "nhentai"] {
        if let Ok(entries) = std::fs::read_dir(base.join(source)) {
            for entry in entries.flatten() {
                if let Ok(m) = entry.metadata() {
                    if !m.is_file() { continue; }
                    total = total.saturating_add(m.len());
                    files.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), entry.path()));
                }
            }
        }
    }
    files.sort_unstable_by_key(|(modified, _, _)| *modified);
    for (_, bytes, path) in files {
        if total <= limit_bytes { break; }
        if std::fs::remove_file(path).is_ok() { total = total.saturating_sub(bytes); }
    }
}

fn is_image_bytes(data: &[u8]) -> bool {
    data.starts_with(&[0xff, 0xd8, 0xff]) // JPEG
        || data.starts_with(b"\x89PNG\r\n\x1a\n")
        || (data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP")
        || data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")
        || (data.len() >= 12 && &data[4..8] == b"ftyp" && (&data[8..12] == b"avif" || &data[8..12] == b"avis"))
}

#[command]
fn image_cache_stats(app: tauri::AppHandle) -> Result<ImageCacheStats, String> {
    Ok(cache_stats_at(&cache_dir(&app)?))
}

#[command]
fn image_cache_clear(app: tauri::AppHandle) -> Result<ImageCacheStats, String> {
    let base = cache_dir(&app)?;
    // Delete only the dedicated image-cache-v1 directory; never touch reading progress.
    if base.exists() { std::fs::remove_dir_all(&base).map_err(|e| format!("清除失敗：{e}"))?; }
    Ok(cache_stats_at(&base))
}

#[command]
fn image_cache_trim(app: tauri::AppHandle, limit_mb: u32) -> Result<ImageCacheStats, String> {
    if !matches!(limit_mb, 500 | 1024 | 2048) { return Err("快取大小設定無效".into()); }
    let base = cache_dir(&app)?;
    trim_cache(&base, u64::from(limit_mb) * 1024 * 1024);
    Ok(cache_stats_at(&base))
}

#[command]
async fn image_cache_get(app: tauri::AppHandle, url: String, limit_mb: u32) -> Result<tauri::ipc::Response, String> {
    if !matches!(limit_mb, 500 | 1024 | 2048) { return Err("快取大小設定無效".into()); }
    let (target, source) = image_cache_url(&url)?;
    let base = cache_dir(&app)?;
    let dir = base.join(source);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立快取目錄失敗：{e}"))?;
    let file = dir.join(format!("{}.image", cache_hash(target.as_str())));
    if let Ok(bytes) = std::fs::read(&file) {
        if bytes.len() <= IMAGE_CACHE_MAX_ITEM && is_image_bytes(&bytes) {
            if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&file) {
                let _ = f.set_modified(std::time::SystemTime::now());
            }
            return Ok(tauri::ipc::Response::new(bytes));
        }
        let _ = std::fs::remove_file(&file);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("MangaHub/0.6.4 (opt-in image cache)")
        .build().map_err(|e| e.to_string())?;
    let mut response = client.get(target).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("圖片伺服器 HTTP {}", response.status())); }
    if response.content_length().unwrap_or(0) > IMAGE_CACHE_MAX_ITEM as u64 { return Err("圖片過大".into()); }
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
        let value = content_type.to_str().unwrap_or("").to_ascii_lowercase();
        if !value.starts_with("image/") && !value.starts_with("application/octet-stream") {
            return Err("伺服器未回傳圖片".into());
        }
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if data.len().saturating_add(chunk.len()) > IMAGE_CACHE_MAX_ITEM { return Err("圖片超出快取上限".into()); }
        data.extend_from_slice(&chunk);
    }
    if !is_image_bytes(&data) { return Err("圖片格式無法驗證".into()); }
    // Cache write failures should not prevent the image from being read.
    let tmp = dir.join(format!("{}.partial", cache_hash(&url)));
    if std::fs::write(&tmp, &data).is_ok() {
        if std::fs::rename(&tmp, &file).is_ok() {
            trim_cache(&base, u64::from(limit_mb) * 1024 * 1024);
        } else { let _ = std::fs::remove_file(tmp); }
    }
    Ok(tauri::ipc::Response::new(data))
}

#[cfg(test)]
mod image_cache_tests {
    use super::*;
    #[test]
    fn allowed_image_urls_only() {
        assert!(image_cache_url("https://v1.towm85.xyz/m/sample.jpg").is_ok());
        assert!(image_cache_url("https://v1.kelv47.xyz/m/sample.jpg?sr=1").is_ok());
        assert!(image_cache_url("https://kelv47.xyz/m/sample.jpg").is_ok());
        assert!(image_cache_url("https://v1.kelv47.xyz.evil.test/m/1.jpg").is_err());
        assert!(image_cache_url("http://v1.kelv47.xyz/m/1.jpg").is_err());
        assert!(image_cache_url("https://i.nhentai.net/galleries/123/1.jpg").is_ok());
        assert!(image_cache_url("https://localhost/m/private.jpg").is_err());
        assert!(image_cache_url("https://v1.towm85.xyz.evil.test/m/1.jpg").is_err());
        assert!(image_cache_url("http://i.nhentai.net/galleries/1/1.jpg").is_err());
    }
    #[test]
    fn image_sniffing() {
        assert!(is_image_bytes(&[255, 216, 255, 0]));
        assert!(!is_image_bytes(b"<html>oops</html>"));
    }
}


#[command]
async fn inspect_comicbox_chapter(url: String) -> Result<ChapterInfo, String> {
    let target = validate_chapter_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("MangaHub/0.1 (chapter metadata inspection)")
        .build().map_err(|e| e.to_string())?;
    let response = client.get(target.clone()).send().await.map_err(|e| format!("網站連線失敗：{e}"))?;
    if !response.status().is_success() { return Err(format!("HTTP {} · URL: {} · 來源站拒絕或無法完成本次請求", response.status(), target)); }
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
        if !content_type.to_str().unwrap_or("").contains("text/html") { return Err("回應不是 HTML".into()); }
    }
    if response.content_length().unwrap_or(0) > 2_000_000 { return Err("網頁資料過大".into()); }
    let html = response.text().await.map_err(|e| e.to_string())?;
    if html.len() > 2_000_000 { return Err("網頁資料過大".into()); }
    Ok(parse_chapter(&html, &target))
}

fn parse_chapter(html: &str, target: &Url) -> ChapterInfo {
    let doc = Html::parse_document(html);
    let selector_pages = Selector::parse(".comicpage [data-src]").unwrap();
    let selector_chapters = Selector::parse("a[href*='/free-chapter/']").unwrap();
    let selector_title = Selector::parse("meta[property='og:title']").unwrap();
    let title = doc.select(&selector_title).next()
        .and_then(|x| x.value().attr("content")).unwrap_or("未命名章節").to_string();
    let mut chapters = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for element in doc.select(&selector_chapters) {
        let Some(href) = element.value().attr("href") else { continue };
        let Ok(link) = target.join(href) else { continue };
        if validate_chapter_url(link.as_str()).is_err() { continue; }
        let id = link.path().trim_start_matches("/free-chapter/").to_string();
        if !seen.insert(id.clone()) { continue; }
        let text = element.text().collect::<Vec<_>>().join(" ");
        let chapter_title = text.split_whitespace().collect::<Vec<_>>().join(" ");
        chapters.push(Chapter { id, title: if chapter_title.is_empty() { "未命名章節".into() } else { chapter_title }, url: link.to_string() });
    }
    ChapterInfo {
        title, url: target.to_string(),
        chapter_id: target.path().trim_start_matches("/free-chapter/").to_string(),
        pages: doc.select(&selector_pages).count(), chapters,
        encrypted_image_pipeline: html.contains("merge_monga") || html.contains("data-bmi-manifest"),
    }
}


// Diagnostics are intentionally limited to the known ComicBox image CDN.
// No credentials, session cookies, challenge bypass or decryption is used.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageProbe {
    url: String,
    http_status: u16,
    content_type: String,
    content_length: Option<u64>,
    cors_header: String,
    detected_format: String,
    directly_renderable: bool,
    sampled_bytes: usize,
    content_range: String,
    resource_size: Option<u64>,
    range_honored: bool,
    explanation: String,
}

fn validate_image_probe_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "圖片網址格式錯誤".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("bmigmi-global-wuwu.ccavbox.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.path().starts_with("/break_2/static/upload/book/")
            || url.path().starts_with("/break_avif/static/upload/book/"))
    { return Err("僅允許 ComicBox 已知圖片 CDN 的 HTTPS 圖片路徑".into()); }
    Ok(url)
}

fn resource_size_from_range(value: &str) -> Option<u64> {
    // RFC 9110 Content-Range example: bytes 0-63/52352
    let (unit_and_range, total) = value.split_once('/')?;
    if !unit_and_range.starts_with("bytes ") { return None; }
    if total == "*" { return None; }
    total.parse::<u64>().ok()
}

fn paired_image_urls(url: &Url) -> Result<(Url, Url), String> {
    let path = url.path();
    let base = if let Some(base) = path.strip_suffix(".b_0") { base }
               else if let Some(base) = path.strip_suffix(".b_1") { base }
               else { return Err("請提供以 .b_0 或 .b_1 結尾的圖片分段網址".into()); };
    let mut a = url.clone();
    let mut b = url.clone();
    a.set_path(&format!("{base}.b_0"));
    b.set_path(&format!("{base}.b_1"));
    validate_image_probe_url(a.as_str())?;
    validate_image_probe_url(b.as_str())?;
    Ok((a, b))
}

fn classify_image_header(data: &[u8]) -> &'static str {
    if data.starts_with(&[0xff, 0xd8, 0xff]) { return "JPEG"; }
    if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) { return "PNG"; }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" { return "WebP"; }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) { return "GIF"; }
    if data.len() >= 16 && &data[4..8] == b"ftyp"
        && (&data[8..12] == b"avif" || &data[8..12] == b"avis") { return "AVIF"; }
    "未辨識的二進位資料"
}

async fn probe_one(target: Url, client: &reqwest::Client) -> Result<ImageProbe, String> {
    let mut response = client.get(target.clone())
        .header(reqwest::header::RANGE, "bytes=0-63")
        .send().await.map_err(|e| format!("圖片來源連線失敗：{e}"))?;
    let status = response.status().as_u16();
    let headers = response.headers();
    let content_type = headers.get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok()).unwrap_or("未提供").to_string();
    let cors = headers.get(reqwest::header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|h| h.to_str().ok()).unwrap_or("未提供").to_string();
    let range = headers.get(reqwest::header::CONTENT_RANGE)
        .and_then(|h| h.to_str().ok()).unwrap_or("未提供").to_string();
    let length = response.content_length();
    let range_honored = status == 206 && range.starts_with("bytes ");
    let resource_size = resource_size_from_range(&range);
    // Range 0-63 is intentionally tiny. For status 200, only inspect the first
    // received chunk; never collect the remaining body or persist it.
    let head = if (200..300).contains(&status) {
        response.chunk().await.map_err(|e| format!("讀取資料標頭失敗：{e}"))?
            .map(|chunk| chunk[..chunk.len().min(64)].to_vec()).unwrap_or_default()
    } else { Vec::new() };
    let format = classify_image_header(&head).to_string();
    let recognized = format != "未辨識的二進位資料";
    let renderable = (200..300).contains(&status) && recognized;
    let explanation = if (300..400).contains(&status) {
        "來源回傳重新導向，已停止，不追蹤至未知網域。"
    } else if status == 403 {
        "HTTP 403：來源拒絕本次請求，不嘗試繞過。"
    } else if !(200..300).contains(&status) {
        "請求未成功，無法判斷圖片格式。"
    } else if recognized {
        "開頭符合標準圖片簽名，但這不代表完整資源可以直接閱讀或具有第三方授權。"
    } else {
        "前 64 bytes 無法辨識為標準圖片；可能是分段、專用容器或其他二進位資料。"
    }.to_string();
    Ok(ImageProbe { url: target.to_string(), http_status: status,
        content_type, content_length: length, cors_header: cors,
        detected_format: format, directly_renderable: renderable,
        sampled_bytes: head.len(), content_range: range,
        resource_size, range_honored, explanation })
}

fn probe_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("MangaHub/0.3.2 (read-only source diagnostics)")
        .build().map_err(|e| e.to_string())
}

#[command]
async fn probe_comicbox_image(url: String) -> Result<ImageProbe, String> {
    let target = validate_image_probe_url(&url)?;
    let client = probe_client()?;
    probe_one(target, &client).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairProbe {
    parts: Vec<ImageProbe>,
    same_content_type: bool,
    both_range_honored: bool,
    reported_total_bytes: Option<u64>,
    explanation: String,
}

#[command]
async fn probe_comicbox_pair(url: String) -> Result<PairProbe, String> {
    let target = validate_image_probe_url(&url)?;
    let (a, b) = paired_image_urls(&target)?;
    let client = probe_client()?;
    // Intentionally issue exactly two small range requests, without retries.
    let first = probe_one(a, &client).await?;
    let second = probe_one(b, &client).await?;
    let same = first.content_type == second.content_type;
    let both_range_honored = first.range_honored && second.range_honored;
    // This is the sum of the *individual segment resource lengths*, not the
    // length of a reconstructed image; no reconstruction is performed.
    let reported_total_bytes = first.resource_size.zip(second.resource_size)
        .and_then(|(x, y)| x.checked_add(y));
    Ok(PairProbe { parts: vec![first, second], same_content_type: same,
        both_range_honored, reported_total_bytes,
        explanation: "僅比較兩個 HTTP 分段的標頭與前 64 bytes；不合併、解密或下載完整圖片。".into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_range_total_and_pairs() {
        assert_eq!(resource_size_from_range("bytes 0-63/52352"), Some(52352));
        assert_eq!(resource_size_from_range("bytes 0-63/*"), None);
        let url = validate_image_probe_url("https://bmigmi-global-wuwu.ccavbox.com/break_avif/static/upload/book/5687/42682/3066481.b_0?v=1").unwrap();
        let (a, b) = paired_image_urls(&url).unwrap();
        assert!(a.path().ends_with("3066481.b_0"));
        assert!(b.path().ends_with("3066481.b_1"));
        assert_eq!(b.query(), Some("v=1"));
    }
    #[test]
    fn probe_rejects_other_hosts_and_ports() {
        assert!(validate_image_probe_url("https://127.0.0.1/break_avif/static/upload/book/1/2/3.b_0").is_err());
        assert!(validate_image_probe_url("https://bmigmi-global-wuwu.ccavbox.com:444/break_avif/static/upload/book/1/2/3.b_0").is_err());
        assert!(validate_image_probe_url("https://bmigmi-global-wuwu.ccavbox.com/not-allowed/1.jpg").is_err());
    }
    #[test]
    fn image_signatures() {
        assert_eq!(classify_image_header(&[0xff,0xd8,0xff,0x00]), "JPEG");
        assert_eq!(classify_image_header(b"RIFFabcdWEBP123"), "WebP");
        assert_eq!(classify_image_header(b"encrypted-chunk"), "未辨識的二進位資料");
    }
    #[test]
    fn rejects_untrusted_hosts() {
        assert!(validate_chapter_url("https://www.comicbox.xyz.evil.test/free-chapter/123").is_err());
        assert!(validate_chapter_url("http://www.comicbox.xyz/free-chapter/123").is_err());
        assert!(validate_chapter_url("https://www.comicbox.xyz/book/123").is_err());
    }
    #[test]
    fn extracts_chapter_metadata() {
        let html = r#"<meta property="og:title" content="Sample"><div class="comicpage"><div data-src="https://image.test/a.jpg"></div><div data-src="https://image.test/b.jpg"></div></div><a href="/free-chapter/123">第 1 話</a>"#;
        let u = Url::parse("https://www.comicbox.xyz/free-chapter/123").unwrap();
        let info = parse_chapter(html, &u);
        assert_eq!(info.pages, 2);
        assert_eq!(info.chapters.len(), 1);
    }
}


// nHentai v2 public gallery metadata. This command never fetches image bytes,
// does not use cookies, bypass challenges, or discover private endpoints.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhGallery {
    id: u64,
    title: String,
    page_urls: Vec<String>,
    cover_url: Option<String>,
    tags: Vec<String>,
}

fn nh_gallery_id(input: &str) -> Result<u64, String> {
    let trimmed = input.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return trimmed.parse::<u64>().ok().filter(|&n| n > 0)
            .ok_or_else(|| "作品 ID 無效".into());
    }
    let u = Url::parse(trimmed).map_err(|_| "請輸入作品 ID 或 https://nhentai.net/g/數字/".to_string())?;
    if u.scheme() != "https" || u.host_str() != Some("nhentai.net")
        || u.port().is_some() || u.query().is_some() || u.fragment().is_some()
        || !u.username().is_empty() || u.password().is_some() {
        return Err("僅允許 nhentai.net 的 HTTPS 作品網址".into());
    }
    let segments: Vec<_> = u.path().trim_matches('/').split('/').collect();
    if segments.len() != 2 || segments[0] != "g" || segments[1].is_empty()
        || !segments[1].bytes().all(|b| b.is_ascii_digit()) {
        return Err("網址格式應為 https://nhentai.net/g/123456/".into());
    }
    segments[1].parse::<u64>().ok().filter(|&n| n > 0)
        .ok_or_else(|| "作品 ID 無效".into())
}

fn verified_page_url(path: &str) -> Result<String, String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 3 || parts[0] != "galleries"
        || !parts[1].bytes().all(|b| b.is_ascii_digit()) || parts[1].is_empty() {
        return Err("API 圖片路徑不符合預期".into());
    }
    let Some((number, ext)) = parts[2].rsplit_once('.') else {
        return Err("API 圖片路徑沒有副檔名".into());
    };
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit())
        || !matches!(ext, "jpg" | "png" | "webp" | "gif" | "avif") {
        return Err("API 圖片格式不支援".into());
    }
    Ok(format!("https://i.nhentai.net/{path}"))
}

fn parse_nh_gallery(data: &Value, requested_id: u64) -> Result<NhGallery, String> {
    let id = data.get("id").and_then(Value::as_u64).ok_or("API 沒有作品 ID")?;
    if id != requested_id { return Err("API 回傳的作品 ID 不符合請求".into()); }
    let title = data.get("title")
        .and_then(|v| ["pretty", "english", "japanese"].iter()
            .find_map(|key| v.get(*key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())))
        .unwrap_or("未命名作品").chars().take(240).collect::<String>();

    let pages = data.get("pages").and_then(Value::as_array)
        .ok_or("API 沒有 pages 清單，無法直接閱讀")?;
    if pages.is_empty() || pages.len() > 1000 { return Err("作品頁數不在支援範圍".into()); }
    let mut page_urls = Vec::with_capacity(pages.len());
    for page in pages {
        let path = page.get("path").and_then(Value::as_str)
            .ok_or("API 頁面缺少 path")?;
        page_urls.push(verified_page_url(path)?);
    }
    Ok(NhGallery { id, title, page_urls, cover_url: nh_cover(data), tags: nh_tags(data) })
}

#[command]
async fn fetch_nh_gallery(input: String) -> Result<NhGallery, String> {
    let id = nh_gallery_id(&input)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("MangaHub/0.4 (gallery metadata reader)")
        .build().map_err(|e| e.to_string())?;
    let response = client.get(format!("https://nhentai.net/api/v2/galleries/{id}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send().await.map_err(|e| format!("API 連線失敗：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("API 回傳 HTTP {}；若遇到 403/429，請遵守網站限制，不要密集重試。", response.status().as_u16()));
    }
    if let Some(len) = response.content_length() {
        if len > 1_000_000 { return Err("API 回應過大".into()); }
    }
    let body = response.bytes().await.map_err(|e| format!("讀取 API 失敗：{e}"))?;
    if body.len() > 1_000_000 { return Err("API 回應過大".into()); }
    let data: Value = serde_json::from_slice(&body).map_err(|_| "API 並未回傳有效 JSON".to_string())?;
    parse_nh_gallery(&data, id)
}

#[cfg(test)]
mod nh_tests {
    use super::*;
    #[test]
    fn gallery_url_restrictions() {
        assert_eq!(nh_gallery_id("https://nhentai.net/g/12345/").unwrap(), 12345);
        assert_eq!(nh_gallery_id("12345").unwrap(), 12345);
        assert!(nh_gallery_id("https://nhentai.net.evil.test/g/12345/").is_err());
        assert!(nh_gallery_id("http://nhentai.net/g/12345/").is_err());
        assert!(verified_page_url("galleries/123/1.jpg").is_ok());
        assert!(verified_page_url("https://evil.test/1.jpg").is_err());
    }
    #[test]
    fn metadata_to_urls() {
        let data = serde_json::json!({"id":12345,"title":{"pretty":"Demo"},"pages":[{"path":"galleries/123/1.jpg"},{"path":"galleries/123/2.webp"}]});
        let parsed = parse_nh_gallery(&data, 12345).unwrap();
        assert_eq!(parsed.page_urls.len(), 2);
    }
}


// Catalog API: only documented public v2 endpoints. No credentials, scraping,
// anti-bot bypass, image downloads, redirects or requests to arbitrary hosts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhListItem {
    id: u64,
    title: String,
    cover_url: Option<String>,
    page_count: usize,
    tags: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhCatalogPage {
    items: Vec<NhListItem>,
    page: u32,
    total_pages: Option<u32>,
    has_next: bool,
}
fn nh_title(data: &Value) -> String {
    let title = data.get("title").and_then(|v| {
        if let Some(t) = v.as_str() { return Some(t); }
        ["pretty", "english", "japanese"].iter()
            .find_map(|key| v.get(*key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
    }).or_else(|| data.get("english_title").and_then(Value::as_str))
      .or_else(|| data.get("japanese_title").and_then(Value::as_str))
      .unwrap_or("未命名作品");
    title.chars().take(240).collect()
}
fn nh_safe_cover(path: &str) -> Option<String> {
    // Accept the official list API's thumbnail string as well as the
    // gallery detail API's cover.path / thumbnail.path shapes.
    let normalized = if path.starts_with("https://") {
        let u = Url::parse(path).ok()?;
        if u.host_str() != Some("t.nhentai.net") || u.port().is_some()
            || !u.username().is_empty() || u.password().is_some()
            || u.query().is_some() || u.fragment().is_some() { return None; }
        u.path().trim_start_matches('/').to_string()
    } else {
        path.trim_start_matches('/').to_string()
    };
    let bits: Vec<_> = normalized.split('/').collect();
    if bits.len() != 3 || bits[0] != "galleries" || bits[1].is_empty()
        || !bits[1].bytes().all(|b| b.is_ascii_digit()) { return None; }
    let (stem, ext) = bits[2].rsplit_once('.')?;
    if !matches!(stem, "cover" | "thumb") || !matches!(ext, "jpg" | "png" | "webp" | "avif") { return None; }
    Some(format!("https://t.nhentai.net/{normalized}"))
}
fn nh_cover(data: &Value) -> Option<String> {
    // The v2 compact gallery list exposes `thumbnail` as a string;
    // detail responses can instead use nested cover/thumbnail objects.
    let paths = [
        data.pointer("/thumbnail/path"),
        data.pointer("/thumbnail/s"),
        data.get("thumbnail"),
        data.pointer("/cover/path"),
        data.pointer("/cover/s"),
        data.pointer("/images/cover/path"),
        data.get("cover_path"),
        data.get("cover_url"),
        data.pointer("/cover/url"),
    ];
    paths.iter().filter_map(|value| value.and_then(Value::as_str))
        .find_map(nh_safe_cover)
}
fn nh_tags(data: &Value) -> Vec<String> {
    data.get("tags").and_then(Value::as_array).map(|items| items.iter()
        .filter_map(|item| item.get("name").and_then(Value::as_str)
            .or_else(|| item.as_str()))
        .filter(|name| !name.is_empty())
        .take(20).map(|s| s.chars().take(60).collect()).collect()).unwrap_or_default()
}
fn parse_nh_list_item(v: &Value) -> Option<NhListItem> {
    let id = v.get("id").and_then(Value::as_u64).filter(|&x| x > 0)?;
    let page_count = v.get("num_pages").or_else(|| v.get("page_count"))
        .and_then(Value::as_u64).map(|v| v.min(1000) as usize)
        .or_else(|| v.get("pages").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    Some(NhListItem { id, title: nh_title(v), cover_url: nh_cover(v), page_count, tags: nh_tags(v) })
}
fn parse_nh_catalog(v: &Value, page: u32) -> Result<NhCatalogPage, String> {
    let arr = if let Some(arr) = v.as_array() { Some(arr) } else {
        v.get("result").or_else(|| v.get("items")).or_else(|| v.get("results")).or_else(|| v.get("galleries"))
            .or_else(|| v.get("data")).and_then(Value::as_array)
    }.ok_or("API 清單結構未辨識，請保留錯誤資訊供相容性修正")?;
    let items = arr.iter().take(100).filter_map(parse_nh_list_item).collect::<Vec<_>>();
    let total_pages = v.get("total_pages").or_else(|| v.get("totalPages")).or_else(|| v.get("num_pages"))
        .and_then(Value::as_u64).map(|x| x.min(100000) as u32)
        .or_else(|| {
            let total = v.get("total").and_then(Value::as_u64)?;
            let per_page = v.get("per_page").and_then(Value::as_u64).unwrap_or(25).max(1);
            Some((total.saturating_add(per_page - 1) / per_page).min(100000) as u32)
        });
    let has_next = v.get("has_next").and_then(Value::as_bool)
        .or_else(|| total_pages.map(|max| page < max))
        .unwrap_or(items.len() >= 25);
    Ok(NhCatalogPage { items, page, total_pages, has_next })
}
fn nh_api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(18))
        .user_agent("MangaHub/0.5 (public gallery catalog)")
        .build().map_err(|e| e.to_string())
}
async fn nh_get_json(client: &reqwest::Client, url: Url) -> Result<Value, String> {
    if url.scheme() != "https" || url.host_str() != Some("nhentai.net") || url.port().is_some() {
        return Err("不允許的 API 網域".into());
    }
    let response = client.get(url).header(reqwest::header::ACCEPT, "application/json")
        .send().await.map_err(|e| format!("API 連線失敗：{e}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(match status {
            403 => "API HTTP 403 Forbidden：來源拒絕清單請求，請稍後再試或使用已能閱讀的 Gallery ID。".to_string(),
            429 => "API HTTP 429 Too Many Requests：已被來源限流，請停止重新整理並等待來源恢復。".to_string(),
            _ => format!("API HTTP {status}：作品清單請求失敗。"),
        });
    }
    if response.content_length().unwrap_or(0) > 3_000_000 { return Err("API 回應過大".into()); }
    let bytes = response.bytes().await.map_err(|e| format!("讀取 API 失敗：{e}"))?;
    if bytes.len() > 3_000_000 { return Err("API 回應過大".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "API 沒有回傳有效 JSON".to_string())
}
#[command]
async fn browse_nh_catalog(mode: String, query: String, sort: String, page: u32) -> Result<NhCatalogPage, String> {
    if page == 0 || page > 1000 { return Err("頁碼必須介於 1～1000".into()); }
    let mut url = match mode.as_str() {
        "latest" => Url::parse("https://nhentai.net/api/v2/galleries").unwrap(),
        "popular" => Url::parse("https://nhentai.net/api/v2/galleries/popular").unwrap(),
        "search" => Url::parse("https://nhentai.net/api/v2/search").unwrap(),
        _ => return Err("未知清單模式".into()),
    };
    if mode == "search" {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 120 { return Err("搜尋文字請介於 1～120 字".into()); }
        if !matches!(sort.as_str(), "date" | "popular" | "popular-today" | "popular-week" | "popular-month") { return Err("未知排序方式".into()); }
        url.query_pairs_mut().append_pair("query", query).append_pair("sort", &sort).append_pair("page", &page.to_string());
    } else if mode == "latest" {
        url.query_pairs_mut().append_pair("page", &page.to_string());
    } else if page != 1 {
        return Err("熱門專區僅支援第 1 頁".into());
    }
    let client = nh_api_client()?;
    let body = nh_get_json(&client, url).await?;
    parse_nh_catalog(&body, page)
}


// Public taxonomy directory endpoint, as documented by the v2 API.
// One page at a time; no scraping, arbitrary hosts, or credential forwarding.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhTaxonomyItem { id: Option<u64>, name: String, count: Option<u64>, r#type: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhTaxonomyPage { items: Vec<NhTaxonomyItem>, page: u32, total_pages: Option<u32>, has_next: bool }
fn parse_nh_taxonomy(body: &Value, kind: &str, page: u32) -> Result<NhTaxonomyPage, String> {
    let entries = body.as_array()
        .or_else(|| body.get("result").and_then(Value::as_array))
        .or_else(|| body.get("items").and_then(Value::as_array))
        .or_else(|| body.get("results").and_then(Value::as_array))
        .or_else(|| body.get("tags").and_then(Value::as_array))
        .or_else(|| body.get("data").and_then(Value::as_array))
        .or_else(|| body.pointer("/data/items").and_then(Value::as_array))
        .or_else(|| body.pointer("/data/result").and_then(Value::as_array))
        .ok_or_else(|| "無法辨識官方分類目錄回應格式".to_string())?;
    let items = entries.iter().take(100).filter_map(|entry| {
        let name = entry.get("name").or_else(|| entry.get("slug")).and_then(Value::as_str)
            .or_else(|| entry.as_str())?.trim();
        if name.is_empty() { return None; }
        Some(NhTaxonomyItem {
            id: entry.get("id").and_then(Value::as_u64),
            name: name.chars().take(90).collect(),
            count: entry.get("count").or_else(|| entry.get("num_galleries")).or_else(|| entry.get("gallery_count")).and_then(Value::as_u64),
            r#type: kind.to_owned(),
        })
    }).collect::<Vec<_>>();
    let total_pages = body.get("total_pages").or_else(|| body.get("totalPages")).and_then(Value::as_u64)
        .or_else(|| body.pointer("/pagination/total_pages").and_then(Value::as_u64))
        .or_else(|| {
            let total = body.get("total").and_then(Value::as_u64)?;
            let per = body.get("per_page").and_then(Value::as_u64).unwrap_or(25).max(1);
            Some(total.saturating_add(per-1)/per)
        }).map(|n| n.min(1000) as u32);
    let has_next = body.get("has_next").and_then(Value::as_bool)
        .or_else(|| body.pointer("/pagination/has_next").and_then(Value::as_bool))
        .or_else(|| total_pages.map(|total| page < total))
        .unwrap_or(items.len() >= 25);
    Ok(NhTaxonomyPage { items, page, total_pages, has_next })
}
#[command]
async fn list_nh_taxonomy(kind: String, page: u32) -> Result<NhTaxonomyPage, String> {
    if !matches!(kind.as_str(), "tag" | "artist" | "group" | "character" | "parody" | "language" | "category") {
        return Err("不支援的分類類型".into());
    }
    if !(1..=1000).contains(&page) { return Err("分類頁碼必須介於 1～1000".into()); }
    let mut url = Url::parse(&format!("https://nhentai.net/api/v2/tags/{kind}")).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("page", &page.to_string());
    let client = nh_api_client()?;
    let body = nh_get_json(&client, url).await?;
    parse_nh_taxonomy(&body, &kind, page)
}

// Public, read-only user-facing API endpoints. Never authenticate or bypass rate limits.
#[command]
async fn random_nh_gallery() -> Result<u64, String> {
    let client = nh_api_client()?;
    let body = nh_get_json(&client, Url::parse("https://nhentai.net/api/v2/galleries/random").unwrap()).await?;
    let id = body.as_u64()
        .or_else(|| body.get("id").and_then(Value::as_u64))
        .or_else(|| body.get("gallery_id").and_then(Value::as_u64))
        .or_else(|| body.pointer("/data/id").and_then(Value::as_u64))
        .or_else(|| body.pointer("/gallery/id").and_then(Value::as_u64))
        .or_else(|| body.get("id").and_then(Value::as_str).and_then(|v| v.parse::<u64>().ok()));
    id.filter(|&v| v > 0).ok_or("隨機作品 API 未回傳可辨識的作品 ID".into())
}

#[command]
async fn related_nh_galleries(id: u64) -> Result<NhCatalogPage, String> {
    if id == 0 { return Err("作品 ID 無效".into()); }
    let client = nh_api_client()?;
    let url = Url::parse(&format!("https://nhentai.net/api/v2/galleries/{id}/related"))
        .map_err(|e| e.to_string())?;
    let response = nh_get_json(&client, url).await?;
    // Supported list shapes are checked strictly; a changed API shows an error, not invented cards.
    if let Some(a) = response.get("related").and_then(Value::as_array) {
        return parse_nh_catalog(&Value::Array(a.clone()), 1);
    }
    parse_nh_catalog(&response, 1)
}

#[cfg(test)]
mod nh_catalog_tests {
    use super::*;
    #[test]
    fn list_parsing_and_cover_validation() {
        let data = serde_json::json!({"items":[{"id":123,"title":{"pretty":"Demo"},"cover":{"path":"galleries/123/cover.jpg"},"num_pages":10}],"total_pages":3});
        let result = parse_nh_catalog(&data, 1).unwrap();
        assert_eq!(result.items[0].title, "Demo");
        assert_eq!(result.items[0].cover_url.as_deref(), Some("https://t.nhentai.net/galleries/123/cover.jpg"));
        assert!(result.has_next);
        assert!(nh_safe_cover("https://evil.test/cover.jpg").is_none());
        let result_list = serde_json::json!({"result":[{"id":321,"english_title":"V2 latest", "thumbnail":{"s":"https://t.nhentai.net/galleries/322/thumb.jpg"},"num_pages":5}],"num_pages":4,"page":1});
        let v2 = parse_nh_catalog(&result_list, 1).unwrap();
        assert_eq!(v2.items.len(), 1);
        assert_eq!(v2.items[0].title, "V2 latest");
        assert_eq!(v2.items[0].cover_url.as_deref(), Some("https://t.nhentai.net/galleries/322/thumb.jpg"));
        let compact = serde_json::json!({"id": 456, "english_title": "Compact list title", "thumbnail": "galleries/345/thumb.webp", "num_pages": 8});
        let compact_item = parse_nh_list_item(&compact).unwrap();
        assert_eq!(compact_item.title, "Compact list title");
        assert_eq!(compact_item.cover_url.as_deref(), Some("https://t.nhentai.net/galleries/345/thumb.webp"));
        let direct_thumb = serde_json::json!({"id": 789, "english_title": "URL thumbnail", "thumbnail": "https://t.nhentai.net/galleries/678/thumb.jpg"});
        assert!(parse_nh_list_item(&direct_thumb).unwrap().cover_url.is_some());
    }
}



// v0.5.5 account API. Secrets are NEVER returned to the WebView or stored in
// browser localStorage. Windows Credential Manager is the storage backend.
// Only the exact official HTTPS API host can receive an Authorization header.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NhAccountStatus {
    connected: bool,
    display_name: String,
    credential_kind: String,
}

#[cfg(target_os = "windows")]
fn account_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("MangaHub-nhentai-v055", "nhentai-account")
        .map_err(|_| "無法使用 Windows Credential Manager".to_string())
}
#[cfg(target_os = "windows")]
fn save_account_secret(value: &str) -> Result<(), String> {
    account_entry()?.set_password(value).map_err(|_| "無法安全儲存登入憑證".to_string())
}
#[cfg(target_os = "windows")]
fn load_account_secret() -> Result<String, String> {
    account_entry()?.get_password().map_err(|_| "尚未連接帳號或無法讀取安全憑證".to_string())
}
#[cfg(target_os = "windows")]
fn clear_account_secret() -> Result<(), String> {
    account_entry()?.delete_credential().map_err(|_| "無法移除已儲存的憑證".to_string())
}
#[cfg(not(target_os = "windows"))]
fn save_account_secret(_value: &str) -> Result<(), String> { Err("目前僅在 Windows 支援安全憑證儲存".into()) }
#[cfg(not(target_os = "windows"))]
fn load_account_secret() -> Result<String, String> { Err("目前僅在 Windows 支援安全憑證儲存".into()) }
#[cfg(not(target_os = "windows"))]
fn clear_account_secret() -> Result<(), String> { Err("目前僅在 Windows 支援安全憑證儲存".into()) }

fn validated_auth_header(kind: &str, secret: &str) -> Result<String, String> {
    if kind != "Key" && kind != "User" { return Err("僅支援官方 Key 或 User Token".into()); }
    let token = secret.trim();
    if token.len() < 8 || token.len() > 4096 || !token.is_ascii() || token.chars().any(|c| c.is_ascii_whitespace() || c.is_ascii_control()) {
        return Err("憑證格式錯誤".into());
    }
    Ok(format!("{kind} {token}"))
}
fn account_authorization() -> Result<String, String> {
    let stored = load_account_secret()?;
    let (kind, token) = stored.split_once(':').ok_or("安全憑證資料格式不正確")?;
    validated_auth_header(kind, token)
}
fn account_kind() -> String {
    load_account_secret().ok().and_then(|s| s.split_once(':').map(|x| x.0.to_owned())).unwrap_or_default()
}
async fn nh_account_request(method: reqwest::Method, path: &str, query: &[(&str,String)], auth: &str) -> Result<Value, String> {
    if !path.starts_with("/api/v2/") || path.contains("..") || path.contains('?') || path.contains('#') { return Err("API 路徑不合法".into()); }
    let mut url = Url::parse(&format!("https://nhentai.net{path}")).map_err(|_| "API 網址錯誤")?;
    for (k,v) in query { url.query_pairs_mut().append_pair(k, v); }
    let client = nh_api_client()?;
    let is_mutation = method != reqwest::Method::GET;
    let resp = client.request(method,url)
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::ACCEPT, "application/json")
        .send().await.map_err(|_| "帳號 API 連線失敗，請檢查網路".to_string())?;
    let status=resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "HTTP 401：登入憑證無效或過期".into(),
            403 => "HTTP 403：來源拒絕操作或目前憑證權限不足".into(),
            429 => "HTTP 429：來源限流，請稍後再手動重試".into(),
            n => format!("帳號 API HTTP {n}，請求未完成"),
        });
    }
    if resp.content_length().unwrap_or(0) > 3_000_000 { return Err("API 回應太大".into()); }
    let bytes = resp.bytes().await.map_err(|_| "讀取 API 回應失敗")?;
    if bytes.len()>3_000_000 { return Err("API 回應太大".into()); }
    if bytes.is_empty() { return Ok(serde_json::json!({"success":true})); }
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(value),
        Err(_) if is_mutation => Ok(serde_json::json!({"success":true})),
        Err(_) => Err("API 未回傳預期的 JSON".into()),
    }
}
fn user_label(v: &Value) -> String {
    ["username","display_name","name","slug"].iter().find_map(|key| v.get(*key).and_then(Value::as_str))
        .or_else(|| v.get("user").and_then(|u| u.get("username")).and_then(Value::as_str))
        .unwrap_or("已驗證帳號").chars().take(80).collect()
}
#[command]
async fn nh_connect(kind: String, secret: String) -> Result<NhAccountStatus, String> {
    let auth = validated_auth_header(&kind, &secret)?;
    // Verify BEFORE storing the secret; never log or return it.
    let profile = nh_account_request(reqwest::Method::GET,"/api/v2/user",&[],&auth).await?;
    let display_name = user_label(&profile);
    save_account_secret(&format!("{}:{}",kind,secret.trim()))?;
    Ok(NhAccountStatus {connected:true,display_name,credential_kind:kind})
}
#[command]
async fn nh_session() -> Result<NhAccountStatus, String> {
    let auth = match account_authorization() {
        Ok(s) => s,
        Err(_) => return Ok(NhAccountStatus{connected:false,display_name:String::new(),credential_kind:String::new()}),
    };
    let profile = nh_account_request(reqwest::Method::GET,"/api/v2/user",&[],&auth).await?;
    Ok(NhAccountStatus{connected:true,display_name:user_label(&profile),credential_kind:account_kind()})
}
#[command]
fn nh_disconnect() -> Result<(), String> { clear_account_secret() }
#[command]
async fn nh_account_favorites(page:u32) -> Result<NhCatalogPage,String> {
    if page<1 || page>1000 {return Err("頁碼必須介於 1～1000".into());}
    let value=nh_account_request(reqwest::Method::GET,"/api/v2/favorites",&[("page",page.to_string())],&account_authorization()?).await?;
    parse_nh_catalog(&value,page)
}
#[command]
async fn nh_account_blacklist(page:u32) -> Result<Value,String> {
    if page<1 || page>100 {return Err("黑名單頁碼不合法".into());}
    nh_account_request(reqwest::Method::GET,"/api/v2/blacklist",&[("page",page.to_string())],&account_authorization()?).await
}
#[command]
async fn nh_account_random_favorite() -> Result<u64,String> {
    let value=nh_account_request(reqwest::Method::GET,"/api/v2/favorites/random",&[],&account_authorization()?).await?;
    value.as_u64().or_else(||value.get("id").or_else(||value.get("gallery_id"))
        .or_else(||value.get("gallery").and_then(|v|v.get("id"))).and_then(Value::as_u64))
        .ok_or("隨機收藏未回傳可辨識的 Gallery ID".into())
}
#[command]
async fn nh_toggle_remote_favorite(gallery_id:u64, add:bool) -> Result<bool,String> {
    if gallery_id==0 { return Err("作品 ID 不合法".into()); }
    // API Key may be scoped to reads; write operations require a User Token.
    if account_kind()!="User" {return Err("修改官方收藏需要 User Token；API Key 模式僅同步讀取".into());}
    let method = if add {reqwest::Method::POST} else {reqwest::Method::DELETE};
    let _ = nh_account_request(method,&format!("/api/v2/galleries/{gallery_id}/favorite"),&[],&account_authorization()?).await?;
    Ok(add)
}
#[command]
async fn nh_gallery_comments(gallery_id:u64, page:u32) -> Result<Value,String> {
    if gallery_id==0 || page==0 || page>100 {return Err("作品 ID／頁碼不合法".into());}
    // Comments can be read anonymously. A separate authenticated browser is
    // used for posting because the official API requires CAPTCHA/PoW.
    {
        let mut url=Url::parse(&format!("https://nhentai.net/api/v2/galleries/{gallery_id}/comments")).map_err(|_| "URL 錯誤")?;
        url.query_pairs_mut().append_pair("page", &page.to_string());
        nh_get_json(&nh_api_client()?, url).await
    }
}

// Rouman5 chapter inspection. Reads only published chapter HTML and returns
// source-provided JPEG URLs. No hidden API calls, cookies, or challenge bypass.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoumanChapter {
    book_id: String,
    book_title: String,
    chapter_id: String,
    chapter_title: String,
    chapter_index: u32,
    chapter_count: u32,
    page_urls: Vec<String>,
    url: String,
}

fn validate_rouman_chapter_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "網址格式錯誤".to_owned())?;
    if url.scheme() != "https" || url.host_str() != Some("rouman5.com")
        || url.port().is_some() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() {
        return Err("請使用 rouman5.com 的 HTTPS 章節網址".into());
    }
    let segments: Vec<_> = url.path_segments().ok_or("章節網址無效")?.collect();
    if segments.len() != 3 || segments[0] != "books"
        || segments[1].len() < 8 || segments[1].len() > 80
        || !segments[1].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || segments[2].parse::<u32>().ok().filter(|n| *n < 10_000).is_none() {
        return Err("網址格式應為 https://rouman5.com/books/{作品ID}/{章節索引}".into());
    }
    Ok(url)
}

fn json_string_after(html: &str, needle: &str) -> Option<String> {
    let after = html.split_once(needle)?.1;
    let start = after.find('"')?;
    let json_string = &after[start..];
    // Use JSON parser to decode escaped titles safely.
    let mut end = start + 1;
    let chars = after.as_bytes();
    let mut escaped = false;
    while end < chars.len() {
        let byte = chars[end];
        if !escaped && byte == b'"' {
            return serde_json::from_str::<String>(&after[start..=end]).ok();
        }
        if !escaped && byte == b'\\' { escaped = true; }
        else { escaped = false; }
        end += 1;
    }
    let _ = json_string;
    None
}

fn parse_rouman_html(html: &str, target: &Url) -> Result<RoumanChapter, String> {
    // Next.js streamed payload: imagePaths:$R[26]=["https://...", ...]
    // Reference index changes between renders, so locate the assignment, not [26].
    let anchor = html.find("imagePaths:$R[").ok_or("章節資料未包含 imagePaths，網站格式可能已變更")?;
    let after = &html[anchor..];
    let assignment = after.find("]=[").ok_or("無法定位圖片清單")?;
    let json_start = anchor + assignment + 2; // opening '['
    let rest = &html[json_start..];
    let json_end = rest.find(']').ok_or("圖片清單格式不完整")?;
    let raw = &rest[..=json_end];
    let paths: Vec<String> = serde_json::from_str(raw)
        .map_err(|_| "無法解析 imagePaths JSON")?;
    if paths.is_empty() || paths.len() > 800 {
        return Err("圖片清單為空或超出合理數量".into());
    }
    let mut urls = Vec::with_capacity(paths.len());
    for (index, path) in paths.into_iter().enumerate() {
        let page = index + 1;
        let u = Url::parse(&path)
            .map_err(|_| format!("第 {page} 張圖片網址格式錯誤，已停止解析"))?;
        if let Err(reason) = validate_rouman_image_source(&u) {
            // Report host and a path category, never the entire signed image URL.
            // Its query string may include temporary tokens or identifiers.
            let host = u.host_str().unwrap_or("(無主機)");
            return Err(format!(
                "第 {page} 張圖片來源驗證失敗：主機 {host}；原因：{reason}。已停止解析，請提供此訊息以確認來源 CDN。"
            ));
        }
        urls.push(u.to_string());
    }
    let book_id = target.path_segments().and_then(|mut x| x.nth(1)).unwrap_or("").to_string();
    let chapter_index = target.path_segments().and_then(|mut x| x.nth(2))
        .and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
    // Metadata adjacent to imagePaths in the streamed payload. Never use these
    // fields to generate image URLs; only the explicit source-provided array.
    let mut start = anchor.saturating_sub(650);
    while start > 0 && !html.is_char_boundary(start) { start -= 1; }
    let nearby = &html[start..anchor];
    let book_title = nearby.rfind("book:$R[")
        .and_then(|pos| json_string_after(&nearby[pos..], ",name:"))
        .unwrap_or_else(|| "Rouman5 漫畫".into());
    let chapter_title = nearby.rfind(",name:")
        .and_then(|i| json_string_after(&nearby[i..], ",name:"))
        .unwrap_or_else(|| format!("第 {} 話", chapter_index + 1));
    let chapter_id = nearby.rfind("chapter:$R[")
        .and_then(|pos| json_string_after(&nearby[pos..], "id:"))
        .unwrap_or_default();
    let chapter_count = nearby.rfind("total:")
        .and_then(|pos| nearby[pos + 6..].split(|c:char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(RoumanChapter {book_id, book_title, chapter_id, chapter_title,
        chapter_index, chapter_count, page_urls: urls, url: target.to_string()})
}

#[command]
async fn inspect_rouman_chapter(url: String) -> Result<RoumanChapter, String> {
    let target = validate_rouman_chapter_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("MangaHub/0.5.8 (chapter reader)")
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(target.clone()).send().await
        .map_err(|e| format!("Rouman5 連線失敗：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Rouman5 HTTP {}，請確認網址及網站存取限制", resp.status()));
    }
    if let Some(t) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        if !t.to_str().unwrap_or("").contains("text/html") { return Err("回應不是 HTML".into()); }
    }
    if resp.content_length().unwrap_or(0) > 4_000_000 { return Err("HTML 超出大小限制".into()); }
    let html = resp.text().await.map_err(|_| "無法讀取章節 HTML")?;
    if html.len() > 4_000_000 { return Err("HTML 超出大小限制".into()); }
    parse_rouman_html(&html, &target)
}

#[cfg(test)]
mod rouman_tests {
    use super::*;
    #[test]
    fn rejects_new_cdn_with_actionable_and_non_sensitive_error() {
        let target = Url::parse("https://rouman5.com/books/47376792-2816-4ccf-a146-957b8d6a2ac6/0").unwrap();
        let html = r#"imagePaths:$R[3]=["https://v1.towm85.xyz/m/1.jpg", "https://v5.towm85.xyz/m/2.jpg?token=secret-value"]"#;
        let error = parse_rouman_html(html, &target).err().expect("expected a rejected CDN");
        assert!(error.contains("第 2 張"));
        assert!(error.contains("v5.towm85.xyz"));
        assert!(error.contains("CDN"));
        assert!(!error.contains("secret-value"));
    }
    #[test]
    fn shared_cdn_validation_rejects_untrusted_paths_and_hosts() {
        assert!(validate_rouman_image_source(&Url::parse("https://v2.towm85.xyz/m/1.jpg?sr=1").unwrap()).is_ok());
        assert!(validate_rouman_image_source(&Url::parse("https://v1.kelv47.xyz/m/1.jpg?sr=1").unwrap()).is_ok());
        assert!(validate_rouman_image_source(&Url::parse("https://v1.kelv47.xyz.evil.test/m/1.jpg").unwrap()).is_err());
        assert!(validate_rouman_image_source(&Url::parse("https://v2.towm85.xyz.evil.test/m/1.jpg").unwrap()).is_err());
        assert!(validate_rouman_image_source(&Url::parse("https://v2.towm85.xyz/other/1.jpg").unwrap()).is_err());
    }
    #[test]
    fn parses_streamed_image_paths() {
        let target=Url::parse("https://rouman5.com/books/cmegn4syy019ved077i2841wl/0").unwrap();
        let html=r#"abc,book:$R[24]={id:"cmegn4syy019ved077i2841wl",name:"神聖陷阱"},chapter:$R[25]={id:"chapter123",name:"第1話",ind:0},current:0,total:61,imagePaths:$R[26]=["https://v1.towm85.xyz/m/one.jpg","https://v2.towm85.xyz/m/two.jpg"]xyz"#;
        let data=parse_rouman_html(html,&target).unwrap();
        assert_eq!(data.page_urls.len(),2);
        assert_eq!(data.chapter_count,61);
        assert_eq!(data.chapter_index,0);
    }
    #[test]
    fn rejects_arbitrary_domains() {
        assert!(validate_rouman_chapter_url("https://example.com/books/a/0").is_err());
        let target=Url::parse("https://rouman5.com/books/cmegn4syy019ved077i2841wl/0").unwrap();
        assert!(parse_rouman_html("imagePaths:$R[7]=[\"https://evil.test/m/a.jpg\"]",&target).is_err());
    }
}


// Rouman5 public browsing: only fetches human-visible HTML pages, never
// calls private Next.js server functions or generates CDN image addresses.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoumanBookCard {
    id: String,
    title: String,
    url: String,
    cover_url: Option<String>,
    section: String,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoumanCatalog {
    mode: String,
    page: u32,
    books: Vec<RoumanBookCard>,
    has_next: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoumanBookDetails {
    id: String,
    title: String,
    cover_url: Option<String>,
    description: String,
    chapters: Vec<RoumanChapterLink>,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoumanChapterLink { index: u32, name: String, url: String }

fn rouman_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(22))
        .user_agent("MangaHub/0.5.9 (public catalog reader)")
        .build().map_err(|e| e.to_string())
}

async fn rouman_html(url: Url) -> Result<String, String> {
    let response = rouman_client()?.get(url).send().await
        .map_err(|e| format!("網站連線失敗：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("Rouman5 HTTP {}（請遵守網站存取限制）", response.status()));
    }
    let kind = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
    if !kind.contains("text/html") { return Err("來源回應不是 HTML".into()); }
    if response.content_length().unwrap_or(0) > 5_000_000 { return Err("HTML 超過大小限制".into()); }
    let html = response.text().await.map_err(|e| e.to_string())?;
    if html.len() > 5_000_000 { return Err("HTML 超過大小限制".into()); }
    Ok(html)
}

fn rouman_book_id_from_href(href: &str) -> Option<String> {
    let path = if href.starts_with("https://rouman5.com/") {
        Url::parse(href).ok()?.path().to_string()
    } else { href.split(['?', '#']).next()?.to_string() };
    let mut parts = path.trim_matches('/').split('/');
    if parts.next()? != "books" { return None; }
    let id = parts.next()?;
    if parts.next().is_some() || id.len() < 8 || id.len() > 80
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return None; }
    Some(id.to_string())
}

fn rouman_cover(element: &scraper::ElementRef<'_>) -> Option<String> {
    let img = Selector::parse("img").ok()?;
    let node = element.select(&img).next()?;
    let src = node.value().attr("data-src")
        .or_else(|| node.value().attr("src"))?;
    let src = if src.starts_with("//") { format!("https:{src}") }
        else if src.starts_with('/') { format!("https://rouman5.com{src}") }
        else { src.to_string() };
    let u = Url::parse(&src).ok()?;
    if u.scheme() != "https" || u.port().is_some() || !u.username().is_empty() { return None; }
    Some(u.to_string())
}

// Only collect labels that are explicitly marked as taxonomy in public HTML.
// Do not infer tags from manga names or arbitrary paragraph text.
fn rouman_card_tags(el: &scraper::ElementRef<'_>) -> Vec<String> {
    let mut labels = Vec::new();
    if let Ok(sel) = Selector::parse("[data-tag], [data-category], a[href*='/tags/'], a[href*='/genres/']") {
        for node in el.select(&sel) {
            let val = node.value().attr("data-tag")
                .or_else(|| node.value().attr("data-category"))
                .map(str::to_string)
                .unwrap_or_else(|| node.text().collect::<Vec<_>>().join(" "));
            let label = val.trim();
            if !label.is_empty() && label.chars().count() <= 40 && !labels.iter().any(|x| x == label) {
                labels.push(label.to_owned());
            }
            if labels.len() >= 12 { break; }
        }
    }
    labels
}

fn parse_rouman_catalog(html: &str, mode: &str, page: u32) -> RoumanCatalog {
    use scraper::ElementRef;
    use std::collections::HashSet;
    let doc = Html::parse_document(html);
    let mut section = "全部漫畫".to_string();
    let mut books = Vec::new();
    let mut seen = HashSet::<(String, String)>::new();
    // Traverse in document order to associate homepage cards with their
    // visible ranking section, without reverse engineering internal APIs.
    for node in doc.root_element().descendants() {
        let Some(el) = ElementRef::wrap(node) else { continue; };
        let tag = el.value().name();
        if matches!(mode, "home" | "new") && matches!(tag, "h1" | "h2" | "h3" | "h4") {
            let heading = el.text().collect::<String>().trim().to_string();
            if ["正熱門", "今日最佳", "最近更新", "本週熱門", "已完結", "新上架", "最新上架"].iter().any(|t| heading.contains(t)) {
                section = heading;
            }
        }
        if tag != "a" { continue; }
        let Some(href) = el.value().attr("href") else { continue; };
        let Some(id) = rouman_book_id_from_href(href) else { continue; };
        let img_alt = Selector::parse("img").ok().and_then(|q| {
            el.select(&q).next().and_then(|img| img.value().attr("alt"))
                .map(|alt| alt.trim().to_string())
        }).unwrap_or_default();
        let text = el.text().collect::<Vec<_>>().join(" ");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let title = if !img_alt.is_empty() { img_alt } else {
            text.split("至:").next().unwrap_or("").trim().to_string()
        };
        if title.is_empty() || !seen.insert((id.clone(), section.clone())) { continue; }
        books.push(RoumanBookCard {
            id: id.clone(), title, url: format!("https://rouman5.com/books/{id}"),
            cover_url: rouman_cover(&el), section: section.clone(),
            tags: rouman_card_tags(&el),
        });
        if books.len() >= 180 { break; }
    }
    let has_next = mode != "home" && !books.is_empty() && html.contains("下一頁");
    RoumanCatalog { mode: mode.into(), page, books, has_next }
}

#[command]
async fn browse_rouman_catalog(mode: String, page: u32) -> Result<RoumanCatalog, String> {
    if page > 1000 { return Err("頁碼超出限制".into()); }
    // 「新上架」和「最近更新」不同：只讀取網站明確標示的新上架作品。
    // 優先使用首頁分類；如果網站改成獨立清單，再跟隨公開站內連結。
    if mode == "new" {
        if page > 0 { return Err("新上架目前沒有經驗證的分頁來源".into()); }
        let home = rouman_html(Url::parse("https://rouman5.com/home").unwrap()).await?;
        let mut grouped = parse_rouman_catalog(&home, "home", 0);
        grouped.books.retain(|item| item.section.contains("新上架") || item.section.contains("最新上架"));
        if !grouped.books.is_empty() {
            grouped.mode = mode;
            grouped.has_next = false;
            return Ok(grouped);
        }
        // Some site revisions expose the section as a dedicated public link.
        // Reject off-site links, unexpected paths, and redirects.
        // IMPORTANT: `scraper::ElementRef` is !Send. Collect owned URLs and
        // drop the HTML document/selectors before awaiting network requests.
        let candidate_urls: Vec<Url> = {
            let document = Html::parse_document(&home);
            let anchor_selector = Selector::parse("a[href]").map_err(|e| e.to_string())?;
            let base = Url::parse("https://rouman5.com/home").map_err(|e| e.to_string())?;
            let mut urls = Vec::new();
            for anchor in document.select(&anchor_selector) {
                let label = anchor.text().collect::<String>();
                if !label.contains("新上架") && !label.contains("最新上架") {
                    continue;
                }
                let Some(href) = anchor.value().attr("href") else { continue; };
                let Ok(url) = base.join(href) else { continue; };
                if url.scheme() != "https"
                    || url.host_str() != Some("rouman5.com")
                    || url.port().is_some()
                    || !url.username().is_empty()
                    || url.fragment().is_some()
                    || url.path() == "/home"
                    || !(url.path().starts_with("/books") || url.path().starts_with("/new"))
                {
                    continue;
                }
                if !urls.contains(&url) { urls.push(url); }
            }
            urls
        };
        for url in candidate_urls {
            let html = rouman_html(url).await?;
            let mut list = parse_rouman_catalog(&html, "new", 0);
            if !list.books.is_empty() {
                list.mode = mode;
                list.has_next = false;
                return Ok(list);
            }
        }
        return Err("網站這次沒有提供可辨識的「新上架」作品區塊或連結；不會拿「最近更新」冒充新上架。".into());
    }
    let mut url = match mode.as_str() {
        "home" => Url::parse("https://rouman5.com/home").unwrap(),
        "all" | "ongoing" | "completed" => Url::parse("https://rouman5.com/books").unwrap(),
        _ => return Err("不支援的目錄類型".into()),
    };
    if mode == "home" && page != 0 { return Err("首頁不支援分頁".into()); }
    if mode != "home" {
        url.query_pairs_mut().append_pair("page", &page.to_string()).append_pair("continued",
            match mode.as_str() { "ongoing" => "true", "completed" => "false", _ => "" });
    }
    let html = rouman_html(url).await?;
    let result = parse_rouman_catalog(&html, &mode, page);
    if result.books.is_empty() { return Err("目錄未取得作品卡片，可能是網站 HTML 已變更".into()); }
    Ok(result)
}

// Verified public search URL from the human-facing Rouman5 search page.
// Terms are inserted as URL query parameters; no private API is called.
#[command]
async fn search_rouman_catalog(term: String, page: u32) -> Result<RoumanCatalog, String> {
    let term = term.trim();
    if term.chars().count() < 1 || term.chars().count() > 100 { return Err("請輸入 1～100 字的搜尋關鍵字".into()); }
    if page > 100 { return Err("搜尋頁碼超出限制".into()); }
    let mut url = Url::parse("https://rouman5.com/search").unwrap();
    url.query_pairs_mut().append_pair("page", &page.to_string()).append_pair("term", term);
    let html = rouman_html(url).await?;
    // An empty list is valid (no results).
    Ok(parse_rouman_catalog(&html, "search", page))
}

#[command]
async fn inspect_rouman_book(book_id: String) -> Result<RoumanBookDetails, String> {
    if book_id.len() < 8 || book_id.len() > 80
        || !book_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("作品 ID 格式不正確".into());
    }
    let url = Url::parse(&format!("https://rouman5.com/books/{book_id}"))
        .map_err(|e| e.to_string())?;
    let html = rouman_html(url).await?;
    let doc = Html::parse_document(&html);
    let select = |q: &str| Selector::parse(q).ok();
    let title = select("h1").and_then(|q| {
        doc.select(&q).next().map(|el| el.text().collect::<Vec<_>>().join(" ").trim().to_string())
    }).filter(|s| !s.is_empty()).or_else(|| {
        select("meta[property='og:title']").and_then(|q| {
            doc.select(&q).next().and_then(|el| el.value().attr("content")).map(str::to_owned)
        })
    }).unwrap_or_else(|| book_id.clone());
    let cover_url = select("meta[property='og:image']").and_then(|q| {
        doc.select(&q).next().and_then(|el| el.value().attr("content"))
            .and_then(|s| Url::parse(s).ok()).filter(|u| u.scheme() == "https").map(|u| u.to_string())
    });
    let description = select("meta[name='description']").and_then(|q| {
        doc.select(&q).next().and_then(|el| el.value().attr("content")).map(str::to_owned)
    }).unwrap_or_default();
    let links = select("a[href]").ok_or("無法解析頁面連結")?;
    let mut chapters = Vec::new();
    let mut seen = std::collections::HashSet::<u32>::new();
    for el in doc.select(&links) {
        let Some(href) = el.value().attr("href") else { continue; };
        let path = href.split(['?', '#']).next().unwrap_or("");
        let prefix = format!("/books/{book_id}/");
        let suffix = if let Some(s) = path.strip_prefix(&prefix) { s }
            else if let Some(s) = path.strip_prefix(&format!("https://rouman5.com{prefix}")) { s }
            else { continue; };
        let Ok(index) = suffix.parse::<u32>() else { continue; };
        if index > 9999 || !seen.insert(index) { continue; }
        let text = el.text().collect::<Vec<_>>().join(" ");
        let text = text.trim();
        chapters.push(RoumanChapterLink {
            index, name: if text.is_empty() { format!("第 {} 話", index+1) } else { text.into() },
            url: format!("https://rouman5.com/books/{book_id}/{index}"),
        });
        if chapters.len() >= 1000 { break; }
    }
    chapters.sort_by_key(|ch| ch.index);
    if chapters.is_empty() { return Err("作品頁未找到章節連結，請確認作品是否可公開閱讀".into()); }
    let mut tags = Vec::<String>::new();
    if let Ok(sel) = Selector::parse("[data-tag], [data-category], a[href*='/tags/'], a[href*='/genres/']") {
        for node in doc.select(&sel) {
            let val = node.value().attr("data-tag").or_else(|| node.value().attr("data-category"))
                .map(str::to_owned).unwrap_or_else(|| node.text().collect::<Vec<_>>().join(" "));
            let label = val.trim();
            if !label.is_empty() && label.chars().count() <= 40 && !tags.iter().any(|x| x == label) { tags.push(label.into()); }
            if tags.len() >= 24 { break; }
        }
    }
    Ok(RoumanBookDetails { id: book_id, title, cover_url, description, chapters, tags })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![image_cache_trim, image_cache_get, image_cache_clear, image_cache_stats, search_rouman_catalog, browse_rouman_catalog, inspect_rouman_book, inspect_rouman_chapter, inspect_comicbox_chapter, probe_comicbox_image, probe_comicbox_pair, fetch_nh_gallery, browse_nh_catalog, list_nh_taxonomy, random_nh_gallery, related_nh_galleries, nh_connect, nh_disconnect, nh_session, nh_account_favorites, nh_account_blacklist, nh_account_random_favorite, nh_toggle_remote_favorite, nh_gallery_comments])
        .run(tauri::generate_context!())
        .expect("error while running MangaHub");
}

#[cfg(test)]
mod rouman_search_tests {
    use super::*;

    #[test]
    fn parses_public_search_cards_without_guessing_image_paths() {
        let html = r#"<main><a href='/books/cmegn4syy019ved077i2841wl'>
          <img alt='神聖陷阱' src='https://cdn.example.org/cover.jpg' />
          <span data-tag='韓國'>韓國</span></a><a href='/books/cmegn4syy019ved077i2841wl'>duplicate</a></main>"#;
        let list = parse_rouman_catalog(html, "search", 0);
        assert_eq!(list.books.len(), 1);
        assert_eq!(list.books[0].title, "神聖陷阱");
        assert_eq!(list.books[0].tags, vec!["韓國"]);
    }

    #[test]
    fn empty_search_is_valid() {
        let list = parse_rouman_catalog("<main><p>沒有結果</p></main>", "search", 0);
        assert!(list.books.is_empty());
    }
}

#[cfg(test)]
mod rouman_new_arrivals_tests {
    use super::*;

    #[test]
    fn homepage_new_arrivals_are_separate_from_recent_updates() {
        let html = r#"<main><h2>最近更新</h2><a href='/books/abcdefgh123'><img alt='更新作品'/></a>
            <h2>新上架</h2><a href='/books/abcdefgh456'><img alt='新上架作品'/></a>
            <h2>本週熱門</h2><a href='/books/abcdefgh789'><img alt='熱門作品'/></a></main>"#;
        let list = parse_rouman_catalog(html, "home", 0);
        let new_books: Vec<_> = list.books.iter().filter(|b| b.section.contains("新上架")).collect();
        assert_eq!(new_books.len(), 1);
        assert_eq!(new_books[0].id, "abcdefgh456");
        assert_ne!(new_books[0].id, list.books[0].id);
    }
}
