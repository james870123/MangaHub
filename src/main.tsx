import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { BookOpen, Bookmark, ExternalLink, RefreshCw, ChevronLeft, ChevronRight, CircleHelp, Globe2, Image, Library, Link, LoaderCircle, Plus, Search, Trash2 } from 'lucide-react';
import './style.css';

type Chapter = { id: string; title: string; url: string };
type ChapterInfo = { title: string; url: string; chapterId: string; pages: number; chapters: Chapter[]; encryptedImagePipeline: boolean };
type CachedChapter = { info: ChapterInfo; cachedAt: number };
type Book = { url: string; title: string; pages: number; chapterId: string; savedAt: number };
function useSaved<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : initial; } catch { return initial; } });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState];
}
const example = 'https://www.comicbox.xyz/free-chapter/42682?t=20260415';
function App() {
  const [tab, setTab] = useState<'source' | 'library' | 'reader' | 'chapter'>('source');
  const [url, setUrl] = useState(example);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<ChapterInfo | null>(null);
  const [active, setActive] = useState<Chapter | null>(null);
  const [chapterError, setChapterError] = useState('');
  const [chapterLoading, setChapterLoading] = useState(false);
  const [cache, setCache] = useSaved<Record<string, CachedChapter>>('mh-chapter-cache-v02', {});
  const [books, setBooks] = useSaved<Book[]>('mh-books', []);
  const [imageText, setImageText] = useSaved('mh-image-urls', '');
  const [page, setPage] = useSaved('mh-page', 0);
  const [vertical, setVertical] = useSaved('mh-vertical', true);
  const images = imageText.split(/\r?\n/).map(s => s.trim()).filter(s => { try { const u = new URL(s); return u.protocol === 'https:'; } catch { return false; } });
  function chapterKey(input: string) {
    try {
      const parsed = new URL(input);
      const match = parsed.pathname.match(/^\/free-chapter\/(\d+)$/);
      return parsed.protocol === 'https:' && parsed.hostname === 'www.comicbox.xyz' ? (match?.[1] ?? '') : '';
    } catch { return ''; }
  }
  async function inspect(input: string, force = false) {
    setLoading(true); setError(''); setTab('source');
    try {
      const key = chapterKey(input);
      const saved = !force && key ? cache[key] : undefined;
      const data = saved?.info ?? await invoke<ChapterInfo>('inspect_comicbox_chapter', { url: input });
      setInfo(data); setUrl(data.url);
      if (!saved) setCache(prev => ({ ...prev, [data.chapterId]: { info: data, cachedAt: Date.now() } }));
    } catch (e) {
      setError(String(e)); // preserve the previously parsed index when a later request is blocked
    } finally { setLoading(false); }
  }
  async function openChapter(chapter: Chapter, force = false) {
    setActive(chapter); setChapterError(''); setTab('chapter');
    const key = chapterKey(chapter.url);
    if (!force && cache[key]) return;
    setChapterLoading(true);
    try {
      const data = await invoke<ChapterInfo>('inspect_comicbox_chapter', { url: chapter.url });
      setCache(prev => ({ ...prev, [data.chapterId]: { info: data, cachedAt: Date.now() } }));
    } catch (e) { setChapterError(String(e)); }
    finally { setChapterLoading(false); }
  }
  async function openOriginal(input: string) {
    try {
      const parsed = new URL(input);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.comicbox.xyz') throw new Error('只允許開啟 ComicBox HTTPS 網址');
      await openUrl(parsed.href);
    } catch (e) { setChapterError(`開啟瀏覽器失敗：${String(e)}`); }
  }
  function saveBook() {
    if (!info) return;
    const item = { url: info.url, title: info.title, pages: info.pages, chapterId: info.chapterId, savedAt: Date.now() };
    setBooks(prev => [item, ...prev.filter(b => b.chapterId !== item.chapterId)]);
  }
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brandicon"><BookOpen size={22}/></div><div><strong>MangaHub</strong><small>YOUR READING SPACE</small></div></div>
      <div className="sideTitle">工作空間</div>
      <button className={tab === 'source' ? 'nav active' : 'nav'} onClick={() => setTab('source')}><Search size={19}/> 來源解析</button>
      <button className={tab === 'library' ? 'nav active' : 'nav'} onClick={() => setTab('library')}><Library size={19}/> 我的書架 <span className="count">{books.length}</span></button>
      <button className={tab === 'reader' ? 'nav active' : 'nav'} onClick={() => setTab('reader')}><Image size={19}/> 圖片閱讀器</button>
      <div className="asideFoot"><CircleHelp size={16}/> v0.2 · Local-first<br/><span>無原站廣告、無追蹤 SDK</span></div>
    </aside>
    <main className="main">
      <header><span className="eyebrow"><Globe2 size={15}/> MangaHub / {tab === 'source' ? 'Source Inspector' : tab === 'library' ? 'My Library' : tab === 'chapter' ? 'Chapter' : 'Reader'}</span><span className="status">● Local-first</span></header>
      {tab === 'source' && <section className="content">
        <div className="pill">SOURCE ADAPTER · COMICBOX</div>
        <h1>探索漫畫，<br/><span>專注於閱讀。</span></h1>
        <p className="lead">輸入 ComicBox 的公開章節網址，擷取章節名稱、導覽資訊和頁面數。v0.2 支援已解析章節快取、章節導覽及 HTTP 錯誤診斷；不處理受保護圖片。</p>
        <form className="urlbox" onSubmit={e => { e.preventDefault(); void inspect(url); }}><Link size={20}/><input aria-label="章節網址" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.comicbox.xyz/free-chapter/…"/><button disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : <Search size={17}/>}<span>解析章節</span></button></form>
        {error && <div className="error"><strong>解析失敗</strong><p>{error}</p><small>已保留先前成功解析的章節索引。你也可以選擇以系統瀏覽器閱讀。</small></div>}
        {!info && <div className="startGrid"><div className="hint"><div className="hintIcon"><BookOpen/></div><b>章節資訊</b><p>解析標題與章節目錄</p></div><div className="hint"><div className="hintIcon"><Bookmark/></div><b>個人書架</b><p>將章節保存在本機</p></div><div className="hint"><div className="hintIcon"><Image/></div><b>純淨閱讀</b><p>使用自己的圖片網址閱讀</p></div></div>}
        {info && <div className="results"><div className="resultTop"><div><div className="pill muted">解析成功 · {info.chapterId}</div><h2>{info.title}</h2><p>{info.pages} 個漫畫頁面節點 · {info.chapters.length} 個章節連結</p></div><button className="secondaryButton" onClick={saveBook}><Plus size={17}/> 收藏此章</button></div>
          {info.encryptedImagePipeline && <div className="notice"><CircleHelp size={20}/><div><b>偵測到分段／處理後的圖片載入流程</b><p>此來源目前只顯示頁面索引，不會將分段資料視為一般圖片，也不會繞過網站的存取保護。可以在「圖片閱讀器」載入你有權使用的直接圖片網址。</p></div></div>}
          <div className="resultStats"><div><b>{info.pages}</b><span>頁面節點</span></div><div><b>{info.chapters.length}</b><span>章節連結</span></div><div><b>HTML</b><span>解析方式</span></div></div>
          <div className="diagnosticActions"><button className="secondaryButton" onClick={() => void inspect(info.url, true)}><RefreshCw size={16}/> 強制重新解析</button><button className="secondaryButton" onClick={() => void openOriginal(info.url)}><ExternalLink size={16}/> 在瀏覽器閱讀</button></div><h3>章節清單</h3><div className="chapterList">{info.chapters.map(c => <button key={c.id} onClick={() => void openChapter(c)}><span>{c.title}</span><ChevronRight size={17}/></button>)}</div></div>}
      </section>}
      {tab === 'chapter' && <section className="content">
        <button className="backButton" onClick={() => setTab('source')}><ChevronLeft size={17}/> 返回章節清單</button>
        <div className="pill">COMICBOX · CHAPTER</div>
        <h1>章節<span>閱讀入口</span></h1>
        <h2>{active?.title ?? '尚未選擇章節'}</h2>
        {active && <p className="lead">章節 ID：{active.id} · 已保留上一頁的章節目錄</p>}
        {chapterLoading && <div className="notice"><LoaderCircle className="spin" size={20}/><div>正在取得這一話的公開章節資訊…</div></div>}
        {chapterError && <div className="error"><strong>網站回應錯誤</strong><p>{chapterError}</p><small>HTTP 403 表示原站拒絕本次請求，並非漫畫不存在；不會自動重試或繞過存取限制。</small></div>}
        {active && cache[active.id] && <div className="resultStats"><div><b>{cache[active.id].info.pages}</b><span>已快取的頁面節點</span></div><div><b>{cache[active.id].info.chapters.length}</b><span>章節連結</span></div><div><b>本機</b><span>資料索引來源</span></div></div>}
        <div className="notice"><CircleHelp size={20}/><div><b>目前尚無法在 MangaHub 直接顯示此網站的漫畫圖片</b><p>這個來源的圖片經過分段與處理。v0.2 不會嘗試繞過保護；你可以用系統瀏覽器在原站正常閱讀，或使用「圖片閱讀器」讀取有權存取的直接圖片網址。</p></div></div>
        <div className="diagnosticActions">
          {active && <button className="primary" onClick={() => void openOriginal(active.url)}><ExternalLink size={17}/> 使用 Edge／預設瀏覽器閱讀</button>}
          {active && <button className="secondaryButton" disabled={chapterLoading} onClick={() => void openChapter(active, true)}><RefreshCw size={17}/> 重新取得章節資訊</button>}
          <button className="secondaryButton" onClick={() => setTab('reader')}><Image size={17}/> 開啟圖片閱讀器</button>
        </div>
        <p className="detailNote">來源網址：{active?.url || '尚未選擇'}。原站在外部瀏覽器開啟時，其廣告仍由原網站控制。</p>
      </section>}
      {tab === 'library' && <section className="content"><div className="pill">PERSONAL COLLECTION</div><h1>我的<span>書架</span></h1><p className="lead">收藏資料只儲存在這台裝置，不會上傳到伺服器。</p>{books.length === 0 ? <div className="empty"><Library size={36}/><h2>書架還是空的</h2><p>先到來源解析頁面，解析章節後即可收藏。</p><button onClick={() => setTab('source')} className="primary">前往來源解析</button></div> : <div className="bookGrid">{books.map(book => <div className="book" key={book.chapterId}><div className="bookCover"><BookOpen size={36}/></div><div className="bookInfo"><b>{book.title}</b><small>{book.pages} 個頁面節點</small><div className="bookActions"><button onClick={() => void openChapter({ id: book.chapterId, title: book.title, url: book.url })}>開啟章節</button><button aria-label="移除收藏" onClick={() => setBooks(p => p.filter(x => x.chapterId !== book.chapterId))}><Trash2 size={16}/></button></div></div></div>)}</div>}</section>}
      {tab === 'reader' && <section className="content readerContent"><div className="pill">CLEAN READER</div><h1>圖片<span>閱讀器</span></h1><p className="lead">每行貼上一個你有權使用的 HTTPS 漫畫圖片網址（JPG、PNG、WebP 等）。這裡不載入第三方網頁或廣告。</p><textarea value={imageText} onChange={e => { setImageText(e.target.value); setPage(0); }} rows={4} placeholder={'https://example.org/page001.jpg\nhttps://example.org/page002.jpg'}/><div className="readerTools"><span>{images.length} 張圖片</span><div><button className={!vertical ? 'toggle on' : 'toggle'} onClick={() => setVertical(false)}>單頁</button><button className={vertical ? 'toggle on' : 'toggle'} onClick={() => setVertical(true)}>長條捲動</button></div></div>{images.length > 0 ? vertical ? <div className="scrollReader">{images.map((src, i) => <img key={`${src}-${i}`} src={src} loading={i < 2 ? 'eager' : 'lazy'} referrerPolicy="no-referrer" alt={`第 ${i + 1} 頁`} />)}</div> : <div className="singleReader"><div className="pager"><button disabled={page <= 0} onClick={() => setPage(p => p - 1)}><ChevronLeft/> 上一頁</button><span>{Math.min(page + 1, images.length)} / {images.length}</span><button disabled={page >= images.length - 1} onClick={() => setPage(p => p + 1)}>下一頁 <ChevronRight/></button></div><img src={images[Math.min(page, images.length - 1)]} referrerPolicy="no-referrer" alt={`第 ${page + 1} 頁`}/></div> : <div className="empty"><Image size={34}/><h2>等待圖片</h2><p>貼上可直接存取的圖片 URL 即可開始閱讀。</p></div>}</section>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
