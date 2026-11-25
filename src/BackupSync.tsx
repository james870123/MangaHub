import { useRef, useState } from 'react';
import { Download, FileUp, ShieldCheck, RefreshCw } from 'lucide-react';

// Portable, explicitly whitelisted local-only records. Never export auth tokens,
// cookies, cached image bytes/URLs, or arbitrary localStorage entries.
const keys = [
  'mh-v05-nh-favorites',
  'mh-v05-nh-history',
  'mangahub-rouman-favorites-v059',
  'mangahub-rouman-recent-v058',
  'mangahub-rouman-page-progress-v062',
  'mangahub-rouman-chapter-updates-v066',
  'mh-v03-reading-progress',
  'mh-v055-local-blacklist',
] as const;
type BackupKey = typeof keys[number];
export type BackupData = Partial<Record<BackupKey, unknown>>;
type PortableBackup = { format: 'mangahub-backup'; schema: 1; exportedAt: string; data: BackupData };
type Group = { label:string; key:BackupKey; kind:'array'|'map'|'strings' };
const groups:Group[] = [
  {key:keys[0],label:'nHentai 收藏',kind:'array'},
  {key:keys[1],label:'nHentai 閱讀紀錄',kind:'array'},
  {key:keys[2],label:'Rouman5 收藏',kind:'array'},
  {key:keys[3],label:'Rouman5 最近章節',kind:'array'},
  {key:keys[4],label:'Rouman5 章節頁數',kind:'map'},
  {key:keys[5],label:'Rouman5 章節更新狀態',kind:'map'},
  {key:keys[6],label:'閱讀器歷史頁數',kind:'map'},
  {key:keys[7],label:'本機黑名單標籤',kind:'strings'},
];
const isRecord = (v:unknown):v is Record<string,unknown> => Boolean(v) && typeof v==='object' && !Array.isArray(v);
const validNumber = (v:unknown) => typeof v==='number' && Number.isFinite(v) && v>=0;
const toTime = (v:unknown):number => isRecord(v) ? (validNumber(v.updatedAt)?v.updatedAt as number:validNumber(v.visitedAt)?v.visitedAt as number:0) : 0;
function readLocal(key:BackupKey):unknown {
  try { const text=localStorage.getItem(key);return text===null?undefined:JSON.parse(text) as unknown; }
  catch{return undefined;}
}
function itemId(v:unknown,key:BackupKey):string|null {
  if(!isRecord(v))return null;
  // A Rouman recent chapter is keyed by chapter, not by its ephemeral CDN URLs.
  if(key==='mangahub-rouman-recent-v058') {
    if(typeof v.bookId!=='string'||!v.bookId)return null;
    return `${v.bookId}:${typeof v.chapterId==='string'&&v.chapterId?v.chapterId:String(v.chapterIndex??'')}`;
  }
  const id=v.id;
  return (typeof id==='string'&&id.length>0&&id.length<=100)||(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)?String(id):null;
}
function safeGroupValue(group:Group,value:unknown):unknown {
  if(group.kind==='strings'){
    if(!Array.isArray(value))throw new Error(`${group.label} 的資料格式不正確`);
    return [...new Set(value.filter((x):x is string=>typeof x==='string'&&x.length<=150))].slice(0,1000);
  }
  if(group.kind==='array'){
    if(!Array.isArray(value))throw new Error(`${group.label} 的資料格式不正確`);
    return value.filter(v=>itemId(v,group.key)!==null).map(v=>{
      const obj={...(v as Record<string,unknown>)};
      // Don't move whole-chapter remote image URLs between devices.
      if(group.key==='mangahub-rouman-recent-v058')delete obj.pageUrls;
      return obj;
    }).slice(0,5000);
  }
  if(!isRecord(value))throw new Error(`${group.label} 的資料格式不正確`);
  const result:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
  for(const [id,rec] of Object.entries(value).slice(0,10000)){
    if(id==='__proto__'||id==='constructor'||id==='prototype'||id.length>180)continue;
    if(!isRecord(rec))continue;
    if(group.key==='mangahub-rouman-page-progress-v062'){
      if(!validNumber(rec.page)||!validNumber(rec.total))continue;
    }
    result[id]=rec;
  }
  return result;
}
function safeData(value:unknown):BackupData {
  if(!isRecord(value))throw new Error('備份 data 欄位不正確');
  const output:BackupData={};
  for(const group of groups){if(Object.prototype.hasOwnProperty.call(value,group.key))output[group.key]=safeGroupValue(group,value[group.key]);}
  if(Object.keys(output).length===0)throw new Error('備份沒有可匯入的 MangaHub 紀錄');
  return output;
}
function count(v:unknown):number {return Array.isArray(v)?v.length:isRecord(v)?Object.keys(v).length:0;}
function mergeGroup(group:Group,localValue:unknown,incomingValue:unknown):unknown{
  const incoming=safeGroupValue(group,incomingValue);
  if(group.kind==='strings')return [...new Set([...(Array.isArray(localValue)?localValue:[]),...(incoming as string[])])];
  if(group.kind==='array'){
    const merged=new Map<string,unknown>();
    for(const x of Array.isArray(localValue)?localValue:[]){const id=itemId(x,group.key);if(id)merged.set(id,x);}
    for(const x of incoming as unknown[]){
      const id=itemId(x,group.key);if(!id)continue;
      const old=merged.get(id);
      // Newer wins. When timestamps are missing/tied, keep the device's local entry.
      if(!old || toTime(x)>toTime(old))merged.set(id,x);
    }
    return [...merged.values()];
  }
  const merged:Record<string,unknown>={...(isRecord(localValue)?localValue:{})};
  for(const [id,item] of Object.entries(incoming as Record<string,unknown>)){
    const old=merged[id];
    const timeField=group.key==='mangahub-rouman-chapter-updates-v066'?'checkedAt':'updatedAt';
    const stamp=(v:unknown)=>isRecord(v)&&validNumber(v[timeField])?v[timeField] as number:0;
    if(!old||stamp(item)>stamp(old)){
      if(group.key==='mangahub-rouman-chapter-updates-v066'&&isRecord(item)&&isRecord(old)) {
        merged[id]={...item,unseen:Math.max(Number(item.unseen)||0,Number(old.unseen)||0)};
      }else merged[id]=item;
    }
  }
  return merged;
}
function mergeAll(imported:BackupData):BackupData{
  const output:BackupData={};
  for(const group of groups){
    if(Object.prototype.hasOwnProperty.call(imported,group.key)){
      const old=readLocal(group.key);
      output[group.key]=mergeGroup(group,old,imported[group.key]);
    }
  }
  return output;
}
export default function BackupSync({onImported}:{onImported:(values:BackupData)=>void}){
  const fileInput=useRef<HTMLInputElement>(null);
  const [pending,setPending]=useState<PortableBackup|null>(null);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  async function exportBackup(){
    setError('');setMessage('');
    try{
      const raw:Record<string,unknown>={};
      for(const group of groups){const v=readLocal(group.key);if(v!==undefined)raw[group.key]=v;}
      const backup:PortableBackup={format:'mangahub-backup',schema:1,exportedAt:new Date().toISOString(),data:safeData(raw)};
      const json=JSON.stringify(backup,null,2);
      const name=`MangaHub-backup-${new Date().toISOString().slice(0,10)}.json`;
      const file=new File([json],name,{type:'application/json'});
      // iOS share sheet is more dependable than downloading blob URLs in WKWebView.
      if(typeof navigator.share==='function' && (!navigator.canShare || navigator.canShare({files:[file]}))){
        try{await navigator.share({files:[file],title:'MangaHub 資料備份'});setMessage('已開啟系統分享／儲存介面。');return;}
        catch(e){if(isRecord(e)&&e.name==='AbortError')return;}
      }
      const url=URL.createObjectURL(file);
      const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),30000);
      setMessage('已要求儲存 JSON 備份；請確認檔案成功儲存。');
    }catch(e){setError(`匯出失敗：${String(e)}`);}
  }
  async function selectFile(file:File|undefined){
    setError('');setMessage('');setPending(null);
    if(!file)return;
    if(file.size>2_000_000){setError('備份檔超過 2 MB，請檢查是否選錯檔案。');return;}
    try{
      const v:unknown=JSON.parse(await file.text());
      if(!isRecord(v)||v.format!=='mangahub-backup'||v.schema!==1||typeof v.exportedAt!=='string')throw new Error('不是支援的 MangaHub v1 備份檔');
      const data=safeData(v.data);
      setPending({format:'mangahub-backup',schema:1,exportedAt:v.exportedAt,data});
    }catch(e){setError(`無法讀取備份：${String(e)}`);}
  }
  function applyImport(){
    if(!pending||busy)return;
    setBusy(true);setError('');
    try{
      const merged=mergeAll(pending.data);
      // Preflight serialization before any writes.
      const changes=Object.entries(merged).map(([key,v])=>[key,JSON.stringify(v)] as const);
      for(const [key,json] of changes)if(json.length>3_000_000)throw new Error(`${key} 合併後過大`);
      // Restore original values if browser storage is full part-way through import.
      const previous=changes.map(([key])=>[key,localStorage.getItem(key)] as const);
      try{for(const [key,json] of changes)localStorage.setItem(key,json);}
      catch(e){for(const [key,old] of previous){try{if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);}catch{/* best effort rollback */}}throw e;}
      onImported(merged);
      setPending(null);setMessage(`已合併 ${changes.length} 類資料。舊有紀錄已保留；建議重新開啟 App 核對。`);
    }catch(e){setError(`匯入失敗：${String(e)}`);}
    finally{setBusy(false);}
  }
  return <section className="mh-backup-panel">
    <div className="mh-backup-heading"><ShieldCheck size={20}/><div><h2>跨裝置資料備份</h2><p>Windows / iPhone 共用 JSON 格式 · 手動備份與合併</p></div></div>
    <p>備份收藏、最近閱讀、章節頁數及新章節檢查狀態。<b>不包含密鑰、圖片快取、Cookie 或圖片內容。</b></p>
    <div className="mh-backup-actions">
      <button type="button" onClick={()=>void exportBackup()}><Download size={16}/> 匯出備份 JSON</button>
      <button type="button" onClick={()=>fileInput.current?.click()}><FileUp size={16}/> 選擇 JSON 匯入</button>
      <input aria-label="選擇 MangaHub 備份檔" ref={fileInput} type="file" accept=".json,application/json" hidden onChange={e=>{void selectFile(e.target.files?.[0]);e.currentTarget.value='';}}/>
    </div>
    {pending&&<div className="mh-backup-preview">
      <strong>匯入預覽 · {pending.exportedAt.slice(0,10)}</strong>
      <p>採合併模式：相同作品依較新的更新時間選擇；同時間則保留本機資料。沒有出現在備份的類別不會刪除。</p>
      <div className="mh-backup-grid">{groups.filter(g=>Object.prototype.hasOwnProperty.call(pending.data,g.key)).map(g=><div key={g.key}><span>{g.label}</span><b>{count(readLocal(g.key))} → {count(mergeGroup(g,readLocal(g.key),pending.data[g.key]))}</b></div>)}</div>
      <div className="mh-backup-actions"><button type="button" disabled={busy} onClick={applyImport}><RefreshCw size={16}/> 確認合併匯入</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>取消</button></div>
    </div>}
    {error&&<p className="mh-backup-error" role="alert">{error}</p>}
    {message&&<p className="mh-backup-success" role="status">{message}</p>}
  </section>;
}
