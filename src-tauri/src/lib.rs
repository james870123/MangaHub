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
    if !response.status().is_success() { return Err(format!("網站回應 HTTP {}", response.status())); }
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

#[cfg(test)]
mod tests {
    use super::*;
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
        .invoke_handler(tauri::generate_handler![inspect_comicbox_chapter])
        .run(tauri::generate_context!())
        .expect("error while running MangaHub");
}
