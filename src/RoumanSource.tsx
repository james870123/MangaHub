import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, ChevronLeft, ChevronRight, Heart, LoaderCircle, RefreshCw, Search } from 'lucide-react';

export type RoumanChapter = {
  bookId: string; bookTitle: string; chapterId: string; chapterTitle: string;
  chapterIndex: number; chapterCount: number; pageUrls: string[]; url: string;
};
type Card = { id: string; title: string; url: string; coverUrl: string | null; section: string };
type Catalog = { mode: string; page: number; books: Card[]; hasNext: boolean };
type ChapterLink = { index: number; name: string; url: string };
type BookDetail = { id: string; title: string; coverUrl: string | null; description: string; chapters: ChapterLink[] };
type Mode = 'home' | 'all' | 'ongoing' | 'completed';
type Props = { onRead: (chapter: RoumanChapter) => void; active: boolean };
const starter = 'https://rouman5.com/books/cmegn4syy019ved077i2841wl/0';
const recentKey = 'mangahub-rouman-recent-v058';
const favKey = 'mangahub-rouman-favorites-v059';
function saved<T>(key: string, fallback: T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return value === null ? fallback : value as T; }
  catch { return fallback; }
}
function chapterUrl(id: string, index: number) { return `https://rouman5.com/books/${id}/${index}`; }

