import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, AlertTriangle, CheckCircle2, Download, LoaderCircle, Search } from 'lucide-react';

type Probe = {
  url: string; httpStatus: number; contentType: string; contentLength: number | null;
  contentRange: string; resourceSize: number | null; rangeHonored: boolean;
  corsHeader: string; detectedFormat: string; directlyRenderable: boolean;
  sampledBytes: number; explanation: string;
};
type PairProbe = {
  parts: Probe[]; sameContentType: boolean; bothRangeHonored: boolean;
  reportedTotalBytes: number | null; explanation: string;
};
const example = 'https://bmigmi-global-wuwu.ccavbox.com/break_avif/static/upload/book/5687/42682/3066481.b_0?v=2026021808';

function fmt(value: number | null) {
  return value == null ? '未提供' : `${value.toLocaleString()} bytes`;
}
function ResultCard({ result }: { result: Probe }) {
  return <div className="diagReport" aria-live="polite">
    <div className="diagVerdict">{result.directlyRenderable ? <CheckCircle2 color="#88d7ab" /> : <AlertTriangle color="#dba1ef" />}
      <div><b>{result.directlyRenderable ? '辨識到標準圖片簽名' : '尚未辨識為標準圖片'}</b>
        <p>{result.explanation}</p></div>
    </div>
    <p className="detailNote" style={{overflowWrap:'anywhere'}}>{result.url}</p>
    <dl>
      <div><dt>HTTP Status</dt><dd>{result.httpStatus}</dd></div>
      <div><dt>Content-Type</dt><dd>{result.contentType}</dd></div>
      <div><dt>Magic Bytes</dt><dd>{result.detectedFormat}</dd></div>
      <div><dt>Content-Length（本次回應）</dt><dd>{fmt(result.contentLength)}</dd></div>
      <div><dt>Content-Range</dt><dd>{result.contentRange}</dd></div>
      <div><dt>完整分段大小（由 Range 推算）</dt><dd>{fmt(result.resourceSize)}</dd></div>
      <div><dt>Range 是否依要求回傳</dt><dd>{result.rangeHonored ? '是（206 + Content-Range）' : '未確認'}</dd></div>
      <div><dt>Access-Control-Allow-Origin</dt><dd>{result.corsHeader}</dd></div>
      <div><dt>實際分析位元組</dt><dd>{fmt(result.sampledBytes)}</dd></div>
    </dl>
  </div>;
}

export default function SourceDiagnostics() {
  const [url, setUrl] = useState(example);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Probe | null>(null);
  const [pair, setPair] = useState<PairProbe | null>(null);
  const [error, setError] = useState('');
  async function run(mode: 'single' | 'pair') {
    setLoading(true); setError(''); setResult(null); setPair(null);
    try {
      if (mode === 'pair') setPair(await invoke<PairProbe>('probe_comicbox_pair', { url: url.trim() }));
      else setResult(await invoke<Probe>('probe_comicbox_image', { url: url.trim() }));
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  function exportJson() {
    const data = pair ? { schemaVersion: '0.3.2', mode: 'pair', ...pair } :
      { schemaVersion: '0.3.2', mode: 'single', result };
    // Do not export URL query strings, as they can contain tokens on other sources.
    const serialized = JSON.stringify(data, (_key, value: unknown) => {
      if (_key === 'url' && typeof value === 'string') {
        try { const u = new URL(value); u.search = ''; return u.toString(); } catch { return value; }
      }
      return value;
    }, 2);
    const blob = new Blob([serialized], {type:'application/json'});
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl; link.download = 'mangahub-source-report-v0.3.2.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return <section className="content">
    <div className="pill">SOURCE COMPATIBILITY · v0.3.2</div>
    <h1>圖片來源<span>診斷</span></h1>
    <p className="lead">比較 ComicBox 的單一分段或 .b_0／.b_1：分析 HTTP、Content-Range、CORS 和前 64 bytes。只讀取少量資料，不下載完整圖片、不解密、不儲存原始資料。</p>
    <form className="urlbox" onSubmit={e => {e.preventDefault(); void run('single');}}>
      <Activity size={20}/><input aria-label="圖片資料網址" value={url} onChange={e => setUrl(e.target.value)} />
      <button disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : <Search size={17}/>} 單一診斷</button>
    </form>
    <div style={{display:'flex', gap:12, flexWrap:'wrap', margin:'12px 0 24px'}}>
      <button type="button" disabled={loading} onClick={() => void run('pair')}>比較 b_0／b_1</button>
      {(pair || result) && <button type="button" onClick={exportJson}><Download size={16}/> 匯出 JSON 報告</button>}
    </div>
    {error && <div className="error"><strong>診斷失敗</strong><p>{error}</p></div>}
    {result && <ResultCard result={result}/>}
    {pair && <>
      <div className="diagReport"><b>雙分段診斷摘要</b><dl>
        <div><dt>資料型別是否相同</dt><dd>{pair.sameContentType ? '是' : '否'}</dd></div>
        <div><dt>兩段是否都支援 Range</dt><dd>{pair.bothRangeHonored ? '是' : '否／未確認'}</dd></div>
        <div><dt>兩個分段宣告大小加總</dt><dd>{fmt(pair.reportedTotalBytes)}</dd></div>
      </dl><p className="detailNote">{pair.explanation} 加總值並非解碼後的圖片大小。</p></div>
      {pair.parts.map((item, i) => <div key={item.url}><h2>分段 {i === 0 ? 'b_0' : 'b_1'}</h2><ResultCard result={item}/></div>)}
    </>}
    <div className="notice"><AlertTriangle size={20}/><div><b>診斷邊界</b><p>僅支援已知 ComicBox CDN HTTPS 路徑。每次比較最多發出兩個小型 Range 請求，不讀取帳號憑證、不重試 403、不下載、合併或解密完整圖片。請勿將可能含個人識別資訊的網址直接公開。</p></div></div>
  </section>;
}
