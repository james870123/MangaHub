import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Library, PanelLeftClose, PanelLeftOpen, Search, UserRound } from 'lucide-react';
import './style.css';
import Reader from './Reader';
import RoumanSource, { type RoumanChapter } from './RoumanSource';
import NhCatalog, { type CatalogItem, type GalleryDetail, type ReadingRecord } from './NhCatalog';
import NhAccount, { type AccountItem } from './NhAccount';
import UnifiedShelf from './UnifiedShelf';
import BackupSync, { type BackupData } from './BackupSync';

function useSaved<T>(key:string,initial:T):[T,React.Dispatch<React.SetStateAction<T>>]{
  const [value,setValue]=useState<T>(()=>{try {const raw=localStorage.getItem(key);return raw?JSON.parse(raw) as T:initial;}catch{return initial;}});
  useEffect(()=>{localStorage.setItem(key,JSON.stringify(value));},[key,value]);
  return [value,setValue];
}
type Tab='catalog'|'rouman'|'library'|'account'|'reader';
type RoumanProgress={page:number;total:number;updatedAt:number};
function App(){
  const [tab,setTab]=useState<Tab>('catalog');
  const [sidebarCollapsed,setSidebarCollapsed]=useSaved('mh-ui-sidebar-collapsed',false);
  const [adultConfirmed,setAdultConfirmed]=useSaved('mh-v05-adult-confirmed',false);
  const [showCovers,setShowCovers]=useSaved('mh-v05-show-covers',false);
  const [nhFavorites,setNhFavorites]=useSaved<CatalogItem[]>('mh-v05-nh-favorites',[]);
  const [nhHistory,setNhHistory]=useSaved<ReadingRecord[]>('mh-v05-nh-history',[]);
  const [roumanPages,setRoumanPages]=useSaved<Record<string,RoumanProgress>>('mangahub-rouman-page-progress-v062',{});
  const [blockedTags,setBlockedTags]=useState<string[]>(()=>{
    try{const data:unknown=JSON.parse(localStorage.getItem('mh-v055-local-blacklist')||'[]');return Array.isArray(data)?data.filter((x):x is string=>typeof x==='string'):[];}
    catch{return [];}
  });
  const [accountGalleryId,setAccountGalleryId]=useState<number|null>(null);
  const [readerUrls,setReaderUrls]=useState<string[]>([]);
  const [readerSession,setReaderSession]=useState(0);
  const [readerLeaving,setReaderLeaving]=useState(false);
  const [readerEntering,setReaderEntering]=useState(false);
  const returnTimer=useRef<number|null>(null);
  const [readerOrigin,setReaderOrigin]=useState<'catalog'|'rouman'|'account'|'library'|null>(null);
  const [currentGallery,setCurrentGallery]=useState<GalleryDetail|null>(null);
  const [roumanReading,setRoumanReading]=useState<RoumanChapter|null>(null);
  const catalogScroll=useRef(0);
  const originScroll=useRef(0);
  const roumanPageKey=(c:RoumanChapter)=>`${c.bookId}:${c.chapterId||c.chapterIndex}`;
  function showTab(next:Tab){if(next==='catalog'&&tab!=='reader')requestAnimationFrame(()=>window.scrollTo(0,catalogScroll.current));setTab(next);}
  function readImages(urls:string[],origin:'catalog'|'rouman'|'account'|'library',preserveOrigin=false){
    if(!preserveOrigin){
      originScroll.current=window.scrollY;
      if(origin==='catalog')catalogScroll.current=window.scrollY;
    }
    setReaderOrigin(origin);setReaderUrls(urls);setReaderSession(v=>v+1);setTab('reader');window.scrollTo(0,0);
  }
  function readRoumanChapter(c:RoumanChapter,origin:'rouman'|'library'='rouman',preserveOrigin=false){
    setCurrentGallery(null);setRoumanReading(c);readImages(c.pageUrls,origin,preserveOrigin);
  }
  async function navigateRoumanChapter(direction:-1|1){
    if(!roumanReading)return;
    const next=roumanReading.chapterIndex+direction;
    if(next<0 || next>=roumanReading.chapterCount)return;
    const url=`https://rouman5.com/books/${encodeURIComponent(roumanReading.bookId)}/${next}`;
    const chapter=await invoke<RoumanChapter>('inspect_rouman_chapter',{url});
    readRoumanChapter(chapter,readerOrigin==='library'?'library':'rouman',true);
  }
  function readNhGallery(g:GalleryDetail,origin:'catalog'|'account'|'rouman'|'library'='catalog'){
    setNhHistory(prev=>{const old=prev.find(r=>r.id===g.id);
      const r:ReadingRecord={id:g.id,title:g.title,coverUrl:g.coverUrl??old?.coverUrl??null,
        page:old?.page??1,total:g.pageUrls.length,updatedAt:Date.now()};
      return[r,...prev.filter(x=>x.id!==g.id)].slice(0,200);});
    setRoumanReading(null);setCurrentGallery(g);readImages(g.pageUrls,origin);
  }
  async function openNhId(id:number,origin:'rouman'|'account'|'library'){
    try{const g=await invoke<GalleryDetail>('fetch_nh_gallery',{input:String(id)});readNhGallery(g,origin);}
    catch(e){window.alert('無法載入作品：'+String(e));}
  }
  async function openRoumanUrl(url:string){
    try{const c=await invoke<RoumanChapter>('inspect_rouman_chapter',{url});readRoumanChapter(c,'library');}
    catch(e){window.alert('無法載入 Rouman5 章節：'+String(e));}
  }
  function openRoumanBook(id:string){
    setTab('rouman');
    window.dispatchEvent(new CustomEvent('mangahub-open-rouman-book',{detail:id}));
  }
  function removeRoumanFavorite(id:string){
    try{
      const key='mangahub-rouman-favorites-v059';
      const items=JSON.parse(localStorage.getItem(key)||'[]') as {id:string}[];
      const next=items.filter(x=>x.id!==id);
      localStorage.setItem(key,JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('mangahub-rouman-favorites-updated',{detail:next}));
      // Remount the shelf to refresh its own read-only snapshot.
      setShelfRevision(x=>x+1);
    }catch(e){window.alert('無法更新收藏：'+String(e));}
  }
  const [shelfRevision,setShelfRevision]=useState(0);
  const [roumanRevision,setRoumanRevision]=useState(0);
  function applyBackupImport(values:BackupData){
    const data=<T,>(key:string):T|undefined => values[key as keyof BackupData] as T|undefined;
    const f=data<CatalogItem[]>('mh-v05-nh-favorites');if(f)setNhFavorites(f);
    const h=data<ReadingRecord[]>('mh-v05-nh-history');if(h)setNhHistory(h);
    const p=data<Record<string,RoumanProgress>>('mangahub-rouman-page-progress-v062');if(p)setRoumanPages(p);
    const tags=data<string[]>('mh-v055-local-blacklist');if(tags)setBlockedTags(tags);
    // RoumanSource and UnifiedShelf have their own storage snapshots; remount
    // after the merge so they read the new local data without losing it.
    setRoumanRevision(x=>x+1);setShelfRevision(x=>x+1);
  }
  function returnFromReader(){
    if(readerLeaving)return;
    const dest=readerOrigin??'catalog';
    const y=dest==='catalog'?catalogScroll.current:originScroll.current;
    const finish=()=>{
      setReaderOrigin(null);setReaderLeaving(false);setTab(dest);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        window.scrollTo({top:y,behavior:'instant'});
        setReaderEntering(true);
        if(returnTimer.current!==null)window.clearTimeout(returnTimer.current);
        returnTimer.current=window.setTimeout(()=>setReaderEntering(false),260);
      }));
    };
    const mobile=window.matchMedia('(max-width:750px)').matches;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(!mobile||reduced){finish();return;}
    setReaderLeaving(true);
    returnTimer.current=window.setTimeout(finish,215);
  }
  useEffect(()=>()=>{if(returnTimer.current!==null)window.clearTimeout(returnTimer.current);},[]);
  useEffect(()=>{if(tab!=='reader'||!readerOrigin)return;
    const handler=(e:KeyboardEvent)=>{if(e.key==='Escape'||(e.altKey&&e.key==='ArrowLeft')){
      if(document.activeElement&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
      e.preventDefault();returnFromReader();}};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[tab,readerOrigin]);
  const toggleNhFavorite=(item:CatalogItem)=>setNhFavorites(prev=>prev.some(x=>x.id===item.id)?prev.filter(x=>x.id!==item.id):[item,...prev].slice(0,500));
  const repairHistoryCover=(id:number,coverUrl:string)=>{
    setNhHistory(prev=>prev.map(x=>x.id===id&&x.coverUrl!==coverUrl?{...x,coverUrl}:x));
    setNhFavorites(prev=>prev.map(x=>x.id===id&&x.coverUrl!==coverUrl?{...x,coverUrl}:x));
  };
  function syncOfficialFavorites(items:AccountItem[]){setNhFavorites(prev=>{
    const merged=new Map<number,CatalogItem>();for(const item of prev)merged.set(item.id,item);
    for(const item of items)merged.set(item.id,{id:item.id,title:item.title,coverUrl:item.coverUrl,pageCount:item.pageCount,tags:item.tags});
    return[...merged.values()].slice(0,2000);
  });}
  function handleRemoteFavorite(id:number,add:boolean){
    if(!add){setNhFavorites(p=>p.filter(x=>x.id!==id));return;}
    void invoke<GalleryDetail>('fetch_nh_gallery',{input:String(id)}).then(g=>setNhFavorites(p=>p.some(x=>x.id===id)?p:[{id,title:g.title,coverUrl:g.coverUrl??null,pageCount:g.pageUrls.length,tags:g.tags??[]},...p])).catch(()=>{});
  }
  const recordRoumanProgress=useCallback((page:number)=>{
    if(!roumanReading)return;const key=roumanPageKey(roumanReading),total=roumanReading.pageUrls.length;
    const safe=Math.max(1,Math.min(page,total));
    setRoumanPages(prev=>prev[key]?.page===safe&&prev[key]?.total===total?prev:{...prev,[key]:{page:safe,total,updatedAt:Date.now()}});
  },[roumanReading,setRoumanPages]);
  const recordNhProgress=useCallback((page:number)=>{
    if(!currentGallery)return;
    setNhHistory(prev=>prev.map(r=>r.id===currentGallery.id&&r.page!==page?{...r,page,updatedAt:Date.now()}:r));
  },[currentGallery,setNhHistory]);
  return <div className={`${sidebarCollapsed ? 'app sidebar-collapsed' : 'app'}${tab === 'reader' ? ' reader-active' : ''}${readerLeaving ? ' mh-reader-leaving' : ''}${readerEntering ? ' mh-reader-entering' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brandicon"><BookOpen size={22}/></div><div className="brandText"><strong>MangaHub</strong><small>YOUR READING SPACE</small></div></div>
      <button className="sidebarToggle" onClick={()=>setSidebarCollapsed(v=>!v)} title={sidebarCollapsed?'展開側邊欄':'收合側邊欄'}>{sidebarCollapsed?<PanelLeftOpen size={19}/>:<PanelLeftClose size={19}/>}<span>{sidebarCollapsed?'展開選單':'收合選單'}</span></button>
      <div className="sideTitle">漫畫空間</div>
      <button className={tab==='catalog'?'nav active':'nav'} onClick={()=>showTab('catalog')}><Search size={19}/><span className="navText">nHentai 探索</span></button>
      <button className={tab==='rouman'?'nav active':'nav'} onClick={()=>showTab('rouman')}><BookOpen size={19}/><span className="navText">Rouman5 探索</span></button>
      <button className={tab==='library'?'nav active':'nav'} onClick={()=>showTab('library')}><Library size={19}/><span className="navText">我的漫畫書架</span></button>
      <button className={tab==='account'?'nav active':'nav'} onClick={()=>showTab('account')}><UserRound size={19}/><span className="navText">帳號與同步</span></button>
      <div className="asideFoot"><span className="footText">v0.6.8 · Local-first</span></div>
    </aside>
    <main className="main"><header><span className="eyebrow">MangaHub / {tab==='catalog'?'nHentai':tab==='rouman'?'Rouman5':tab==='library'?'My Library':tab==='account'?'Account':'Reader'}</span><span className="status">● Local-first</span></header>
      <div className={tab==='catalog'?'catalogView':'catalogView is-hidden'}><NhCatalog adultConfirmed={adultConfirmed} showCovers={showCovers} onAdultChange={setAdultConfirmed} onCoversChange={setShowCovers} favorites={nhFavorites} onToggleFavorite={toggleNhFavorite} history={nhHistory} onClearHistory={()=>setNhHistory([])} onReadGallery={readNhGallery} onRepairHistoryCover={repairHistoryCover} blockedTags={blockedTags} onOpenComments={id=>{setAccountGalleryId(id);setTab('account');window.scrollTo(0,0);}}/></div>
      <div className={tab==='rouman'?'sourceView':'sourceView is-hidden'}><RoumanSource key={roumanRevision} active={tab==='rouman'} onRead={readRoumanChapter} nhHistory={nhHistory} onOpenNh={id=>void openNhId(id,'rouman')} pageProgress={roumanPages}/></div>
      {tab==='library'&&<><BackupSync onImported={applyBackupImport}/><UnifiedShelf key={shelfRevision} nhFavorites={nhFavorites} nhHistory={nhHistory} roumanPages={roumanPages} onOpenNh={id=>void openNhId(id,'library')} onOpenRouman={url=>void openRoumanUrl(url)} onShowRouman={openRoumanBook} onRemoveNh={id=>setNhFavorites(p=>p.filter(x=>x.id!==id))} onRemoveRouman={removeRoumanFavorite}/></>}
      {tab==='account'&&<NhAccount onSyncFavorites={syncOfficialFavorites} onRemoteFavorite={handleRemoteFavorite} onOpenGallery={id=>void openNhId(id,'account')} onBlacklistUpdated={setBlockedTags} selectedGalleryId={accountGalleryId}/>}
      {tab==='reader'&&<Reader key={readerSession} initialUrls={readerUrls} initialPage={roumanReading?roumanPages[roumanPageKey(roumanReading)]?.page??1:undefined} progressKey={roumanReading?`rouman:${roumanPageKey(roumanReading)}`:undefined} onProgress={currentGallery?recordNhProgress:roumanReading?recordRoumanProgress:undefined} galleryTitle={currentGallery?.title??(roumanReading?`${roumanReading.bookTitle} · ${roumanReading.chapterTitle}`:undefined)} onBack={readerOrigin?returnFromReader:undefined} backLabel="返回上一頁" chapterNavigation={roumanReading&&roumanReading.chapterCount>0?{index:roumanReading.chapterIndex,count:roumanReading.chapterCount,onNavigate:navigateRoumanChapter}:undefined}/>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
