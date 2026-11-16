import { useMemo, useState } from 'react';
import { BookOpen, Image, Info, Play } from 'lucide-react';
import { SOURCE_MANIFESTS, checkDirectImageUrls } from './sourceCapabilities';
export default function SourceCapabilities({ onRead }: { onRead: (urls: string[]) => void }) {
  const [text, setText] = useState('');
  const [confirmRights, setConfirmRights] = useState(false);
  const checked = useMemo(() => checkDirectImageUrls(text), [text]);
  return <section className="content">
    <div className="pill">SOURCE CAPABILITIES · v0.3.3</div>
    <h1>來源<span>相容性</span></h1>
    <p className="lead">先辨識來源能提供的內容，再決定是否能直接閱讀。這裡不搜尋私有 API，也不下載、解密或重新組裝網站分段資料。</p>
    <div className="cap-grid">{SOURCE_MANIFESTS.map(source => <article className="cap-card" key={source.id}>
      <div className="cap-head">{source.chapterIndex ? <BookOpen size={20}/> : <Image size={20}/>}<strong>{source.name}</strong></div>
      <dl><div><dt>章節索引</dt><dd>{source.chapterIndex ? '支援' : '不適用'}</dd></div>
      <div><dt>圖片傳輸</dt><dd>{source.imageTransport === 'direct-https' ? '標準 HTTPS 圖片' : '原站專用流程'}</dd></div>
      <div><dt>公開圖片 API</dt><dd>{source.publicImageApi === 'unverified' ? '未確認' : source.publicImageApi === 'documented' ? '已確認' : '無需 API'}</dd></div></dl>
      <p>{source.notes}</p>
    </article>)}</div>
    <div className="notice"><Info size={20}/><div><b>直接圖片清單測試</b><p>每行貼上一個你有權存取的 HTTPS 圖片網址。這是使用者提供的資料，不會推測 ComicBox 的分段位址或繞過保護。</p></div></div>
    <textarea className="cap-textarea" value={text} onChange={e => setText(e.target.value)} rows={5} placeholder={'https://example.org/pages/001.jpg\nhttps://example.org/pages/002.webp'} aria-label="直接圖片網址清單"/>
    <p className="detailNote">可使用 {checked.urls.length} 張圖片{checked.errors.length ? `；${checked.errors.length} 筆網址未通過基本檢查` : ''}。副檔名檢查不代表圖片一定可公開讀取，實際載入錯誤會由 Reader 呈現。</p>
    {checked.errors.length > 0 && <div className="error"><strong>無法接受的網址</strong>{checked.errors.slice(0, 5).map((error: string, index: number) => <p key={index}>{error}</p>)}</div>}
    <label className="cap-consent"><input type="checkbox" checked={confirmRights} onChange={e => setConfirmRights(e.target.checked)}/> 我確認有權使用這些圖片網址</label>
    <div className="diagnosticActions"><button className="primary" disabled={!confirmRights || checked.urls.length === 0 || checked.errors.length > 0} onClick={() => onRead(checked.urls)}><Play size={17}/> 在 MangaHub 閱讀 {checked.urls.length} 張</button></div>
  </section>;
}
