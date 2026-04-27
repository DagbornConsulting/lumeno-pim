import React, { useState, useEffect } from 'react';
import { 
  Link2, ChevronRight, Plus, Trash2, Save, RefreshCw,
  CheckCircle2, AlertCircle, Download, Settings, Store
} from 'lucide-react';
import { pimFields, defaultShopifyMapping } from '../data/demoData';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function MappingConfig({ stores, selectedStoreId, onStoreSelect }) {
  const [mapping, setMapping] = useState(null);
  const [shopifyMetafields, setShopifyMetafields] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const selectedStore = stores.find(s => s.id === selectedStoreId);

  useEffect(() => {
    if (selectedStoreId) {
      loadMapping(selectedStoreId);
      loadShopifyMetafields(selectedStoreId);
    }
  }, [selectedStoreId]);

  const loadMapping = async (storeId) => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/mappings/${storeId}`);
      if (response.ok) {
        const data = await response.json();
        setMapping(data);
      } else {
        // Use default mapping
        setMapping({
          storeId,
          ...defaultShopifyMapping
        });
      }
    } catch (error) {
      console.error('Load mapping error:', error);
      setMapping({ storeId, ...defaultShopifyMapping });
    } finally {
      setIsLoading(false);
    }
  };

  const loadShopifyMetafields = async (storeId) => {
    try {
      const response = await fetch(`${API_URL}/shopify/metafields/${storeId}`);
      if (response.ok) {
        const data = await response.json();
        setShopifyMetafields(data.metafields || []);
      }
    } catch (error) {
      console.error('Load metafields error:', error);
    }
  };

  const updateMapping = (section, field, value) => {
    setMapping(prev => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value
      }
    }));
    setHasChanges(true);
  };

  const updateMetafieldMapping = (index, key, value) => {
    setMapping(prev => {
      const newMetafields = [...(prev.metafields || [])];
      newMetafields[index] = { ...newMetafields[index], [key]: value };
      return { ...prev, metafields: newMetafields };
    });
    setHasChanges(true);
  };

  const addMetafieldMapping = () => {
    setMapping(prev => ({
      ...prev,
      metafields: [
        ...(prev.metafields || []),
        { pimField: '', namespace: 'custom', key: '', enabled: true }
      ]
    }));
    setHasChanges(true);
  };

  const removeMetafieldMapping = (index) => {
    setMapping(prev => ({
      ...prev,
      metafields: prev.metafields.filter((_, i) => i !== index)
    }));
    setHasChanges(true);
  };

  const saveMapping = async () => {
    setIsSaving(true);
    try {
      await fetch(`${API_URL}/mappings/${selectedStoreId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping })
      });
      setHasChanges(false);
    } catch (error) {
      console.error('Save mapping error:', error);
      alert('Kunde inte spara mappningen');
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedStoreId) {
    return (
      <div className="mapping-empty">
        <Store size={48} />
        <h3>Välj en butik</h3>
        <p>Välj en butik i listan till vänster för att konfigurera fältmappning.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mapping-loading">
        <RefreshCw size={24} className="spin" />
        <span>Laddar mappning...</span>
      </div>
    );
  }

  return (
    <div className="mapping-config">
      <div className="mapping-header">
        <div className="mapping-store-info">
          <Store size={20} />
          <div>
            <h3>{selectedStore?.name}</h3>
            <span>{selectedStore?.domain}</span>
          </div>
        </div>
        <div className="mapping-actions">
          <button 
            className="btn btn-secondary"
            onClick={() => loadShopifyMetafields(selectedStoreId)}
          >
            <Download size={16} />
            Hämta metafält från Shopify
          </button>
          <button 
            className="btn btn-primary"
            onClick={saveMapping}
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? <RefreshCw size={16} className="spin" /> : <Save size={16} />}
            Spara mappning
          </button>
        </div>
      </div>

      {/* Standard Product Fields */}
      <div className="mapping-section">
        <h4 className="mapping-section-title">
          <Link2 size={18} />
          Produktfält
        </h4>
        <p className="mapping-section-desc">
          Mappning mellan PIM-fält och Shopify produktfält.
        </p>
        
        <div className="mapping-table">
          <div className="mapping-table-header">
            <div>PIM-fält</div>
            <div></div>
            <div>Shopify-fält</div>
            <div>Aktiverad</div>
          </div>
          
          {Object.entries(mapping?.product || {}).map(([shopifyField, pimField]) => (
            <div key={shopifyField} className="mapping-row">
              <div className="mapping-field pim">
                <select
                  className="mapping-select"
                  value={pimField}
                  onChange={e => updateMapping('product', shopifyField, e.target.value)}
                >
                  <option value="">-- Välj fält --</option>
                  {pimFields.standard.map(f => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="mapping-arrow">
                <ChevronRight size={16} />
              </div>
              <div className="mapping-field shopify">
                <code>{shopifyField}</code>
              </div>
              <div className="mapping-toggle">
                <input type="checkbox" defaultChecked={true} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Variant Fields */}
      <div className="mapping-section">
        <h4 className="mapping-section-title">
          <Link2 size={18} />
          Variantfält
        </h4>
        <p className="mapping-section-desc">
          Mappning för produktvarianter (pris, SKU, lager etc).
        </p>
        
        <div className="mapping-table">
          <div className="mapping-table-header">
            <div>PIM-fält</div>
            <div></div>
            <div>Shopify-fält</div>
            <div>Aktiverad</div>
          </div>
          
          {Object.entries(mapping?.variant || {}).map(([shopifyField, pimField]) => (
            <div key={shopifyField} className="mapping-row">
              <div className="mapping-field pim">
                <select
                  className="mapping-select"
                  value={pimField}
                  onChange={e => updateMapping('variant', shopifyField, e.target.value)}
                >
                  <option value="">-- Välj fält --</option>
                  {pimFields.variant.map(f => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="mapping-arrow">
                <ChevronRight size={16} />
              </div>
              <div className="mapping-field shopify">
                <code>variants[].{shopifyField}</code>
              </div>
              <div className="mapping-toggle">
                <input type="checkbox" defaultChecked={true} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SEO Fields */}
      <div className="mapping-section">
        <h4 className="mapping-section-title">
          <Link2 size={18} />
          SEO-fält
        </h4>
        <p className="mapping-section-desc">
          Mappning för SEO-titel och meta-beskrivning.
        </p>
        
        <div className="mapping-table">
          <div className="mapping-table-header">
            <div>PIM-fält</div>
            <div></div>
            <div>Shopify Metafield</div>
            <div>Aktiverad</div>
          </div>
          
          <div className="mapping-row">
            <div className="mapping-field pim">
              <span className="mapping-field-label">SEO Titel</span>
            </div>
            <div className="mapping-arrow">
              <ChevronRight size={16} />
            </div>
            <div className="mapping-field shopify">
              <code>metafields.global.title_tag</code>
            </div>
            <div className="mapping-toggle">
              <input type="checkbox" defaultChecked={true} />
            </div>
          </div>
          
          <div className="mapping-row">
            <div className="mapping-field pim">
              <span className="mapping-field-label">Meta Beskrivning</span>
            </div>
            <div className="mapping-arrow">
              <ChevronRight size={16} />
            </div>
            <div className="mapping-field shopify">
              <code>metafields.global.description_tag</code>
            </div>
            <div className="mapping-toggle">
              <input type="checkbox" defaultChecked={true} />
            </div>
          </div>
        </div>
      </div>

      {/* Metafields */}
      <div className="mapping-section">
        <div className="mapping-section-header">
          <div>
            <h4 className="mapping-section-title">
              <Settings size={18} />
              Metafält (Custom Fields)
            </h4>
            <p className="mapping-section-desc">
              Mappa PIM-fält till Shopify metafields. Klicka "Hämta metafält" för att se tillgängliga fält i Shopify.
            </p>
          </div>
        </div>
        
        {shopifyMetafields.length > 0 && (
          <div className="shopify-metafields-info">
            <CheckCircle2 size={16} />
            <span>{shopifyMetafields.length} metafält hittades i Shopify</span>
          </div>
        )}
        
        <div className="mapping-table">
          <div className="mapping-table-header">
            <div>PIM-fält</div>
            <div></div>
            <div>Namespace</div>
            <div>Key</div>
            <div></div>
          </div>
          
          {(mapping?.metafields || []).map((mf, index) => (
            <div key={index} className="mapping-row">
              <div className="mapping-field pim">
                <select
                  className="mapping-select"
                  value={mf.pimField}
                  onChange={e => updateMetafieldMapping(index, 'pimField', e.target.value)}
                >
                  <option value="">-- Välj fält --</option>
                  {pimFields.metafields.map(f => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                  {pimFields.seo.map(f => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="mapping-arrow">
                <ChevronRight size={16} />
              </div>
              <div className="mapping-field namespace">
                <select
                  className="mapping-select-sm"
                  value={mf.namespace}
                  onChange={e => updateMetafieldMapping(index, 'namespace', e.target.value)}
                >
                  <option value="custom">custom</option>
                  <option value="global">global</option>
                  <option value="seo">seo</option>
                </select>
              </div>
              <div className="mapping-field key">
                {shopifyMetafields.length > 0 ? (
                  <select
                    className="mapping-select"
                    value={mf.key}
                    onChange={e => updateMetafieldMapping(index, 'key', e.target.value)}
                  >
                    <option value="">-- Välj --</option>
                    {shopifyMetafields
                      .filter(sf => sf.namespace === mf.namespace)
                      .map(sf => (
                        <option key={sf.key} value={sf.key}>{sf.name || sf.key}</option>
                      ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="mapping-input"
                    value={mf.key}
                    onChange={e => updateMetafieldMapping(index, 'key', e.target.value)}
                    placeholder="key_name"
                  />
                )}
              </div>
              <div className="mapping-delete">
                <button 
                  className="btn-icon-sm danger"
                  onClick={() => removeMetafieldMapping(index)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        
        <button className="btn btn-secondary" onClick={addMetafieldMapping}>
          <Plus size={16} />
          Lägg till metafältmappning
        </button>
      </div>

      {hasChanges && (
        <div className="mapping-unsaved-notice">
          <AlertCircle size={16} />
          <span>Du har osparade ändringar</span>
          <button className="btn btn-primary btn-sm" onClick={saveMapping}>
            Spara nu
          </button>
        </div>
      )}
    </div>
  );
}
