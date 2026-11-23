import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowDownAZ, ArrowUpAZ, BookOpen, Check, ChevronLeft, ChevronRight,
  Clock3, Heart, LoaderCircle, Play, RefreshCw, Search, X,
} from 'lucide-react';

export type RoumanChapter = {
  bookId: string; bookTitle: string; chapterId: string; chapterTitle: string;
  chapterIndex: number; chapterCount: number; pageUrls: string[]; url: string;
};
type Card = { id: string; title: string; url: string; coverUrl: string | null; section: string };
type Catalog = { mode: string; page: number; books: Card[]; hasNext: boolean };
type ChapterLink = { index: number; name: string; url: string };
type BookDetail = { id: string; title: string; coverUrl: string | null; description: string; chapters: ChapterLink[] };
type Mode = 'home' | 'all' | 'ongoing' | 'completed';
type Order = 'site' | 'az' | 'za';
type Props = { onRead: (chapter: RoumanChapter) => void; active: boolean };
const starter = 'https://rouman5.com/books/cmegn4syy019ved077i2841wl/0';
const recentKey = 'mangahub-rouman-recent-v058';
const favKey = 'mangahub-rouman-favorites-v059';
const preferenceKey = 'mangahub-rouman-ui-v060';
function saved<T>(key: string, fallback: T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return value === null ? fallback : value as T; }
  catch { return fallback; }
}
function chapterUrl(id: string, index: number) { return `https://rouman5.com/books/${id}/${index}`; }
function chapterNumber(index: number) { return `第 ${index + 1} 話`; }
function displayTitle(title: string) { return title.trim() || '未命名作品'; }

