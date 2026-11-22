import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';

export type RoumanChapter = {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  chapterCount: number;
  pageUrls: string[];
  url: string;
};

type Props = {
  onRead: (chapter: RoumanChapter) => void;
};

const starter = 'https://rouman5.com/books/cmegn4syy019ved077i2841wl/0';
const savedKey = 'mangahub-rouman-recent-v058';
function chapterUrl(bookId: string, index: number) {
  return `https://rouman5.com/books/${encodeURIComponent(bookId)}/${index}`;
}

export default function RoumanSource({ onRead }: Props) {
  const [input, setInput] = useState(starter);
  const [result, setResult] = useState<RoumanChapter | null>(null);
  const [recent, setRecent] = useState<RoumanChapter[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(savedKey) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is RoumanChapter =>
        item !== null && typeof item === 'object' && typeof item.url === 'string' && typeof item.bookId === 'string') : [];
    } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    localStorage.setItem(savedKey, JSON.stringify(recent.map(item => ({ ...item, pageUrls: [] }))));
  }, [recent]);
  async function inspect(value: string) {
    setLoading(true);
    setError('');
    try {
      const data = await invoke<RoumanChapter>('inspect_rouman_chapter', { url: value.trim() });
      setResult(data);
      setInput(data.url);
      setRecent(prev => [{ ...data, pageUrls: [] }, ...prev.filter(x => x.url !== data.url)].slice(0, 20));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }
  function nextChapter(offset: number) {
    if (!result) return;
    const index = result.chapterIndex + offset;
    if (index < 0 || (result.chapterCount > 0 && index >= result.chapterCount)) return;
    void inspect(chapterUrl(result.bookId, index));
  }
  return <section className="content roumanPage">
    <div className="pill">SOURCE ADAPTER · ROUMAN5 · v0.5.8</div>
    <h1>Rouman5 <span>閱讀來源</span></h1>
    <p className="lead">輸入公開的 Rouman5 章節網址，取得 HTML 內的圖片清單，使用 MangaHub 的純淨圖片閱讀器。第一階段先驗證單話閱讀，首頁和搜尋尚未整合。</p>
    <form className="urlbox" onSubmit={e => { e.preventDefault(); void inspect(input); }}>
      <BookOpen size={19}/>
      <input aria-label="Rouman5 章節網址" value={input} onChange={e => setInput(e.target.value)} placeholder={starter}/>
      <button disabled={loading}>{loading ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} 解析章節</button>
    </form>
    {error && <div className="error"><strong>無法取得章節</strong><p>{error}</p><small>如果網站限制第三方 HTTP 請求，將顯示實際錯誤，不會繞過登入或驗證。</small></div>}
    {result && <div className="results">
      <div className="resultTop"><div><div className="pill muted">第 {result.chapterIndex + 1} 話 / {result.chapterCount || '?'} 話</div>
        <h2>{result.bookTitle}</h2><p>{result.chapterTitle} · {result.pageUrls.length} 張圖片</p></div>
        <button className="primary" disabled={!result.pageUrls.length} onClick={() => onRead(result)}><BookOpen size={17}/> 在 MangaHub 閱讀</button>
      </div>
      <div className="diagnosticActions">
        <button className="secondaryButton" disabled={loading || result.chapterIndex <= 0} onClick={() => nextChapter(-1)}><ChevronLeft size={16}/> 上一話</button>
        <button className="secondaryButton" disabled={loading || (result.chapterCount > 0 && result.chapterIndex + 1 >= result.chapterCount)} onClick={() => nextChapter(1)}>下一話 <ChevronRight size={16}/></button>
        <span className="detailNote">章節網址：{result.url}</span>
      </div>
      <div className="notice"><BookOpen size={18}/><div><b>圖片來源相容性</b><p>已解析來源頁面公開提供的圖片網址，但圖片 CDN 可能仍有防盜連、到期或授權限制。若 Reader 載入失敗，請以來源存取規則為準。</p></div></div>
    </div>}
    {recent.length > 0 && <div className="roumanRecent"><h3>最近解析章節</h3><div className="chapterList">{recent.map(item => <button key={item.url} onClick={() => void inspect(item.url)}><span>{item.bookTitle} · {item.chapterTitle}</span><ChevronRight size={16}/></button>)}</div></div>}
  </section>;
}
