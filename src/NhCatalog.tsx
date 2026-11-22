import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bookmark, BookOpen, ChevronLeft, ChevronRight, Clock3, Eye, EyeOff, Heart, LoaderCircle, RefreshCw, Search, Shield, Star, Trash2 } from 'lucide-react';

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
  const { adultConfirmed, showCovers, onAdultChange, onCoversChange, favorites, onToggleFavorite, history, onClearHistory, onReadGallery, onRepairHistoryCover } = props;
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

  useEffect(() => {
    if (!adultConfirmed || mode === 'favorites' || mode === 'history' || (mode === 'search' && !submitted)) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setResult(null);
    void invoke<CatalogPage>('browse_nh_catalog', { mode, query: submitted, sort, page })
      .then(value => { if (!cancelled) setResult(value); })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [adultConfirmed, mode, submitted, sort, page, refresh]);

  const changeMode = (next: Mode) => { setMode(next); setPage(1); setDetail(null); setError(''); };
  const openDetail = useCallback(async (item: CatalogItem) => {
    setSelection(item); setDetail(null); setDetailError(''); setDetailLoading(true);
    try {
      const data = await invoke<GalleryDetail>('fetch_nh_gallery', { input: String(item.id) });
      setDetail(data);
      if (data.coverUrl) onRepairHistoryCover(data.id, data.coverUrl);
    } catch (err) { setDetailError(String(err)); }
    finally { setDetailLoading(false); }
  }, [onRepairHistoryCover]);
  const visibleItems = mode === 'favorites' ? favorites : mode === 'history' ? history.map(infoForRecord) : (result?.items ?? []);
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
      {(mode === 'latest' || mode === 'popular' || mode === 'search') && <button className="secondaryButton" disabled={loading} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={17}/> 重新整理</button>}
    </div>
    {mode === 'search' && <form className="urlbox" onSubmit={e => { e.preventDefault(); setPage(1); setSubmitted(searchText.trim()); }}>
      <Search size={18}/><input aria-label="搜尋標題或標籤" placeholder="搜尋標題、作者或標籤" value={searchText} onChange={e => setSearchText(e.target.value)}/>
      <button disabled={!searchText.trim() || loading}>搜尋</button>
    </form>}
    {mode === 'search' && <div className="catalogSort"><label>排序 <select value={sort} onChange={e => { setSort(e.target.value as Sort); setPage(1); }}>{sorting.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label></div>}
    {mode === 'popular' && <div className="notice"><Star size={18}/><div><b>今日熱門</b><p>使用來源 API 的熱門作品端點。若要搜尋「全部熱門／本週熱門」，請到搜尋頁選擇對應排序。</p></div></div>}
    {loading && <div className="catalogStatus"><LoaderCircle className="spin" size={24}/> 正在讀取作品資訊…</div>}
    {error && <div className="error"><strong>無法取得目錄</strong><p>{error}</p><small>遇到 403／429 不會自動重試。請遵守來源站的請求限制。</small></div>}
    {!loading && !error && visibleItems.length === 0 && <div className="empty"><BookOpen size={34}/><h2>{mode === 'search' && !submitted ? '輸入關鍵字開始搜尋' : '目前沒有作品'}</h2><p>{mode === 'favorites' ? '點選漫畫詳情中的收藏按鈕即可加入。' : mode === 'history' ? '開始閱讀後，作品會出現在這裡。' : '可嘗試其他搜尋關鍵字或稍後重新整理。'}</p></div>}
    <div className="catalogGrid">{visibleItems.map(item => <article key={item.id} className="catalogCard">
      <button className="catalogCardMain" onClick={() => void openDetail(item)} aria-label={`查看 ${item.title}`}>
        <div className="catalogCover"><BookOpen size={32}/>{showCovers && item.coverUrl && <img src={item.coverUrl} alt="作品封面" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }}/>}</div>
        <div className="catalogCardText"><strong>{item.title}</strong><small>#{item.id} · {item.pageCount || '—'} 頁</small>{mode === 'history' && <small><Clock3 size={12}/> 上次第 {history.find(r => r.id === item.id)?.page ?? 1} 頁</small>}{mode === 'history' && !item.coverUrl && <small>封面未儲存，點此更新資料</small>}</div>
      </button>
      <button className="catalogHeart" aria-label={favorites.some(f => f.id === item.id) ? '取消收藏' : '收藏'} onClick={() => onToggleFavorite(item)}><Heart size={18} fill={favorites.some(f => f.id === item.id) ? 'currentColor' : 'none'}/></button>
    </article>)}</div>
    {(mode === 'latest' || mode === 'search') && result && <div className="catalogPager">
      <button disabled={page <= 1 || loading} onClick={() => setPage(n => Math.max(1, n - 1))}><ChevronLeft size={18}/> 上一頁</button>
      <span>第 {page} 頁{result.totalPages ? ` / ${result.totalPages} 頁` : ''}</span>
      <button disabled={!result.hasNext || loading} onClick={() => setPage(n => n + 1)}>下一頁 <ChevronRight size={18}/></button>
    </div>}
    {selection && <div className="catalogModalShade" role="presentation" onClick={() => setSelection(null)}>
      <section className="catalogModal" role="dialog" aria-modal="true" aria-label="漫畫詳情" onClick={e => e.stopPropagation()}>
        <button className="catalogClose" onClick={() => setSelection(null)} aria-label="關閉">×</button>
        <div className="pill muted">GALLERY · {selection.id}</div><h2>{detail?.title || selection.title}</h2>
        <div className="catalogDetailRow"><div className="catalogDetailCover">{showCovers && (detail?.coverUrl || selection.coverUrl) ? <img src={(detail?.coverUrl || selection.coverUrl)!} alt="作品封面" referrerPolicy="no-referrer"/> : <BookOpen size={44}/>}</div>
          <div className="catalogDetailInfo"><p>頁數：{detail?.pageUrls.length ?? selection.pageCount ?? '—'}</p><p>作品 ID：{selection.id}</p>
            <div className="catalogTags">{(detail?.tags?.length ? detail.tags : selection.tags).map(tag => <span key={tag}>{tag}</span>)}</div>
            <button className="secondaryButton" onClick={() => onToggleFavorite(selection)}><Bookmark size={17}/> {selected ? '取消收藏' : '加入收藏'}</button>
            <button className="primary" disabled={!detail || detailLoading || detail.pageUrls.length === 0} onClick={() => { if (detail) { onReadGallery(detail); setSelection(null); } }}><BookOpen size={17}/> 在 MangaHub 閱讀</button>
          </div></div>
        {detailLoading && <p className="catalogStatus"><LoaderCircle className="spin" size={20}/> 載入作品詳情中…</p>}
        {detailError && <div className="error"><strong>作品詳情取得失敗</strong><p>{detailError}</p><button onClick={() => void openDetail(selection)}>重試</button></div>}
        <p className="detailNote">圖片僅在開啟閱讀器後載入。漫畫資料與圖片是否可取得取決於來源 API、CDN 及使用權限。</p>
      </section>
    </div>}
  </section>;
}
