export default function TabBasic({ draft, setDraft }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  return (
    <div className="form-grid">
      <div style={{ gridColumn: '1 / -1' }}>
        <label>Titel</label>
        <input value={draft.title || ''} onChange={e => set('title', e.target.value)} />
      </div>
      <div>
        <label>Handle (URL slug)</label>
        <input value={draft.handle || ''} onChange={e => set('handle', e.target.value)} />
      </div>
      <div>
        <label>Status</label>
        <select value={draft.status || 'draft'} onChange={e => set('status', e.target.value)}>
          <option value="active">Aktiv</option>
          <option value="draft">Utkast</option>
          <option value="archived">Arkiverad</option>
        </select>
      </div>
      <div>
        <label>Varumärke / Vendor</label>
        <input value={draft.vendor || ''} onChange={e => set('vendor', e.target.value)} />
      </div>
      <div>
        <label>Produkttyp</label>
        <input value={draft.product_type || ''} onChange={e => set('product_type', e.target.value)} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label>Taggar (kommaseparerade)</label>
        <input
          value={Array.isArray(draft.tags) ? draft.tags.join(', ') : (draft.tags || '')}
          onChange={e => set('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
        />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label>Beskrivning (HTML)</label>
        <textarea
          rows={10}
          value={draft.body_html || ''}
          onChange={e => set('body_html', e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </div>
    </div>
  );
}
