import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Download, HardDrive, RefreshCw, Trash2 } from 'lucide-react';

type CheckResult = { name: string; status: 'ok' | 'error'; summary: string; elapsedMs: number; checkedAt: string };
type CacheStats = { bytes: number; files: number; roumanBytes: number; nhentaiBytes: number };
type StorageReport = { key: string; items: number | null; present: boolean };
const storageKeys = [
  ['nHentai 收藏', 'mh-v05-nh-favorites'],
  ['nHentai 閱讀歷史', 'mh-v05-nh-history'],
  ['Rouman5 收藏', 'mangahub-rouman-favorites-v059'],
  ['Rouman5 閱讀進度', 'mangahub-rouman-page-progress-v062'],
  ['Rouman5 最近閱讀', 'mangahub-rouman-recent-v059'],
] as const;
const mb = (v: number) => `${(v / 1048576).toFixed(1)} MB`;
// Diagnostic exports intentionally contain only categories, counts, statuses and
// timings. Do not include source URLs, gallery titles, tokens or raw exceptions.
function safeError(value: unknown) {
  const message = String(value);
  const code = message.match(/\b(?:HTTP\s*)?(403|404|429|500|502|503|504)\b/i)?.[1];
  if (code) return `HTTP ${code}`;
  if (/timeout|timed out|逾時|超時/i.test(message)) return '連線逾時';
  if (/network|connect|dns|連線|網路/i.test(message)) return '網路連線異常';
  if (/目錄|HTML|格式|parse|解析|JSON/i.test(message)) return '來源資料格式可能已改變';
  if (/not found|unknown command|command .*not/i.test(message)) return '此版本缺少對應診斷指令';
  return '來源請求失敗（詳細內容不收集）';
}
function readStorage(): StorageReport[] {
  return storageKeys.map(([name, key]) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { key: name, present: false, items: 0 };
      const parsed: unknown = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed.length : parsed && typeof parsed === 'object' ? Object.keys(parsed).length : null;
      return { key: name, present: true, items };
    } catch { return { key: name, present: true, items: null }; }
  });
}

