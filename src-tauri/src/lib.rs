use scraper::{Html, Selector};
use serde::Serialize;
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

fn classify_image_header(data: &[u8]) -> &'static str {
    if data.starts_with(&[0xff, 0xd8, 0xff]) { return "JPEG"; }
    if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) { return "PNG"; }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" { return "WebP"; }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) { return "GIF"; }
    if data.len() >= 16 && &data[4..8] == b"ftyp"
        && (&data[8..12] == b"avif" || &data[8..12] == b"avis") { return "AVIF"; }
    "未辨識的二進位資料"
}

#[command]
async fn probe_comicbox_image(url: String) -> Result<ImageProbe, String> {
    let target = validate_image_probe_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("MangaHub/0.3.1 (image-format diagnostics)")
        .build().map_err(|e| e.to_string())?;
    let mut response = client.get(target.clone())
        .header(reqwest::header::RANGE, "bytes=0-63")
        .send().await.map_err(|e| format!("圖片來源連線失敗：{e}"))?;
    let status = response.status().as_u16();
    let headers = response.headers();
    let content_type = headers.get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok()).unwrap_or("未提供").to_string();
    let cors = headers.get(reqwest::header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|h| h.to_str().ok()).unwrap_or("未提供").to_string();
    let length = response.content_length();
    // Inspect only one response chunk, never save the content or reconstruct protected images.
    let head = if (200..300).contains(&status) {
        response.chunk().await.map_err(|e| format!("讀取資料標頭失敗：{e}"))?
            .map(|chunk| chunk[..chunk.len().min(64)].to_vec()).unwrap_or_default()
    } else { Vec::new() };
    let format = classify_image_header(&head).to_string();
    let recognized = format != "未辨識的二進位資料";
    let renderable = (200..300).contains(&status) && recognized;
    let explanation = if (300..400).contains(&status) {
        "來源回傳重新導向；為避免跳轉到未知網域，診斷器不追蹤重新導向。"
    } else if status == 403 {
        "HTTP 403：來源拒絕此請求。診斷器不會重試或繞過存取限制。"
    } else if !(200..300).contains(&status) {
        "來源未回傳成功狀態，無法判斷圖片格式。"
    } else if recognized {
        "資料標頭符合一般圖片格式；這不代表第三方使用權或瀏覽器載入權限已獲確認。"
    } else {
        "資料標頭不是常見圖片格式；可能是網站專用分段或其他資料，不能直接交給圖片閱讀器。"
    }.to_string();
    Ok(ImageProbe { url: target.to_string(), http_status: status,
        content_type, content_length: length, cors_header: cors,
        detected_format: format, directly_renderable: renderable,
        sampled_bytes: head.len(), explanation })
}

#[cfg(test)]
mod tests {
    use super::*;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![inspect_comicbox_chapter, probe_comicbox_image])
        .run(tauri::generate_context!())
        .expect("error while running MangaHub");
}
