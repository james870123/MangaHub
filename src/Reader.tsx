import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, ImagePlus, RotateCcw, Trash2, ZoomOut, BookOpen, LoaderCircle } from 'lucide-react';
import { drawRoumanImage, isRoumanCdnImage, needsRoumanStripRepair } from './roumanStripRepair';
import { invoke } from '@tauri-apps/api/core';

type ReadingMode = 'vertical' | 'ltr' | 'rtl';
type PageStatus = 'idle' | 'loading' | 'ready' | 'failed';
type PageSource = { url: string; label: string };
const STORAGE_URLS = 'mh-image-urls';
const STORAGE_MODE = 'mh-v03-mode';
const STORAGE_PROGRESS = 'mh-v03-reading-progress';
const STORAGE_CACHE_LIMIT = 'mh-v064-image-cache-limit';
type CacheStats = { bytes: number; files: number; roumanBytes: number; nhentaiBytes: number };
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const cacheSupported = (url: string) => { try { const u = new URL(url); return isRoumanCdnImage(url) || (u.protocol === 'https:' && u.hostname === 'i.nhentai.net' && u.pathname.startsWith('/galleries/') && !u.username && !u.password && !u.port); } catch { return false; } };
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

function ReaderImage({ src, index, eager, cacheLimitMb }: { src: string; index: number; eager: boolean; cacheLimitMb: number }) {
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
  const cacheEnabled = cacheLimitMb > 0 && cacheSupported(src);
  const [displaySrc, setDisplaySrc] = useState<string | null>(() => cacheEnabled ? null : src);
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
  useEffect(() => {
    if (!active) { setDisplaySrc(null); return; }
    if (!cacheEnabled) { setDisplaySrc(src); return; }
    let disposed = false;
    let objectUrl: string | null = null;
    setDisplaySrc(null);
    invoke<ArrayBuffer>('image_cache_get', { url: src, limitMb: cacheLimitMb })
      .then(result => {
        if (disposed) return;
        const bytes: ArrayBuffer = result instanceof ArrayBuffer ? result : (new Uint8Array(result as unknown as number[]).buffer as ArrayBuffer);
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        setDisplaySrc(objectUrl);
      })
      .catch(() => { if (!disposed) setDisplaySrc(src); }); // Preserve v0.6.3 direct image loading as fallback.
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [active, cacheEnabled, cacheLimitMb, src]);

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
  const placeholderStyle: React.CSSProperties | undefined = (!active || !displaySrc)
    ? (size ? { aspectRatio: `${size.width} / ${size.height}` } : { minHeight: 420 })
    : undefined;

  return <div className="mh-image-slot" ref={node} data-page={index + 1} style={placeholderStyle}>
    {active && displaySrc ? <>
      <img key={`${src}-${attempt}-${displaySrc}`} src={displaySrc} loading="eager" decoding="async"
        referrerPolicy="no-referrer" alt={`漫畫第 ${index + 1} 頁`}
        // Preserve the original image's layout height; Rouman5's repaired
        // canvas overlays it without altering the verified strip algorithm.
        style={repairStrips ? { visibility: 'hidden' } : undefined}
        onLoad={event => handleLoad(event.currentTarget)}
        onError={() => setState('failed')}/>
      {repairStrips && <canvas ref={attachCanvas} aria-label={`漫畫第 ${index + 1} 頁`}
        role="img" style={{ position: 'absolute', inset: 0, display: state === 'ready' ? 'block' : 'none', width: '100%', height: '100%' }}/>} 
    </> : <div className="mh-placeholder mh-recycled-placeholder">第 {index + 1} 頁 · {active ? '讀取快取中' : '捲動時載入'}</div>}
    {active && state === 'failed' && <div className="mh-load-error"><AlertCircle size={19}/><strong>第 {index + 1} 頁載入失敗</strong><small>可能是網路暫時中斷、來源限制或圖片格式問題。</small><button onClick={() => { setState('loading'); setAttempt(n => n + 1); }}><RotateCcw size={15}/> 重試</button></div>}
  </div>;
}

export default function Reader({ initialUrls, initialPage, progressKey, onProgress, onBack, backLabel, galleryTitle, chapterNavigation }: { initialUrls?: string[]; initialPage?: number; progressKey?: string; onProgress?: (page: number) => void; onBack?: () => void; backLabel?: string; galleryTitle?: string; chapterNavigation?: { index: number; count: number; onNavigate: (direction: -1 | 1) => Promise<void> } }) {
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
  const [focusMode, setFocusMode] = useState(false);
  const [dockVisible, setDockVisible] = useState(true);
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterError, setChapterError] = useState('');
  const changeChapter = async (direction: -1 | 1) => {
    if (!chapterNavigation || chapterBusy) return;
    const next = chapterNavigation.index + direction;
    if (next < 0 || next >= chapterNavigation.count) return;
    setChapterBusy(true);
    setChapterError('');
    try { await chapterNavigation.onNavigate(direction); }
    catch (error) { setChapterError(`無法開啟相鄰章節：${String(error)}`); setChapterBusy(false); }
  };

  const edgeTouch = useRef<{ x: number; y: number; time: number } | null>(null);
  const scrollBaseline = useRef(0);
  const scrollTravel = useRef(0);
  const touchStart = useRef<{ x: number; y: number; at: number } | null>(null);
  // v0.7.0: single-page touch zoom. Do not alter the verified vertical reader.
  // This transforms the entire image slot, including Rouman5's repaired canvas.
  const [mobileScale, setMobileScale] = useState(1);
  const [mobilePan, setMobilePan] = useState({ x: 0, y: 0 });
  const mobileScaleRef = useRef(1);
  const mobilePanRef = useRef({ x: 0, y: 0 });
  const zoomGesture = useRef<{ distance: number; scale: number } | null>(null);
  const panGesture = useRef<{ x: number; y: number; initialX: number; initialY: number } | null>(null);
  const touchWasMulti = useRef(false);
  const suppressedTapUntil = useRef(0);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleImageRef = useRef<HTMLDivElement>(null);
  const clampScale = (n: number) => Math.max(1, Math.min(3, n));
  const applyMobileScale = (next: number) => {
    const scale = clampScale(next);
    mobileScaleRef.current = scale;
    setMobileScale(scale);
    if (scale <= 1.001) { mobilePanRef.current = { x: 0, y: 0 }; setMobilePan({ x: 0, y: 0 }); }
  };
  const applyMobilePan = (x: number, y: number) => {
    const element = singleImageRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const maxX = Math.max(0, (rect.width * (mobileScaleRef.current - 1)) / 2);
    const maxY = Math.max(0, (rect.height * (mobileScaleRef.current - 1)) / 2);
    const next = { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    mobilePanRef.current = next;
    setMobilePan(next);
  };
  const touchDistance = (a: React.Touch, b: React.Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const onZoomTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileReader()) return;
    if (event.touches.length >= 2) {
      touchWasMulti.current = true;
      zoomGesture.current = { distance: Math.max(1, touchDistance(event.touches[0], event.touches[1])), scale: mobileScaleRef.current };
      panGesture.current = null;
      touchStart.current = null;
      edgeTouch.current = null;
    } else if (event.touches.length === 1 && mobileScaleRef.current > 1) {
      const t = event.touches[0];
      panGesture.current = { x: t.clientX, y: t.clientY, initialX: mobilePanRef.current.x, initialY: mobilePanRef.current.y };
      touchStart.current = null;
      edgeTouch.current = null;
    }
  };
  const onZoomTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileReader()) return;
    if (event.touches.length >= 2 && zoomGesture.current) {
      event.preventDefault();
      applyMobileScale(zoomGesture.current.scale * touchDistance(event.touches[0], event.touches[1]) / zoomGesture.current.distance);
      return;
    }
    if (event.touches.length === 1 && panGesture.current && mobileScaleRef.current > 1) {
      event.preventDefault();
      const t = event.touches[0];
      applyMobilePan(panGesture.current.initialX + t.clientX - panGesture.current.x, panGesture.current.initialY + t.clientY - panGesture.current.y);
    }
  };
  const onZoomTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobileReader()) return;
    if (zoomGesture.current || touchWasMulti.current || panGesture.current) {
      suppressedTapUntil.current = Date.now() + 450;
      touchStart.current = null;
    }
    if (event.touches.length < 2) zoomGesture.current = null;
    if (event.touches.length === 0) {
      touchWasMulti.current = false;
      panGesture.current = null;
    }
    // Two fast taps to toggle readable image magnification. No double-tap in vertical mode.
    if (event.touches.length === 0 && event.changedTouches.length === 1 && Date.now() > suppressedTapUntil.current) {
      const t = event.changedTouches[0];
      const last = lastTap.current;
      if (last && Date.now() - last.time < 330 && Math.hypot(t.clientX-last.x, t.clientY-last.y) < 36) {
        applyMobileScale(mobileScaleRef.current > 1 ? 1 : 2);
        lastTap.current = null;
        suppressedTapUntil.current = Date.now() + 400;
      } else lastTap.current = { time: Date.now(), x: t.clientX, y: t.clientY };
    }
  };

  const [cacheLimitMb, setCacheLimitMb] = useState(() => { const n = Number(safeRead(STORAGE_CACHE_LIMIT, '0')); return [0, 500, 1024, 2048].includes(n) ? n : 0; });
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheMessage, setCacheMessage] = useState('');
  const refreshCacheStats = useCallback(() => { invoke<CacheStats>('image_cache_stats').then(setCacheStats).catch(() => setCacheStats(null)); }, []);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_CACHE_LIMIT, String(cacheLimitMb)); } catch { /* storage disabled */ }
    if (cacheLimitMb > 0) invoke<CacheStats>('image_cache_trim', { limitMb: cacheLimitMb }).then(setCacheStats).catch(refreshCacheStats);
    else refreshCacheStats();
  }, [cacheLimitMb, refreshCacheStats]);
  const clearImageCache = async () => {
    if (!window.confirm('確定清除磁碟圖片快取？收藏與閱讀進度不會刪除。')) return;
    try { setCacheStats(await invoke<CacheStats>('image_cache_clear')); setCacheMessage('圖片快取已清除'); }
    catch (error) { setCacheMessage(`清除失敗：${String(error)}`); }
  };
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
  // On mobile the dock follows the reading direction, independently of page
  // progress tracking. Small movements are ignored to avoid toolbar jitter.
  useEffect(() => {
    if (mode !== 'vertical') { setDockVisible(true); return; }
    scrollBaseline.current = window.scrollY;
    scrollTravel.current = 0;
    const onScrollChrome = () => {
      if (restoring.current) { scrollBaseline.current = window.scrollY; return; }
      const y = window.scrollY;
      const delta = y - scrollBaseline.current;
      scrollBaseline.current = y;
      if (Math.abs(delta) > 160) { scrollTravel.current = 0; return; }
      if (y < 70) { scrollTravel.current = 0; setDockVisible(true); return; }
      if (delta * scrollTravel.current < 0) scrollTravel.current = delta;
      else scrollTravel.current += delta;
      if (scrollTravel.current > 42) { setDockVisible(false); scrollTravel.current = 0; }
      if (scrollTravel.current < -32) { setDockVisible(true); scrollTravel.current = 0; }
    };
    window.addEventListener('scroll', onScrollChrome, { passive: true });
    return () => window.removeEventListener('scroll', onScrollChrome);
  }, [mode]);
  const isMobileReader = () => window.matchMedia('(max-width: 750px), (max-width: 950px) and (orientation: landscape) and (pointer: coarse)').matches;
  const onReaderTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    if (!onBack || !isMobileReader() || event.touches.length !== 1) { edgeTouch.current = null; return; }
    const touch = event.touches[0];
    const target = event.target as HTMLElement;
    const fromLeftEdge = touch.clientX <= Math.max(26, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mh-safe-left')) || 0);
    edgeTouch.current = fromLeftEdge && !target.closest('button, a, input, textarea, select')
      ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : null;
  };
  const onReaderTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = edgeTouch.current;
    edgeTouch.current = null;
    if (!start || !onBack || event.changedTouches.length !== 1 || event.touches.length !== 0) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (dx >= 85 && Math.abs(dx) >= Math.abs(dy) * 1.6 && Date.now() - start.time < 1200) {
      // Stop the underlying single-page swipe from also changing the page.
      event.stopPropagation();
      onBack();
    }
  };
  const onReadingSurfaceTap = (event: React.MouseEvent<HTMLElement>) => {
    if (!isMobileReader() || Date.now() < suppressedTapUntil.current) return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (focusMode) { setFocusMode(false); setDockVisible(true); }
    else setDockVisible(show => !show);
  };
  const toggleFocus = () => { setFocusMode(v => !v); setDockVisible(true); };
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
  useEffect(() => {
    // A new page should never inherit zoom/pan from the previous image.
    mobileScaleRef.current = 1;
    mobilePanRef.current = { x: 0, y: 0 };
    setMobileScale(1);
    setMobilePan({ x: 0, y: 0 });
    zoomGesture.current = null;
    panGesture.current = null;
  }, [page, mode, sessionKey]);
  const current = Math.min(page, Math.max(0, sources.length - 1));
  // Touch navigation only applies to single-page mode. Vertical scrolling is never intercepted.
  const onSingleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1 || mobileScaleRef.current > 1 || touchWasMulti.current) { touchStart.current = null; return; }
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  };
  const onSingleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const origin = touchStart.current;
    touchStart.current = null;
    if (!origin || event.changedTouches.length !== 1 || mode === 'vertical' || mobileScaleRef.current > 1 || touchWasMulti.current || Date.now() < suppressedTapUntil.current) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a')) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - origin.x, dy = touch.clientY - origin.y;
    // Ignore vertical scrolling, slow drags and short accidental gestures.
    if (Date.now() - origin.at > 1000 || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const forward = mode === 'rtl' ? dx > 0 : dx < 0;
    goTo(current + (forward ? 1 : -1));
  };
  const mobileJump = (delta: number) => {
    if (mode !== 'vertical') { goTo(current + delta); return; }
    const next = Math.max(0, Math.min(sources.length - 1, scrollPage + delta));
    const slot = scroller.current?.querySelector<HTMLElement>(`[data-page="${next + 1}"]`);
    slot?.scrollIntoView({ block: 'start', behavior: 'instant' });
    setScrollPage(next);
  };
  const chapterEndCard = chapterNavigation && sources.length > 0 && <section className="mh-chapter-end" aria-label="章節結束與下一話導覽">
    <div className="mh-chapter-end-icon"><BookOpen size={22}/></div>
    <strong>本話閱讀完畢</strong>
    <p>第 {chapterNavigation.index + 1} 話 / 共 {chapterNavigation.count} 話</p>
    <div className="mh-chapter-end-actions">
      <button disabled={chapterBusy || chapterNavigation.index <= 0} onClick={() => void changeChapter(-1)}><ChevronLeft size={18}/> 上一話</button>
      <button className="mh-chapter-end-next" disabled={chapterBusy || chapterNavigation.index + 1 >= chapterNavigation.count} onClick={() => void changeChapter(1)}>
        {chapterBusy ? <LoaderCircle size={18} className="mh-spinner"/> : <ChevronRight size={18}/>} 下一話
      </button>
    </div>
    {chapterError && <p className="mh-chapter-end-error" role="alert">{chapterError}</p>}
    {chapterNavigation.index + 1 >= chapterNavigation.count && <small>已是目前最後一話</small>}
  </section>;
  // Offscreen images recycle their decoded resources; scroll events still track progress independently.
  return <section className={`content readerContent${focusMode ? ' reader-focus' : ''}${dockVisible ? '' : ' reader-dock-hidden'}`} onTouchStartCapture={onReaderTouchStart} onTouchEndCapture={onReaderTouchEnd}>
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
    {sources.length > 0 && <div className="mh-reader-focus-toggle"><button className="toggle" onClick={toggleFocus} aria-pressed={focusMode}>{focusMode ? '顯示閱讀設定' : '專注閱讀（收合設定）'}</button></div>}
    {sources.length > 0 && <div className="mh-reader-settings">
      <label>縮放 <input type="range" min="60" max="150" step="10" value={zoom} onChange={e => setZoom(Number(e.target.value))}/> {zoom}%</label>
      <button className="toggle" onClick={() => { setZoom(100); applyMobileScale(1); }}><ZoomOut size={14}/> 重設</button>
      {mode !== 'vertical' && <span className="mh-touch-zoom-hint">iPhone：雙指縮放、拖動查看、雙擊放大／還原</span>}
      {localPages.length > 0 && <button className="toggle" onClick={clearLocal}><Trash2 size={14}/> 清除本機圖片</button>}
    </div>}
    {sources.length > 0 && <div className="mh-reader-cache-settings">
      <label>圖片磁碟快取 <select aria-label="圖片快取容量" value={cacheLimitMb} onChange={e => { setCacheLimitMb(Number(e.currentTarget.value)); setCacheMessage(''); }}>
        <option value={0}>關閉（預設）</option><option value={500}>500 MB</option><option value={1024}>1 GB</option><option value={2048}>2 GB</option>
      </select></label>
      <span>{cacheStats ? `已使用 ${mb(cacheStats.bytes)} · Rouman5 ${mb(cacheStats.roumanBytes)} · nHentai ${mb(cacheStats.nhentaiBytes)} · ${cacheStats.files} 張` : '快取容量未取得'}</span>
      <button className="toggle" onClick={refreshCacheStats}>更新容量</button>
      <button className="toggle" onClick={clearImageCache}><Trash2 size={14}/> 清除圖片快取</button>
      <small>僅在您有權保存圖片時啟用；關閉後直接從來源網站載入。清除快取不影響閱讀進度。</small>
      {cacheMessage && <small role="status">{cacheMessage}</small>}
    </div>}
    {sources.length === 0 ? <div className="empty"><ImagePlus size={34}/><h2>等待圖片</h2><p>可選取自己的漫畫圖片，或貼上有權存取的 HTTPS 圖片網址。</p></div> : mode === 'vertical' ?
      <div ref={scroller} onClick={onReadingSurfaceTap} className="scrollReader mh-scroll-reader" style={{ '--reader-width': `${zoom}%` } as React.CSSProperties}>
        {sources.map((item, i) => <ReaderImage key={`${item.url}-${i}`} src={item.url} index={i} eager={false} cacheLimitMb={cacheLimitMb} />)}
        {chapterEndCard}
      </div> : <div className="singleReader mh-single-reader" onTouchStart={onSingleTouchStart} onTouchEnd={onSingleTouchEnd}>
        <div className="pager">
          <button disabled={current === 0} onClick={() => goTo(current - 1)}><ChevronLeft size={16}/> 上一頁</button>
          <span>{current + 1} / {sources.length}</span>
          <button disabled={current === sources.length - 1} onClick={() => goTo(current + 1)}>下一頁 <ChevronRight size={16}/></button>
        </div>
        <div ref={singleImageRef} className={`mh-single-image${mobileScale > 1.001 ? ' mh-zoomed' : ''}`}
          onTouchStart={onZoomTouchStart} onTouchMove={onZoomTouchMove} onTouchEnd={onZoomTouchEnd}
          onClick={onReadingSurfaceTap}
          style={{ '--single-zoom': `${zoom}%`, '--mh-pinch-scale': mobileScale, '--mh-pan-x': `${mobilePan.x}px`, '--mh-pan-y': `${mobilePan.y}px` } as React.CSSProperties}>
          <ReaderImage key={`${current}-${sources[current].url}`} src={sources[current].url} index={current} eager cacheLimitMb={cacheLimitMb} />
        </div>
        <p className="mh-help">方向鍵可翻頁（右至左模式會反轉方向）。圖片若因來源站限制無法直接載入，請使用合法提供的圖片檔案。</p>
        {current === sources.length - 1 && chapterEndCard}
      </div>}
    {sources.length > 0 && <nav className="mh-mobile-reader-dock" aria-label="手機閱讀控制列" aria-hidden={focusMode || !dockVisible}>
      {onBack && <button className="mh-mobile-dock-back" onClick={onBack} aria-label="返回漫畫列表"><ArrowLeft size={19}/></button>}
      <button onClick={() => mobileJump(-1)} disabled={(mode === 'vertical' ? scrollPage : current) === 0} aria-label="上一頁"><ChevronLeft size={20}/></button>
      <span aria-live="off">{Math.min(sources.length, mode === 'vertical' ? scrollPage + 1 : current + 1)} / {sources.length}</span>
      <button onClick={() => mobileJump(1)} disabled={(mode === 'vertical' ? scrollPage : current) >= sources.length - 1} aria-label="下一頁"><ChevronRight size={20}/></button>
      <button className="mh-mobile-dock-focus" onClick={toggleFocus} aria-pressed={focusMode}>{focusMode ? '設定' : '專注'}</button>
    </nav>}
    <p className="detailNote">遠端圖片網址與閱讀進度僅儲存於本機。選取的本機圖片在關閉 App 後需重新選取。ComicBox 的分段／處理後圖片不在此版本的支援範圍。</p>
  </section>;
}
