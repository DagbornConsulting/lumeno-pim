import { useState, useEffect, useCallback } from 'react';
import { Layers, UploadCloud, Trash2, RefreshCw, PackagePlus, CheckCircle2, AlertTriangle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// Staging list for freshly imported products. These live OUTSIDE the main
// catalogue (products.is_staged = true) so you can group into variants, enrich
// and set the Shopify category before anything touches Shopify. "Pusha till
// Shopify" creates them in Shopify and moves them into the main product list.
export default function StagingProducts({ stores = [], onEditProduct, reloadKey = 0, onCountChange, onGoToImport }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''); // '', 'merge', 'publish', 'delete'
  const [selected, setSelected] = useState(new Set());
  const [progress, setProgress] = useState(null); // { done, total }
  const [toast, setToast] = useState(null);

  const storeIds = stores.map(s => s.id).filter(Boolean);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/db/products?staging=only&limit=3000`);
      const data = await r.json();
      const list = data.data || [];
      setRows(list);
      setSelected(prev => new Set([...prev].filter(id => list.some(p => p.id === id))));
      if (typeof onCountChange === 'function') onCountChange(list.length);
    } catch (err) {
      showToast('Kunde inte ladda: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const toggle = (id) => setSelected(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)));

  const selectedIds = [...selected];

  const handleMerge = async () => {
    if (selectedIds.length < 2) return;
    setBusy('merge');
    try {
      const r = await fetch(`${API_URL}/db/products/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kunde inte slå ihop');
      showToast(`${selectedIds.length} produkter ihopslagna till ${data.variants} varianter`);
      setSelected(new Set());
      await load();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const handlePublish = async () => {
    if (!selectedIds.length) return;
    if (!storeIds.length) { showToast('Ingen Shopify-butik kopplad', 'error'); return; }
    setBusy('publish');
    setProgress({ done: 0, total: selectedIds.length });
    let ok = 0, fail = 0;
    for (const id of selectedIds) {
      try {
        const r = await fetch(`${API_URL}/db/products/${id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeIds }),
        });
        const data = await r.json();
        if (r.ok && data.allSynced) ok++; else fail++;
      } catch { fail++; }
      setProgress(p => ({ done: p.done + 1, total: p.total }));
    }
    setProgress(null);
    setBusy('');
    setSelected(new Set());
    showToast(`${ok} pushade till Shopify${fail ? `, ${fail} misslyckades` : ''}. De ligger nu i huvudlistan.`, fail ? 'warning' : 'success');
    await load();
  };

  const handleDelete = async () => {
    if (!selectedIds.length) return;
    if (!window.confirm(`Ta bort ${selectedIds.length} utkast permanent? De skapas inte i Shopify.`)) return;
    setBusy('delete');
    for (const id of selectedIds) {
      try { await fetch(`${API_URL}/db/products/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
    setBusy('');
    setSelected(new Set());
    showToast('Utkast borttagna');
    await load();
  };

  const fmtPrice = (p) => (p == null ? '—' : `${Math.round(Number(p))} kr`);
  const shortCat = (c) => (c ? String(c).split('>').pop().trim() : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 1000, padding: '10px 16px', borderRadius: 8,
          background: toast.type === 'error' ? '#7f1d1d' : toast.type === 'warning' ? '#78350f' : '#14532d',
          color: '#fff', fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: 380,
        }}>{toast.msg}</div>
      )}

      <div className="content-header">
        <div>
          <h1 className="content-title">Nya produkter</h1>
          <p className="content-subtitle">
            Utkast från importen — gruppera till varianter, berika och sätt Shopify-kategori. "Pusha till Shopify" skapar dem i Shopify och flyttar in dem i huvudlistan.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={loading || !!busy}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} /> Uppdatera
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary, #888)' }}>Laddar…</div>
      ) : rows.length === 0 ? (
        <div className="settings-section" style={{ textAlign: 'center', padding: 48 }}>
          <PackagePlus size={40} style={{ color: 'var(--text-secondary, #888)', marginBottom: 12 }} />
          <h3 style={{ marginBottom: 8 }}>Inga nya produkter i kö</h3>
          <p style={{ color: 'var(--text-secondary, #888)', marginBottom: 16 }}>
            Ladda upp en leverantörsfil så hamnar nya produkter (som inte finns i Shopify) här som utkast.
          </p>
          {onGoToImport && (
            <button className="btn btn-primary" onClick={onGoToImport}>
              <UploadCloud size={16} /> Importera produkter
            </button>
          )}
        </div>
      ) : (
        <div className="settings-section" style={{ flex: 1, overflow: 'auto' }}>
          {/* Toolbar */}
          <div className="bulk-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary, #888)' }}>
              {rows.length} utkast · {selected.size} valda
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={handleMerge} disabled={selectedIds.length < 2 || !!busy}>
                <Layers size={14} /> {busy === 'merge' ? 'Slår ihop…' : 'Slå ihop till varianter'}
              </button>
              <button className="btn btn-secondary" onClick={handleDelete} disabled={!selectedIds.length || !!busy}>
                <Trash2 size={14} /> Ta bort
              </button>
              <button className="btn btn-primary" onClick={handlePublish} disabled={!selectedIds.length || !!busy}>
                {busy === 'publish'
                  ? <><RefreshCw size={14} className="spin" /> Pushar {progress ? `${progress.done}/${progress.total}` : ''}…</>
                  : <><CheckCircle2 size={14} /> Pusha till Shopify ({selectedIds.length})</>}
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="margin-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th style={{ width: 44 }}></th>
                  <th>Produkt</th>
                  <th>SKU</th>
                  <th className="num">Varianter</th>
                  <th className="num">Pris</th>
                  <th>Kategori</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(p => {
                  const img = p.images?.[0]?.url;
                  const vCount = p.variants?.length || 0;
                  const hasCat = !!p.product_category;
                  return (
                    <tr key={p.id} className={selected.has(p.id) ? 'selected' : ''}>
                      <td onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      </td>
                      <td onClick={() => onEditProduct?.(p)} style={{ cursor: 'pointer' }}>
                        {img
                          ? <img src={img} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4 }} />
                          : <div style={{ width: 36, height: 36, borderRadius: 4, background: 'var(--bg-secondary, #222)' }} />}
                      </td>
                      <td onClick={() => onEditProduct?.(p)} style={{ cursor: 'pointer', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.title || '—'}
                      </td>
                      <td onClick={() => onEditProduct?.(p)} style={{ cursor: 'pointer' }}><code style={{ fontSize: 12 }}>{p.sku || '—'}</code></td>
                      <td className="num">{vCount}</td>
                      <td className="num">{fmtPrice(p.default_price)}</td>
                      <td onClick={() => onEditProduct?.(p)} style={{ cursor: 'pointer', fontSize: 12 }}>
                        {hasCat
                          ? <span style={{ color: 'var(--text-secondary, #aaa)' }}>{shortCat(p.product_category)}</span>
                          : <span style={{ color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} /> saknas</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