export default function RoumanSource({ onRead, active }: Props) {
  const [mode, setMode] = useState<Mode>('home');
  const [page, setPage] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState(starter);
  const [chapter, setChapter] = useState<RoumanChapter | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [favorites, setFavorites] = useState<Card[]>(() => saved<Card[]>(favKey, []));
  const [recent, setRecent] = useState<RoumanChapter[]>(() => saved<RoumanChapter[]>(recentKey, []));
  const [showFavorites, setShowFavorites] = useState(false);
  const [badCovers, setBadCovers] = useState<string[]>([]);
  const [showCovers, setShowCovers] = useState(() => saved<boolean>('mh-v05-show-covers', false));
  useEffect(() => { localStorage.setItem(favKey, JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { localStorage.setItem(recentKey, JSON.stringify(recent.map(r => ({ ...r, pageUrls: [] })))); }, [recent]);
  useEffect(() => { localStorage.setItem('mh-v05-show-covers', JSON.stringify(showCovers)); }, [showCovers]);

  async function loadCatalog(target: Mode, nextPage: number) {
    setBusy(true); setError(''); setDetail(null); setChapter(null); setShowFavorites(false);
    try {
      const data = await invoke<Catalog>('browse_rouman_catalog', { mode: target, page: nextPage });
      setCatalog(data); setMode(target); setPage(nextPage);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active && !catalog) void loadCatalog('home', 0); }, [active]); // only when opened

  async function openBook(id: string) {
    setBusy(true); setError(''); setDetail(null); setChapter(null);
    try { setDetail(await invoke<BookDetail>('inspect_rouman_book', { bookId: id })); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function inspect(url: string) {
    setBusy(true); setError('');
    try {
      const data = await invoke<RoumanChapter>('inspect_rouman_chapter', { url: url.trim() });
      setChapter(data); setInput(data.url);
      setRecent(prev => [{...data, pageUrls: []}, ...prev.filter(r => r.url !== data.url)].slice(0, 30));
      return data;
    } catch (e) { setError(String(e)); return null; }
    finally { setBusy(false); }
  }
  async function startChapter(url: string) {
    const data = await inspect(url);
    if (data) onRead(data);
  }
  function changeFavorite(card: Card) {
    setFavorites(prev => prev.some(f => f.id === card.id) ? prev.filter(f => f.id !== card.id) : [card, ...prev].slice(0, 500));
  }
  const visible = useMemo(() => {
    const list = showFavorites ? favorites : catalog?.books ?? [];
    return list.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  }, [showFavorites, favorites, catalog, query]);
  const groupNames = mode === 'home' && !showFavorites ? [...new Set(visible.map(x => x.section))] : [showFavorites ? '我的收藏' : '全部作品'];
  const activeCard: Card | null = detail ? {
    id: detail.id, title: detail.title, url: `https://rouman5.com/books/${detail.id}`,
    coverUrl: detail.coverUrl ?? catalog?.books.find(x => x.id === detail.id)?.coverUrl ?? null,
    section: '作品詳情',
  } : null;
  return <section className="content roumanPage roumanExplore">
    <div className="pill">SOURCE · ROUMAN5 · v0.5.9</div>
    <h1>Rouman5 <span>探索漫畫</span></h1>
    <p className="lead">熱門排行、最近更新、連載／完結、章節目錄與閱讀器整合。只讀取公開網頁，不使用未公開 API。</p>
    <div className="roumanToolbar">
      {([['home','熱門首頁'],['all','全部漫畫'],['ongoing','連載'],['completed','完結']] as const).map(([key,label]) =>
        <button key={key} className={mode === key && !showFavorites ? 'toggle on' : 'toggle'} disabled={busy} onClick={() => void loadCatalog(key, 0)}>{label}</button>)}
      <button className={showFavorites ? 'toggle on' : 'toggle'} onClick={() => { setShowFavorites(true); setDetail(null); setChapter(null); }}><Heart size={15}/> 我的收藏 ({favorites.length})</button>
      <button className="toggle" disabled={busy} onClick={() => void loadCatalog(mode, page)}><RefreshCw size={15}/> 重新整理</button>
      <button className="toggle" onClick={() => setShowCovers(v => !v)}>{showCovers ? '隱藏封面' : '顯示封面'}</button>
    </div>
    <div className="roumanFilter"><Search size={18}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="篩選目前頁面上的作品名稱" aria-label="搜尋目前目錄"/><small>僅篩選已載入作品；非全站搜尋</small></div>
    {error && <div className="error"><b>載入失敗</b><p>{error}</p></div>}
    {busy && <div className="notice"><LoaderCircle className="spin" size={18}/><div>正在讀取來源公開頁面…</div></div>}
    {!detail && !chapter && groupNames.map(group => {
      const cards = visible.filter(card => (mode !== 'home' || showFavorites) || card.section === group);
      return <div key={group} className="roumanSection"><h2>{group} <small>{cards.length} 部</small></h2>
        <div className="roumanGrid">{cards.map((card, i) => <article className="roumanCard" key={`${group}:${card.id}:${i}`}>
          <button className="roumanCoverButton" onClick={() => void openBook(card.id)} aria-label={`查看 ${card.title}`}>
            {showCovers && card.coverUrl && !badCovers.includes(card.id) ? <img src={card.coverUrl} loading="lazy" alt={card.title} onError={() => setBadCovers(p => [...p, card.id])}/> : <BookOpen size={30}/>}
          </button>
          <div className="roumanCardInfo"><button className="roumanTitle" onClick={() => void openBook(card.id)}>{card.title}</button>
            <div className="roumanCardBottom"><small>{card.section}</small><button aria-label="收藏" className="roumanHeart" onClick={() => changeFavorite(card)}><Heart size={17} fill={favorites.some(x=>x.id === card.id) ? 'currentColor' : 'none'}/></button></div>
          </div>
        </article>)}</div>
      </div>;
    })}
    {!detail && !chapter && !showFavorites && mode !== 'home' && <div className="roumanPager">
      <button className="toggle" disabled={busy || page <= 0} onClick={() => void loadCatalog(mode, page - 1)}><ChevronLeft size={15}/> 上一頁</button>
      <span>第 {page + 1} 頁</span>
      <button className="toggle" disabled={busy || !catalog?.hasNext} onClick={() => void loadCatalog(mode, page + 1)}>下一頁 <ChevronRight size={15}/></button>
    </div>}
    {detail && <div className="roumanDetail">
      <button className="backButton" onClick={() => { setDetail(null); setError(''); }}>〈 返回作品列表</button>
      <h2>{detail.title}</h2><p className="detailNote">{detail.description}</p>
      <div className="roumanDetailActions">
        {activeCard && <button className="secondaryButton" onClick={() => changeFavorite(activeCard)}><Heart size={16}/>{favorites.some(x=>x.id===detail.id)?'取消收藏':'加入收藏'}</button>}
        <span>{detail.chapters.length} 個章節</span>
      </div>
      <h3>章節目錄</h3>
      <div className="chapterList roumanChapterList">{detail.chapters.map(link => <button key={link.index} disabled={busy} onClick={() => void startChapter(link.url)}><span>{link.name}</span><ChevronRight size={16}/></button>)}</div>
    </div>}
    {chapter && <div className="roumanResult"><div className="resultTop"><div><h3>{chapter.bookTitle}</h3><p>{chapter.chapterTitle} · {chapter.pageUrls.length} 張圖片</p></div>
      <button className="primary" onClick={() => onRead(chapter)}><BookOpen size={17}/> 重新閱讀</button></div>
      <div className="diagnosticActions"><button className="secondaryButton" onClick={() => {setChapter(null);}}>返回章節清單</button>
      <button className="secondaryButton" disabled={chapter.chapterIndex===0 || busy} onClick={() => void startChapter(chapterUrl(chapter.bookId, chapter.chapterIndex-1))}>上一話</button>
      <button className="secondaryButton" disabled={busy || (chapter.chapterCount > 0 && chapter.chapterIndex + 1 >= chapter.chapterCount)} onClick={() => void startChapter(chapterUrl(chapter.bookId, chapter.chapterIndex+1))}>下一話</button></div></div>}
    <details className="roumanManual"><summary>貼上章節網址（進階）</summary>
      <form className="urlbox" onSubmit={e=>{e.preventDefault();void startChapter(input);}}><input value={input} onChange={e=>setInput(e.target.value)} placeholder={starter}/><button disabled={busy}>解析並閱讀</button></form>
    </details>
    {recent.length>0 && <details className="roumanRecent"><summary>最近閱讀章節 ({recent.length})</summary><div className="chapterList">{recent.map(r=><button key={r.url} onClick={()=>void startChapter(r.url)}>{r.bookTitle} · {r.chapterTitle}<ChevronRight size={16}/></button>)}</div></details>}
  </section>;
}