export default function Diagnostics() {
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [cacheError, setCacheError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [storage, setStorage] = useState<StorageReport[]>(() => readStorage());

  const refreshStorage = () => setStorage(readStorage());
  const refreshCache = async () => {
    setCacheBusy(true); setCacheError('');
    try { setCache(await invoke<CacheStats>('image_cache_stats')); }
    catch (error) { setCache(null); setCacheError(safeError(error)); }
    finally { setCacheBusy(false); }
  };
  const runCheck = async (name: string, command: string, args: Record<string, unknown>) => {
    const start = performance.now();
    const checkedAt = new Date().toISOString();
    try {
      const value = await invoke<unknown>(command, args);
      // Do not retain returned catalog items or their URLs.
      const valid = !!value && typeof value === 'object' && Array.isArray((value as { items?: unknown[]; books?: unknown[] }).items ?? (value as { books?: unknown[] }).books);
      return { name, status: valid ? 'ok' : 'error', summary: valid ? '來源清單回應正常' : '清單格式不符預期', elapsedMs: Math.round(performance.now() - start), checkedAt } as CheckResult;
    } catch (error) {
      return { name, status: 'error', summary: safeError(error), elapsedMs: Math.round(performance.now() - start), checkedAt } as CheckResult;
    }
  };
  const runAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Sequential, minimal public metadata requests; never submit account secrets.
      const results: CheckResult[] = [];
      results.push(await runCheck('nHentai 目錄', 'browse_nh_catalog', { mode: 'latest', query: '', sort: 'date', page: 1 }));
      setChecks([...results]);
      results.push(await runCheck('Rouman5 首頁', 'browse_rouman_catalog', { mode: 'home', page: 0 }));
      setChecks([...results]);
      await refreshCache();
      refreshStorage();
    } finally { setBusy(false); }
  };
  const clearCache = async () => {
    if (cacheBusy || !window.confirm('確定清除已下載的圖片快取？不會刪除收藏、閱讀紀錄或備份。')) return;
    setCacheBusy(true); setCacheError('');
    try { setCache(await invoke<CacheStats>('image_cache_clear')); }
    catch (error) { setCacheError(safeError(error)); }
    finally { setCacheBusy(false); }
  };
  const exportReport = async () => {
    const report = {
      schema: 'mangahub-diagnostics-v1',
      createdAt: new Date().toISOString(),
      appVersion: '0.7.1',
      platform: /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iOS' : 'desktop/other',
      checks,
      cache: cache ? { ...cache } : null,
      cacheStatus: cacheError || (cache ? 'ok' : 'not-checked'),
      storage,
    };
    const filename = `MangaHub-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(report, null, 2)], filename, { type: 'application/json' });
    if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try { await navigator.share({ files: [file], title: 'MangaHub 診斷報告' }); return; }
      catch { /* Fall back to ordinary download. */ }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="mh-diagnostics">
    <div className="mh-diag-heading"><div><p className="eyebrow">MANGAHUB / TROUBLESHOOTING</p><h2>來源與快取診斷</h2><p>所有測試均需手動啟動；不變更書架、Reader 或登入狀態。</p></div></div>
    <div className="mh-diag-card">
      <div className="mh-diag-card-head"><h3><Activity size={18}/> 來源連線</h3><button disabled={busy} onClick={() => void runAll()}><RefreshCw size={16}/>{busy ? '測試中…' : '執行來源測試'}</button></div>
      <p className="mh-diag-desc">依序請求 nHentai 目錄與 Rouman5 首頁。來源可能限流；請勿短時間內重複測試。</p>
      {checks.length === 0 ? <p className="mh-diag-muted">尚未執行測試</p> : checks.map(c => <div key={c.name} className="mh-diag-line"><span>{c.name}</span><span className={c.status === 'ok' ? 'mh-diag-ok' : 'mh-diag-error'}>{c.status === 'ok' ? '正常' : c.summary}</span><small>{c.elapsedMs} ms</small></div>)}
    </div>
    <div className="mh-diag-card">
      <div className="mh-diag-card-head"><h3><HardDrive size={18}/> 圖片磁碟快取</h3><div className="mh-diag-actions"><button disabled={cacheBusy} onClick={() => void refreshCache()}>重新整理</button><button disabled={cacheBusy} onClick={() => void clearCache()}><Trash2 size={15}/>清除快取</button></div></div>
      {cache ? <div className="mh-diag-stats"><span>已使用 <b>{mb(cache.bytes)}</b></span><span>圖片 <b>{cache.files} 張</b></span><span>Rouman5 <b>{mb(cache.roumanBytes)}</b></span><span>nHentai <b>{mb(cache.nhentaiBytes)}</b></span></div> : <p className="mh-diag-muted">尚未取得快取統計</p>}
      {cacheError && <p className="mh-diag-error">{cacheError}</p>}
    </div>
    <div className="mh-diag-card">
      <div className="mh-diag-card-head"><h3>本機紀錄檢查</h3><button onClick={refreshStorage}>重新統計</button></div>
      <p className="mh-diag-desc">只統計資料筆數，不讀取或匯出作品名稱及閱讀內容。</p>
      {storage.map(s => <div className="mh-diag-line" key={s.key}><span>{s.key}</span><span>{!s.present ? '無紀錄' : s.items === null ? '格式需檢查' : `${s.items} 筆`}</span></div>)}
    </div>
    <div className="mh-diag-card"><div className="mh-diag-card-head"><h3>分享診斷結果</h3><button onClick={() => void exportReport()}><Download size={16}/>匯出 JSON</button></div><p className="mh-diag-desc">報告只包含測試時間、成功／失敗、耗時、快取大小與資料數量；不包含 Token、Cookie、漫畫網址、作品標題或完整錯誤訊息。iOS 會優先開啟系統分享介面，Windows 則下載 JSON。</p></div>
  </section>;
}
