import { useMemo, useState } from 'react';
import { BookOpen, Clock3, Heart, Library, Search, Trash2 } from 'lucide-react';
import type { CatalogItem, ReadingRecord } from './NhCatalog';
import type { RoumanChapter } from './RoumanSource';

type RoumanFav = { id: string; title: string; coverUrl: string | null; section: string };
type Progress = Record<string, {page:number;total:number;updatedAt:number}>;
type Source = 'all' | 'nh' | 'rouman';
function loadList<T>(key:string): T[] {
  try { const data: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(data) ? data as T[] : []; }
  catch { return []; }
}
export default function UnifiedShelf({ nhFavorites, nhHistory, roumanPages, onOpenNh, onOpenRouman, onShowRouman, onRemoveNh, onRemoveRouman }:{
  nhFavorites: CatalogItem[]; nhHistory: ReadingRecord[]; roumanPages: Progress;
  onOpenNh: (id:number)=>void; onOpenRouman: (url:string)=>void; onShowRouman:(id:string)=>void;
  onRemoveNh:(id:number)=>void; onRemoveRouman:(id:string)=>void;
}) {
  const [source,setSource]=useState<Source>('all');
  const [kind,setKind]=useState<'all'|'saved'|'recent'>('all');
  const [sort,setSort]=useState<'recent'|'title'>('recent');
  const [search,setSearch]=useState('');
  // The shelf is mounted when opened; read the same legacy keys as the source pages.
  // No migration and no destructive write are necessary.
  const [roumanFavorites]=useState(()=>loadList<RoumanFav>('mangahub-rouman-favorites-v059'));
  const [roumanHistory]=useState(()=>loadList<RoumanChapter>('mangahub-rouman-recent-v058'));
  type ShelfItem={ key:string; source:'nh'|'rouman'; id:string; title:string; cover:string|null; saved:boolean; time:number;
    description:string; open:()=>void; remove:()=>void };
  const items=useMemo(()=>{
    const map=new Map<string,ShelfItem>();
    for(const f of nhFavorites) map.set('nh:'+f.id,{
      key:'nh:'+f.id,source:'nh',id:String(f.id),title:f.title,cover:f.coverUrl??null,saved:true,time:0,
      description:'已收藏',open:()=>onOpenNh(f.id),remove:()=>onRemoveNh(f.id)
    });
    for(const r of nhHistory){const key='nh:'+r.id;const old=map.get(key);
      map.set(key,{key,source:'nh',id:String(r.id),title:r.title||old?.title||`#${r.id}`,
        cover:r.coverUrl??old?.cover??null,saved:!!old?.saved,time:r.updatedAt||0,
        description:`第 ${r.page||1} / ${r.total||'?'} 頁`,open:()=>onOpenNh(r.id),remove:()=>onRemoveNh(r.id) });}
    for(const f of roumanFavorites) map.set('rouman:'+f.id,{
      key:'rouman:'+f.id,source:'rouman',id:f.id,title:f.title,cover:f.coverUrl,saved:true,time:0,
      description:'已收藏',open:()=>onShowRouman(f.id),remove:()=>onRemoveRouman(f.id)
    });
    for(const r of roumanHistory){const key='rouman:'+r.bookId;const old=map.get(key);
      const record=roumanPages[`${r.bookId}:${r.chapterId||r.chapterIndex}`];
      map.set(key,{key,source:'rouman',id:r.bookId,title:r.bookTitle||old?.title||r.bookId,cover:old?.cover??null,
        saved:!!old?.saved,time:Math.max(r.visitedAt||0,record?.updatedAt||0),
        description:`${r.chapterTitle}${record?` · 第 ${record.page} / ${record.total} 頁`:''}`,
        open:()=>onOpenRouman(r.url),remove:()=>onRemoveRouman(r.bookId)
      });}
    const needle=search.trim().toLocaleLowerCase();
    return [...map.values()].filter(x=>(source==='all'||x.source===source) &&
      (kind==='all'||(kind==='saved'?x.saved:x.time>0)) && x.title.toLocaleLowerCase().includes(needle))
      .sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):(b.time-a.time||a.title.localeCompare(b.title)));
  },[nhFavorites,nhHistory,roumanFavorites,roumanHistory,roumanPages,onOpenNh,onOpenRouman,onShowRouman,onRemoveNh,onRemoveRouman,source,kind,sort,search]);
  return <section className="content shelfPage">
    <div className="pill">MANGAHUB · PERSONAL LIBRARY</div>
    <h1>我的<span>漫畫書架</span></h1>
    <p className="lead">nHentai 與 Rouman5 的收藏和閱讀紀錄集中管理。資料保留在本機，不會清除舊版紀錄。</p>
    <div className="shelfTools">
      <label><span>來源</span><select value={source} onChange={e=>setSource(e.target.value as Source)}><option value="all">全部來源</option><option value="nh">nHentai</option><option value="rouman">Rouman5</option></select></label>
      <label><span>類型</span><select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="all">全部</option><option value="saved">已收藏</option><option value="recent">最近閱讀</option></select></label>
      <label><span>排序</span><select value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="recent">最近閱讀</option><option value="title">標題 A–Z</option></select></label>
      <label className="shelfSearch"><Search size={16}/><input aria-label="搜尋書架" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜尋書架作品"/></label>
    </div>
    <p className="shelfCount">目前顯示 {items.length} 部作品</p>
    {items.length===0?<div className="shelfEmpty"><Library size={36}/><h2>目前沒有符合的作品</h2><p>前往漫畫探索加入收藏，或調整書架篩選條件。</p></div>:
      <div className="shelfGrid">{items.map(item=><article key={item.key} className="shelfCard">
        <button className="shelfCover" onClick={item.open} aria-label={`開啟 ${item.title}`}>
          {item.cover?<img src={item.cover} alt="" loading="lazy" onError={e=>{e.currentTarget.style.display='none';}}/>:<BookOpen size={32}/>}</button>
        <div className="shelfInfo"><span className="shelfSource">{item.source==='nh'?'nHentai':'Rouman5'} {item.saved?'· 已收藏':''}</span>
          <button className="shelfTitle" onClick={item.open}>{item.title}</button>
          <small>{item.time>0?<Clock3 size={13}/>:<Heart size={13}/>} {item.description}</small>
          <div className="shelfActions"><button onClick={item.open}> {item.time>0?'接續閱讀':'查看作品'} </button>
            {item.saved&&<button title="取消收藏" aria-label={`取消收藏 ${item.title}`} onClick={item.remove}><Trash2 size={16}/></button>}</div>
        </div></article>)}</div>}
  </section>;
}
