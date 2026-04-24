export default function TabInventory({ draft, setDraft }) {
  const variants = draft.variants || [];

  function set(i, k, v) {
    setDraft(d => ({
      ...d,
      variants: d.variants.map((x, idx) => idx === i ? { ...x, [k]: v } : x),
    }));
  }

  if (variants.length === 0) {
    return <div className="empty">Lägg först till en variant under fliken Varianter.</div>;
  }

  return (
    <table className="product-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>SKU</th>
          <th>Lagerhantering</th>
          <th>Antal</th>
          <th>Vid slut</th>
          <th>Frakt</th>
          <th>Moms</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((v, i) => (
          <tr key={v.id || i} style={{ cursor: 'default' }}>
            <td>{v.title || `#${i + 1}`}</td>
            <td><input value={v.sku || ''} onChange={e => set(i, 'sku', e.target.value)} /></td>
            <td>
              <select value={v.inventory_management || 'shopify'} onChange={e => set(i, 'inventory_management', e.target.value)}>
                <option value="shopify">Shopify</option>
                <option value="">Ingen</option>
              </select>
            </td>
            <td><input type="number" value={v.inventory_quantity ?? 0} onChange={e => set(i, 'inventory_quantity', parseInt(e.target.value, 10) || 0)} /></td>
            <td>
              <select value={v.inventory_policy || 'deny'} onChange={e => set(i, 'inventory_policy', e.target.value)}>
                <option value="deny">Stoppa beställning</option>
                <option value="continue">Tillåt beställning</option>
              </select>
            </td>
            <td>
              <input type="checkbox" checked={v.requires_shipping ?? true} onChange={e => set(i, 'requires_shipping', e.target.checked)} style={{ width: 'auto' }} />
            </td>
            <td>
              <input type="checkbox" checked={v.taxable ?? true} onChange={e => set(i, 'taxable', e.target.checked)} style={{ width: 'auto' }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
