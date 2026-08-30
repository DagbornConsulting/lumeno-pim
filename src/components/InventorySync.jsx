import React, { useState, useEffect, useRef } from 'react';
import { Upload, RefreshCw, CheckCircle2, ArrowUp, ArrowDown, Minus, Sparkles, PackagePlus } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function InventorySync({ mode = 'both', onCreated } = {}) {
  // mode: 'inventory' = bara lageruppdatering · 'import' = bara skapa nya produkter · 'both' = allt
  const showUpdate = mode !== 'import';
  const showCreate = mode !== 'inventory';
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

  // "Create new" tab state
  const [activeTab, setActiveTab] = useState(mode === 'import' ? 'create' : 'update');
  // Cost check: supplier price × pack vs Shopify "cost per item".
  const [costSelected, setCostSelected] = useState(new Set());

  const handleApplyCost = async () => {
    if (!diff?.costDiff?.length || !storeId || !costSelected.size) return;
    const items = diff.costDiff.filter(r => costSelected.has(r.sku)).map(r => ({
      sku: r.sku, inventoryItemId: r.inventoryItemId, expectedCost: r.expectedCost, supplierUnitCost: r.supplierUnitCost,
    }));
    setLoading('apply-cost');
    try {
      const r = await fetch(`${API_URL}/inventory/apply-cost`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, items }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel vid uppdatering');
      showToast(`Inköpspris rättat på ${data.updated} artiklar i Shopify${data.failed ? `, ${data.failed} misslyckades` : ''}`, data.failed ? 'warning' : 'success');
      const failed = new Set((data.errors || []).map(e => e.sku));
      setDiff(prev => prev ? { ...prev, costDiff: prev.costDiff.filter(r => !costSelected.has(r.sku) || failed.has(r.sku)) } : prev);
      setCostSelected(new Set());
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading('');
    }
  };
  const [newRows, setNewRows] = useState([]);
  const [newSelected, setNewSelected] = useState(new Set());
  const [aiLoading, setAiLoading] = useState(false);
  const [bulkType, setBulkType] = useState('');
  const [bulkTags, setBulkTags] = useState('');
  const [roundTo9, setRoundTo9] = useState(true); // avrunda priser uppåt så de slutar på 9

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

  // Round a price UP to the nearest whole number ending in 9 (358 -> 359, 360 -> 369).
  const roundUpTo9 = (p) => {
    if (p == null || p === '' || isNaN(Number(p))) return p;
    return Math.ceil((Number(p) - 9) / 10) * 10 + 9;
  };
  // The price to show for a row given the current rounding mode (based on the
  // original suggested price = cost × margin, so toggling is reversible).
  const priceFor = (suggested, round) => (round ? roundUpTo9(suggested) : suggested);

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
    setNewRows([]);
    setNewSelected(new Set());

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
      // Seed the editable "create new" rows (tags kept as a comma string for editing).
      const nrows = (data.newProducts || []).map(p => ({
        ...p,
        price: priceFor(p.suggestedPrice, roundTo9),
        tags: Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
      }));
      setNewRows(nrows);
      setNewSelected(new Set(nrows.map(r => r.sku)));
      const hasChanges = (data.diff || []).some(r => r.changed);
      setActiveTab(hasChanges ? 'update' : (nrows.length ? 'create' : 'update'));
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
      setDiff(prev => prev ? { ...prev, diff: prev.diff.map(r => selected.has(r.sku) ? { ...r, currentQty: r.newQty, delta: 0, changed: false } : r) } : prev);
      setSelected(new Set());
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

  // ---- Create-new helpers ----
  const updateNewRow = (sku, field, value) =>
    setNewRows(rows => rows.map(r => (r.sku === sku ? { ...r, [field]: value } : r)));

  const toggleNewRow = (sku) =>
    setNewSelected(prev => {
      const next = new Set(prev);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });

  const allNewSelected = newRows.length > 0 && newRows.every(r => newSelected.has(r.sku));
  const toggleAllNew = () =>
    setNewSelected(prev => (allNewSelected ? new Set() : new Set(newRows.map(r => r.sku))));

  const applyBulk = () => {
    if (!bulkType && !bulkTags) return;
    setNewRows(rows => rows.map(r => {
      if (!newSelected.has(r.sku)) return r;
      return {
        ...r,
        product_type: bulkType || r.product_type,
        tags: bulkTags ? (r.tags ? `${r.tags}, ${bulkTags}` : bulkTags) : r.tags,
      };
    }));
    setBulkType('');
    setBulkTags('');
  };

  const suggestWithAI = async () => {
    const targets = newRows.filter(r => newSelected.has(r.sku));
    if (!targets.length) return;
    setAiLoading(true);
    try {
      const chunkSize = 50;
      const bySku = {};
      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize).map(r => ({ sku: r.sku, title: r.title }));
        const r = await fetch(`${API_URL}/claude/suggest-taxonomy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products: chunk }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'AI-fel');
        for (const s of (data.suggestions || [])) bySku[s.sku] = s;
      }
      setNewRows(rows => rows.map(r => (bySku[r.sku] ? {
        ...r,
        product_type: bySku[r.sku].product_type || r.product_type,
        tags: (bySku[r.sku].tags || []).join(', ') || r.tags,
      } : r)));
      showToast(`Förslag ifyllda för ${Object.keys(bySku).length} produkter`);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setAiLoading(false);
    }
  };

  const createProducts = async () => {
    const targets = newRows.filter(r => newSelected.has(r.sku)).map(r => ({
      sku: r.sku,
      title: r.title,
      barcode: r.barcode,
      cost: r.cost,
      price: r.price,
      weight: r.weight,
      qty: r.qty,
      product_type: r.product_type,
      tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      imageUrl: r.imageUrl,
      size: r.size,
      color: r.color,
      metafields: r.metafields || {},
    }));
    if (!targets.length) return;
    setLoading('create');
    try {
      let created = 0, failed = 0;
      const chunk = 200;
      for (let i = 0; i < targets.length; i += chunk) {
        const r = await fetch(`${API_URL}/inventory/create-products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId, products: targets.slice(i, i + chunk) }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Fel vid skapande');
        created += data.created || 0;
        failed += data.failed || 0;
      }
      showToast(`${created} produkter skapade som utkast${failed ? `, ${failed} misslyckades` : ''}. Se "Nya produkter".`, failed ? 'warning' : 'success');
      setNewRows(rows => rows.filter(r => !newSelected.has(r.sku)));
      setNewSelected(new Set());
      if (created > 0 && typeof onCreated === 'function') onCreated(created);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading('');
    }
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
          <h1 className="content-title">{mode === 'import' ? 'Importera produkter' : 'Uppdatera lagersaldo'}</h1>
          <p className="content-subtitle">
            {mode === 'import'
              ? 'Ladda upp en leverantörsfil. Nya produkter (som inte finns i Shopify) skapas som utkast i "Nya produkter" där du grupperar och berikar innan de pushas.'
              : mode === 'inventory'
              ? 'Ladda upp leverantörens lagerfil och synka saldon mot Shopify.'
              : 'Ladda upp leverantörens lagerfil, synka saldon och skapa produkter som saknas i Shopify.'}
          </p>
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
          {/* Tabs */}
          <div className="settings-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {showUpdate && (
              <button
                className={`btn ${activeTab === 'update' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setActiveTab('update')}
              >
                Uppdatera lager ({diff.changed || 0})
              </button>
            )}
            {showCreate && (
              <button
                className={`btn ${activeTab === 'create' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setActiveTab('create')}
              >
                <PackagePlus size={14} /> Skapa nya ({diff.newCount || 0})
              </button>
            )}
            {showUpdate && diff.costDiff && (
              <button
                className={`btn ${activeTab === 'cost' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setActiveTab('cost')}
                style={diff.costDiff.length && activeTab !== 'cost' ? { borderColor: '#f59e0b', color: '#b45309' } : undefined}
                title="Affaris pris × förpackningsantal jämfört med Shopifys kostnad per artikel"
              >
                Inköpspris avviker ({diff.costDiff.length})
              </button>
            )}
            {diff.alreadyInPimCount > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary, #888)' }}>
                {diff.alreadyInPimCount} finns redan i PIM (ej pushade)
              </span>
            )}
          </div>

          {/* ---- COST CHECK TAB ---- */}
          {activeTab === 'cost' && diff.costDiff && (
            <div className="settings-body">
              <div className="settings-description" style={{ marginBottom: 12 }}>
                Affaris pris i filen × förpackningsantal (PIM) jämfört med Shopifys <em>kostnad per artikel</em>.
                Fel kostnad ger fel marginalrapporter och fel utpris om priset räknas om från Shopify.
                {diff.costChecked != null && <> &nbsp;·&nbsp; {diff.costChecked} kontrollerade, <span style={{ color: diff.costDiff.length ? '#f59e0b' : 'inherit' }}>{diff.costDiff.length} avviker</span></>}
              </div>
              {diff.costDiff.length > 0 ? (
                <>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="margin-table">
                      <thead>
                        <tr>
                          <th><input type="checkbox" checked={costSelected.size === diff.costDiff.length} onChange={() => setCostSelected(costSelected.size === diff.costDiff.length ? new Set() : new Set(diff.costDiff.map(r => r.sku)))} /></th>
                          <th>SKU</th>
                          <th>Produkt</th>
                          <th className="num">Affari/st</th>
                          <th className="num">Förp.</th>
                          <th className="num">Bör vara</th>
                          <th className="num">Shopify nu</th>
                          <th>Typ av fel</th>
                          <th className="num">Pris nu</th>
                          <th className="num">Pris vid 2,5×</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.costDiff.map(row => (
                          <tr key={row.sku} className={costSelected.has(row.sku) ? 'selected' : ''}>
                            <td><input type="checkbox" checked={costSelected.has(row.sku)} onChange={() => setCostSelected(prev => { const n = new Set(prev); n.has(row.sku) ? n.delete(row.sku) : n.add(row.sku); return n; })} /></td>
                            <td><code style={{ fontSize: 12 }}>{row.sku}</code></td>
                            <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.productTitle || '—'}</td>
                            <td className="num">{row.supplierUnitCost}</td>
                            <td className="num">{row.pack > 1 ? `${row.pack}-pack` : '1'}</td>
                            <td className="num"><strong>{row.expectedCost}</strong></td>
                            <td className="num" style={{ color: '#ef4444' }}>{row.shopifyCost ?? '—'}</td>
                            <td style={{ fontSize: 12 }}>{row.kind === 'missing' ? 'Kostnad saknas' : row.kind === 'unit-on-pack' ? 'Styckpris inlagt på pack' : row.kind === 'supplier-change' ? 'Affari har ändrat pris' : 'Fel kostnad'}</td>
                            <td className="num">{row.price ?? '—'}</td>
                            <td className="num" style={{ color: row.price != null && Math.abs(row.price - row.suggestedPrice) / row.suggestedPrice > 0.08 ? '#f59e0b' : 'inherit' }}>{row.suggestedPrice}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="bulk-bar" style={{ marginTop: 12 }}>
                    <span style={{ fontSize: 13 }}>{costSelected.size} valda</span>
                    <button className="btn btn-primary" onClick={handleApplyCost} disabled={!!loading || !costSelected.size}>
                      {loading === 'apply-cost' ? <RefreshCw size={14} className="spin" /> : <CheckCircle2 size={14} />}
                      {loading === 'apply-cost' ? 'Rättar...' : 'Rätta kostnad i Shopify (och PIM)'}
                    </button>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Ändrar bara kostnadsfältet – aldrig försäljningspriset. Kolumnen "Pris vid 2,5×" är ett underlag för prisöversynen.</span>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-secondary, #888)' }}>
                  Alla kontrollerade artiklar har rätt inköpspris i Shopify.
                </div>
              )}
            </div>
          )}

          {/* ---- UPDATE STOCK TAB ---- */}
          {activeTab === 'update' && (
            <div className="settings-body">
              <div className="settings-description" style={{ marginBottom: 12 }}>
                {diff.matched} matchade &nbsp;·&nbsp;
                <span style={{ color: diff.changed > 0 ? '#f59e0b' : 'inherit' }}>{diff.changed} med förändring</span>
                {diff.notFound?.length > 0 && <span style={{ color: '#ef4444' }}>&nbsp;·&nbsp;{diff.notFound.length} ej i Shopify</span>}
                {diff.skippedDuplicate > 0 && <span style={{ color: '#ef4444' }}>&nbsp;·&nbsp;{diff.skippedDuplicate} SKU-dubletter</span>}
                {diff.skippedUntracked > 0 && <span style={{ color: 'var(--text-secondary, #888)' }}>&nbsp;·&nbsp;{diff.skippedUntracked} otrackade</span>}
                <label style={{ marginLeft: 16, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} /> Visa bara förändrade
                </label>
              </div>

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
                            <td><input type="checkbox" checked={selected.has(row.sku)} onChange={() => toggleRow(row.sku)} /></td>
                            <td><code style={{ fontSize: 12 }}>{row.sku}</code></td>
                            <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.productTitle || '—'}</td>
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
                        {loading === 'apply' ? <RefreshCw size={14} className="spin" /> : <CheckCircle2 size={14} />}
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
                    SKUs som saknas i Shopify ({diff.notFound.length}) — se fliken "Skapa nya"
                  </summary>
                  <p style={{ fontSize: 12, marginTop: 6, color: 'var(--text-secondary, #888)', wordBreak: 'break-all' }}>
                    {diff.notFound.join(', ')}
                  </p>
                </details>
              )}
              {diff.duplicates?.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13, color: '#ef4444' }}>
                    SKU-dubletter i Shopify — hoppas över, rensa manuellt ({diff.duplicates.length})
                  </summary>
                  <p style={{ fontSize: 12, marginTop: 6, color: 'var(--text-secondary, #888)', wordBreak: 'break-all' }}>
                    {diff.duplicates.join(', ')}
                  </p>
                </details>
              )}
            </div>
          )}

          {/* ---- CREATE NEW TAB ---- */}
          {activeTab === 'create' && (
            <div className="settings-body">
              {newRows.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-secondary, #888)' }}>
                  Inga nya produkter att skapa.
                </div>
              ) : (
                <>
                  <div className="settings-description" style={{ marginBottom: 12 }}>
                    {newRows.length} produkter i CSV:n saknas i Shopify och kan skapas. Justera pris, typ, taggar och bildlänk och skapa dem som utkast. Pris = inköp × {newRows[0]?.margin ?? 2.0}{roundTo9 ? ', avrundat uppåt till 9' : ''} som standard.
                    {(diff.skippedNonDropship > 0 || diff.alreadyInPimCount > 0) && (
                      <span style={{ display: 'block', marginTop: 4, color: 'var(--text-secondary, #888)' }}>
                        Automatiskt exkluderade ur listan:
                        {diff.skippedNonDropship > 0 && ` ${diff.skippedNonDropship} ej godkända för dropship`}
                        {diff.skippedNonDropship > 0 && diff.alreadyInPimCount > 0 && ' ·'}
                        {diff.alreadyInPimCount > 0 && ` ${diff.alreadyInPimCount} finns redan i PIM`}
                        .
                      </span>
                    )}
                  </div>

                  {/* Bulk toolbar */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={roundTo9}
                        onChange={e => {
                          const on = e.target.checked;
                          setRoundTo9(on);
                          // Recompute every row's price from its original suggested price.
                          setNewRows(rows => rows.map(r => ({ ...r, price: priceFor(r.suggestedPrice, on) })));
                        }}
                      />
                      Avrunda priser uppåt till 9
                    </label>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Sätt typ på valda</label>
                      <input className="form-input" value={bulkType} onChange={e => setBulkType(e.target.value)} placeholder="t.ex. Urna" style={{ width: 150 }} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Lägg taggar på valda</label>
                      <input className="form-input" value={bulkTags} onChange={e => setBulkTags(e.target.value)} placeholder="komma,separerat" style={{ width: 180 }} />
                    </div>
                    <button className="btn btn-secondary" onClick={applyBulk} disabled={!newSelected.size || (!bulkType && !bulkTags)}>
                      Applicera på {newSelected.size} valda
                    </button>
                    <button className="btn btn-secondary" onClick={suggestWithAI} disabled={aiLoading || !newSelected.size}>
                      {aiLoading ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />}
                      {aiLoading ? 'Föreslår...' : 'Föreslå typ & taggar (AI)'}
                    </button>
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table className="margin-table">
                      <thead>
                        <tr>
                          <th><input type="checkbox" checked={allNewSelected} onChange={toggleAllNew} /></th>
                          <th>SKU</th>
                          <th>Benämning</th>
                          <th className="num">Inköp</th>
                          <th className="num">Pris</th>
                          <th>Typ</th>
                          <th>Taggar</th>
                          <th>Bildlänk</th>
                        </tr>
                      </thead>
                      <tbody>
                        {newRows.map(row => (
                          <tr key={row.sku} className={newSelected.has(row.sku) ? 'selected' : ''}>
                            <td><input type="checkbox" checked={newSelected.has(row.sku)} onChange={() => toggleNewRow(row.sku)} /></td>
                            <td><code style={{ fontSize: 12 }}>{row.sku}</code></td>
                            <td>
                              <input className="form-input" value={row.title} onChange={e => updateNewRow(row.sku, 'title', e.target.value)} style={{ minWidth: 200 }} />
                            </td>
                            <td className="num">{row.cost != null ? row.cost : '—'}</td>
                            <td className="num">
                              <input className="form-input" type="number" value={row.price ?? ''} onChange={e => updateNewRow(row.sku, 'price', e.target.value)} style={{ width: 80, textAlign: 'right' }} />
                            </td>
                            <td>
                              <input className="form-input" value={row.product_type} onChange={e => updateNewRow(row.sku, 'product_type', e.target.value)} placeholder="typ" style={{ width: 120 }} />
                            </td>
                            <td>
                              <input className="form-input" value={row.tags} onChange={e => updateNewRow(row.sku, 'tags', e.target.value)} placeholder="tagg1, tagg2" style={{ minWidth: 160 }} />
                            </td>
                            <td>
                              <input className="form-input" value={row.imageUrl} onChange={e => updateNewRow(row.sku, 'imageUrl', e.target.value)} placeholder="https://..." style={{ minWidth: 160 }} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {newSelected.size > 0 && (
                    <div className="bulk-bar" style={{ marginTop: 12 }}>
                      <span style={{ fontSize: 13 }}>{newSelected.size} valda</span>
                      <button className="btn btn-primary" onClick={createProducts} disabled={!!loading}>
                        {loading === 'create' ? <RefreshCw size={14} className="spin" /> : <PackagePlus size={14} />}
                        {loading === 'create' ? 'Skapar...' : `Skapa ${newSelected.size} som utkast`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
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
