import React, { useState, useEffect, useMemo } from 'react';
import {
  TrendingUp, Save, Plus, Trash2, RefreshCw, Search, AlertCircle, CheckCircle2
} from 'lucide-react';
import {
  resolveMargin, computePricing, fmtKr, fmtPct, DEFAULT_MARGIN, DEFAULT_VAT_RATE
} from '../utils/pricing';
import './MarginEngine.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const buildHeaders = (storeId) => {
  const token = localStorage.getItem('pim_token');
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (storeId) h['x-store-id'] = storeId;
  return h;
};

const withStore = (path, storeId) => {
  if (!storeId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}storeId=${encodeURIComponent(storeId)}`;
};

export default function MarginEngine() {
  const [storeId, setStoreId] = useState(null);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [settings, setSettings] = useState({
    default_margin_multiplier: DEFAULT_MARGIN,
    default_vat_rate: DEFAULT_VAT_RATE,
  });
  const [categoryRules, setCategoryRules] = useState([]);
  const [newRule, setNewRule] = useState({ category: '', margin_multiplier: '' });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkMargin, setBulkMargin] = useState('');
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Resolve active store first; everything else depends on storeId.
  useEffect(() => {
    fetch(`${API_URL}/db/stores`, { headers: buildHeaders() })
      .then(r => r.json())
      .then(stores => {
        const first = Array.isArray(stores) && stores[0]?.id;
        if (first) setStoreId(first);
        else setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadAll = async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const headers = buildHeaders(storeId);
      const [s, r, prodRes, supRes] = await Promise.all([
        fetch(withStore(`${API_URL}/db/pricing-settings`, storeId), { headers }).then(r => r.json()),
        fetch(withStore(`${API_URL}/db/category-margin-rules`, storeId), { headers }).then(r => r.json()),
        fetch(withStore(`${API_URL}/db/products?limit=10000`, storeId), { headers }).then(r => r.json()),
        fetch(withStore(`${API_URL}/db/suppliers`, storeId), { headers }).then(r => r.json()),
      ]);
      if (s && !s.error) setSettings({
        default_margin_multiplier: Number(s.default_margin_multiplier ?? DEFAULT_MARGIN),
        default_vat_rate: Number(s.default_vat_rate ?? DEFAULT_VAT_RATE),
      });
      if (Array.isArray(r)) setCategoryRules(r);
      if (prodRes?.data) setProducts(prodRes.data);
      if (Array.isArray(supRes)) setSuppliers(supRes);
    } catch (e) {
      console.error('MarginEngine load error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, [storeId]);
  const onRefresh = loadAll;
  const headers = buildHeaders(storeId);

  const flash = (msg, type = 'success') => {
    setStatus({ msg, type });
    setTimeout(() => setStatus(null), 3000);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch(withStore(`${API_URL}/db/pricing-settings`, storeId), {
        method: 'PUT',
        headers,
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Fel');
      flash('Inställningar sparade');
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const addRule = async () => {
    if (!newRule.category || !newRule.margin_multiplier) return;
    try {
      const res = await fetch(withStore(`${API_URL}/db/category-margin-rules`, storeId), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          category: newRule.category,
          margin_multiplier: Number(newRule.margin_multiplier),
        }),
      });
      const rule = await res.json();
      if (!res.ok) throw new Error(rule.error || 'Fel');
      setCategoryRules(prev => {
        const without = prev.filter(r => r.category !== rule.category);
        return [...without, rule].sort((a, b) => a.category.localeCompare(b.category));
      });
      setNewRule({ category: '', margin_multiplier: '' });
      flash('Kategoriregel sparad');
    } catch (e) {
      flash(e.message, 'error');
    }
  };

  const deleteRule = async (id) => {
    try {
      await fetch(withStore(`${API_URL}/db/category-margin-rules/${id}`, storeId), {
        method: 'DELETE',
        headers,
      });
      setCategoryRules(prev => prev.filter(r => r.id !== id));
      flash('Kategoriregel borttagen');
    } catch (e) {
      flash(e.message, 'error');
    }
  };

  const recomputeAll = async () => {
    setSaving(true);
    try {
      const res = await fetch(withStore(`${API_URL}/db/products/recompute-prices`, storeId), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const r = await res.json();
      flash(`Räknat om ${r.success}/${r.total} produkter`);
      onRefresh?.();
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const applyBulkMargin = async (clear = false) => {
    if (!selectedIds.size) return;
    setSaving(true);
    try {
      const res = await fetch(withStore(`${API_URL}/db/products/bulk-margin`, storeId), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          productIds: [...selectedIds],
          margin_multiplier: clear ? null : Number(bulkMargin),
        }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Fel');
      flash(`${clear ? 'Återställde' : 'Uppdaterade'} ${r.updated} produkter`);
      setSelectedIds(new Set());
      setBulkMargin('');
      onRefresh?.();
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Compute view rows with resolved margin/pricing for each product
  const rows = useMemo(() => {
    return products.map(p => {
      const supplier = suppliers.find(s => s.id === p.supplier_id) || null;
      const margin = resolveMargin({
        product: p,
        categoryRules,
        supplier,
        defaultMargin: settings.default_margin_multiplier,
      });
      const pricing = computePricing({
        cost: p.default_cost,
        margin: margin.value,
        supplierFeePercent: supplier?.supplier_fee_percent ?? 0,
        vatRate: settings.default_vat_rate,
      });
      return { product: p, margin, pricing, supplier };
    });
  }, [products, suppliers, categoryRules, settings]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ product: p }) => {
      if (filterCategory && p.product_type !== filterCategory) return false;
      if (q && !p.title?.toLowerCase().includes(q) && !p.product_type?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, filterCategory]);

  const allCategories = useMemo(() => {
    return [...new Set(products.map(p => p.product_type).filter(Boolean))].sort();
  }, [products]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredRows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredRows.map(r => r.product.id)));
    }
  };

  const totals = useMemo(() => {
    return filteredRows.reduce((acc, r) => ({
      cost: acc.cost + (r.pricing.trueCost || 0),
      sale: acc.sale + (r.pricing.salePriceExVat || 0),
      profit: acc.profit + (r.pricing.profit || 0),
    }), { cost: 0, sale: 0, profit: 0 });
  }, [filteredRows]);

  if (!storeId && !loading) {
    return (
      <div className="margin-engine">
        <div className="content-header">
          <h1 className="content-title">Marginal & Vinst</h1>
        </div>
        <div className="pricing-flash error">
          <AlertCircle size={16} />
          Ingen butik konfigurerad. Lägg till en butik under "Butiker" först.
        </div>
      </div>
    );
  }

  return (
    <div className="margin-engine">
      <div className="content-header">
        <div>
          <h1 className="content-title">Marginal & Vinst</h1>
          <p className="content-subtitle">
            Sätt marginal per produkt, kategori eller globalt — se vinst per produkt direkt.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={recomputeAll} disabled={saving}>
          <RefreshCw size={16} /> Räkna om alla priser
        </button>
      </div>

      {status && (
        <div className={`pricing-flash ${status.type}`}>
          {status.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          {status.msg}
        </div>
      )}

      {/* Global settings */}
      <section className="settings-section">
        <div className="settings-header">
          <div className="settings-title">Globala inställningar</div>
          <div className="settings-description">Default som används när varken produkt, kategori eller leverantör har egen regel.</div>
        </div>
        <div className="settings-body" style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Default marginal-multiplikator</label>
            <input
              type="number" step="0.01" min="0"
              className="form-input"
              value={settings.default_margin_multiplier}
              onChange={e => setSettings(s => ({ ...s, default_margin_multiplier: Number(e.target.value) }))}
            />
            <span className="form-help">Inköpspris × detta = utpris ink moms</span>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Momssats</label>
            <input
              type="number" step="0.01" min="0" max="1"
              className="form-input"
              value={settings.default_vat_rate}
              onChange={e => setSettings(s => ({ ...s, default_vat_rate: Number(e.target.value) }))}
            />
            <span className="form-help">0,25 = 25% (svensk standard)</span>
          </div>
          <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
            <Save size={16} /> Spara
          </button>
        </div>
      </section>

      {/* Category rules */}
      <section className="settings-section">
        <div className="settings-header">
          <div className="settings-title">Marginal per kategori</div>
          <div className="settings-description">Överstyr default för en specifik produkttyp.</div>
        </div>
        <div className="settings-body">
          <table className="margin-table">
            <thead>
              <tr><th>Kategori</th><th>Marginal</th><th></th></tr>
            </thead>
            <tbody>
              {categoryRules.map(r => (
                <tr key={r.id}>
                  <td>{r.category}</td>
                  <td>{Number(r.margin_multiplier).toFixed(2)}×</td>
                  <td>
                    <button className="btn-icon" onClick={() => deleteRule(r.id)} title="Ta bort">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <input
                    list="margin-cat-list"
                    className="form-input"
                    placeholder="Kategori (product_type)"
                    value={newRule.category}
                    onChange={e => setNewRule(r => ({ ...r, category: e.target.value }))}
                  />
                  <datalist id="margin-cat-list">
                    {allCategories.map(c => <option key={c} value={c} />)}
                  </datalist>
                </td>
                <td>
                  <input
                    type="number" step="0.01" min="0"
                    className="form-input"
                    placeholder="2.50"
                    value={newRule.margin_multiplier}
                    onChange={e => setNewRule(r => ({ ...r, margin_multiplier: e.target.value }))}
                  />
                </td>
                <td>
                  <button className="btn btn-primary" onClick={addRule}>
                    <Plus size={14} /> Lägg till
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Bulk operations + product table */}
      <section className="settings-section">
        <div className="settings-header">
          <div className="settings-title">Produkter</div>
          <div className="settings-description">
            Visar resolverad marginal och vinst per produkt. Markera flera för bulk-uppdatering.
          </div>
        </div>
        <div className="settings-body">
          <div className="margin-toolbar">
            <div className="search-box" style={{ flex: 1 }}>
              <Search size={16} />
              <input
                className="form-input"
                placeholder="Sök produkt..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              className="form-input"
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              style={{ maxWidth: 200 }}
            >
              <option value="">Alla kategorier</option>
              {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {selectedIds.size > 0 && (
            <div className="bulk-bar">
              <span><strong>{selectedIds.size}</strong> markerade</span>
              <input
                type="number" step="0.01" min="0"
                className="form-input"
                placeholder="Sätt marginal (t.ex. 2.5)"
                value={bulkMargin}
                onChange={e => setBulkMargin(e.target.value)}
                style={{ maxWidth: 180 }}
              />
              <button
                className="btn btn-primary"
                onClick={() => applyBulkMargin(false)}
                disabled={!bulkMargin || saving}
              >
                <Save size={14} /> Sätt marginal
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => applyBulkMargin(true)}
                disabled={saving}
              >
                Återställ till ärvt
              </button>
            </div>
          )}

          <table className="margin-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={filteredRows.length > 0 && selectedIds.size === filteredRows.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Produkt</th>
                <th>Kategori</th>
                <th className="num">Inköp</th>
                <th>Marginal</th>
                <th className="num">Utpris ink</th>
                <th className="num">Faktisk kost</th>
                <th className="num">Vinst</th>
                <th className="num">Marg %</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ product: p, margin, pricing, supplier }) => (
                <tr key={p.id} className={selectedIds.has(p.id) ? 'selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                  </td>
                  <td className="product-cell">
                    <div className="product-title">{p.title}</div>
                    {supplier && <div className="product-meta">{supplier.name}</div>}
                  </td>
                  <td>{p.product_type || <span className="muted">—</span>}</td>
                  <td className="num">{p.default_cost ? fmtKr(p.default_cost) : <span className="muted">—</span>}</td>
                  <td>
                    <span className={`margin-badge source-${margin.source}`}>
                      {margin.value.toFixed(2)}×
                    </span>
                    <div className="margin-source">{margin.sourceLabel}</div>
                  </td>
                  <td className="num">{fmtKr(pricing.salePriceInclVat)}</td>
                  <td className="num">{fmtKr(pricing.trueCost)}</td>
                  <td className={`num ${pricing.profit >= 0 ? 'profit-pos' : 'profit-neg'}`}>
                    {fmtKr(pricing.profit)}
                  </td>
                  <td className="num">{fmtPct(pricing.marginPct)}</td>
                </tr>
              ))}
              {!filteredRows.length && (
                <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  Inga produkter matchar
                </td></tr>
              )}
            </tbody>
            {filteredRows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={6} style={{ textAlign: 'right' }}><strong>Totalt ({filteredRows.length}):</strong></td>
                  <td className="num"><strong>{fmtKr(totals.cost)}</strong></td>
                  <td className="num profit-pos"><strong>{fmtKr(totals.profit)}</strong></td>
                  <td className="num"><strong>{totals.sale > 0 ? fmtPct(totals.profit / totals.sale) : '—'}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
