import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bookmark, BookOpen, ChevronLeft, ChevronRight, Clock3, Eye, EyeOff, Heart, LoaderCircle, RefreshCw, Search, Shield, Star, Trash2, Shuffle, Sparkles } from 'lucide-react';

export type CatalogItem = { id: number; title: string; coverUrl: string | null; pageCount: number; tags: string[] };
export type GalleryDetail = { id: number; title: string; pageUrls: string[]; coverUrl?: string | null; tags?: string[] };
export type ReadingRecord = { id: number; title: string; coverUrl: string | null; page: number; total: number; updatedAt: number };
type CatalogPage = { items: CatalogItem[]; page: number; totalPages: number | null; hasNext: boolean };
type Mode = 'latest' | 'popular' | 'search' | 'favorites' | 'history';
type Sort = 'date' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month';
type Props = {
  adultConfirmed: boolean;
  showCovers: boolean;
  onAdultChange: (confirmed: boolean) => void;
  onCoversChange: (show: boolean) => void;
  favorites: CatalogItem[];
  onToggleFavorite: (item: CatalogItem) => void;
  history: ReadingRecord[];
  onClearHistory: () => void;
  onReadGallery: (gallery: GalleryDetail) => void;
  onRepairHistoryCover: (id: number, coverUrl: string) => void;
  blockedTags: string[];
  onOpenComments: (id:number)=>void;
};
const sorting: { value: Sort; label: string }[] = [
  { value: 'date', label: '最新' },
  { value: 'popular', label: '全部熱門' },
  { value: 'popular-today', label: '今日熱門' },
  { value: 'popular-week', label: '本週熱門' },
  { value: 'popular-month', label: '本月熱門' },
];
const infoForRecord = (r: ReadingRecord): CatalogItem => ({ id: r.id, title: r.title, coverUrl: r.coverUrl, pageCount: r.total, tags: [] });

