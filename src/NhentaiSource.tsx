import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, LoaderCircle, Play, RefreshCw } from 'lucide-react';

type NhGallery = { id: number; title: string; pageUrls: string[] };

export default function NhentaiSource({ onRead }: { onRead: (urls: string[]) => void }) {
  const [input, setInput] = useState('');
  const [adult, setAdult] = useState(false);
  const [rights, setRights] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [gallery, setGallery] = useState<NhGallery | null>(null);
  async function inspect() {
    setError(''); setGallery(null); setLoading(true);
    try {
      setGallery(await invoke<NhGallery>('fetch_nh_gallery', { input: input.trim() }));
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  return <section className="content">
    <div className="pill">SOURCE ADAPTER · v0.4</div>
    <h1>Gallery <span>Reader</span></h1>
    <p className="lead">輸入 nhentai 作品網址或 Gallery ID，透過公開 v2 API 讀取作品標題及頁面路徑。內容可能僅適合成年人；請遵守來源網站規定與著作權限制。</p>
    <form className="urlbox" onSubmit={e => { e.preventDefault(); void inspect(); }}>
      <BookOpen size={20}/><input value={input} onChange={e => setInput(e.target.value)} placeholder="https://nhentai.net/g/123456/" aria-label="Gallery URL 或 ID"/>
      <button disabled={loading || !input.trim() || !adult}>{loading ? <LoaderCircle className="spin" size={17}/> : <RefreshCw size={17}/>} 取得資料</button>
    </form>
    <label className="cap-consent"><input type="checkbox" checked={adult} onChange={e => setAdult(e.target.checked)}/> 我已年滿 18 歲，並會遵守來源網站的年齡與存取規定</label>
    {error && <div className="error"><strong>取得作品失敗</strong><p>{error}</p></div>}
    {gallery && <div className="results">
      <div className="resultTop"><div><div className="pill muted">GALLERY · {gallery.id}</div><h2>{gallery.title}</h2><p>{gallery.pageUrls.length} 頁 · API 提供的圖片路徑</p></div></div>
      <div className="notice"><BookOpen size={20}/><div><b>獨立圖片閱讀測試</b><p>此功能不載入原站廣告。圖片是否可顯示仍取決於 CDN 的存取政策；遇到 403／429 不會繞過限制。</p></div></div>
      <label className="cap-consent"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)}/> 我確認有權存取並使用這些圖片進行個人閱讀</label>
      <div className="diagnosticActions"><button className="primary" disabled={!rights || gallery.pageUrls.length === 0} onClick={() => onRead(gallery.pageUrls)}><Play size={17}/> 在 MangaHub 閱讀 {gallery.pageUrls.length} 頁</button></div>
    </div>}
  </section>;
}
