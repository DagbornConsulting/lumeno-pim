import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import * as api from '../../api.js';

export default function TabMetafields({ draft, setDraft }) {
  const [defs, setDefs] = useState([]);
  const metafields = draft.metafields || [];

  useEffect(() => {
    api.listMetafieldDefs().then(setDefs).catch(() => {});
  }, []);

  function set(i, k, v) {
    setDraft(d => ({ ...d, metafields: d.metafields.map((mf, idx) => idx === i ? { ...mf, [k]: v } : mf) }));
  }
  function add() {
    setDraft(d => ({
      ...d,
      metafields: [...(d.metafields || []), { namespace: 'custom', key: '', value: '', type: 'single_line_text_field' }],
    }));
  }
  function addFromDef(def) {
    setDraft(d => ({
      ...d,
      metafields: [...(d.metafields || []), { namespace: def.namespace, key: def.key, value: '', type: def.type }],
    }));
  }
  function remove(i) {
    setDraft(d => ({ ...d, metafields: d.metafields.filter((_, idx) => idx !== i) }));
  }

  const unused = defs.filter(d =>
    !metafields.some(mf => mf.namespace === d.namespace && mf.key === d.key)
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {unused.length > 0 && (
          <>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Lägg till från definition:</span>
            {unused.map(d => (
              <button key={d.id} className="sm" onClick={() => addFromDef(d)}>
                {d.namespace}.{d.key}
              </button>
            ))}
          </>
        )}
        <button className="primary sm" style={{ marginLeft: 'auto' }} onClick={add}>
          <Plus size={12} /> Eget metafält
        </button>
      </div>

      {metafields.length === 0 ? (
        <div className="empty">Inga metafält.</div>
      ) : (
        <table className="product-table">
          <thead>
            <tr>
              <th>Namespace</th>
              <th>Key</th>
              <th>Värde</th>
              <th>Typ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {metafields.map((mf, i) => (
              <tr key={mf.id || i} style={{ cursor: 'default' }}>
                <td><input value={mf.namespace} onChange={e => set(i, 'namespace', e.target.value)} /></td>
                <td><input value={mf.key} onChange={e => set(i, 'key', e.target.value)} /></td>
                <td><input value={mf.value || ''} onChange={e => set(i, 'value', e.target.value)} /></td>
                <td>
                  <select value={mf.type} onChange={e => set(i, 'type', e.target.value)}>
                    <option value="single_line_text_field">text (en rad)</option>
                    <option value="multi_line_text_field">text (flera rader)</option>
                    <option value="number_integer">heltal</option>
                    <option value="number_decimal">decimal</option>
                    <option value="boolean">boolean</option>
                    <option value="color">color</option>
                    <option value="date">datum</option>
                    <option value="url">URL</option>
                    <option value="json">JSON</option>
                  </select>
                </td>
                <td><button className="ghost sm" onClick={() => remove(i)}><Trash2 size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