export default function NhCatalog(props: Props) {
  const { adultConfirmed, showCovers, onAdultChange, onCoversChange, favorites, onToggleFavorite, history, onClearHistory, onReadGallery, onRepairHistoryCover, blockedTags, onOpenComments } = props;
  const [mode, setMode] = useState<Mode>('latest');
  const [searchText, setSearchText] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [sort, setSort] = useState<Sort>('date');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<GalleryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [selection, setSelection] = useState<CatalogItem | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [coverOverrides, setCoverOverrides] = useState<Record<number, string>>({});
  const [related, setRelated] = useState<CatalogItem[]>([]);
  const [relatedError, setRelatedError] = useState('');
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [randomLoading, setRandomLoading] = useState(false);
  const [jumpPage, setJumpPage] = useState('');
  const [searchKind, setSearchKind] = useState('');
  const [searchValue, setSearchValue] = useState('');

  // Search is useful before a keyword is entered: default to the newest public
  // catalog, or today's popular public catalog, without making an invalid
  // /api/v2/search request with an empty query.
  const searchHasQuery = submitted.trim().length > 0;
  const browseMode: 'latest' | 'popular' | 'search' = mode === 'search' && !searchHasQuery
    ? (sort === 'popular-today' ? 'popular' : 'latest')
    : mode === 'popular' ? 'popular' : mode === 'search' ? 'search' : 'latest';

  useEffect(() => {
    if (!adultConfirmed || mode === 'favorites' || mode === 'history') return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setResult(null);
    void invoke<CatalogPage>('browse_nh_catalog', { mode: browseMode, query: submitted, sort, page })
      .then(value => { if (!cancelled) setResult(value); })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [adultConfirmed, mode, browseMode, submitted, sort, page, refresh]);

  const changeMode = (next: Mode) => {
    setMode(next);
    setPage(1);
    setDetail(null);
    setError('');
    if (next === 'search' && !submitted.trim()) setSort('date');
  };
  const openDetail = useCallback(async (item: CatalogItem) => {
    setSelection(item); setDetail(null); setDetailError(''); setDetailLoading(true); setRelated([]); setRelatedError('');
    try {
      const data = await invoke<GalleryDetail>('fetch_nh_gallery', { input: String(item.id) });
      setDetail(data);
      if (data.coverUrl) {
        setCoverOverrides(prev => ({ ...prev, [data.id]: data.coverUrl! }));
        onRepairHistoryCover(data.id, data.coverUrl);
      }
    } catch (err) { setDetailError(String(err)); }
    finally { setDetailLoading(false); }
    setRelatedLoading(true);
    void invoke<CatalogPage>('related_nh_galleries', { id: item.id })
      .then(data => setRelated(data.items.filter(g => g.id !== item.id).slice(0, 12)))
      .catch(err => setRelatedError(String(err)))
      .finally(() => setRelatedLoading(false));
  }, [onRepairHistoryCover]);
  async function openRandom() {
    setRandomLoading(true);
    try {
      const id = await invoke<number>('random_nh_gallery');
      await openDetail({ id, title: `#${id}`, coverUrl: null, pageCount: 0, tags: [] });
    } catch (err) { setError(String(err)); }
    finally { setRandomLoading(false); }
  }
  function submitAdvancedSearch() {
    const value = searchValue.trim();
    const filter = value && searchKind ? `${searchKind}:${value.includes(' ') ? `"${value.replace(/"/g, '')}"` : value}` : '';
    const query = [searchText.trim(), filter].filter(Boolean).join(' ').trim();
    if (!query) return;
    setMode('search'); setPage(1); setSubmitted(query); setSearchText(query);
  }
  function searchTag(tag: string) {
    const query = `tag:"${tag.replace(/"/g,'')}"`;
    setSearchText(query); setSubmitted(query); setMode('search'); setPage(1); setSelection(null);
  }
  const visibleItems = (mode === 'favorites' ? favorites : mode === 'history' ? history.map(infoForRecord) : (result?.items ?? [])).map(item => coverOverrides[item.id] ? { ...item, coverUrl: coverOverrides[item.id] } : item);
  const excluded = blockedTags.map(x=>x.toLowerCase().trim()).filter(Boolean);
  const filteredItems = visibleItems.filter(item=>!item.tags.some(tag=>excluded.some(b=>tag.toLowerCase()===b)));
  const selected = selection ? favorites.some(f => f.id === selection.id) : false;

  if (!adultConfirmed) return <section className="content">
    <div className="pill">CONTENT SETTINGS</div><h1>內容<span>顯示設定</span></h1>
    <div className="notice"><Shield size={24}/><div><b>成人內容預設關閉</b><p>此來源可能包含成人題材。只有年滿 18 歲且符合所在地法律與網站規定的使用者才能自行啟用。MangaHub 不會預先載入封面或目錄。</p></div></div>
    <label className="cap-consent"><input type="checkbox" checked={adultConfirmed} onChange={e => onAdultChange(e.target.checked)}/> 我已年滿 18 歲，並同意自行遵守網站規定</label>
    <p className="detailNote">此設定保存在目前裝置。不會自動下載作品、圖片或登入帳號。</p>
  </section>;

  return <section className="content catalogPage">
    <div className="pill">MANGAHUB · DISCOVER v0.5</div>
    <h1>探索<span>漫畫</span></h1>
    <p className="lead">瀏覽最新、熱門、搜尋與本機書架。封面預設隱藏，只有你允許時才顯示。</p>
    <div className="catalogTabs">
      {([['latest','最新'],['popular','熱門'],['search','搜尋'],['favorites','我的收藏'],['history','最近閱讀']] as [Mode,string][]).map(([value,label]) => <button key={value} className={mode === value ? 'on' : ''} onClick={() => changeMode(value)}>{label}</button>)}
    </div>
    <div className="catalogControls">
      <button className="secondaryButton" onClick={() => onCoversChange(!showCovers)}>{showCovers ? <Eye size={17}/> : <EyeOff size={17}/>} {showCovers ? '隱藏封面' : '顯示成人封面'}</button>
      <button className="secondaryButton" onClick={() => onAdultChange(false)}><Shield size={17}/> 關閉成人目錄</button>
      {mode === 'history' && history.length > 0 && <button className="secondaryButton" onClick={() => { if (window.confirm('確定清除這台裝置的閱讀歷史？')) onClearHistory(); }}><Trash2 size={17}/> 清除歷史</button>}
      <button className="secondaryButton" disabled={randomLoading} onClick={() => void openRandom()}><Shuffle size={17}/> {randomLoading ? '選取中…' : '隨機作品'}</button>
      {(mode === 'latest' || mode === 'popular' || mode === 'search') && <button className="secondaryButton" disabled={loading} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17}/> 重新整理</button>}
    </div>
    {mode === 'search' && <form className="urlbox" onSubmit={e => { e.preventDefault(); setPage(1); setSubmitted(searchText.trim()); }}>
      <Search size={18}/><input aria-label="搜尋標題或標籤" placeholder="搜尋標題、作者或標籤（可留空瀏覽最新）" value={searchText} onChange={e => setSearchText(e.target.value)}/>
      <button disabled={loading}>{searchText.trim() ? '搜尋' : '顯示最新'}</button>
    </form>}
    {mode === 'search' && <div className="catalogQueryTools">
      <label>進階條件 <select value={searchKind} onChange={e => setSearchKind(e.target.value)}>
        <option value="">不使用</option><option value="artist">作者</option><option value="language">語言</option><option value="tag">標籤</option><option value="character">角色</option><option value="parody">作品來源</option><option value="group">社團</option>
      </select></label>
      <input aria-label="進階搜尋值" placeholder="作者、語言或標籤" value={searchValue} onChange={e => setSearchValue(e.target.value)}/>
      <button className="secondaryButton" onClick={submitAdvancedSearch}>套用條件</button>
    </div>}
    {mode === 'search' && <div className="catalogSort"><label>排序 <select value={sort} onChange={e => { setSort(e.target.value as Sort); setPage(1); }}>{sorting.map(option => <option key={option.value} value={option.value} disabled={!searchHasQuery && option.value !== 'date' && option.value !== 'popular-today'}>{option.label}{!searchHasQuery && option.value !== 'date' && option.value !== 'popular-today' ? '（需關鍵字）' : ''}</option>)}</select></label>
      {!searchHasQuery && <p className="detailNote">尚未輸入關鍵字：可直接瀏覽「最新」與「今日熱門」。其他熱門排序需要先搜尋作品。</p>}
    </div>}
    {mode === 'popular' && <div className="notice"><Star size={18}/><div><b>今日熱門</b><p>使用來源 API 的熱門作品端點。若要搜尋「全部熱門／本週熱門」，請到搜尋頁選擇對應排序。</p></div></div>}
    {loading && <div className="catalogStatus"><LoaderCircle className="spin" size={24}/> 正在讀取作品資訊…</div>}
    {error && <div className="error"><strong>無法取得目錄</strong><p>{error}</p><small>遇到 403／429 不會自動重試。請遵守來源站的請求限制。</small></div>}
    {!loading && !error && visibleItems.length === 0 && <div className="empty"><BookOpen size={34}/><h2>目前沒有作品</h2><p>{mode === 'favorites' ? '點選漫畫詳情中的收藏按鈕即可加入。' : mode === 'history' ? '開始閱讀後，作品會出現在這裡。' : '可嘗試其他搜尋關鍵字或稍後重新整理。'}</p></div>}
    {blockedTags.length>0 && <p className="catalogBlockedNotice">已啟用 {blockedTags.length} 個黑名單標籤（僅篩選 API 已提供標籤的作品）</p>}
    <div className="catalogGrid">{filteredItems.map(item => <article key={item.id} className="catalogCard">
      <button className="catalogCardMain" onClick={() => void openDetail(item)} aria-label={`查看 ${item.title}`}>
        <div className="catalogCover"><BookOpen size={32}/>{showCovers && item.coverUrl && <img src={item.coverUrl} alt="作品封面" title="封面無法載入時，點擊作品取得最新資料" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }}/>}</div>
        <div className="catalogCardText"><strong>{item.title}</strong><small>#{item.id} · {item.pageCount || '—'} 頁</small>{mode === 'history' && <small><Clock3 size={12}/> 上次第 {history.find(r => r.id === item.id)?.page ?? 1} 頁</small>}{mode === 'history' && !item.coverUrl && <small>封面未儲存，點此更新資料</small>}</div>
      </button>
      <button className="catalogHeart" aria-label={favorites.some(f => f.id === item.id) ? '取消收藏' : '收藏'} onClick={() => onToggleFavorite(item)}><Heart size={18} fill={favorites.some(f => f.id === item.id) ? 'currentColor' : 'none'}/></button>
    </article>)}</div>
    {(mode === 'latest' || (mode === 'search' && browseMode !== 'popular')) && result && <div className="catalogPager">
      <button disabled={page <= 1 || loading} onClick={() => setPage(n => Math.max(1, n - 1))}><ChevronLeft size={18}/> 上一頁</button>
      <span>第 {page} 頁{result.totalPages ? ` / ${result.totalPages} 頁` : ''}</span>
      <form className="catalogPageJump" onSubmit={e => { e.preventDefault(); const n=Number(jumpPage); if(Number.isInteger(n) && n>=1 && n<=Math.min(result.totalPages ?? 1000,1000)) setPage(n); }}>
        <input aria-label="指定頁碼" type="number" min={1} max={Math.min(result.totalPages ?? 1000,1000)} value={jumpPage} onChange={e => setJumpPage(e.target.value)} placeholder="頁碼"/>
        <button disabled={!jumpPage.trim() || loading} type="submit">跳頁</button>
      </form>
      <button disabled={!result.hasNext || loading} onClick={() => setPage(n => n + 1)}>下一頁 <ChevronRight size={18}/></button>
    </div>}
    {selection && <div className="catalogModalShade" role="presentation" onClick={() => setSelection(null)}>
      <section className="catalogModal" role="dialog" aria-modal="true" aria-label="漫畫詳情" onClick={e => e.stopPropagation()}>
        <button className="catalogClose" onClick={() => setSelection(null)} aria-label="關閉">×</button>
        <div className="pill muted">GALLERY · {selection.id}</div><h2>{detail?.title || selection.title}</h2>
        <div className="catalogDetailRow"><div className="catalogDetailCover">{showCovers && (detail?.coverUrl || selection.coverUrl) ? <img src={(detail?.coverUrl || selection.coverUrl)!} alt="作品封面" referrerPolicy="no-referrer"/> : <BookOpen size={44}/>}</div>
          <div className="catalogDetailInfo"><p>頁數：{detail?.pageUrls.length ?? selection.pageCount ?? '—'}</p><p>作品 ID：{selection.id}</p>
            <div className="catalogTags">{(detail?.tags?.length ? detail.tags : selection.tags).map(tag => <button key={tag} title="搜尋此標籤" onClick={() => searchTag(tag)}>{tag}</button>)}</div>
            <button className="secondaryButton" onClick={() => onToggleFavorite(selection)}><Bookmark size={17}/> {selected ? '取消收藏' : '加入收藏'}</button>
            <button className="secondaryButton" onClick={()=>{onOpenComments(selection.id);setSelection(null);}}>查看漫畫留言</button>
            <button className="primary" disabled={!detail || detailLoading || detail.pageUrls.length === 0} onClick={() => { if (detail) { onReadGallery(detail); setSelection(null); } }}><BookOpen size={17}/> 在 MangaHub 閱讀</button>
          </div></div>
        {relatedLoading && <p className="catalogStatus"><Sparkles size={18}/> 正在取得相關作品…</p>}
        {relatedError && <p className="detailNote">相關作品暫不可用：{relatedError}</p>}
        {related.length > 0 && <div className="catalogRelated"><strong>相關作品</strong><div className="catalogRelatedGrid">{related.map(item => <button key={item.id} className="catalogRelatedTile" onClick={() => void openDetail(item)}>{showCovers && item.coverUrl ? <img loading="lazy" src={item.coverUrl} referrerPolicy="no-referrer" alt=""/> : <BookOpen size={25}/>}<span>{item.title}</span></button>)}</div></div>}
        {detailLoading && <p className="catalogStatus"><LoaderCircle className="spin" size={20}/> 載入作品詳情中…</p>}
        {detailError && <div className="error"><strong>作品詳情取得失敗</strong><p>{detailError}</p><button onClick={() => void openDetail(selection)}>重試</button></div>}
        <p className="detailNote">圖片僅在開啟閱讀器後載入。漫畫資料與圖片是否可取得取決於來源 API、CDN 及使用權限。</p>
      </section>
    </div>}
  </section>;
}
