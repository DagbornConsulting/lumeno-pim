import { useState, useEffect } from 'react';
import { Plus, Trash2, Sparkles, Settings, Loader2, CheckCircle2 } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const FIELD_TYPES = [
  { value: 'single_line_text', label: 'Text (en rad)' },
  { value: 'multi_line_text', label: 'Text (flerrad)' },
  { value: 'rich_text', label: 'Rich text (HTML)' },
  { value: 'json', label: 'JSON' },
  { value: 'number', label: 'Nummer' },
  { value: 'boolean', label: 'Ja/Nej' },
  { value: 'color', label: 'Färg' },
  { value: 'url', label: 'URL' },
  { value: 'date', label: 'Datum' },
];

export default function MetafieldsTab({ editedProduct, onMetafieldChange, stores }) {
  const [definitions, setDefinitions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newField, setNewField] = useState({ name: '', key: '', namespace: 'custom', field_type: 'single_line_text', description: '' });
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    loadDefinitions();
  }, []);

  const loadDefinitions = async () => {
    try {
      const res = await fetch(`${API_URL}/db/metafields`);
      if (res.ok) {
        const data = await res.json();
        setDefinitions(data);
      }
    } catch (err) {
      console.error('Failed to load metafield definitions:', err);
    } finally {
      setLoading(false);
    }
  };

  const createDefinition = async () => {
    if (!newField.name || !newField.key) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/db/metafields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newField)
      });
      if (res.ok) {
        const created = await res.json();
        setDefinitions(prev => [...prev, created]);
        setNewField({ name: '', key: '', namespace: 'custom', field_type: 'single_line_text', description: '' });
        setShowCreate(false);
      }
    } catch (err) {
      console.error('Failed to create metafield:', err);
    } finally {
      setCreating(false);
    }
  };

  const deleteDefinition = async (id) => {
    try {
      const res = await fetch(`${API_URL}/db/metafields/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setDefinitions(prev => prev.filter(d => d.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete metafield:', err);
    }
  };

  const aiSuggest = async () => {
    setSuggesting(true);
    setSuggestions([]);
    try {
      const existingKeys = definitions.map(d => d.name);
      const res = await fetch(`${API_URL}/db/metafields/ai-suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productType: editedProduct.type || '',
          category: editedProduct.productCategory || '',
          existingFields: existingKeys
        })
      });
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data);
      }
    } catch (err) {
      console.error('AI suggest failed:', err);
    } finally {
      setSuggesting(false);
    }
  };

  const addSuggestion = async (suggestion) => {
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/db/metafields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suggestion)
      });
      if (res.ok) {
        const created = await res.json();
        setDefinitions(prev => [...prev, created]);
        setSuggestions(prev => prev.filter(s => s.key !== suggestion.key));
      }
    } catch (err) {
      console.error('Failed to add suggestion:', err);
    } finally {
      setCreating(false);
    }
  };

  const renderFieldInput = (def) => {
    const fullKey = `${def.namespace}.${def.key}`;
    const value = editedProduct.metafields?.[fullKey] || '';

    if (def.field_type === 'multi_line_text' || def.field_type === 'rich_text') {
      return (
        <textarea className="form-input form-textarea" rows={3}
          value={value}
          onChange={e => onMetafieldChange(fullKey, e.target.value)}
          placeholder={def.description || ''} />
      );
    }
    if (def.field_type === 'json') {
      return (
        <textarea className="form-input form-textarea mono" rows={4}
          value={typeof value === 'object' ? JSON.stringify(value, null, 2) : value}
          onChange={e => onMetafieldChange(fullKey, e.target.value)}
          placeholder='[{"key": "value"}]'
          style={{ fontSize: '12px' }} />
      );
    }
    if (def.field_type === 'boolean') {
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={value === 'true' || value === true}
            onChange={e => onMetafieldChange(fullKey, e.target.checked ? 'true' : 'false')} />
          <span>{value === 'true' || value === true ? 'Ja' : 'Nej'}</span>
        </label>
      );
    }
    if (def.field_type === 'color') {
      return (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input type="color" value={value || '#000000'}
            onChange={e => onMetafieldChange(fullKey, e.target.value)}
            style={{ width: 40, height: 36, padding: 2, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }} />
          <input type="text" className="form-input" style={{ flex: 1 }}
            value={value} onChange={e => onMetafieldChange(fullKey, e.target.value)}
            placeholder="#000000" />
        </div>
      );
    }
    if (def.field_type === 'number') {
      return (
        <input type="number" className="form-input"
          value={value} onChange={e => onMetafieldChange(fullKey, e.target.value)} />
      );
    }
    if (def.field_type === 'date') {
      return (
        <input type="date" className="form-input"
          value={value} onChange={e => onMetafieldChange(fullKey, e.target.value)} />
      );
    }
    if (def.field_type === 'url') {
      return (
        <input type="url" className="form-input"
          value={value} onChange={e => onMetafieldChange(fullKey, e.target.value)}
          placeholder="https://..." />
      );
    }
    return (
      <input type="text" className="form-input"
        value={value} onChange={e => onMetafieldChange(fullKey, e.target.value)}
        placeholder={def.description || ''} />
    );
  };

  if (loading) {
    return (
      <div className="tab-content">
        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} className="spin" />
        </div>
      </div>
    );
  }

  const systemFields = definitions.filter(d => d.is_system);
  const customFields = definitions.filter(d => !d.is_system);

  return (
    <div className="tab-content">
      {systemFields.length > 0 && (
        <div className="form-section">
          <h3 className="form-section-title">Systemfält</h3>
          <p className="form-section-description">Standardfält som PIM:et hanterar. Dessa fylls automatiskt av AI-innehåll-tabben.</p>
          <div className="form-grid metafield-grid">
            {systemFields.map(def => {
              const fullKey = `${def.namespace}.${def.key}`;
              const hasValue = !!(editedProduct.metafields?.[fullKey]);
              return (
                <div key={def.id} className={`form-group ${hasValue ? '' : ''}`}>
                  <label className="form-label">
                    <span>{def.name}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: '8px' }}>{def.namespace}.{def.key}</span>
                    {hasValue && <CheckCircle2 size={12} style={{ color: 'var(--success)', marginLeft: '4px' }} />}
                  </label>
                  {renderFieldInput(def)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="form-section">
        <div className="form-section-header">
          <div>
            <h3 className="form-section-title">Egna metafält</h3>
            <p className="form-section-description">
              Skapa fält för denna butiks behov. Synkas till Shopify som metafält-definitioner.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-accent" onClick={aiSuggest} disabled={suggesting}>
              {suggesting ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
              AI-förslag
            </button>
            <button className="btn btn-secondary" onClick={() => setShowCreate(!showCreate)}>
              <Plus size={16} /> Nytt fält
            </button>
          </div>
        </div>

        {suggestions.length > 0 && (
          <div style={{
            background: 'var(--accent-dim)', border: '1px solid var(--accent)',
            borderRadius: '8px', padding: '16px', marginBottom: '16px'
          }}>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>
              <Sparkles size={14} style={{ display: 'inline', marginRight: '6px' }} />
              AI föreslår dessa metafält:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {suggestions.map(s => (
                <div key={s.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'var(--surface)', borderRadius: '6px', padding: '10px 12px'
                }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{s.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {s.namespace}.{s.key} &bull; {FIELD_TYPES.find(t => t.value === s.field_type)?.label || s.field_type}
                      {s.description && ` &bull; ${s.description}`}
                    </div>
                  </div>
                  <button className="btn btn-secondary" style={{ fontSize: '12px' }}
                    onClick={() => addSuggestion(s)} disabled={creating}>
                    <Plus size={14} /> Lägg till
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {showCreate && (
          <div style={{
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '8px', padding: '16px', marginBottom: '16px'
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Skapa nytt metafält</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label className="form-label">Namn</label>
                <input type="text" className="form-input" placeholder="T.ex. Skötselråd"
                  value={newField.name}
                  onChange={e => {
                    const name = e.target.value;
                    const key = name.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                    setNewField(prev => ({ ...prev, name, key }));
                  }} />
              </div>
              <div className="form-group">
                <label className="form-label">Nyckel (auto)</label>
                <input type="text" className="form-input mono" value={newField.key}
                  onChange={e => setNewField(prev => ({ ...prev, key: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Typ</label>
                <select className="form-input" value={newField.field_type}
                  onChange={e => setNewField(prev => ({ ...prev, field_type: e.target.value }))}>
                  {FIELD_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Namespace</label>
                <select className="form-input" value={newField.namespace}
                  onChange={e => setNewField(prev => ({ ...prev, namespace: e.target.value }))}>
                  <option value="custom">custom</option>
                  <option value="filters">filters</option>
                  <option value="theme">theme</option>
                </select>
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Beskrivning</label>
                <input type="text" className="form-input" placeholder="Kort beskrivning av fältet"
                  value={newField.description}
                  onChange={e => setNewField(prev => ({ ...prev, description: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button className="btn btn-primary" onClick={createDefinition} disabled={creating || !newField.name}>
                {creating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                Skapa
              </button>
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Avbryt</button>
            </div>
          </div>
        )}

        {customFields.length > 0 ? (
          <div className="form-grid metafield-grid">
            {customFields.map(def => {
              const fullKey = `${def.namespace}.${def.key}`;
              const hasValue = !!(editedProduct.metafields?.[fullKey]);
              return (
                <div key={def.id} className="form-group">
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>
                      {def.name}
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: '8px' }}>{def.namespace}.{def.key}</span>
                      {hasValue && <CheckCircle2 size={12} style={{ color: 'var(--success)', marginLeft: '4px' }} />}
                    </span>
                    <button className="btn-icon-sm danger" onClick={() => deleteDefinition(def.id)}
                      title="Ta bort fält">
                      <Trash2 size={12} />
                    </button>
                  </label>
                  {renderFieldInput(def)}
                </div>
              );
            })}
          </div>
        ) : !showCreate && suggestions.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)', fontSize: '13px' }}>
            Inga egna metafält skapade. Klicka "AI-förslag" för att få förslag baserat på produkttyp.
          </div>
        )}
      </div>
    </div>
  );
}