export default function RoumanSource({ onRead, active }: Props) {
  const [mode, setMode] = useState<Mode>('home');
  const [page, setPage] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<Order>(() => saved<Order>(preferenceKey + '-order', 'site'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState(starter);
  const [chapter, setChapter] = useState<RoumanChapter | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [chapterSearch, setChapterSearch] = useState('');
  const [chaptersDescending, setChaptersDescending] = useState(() => saved<boolean>(preferenceKey + '-chapters-desc', true));
  const [favorites, setFavorites] = useState<Card[]>(() => saved<Card[]>(favKey, []));
  const [recent, setRecent] = useState<RoumanChapter[]>(() => saved<RoumanChapter[]>(recentKey, []));
  const [showFavorites, setShowFavorites] = useState(false);
  const [badCovers, setBadCovers] = useState<string[]>([]);
  const [showCovers, setShowCovers] = useState(() => saved<boolean>('mh-v05-show-covers', false));
  const [sectionFilter, setSectionFilter] = useState('all');

  useEffect(() => { localStorage.setItem(favKey, JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { localStorage.setItem(recentKey, JSON.stringify(recent.map(r => ({ ...r, pageUrls: [] })))); }, [recent]);
  useEffect(() => { localStorage.setItem('mh-v05-show-covers', JSON.stringify(showCovers)); }, [showCovers]);
  useEffect(() => { localStorage.setItem(preferenceKey + '-order', JSON.stringify(order)); }, [order]);
  useEffect(() => { localStorage.setItem(preferenceKey + '-chapters-desc', JSON.stringify(chaptersDescending)); }, [chaptersDescending]);

  async function loadCatalog(target: Mode, nextPage: number) {
    setBusy(true); setError(''); setDetail(null); setChapter(null); setShowFavorites(false); setSectionFilter('all');
    try {
      const data = await invoke<Catalog>('browse_rouman_catalog', { mode: target, page: nextPage });
      setCatalog(data); setMode(target); setPage(nextPage);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active && !catalog) void loadCatalog('home', 0); }, [active]);

  async function openBook(id: string) {
    setBusy(true); setError(''); setChapterSearch('');
    try {
      const book = await invoke<BookDetail>('inspect_rouman_book', { bookId: id });
      setDetail(book); setChapter(null);
      // Keep the existing catalog mounted: returning to it won't reset filters or pagination.
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function inspect(url: string) {
    setBusy(true); setError('');
    try {
      const data = await invoke<RoumanChapter>('inspect_rouman_chapter', { url: url.trim() });
      setChapter(data); setInput(data.url);
      setRecent(prev => [{ ...data, pageUrls: [] }, ...prev.filter(r => r.url !== data.url)].slice(0, 30));
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
    const needle = query.toLocaleLowerCase().trim();
    const filtered = list.filter(item => item.title.toLocaleLowerCase().includes(needle) &&
      (mode !== 'home' || showFavorites || sectionFilter === 'all' || item.section === sectionFilter));
    if (order === 'site') return filtered;
    return [...filtered].sort((a, b) => (order === 'az' ? 1 : -1) * a.title.localeCompare(b.title));
  }, [showFavorites, favorites, catalog, query, mode, sectionFilter, order]);
  const sections = useMemo(() => [...new Set((catalog?.books ?? []).map(x => x.section))], [catalog]);
  const groupNames = mode === 'home' && !showFavorites && order === 'site' ? [...new Set(visible.map(x => x.section))] : [showFavorites ? '我的收藏' : '作品清單'];
  const activeCard: Card | null = detail ? {
    id: detail.id, title: detail.title, url: `https://rouman5.com/books/${detail.id}`,
    coverUrl: detail.coverUrl ?? catalog?.books.find(x => x.id === detail.id)?.coverUrl ?? null,
    section: '作品詳情',
  } : null;
  const activeRecent = detail ? recent.find(x => x.bookId === detail.id) : undefined;
  const chapterLinks = useMemo(() => {
    const needle = chapterSearch.trim().toLocaleLowerCase();
    if (!detail) return [];
    return detail.chapters.filter(c => c.name.toLocaleLowerCase().includes(needle) ||
      String(c.index + 1) === needle).sort((a, b) => chaptersDescending ? b.index - a.index : a.index - b.index);
  }, [detail, chapterSearch, chaptersDescending]);
  const showList = !detail && !chapter;
  const isSaved = (id: string) => favorites.some(f => f.id === id);
  return <section className="content roumanPage roumanExplore">
    <div className="roumanHeading">
      <div><div className="pill">SOURCE · ROUMAN5 · v0.6.0</div>
        <h1>Rouman5 <span>探索漫畫</span></h1>
        <p className="lead">依公開目錄探索作品、查看章節與接續閱讀。漫畫內容由原站提供。</p></div>
      {recent.length > 0 && showList && <button className="roumanResume" disabled={busy} onClick={() => void startChapter(recent[0].url)}>
        <Clock3 size={18}/><span><strong>接續上次閱讀</strong><small>{recent[0].bookTitle} · {recent[0].chapterTitle}</small></span><ChevronRight size={16}/>
      </button>}
    </div>
    <div className="roumanToolbar" role="navigation" aria-label="Rouman5 作品目錄">
      {([['home','熱門首頁'],['all','全部漫畫'],['ongoing','連載'],['completed','完結']] as const).map(([key,label]) =>
        <button key={key} className={mode === key && !showFavorites ? 'toggle on' : 'toggle'} disabled={busy} onClick={() => void loadCatalog(key, 0)}>{label}</button>)}
      <button className={showFavorites ? 'toggle on' : 'toggle'} onClick={() => { setShowFavorites(true); setDetail(null); setChapter(null); setError(''); }}><Heart size={15}/> 我的收藏 ({favorites.length})</button>
      <button className="toggle" disabled={busy} onClick={() => void loadCatalog(mode, page)}><RefreshCw size={15}/> 重新整理</button>
      <button className="toggle" aria-pressed={showCovers} onClick={() => setShowCovers(v => !v)}>{showCovers ? '隱藏封面' : '顯示封面'}</button>
    </div>
    {showList && <>
      {mode === 'home' && !showFavorites && sections.length > 1 && <div className="roumanSectionTabs" aria-label="首頁排行分類">
        <button className={sectionFilter === 'all' ? 'active' : ''} onClick={() => setSectionFilter('all')}>全部排行</button>
        {sections.map(s => <button key={s} className={sectionFilter === s ? 'active' : ''} onClick={() => setSectionFilter(s)}>{s}</button>)}
      </div>}
      <div className="roumanBrowseTools"><div className="roumanFilter"><Search size={18}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋目前已載入的作品" aria-label="搜尋目前目錄"/>
        {query && <button aria-label="清除搜尋" className="roumanClear" onClick={() => setQuery('')}><X size={16}/></button>}</div>
        <label className="roumanSort">顯示順序<select value={order} onChange={e => setOrder(e.target.value as Order)}><option value="site">原站排序</option><option value="az">標題 A → Z</option><option value="za">標題 Z → A</option></select></label>
      </div>
      <div className="roumanListMeta"><span>{showFavorites ? '我的收藏' : mode === 'home' ? '首頁排行' : mode === 'all' ? '全部漫畫' : mode === 'ongoing' ? '連載中' : '已完結'} · {visible.length} 部作品</span><small>搜尋只篩選已載入清單，並非全站搜尋</small></div>
    </>}
    {error && <div className="error" role="alert"><b>載入失敗</b><p>{error}</p><button className="secondaryButton" disabled={busy} onClick={() => { setError(''); if (detail) void openBook(detail.id); else void loadCatalog(mode, page); }}>重試</button></div>}
    {busy && <div className="notice" role="status"><LoaderCircle className="spin" size={18}/><div>正在讀取來源公開頁面…</div></div>}
    {showList && (visible.length === 0 && !busy ? <div className="roumanEmpty"><Search size={28}/><h3>沒有符合的作品</h3><p>試著清除搜尋條件，或切換其他分類。</p><button className="toggle" onClick={() => {setQuery('');setSectionFilter('all');}}>清除篩選</button></div>
      : groupNames.map(group => {
      const cards = visible.filter(card => (mode !== 'home' || showFavorites || order !== 'site') || card.section === group);
      return <div key={group} className="roumanSection"><h2>{group} <small>{cards.length} 部</small></h2>
        <div className="roumanGrid">{cards.map((card, i) => <article className="roumanCard" key={`${group}:${card.id}:${i}`}>
          <button className="roumanCoverButton" disabled={busy} onClick={() => void openBook(card.id)} aria-label={`查看 ${card.title}`}>
            {showCovers && card.coverUrl && !badCovers.includes(card.id) ? <img src={card.coverUrl} loading="lazy" alt="" onError={() => setBadCovers(p => p.includes(card.id) ? p : [...p, card.id])}/> : <BookOpen size={30}/>}</button>
          <div className="roumanCardInfo"><button className="roumanTitle" title={card.title} onClick={() => void openBook(card.id)}>{displayTitle(card.title)}</button>
            <div className="roumanCardBottom"><small>{card.section}</small><button aria-label={isSaved(card.id) ? '取消收藏' : '收藏作品'} aria-pressed={isSaved(card.id)} className="roumanHeart" onClick={() => changeFavorite(card)}><Heart size={17} fill={isSaved(card.id) ? 'currentColor' : 'none'}/></button></div></div>
        </article>)}</div></div>;
    }))}
    {showList && !showFavorites && mode !== 'home' && <div className="roumanPager">
      <button className="toggle" disabled={busy || page <= 0} onClick={() => void loadCatalog(mode, page - 1)}><ChevronLeft size={15}/> 上一頁</button><span>第 {page + 1} 頁</span>
      <button className="toggle" disabled={busy || !catalog?.hasNext} onClick={() => void loadCatalog(mode, page + 1)}>下一頁 <ChevronRight size={15}/></button>
    </div>}
    {detail && <div className="roumanDetail">
      <button className="roumanBack" onClick={() => {setDetail(null);setChapter(null);setError('');}}><ChevronLeft size={16}/> 返回原本作品列表</button>
      <div className="roumanDetailHero"><div className="roumanDetailCover">{showCovers && activeCard?.coverUrl ? <img src={activeCard.coverUrl} alt="作品封面" onError={e => { e.currentTarget.style.visibility = 'hidden'; }}/> : <BookOpen size={42}/>}</div>
        <div className="roumanDetailBody"><h2>{displayTitle(detail.title)}</h2><p className="detailNote">{detail.description || '來源未提供作品介紹。'}</p>
          <div className="roumanDetailActions"><span><BookOpen size={15}/>{detail.chapters.length} 個章節</span>
            {activeCard && <button className="secondaryButton" onClick={() => changeFavorite(activeCard)}><Heart size={16} fill={isSaved(detail.id) ? 'currentColor' : 'none'}/>{isSaved(detail.id) ? '取消收藏' : '加入收藏'}</button>}
            {activeRecent && <button className="primary" disabled={busy} onClick={() => void startChapter(activeRecent.url)}><Play size={16}/> 繼續閱讀 {chapterNumber(activeRecent.chapterIndex)}</button>}
            {!activeRecent && detail.chapters.length > 0 && <button className="primary" disabled={busy} onClick={() => void startChapter(detail.chapters[0].url)}><Play size={16}/> 開始閱讀</button>}
          </div></div>
      </div>
      <div className="roumanChaptersHeader"><div><h3>章節目錄</h3><small>共 {detail.chapters.length} 話，點選即可閱讀</small></div>
        <div className="roumanChapterTools"><label className="roumanChapterSearch"><Search size={15}/><input value={chapterSearch} onChange={e => setChapterSearch(e.target.value)} placeholder="搜尋章節或話數" aria-label="搜尋章節"/></label>
          <button className="toggle" aria-label="切換章節排序" onClick={() => setChaptersDescending(v => !v)}>{chaptersDescending ? <ArrowDownAZ size={16}/> : <ArrowUpAZ size={16}/>} {chaptersDescending ? '新到舊' : '舊到新'}</button>
        </div></div>
      <div className="roumanChapterGrid">{chapterLinks.map(link => <button className={activeRecent?.chapterIndex === link.index ? 'roumanChapterItem last' : 'roumanChapterItem'} key={link.index} disabled={busy} onClick={() => void startChapter(link.url)}><span>{link.name || chapterNumber(link.index)}</span>{activeRecent?.chapterIndex === link.index ? <small><Check size={13}/> 上次閱讀</small> : <ChevronRight size={16}/>}</button>)}</div>
      {chapterLinks.length === 0 && <div className="roumanEmpty">沒有符合的章節，請調整搜尋內容。</div>}
    </div>}
    {chapter && <div className="roumanResult"><div className="resultTop"><div><h3>{chapter.bookTitle}</h3><p>{chapter.chapterTitle} · {chapter.pageUrls.length} 張圖片</p></div>
      <button className="primary" onClick={() => onRead(chapter)}><BookOpen size={17}/> 繼續閱讀</button></div>
      <div className="diagnosticActions"><button className="secondaryButton" onClick={() => {setChapter(null);}}>返回章節目錄</button>
      <button className="secondaryButton" disabled={chapter.chapterIndex===0 || busy} onClick={() => void startChapter(chapterUrl(chapter.bookId, chapter.chapterIndex-1))}>上一話</button>
      <button className="secondaryButton" disabled={busy || (chapter.chapterCount > 0 && chapter.chapterIndex + 1 >= chapter.chapterCount)} onClick={() => void startChapter(chapterUrl(chapter.bookId, chapter.chapterIndex+1))}>下一話</button></div></div>}
    <details className="roumanManual"><summary>貼上章節網址（進階）</summary><form className="urlbox" onSubmit={e=>{e.preventDefault();void startChapter(input);}}><input value={input} onChange={e => setInput(e.target.value)} placeholder={starter}/><button disabled={busy}>解析並閱讀</button></form></details>
    {recent.length>0 && <details className="roumanRecent"><summary>最近閱讀章節 ({recent.length})</summary><div className="chapterList">{recent.map(r=><button key={r.url} onClick={()=>void startChapter(r.url)}>{r.bookTitle} · {r.chapterTitle}<ChevronRight size={16}/></button>)}</div></details>}
  </section>;
}
