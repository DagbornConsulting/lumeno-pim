import { useState, useEffect } from 'react';
import { Plus, Upload, Trash2 } from 'lucide-react';
import * as api from '../api.js';

const TYPE_OPTIONS = [
  { value: 'single_line_text_field', label: 'Text (en rad)' },
  { value: 'multi_line_text_field', label: 'Text (flera rader)' },
  { value: 'number_integer', label: 'Heltal' },
  { value: 'number_decimal', label: 'Decimal' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'color', label: 'Färg' },
  { value: 'date', label: 'Datum' },
  { value: 'date_time', label: 'Datum + tid' },
  { value: 'url', label: 'URL' },
  { value: 'json', label: 'JSON' },
  { value: 'metaobject_reference', label: 'Metaobject referens' },
  { value: 'product_reference', label: 'Produkt referens' },
  { value: 'collection_reference', label: 'Kollektion referens' },
];

export default function MetafieldsManager({ onToast }) {
  const [defs, setDefs] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    namespace: 'custom', key: '', name: '', description: '',
    type: 'single_line_text_field', owner_type: 'PRODUCT', pin: true,
  });

  useEffect(() => { load(); }, []);

  async function load() {
    try { setDefs(await api.listMetafieldDefs()); }
    catch (e) { onToast(e.message, 'error'); }
  }

  async function create() {
    if (!form.key || !form.name) {
      onToast('Key och Name krävs', 'error');
      return;
    }
    try {
      await api.createMetafieldDef(form);
      setShowForm(false);
      setForm({ namespace: 'custom', key: '', name: '', description: '', type: 'single_line_text_field', owner_type: 'PRODUCT', pin: true });
      onToast('Definition skapad', 'success');
      await load();
    } catch (e) { onToast(e.message, 'error'); }
  }

  async function pushToShopify(id) {
    try {
      await api.pushMetafieldDef(id);
      onToast('Pushad till Shopify', 'success');
      await load();
    } catch (e) { onToast(e.message, 'error'); }
  }

  async function remove(id) {
    if (!confirm('Ta bort denna definition från PIM? (Tas inte bort från Shopify)')) return;
    try { await api.deleteMetafieldDef(id); await load(); }
    catch (e) { onToast(e.message, 'error'); }
  }

  return (
    <>
      <div className="page-header">
        <h1>Metafält</h1>
        <button className="primary" onClick={() => setShowForm(true)}>
          <Plus size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Ny definition
        </button>
      </div>

      <p style={{ color: 'var(--fg-muted)', marginBottom: 16 }}>
        Definiera metafält i PIM och pusha dem till Shopify. Används sedan på produktnivå.
      </p>

      {defs.length === 0 ? (
        <div className="empty">Inga metafält-definitioner. Skapa en ny med knappen ovan.</div>
      ) : (
        <table className="product-table">
          <thead>
            <tr>
              <th>Namn</th>
              <th>Namespace.Key</th>
              <th>Typ</th>
              <th>Owner</th>
              <th>Sync</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {defs.map(d => (
              <tr key={d.id} style={{ cursor: 'default' }}>
                <td>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  {d.description && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{d.description}</div>}
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{d.namespace}.{d.key}</td>
                <td>{d.type}</td>
                <td>{d.owner_type}</td>
                <td>
                  <span className={`status-badge ${d.sync_status === 'synced' ? 'synced' : 'new'}`}>
                    {d.sync_status === 'synced' ? 'Synkad' : 'Ej pushad'}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {d.sync_status !== 'synced' && (
                    <button className="sm" onClick={() => pushToShopify(d.id)} title="Pusha till Shopify">
                      <Upload size={12} />
                    </button>
                  )}
                  <button className="sm ghost" onClick={() => remove(d.id)}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Ny metafält-definition</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label>Visningsnamn *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="t.ex. Material" />
              </div>
              <div className="form-row">
                <div>
                  <label>Namespace *</label>
                  <input value={form.namespace} onChange={e => setForm({ ...form, namespace: e.target.value })} />
                </div>
                <div>
                  <label>Key *</label>
                  <input value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} placeholder="material" />
                </div>
              </div>
              <div>
                <label>Typ *</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label>Owner</label>
                <select value={form.owner_type} onChange={e => setForm({ ...form, owner_type: e.target.value })}>
                  <option value="PRODUCT">Produkt</option>
                  <option value="PRODUCTVARIANT">Produktvariant</option>
                </select>
              </div>
              <div>
                <label>Beskrivning</label>
                <textarea rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button onClick={() => setShowForm(false)}>Avbryt</button>
              <button className="primary" onClick={create}>Skapa</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
