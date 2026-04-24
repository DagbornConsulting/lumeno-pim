import { Plus, Trash2 } from 'lucide-react';

export default function TabVariants({ draft, setDraft }) {
  const variants = draft.variants || [];

  function setVariant(i, key, value) {
    setDraft(d => ({
      ...d,
      variants: d.variants.map((v, idx) => idx === i ? { ...v, [key]: value } : v),
    }));
  }
  function addVariant() {
    setDraft(d => ({
      ...d,
      variants: [...(d.variants || []), {
        title: 'Default', sku: '', price: 0, inventory_quantity: 0, weight_unit: 'kg',
      }],
    }));
  }
  function removeVariant(i) {
    setDraft(d => ({ ...d, variants: d.variants.filter((_, idx) => idx !== i) }));
  }

  if (variants.length === 0) {
    return (
      <div className="empty">
        Inga varianter än. <button className="primary" onClick={addVariant}><Plus size={14} /> Lägg till variant</button>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button onClick={addVariant}><Plus size={14} /> Lägg till variant</button>
      </div>
      <table className="product-table">
        <thead>
          <tr>
            <th>Titel / Option</th>
            <th>SKU</th>
            <th>Streckkod</th>
            <th>Pris</th>
            <th>Jämför pris</th>
            <th>Lager</th>
            <th>Vikt</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => (
            <tr key={v.id || i} style={{ cursor: 'default' }}>
              <td>
                <input value={v.title || ''} onChange={e => setVariant(i, 'title', e.target.value)} placeholder="Default" />
              </td>
              <td><input value={v.sku || ''} onChange={e => setVariant(i, 'sku', e.target.value)} /></td>
              <td><input value={v.barcode || ''} onChange={e => setVariant(i, 'barcode', e.target.value)} /></td>
              <td><input type="number" step="0.01" value={v.price ?? ''} onChange={e => setVariant(i, 'price', e.target.value ? parseFloat(e.target.value) : null)} /></td>
              <td><input type="number" step="0.01" value={v.compare_at_price ?? ''} onChange={e => setVariant(i, 'compare_at_price', e.target.value ? parseFloat(e.target.value) : null)} /></td>
              <td><input type="number" value={v.inventory_quantity ?? 0} onChange={e => setVariant(i, 'inventory_quantity', parseInt(e.target.value, 10) || 0)} /></td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type="number" step="0.001" value={v.weight ?? ''} onChange={e => setVariant(i, 'weight', e.target.value ? parseFloat(e.target.value) : null)} style={{ width: 70 }} />
                  <select value={v.weight_unit || 'kg'} onChange={e => setVariant(i, 'weight_unit', e.target.value)} style={{ width: 65 }}>
                    <option value="kg">kg</option><option value="g">g</option><option value="lb">lb</option><option value="oz">oz</option>
                  </select>
                </div>
              </td>
              <td><button className="ghost" onClick={() => removeVariant(i)} title="Ta bort"><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
