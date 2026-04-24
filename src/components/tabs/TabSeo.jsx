export default function TabSeo({ draft, setDraft }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const titleLen = (draft.seo_title || '').length;
  const descLen = (draft.seo_description || '').length;
  return (
    <div className="form-grid">
      <div style={{ gridColumn: '1 / -1' }}>
        <label>SEO-titel <span style={{ color: titleLen > 70 ? 'var(--status-modified)' : 'var(--fg-muted)', fontWeight: 400 }}>({titleLen}/70)</span></label>
        <input value={draft.seo_title || ''} onChange={e => set('seo_title', e.target.value)} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label>SEO-beskrivning <span style={{ color: descLen > 320 ? 'var(--status-modified)' : 'var(--fg-muted)', fontWeight: 400 }}>({descLen}/320)</span></label>
        <textarea rows={4} value={draft.seo_description || ''} onChange={e => set('seo_description', e.target.value)} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label>URL-slug</label>
        <input value={draft.handle || ''} onChange={e => set('handle', e.target.value)} />
        <small style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Produkten kommer nås på <code>/products/{draft.handle || 'din-url-slug'}</code>
        </small>
      </div>
    </div>
  );
}
