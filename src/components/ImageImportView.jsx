import React, { useState, useRef } from 'react';
import { Search, CheckCircle, Loader2, Image, X, Globe } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// Build initial selection: tick anything with score >= 80 (SKU/barcode match),
// leave score 70 (path-prefix fallback) for manual review.
const buildDefaultSelection = (matches) => {
  const sel = new Set();
  for (const m of matches) {
    for (const img of m.images) {
      if (img.score >= 80) sel.add(`${m.product.id}::${img.url}`);
    }
  }
  return sel;
};

export default function ImageImportView() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle | crawling | reviewing | applying | done | error
  const [progress, setProgress] = useState(null); // { page, queued, url, matched, elapsed }
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [applyResult, setApplyResult] = useState(null);
  const [testMode, setTestMode] = useState(true);
  const [testLimit, setTestLimit] = useState(3);
  const [selectedImages, setSelectedImages] = useState(new Set()); // Set<"productId::url">
  const abortRef = useRef(null);
  const liveMatchesRef = useRef([]); // accumulates matches during crawl for mid-crawl save

  const enterReview = (snapshot) => {
    setResult({ autoMatched: snapshot, pagesScanned: progress?.page || 0, imagesScanned: progress?.queued || 0 });
    setSelectedImages(buildDefaultSelection(snapshot));
    setStatus('reviewing');
  };

  const handleStop = async (save) => {
    abortRef.current?.abort();
    if (save && liveMatchesRef.current.length) {
      enterReview([...liveMatchesRef.current]);
    } else {
      setStatus('idle');
      setProgress(null);
    }
  };

  const handleScrape = async () => {
    if (!url.trim()) return;
    setStatus('crawling');
    setResult(null);
    setErrorMsg('');
    setApplyResult(null);
    setProgress(null);
    liveMatchesRef.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/images/bulk-scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), maxProducts: testMode ? testLimit : null }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Serverfel' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'progress') {
              setProgress(event);
            } else if (event.type === 'match') {
              // Accumulate matches live — used for mid-crawl save
              const idx = liveMatchesRef.current.findIndex(m => m.product.id === event.product.id);
              if (idx >= 0) liveMatchesRef.current[idx] = { product: event.product, images: event.images };
              else liveMatchesRef.current.push({ product: event.product, images: event.images });
            } else if (event.type === 'done') {
              if (event.autoMatched?.length) {
                enterReview(event.autoMatched);
              } else {
                setResult(event);
                setStatus('done');
              }
            } else if (event.type === 'error') {
              throw new Error(event.message);
            }
          } catch (parseErr) {
            if (parseErr.message !== 'Unexpected end of JSON input') throw parseErr;
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setErrorMsg(err.message);
      setStatus('error');
    }
  };

  const applyMatches = async (matches) => {
    setStatus('applying');
    try {
      const payload = matches.map(m => ({ productId: m.product.id, images: m.images }));
      const res = await fetch(`${API_URL}/images/bulk-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matches: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Serverfel');
      setApplyResult(data);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err.message);
      setStatus('error');
    }
  };

  const toggleImage = (productId, url) => {
    setSelectedImages(prev => {
      const next = new Set(prev);
      const key = `${productId}::${url}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleProduct = (productId, images, allChecked) => {
    setSelectedImages(prev => {
      const next = new Set(prev);
      for (const img of images) {
        const key = `${productId}::${img.url}`;
        if (allChecked) next.delete(key); else next.add(key);
      }
      return next;
    });
  };

  const applySelected = async () => {
    const filtered = (result?.autoMatched || [])
      .map(m => ({
        product: m.product,
        images: m.images.filter(img => selectedImages.has(`${m.product.id}::${img.url}`)),
      }))
      .filter(m => m.images.length > 0);
    if (!filtered.length) return;
    await applyMatches(filtered);
  };

  const selectedImageCount = selectedImages.size;
  const selectedProductCount = new Set([...selectedImages].map(k => k.split('::')[0])).size;

  const isCrawling = status === 'crawling';
  const isApplying = status === 'applying';
  const isReviewing = status === 'reviewing';
  const isBusy = isCrawling || isApplying;

  return (
    <div style={{ padding: '32px', maxWidth: '960px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '20px', fontWeight: 600 }}>Bildimport</h2>
      <p style={{ margin: '0 0 28px', color: '#6b7280', fontSize: '14px' }}>
        Ange en leverantörs webbplats. Crawlern följer alla sidor automatiskt och matchar bilder mot
        produkter via SKU och streckkod. Matchade bilder sparas direkt.
      </p>

      {/* Test mode toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', padding: '12px 16px', background: testMode ? '#fefce8' : '#f9fafb', border: `1px solid ${testMode ? '#fde68a' : '#e5e7eb'}`, borderRadius: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={testMode}
            onChange={e => setTestMode(e.target.checked)}
            disabled={isBusy}
            style={{ width: '16px', height: '16px', cursor: 'pointer' }}
          />
          <span style={{ fontWeight: 600, fontSize: '14px', color: testMode ? '#92400e' : '#374151' }}>
            Testläge
          </span>
        </label>
        {testMode && (
          <>
            <span style={{ fontSize: '13px', color: '#78350f' }}>— stoppa efter</span>
            <input
              type="number"
              min={1}
              max={50}
              value={testLimit}
              onChange={e => setTestLimit(Math.max(1, parseInt(e.target.value) || 1))}
              disabled={isBusy}
              style={{ width: '60px', padding: '4px 8px', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '14px', fontWeight: 600, textAlign: 'center' }}
            />
            <span style={{ fontSize: '13px', color: '#78350f' }}>matchade produkter</span>
          </>
        )}
        {!testMode && (
          <span style={{ fontSize: '13px', color: '#6b7280' }}>Kör på alla {'>'}1500 produkter — kontrollera testläget först</span>
        )}
      </div>

      {/* URL input */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '28px' }}>
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !isBusy && handleScrape()}
          placeholder="https://leverantor.se"
          disabled={isBusy}
          style={{
            flex: 1, padding: '10px 14px', border: '1px solid #d1d5db',
            borderRadius: '8px', fontSize: '14px', outline: 'none',
          }}
        />
        {isCrawling ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => handleStop(true)}
              disabled={!progress?.matched}
              style={{ padding: '10px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: progress?.matched ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500, fontSize: '14px', opacity: progress?.matched ? 1 : 0.5 }}
            >
              <CheckCircle size={15} /> Spara & avbryt {progress?.matched ? `(${progress.matched})` : ''}
            </button>
            <button
              onClick={() => handleStop(false)}
              style={{ padding: '10px 14px', background: '#6b7280', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500, fontSize: '14px' }}
            >
              <X size={15} /> Avbryt
            </button>
          </div>
        ) : (
          <button
            onClick={handleScrape}
            disabled={!url.trim() || isApplying}
            style={{
              padding: '10px 20px', background: '#2563eb', color: '#fff',
              border: 'none', borderRadius: '8px', cursor: (!url.trim() || isApplying) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500, fontSize: '14px',
              opacity: (!url.trim() || isApplying) ? 0.6 : 1,
            }}
          >
            {isApplying ? <><Loader2 size={15} className="spin" /> Sparar...</> : <><Search size={15} /> Starta crawl</>}
          </button>
        )}
      </div>

      {/* Crawl progress */}
      {isCrawling && progress && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '16px 20px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <Loader2 size={16} className="spin" style={{ color: '#2563eb', flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: '14px', color: '#1d4ed8' }}>
              Sida {progress.page} · {progress.queued} kvar · {progress.matched} produkter matchade · {progress.elapsed}s
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#3b82f6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Globe size={11} /> {progress.url}
          </div>
          <div style={{ marginTop: '10px', background: '#dbeafe', borderRadius: '4px', height: '4px', overflow: 'hidden' }}>
            <div style={{ background: '#2563eb', height: '100%', width: `${Math.min(100, (progress.page / (progress.page + progress.queued)) * 100)}%`, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {isCrawling && !progress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#6b7280', marginBottom: '24px' }}>
          <Loader2 size={16} className="spin" /> Hämtar sidor...
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px 16px', color: '#dc2626', marginBottom: '20px', fontSize: '14px' }}>
          {errorMsg}
        </div>
      )}

      {/* Stats */}
      {result && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <StatCard label="Sidor skannade" value={result.pagesScanned} />
          <StatCard label="Bilder hittade" value={result.imagesScanned} />
          <StatCard label="Matchade produkter" value={result.autoMatched?.length || 0} color="#16a34a" icon={<CheckCircle size={13} />} />
        </div>
      )}

      {/* Apply result */}
      {applyResult && status === 'done' && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', color: '#15803d', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
          <CheckCircle size={16} />
          <strong>{applyResult.applied} bilder</strong>&nbsp;sparades på produkter
          {applyResult.skipped > 0 && <span style={{ color: '#6b7280', marginLeft: '4px' }}>({applyResult.skipped} fanns redan)</span>}
        </div>
      )}

      {/* Review apply bar */}
      {isReviewing && (
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 0', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1, fontSize: '14px', color: '#374151' }}>
            <strong>{selectedImageCount}</strong> bild{selectedImageCount !== 1 ? 'er' : ''} valda på <strong>{selectedProductCount}</strong> produkt{selectedProductCount !== 1 ? 'er' : ''}
            <span style={{ color: '#6b7280', marginLeft: '8px' }}>
              · score 80+ är förvalda, 70 (path-prefix) kräver bekräftelse
            </span>
          </div>
          <button
            onClick={applySelected}
            disabled={selectedImageCount === 0}
            style={{ padding: '10px 20px', background: selectedImageCount ? '#16a34a' : '#9ca3af', color: '#fff', border: 'none', borderRadius: '8px', cursor: selectedImageCount ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500, fontSize: '14px' }}
          >
            <CheckCircle size={15} /> Spara valda bilder
          </button>
        </div>
      )}

      {/* Results list */}
      {(isReviewing || status === 'done') && result?.autoMatched?.length > 0 && (
        <section>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', color: '#15803d', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle size={16} /> Matchade produkter ({result.autoMatched.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {result.autoMatched.map(m => (
              <ProductRow
                key={m.product.id}
                match={m}
                selectable={isReviewing}
                selected={selectedImages}
                onToggleImage={toggleImage}
                onToggleProduct={toggleProduct}
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty state after crawl */}
      {result && result.autoMatched?.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: '#9ca3af' }}>
          <Image size={48} style={{ margin: '0 auto 16px', display: 'block', opacity: 0.3 }} />
          <p style={{ margin: 0 }}>
            Inga matchningar hittades på {result.pagesScanned} sidor.<br />
            Kontrollera att bildfilnamnen innehåller produkternas SKU-koder.
          </p>
        </div>
      )}

      <style>{`
        .spin { animation: spin 0.9s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function StatCard({ label, value, color = '#374151', icon }) {
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', minWidth: '120px' }}>
      <div style={{ color, fontSize: '26px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
        {icon} {value}
      </div>
      <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>{label}</div>
    </div>
  );
}

function scoreColor(score) {
  if (score >= 100) return '#15803d';
  if (score >= 80)  return '#16a34a';
  if (score >= 70)  return '#ca8a04';
  return '#9ca3af';
}

function ProductRow({ match, selectable = false, selected = new Set(), onToggleImage, onToggleProduct }) {
  const { product, images } = match;
  const checkedCount = selectable ? images.filter(img => selected.has(`${product.id}::${img.url}`)).length : images.length;
  const allChecked = selectable && checkedCount === images.length;
  const someChecked = selectable && checkedCount > 0 && !allChecked;
  return (
    <div style={{
      background: '#f0fdf4', border: '1px solid #bbf7d0',
      borderRadius: '8px', padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: '14px',
    }}>
      {selectable && (
        <input
          type="checkbox"
          checked={allChecked}
          ref={el => { if (el) el.indeterminate = someChecked; }}
          onChange={() => onToggleProduct(product.id, images, allChecked)}
          style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {product.title}
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280' }}>SKU: {product.sku || '—'}</div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap', maxWidth: '60%', justifyContent: 'flex-end' }}>
        {images.map((img, i) => {
          const key = `${product.id}::${img.url}`;
          const isChecked = selectable ? selected.has(key) : true;
          return (
            <label
              key={i}
              title={`${img.matchReason} · ${img.filename}`}
              style={{ position: 'relative', cursor: selectable ? 'pointer' : 'default', display: 'block' }}
            >
              <img
                src={img.url} alt=""
                style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, border: `2px solid ${isChecked ? '#16a34a' : '#e5e7eb'}`, display: 'block', opacity: isChecked ? 1 : 0.5 }}
                onError={e => { e.target.style.opacity = '0.15'; }}
              />
              {selectable && (
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggleImage(product.id, img.url)}
                  style={{ position: 'absolute', top: 2, left: 2, width: 14, height: 14, cursor: 'pointer', accentColor: '#16a34a' }}
                />
              )}
              <span style={{
                position: 'absolute', bottom: 2, right: 2,
                background: scoreColor(img.score),
                color: '#fff', fontSize: '9px', fontWeight: 700, borderRadius: 3, padding: '1px 3px',
              }}>{img.score}</span>
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: '12px', color: '#6b7280', flexShrink: 0, textAlign: 'right', minWidth: '80px' }}>
        <div style={{ fontWeight: 500, color: '#374151' }}>{images[0]?.matchReason}</div>
        <div>{selectable ? `${checkedCount} / ${images.length}` : `${images.length} bild${images.length !== 1 ? 'er' : ''}`}</div>
      </div>
    </div>
  );
}
