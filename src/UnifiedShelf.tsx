import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Clock3, Heart, Library, Search, Trash2, RefreshCw, BellDot, CheckCheck } from 'lucide-react';
import type { CatalogItem, ReadingRecord } from './NhCatalog';
import type { RoumanChapter } from './RoumanSource';

type RoumanFav = { id: string; title: string; coverUrl: string | null; section: string };
type Progress = Record<string, {page:number;total:number;updatedAt:number}>;
type Source = 'all' | 'nh' | 'rouman';
type ChapterLink = { index:number; name:string; url:string };
type BookDetail = { id:string; title:string; chapters:ChapterLink[] };
type UpdateRecord = { chapterIndex:number; chapterCount:number; checkedAt:number; unseen:number; latestChapter:string };
type UpdateRecordMap = Record<string,UpdateRecord>;
const updateKey='mangahub-rouman-chapter-updates-v066';
const perCheckLimit=20;
function loadUpdates():UpdateRecordMap {
  try { const val:unknown=JSON.parse(localStorage.getItem(updateKey)||'{}'); return val && typeof val==='object' && !Array.isArray(val) ? val as UpdateRecordMap : {}; }
  catch { return {}; }
}
function newestChapter(chapters:ChapterLink[]):ChapterLink|undefined {
  return chapters.reduce<ChapterLink|undefined>((best, ch)=>!best||ch.index>best.index?ch:best,undefined);
}
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
  const [updates,setUpdates]=useState<UpdateRecordMap>(loadUpdates);
  const [updating,setUpdating]=useState(false);
  const [updateProgress,setUpdateProgress]=useState('');
  const [updateError,setUpdateError]=useState('');
  const [nextBatch,setNextBatch]=useState(0);
  const [onlyUpdates,setOnlyUpdates]=useState(false);
  const [failedIds,setFailedIds]=useState<string[]>([]);
  // The shelf is mounted when opened; read the same legacy keys as the source pages.
  // No migration and no destructive write are necessary.
  const [roumanFavorites]=useState(()=>loadList<RoumanFav>('mangahub-rouman-favorites-v059'));
  const [roumanHistory]=useState(()=>loadList<RoumanChapter>('mangahub-rouman-recent-v058'));
  function persistUpdates(next:UpdateRecordMap){setUpdates(next);localStorage.setItem(updateKey,JSON.stringify(next));}
  async function checkRoumanUpdates(){
    if(updating || roumanFavorites.length===0) return;
    setUpdating(true);setUpdateError('');setFailedIds([]);
    const targets=roumanFavorites.slice(nextBatch,nextBatch+perCheckLimit);
    const updated:UpdateRecordMap={...updates};
    const failed:string[]=[];
    let changed=0;
    for(let i=0;i<targets.length;i++){
      const book=targets[i];
      setUpdateProgress(`正在檢查 ${nextBatch+i+1}/${roumanFavorites.length}：${book.title}`);
      try {
        const detail=await invoke<BookDetail>('inspect_rouman_book',{bookId:book.id});
        const latest=newestChapter(detail.chapters);
        if(!latest) { failed.push(book.id); continue; }
        const prev=updated[book.id];
        // First check establishes a baseline; it must not mark old chapters as new.
        const increased=prev && latest.index>prev.chapterIndex ? latest.index-prev.chapterIndex : 0;
        if(increased>0) changed++;
        updated[book.id]={
          chapterIndex:Math.max(prev?.chapterIndex??-1,latest.index),
          chapterCount:detail.chapters.length,
          checkedAt:Date.now(),
          unseen:(prev?.unseen??0)+increased,
          latestChapter:latest.name,
        };
      }catch{failed.push(book.id);}
      // Persist partial progress so a canceled App session doesn't lose completed checks.
      localStorage.setItem(updateKey,JSON.stringify(updated));
    }
    persistUpdates(updated);
    setFailedIds(failed);
    const next=nextBatch+targets.length;
    setNextBatch(next>=roumanFavorites.length?0:next);
    setUpdateProgress(`已檢查 ${targets.length} 部；新增章節作品 ${changed} 部；失敗 ${failed.length} 部。${next<roumanFavorites.length?`下次從第 ${next+1} 部繼續。`:'全部批次已結束。'}`);
    setUpdating(false);
  }
  function markSeen(id:string){
    const prev=updates[id];if(!prev||!prev.unseen) return;
    persistUpdates({...updates,[id]:{...prev,unseen:0}});
  }
  type ShelfItem={ key:string; source:'nh'|'rouman'; id:string; title:string; cover:string|null; saved:boolean; time:number;
    description:string; open:()=>void; remove:()=>void; updates:number }; 
  const items=useMemo(()=>{
    const map=new Map<string,ShelfItem>();
    for(const f of nhFavorites) map.set('nh:'+f.id,{
      key:'nh:'+f.id,source:'nh',id:String(f.id),title:f.title,cover:f.coverUrl??null,saved:true,time:0,
      description:'已收藏',updates:0,open:()=>onOpenNh(f.id),remove:()=>onRemoveNh(f.id)
    });
    for(const r of nhHistory){const key='nh:'+r.id;const old=map.get(key);
      map.set(key,{key,source:'nh',id:String(r.id),title:r.title||old?.title||`#${r.id}`,
        cover:r.coverUrl??old?.cover??null,saved:!!old?.saved,time:r.updatedAt||0,
        description:`第 ${r.page||1} / ${r.total||'?'} 頁`,updates:0,open:()=>onOpenNh(r.id),remove:()=>onRemoveNh(r.id) });}
    for(const f of roumanFavorites) map.set('rouman:'+f.id,{
      key:'rouman:'+f.id,source:'rouman',id:f.id,title:f.title,cover:f.coverUrl,saved:true,time:0,
      description:'已收藏',updates:updates[f.id]?.unseen??0,open:()=>onShowRouman(f.id),remove:()=>onRemoveRouman(f.id)
    });
    for(const r of roumanHistory){const key='rouman:'+r.bookId;const old=map.get(key);
      const record=roumanPages[`${r.bookId}:${r.chapterId||r.chapterIndex}`];
      map.set(key,{key,source:'rouman',id:r.bookId,title:r.bookTitle||old?.title||r.bookId,cover:old?.cover??null,
        saved:!!old?.saved,time:Math.max(r.visitedAt||0,record?.updatedAt||0),
        description:`${r.chapterTitle}${record?` · 第 ${record.page} / ${record.total} 頁`:''}`,updates:updates[r.bookId]?.unseen??0,
        open:()=>onOpenRouman(r.url),remove:()=>onRemoveRouman(r.bookId)
      });}
    const needle=search.trim().toLocaleLowerCase();
    return [...map.values()].filter(x=>(source==='all'||x.source===source) &&
      (kind==='all'||(kind==='saved'?x.saved:x.time>0)) && (!onlyUpdates||x.updates>0) && x.title.toLocaleLowerCase().includes(needle))
      .sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):(b.time-a.time||a.title.localeCompare(b.title)));
  },[nhFavorites,nhHistory,roumanFavorites,roumanHistory,roumanPages,onOpenNh,onOpenRouman,onShowRouman,onRemoveNh,onRemoveRouman,source,kind,sort,search,updates,onlyUpdates]);
  return <section className="content shelfPage">
    <div className="pill">MANGAHUB · PERSONAL LIBRARY</div>
    <h1>我的<span>漫畫書架</span></h1>
    <p className="lead">nHentai 與 Rouman5 的收藏和閱讀紀錄集中管理。資料保留在本機，不會清除舊版紀錄。</p>
    <div className="shelfUpdatePanel">
      <div><strong><BellDot size={18}/> Rouman5 收藏更新檢查</strong>
        <p>僅在點擊時查詢公開作品詳情，每批最多 {perCheckLimit} 部。首次檢查會建立章節基準，不會將舊章節標成新上架。資料僅存於本機。</p>
        <small>Rouman5 已收藏 {roumanFavorites.length} 部 · 有未讀更新 {roumanFavorites.filter(f=>(updates[f.id]?.unseen??0)>0).length} 部</small></div>
      <div className="shelfUpdateActions">
        <button className="secondaryButton" disabled={updating||roumanFavorites.length===0} onClick={()=>void checkRoumanUpdates()}><RefreshCw size={15} className={updating?'spin':''}/>{updating?'檢查中…':nextBatch?'繼續下一批':'手動檢查新章節'}</button>
        <label><input type="checkbox" checked={onlyUpdates} onChange={e=>setOnlyUpdates(e.target.checked)}/> 只看有更新</label>
      </div>
      {updateProgress&&<p className="shelfUpdateStatus" role="status">{updateProgress}</p>}
      {updateError&&<p className="shelfUpdateStatus" role="alert">{updateError}</p>}
      {failedIds.length>0&&<p className="shelfUpdateStatus">{failedIds.length} 部作品檢查失敗，不會清除既有更新紀錄。</p>}
    </div>
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
          {item.updates>0&&<div className="shelfNewChapter"><BellDot size={14}/> NEW · 新增 {item.updates} 話 <button onClick={()=>{markSeen(item.id);onShowRouman(item.id);}} title="查看更新並清除 NEW 標記"><CheckCheck size={14}/> 查看</button></div>}
          <small>{item.time>0?<Clock3 size={13}/>:<Heart size={13}/>} {item.description}</small>
          <div className="shelfActions"><button onClick={item.open}> {item.time>0?'接續閱讀':'查看作品'} </button>
            {item.saved&&<button title="取消收藏" aria-label={`取消收藏 ${item.title}`} onClick={item.remove}><Trash2 size={16}/></button>}</div>
        </div></article>)}</div>}
  </section>;
}
