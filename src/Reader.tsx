import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, ImagePlus, RotateCcw, Trash2, ZoomOut } from 'lucide-react';
import { drawRoumanImage, needsRoumanStripRepair } from './roumanStripRepair';

type ReadingMode = 'vertical' | 'ltr' | 'rtl';
type PageStatus = 'idle' | 'loading' | 'ready' | 'failed';
type PageSource = { url: string; label: string };
const STORAGE_URLS = 'mh-image-urls';
const STORAGE_MODE = 'mh-v03-mode';
const STORAGE_PROGRESS = 'mh-v03-reading-progress';
const safeRead = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const isSupportedHttps = (s: string) => {
  try { const url = new URL(s); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
};
const hashList = (urls: string[]) => {
  // Stable, non-secret library key; don't store credentials or page data.
  let result = 2166136261;
  for (const char of urls.join('\n')) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return `remote-${(result >>> 0).toString(16)}`;
};

// Only nearby images stay mounted. Layout dimensions are kept independently of
// the decoded image so recycling a page does not collapse the scroll position.
const knownPageSizes = new Map<string, { width: number; height: number }>();
const READER_PREFETCH_MARGIN = '1400px 0px 1400px 0px';

function ReaderImage({ src, index, eager }: { src: string; index: number; eager: boolean }) {
  const node = useRef<HTMLDivElement>(null);
  const canvasNode = useRef<HTMLCanvasElement | null>(null);
  // Release the backing bitmap as soon as a recycled page's canvas unmounts.
  const attachCanvas = useCallback((next: HTMLCanvasElement | null) => {
    if (!next && canvasNode.current) {
      canvasNode.current.width = 0;
      canvasNode.current.height = 0;
    }
    canvasNode.current = next;
  }, []);
  const repairStrips = needsRoumanStripRepair(src);
  const [state, setState] = useState<PageStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(eager);
  const [size, setSize] = useState(() => knownPageSizes.get(src));

  useEffect(() => {
    setState('idle');
    setAttempt(0);
    setSize(knownPageSizes.get(src));
    setActive(eager);
  }, [src, eager]);

  useEffect(() => {
    const target = node.current;
    if (!target || eager) { setActive(true); return; }
    if (!('IntersectionObserver' in window)) { setActive(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      // Returning false removes the <img> and the decoded Canvas backing store.
      setActive(entry.isIntersecting);
    }, { rootMargin: READER_PREFETCH_MARGIN, threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [src, eager]);

  useEffect(() => { if (!active) setState('idle'); }, [active]);

  const handleLoad = (image: HTMLImageElement) => {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) { setState('failed'); return; }
    const dimensions = { width, height };
    knownPageSizes.set(src, dimensions);
    if (knownPageSizes.size > 1200) knownPageSizes.delete(knownPageSizes.keys().next().value!);
    setSize(dimensions);
    if (repairStrips) {
      try {
        if (!canvasNode.current) throw new Error('Canvas missing');
        drawRoumanImage(image, canvasNode.current, src);
      } catch { setState('failed'); return; }
    }
    setState('ready');
  };

  // For recycled pages use their natural aspect ratio instead of an empty
  // fixed-height slot; this keeps scroll offset and saved page numbers stable.
  const placeholderStyle: React.CSSProperties | undefined = !active
    ? (size ? { aspectRatio: `${size.width} / ${size.height}` } : { minHeight: 420 })
    : undefined;

  return <div className="mh-image-slot" ref={node} data-page={index + 1} style={placeholderStyle}>
    {active ? <>
      <img key={`${src}-${attempt}`} src={src} loading="eager" decoding="async"
        referrerPolicy="no-referrer" alt={`漫畫第 ${index + 1} 頁`}
        // Preserve the original image's layout height; Rouman5's repaired
        // canvas overlays it without altering the verified strip algorithm.
        style={repairStrips ? { visibility: 'hidden' } : undefined}
        onLoad={event => handleLoad(event.currentTarget)}
        onError={() => setState('failed')}/>
      {repairStrips && <canvas ref={attachCanvas} aria-label={`漫畫第 ${index + 1} 頁`}
        role="img" style={{ position: 'absolute', inset: 0, display: state === 'ready' ? 'block' : 'none', width: '100%', height: '100%' }}/>} 
    </> : <div className="mh-placeholder mh-recycled-placeholder">第 {index + 1} 頁 · 捲動時載入</div>}
    {active && state === 'failed' && <div className="mh-load-error"><AlertCircle size={19}/><strong>第 {index + 1} 頁載入失敗</strong><small>可能是網路暫時中斷、來源限制或圖片格式問題。</small><button onClick={() => { setState('loading'); setAttempt(n => n + 1); }}><RotateCcw size={15}/> 重試</button></div>}
  </div>;
}

export default function Reader({ initialUrls, initialPage, progressKey, onProgress, onBack, backLabel, galleryTitle }: { initialUrls?: string[]; initialPage?: number; progressKey?: string; onProgress?: (page: number) => void; onBack?: () => void; backLabel?: string; galleryTitle?: string }) {
  // Freeze restore target for this Reader mount; progress changes must not restart restore.
  const resumePage = useRef(initialPage).current;
  const [imageText, setImageText] = useState(() => initialUrls?.join('\n') ?? safeRead(STORAGE_URLS, ''));
  const [mode, setMode] = useState<ReadingMode>(() => {
    const value = safeRead(STORAGE_MODE, 'vertical');
    return value === 'ltr' || value === 'rtl' ? value : 'vertical';
  });
  const [localPages, setLocalPages] = useState<PageSource[]>([]);
  const localUrls = useRef<string[]>([]);
  const [page, setPage] = useState(() => Math.max(0, (resumePage ?? 1) - 1));
  const [zoom, setZoom] = useState(100);
  const [scrollPage, setScrollPage] = useState(() => Math.max(0, (resumePage ?? 1) - 1));
  const restoring = useRef(false);
  const restoreTimer = useRef<number | null>(null);
  const scrollRaf = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const remoteUrls = useMemo(() => imageText.split(/\r?\n/).map(x => x.trim()).filter(Boolean), [imageText]);
  const invalidUrls = useMemo(() => remoteUrls.filter(x => !isSupportedHttps(x)), [remoteUrls]);
  const validUrls = useMemo(() => remoteUrls.filter(isSupportedHttps), [remoteUrls]);
  const sources = useMemo<PageSource[]>(() => [...localPages, ...validUrls.map((url, i) => ({url, label: `網址圖片 ${i + 1}`}))], [localPages, validUrls]);
  // Rouman5 chapter identity stays stable even if signed CDN URLs change.
  const sessionKey = localPages.length ? '' : (progressKey || hashList(validUrls));
  const lastKey = useRef('');
  useEffect(() => { try { localStorage.setItem(STORAGE_URLS, imageText); } catch { /* storage disabled */ } }, [imageText]);
  useEffect(() => { try { localStorage.setItem(STORAGE_MODE, mode); } catch { /* storage disabled */ } }, [mode]);
  useEffect(() => {
    if (lastKey.current === sessionKey) return;
    lastKey.current = sessionKey;
    let saved = 0;
    try { const data = JSON.parse(safeRead(STORAGE_PROGRESS, '{}')) as Record<string, number>; saved = sessionKey ? data[sessionKey] ?? 0 : 0; } catch { /* corrupted progress */ }
    const restored = Math.max(0, Math.min((resumePage != null ? resumePage - 1 : saved), Math.max(0, sources.length - 1)));
    setPage(restored);
    setScrollPage(restored);
  }, [sessionKey, sources.length, resumePage]);
  useEffect(() => {
    if (!sessionKey || !sources.length) return;
    try {
      const data = JSON.parse(safeRead(STORAGE_PROGRESS, '{}')) as Record<string, number>;
      data[sessionKey] = Math.min(sources.length - 1, mode === 'vertical' ? scrollPage : page);
      // Limit the stored reading history to avoid unbounded growth.
      const keys = Object.keys(data);
      if (keys.length > 100) for (const key of keys.slice(0, keys.length - 100)) delete data[key];
      localStorage.setItem(STORAGE_PROGRESS, JSON.stringify(data));
    } catch { /* private mode or storage disabled */ }
  }, [sessionKey, sources.length, mode, page, scrollPage]);
  // Restore the vertical reader to the previously seen image. The index is 0-based
  // internally; it is 1-based everywhere in history and callbacks.
  useEffect(() => {
    if (!sources.length || mode !== 'vertical' || (resumePage ?? 1) <= 1) return;
    const targetPage = Math.min(Math.max(1, resumePage ?? 1), sources.length);
    restoring.current = true;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const slot = scroller.current?.querySelector(`[data-page="${targetPage}"]`);
        slot?.scrollIntoView({ block: 'start', behavior: 'instant' });
        // Intersection observers can report intermediate pages while scrolling.
        restoreTimer.current = window.setTimeout(() => { restoring.current = false; }, 700);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (restoreTimer.current !== null) window.clearTimeout(restoreTimer.current);
      restoring.current = false;
    };
  }, [sessionKey, mode, sources.length, resumePage]);
  // Unlike the image prefetch observer, scroll position is measured against the
  // actual viewport so offscreen prefetched images cannot overwrite progress.
  const updateVerticalPage = useCallback(() => {
    if (restoring.current || !scroller.current) return;
    const slots = scroller.current.querySelectorAll<HTMLElement>('[data-page]');
    const markerY = window.innerHeight * 0.32;
    // Binary search avoids measuring every image on each scroll frame.
    let low = 0, high = slots.length - 1, result = 0;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (slots[middle].getBoundingClientRect().top <= markerY) {
        result = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    setScrollPage(p => p === result ? p : result);
  }, []);
  useEffect(() => {
    if (mode !== 'vertical' || !sources.length) return;
    const onScroll = () => {
      if (scrollRaf.current !== null) return;
      scrollRaf.current = window.requestAnimationFrame(() => {
        scrollRaf.current = null;
        updateVerticalPage();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (scrollRaf.current !== null) window.cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = null;
    };
  }, [mode, sources.length, updateVerticalPage]);
  const onProgressRef = useRef(onProgress);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  const currentProgress = mode === 'vertical' ? scrollPage + 1 : page + 1;
  useEffect(() => { if (sources.length) onProgressRef.current?.(currentProgress); }, [sources.length, currentProgress]);
  const addLocalFiles = (files: FileList | null) => {
    if (!files) return;
    const supported = Array.from(files).filter(f => f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(f.name));
    const created = supported.map(f => {
      const url = URL.createObjectURL(f);
      localUrls.current.push(url);
      return { url, label: f.name };
    });
    setLocalPages(p => [...p, ...created]);
  };
  const clearLocal = () => {
    for (const url of localUrls.current) URL.revokeObjectURL(url);
    localUrls.current = []; setLocalPages([]); setPage(0); setScrollPage(0);
  };
  useEffect(() => () => { for (const url of localUrls.current) URL.revokeObjectURL(url); }, []);
  const goTo = useCallback((next: number) => setPage(Math.max(0, Math.min(next, sources.length - 1))), [sources.length]);
  useEffect(() => {
    if (mode === 'vertical' || !sources.length) return;
    const onKey = (event: KeyboardEvent) => {
      const element = document.activeElement;
      if (element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); goTo(page + (mode === 'rtl' ? -1 : 1)); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(page + (mode === 'rtl' ? 1 : -1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, sources.length, goTo, page]);
  // Preload upcoming and previous pages using the browser cache, without proxies or extra credentials.
  useEffect(() => {
    if (mode === 'vertical' || !sources.length) return;
    const pending = [page + 1, page + 2, page - 1].filter(n => n >= 0 && n < sources.length).map(n => {
      const img = new window.Image(); img.referrerPolicy = 'no-referrer'; img.src = sources[n].url; return img;
    });
    return () => { for (const img of pending) img.src = ''; };
  }, [page, mode, sources]);
  const current = Math.min(page, Math.max(0, sources.length - 1));
  // Offscreen images recycle their decoded resources; scroll events still track progress independently.
  return <section className="content readerContent">
    {onBack && <div className="readerReturnBar"><button className="readerBack" onClick={onBack} title="返回先前瀏覽的列表（Esc / Alt+←）"><ArrowLeft size={18}/> {backLabel ?? '返回上一頁'}</button><span>Esc / Alt + ← 返回</span></div>}
    <div className="pill">MANGAHUB · READER</div>
    <h1>{galleryTitle ? <>正在<span>閱讀</span></> : <>圖片<span>閱讀器</span></>}</h1>
    {galleryTitle ? <p className="readerGalleryTitle" title={galleryTitle}>{galleryTitle}</p> : <p className="lead">閱讀你有權存取的標準圖片，支援 JPG、PNG、WebP、AVIF、長條捲動與左右翻頁。此閱讀器不載入第三方網站 HTML 或廣告。</p>}
    {!galleryTitle && <div className="mh-import">
      <label className="mh-upload"><ImagePlus size={18}/> 選取本機圖片 <input type="file" accept="image/*,.avif" multiple onChange={e => { addLocalFiles(e.target.files); e.currentTarget.value = ''; }}/></label>
      <span>或每行輸入一個 HTTPS 圖片網址：</span>
    </div>}
    {!galleryTitle && <textarea value={imageText} onChange={e => setImageText(e.target.value)} rows={4} placeholder={'https://example.org/page001.jpg\nhttps://example.org/page002.webp'}/>}
    {invalidUrls.length > 0 && <div className="mh-validation"><AlertCircle size={16}/> 已略過 {invalidUrls.length} 個無效網址（僅支援不含帳密的 HTTPS URL）。</div>}
    <div className="readerTools mh-reader-tools">
      <span>{sources.length} 張圖片 · {sources.length ? `第 ${mode === 'vertical' ? scrollPage + 1 : current + 1} 頁` : '尚未載入'}</span>
      <div className="mh-tool-buttons">
        <button className={mode === 'vertical' ? 'toggle on' : 'toggle'} onClick={() => setMode('vertical')}>長條捲動</button>
        <button className={mode === 'ltr' ? 'toggle on' : 'toggle'} onClick={() => setMode('ltr')}>左至右</button>
        <button className={mode === 'rtl' ? 'toggle on' : 'toggle'} onClick={() => setMode('rtl')}>右至左</button>
      </div>
    </div>
    {sources.length > 0 && <div className="mh-reader-settings">
      <label>縮放 <input type="range" min="60" max="150" step="10" value={zoom} onChange={e => setZoom(Number(e.target.value))}/> {zoom}%</label>
      <button className="toggle" onClick={() => setZoom(100)}><ZoomOut size={14}/> 重設</button>
      {localPages.length > 0 && <button className="toggle" onClick={clearLocal}><Trash2 size={14}/> 清除本機圖片</button>}
    </div>}
    {sources.length === 0 ? <div className="empty"><ImagePlus size={34}/><h2>等待圖片</h2><p>可選取自己的漫畫圖片，或貼上有權存取的 HTTPS 圖片網址。</p></div> : mode === 'vertical' ?
      <div ref={scroller} className="scrollReader mh-scroll-reader" style={{ '--reader-width': `${zoom}%` } as React.CSSProperties}>
        {sources.map((item, i) => <ReaderImage key={`${item.url}-${i}`} src={item.url} index={i} eager={false} />)}
      </div> : <div className="singleReader mh-single-reader">
        <div className="pager">
          <button disabled={current === 0} onClick={() => goTo(current - 1)}><ChevronLeft size={16}/> 上一頁</button>
          <span>{current + 1} / {sources.length}</span>
          <button disabled={current === sources.length - 1} onClick={() => goTo(current + 1)}>下一頁 <ChevronRight size={16}/></button>
        </div>
        <div className="mh-single-image" style={{ '--single-zoom': `${zoom}%` } as React.CSSProperties}>
          <ReaderImage key={`${current}-${sources[current].url}`} src={sources[current].url} index={current} eager />
        </div>
        <p className="mh-help">方向鍵可翻頁（右至左模式會反轉方向）。圖片若因來源站限制無法直接載入，請使用合法提供的圖片檔案。</p>
      </div>}
    <p className="detailNote">遠端圖片網址與閱讀進度僅儲存於本機。選取的本機圖片在關閉 App 後需重新選取。ComicBox 的分段／處理後圖片不在此版本的支援範圍。</p>
  </section>;
}
