import SyncBadge from '../SyncBadge.jsx';

export default function TabPublish({ draft, setDraft, product }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  return (
    <div className="form-grid">
      <div style={{ gridColumn: '1 / -1' }}>
        <label>Status</label>
        <select value={draft.status || 'draft'} onChange={e => set('status', e.target.value)}>
          <option value="active">Aktiv (publicerad)</option>
          <option value="draft">Utkast</option>
          <option value="archived">Arkiverad</option>
        </select>
      </div>
      <div style={{ gridColumn: '1 / -1', padding: 16, background: 'var(--bg-alt)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
        <h3 style={{ marginBottom: 12 }}>Shopify sync</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, fontSize: 14 }}>
          <div style={{ color: 'var(--fg-muted)' }}>Status</div>
          <div><SyncBadge status={product?.sync_status} /></div>
          <div style={{ color: 'var(--fg-muted)' }}>Shopify Product ID</div>
          <div>{product?.shopify_product_id || <span style={{ color: 'var(--fg-muted)' }}>— (ej pushad)</span>}</div>
          <div style={{ color: 'var(--fg-muted)' }}>Senast synkad</div>
          <div>{product?.last_synced_at ? new Date(product.last_synced_at).toLocaleString('sv-SE') : '—'}</div>
          <div style={{ color: 'var(--fg-muted)' }}>Senast uppdaterad</div>
          <div>{product?.updated_at ? new Date(product.updated_at).toLocaleString('sv-SE') : '—'}</div>
          {product?.sync_error && (
            <>
              <div style={{ color: 'var(--status-error)' }}>Senaste fel</div>
              <div style={{ color: 'var(--status-error)' }}>{product.sync_error}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
