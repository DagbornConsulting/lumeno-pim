import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Download, Check, AlertCircle, Loader2,
  Package, ChevronRight, X, Store, ArrowDownToLine
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function ShopifyImport({ storeId, onImportComplete, onClose }) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState('');

  const fetchDiff = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setError(null);
    setDiff(null);
    setSelected(new Set());
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/shopify/stores/${storeId}/product-diff`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunde inte hämta produktlista från Shopify');
      setDiff(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => { fetchDiff(); }, [fetchDiff]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const filtered = filteredProducts();
    if (filtered.every(p => selected.has(p.shopifyId))) {
      setSelected(prev => {
        const next = new Set(prev);
        filtered.forEach(p => next.delete(p.shopifyId));
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        filtered.forEach(p => next.add(p.shopifyId));
        return next;
      });
    }
  };

  const filteredProducts = () => {
    if (!diff?.newInShopify) return [];
    if (!search.trim()) return diff.newInShopify;
    const q = search.toLowerCase();
    return diff.newInShopify.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.vendor.toLowerCase().includes(q) ||
      p.productType.toLowerCase().includes(q)
    );
  };

  const handleImport = async () => {
    if (!selected.size) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/shopify/stores/${storeId}/import-from-shopify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopifyIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import misslyckades');
      setResult(data);
      if (onImportComplete) onImportComplete(data);
      // Re-fetch diff to update the list
      fetchDiff();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const filtered = filteredProducts();
  const allFilteredSelected = filtered.length > 0 && filtered.every(p => selected.has(p.shopifyId));

  if (!storeId) {
    return (
      <div className="shopify-import-empty">
        <Store size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
        <p>Koppla en Shopify-butik först för att hämta produkter.</p>
      </div>
    );
  }

  return (
    <div className="shopify-import">
      <div className="shopify-import-header">
        <div>
          <h3>Hämta produkter från Shopify</h3>
          {diff && (
            <p className="shopify-import-subtitle">
              {diff.shopifyTotal} produkter i Shopify &nbsp;·&nbsp;
              {diff.pimLinked} redan i PIM &nbsp;·&nbsp;
              <strong style={{ color: diff.newInShopify.length > 0 ? 'var(--warning)' : 'var(--success)' }}>
                {diff.newInShopify.length} saknas i PIM
              </strong>
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={fetchDiff} disabled={loading} title="Uppdatera">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
          {onClose && <button className="btn btn-ghost" onClick={onClose}><X size={16} /></button>}
        </div>
      </div>

      {error && (
        <div className="import-error">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {result && (
        <div className="shopify-import-result">
          <Check size={15} />
          {result.created} produkter importerade till PIM
          {result.errors > 0 && ` · ${result.errors} fel`}
        </div>
      )}

      {loading && (
        <div className="shopify-import-loading">
          <Loader2 size={24} className="spin" />
          <span>Hämtar produkter från Shopify...</span>
        </div>
      )}

      {diff && !loading && (
        <>
          {diff.newInShopify.length === 0 ? (
            <div className="shopify-import-empty">
              <Check size={40} style={{ color: 'var(--success)', marginBottom: 12 }} />
              <p>Alla Shopify-produkter finns redan i PIM.</p>
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="shopify-import-toolbar">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={selectAll}
                  />
                  Välj alla ({filtered.length})
                </label>
                <input
                  className="form-input"
                  style={{ maxWidth: 260, fontSize: 13 }}
                  placeholder="Sök produkt..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <div style={{ flex: 1 }} />
                {selected.size > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={handleImport}
                    disabled={importing}
                  >
                    {importing
                      ? <><Loader2 size={15} className="spin" /> Importerar...</>
                      : <><ArrowDownToLine size={15} /> Importera {selected.size} till PIM</>
                    }
                  </button>
                )}
              </div>

              {/* Product list */}
              <div className="shopify-import-list">
                {filtered.map(p => (
                  <label key={p.shopifyId} className={`shopify-product-row ${selected.has(p.shopifyId) ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.shopifyId)}
                      onChange={() => toggleSelect(p.shopifyId)}
                    />
                    {p.imageUrl
                      ? <img src={p.imageUrl} alt={p.title} className="shopify-product-thumb" />
                      : <div className="shopify-product-thumb-empty"><Package size={18} /></div>
                    }
                    <div className="shopify-product-info">
                      <div className="shopify-product-title">{p.title}</div>
                      <div className="shopify-product-meta">
                        {p.vendor && <span>{p.vendor}</span>}
                        {p.productType && <span>{p.productType}</span>}
                        <span>{p.variantCount} variant{p.variantCount !== 1 ? 'er' : ''}</span>
                        <span className={`shopify-status-badge status-${p.status}`}>{p.status}</span>
                      </div>
                    </div>
                    <ChevronRight size={14} style={{ opacity: 0.3, flexShrink: 0 }} />
                  </label>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
