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
    Ok(NhGallery { id, title, page_urls })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![inspect_comicbox_chapter, probe_comicbox_image, probe_comicbox_pair, fetch_nh_gallery])
        .run(tauri::generate_context!())
        .expect("error while running MangaHub");
}
