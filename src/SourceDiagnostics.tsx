import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, AlertTriangle, CheckCircle2, LoaderCircle, Search } from 'lucide-react';

type Probe = {
  url: string; httpStatus: number; contentType: string; contentLength: number | null;
  corsHeader: string; detectedFormat: string; directlyRenderable: boolean;
  sampledBytes: number; explanation: string;
};

const example = 'https://bmigmi-global-wuwu.ccavbox.com/break_avif/static/upload/book/5687/42682/3066481.b_0?v=2026021808';

export default function SourceDiagnostics() {
  const [url, setUrl] = useState(example);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Probe | null>(null);
  const [error, setError] = useState('');
  async function run() {
    setLoading(true); setError(''); setResult(null);
    try { setResult(await invoke<Probe>('probe_comicbox_image', { url: url.trim() })); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  return <section className="content">
    <div className="pill">SOURCE COMPATIBILITY · v0.3.1</div>
    <h1>圖片來源<span>診斷</span></h1>
    <p className="lead">測試 ComicBox HAR 中的圖片資料網址：檢查 HTTP 狀態、Content-Type、CORS 回應標頭及前 64 bytes 的圖片格式特徵。不下載完整圖片、不解密、不保存原始資料。</p>
    <form className="urlbox" onSubmit={e => { e.preventDefault(); void run(); }}>
      <Activity size={20}/><input aria-label="圖片資料網址" value={url} onChange={e => setUrl(e.target.value)} />
      <button disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : <Search size={17}/>} 執行診斷</button>
    </form>
    {error && <div className="error"><strong>診斷失敗</strong><p>{error}</p></div>}
    {result && <div className="diagReport" aria-live="polite">
      <div className="diagVerdict">{result.directlyRenderable ? <CheckCircle2 color="#88d7ab"/> : <AlertTriangle color="#dba1ef"/>}
        <div><b>{result.directlyRenderable ? '辨識到標準圖片格式' : '不是可確認的標準圖片'}</b><p>{result.explanation}</p></div>
      </div>
      <dl>
        <div><dt>HTTP Status</dt><dd>{result.httpStatus}</dd></div>
        <div><dt>Content-Type</dt><dd>{result.contentType}</dd></div>
        <div><dt>Magic Bytes 判定</dt><dd>{result.detectedFormat}</dd></div>
        <div><dt>Content-Length</dt><dd>{result.contentLength == null ? '未提供' : `${result.contentLength.toLocaleString()} bytes（回應內容）`}</dd></div>
        <div><dt>Access-Control-Allow-Origin</dt><dd>{result.corsHeader}</dd></div>
        <div><dt>實際分析位元組</dt><dd>{result.sampledBytes} bytes</dd></div>
      </dl>
      <p className="detailNote">注意：CORS 回應標頭只是線索，不能單憑它判斷 Tauri WebView 必然能載入；辨識圖片格式也不代表內容可被授權重新使用。Range 請求可能被伺服器忽略。</p>
    </div>}
    <div className="notice"><AlertTriangle size={20}/><div><b>安全範圍</b><p>僅允許已知 ComicBox CDN 的 HTTPS 圖片路徑，不讀取 Cookie 或登入憑證，不使用代理、不自動重試 403、不處理加密圖片。此版本檢查的是單一 URL，而非自動搜尋網站 API。</p></div></div>
  </section>;
}
