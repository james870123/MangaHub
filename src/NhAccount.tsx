import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Bookmark, KeyRound, LogOut, RefreshCw, MessageCircle, Shuffle, Shield, ExternalLink, CheckCircle, AlertTriangle } from 'lucide-react';

export type AccountItem = {id:number; title:string; coverUrl:string|null; pageCount:number; tags:string[]};
type Page = {items:AccountItem[];page:number;totalPages:number|null;hasNext:boolean};
type Session = {connected:boolean;displayName:string;credentialKind:string};
type Props = {
  onSyncFavorites: (items:AccountItem[])=>void;
  onRemoteFavorite: (id:number,add:boolean)=>void;
  onOpenGallery: (id:number)=>void;
  onBlacklistUpdated: (names:string[])=>void;
  selectedGalleryId?:number|null;
};
function apiMessage(error:unknown):string {return String(error).replace(/(Key|User)\s+[A-Za-z0-9_.-]{8,}/g,'[憑證已隱藏]');}
function itemsFromResponse(value:unknown): Record<string, unknown>[] {
  if(Array.isArray(value))return value.filter((x):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object');
  if(!value||typeof value!=='object')return [];
  const obj=value as Record<string,unknown>;
  for(const k of ['result','items','results','tags','comments','data']){
    if(Array.isArray(obj[k]))return (obj[k] as unknown[]).filter((x):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object');
  }
  return [];
}
function extractBlacklist(value:unknown) {
  return itemsFromResponse(value).flatMap(item=>{
    const name=[item.name,item.slug,item.label].find(v=>typeof v==='string');
    return typeof name==='string'?[name]:[];
  });
}
function commentText(item:Record<string,unknown>):string {
  for(const v of [item.content,item.body,item.text,item.message])if(typeof v==='string')return v.slice(0,3000);
  return '（API 未提供可辨識的留言文字）';
}
export default function NhAccount({onSyncFavorites,onRemoteFavorite,onOpenGallery,onBlacklistUpdated,selectedGalleryId}:Props){
 const [session,setSession]=useState<Session|null>(null);
 const [kind,setKind]=useState<'Key'|'User'>('Key');
 const [secret,setSecret]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [page,setPage]=useState(1);
 const [favoriteId,setFavoriteId]=useState('');
 const [favorites,setFavorites]=useState<Page|null>(null);
 const [blacklist,setBlacklist]=useState<string[]>([]);
 const [comments,setComments]=useState<Record<string,unknown>[]>([]);
 const [commentPage,setCommentPage]=useState(1);
 const [galleryId,setGalleryId]=useState(selectedGalleryId?String(selectedGalleryId):'');
 const [localBlocked,setLocalBlocked]=useState(()=>{
   try {const value=JSON.parse(localStorage.getItem('mh-v055-local-blacklist')||'[]') as unknown;
     return Array.isArray(value)?value.filter((x):x is string=>typeof x==='string').slice(0,100):[];
   } catch {return [] as string[];}
 });
 const [blockedText,setBlockedText]=useState('');
 useEffect(()=>{void invoke<Session>('nh_session').then(setSession).catch(()=>setSession({connected:false,displayName:'',credentialKind:''}));},[]);
 useEffect(()=>{if(selectedGalleryId)setGalleryId(String(selectedGalleryId));},[selectedGalleryId]);
 useEffect(()=>{localStorage.setItem('mh-v055-local-blacklist',JSON.stringify(localBlocked)); onBlacklistUpdated([...new Set([...localBlocked,...blacklist])]);},[localBlocked,blacklist,onBlacklistUpdated]);
 async function run(action:()=>Promise<void>) {setBusy(true);setMessage('');try{await action();}catch(e){setMessage(apiMessage(e));}finally{setBusy(false);}}
 async function connect(){await run(async()=>{
   const result=await invoke<Session>('nh_connect',{kind,secret});
   setSecret('');setSession(result);setMessage(`已連接：${result.displayName}`);
 });}
 async function disconnect(){await run(async()=>{
   await invoke('nh_disconnect');setSession({connected:false,displayName:'',credentialKind:''});setFavorites(null);setBlacklist([]);setMessage('已中斷帳號連線；本機收藏仍保留。');
 });}
 async function fetchFavorites(next:number,accumulate=false){await run(async()=>{
   const result=await invoke<Page>('nh_account_favorites',{page:next});
   setFavorites(result);setPage(next);
   if(accumulate)onSyncFavorites(result.items);
   setMessage(`取得第 ${next} 頁共 ${result.items.length} 部；官方收藏不會自動刪除本機獨有收藏。`);
 });}
 async function loadBlacklist(){await run(async()=>{
   // Paginated official blacklist: first page only, avoid burst requests.
   const result=await invoke<unknown>('nh_account_blacklist',{page:1});
   const names=extractBlacklist(result);setBlacklist(names);
   setMessage(`已讀取官方黑名單第 1 頁：${names.length} 個標籤。可另加本機黑名單。`);
 });}
 async function randomFavorite(){await run(async()=>{
   const id=await invoke<number>('nh_account_random_favorite');onOpenGallery(id);
   setMessage(`隨機收藏：#${id}`);
 });}
 async function mutateFavorite(id:number,add:boolean){await run(async()=>{
   await invoke('nh_toggle_remote_favorite',{galleryId:id,add});
   onRemoteFavorite(id,add);
   setFavorites(p=>p?{...p,items:add?p.items:p.items.filter(x=>x.id!==id)}:p);
   setMessage(add?'已在官方收藏中新增':'已從官方收藏移除');
 });}
 async function loadComments(next:number){await run(async()=>{
   const id=Number(galleryId);if(!Number.isSafeInteger(id)||id<1)throw new Error('請輸入有效 Gallery ID');
   const result=await invoke<unknown>('nh_gallery_comments',{galleryId:id,page:next});
   setComments(itemsFromResponse(result));setCommentPage(next);
   setMessage(`已讀取 #${id} 的第 ${next} 頁留言。發表需在原站完成 CAPTCHA／PoW。`);
 });}
 const connected=Boolean(session?.connected);
 return <section className="content accountPage">
  <div className="pill">NHENTAI ACCOUNT · v0.5.5</div>
  <h1>帳號<span>同步</span></h1>
  <p className="lead">以網站核發的 API Key 或 User Token 連接帳號。密鑰只存放在 Windows Credential Manager，不會記錄到瀏覽器儲存空間或 GitHub。</p>
  <div className="notice"><Shield size={20}/><div><b>安全與功能限制</b><p>網站的帳號密碼登入包含 CAPTCHA／PoW，這版不收集網站密碼，也不繞過驗證。API Key 可讀取官方收藏、黑名單；修改官方收藏需 User Token。評論可直接閱讀，發表請在原站操作。</p></div></div>
  {!connected?<div className="accountCard"><h3><KeyRound size={19}/> 連接現有帳號</h3>
    <label>憑證類型 <select value={kind} onChange={e=>setKind(e.target.value as 'Key'|'User')}><option value="Key">API Key（建議，較低權限）</option><option value="User">User Token（支援官方收藏修改）</option></select></label>
    <label>憑證 <input aria-label="API 金鑰或使用者 Token" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={e=>setSecret(e.target.value)} placeholder="只在此處輸入，不要貼到聊天或 GitHub"/></label>
    <div className="diagnosticActions"><button className="primary" disabled={busy||secret.trim().length<8} onClick={()=>void connect()}><KeyRound size={17}/> 驗證並安全連接</button><button className="secondaryButton" onClick={()=>void openUrl('https://nhentai.net/user/settings#apikeys')}><ExternalLink size={17}/> 到官方網站建立 API Key</button></div>
  </div>:<div className="accountCard"><h3><CheckCircle size={19}/> {session?.displayName}</h3><p className="detailNote">已連線 · {session?.credentialKind==='Key'?'API Key':'User Token'}</p><button className="secondaryButton" disabled={busy} onClick={()=>void disconnect()}><LogOut size={17}/> 中斷連線並刪除本機憑證</button></div>}
  {message&&<div className="notice"><AlertTriangle size={18}/><div>{message}</div></div>}
  {connected&&<>
   <div className="accountCard"><h3><Bookmark size={19}/> 官方收藏同步</h3><p className="detailNote">逐頁載入，手動匯入本機收藏；不會覆蓋或刪除原有書架。大量收藏請依網站限流逐頁操作。</p>
    <div className="diagnosticActions"><button className="secondaryButton" disabled={busy} onClick={()=>void fetchFavorites(page,false)}><RefreshCw size={16}/> 讀取第 {page} 頁</button><button className="primary" disabled={busy} onClick={()=>void fetchFavorites(page,true)}>匯入本機收藏</button><button className="secondaryButton" disabled={busy} onClick={()=>void randomFavorite()}><Shuffle size={16}/> 隨機收藏</button></div>
    {session?.credentialKind==='User'&&<div className="diagnosticActions"><input value={favoriteId} onChange={e=>setFavoriteId(e.target.value)} placeholder="輸入 Gallery ID 加入官方收藏" inputMode="numeric"/><button className="secondaryButton" disabled={busy||!/^\d+$/.test(favoriteId)||Number(favoriteId)<1} onClick={()=>void mutateFavorite(Number(favoriteId),true)}>加入官方收藏</button></div>}
    {favorites&&<><div className="accountList">{favorites.items.map(item=><div key={item.id} className="accountLine"><button onClick={()=>onOpenGallery(item.id)}>#{item.id} · {item.title}</button>{session?.credentialKind==='User'&&<button disabled={busy} onClick={()=>void mutateFavorite(item.id,false)}>取消官方收藏</button>}</div>)}</div><div className="diagnosticActions"><button className="secondaryButton" disabled={busy||page===1} onClick={()=>void fetchFavorites(page-1,false)}>上一頁</button><button className="secondaryButton" disabled={busy||!favorites.hasNext} onClick={()=>void fetchFavorites(page+1,false)}>下一頁</button></div></>}
   </div>
   <div className="accountCard"><h3><Shield size={19}/> 標籤黑名單</h3><p className="detailNote">從官方帳號讀取黑名單第 1 頁，加上本機自行輸入的標籤，套用於 MangaHub 探索列表；目前不向官方回寫黑名單。</p>
    <button className="secondaryButton" disabled={busy} onClick={()=>void loadBlacklist()}><RefreshCw size={16}/> 讀取官方黑名單</button>
    <div className="accountTags">{[...new Set([...blacklist,...localBlocked])].map(x=><span key={x}>{x}{localBlocked.includes(x)&&<button aria-label={'移除 '+x} onClick={()=>setLocalBlocked(p=>p.filter(t=>t!==x))}> ×</button>}</span>)}</div>
    <div className="diagnosticActions"><input placeholder="新增本機封鎖標籤" value={blockedText} onChange={e=>setBlockedText(e.target.value)}/><button className="secondaryButton" onClick={()=>{const text=blockedText.trim().slice(0,80);if(text&&!localBlocked.includes(text))setLocalBlocked(p=>[...p,text]);setBlockedText('');}}>加入</button></div>
   </div>
  </>}
  <div className="accountCard"><h3><MessageCircle size={19}/> 漫畫留言</h3><p className="detailNote">使用公開 API 讀取留言；發表、編輯與刪除留言須使用網站完整驗證流程，這版提供官方網頁入口。</p>
   <div className="diagnosticActions"><input aria-label="留言作品 ID" inputMode="numeric" placeholder="Gallery ID" value={galleryId} onChange={e=>setGalleryId(e.target.value)}/><button className="primary" disabled={busy} onClick={()=>void loadComments(1)}>讀取留言</button><button className="secondaryButton" disabled={!/^\d+$/.test(galleryId)} onClick={()=>void openUrl(`https://nhentai.net/g/${Number(galleryId)}/`)}><ExternalLink size={16}/> 在網站留言</button></div>
   <div className="accountList">{comments.map((item,index)=><article key={String(item.id??index)} className="accountComment"><strong>{String((item.user as Record<string,unknown>|undefined)?.username??item.username??'匿名')}</strong><p>{commentText(item)}</p></article>)}</div>
   {comments.length>0&&<div className="diagnosticActions"><button className="secondaryButton" disabled={busy||commentPage===1} onClick={()=>void loadComments(commentPage-1)}>上一頁</button><span>第 {commentPage} 頁</span><button className="secondaryButton" disabled={busy} onClick={()=>void loadComments(commentPage+1)}>下一頁</button></div>}
  </div>
 </section>;
}
