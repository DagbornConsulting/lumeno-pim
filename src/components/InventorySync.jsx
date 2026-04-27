import React, { useState, useEffect, useRef } from 'react';
import { Upload, RefreshCw, CheckCircle2, ArrowUp, ArrowDown, Minus } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function InventorySync() {
  const [storeId, setStoreId] = useState(null);
  const [stores, setStores] = useState([]);
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState({ headers: [], skuCol: '', qtyCol: '' });
  const [diff, setDiff] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [loading, setLoading] = useState('');
  const [toast, setToast] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    fetch(`${API_URL}/db/stores`)
      .then(r => r.json())
      .then(data => {
        const list = data.stores || data || [];
        setStores(list);
        if (list.length) setStoreId(String(list[0].id));
      })
      .catch(() => {});
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setDiff(null);
    setSelected(new Set());

    const formData = new FormData();
    formData.append('file', f);
    formData.append('storeId', storeId || '');
    setLoading('parse');
    fetch(`${API_URL}/import/parse`, { method: 'POST', body: formData })
      .then(r => r.json())
      .then(data => {
        const headers = data.headers || [];
        const skuCol = headers.find(h => /sku|artnr|artikel/i.test(h)) || headers[0] || '';
        const qtyCol = headers.find(h => /qty|quantity|antal|lager|stock|saldo/i.test(h)) || headers[1] || '';
        setColumns({ headers, skuCol, qtyCol });
      })
      .catch(() => {})
      .finally(() => setLoading(''));
  };

  const handlePreview = async () => {
    if (!file || !storeId) return;
    setLoading('preview');
    setDiff(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('storeId', storeId);
    formData.append('skuColumn', columns.skuCol);
    formData.append('qtyColumn', columns.qtyCol);
    try {
      const r = await fetch(`${API_URL}/inventory/preview`, { method: 'POST', body: formData });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel vid förhandsgranskning');
      setDiff(data);
      const changedSkus = new Set((data.diff || []).filter(row => row.changed).map(r => r.sku));
      setSelected(changedSkus);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading('');
    }
  };

  const handleApply = async () => {
    if (!diff || !storeId || !selected.size) return;
    const items = diff.diff
      .filter(row => selected.has(row.sku))
      .map(row => ({
        inventoryItemId: row.inventoryItemId,
        locationId: row.locationId,
        newQty: row.newQty,
      }));

    setLoading('apply');
    try {
      const r = await fetch(`${API_URL}/inventory/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, items }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel vid uppdatering');
      showToast(
        `${data.updated} produkter uppdaterade i Shopify${data.failed ? `, ${data.failed} misslyckades` : ''}`,
        data.failed ? 'warning' : 'success'
      );
      setDiff(null);
      setFile(null);
      setSelected(new Set());
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading('');
    }
  };

  const toggleRow = (sku) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });
  };

  const visibleRows = diff
    ? (onlyChanged ? diff.diff.filter(r => r.changed) : diff.diff)
    : [];

  const allSelected = visibleRows.length > 0 && visibleRows.every(r => selected.has(r.sku));

  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) visibleRows.forEach(r => next.delete(r.sku));
      else visibleRows.forEach(r => next.add(r.sku));
      return next;
    });
  };

  return (
    <div className="margin-engine">
      {toast && (
        <div className={`pricing-flash ${toast.type}`} style={{ marginBottom: 16 }}>
          {toast.msg}
        </div>
      )}

      <div className="content-header">
        <div>
          <h1 className="content-title">Uppdatera lagersaldo</h1>
          <p className="content-subtitle">Ladda upp leverantörens lagerfil och synka direkt till Shopify.</p>
        </div>
      </div>

      {/* Store selector */}
      {stores.length > 1 && (
        <section className="settings-section" style={{ marginBottom: 16 }}>
          <div className="settings-body">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Butik</label>
              <select className="form-input" value={storeId || ''} onChange={e => setStoreId(e.target.value)}>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
        </section>
      )}

      {/* Upload */}
      <section className="settings-section" style={{ marginBottom: 16 }}>
        <div className="settings-header">
          <div className="settings-title">1. Välj fil</div>
          <div className="settings-description">CSV eller Excel med SKU och lagersaldo från leverantören.</div>
        </div>
        <div className="settings-body">
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              border: '2px dashed var(--border, #2a2a2a)',
              borderRadius: 10,
              padding: '28px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              background: 'var(--bg-elevated, #111)',
              transition: 'border-color 0.15s',
            }}
          >
            <Upload size={28} style={{ margin: '0 auto 10px', display: 'block', opacity: 0.5 }} />
            <div style={{ fontWeight: 500 }}>
              {file ? file.name : 'Klicka för att välja fil'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 4 }}>
              CSV, TSV, XLSX, XLS
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        </div>
      </section>

      {/* Column mapping + preview trigger */}
      {columns.headers.length > 0 && (
        <section className="settings-section" style={{ marginBottom: 16 }}>
          <div className="settings-header">
            <div className="settings-title">2. Välj kolumner</div>
            <div className="settings-description">Ange vilken kolumn som innehåller SKU och lagersaldo.</div>
          </div>
          <div className="settings-body" style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">SKU-kolumn</label>
              <select className="form-input" value={columns.skuCol} onChange={e => setColumns(c => ({ ...c, skuCol: e.target.value }))}>
                {columns.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">Antal-kolumn</label>
              <select className="form-input" value={columns.qtyCol} onChange={e => setColumns(c => ({ ...c, qtyCol: e.target.value }))}>
                {columns.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" onClick={handlePreview} disabled={!!loading}>
              {loading === 'preview' ? <RefreshCw size={14} className="spin" /> : null}
              {loading === 'preview' ? 'Hämtar...' : 'Förhandsgranska'}
            </button>
          </div>
        </section>
      )}

      {/* Results */}
      {diff && (
        <section className="settings-section">
          <div className="settings-header" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div>
              <div className="settings-title">3. Granska & uppdatera</div>
              <div className="settings-description">
                {diff.matched} matchade &nbsp;·&nbsp;
                <span style={{ color: diff.changed > 0 ? '#f59e0b' : 'inherit' }}>{diff.changed} med förändring</span>
                {diff.notFound?.length > 0 && (
                  <span style={{ color: '#ef4444' }}>&nbsp;·&nbsp;{diff.notFound.length} ej hittade</span>
                )}
              </div>
            </div>
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} />
              Visa bara förändrade
            </label>
          </div>

          <div className="settings-body">
            {visibleRows.length > 0 ? (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="margin-table">
                    <thead>
                      <tr>
                        <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                        <th>SKU</th>
                        <th>Produkt</th>
                        <th className="num">Nuvarande</th>
                        <th className="num">Ny</th>
                        <th className="num">Förändring</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map(row => (
                        <tr key={row.sku} className={selected.has(row.sku) ? 'selected' : ''}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(row.sku)}
                              onChange={() => toggleRow(row.sku)}
                            />
                          </td>
                          <td><code style={{ fontSize: 12 }}>{row.sku}</code></td>
                          <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.productTitle || '—'}
                          </td>
                          <td className="num">{row.currentQty}</td>
                          <td className="num">{row.newQty}</td>
                          <td className="num"><DeltaBadge delta={row.delta} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {selected.size > 0 && (
                  <div className="bulk-bar" style={{ marginTop: 12 }}>
                    <span style={{ fontSize: 13 }}>{selected.size} valda</span>
                    <button className="btn btn-primary" onClick={handleApply} disabled={!!loading}>
                      {loading === 'apply'
                        ? <RefreshCw size={14} className="spin" />
                        : <CheckCircle2 size={14} />}
                      {loading === 'apply' ? 'Uppdaterar...' : 'Uppdatera lagersaldo i Shopify'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-secondary, #888)' }}>
                Inga förändringar i lagersaldo.
              </div>
            )}

            {diff.notFound?.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary, #888)' }}>
                  SKUs som saknas i PIM ({diff.notFound.length})
                </summary>
                <p style={{ fontSize: 12, marginTop: 6, color: 'var(--text-secondary, #888)', wordBreak: 'break-all' }}>
                  {diff.notFound.join(', ')}
                </p>
              </details>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function DeltaBadge({ delta }) {
  if (delta === 0) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-secondary, #888)' }}>
      <Minus size={11} /> 0
    </span>
  );
  if (delta > 0) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#22c55e', fontWeight: 600 }}>
      <ArrowUp size={11} /> +{delta}
    </span>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#ef4444', fontWeight: 600 }}>
      <ArrowDown size={11} /> {delta}
    </span>
  );
}
