export default function TabGoogle({ draft, setDraft }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  return (
    <div className="form-grid">
      <div>
        <label>Google Product Category</label>
        <input value={draft.google_category || ''} onChange={e => set('google_category', e.target.value)} placeholder="t.ex. Apparel & Accessories > Clothing" />
      </div>
      <div>
        <label>Gender</label>
        <select value={draft.google_gender || ''} onChange={e => set('google_gender', e.target.value)}>
          <option value="">—</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="unisex">Unisex</option>
        </select>
      </div>
      <div>
        <label>Age group</label>
        <select value={draft.google_age_group || ''} onChange={e => set('google_age_group', e.target.value)}>
          <option value="">—</option>
          <option value="newborn">Newborn</option>
          <option value="infant">Infant</option>
          <option value="toddler">Toddler</option>
          <option value="kids">Kids</option>
          <option value="adult">Adult</option>
        </select>
      </div>
      <div>
        <label>Condition</label>
        <select value={draft.google_condition || 'new'} onChange={e => set('google_condition', e.target.value)}>
          <option value="new">New</option>
          <option value="refurbished">Refurbished</option>
          <option value="used">Used</option>
        </select>
      </div>
      <div>
        <label>MPN (Manufacturer Part Number)</label>
        <input value={draft.google_mpn || ''} onChange={e => set('google_mpn', e.target.value)} />
      </div>
      <div>
        <label>Custom product</label>
        <select
          value={draft.google_custom_product ? 'true' : 'false'}
          onChange={e => set('google_custom_product', e.target.value === 'true')}
        >
          <option value="false">False</option>
          <option value="true">True</option>
        </select>
      </div>
      <div>
        <label>AdWords grouping</label>
        <input value={draft.google_adwords_grouping || ''} onChange={e => set('google_adwords_grouping', e.target.value)} />
      </div>
      <div>
        <label>AdWords labels</label>
        <input value={draft.google_adwords_labels || ''} onChange={e => set('google_adwords_labels', e.target.value)} />
      </div>
    </div>
  );
}
