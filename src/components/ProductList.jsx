import { useState, useEffect, useMemo } from 'react';
import { Search, Download, Upload, Plus, RefreshCw } from 'lucide-react';
import SyncBadge from './SyncBadge.jsx';
import * as api from '../api.js';

const SYNC_STATUSES = [
  { key: '', label: 'Alla' },
  { key: 'synced', label: 'Synkade' },
  { key: 'modified', label: 'Ej pushade' },
  { key: 'new', label: 'Bara i PIM' },
  { key: 'error', label: 'Fel' },
];

export default function ProductList({ onOpen, onToast }) {
  const [products, setProducts] = useState([]);
  const [facets, setFacets] = useState({ vendors: [], product_types: [], sync_counts: {} });
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filters, setFilters] = useState({
    search: '',
    sync_status: '',
    vendor: '',
    product_type: '',
    status: '',
  });

  useEffect(() => { reload(); }, [filters]);
  useEffect(() => { api.getFacets().then(setFacets).catch(() => {}); }, [products.length]);

  async function reload() {
    setLoading(true);
    try {
      const rows = await api.listProducts(filters);
      setProducts(rows);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  }

  async function pullFromShopify() {
    setSyncing(true);
    try {
      const r = await api.pullAllProducts();
      onToast(`Hämtade ${r.imported} produkter från Shopify`, 'success');
      await reload();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSyncing(false); }
  }

  async function pushAllPending() {
    setSyncing(true);
    try {
      const r = await api.pushAllPending();
      const failed = r.results.filter(x => !x.ok).length;
      if (failed > 0) onToast(`Pushade ${r.pushed - failed}/${r.pushed} (${failed} fel)`, 'error');
      else onToast(`Pushade ${r.pushed} produkter till Shopify`, 'success');
      await reload();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSyncing(false); }
  }

  async function createBlank() {
    try {
      const p = await api.createProduct({ title: 'Ny produkt', status: 'draft' });
      onOpen(p.id);
    } catch (e) { onToast(e.message, 'error'); }
  }

  return (
    <>
      <div className="page-header">
        <h1>Produkter</h1>
        <div className="actions">
          <button onClick={pullFromShopify} disabled={syncing}>
            <Download size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Hämta från Shopify
          </button>
          <button onClick={pushAllPending} disabled={syncing}>
            <Upload size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Pusha alla ändrade
          </button>
          <button className="primary" onClick={createBlank}>
            <Plus size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Ny produkt
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="filter" style={{ flex: 1, minWidth: 220 }}>
          <Search size={16} style={{ color: 'var(--fg-muted)' }} />
          <input
            type="text"
            placeholder="Sök titel, handle, varumärke..."
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            style={{ flex: 1 }}
          />
        </div>
        <select
          value={filters.vendor}
          onChange={e => setFilters(f => ({ ...f, vendor: e.target.value }))}
        >
          <option value="">Alla varumärken</option>
          {facets.vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select
          value={filters.product_type}
          onChange={e => setFilters(f => ({ ...f, product_type: e.target.value }))}
        >
          <option value="">Alla produkttyper</option>
          {facets.product_types.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
        >
          <option value="">Alla statusar</option>
          <option value="active">Aktiv</option>
          <option value="draft">Utkast</option>
          <option value="archived">Arkiverad</option>
        </select>
      </div>

      <div className="sync-chips" style={{ marginBottom: 16 }}>
        {SYNC_STATUSES.map(s => (
          <button
            key={s.key || 'all'}
            className={`chip ${filters.sync_status === s.key ? 'active' : ''}`}
            onClick={() => setFilters(f => ({ ...f, sync_status: s.key }))}
            style={{ cursor: 'pointer' }}
          >
            {s.label}
            {s.key && facets.sync_counts[s.key] != null && (
              <span style={{ opacity: 0.7 }}>· {facets.sync_counts[s.key]}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty">Laddar...</div>
      ) : products.length === 0 ? (
        <div className="empty">
          Inga produkter. <button className="ghost" onClick={pullFromShopify}>Hämta från Shopify</button> eller skapa en ny.
        </div>
      ) : (
        <table className="product-table">
          <thead>
            <tr>
              <th></th>
              <th>Titel</th>
              <th>Varumärke</th>
              <th>Typ</th>
              <th>Varianter</th>
              <th>Status</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {products.map(p => (
              <tr key={p.id} onClick={() => onOpen(p.id)}>
                <td className="thumb">
                  {p.first_image
                    ? <img src={p.first_image} alt="" />
                    : <div className="placeholder" />
                  }
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.handle}</div>
                </td>
                <td>{p.vendor || '—'}</td>
                <td>{p.product_type || '—'}</td>
                <td>{p.variant_count}</td>
                <td style={{ textTransform: 'capitalize' }}>{p.status}</td>
                <td><SyncBadge status={p.sync_status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
