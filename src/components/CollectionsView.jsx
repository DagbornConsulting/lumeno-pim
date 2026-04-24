import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import {
  Plus, X, Save, Sparkles, Loader2, Search, Trash2,
  RefreshCw, Globe, AlertCircle, Image, CheckCircle2,
  Layers, Tag, Settings, FileText, ChevronDown, ChevronUp,
  Package, ArrowRight, Download,
} from 'lucide-react';
import './CollectionsView.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

function generateHandle(title) {
  return title.toLowerCase().replace(/[åä]/g, 'a').replace(/[ö]/g, 'o').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- Simple key-value metafields editor ----
function MetafieldsEditor({ metafields, onChange }) {
  const entries = Object.entries(metafields || {});

  const handleKeyChange = (oldKey, newKey) => {
    const next = {};
    for (const [k, v] of entries) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };

  const handleValueChange = (key, value) => {
    onChange({ ...metafields, [key]: value });
  };

  const handleAdd = () => {
    onChange({ ...metafields, 'custom.': '' });
  };

  const handleRemove = (key) => {
    const next = { ...metafields };
    delete next[key];
    onChange(next);
  };

  return (
    <div className="metafields-editor">
      {entries.map(([key, value]) => (
        <div key={key} className="metafield-row">
          <input
            className="form-input mono"
            value={key}
            onChange={e => handleKeyChange(key, e.target.value)}
            placeholder="namespace.key"
            style={{ flex: '0 0 220px' }}
          />
          <input
            className="form-input"
            value={value || ''}
            onChange={e => handleValueChange(key, e.target.value)}
            placeholder="Värde"
            style={{ flex: 1 }}
          />
          <button className="btn btn-ghost btn-icon" onClick={() => handleRemove(key)} title="Ta bort">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <button className="btn btn-secondary" onClick={handleAdd} style={{ marginTop: 8 }}>
        <Plus size={16} /> Lägg till metafält
      </button>
    </div>
  );
}

// ---- Smart collection rule builder ----
const RULE_COLUMNS = [
  { value: 'tag', label: 'Tagg' },
  { value: 'type', label: 'Produkttyp' },
  { value: 'vendor', label: 'Leverantör' },
  { value: 'title', label: 'Produkttitel' },
  { value: 'variant_price', label: 'Pris' },
];

const RULE_RELATIONS = [
  { value: 'equals', label: 'Är lika med' },
  { value: 'not_equals', label: 'Är inte lika med' },
  { value: 'contains', label: 'Innehåller' },
  { value: 'not_contains', label: 'Innehåller inte' },
  { value: 'starts_with', label: 'Börjar med' },
  { value: 'ends_with', label: 'Slutar med' },
  { value: 'greater_than', label: 'Större än' },
  { value: 'less_than', label: 'Mindre än' },
];

function RuleBuilder({ rules, disjunctive, onChange, onDisjunctiveChange }) {
  const addRule = () => {
    onChange([...rules, { column: 'tag', relation: 'equals', condition: '' }]);
  };

  const removeRule = (idx) => {
    onChange(rules.filter((_, i) => i !== idx));
  };

  const updateRule = (idx, field, value) => {
    onChange(rules.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };

  return (
    <div className="rule-builder">
      <div className="rule-disjunctive">
        <label className="form-label">Regellogik</label>
        <div className="toggle-group">
          <button
            className={`toggle-btn ${!disjunctive ? 'active' : ''}`}
            onClick={() => onDisjunctiveChange(false)}
          >
            Alla regler måste stämma (AND)
          </button>
          <button
            className={`toggle-btn ${disjunctive ? 'active' : ''}`}
            onClick={() => onDisjunctiveChange(true)}
          >
            Minst en regel måste stämma (OR)
          </button>
        </div>
      </div>

      <div className="rules-list">
        {rules.map((rule, idx) => (
          <div key={idx} className="rule-row">
            <select
              className="form-input"
              value={rule.column}
              onChange={e => updateRule(idx, 'column', e.target.value)}
              style={{ flex: '0 0 150px' }}
            >
              {RULE_COLUMNS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <select
              className="form-input"
              value={rule.relation}
              onChange={e => updateRule(idx, 'relation', e.target.value)}
              style={{ flex: '0 0 170px' }}
            >
              {RULE_RELATIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <input
              className="form-input"
              value={rule.condition}
              onChange={e => updateRule(idx, 'condition', e.target.value)}
              placeholder="Villkor"
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost btn-icon" onClick={() => removeRule(idx)} title="Ta bort regel">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <button className="btn btn-secondary" onClick={addRule} style={{ marginTop: 12 }}>
        <Plus size={16} /> Lägg till regel
      </button>
    </div>
  );
}

// ---- Collection Detail Modal ----
function CollectionDetail({ collection, stores, onSave, onClose, onDelete }) {
  const [edited, setEdited] = useState({ ...collection });
  const [activeTab, setActiveTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingField, setGeneratingField] = useState(null);
  const [productSearch, setProductSearch] = useState('');
  const [productSearchResults, setProductSearchResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const productSearchRef = useRef(null);

  const isNew = !edited.id || String(edited.id).startsWith('new-');
  const isManual = edited.collection_type === 'manual';

  const field = (key, value) => {
    setEdited(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'title' && !prev.handle) {
        next.handle = generateHandle(value);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(edited);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSync = async () => {
    if (isNew) { alert('Spara collection innan du synkar'); return; }
    setIsSyncing(true);
    try {
      const res = await fetch(`${API_URL}/db/collections/${edited.id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync misslyckades');
      setEdited(prev => ({ ...prev, sync_status: 'synced', shopify_collection_id: data.collection?.shopify_collection_id }));
      alert('Synkroniserad till Shopify!');
    } catch (err) {
      alert('Sync fel: ' + err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAIGenerate = async (aiField) => {
    if (isNew) { alert('Spara collection innan du genererar AI-innehåll'); return; }
    setIsGenerating(true);
    setGeneratingField(aiField);
    try {
      const res = await fetch(`${API_URL}/claude/collections/${edited.id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: aiField }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation misslyckades');

      if (aiField === 'all' && typeof data.result === 'object') {
        setEdited(prev => ({
          ...prev,
          description: data.result.description || prev.description,
          agent_summary: data.result.agentSummary || prev.agent_summary,
          short_description: data.result.shortDescription || prev.short_description,
          faq: data.result.faq || prev.faq,
          use_cases: data.result.useCases || prev.use_cases,
          seo_title: data.result.seoTitle || prev.seo_title,
          seo_description: data.result.seoDescription || prev.seo_description,
        }));
      } else if (aiField === 'faq') {
        if (Array.isArray(data.result)) setEdited(prev => ({ ...prev, faq: data.result }));
      } else if (aiField === 'seo' && typeof data.result === 'object') {
        setEdited(prev => ({
          ...prev,
          seo_title: data.result.seoTitle || prev.seo_title,
          seo_description: data.result.seoDescription || prev.seo_description,
        }));
      } else if (aiField === 'description') {
        setEdited(prev => ({ ...prev, description: data.result }));
      } else if (aiField === 'agentSummary') {
        setEdited(prev => ({ ...prev, agent_summary: data.result }));
      } else if (aiField === 'shortDescription') {
        setEdited(prev => ({ ...prev, short_description: data.result }));
      } else if (aiField === 'useCases') {
        setEdited(prev => ({ ...prev, use_cases: data.result }));
      }
    } catch (err) {
      alert('AI-fel: ' + err.message);
    } finally {
      setIsGenerating(false);
      setGeneratingField(null);
    }
  };

  const searchProducts = useCallback(async (query) => {
    if (!query || query.length < 2) { setProductSearchResults([]); return; }
    setProductSearchLoading(true);
    try {
      const res = await fetch(`${API_URL}/db/products?search=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();
      setProductSearchResults(data.data || []);
    } catch (err) {
      console.error('Product search error:', err);
    } finally {
      setProductSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchProducts(productSearch), 300);
    return () => clearTimeout(timer);
  }, [productSearch, searchProducts]);

  const handleAddProduct = async (product) => {
    if (isNew) { alert('Spara collection innan du lägger till produkter'); return; }
    try {
      const res = await fetch(`${API_URL}/db/collections/${edited.id}/add-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunde inte lägga till produkt');
      setEdited(prev => ({
        ...prev,
        collection_products: [...(prev.collection_products || []), data],
      }));
      setProductSearch('');
      setProductSearchResults([]);
    } catch (err) {
      alert('Fel: ' + err.message);
    }
  };

  const handleRemoveProduct = async (productId) => {
    if (isNew) return;
    try {
      const res = await fetch(`${API_URL}/db/collections/${edited.id}/products/${productId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Kunde inte ta bort produkt');
      setEdited(prev => ({
        ...prev,
        collection_products: (prev.collection_products || []).filter(cp => cp.product_id !== productId),
      }));
    } catch (err) {
      alert('Fel: ' + err.message);
    }
  };

  const tabs = [
    { id: 'general', label: 'Allmänt', icon: Package },
    { id: 'description', label: 'Beskrivning', icon: FileText },
    { id: 'ai-content', label: 'AI-innehåll', icon: Sparkles },
    { id: 'seo', label: 'SEO', icon: Globe },
    { id: 'metafields', label: 'Metafält', icon: Settings },
    { id: 'products', label: `Produkter (${(edited.collection_products || []).length})`, icon: Tag },
  ];

  const productCount = (edited.collection_products || []).length;
  const syncStatusLabel = edited.sync_status === 'synced' ? 'Synkad' : edited.sync_status === 'error' ? 'Fel' : 'Ej synkad';
  const syncStatusClass = edited.sync_status === 'synced' ? 'success' : edited.sync_status === 'error' ? 'error' : 'warning';

  return (
    <div className="collection-detail-overlay" onClick={onClose}>
      <div className="collection-detail-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="collection-detail-header">
          <div className="collection-detail-title-section">
            <div className="collection-thumbnail large">
              {edited.image_url ? (
                <img src={edited.image_url} alt={edited.title} />
              ) : (
                <span className="collection-initial">{(edited.title || 'C').charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div>
              <h2 className="collection-detail-title">{edited.title || 'Ny collection'}</h2>
              <div className="collection-detail-meta">
                <span className={`type-badge ${edited.collection_type}`}>
                  {edited.collection_type === 'smart' ? 'Smart' : 'Manuell'}
                </span>
                <span className={`sync-badge ${syncStatusClass}`}>{syncStatusLabel}</span>
                {edited.shopify_collection_id && (
                  <span className="shopify-id">Shopify #{edited.shopify_collection_id}</span>
                )}
              </div>
            </div>
          </div>
          <div className="collection-detail-actions">
            {!isNew && (
              <button className="btn btn-secondary" onClick={handleSync} disabled={isSyncing}>
                {isSyncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                Synka till Shopify
              </button>
            )}
            {!isNew && onDelete && (
              <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
                <Trash2 size={16} /> Ta bort
              </button>
            )}
            <button className="btn btn-secondary" onClick={onClose}>Avbryt</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
              Spara
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="collection-detail-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="collection-detail-content">

          {/* --- Allmänt --- */}
          {activeTab === 'general' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Grundläggande</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Titel *</label>
                    <input
                      type="text"
                      className="form-input"
                      value={edited.title || ''}
                      onChange={e => field('title', e.target.value)}
                      placeholder="Namn på collection"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Handle (URL)</label>
                    <input
                      type="text"
                      className="form-input mono"
                      value={edited.handle || ''}
                      onChange={e => field('handle', e.target.value)}
                      placeholder="min-collection"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Typ</label>
                    <div className="toggle-group">
                      <button
                        className={`toggle-btn ${!isManual ? '' : 'active'}`}
                        onClick={() => field('collection_type', 'manual')}
                        disabled={!!edited.shopify_collection_id}
                      >
                        Manuell
                      </button>
                      <button
                        className={`toggle-btn ${edited.collection_type === 'smart' ? 'active' : ''}`}
                        onClick={() => field('collection_type', 'smart')}
                        disabled={!!edited.shopify_collection_id}
                      >
                        Smart
                      </button>
                    </div>
                    {edited.shopify_collection_id && (
                      <span className="form-help">Typ kan inte ändras för importerade collections</span>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Sorteringsordning</label>
                    <select className="form-input" value={edited.sort_order || 'best-selling'} onChange={e => field('sort_order', e.target.value)}>
                      <option value="best-selling">Bästsäljare</option>
                      <option value="title-ascending">Titel A–Ö</option>
                      <option value="title-descending">Titel Ö–A</option>
                      <option value="price-ascending">Pris låg–hög</option>
                      <option value="price-descending">Pris hög–låg</option>
                      <option value="created-descending">Nyast först</option>
                      <option value="manual">Manuell</option>
                    </select>
                  </div>
                </div>

                <div className="form-group" style={{ marginTop: 16 }}>
                  <label className="form-label">
                    <span>Publicerad</span>
                    <input
                      type="checkbox"
                      checked={edited.published !== false}
                      onChange={e => field('published', e.target.checked)}
                      style={{ marginLeft: 10 }}
                    />
                  </label>
                  <span className="form-help">Synlig i butiken</span>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Bild</h3>
                <div className="form-group">
                  <label className="form-label">Bild-URL</label>
                  <input
                    type="url"
                    className="form-input"
                    value={edited.image_url || ''}
                    onChange={e => field('image_url', e.target.value)}
                    placeholder="https://cdn.shopify.com/..."
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Alt-text</label>
                  <input
                    type="text"
                    className="form-input"
                    value={edited.image_alt || ''}
                    onChange={e => field('image_alt', e.target.value)}
                    placeholder="Beskrivning av bilden"
                  />
                </div>
                {edited.image_url && (
                  <div className="collection-image-preview">
                    <img src={edited.image_url} alt={edited.image_alt || edited.title} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --- Beskrivning --- */}
          {activeTab === 'description' && (
            <div className="tab-content">
              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Beskrivning (body_html)</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('description')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'description' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera med AI
                  </button>
                </div>
                <div className="quill-wrapper">
                  <ReactQuill
                    value={edited.description || ''}
                    onChange={v => field('description', v)}
                    theme="snow"
                    style={{ minHeight: 200 }}
                  />
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Kort beskrivning</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('shortDescription')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'shortDescription' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea
                    className="form-textarea"
                    value={edited.short_description || ''}
                    onChange={e => field('short_description', e.target.value)}
                    maxLength={200}
                    rows={3}
                    placeholder="2–3 meningar som sammanfattar kategorin..."
                  />
                  <span className="char-counter">{(edited.short_description || '').length}/200</span>
                </div>
              </div>
            </div>
          )}

          {/* --- AI-innehåll --- */}
          {activeTab === 'ai-content' && (
            <div className="tab-content">
              {isNew && (
                <div className="ai-notice">
                  <AlertCircle size={18} />
                  Spara collection innan du genererar AI-innehåll
                </div>
              )}

              <div className="ai-context-info">
                <Package size={16} />
                <span>{productCount} produkter i denna collection används som kontext för AI</span>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Agent Summary (snabbfakta)</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('agentSummary')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'agentSummary' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea
                    className="form-textarea"
                    value={edited.agent_summary || ''}
                    onChange={e => field('agent_summary', e.target.value)}
                    rows={6}
                    placeholder="6–8 punkter om kategorin, en per rad..."
                  />
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Kort beskrivning</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('shortDescription')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'shortDescription' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea
                    className="form-textarea"
                    value={edited.short_description || ''}
                    onChange={e => field('short_description', e.target.value)}
                    rows={3}
                    placeholder="2–3 meningar..."
                    maxLength={200}
                  />
                  <span className="char-counter">{(edited.short_description || '').length}/200</span>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">FAQ</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('faq')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'faq' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera
                  </button>
                </div>
                <div className="faq-list">
                  {(edited.faq || []).map((item, idx) => (
                    <div key={idx} className="faq-item">
                      <div className="faq-item-header">
                        <input
                          className="form-input"
                          value={item.question}
                          onChange={e => {
                            const next = [...(edited.faq || [])];
                            next[idx] = { ...item, question: e.target.value };
                            field('faq', next);
                          }}
                          placeholder="Fråga..."
                        />
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => field('faq', (edited.faq || []).filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <textarea
                        className="form-textarea"
                        value={item.answer}
                        onChange={e => {
                          const next = [...(edited.faq || [])];
                          next[idx] = { ...item, answer: e.target.value };
                          field('faq', next);
                        }}
                        rows={3}
                        placeholder="Svar..."
                      />
                    </div>
                  ))}
                  <button
                    className="btn btn-secondary"
                    onClick={() => field('faq', [...(edited.faq || []), { question: '', answer: '' }])}
                    style={{ marginTop: 8 }}
                  >
                    <Plus size={16} /> Lägg till fråga
                  </button>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Användningsfall</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('useCases')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'useCases' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea
                    className="form-textarea"
                    value={edited.use_cases || ''}
                    onChange={e => field('use_cases', e.target.value)}
                    rows={4}
                    placeholder="Vem passar produkterna för, i vilka situationer..."
                  />
                </div>
              </div>

              <div className="ai-generate-all-bar">
                <button
                  className="btn btn-primary"
                  onClick={() => handleAIGenerate('all')}
                  disabled={isGenerating || isNew}
                >
                  {isGenerating && generatingField === 'all' ? <Loader2 size={18} className="spin" /> : <Sparkles size={18} />}
                  Generera allt AI-innehåll
                </button>
                <span className="form-help">Genererar beskrivning, agent summary, FAQ, användningsfall och SEO på en gång</span>
              </div>
            </div>
          )}

          {/* --- SEO --- */}
          {activeTab === 'seo' && (
            <div className="tab-content">
              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Sökmotoroptimering</h3>
                  <button
                    className="btn btn-secondary sidekick-btn"
                    onClick={() => handleAIGenerate('seo')}
                    disabled={isGenerating || isNew}
                  >
                    {isGenerating && generatingField === 'seo' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    Generera SEO
                  </button>
                </div>
                <div className="form-group">
                  <label className="form-label">SEO-titel</label>
                  <input
                    type="text"
                    className="form-input"
                    value={edited.seo_title || ''}
                    onChange={e => field('seo_title', e.target.value)}
                    maxLength={70}
                    placeholder="Max 60 tecken"
                  />
                  <span className={`char-counter ${(edited.seo_title || '').length > 60 ? 'over' : ''}`}>
                    {(edited.seo_title || '').length}/60
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label">Meta description</label>
                  <textarea
                    className="form-textarea"
                    value={edited.seo_description || ''}
                    onChange={e => field('seo_description', e.target.value)}
                    maxLength={160}
                    rows={3}
                    placeholder="Max 155 tecken"
                  />
                  <span className={`char-counter ${(edited.seo_description || '').length > 155 ? 'over' : ''}`}>
                    {(edited.seo_description || '').length}/155
                  </span>
                </div>
              </div>

              {/* SERP preview */}
              {(edited.seo_title || edited.title) && (
                <div className="form-section">
                  <h3 className="form-section-title">Google förhandsgranskning</h3>
                  <div className="serp-preview">
                    <div className="serp-url">
                      {stores?.[0]?.domain ? `${stores[0].domain}/collections/${edited.handle || ''}` : `dinbutik.se/collections/${edited.handle || ''}`}
                    </div>
                    <div className="serp-title">
                      {(edited.seo_title || edited.title || 'Collection utan titel').substring(0, 60)}
                    </div>
                    <div className="serp-description">
                      {(edited.seo_description || '').substring(0, 155) || 'Ingen meta description angiven.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* --- Metafält --- */}
          {activeTab === 'metafields' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Metafält</h3>
                <p className="form-help" style={{ marginBottom: 16 }}>
                  Använd formatet <code>namespace.key</code> (t.ex. <code>custom.material</code>)
                </p>
                <MetafieldsEditor
                  metafields={edited.metafields || {}}
                  onChange={v => field('metafields', v)}
                />
              </div>
            </div>
          )}

          {/* --- Produkter --- */}
          {activeTab === 'products' && (
            <div className="tab-content">
              {isManual ? (
                <>
                  <div className="form-section">
                    <h3 className="form-section-title">Lägg till produkter</h3>
                    {isNew && (
                      <div className="ai-notice" style={{ marginBottom: 12 }}>
                        <AlertCircle size={16} /> Spara collection innan du lägger till produkter
                      </div>
                    )}
                    <div className="product-search-container" ref={productSearchRef}>
                      <div style={{ position: 'relative' }}>
                        <Search size={16} className="product-search-icon" />
                        <input
                          type="text"
                          className="form-input"
                          style={{ paddingLeft: 36 }}
                          value={productSearch}
                          onChange={e => setProductSearch(e.target.value)}
                          placeholder="Sök på produkttitel eller SKU..."
                          disabled={isNew}
                        />
                      </div>
                      {productSearchResults.length > 0 && (
                        <div className="product-search-dropdown">
                          {productSearchLoading && (
                            <div className="product-search-loading"><Loader2 size={16} className="spin" /> Söker...</div>
                          )}
                          {productSearchResults.map(p => (
                            <div
                              key={p.id}
                              className="product-search-item"
                              onClick={() => handleAddProduct(p)}
                            >
                              <div className="product-search-thumb">
                                {p.images?.[0]?.url ? (
                                  <img src={p.images[0].url} alt={p.title} />
                                ) : (
                                  <Package size={16} />
                                )}
                              </div>
                              <div>
                                <div className="product-search-title">{p.title}</div>
                                {p.sku && <div className="product-search-sku">{p.sku}</div>}
                              </div>
                              <Plus size={16} className="product-search-add" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="form-section">
                    <h3 className="form-section-title">Produkter i collection ({productCount})</h3>
                    {productCount === 0 ? (
                      <div className="empty-products">
                        <Package size={32} />
                        <p>Inga produkter tillagda ännu</p>
                      </div>
                    ) : (
                      <div className="collection-products-list">
                        {(edited.collection_products || []).map(cp => {
                          const p = cp.products || {};
                          const thumb = p.images?.[0]?.url;
                          return (
                            <div key={cp.id || cp.product_id} className="collection-product-row">
                              <div className="collection-product-thumb">
                                {thumb ? <img src={thumb} alt={p.title} /> : <Package size={18} />}
                              </div>
                              <div className="collection-product-info">
                                <span className="collection-product-title">{p.title || 'Okänd produkt'}</span>
                                {p.sku && <span className="collection-product-sku">{p.sku}</span>}
                              </div>
                              <button
                                className="btn btn-ghost btn-icon"
                                onClick={() => handleRemoveProduct(cp.product_id)}
                                title="Ta bort"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="form-section">
                  <h3 className="form-section-title">Smart collection-regler</h3>
                  <p className="form-help" style={{ marginBottom: 16 }}>
                    Produkter matchas automatiskt mot dessa regler i Shopify.
                  </p>
                  <RuleBuilder
                    rules={edited.rules || []}
                    disjunctive={edited.disjunctive || false}
                    onChange={v => field('rules', v)}
                    onDisjunctiveChange={v => field('disjunctive', v)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm */}
      {showDeleteConfirm && (
        <div className="delete-confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="delete-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Ta bort collection?</h3>
            <p>Detta tar bort <strong>{edited.title}</strong> från PIM. Collection kvarstår i Shopify.</p>
            <div className="delete-confirm-actions">
              <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>Avbryt</button>
              <button className="btn btn-danger" onClick={() => { setShowDeleteConfirm(false); onDelete(edited.id); }}>
                <Trash2 size={16} /> Ta bort
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Import from Shopify modal ----
function ImportModal({ storeId, shopifyCollections, existingShopifyIds, onImport, onClose }) {
  const [selected, setSelected] = useState(new Set());
  const [isImporting, setIsImporting] = useState(false);

  const gapCollections = shopifyCollections.filter(c => !existingShopifyIds.has(c.shopify_collection_id));

  const toggleAll = () => {
    if (selected.size === gapCollections.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(gapCollections.map(c => c.shopify_collection_id)));
    }
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    setIsImporting(true);
    try {
      const res = await fetch(`${API_URL}/shopify/stores/${storeId}/import-collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import misslyckades');
      onImport(data);
    } catch (err) {
      alert('Importfel: ' + err.message);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="collection-detail-overlay" onClick={onClose}>
      <div className="import-modal" onClick={e => e.stopPropagation()}>
        <div className="import-modal-header">
          <h2>Importera collections från Shopify</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={20} /></button>
        </div>
        <p className="form-help" style={{ marginBottom: 16 }}>
          {gapCollections.length} collections finns i Shopify men inte i PIM
        </p>

        <div className="import-select-all">
          <label>
            <input
              type="checkbox"
              checked={selected.size === gapCollections.length && gapCollections.length > 0}
              onChange={toggleAll}
            />
            Välj alla
          </label>
        </div>

        <div className="import-collections-list">
          {gapCollections.map(c => (
            <div key={c.shopify_collection_id} className="import-collection-row">
              <input
                type="checkbox"
                checked={selected.has(c.shopify_collection_id)}
                onChange={e => {
                  const next = new Set(selected);
                  e.target.checked ? next.add(c.shopify_collection_id) : next.delete(c.shopify_collection_id);
                  setSelected(next);
                }}
              />
              <div className="import-collection-thumb">
                {c.image?.src ? (
                  <img src={c.image.src} alt={c.title} />
                ) : (
                  <span className="collection-initial">{(c.title || 'C').charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="import-collection-info">
                <span className="import-collection-title">{c.title}</span>
                <span className="import-collection-meta">
                  <span className={`type-badge ${c.collection_type}`}>
                    {c.collection_type === 'smart' ? 'Smart' : 'Manuell'}
                  </span>
                  <span className="shopify-id">ID: {c.shopify_collection_id}</span>
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="import-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Avbryt</button>
          <button
            className="btn btn-primary"
            onClick={handleImport}
            disabled={selected.size === 0 || isImporting}
          >
            {isImporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            Importera {selected.size > 0 ? `${selected.size} ` : ''}valda
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Create collection modal ----
function CreateModal({ stores, storeId, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('manual');
  const [handle, setHandle] = useState('');
  const [creating, setCreating] = useState(false);

  const computedHandle = handle || generateHandle(title);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/db/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          handle: computedHandle,
          collection_type: type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunde inte skapa collection');
      onCreate(data);
    } catch (err) {
      alert('Fel: ' + err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="collection-detail-overlay" onClick={onClose}>
      <div className="create-modal" onClick={e => e.stopPropagation()}>
        <div className="create-modal-header">
          <h2>Ny collection</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="form-group">
          <label className="form-label">Titel *</label>
          <input
            type="text"
            className="form-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="T.ex. Sommarskor"
            autoFocus
          />
        </div>
        <div className="form-group">
          <label className="form-label">Handle</label>
          <input
            type="text"
            className="form-input mono"
            value={handle}
            onChange={e => setHandle(e.target.value)}
            placeholder={computedHandle || 'auto-genereras'}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Typ</label>
          <div className="toggle-group">
            <button className={`toggle-btn ${type === 'manual' ? 'active' : ''}`} onClick={() => setType('manual')}>
              Manuell
            </button>
            <button className={`toggle-btn ${type === 'smart' ? 'active' : ''}`} onClick={() => setType('smart')}>
              Smart
            </button>
          </div>
        </div>
        <div className="create-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Avbryt</button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!title.trim() || creating}
          >
            {creating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            Skapa collection
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Main CollectionsView ----
export default function CollectionsView({ stores }) {
  const [collections, setCollections] = useState([]);
  const [shopifyCollections, setShopifyCollections] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(new Set());
  const [search, setSearch] = useState('');

  const storeId = stores?.[0]?.id || localStorage.getItem('pim_active_store_id');

  const loadCollections = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/db/collections`);
      if (res.ok) {
        const data = await res.json();
        setCollections(data);
      }
    } catch (err) {
      console.error('Failed to load collections:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadShopifyCollections = async () => {
    if (!storeId) return;
    try {
      const res = await fetch(`${API_URL}/shopify/stores/${storeId}/collections`);
      if (res.ok) {
        const data = await res.json();
        setShopifyCollections(data);
      }
    } catch (err) {
      console.error('Failed to load Shopify collections:', err);
    }
  };

  useEffect(() => {
    loadCollections();
    loadShopifyCollections();
  }, [storeId]);

  const existingShopifyIds = new Set(collections.map(c => c.shopify_collection_id).filter(Boolean));
  const gapCount = shopifyCollections.filter(c => !existingShopifyIds.has(c.shopify_collection_id)).length;

  const filteredCollections = collections.filter(c =>
    !search || c.title.toLowerCase().includes(search.toLowerCase()) || (c.handle || '').includes(search.toLowerCase())
  );

  const handleOpenDetail = async (collection) => {
    // Load full collection with products
    try {
      const res = await fetch(`${API_URL}/db/collections/${collection.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedCollection(data);
      } else {
        setSelectedCollection(collection);
      }
    } catch {
      setSelectedCollection(collection);
    }
    setShowDetail(true);
  };

  const handleSave = async (edited) => {
    try {
      const isNew = !edited.id || String(edited.id).startsWith('new-');
      if (isNew) {
        const res = await fetch(`${API_URL}/db/collections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edited),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Kunde inte skapa');
        setCollections(prev => [...prev, data]);
        setSelectedCollection(data);
      } else {
        const res = await fetch(`${API_URL}/db/collections/${edited.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edited),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Kunde inte spara');
        setCollections(prev => prev.map(c => c.id === edited.id ? data : c));
        setSelectedCollection(data);
      }
    } catch (err) {
      alert('Fel vid sparande: ' + err.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`${API_URL}/db/collections/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Kunde inte ta bort');
      setCollections(prev => prev.filter(c => c.id !== id));
      setShowDetail(false);
      setSelectedCollection(null);
    } catch (err) {
      alert('Fel: ' + err.message);
    }
  };

  const handleSync = async (collectionId, e) => {
    e.stopPropagation();
    setSyncing(prev => new Set(prev).add(collectionId));
    try {
      const res = await fetch(`${API_URL}/db/collections/${collectionId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync misslyckades');
      setCollections(prev => prev.map(c => c.id === collectionId ? { ...c, sync_status: 'synced', shopify_collection_id: data.collection?.shopify_collection_id } : c));
    } catch (err) {
      alert('Sync fel: ' + err.message);
      setCollections(prev => prev.map(c => c.id === collectionId ? { ...c, sync_status: 'error' } : c));
    } finally {
      setSyncing(prev => { const next = new Set(prev); next.delete(collectionId); return next; });
    }
  };

  const handleImportComplete = (result) => {
    alert(`Importerade ${result.imported} collections. Hoppade över ${result.skipped}.`);
    setShowImportModal(false);
    loadCollections();
    loadShopifyCollections();
  };

  const handleCreateComplete = (collection) => {
    setCollections(prev => [...prev, collection]);
    setShowCreateModal(false);
    setSelectedCollection(collection);
    setShowDetail(true);
  };

  const getSyncStatus = (c) => {
    if (c.sync_status === 'synced') return { label: 'Synkad', cls: 'synced' };
    if (c.sync_status === 'error') return { label: 'Fel', cls: 'error' };
    return { label: 'Ej synkad', cls: 'pending' };
  };

  return (
    <div className="collections-view">
      {/* Header */}
      <div className="collections-header">
        <div>
          <h1 className="content-title">Collections</h1>
          <p className="content-subtitle">{collections.length} collections i PIM</p>
        </div>
        <div className="collections-header-actions">
          <div className="search-container" style={{ maxWidth: 280 }}>
            <Search className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Sök collections..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button className="btn btn-secondary" onClick={loadShopifyCollections} title="Uppdatera från Shopify">
            <RefreshCw size={16} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={16} /> Ny collection
          </button>
        </div>
      </div>

      {/* Gap banner */}
      {gapCount > 0 && (
        <div className="gap-banner">
          <AlertCircle size={18} />
          <span><strong>{gapCount} collections</strong> finns i Shopify men saknas i PIM</span>
          <button className="btn btn-secondary" onClick={() => setShowImportModal(true)} style={{ marginLeft: 'auto' }}>
            <Download size={16} /> Importera
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="collections-loading">
          <Loader2 size={32} className="spin" />
          <p>Laddar collections...</p>
        </div>
      ) : filteredCollections.length === 0 ? (
        <div className="collections-empty">
          <Layers size={48} />
          <h3>{search ? 'Inga collections matchar sökningen' : 'Inga collections än'}</h3>
          <p>{search ? 'Prova en annan sökning' : 'Skapa din första collection eller importera från Shopify'}</p>
          {!search && (
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                <Plus size={16} /> Skapa collection
              </button>
              {gapCount > 0 && (
                <button className="btn btn-secondary" onClick={() => setShowImportModal(true)}>
                  <Download size={16} /> Importera från Shopify
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="collections-table">
          {/* Table header */}
          <div className="collections-table-header">
            <div style={{ flex: '0 0 56px' }}>Bild</div>
            <div style={{ flex: 1 }}>Titel</div>
            <div style={{ flex: '0 0 100px' }}>Typ</div>
            <div style={{ flex: '0 0 80px', textAlign: 'center' }}>Produkter</div>
            <div style={{ flex: '0 0 110px' }}>Status</div>
            <div style={{ flex: '0 0 140px', textAlign: 'right' }}>Åtgärder</div>
          </div>

          {/* Rows */}
          {filteredCollections.map(c => {
            const status = getSyncStatus(c);
            const isSyncing = syncing.has(c.id);
            return (
              <div key={c.id} className="collection-row" onClick={() => handleOpenDetail(c)}>
                {/* Thumbnail */}
                <div className="collection-thumbnail" style={{ flex: '0 0 56px' }}>
                  {c.image_url ? (
                    <img src={c.image_url} alt={c.title} />
                  ) : (
                    <span className="collection-initial">{(c.title || 'C').charAt(0).toUpperCase()}</span>
                  )}
                </div>

                {/* Info */}
                <div className="collection-info" style={{ flex: 1 }}>
                  <div className="collection-title">{c.title}</div>
                  {c.handle && <div className="collection-handle">/{c.handle}</div>}
                </div>

                {/* Type badge */}
                <div style={{ flex: '0 0 100px' }}>
                  <span className={`type-badge ${c.collection_type}`}>
                    {c.collection_type === 'smart' ? 'Smart' : 'Manuell'}
                  </span>
                </div>

                {/* Product count */}
                <div style={{ flex: '0 0 80px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
                  {c.products_count ?? '—'}
                </div>

                {/* Sync status */}
                <div style={{ flex: '0 0 110px' }}>
                  <span className={`sync-status-badge ${status.cls}`}>{status.label}</span>
                </div>

                {/* Actions */}
                <div className="collection-actions" style={{ flex: '0 0 140px' }} onClick={e => e.stopPropagation()}>
                  <button
                    className="action-btn"
                    onClick={() => handleOpenDetail(c)}
                    title="Redigera"
                  >
                    <Settings size={16} />
                  </button>
                  <button
                    className="action-btn"
                    onClick={(e) => handleSync(c.id, e)}
                    title="Synka till Shopify"
                    disabled={isSyncing}
                  >
                    {isSyncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                  </button>
                  <button
                    className="action-btn delete-btn"
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Ta bort "${c.title}"?`)) handleDelete(c.id); }}
                    title="Ta bort"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showDetail && selectedCollection && (
        <CollectionDetail
          collection={selectedCollection}
          stores={stores}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => { setShowDetail(false); setSelectedCollection(null); }}
        />
      )}

      {showCreateModal && (
        <CreateModal
          stores={stores}
          storeId={storeId}
          onCreate={handleCreateComplete}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {showImportModal && storeId && (
        <ImportModal
          storeId={storeId}
          shopifyCollections={shopifyCollections}
          existingShopifyIds={existingShopifyIds}
          onImport={handleImportComplete}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}
