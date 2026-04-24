export default function TabPricing({ draft, setDraft }) {
  const variants = draft.variants || [];

  function setVariant(i, key, value) {
    setDraft(d => ({
      ...d,
      variants: d.variants.map((v, idx) => idx === i ? { ...v, [key]: value } : v),
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
          <th>Pris</th>
          <th>Jämför pris (ord. pris)</th>
          <th>Inköpspris</th>
          <th>Marginal</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((v, i) => {
          const margin = v.price && v.cost ? ((v.price - v.cost) / v.price * 100).toFixed(1) : null;
          return (
            <tr key={v.id || i} style={{ cursor: 'default' }}>
              <td>{v.title || v.sku || `#${i + 1}`}</td>
              <td><input type="number" step="0.01" value={v.price ?? ''} onChange={e => setVariant(i, 'price', parseFloat(e.target.value) || 0)} /></td>
              <td><input type="number" step="0.01" value={v.compare_at_price ?? ''} onChange={e => setVariant(i, 'compare_at_price', e.target.value ? parseFloat(e.target.value) : null)} /></td>
              <td><input type="number" step="0.01" value={v.cost ?? ''} onChange={e => setVariant(i, 'cost', e.target.value ? parseFloat(e.target.value) : null)} /></td>
              <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>
                {margin != null ? `${margin}%` : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
