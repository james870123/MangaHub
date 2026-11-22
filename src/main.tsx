import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { BookOpen, Bookmark, ExternalLink, RefreshCw, ChevronLeft, ChevronRight, CircleHelp, Globe2, Image, Library, Link, LoaderCircle, Plus, Search, Trash2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import './style.css';
import Reader from './Reader';
import SourceDiagnostics from './SourceDiagnostics';
import NhentaiSource from './NhentaiSource';
import NhCatalog, { type CatalogItem, type GalleryDetail, type ReadingRecord } from './NhCatalog';
import SourceCapabilities from './SourceCapabilityPanel';
import { sourceForUrl } from './sourceCapabilities';

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
  const [tab, setTab] = useState<'source' | 'library' | 'reader' | 'chapter' | 'diagnostics' | 'capabilities' | 'nhentai' | 'catalog'>('catalog');
  const [url, setUrl] = useState(example);
  const [sidebarCollapsed, setSidebarCollapsed] = useSaved('mh-ui-sidebar-collapsed', false);
  const readerOrigin = useRef<'catalog' | 'nhentai' | 'capabilities' | null>(null);
  const catalogScroll = useRef(0);
  const originScroll = useRef(0);
  const [readerReturn, setReaderReturn] = useState<'catalog' | 'nhentai' | 'capabilities' | null>(null);
  function openTab(next: typeof tab) {
    if (next === 'catalog' && tab !== 'reader') window.scrollTo(0, catalogScroll.current);
    setTab(next);
  }
  function returnFromReader() {
    const target = readerOrigin.current;
    readerOrigin.current = null;
    setReaderReturn(null);
    setTab(target ?? 'catalog');
    if (target) {
      const y = target === 'catalog' ? catalogScroll.current : originScroll.current;
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' })));
    } else window.scrollTo(0, 0);
  }
  useEffect(() => {
    if (tab !== 'reader' || !readerReturn) return;
    const onBack = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || (event.altKey && event.key === 'ArrowLeft')) {
        const active = document.activeElement;
        if (active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) return;
        event.preventDefault(); returnFromReader();
      }
    };
    window.addEventListener('keydown', onBack);
    return () => window.removeEventListener('keydown', onBack);
  }, [tab, readerReturn]);
  const [readerUrls, setReaderUrls] = useState<string[] | undefined>();
  const [readerSession, setReaderSession] = useState(0);
  const [adultConfirmed, setAdultConfirmed] = useSaved('mh-v05-adult-confirmed', false);
  const [showCovers, setShowCovers] = useSaved('mh-v05-show-covers', false);
  const [nhFavorites, setNhFavorites] = useSaved<CatalogItem[]>('mh-v05-nh-favorites', []);
  const [nhHistory, setNhHistory] = useSaved<ReadingRecord[]>('mh-v05-nh-history', []);
  const [currentGallery, setCurrentGallery] = useState<GalleryDetail | null>(null);
  const toggleNhFavorite = (item: CatalogItem) => setNhFavorites(prev => prev.some(x => x.id === item.id) ? prev.filter(x => x.id !== item.id) : [item, ...prev].slice(0, 500));
  function readNhGallery(gallery: GalleryDetail) {
    setNhHistory(prev => {
      const existing = prev.find(r => r.id === gallery.id);
      const record: ReadingRecord = { id: gallery.id, title: gallery.title, coverUrl: gallery.coverUrl ?? existing?.coverUrl ?? null, page: existing?.page ?? 1, total: gallery.pageUrls.length, updatedAt: Date.now() };
      return [record, ...prev.filter(r => r.id !== gallery.id)].slice(0, 200);
    });
    readDirectImages(gallery.pageUrls, 'catalog');
    setCurrentGallery(gallery);
  }
  function repairHistoryCover(id: number, coverUrl: string) {
    setNhHistory(prev => prev.map(record => record.id === id && record.coverUrl !== coverUrl
      ? { ...record, coverUrl } : record));
    setNhFavorites(prev => prev.map(item => item.id === id && item.coverUrl !== coverUrl
      ? { ...item, coverUrl } : item));
  }
  function recordNhProgress(page: number) {
    if (!currentGallery) return;
    setNhHistory(prev => prev.map(r => r.id === currentGallery.id && r.page !== page ? { ...r, page, updatedAt: Date.now() } : r));
  }
  function readDirectImages(urls: string[], origin: 'catalog' | 'nhentai' | 'capabilities' | null = null) {
    originScroll.current = window.scrollY;
    if (origin === 'catalog') catalogScroll.current = window.scrollY;
    readerOrigin.current = origin;
    setReaderReturn(origin);
    setCurrentGallery(null);
    setReaderUrls(urls);
    setReaderSession(n => n + 1);
    setTab('reader');
    window.scrollTo(0, 0);
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<ChapterInfo | null>(null);
  const [active, setActive] = useState<Chapter | null>(null);
  const [chapterError, setChapterError] = useState('');
  const [chapterLoading, setChapterLoading] = useState(false);
  const [cache, setCache] = useSaved<Record<string, CachedChapter>>('mh-chapter-cache-v02', {});
  const [books, setBooks] = useSaved<Book[]>('mh-books', []);
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
  return <div className={sidebarCollapsed ? "app sidebar-collapsed" : "app"}>
    <aside className="sidebar">
      <div className="brand"><div className="brandicon"><BookOpen size={22}/></div><div className="brandText"><strong>MangaHub</strong><small>YOUR READING SPACE</small></div></div>
      <button className="sidebarToggle" type="button" title={sidebarCollapsed ? '展開側邊欄' : '收合側邊欄'} aria-label={sidebarCollapsed ? '展開側邊欄' : '收合側邊欄'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(v => !v)}>{sidebarCollapsed ? <PanelLeftOpen size={19}/> : <PanelLeftClose size={19}/>}<span>{sidebarCollapsed ? '展開選單' : '收合選單'}</span></button>
      <div className="sideTitle">工作空間</div>
      <button title="來源解析" aria-label="來源解析" className={tab === 'source' ? 'nav active' : 'nav'} onClick={() => openTab('source')}><Search size={19}/><span className="navText">來源解析</span></button>
      <button title="我的書架" aria-label="我的書架" className={tab === 'library' ? 'nav active' : 'nav'} onClick={() => openTab('library')}><Library size={19}/><span className="navText">我的書架</span> <span className="count">{books.length}</span></button>
      <button title="圖片閱讀器" aria-label="圖片閱讀器" className={tab === 'reader' ? 'nav active' : 'nav'} onClick={() => { setCurrentGallery(null); setReaderReturn(null); readerOrigin.current = null; setReaderUrls(undefined); openTab('reader'); }}><Image size={19}/><span className="navText">圖片閱讀器</span></button>
      <button title="漫畫探索" aria-label="漫畫探索" className={tab === 'catalog' ? 'nav active' : 'nav'} onClick={() => openTab('catalog')}><Search size={19}/><span className="navText">漫畫探索</span></button>
      <button title="nHentai Gallery" aria-label="nHentai Gallery" className={tab === 'nhentai' ? 'nav active' : 'nav'} onClick={() => openTab('nhentai')}><BookOpen size={19}/><span className="navText">nHentai Gallery</span></button>
      <button title="來源相容性" aria-label="來源相容性" className={tab === 'capabilities' ? 'nav active' : 'nav'} onClick={() => openTab('capabilities')}><Image size={19}/><span className="navText">來源相容性</span></button>
      <button title="來源診斷" aria-label="來源診斷" className={tab === 'diagnostics' ? 'nav active' : 'nav'} onClick={() => openTab('diagnostics')}><Globe2 size={19}/><span className="navText">來源診斷</span></button>
      <div className="asideFoot"><CircleHelp size={16}/><span className="footText">v0.5.3 · Local-first<br/>無原站廣告、無追蹤 SDK</span></div>
    </aside>
    <main className="main">
      <header><span className="eyebrow"><Globe2 size={15}/> MangaHub / {tab === 'source' ? 'Source Inspector' : tab === 'library' ? 'My Library' : tab === 'chapter' ? 'Chapter' : tab === 'diagnostics' ? 'Diagnostics' : tab === 'capabilities' ? 'Source Capabilities' : tab === 'catalog' ? 'Discover' : tab === 'nhentai' ? 'Gallery' : 'Reader'}</span><span className="status">● Local-first</span></header>
      {tab === 'source' && <section className="content">
        <div className="pill">SOURCE ADAPTER · COMICBOX</div>
        <h1>探索漫畫，<br/><span>專注於閱讀。</span></h1>
        <p className="lead">輸入 ComicBox 的公開章節網址，擷取章節名稱、導覽資訊和頁面數。v0.3.3 支援已解析章節快取、章節導覽及 HTTP 錯誤診斷；不處理受保護圖片。</p>
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
        <div className="notice"><CircleHelp size={20}/><div><b>目前尚無法在 MangaHub 直接顯示此網站的漫畫圖片</b><p>這個來源的圖片經過分段與處理。v0.3.3 不會嘗試繞過保護；你可以用系統瀏覽器在原站正常閱讀，或使用「圖片閱讀器」讀取有權存取的直接圖片網址。</p></div></div>
        <div className="diagnosticActions">
          {active && <button className="primary" onClick={() => void openOriginal(active.url)}><ExternalLink size={17}/> 使用 Edge／預設瀏覽器閱讀</button>}
          {active && <button className="secondaryButton" disabled={chapterLoading} onClick={() => void openChapter(active, true)}><RefreshCw size={17}/> 重新取得章節資訊</button>}
          <button className="secondaryButton" onClick={() => setTab('capabilities')}><Image size={17}/> 查看來源能力／直接圖片</button>
        </div>
        {active && <p className="detailNote">來源能力：{sourceForUrl(active.url).imageTransport === 'site-managed' ? '原站專用圖片處理，無法直接導入 Reader' : '可使用標準圖片來源'}。</p>}
        <p className="detailNote">來源網址：{active?.url || '尚未選擇'}。原站在外部瀏覽器開啟時，其廣告仍由原網站控制。</p>
      </section>}
      {tab === 'library' && <section className="content"><div className="pill">PERSONAL COLLECTION</div><h1>我的<span>書架</span></h1><p className="lead">收藏資料只儲存在這台裝置，不會上傳到伺服器。</p>{books.length === 0 ? <div className="empty"><Library size={36}/><h2>書架還是空的</h2><p>先到來源解析頁面，解析章節後即可收藏。</p><button onClick={() => setTab('source')} className="primary">前往來源解析</button></div> : <div className="bookGrid">{books.map(book => <div className="book" key={book.chapterId}><div className="bookCover"><BookOpen size={36}/></div><div className="bookInfo"><b>{book.title}</b><small>{book.pages} 個頁面節點</small><div className="bookActions"><button onClick={() => void openChapter({ id: book.chapterId, title: book.title, url: book.url })}>開啟章節</button><button aria-label="移除收藏" onClick={() => setBooks(p => p.filter(x => x.chapterId !== book.chapterId))}><Trash2 size={16}/></button></div></div></div>)}</div>}</section>}
      <div className={tab === 'capabilities' ? 'sourceView' : 'sourceView is-hidden'}><SourceCapabilities onRead={urls => readDirectImages(urls, 'capabilities')}/></div>
      <div className={tab === 'nhentai' ? 'sourceView' : 'sourceView is-hidden'}><NhentaiSource onRead={urls => readDirectImages(urls, 'nhentai')}/></div>
      <div className={tab === 'catalog' ? 'catalogView' : 'catalogView is-hidden'}><NhCatalog adultConfirmed={adultConfirmed} showCovers={showCovers} onAdultChange={setAdultConfirmed} onCoversChange={setShowCovers} favorites={nhFavorites} onToggleFavorite={toggleNhFavorite} history={nhHistory} onClearHistory={() => setNhHistory([])} onReadGallery={readNhGallery} onRepairHistoryCover={repairHistoryCover}/></div>
      {tab === 'diagnostics' && <SourceDiagnostics/>}
      {tab === 'reader' && <Reader key={readerSession} initialUrls={readerUrls} onProgress={currentGallery ? recordNhProgress : undefined} galleryTitle={currentGallery?.title} onBack={readerReturn ? returnFromReader : undefined} backLabel={readerReturn === 'catalog' ? '返回漫畫列表' : readerReturn === 'nhentai' ? '返回 Gallery' : '返回來源頁'}/>} 
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
