import React, { useState, useEffect, useRef } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import {
  X, Save, Sparkles, Loader2, Image, Plus, Trash2,
  Globe, Tag, Package, FileText, Search, AlertCircle,
  CheckCircle2, Truck, Settings, ShoppingBag, GripVertical,
  Store, RefreshCw, MapPin, Megaphone, Link, Upload, FileCheck
} from 'lucide-react';
import { generateHandle } from '../data/demoData';
import CategoryPicker from './CategoryPicker';
import MetafieldsTab from './MetafieldsTab';
import {
  resolveMargin, computePricing, fmtKr, fmtPct,
  DEFAULT_MARGIN, DEFAULT_VAT_RATE,
} from '../utils/pricing';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const COUNTRY_NAMES = {
  SE: 'Sverige', CN: 'Kina', IN: 'Indien', DE: 'Tyskland', PL: 'Polen',
  IT: 'Italien', FR: 'Frankrike', ES: 'Spanien', PT: 'Portugal', TR: 'Turkiet',
  BD: 'Bangladesh', VN: 'Vietnam', ID: 'Indonesien', PK: 'Pakistan', TH: 'Thailand',
  US: 'USA', GB: 'Storbritannien', DK: 'Danmark', NO: 'Norge', FI: 'Finland',
  NL: 'Nederländerna', BE: 'Belgien', AT: 'Österrike', CH: 'Schweiz', CZ: 'Tjeckien',
  MA: 'Marocko', EG: 'Egypten', ET: 'Etiopien', MX: 'Mexiko', BR: 'Brasilien',
};
const MAX_IMAGES = 8;

export default function ProductDetail({ product, stores, onSave, onDelete, onClose }) {
  const [editedProduct, setEditedProduct] = useState({
    ...product,
    handle: product.handle || generateHandle(product.title),
    images: product.images || []
  });
  const [activeTab, setActiveTab] = useState('general');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateOptions, setGenerateOptions] = useState({
    style: 'sales', language: 'sv', length: 'medium', includeSEO: true
  });
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [inventoryData, setInventoryData] = useState(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [isOptimizingImages, setIsOptimizingImages] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState(null);
  const [pricingCtx, setPricingCtx] = useState({ categoryRules: [], suppliers: [], settings: null });
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeStatus, setScrapeStatus] = useState('idle');
  const [scrapeResults, setScrapeResults] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [generatingAlt, setGeneratingAlt] = useState(null); // imageId being generated
  const imageUploadRef = useRef(null);
  const [sourceUrl, setSourceUrl] = useState(product.metafields?.['custom.source_url'] || '');
  const [urlStatus, setUrlStatus] = useState('idle'); // idle | fetching | done | error
  const [urlText, setUrlText] = useState('');
  const [docText, setDocText] = useState('');
  const [docName, setDocName] = useState('');
  const [docStatus, setDocStatus] = useState('idle'); // idle | loading | done | error

  // Load pricing context (category rules, suppliers, global settings) for live preview
  useEffect(() => {
    const storeId = stores?.[0]?.id;
    if (!storeId) return;
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('pim_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    headers['x-store-id'] = storeId;
    Promise.all([
      fetch(`${API_URL}/db/category-margin-rules?storeId=${storeId}`, { headers }).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/db/suppliers?storeId=${storeId}`, { headers }).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/db/pricing-settings?storeId=${storeId}`, { headers }).then(r => r.json()).catch(() => null),
    ]).then(([categoryRules, suppliers, settings]) => {
      setPricingCtx({
        categoryRules: Array.isArray(categoryRules) ? categoryRules : [],
        suppliers: Array.isArray(suppliers) ? suppliers : [],
        settings: settings && !settings.error ? settings : null,
      });
    });
  }, [stores]);

  const loadInventory = async () => {
    if (!product.id || product.id.toString().startsWith('new-')) return;
    setInventoryLoading(true);
    try {
      const res = await fetch(`${API_URL}/db/products/${product.id}/inventory`);
      if (res.ok) {
        const data = await res.json();
        setInventoryData(data);
      }
    } catch (err) {
      console.error('Failed to load inventory:', err);
    } finally {
      setInventoryLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'inventory' && !inventoryData && !inventoryLoading) {
      loadInventory();
    }
  }, [activeTab]);


  const handleFieldChange = (field, value) => {
    setEditedProduct(prev => {
      const updated = { ...prev, [field]: value };
      if (field === 'title' && !prev.handle) {
        updated.handle = generateHandle(value);
      }
      return updated;
    });
  };

  const handleMetafieldChange = (key, value) => {
    setEditedProduct(prev => ({
      ...prev,
      metafields: { ...prev.metafields, [key]: value }
    }));
  };

  const handleGoogleShoppingChange = (key, value) => {
    setEditedProduct(prev => ({
      ...prev,
      googleShopping: { ...prev.googleShopping, [key]: value }
    }));
  };

  const handleVariantChange = (variantId, field, value) => {
    setEditedProduct(prev => ({
      ...prev,
      variants: prev.variants.map(v => 
        v.id === variantId ? { ...v, [field]: value } : v
      )
    }));
  };

  // Image handling
  const handleImageAdd = (url) => {
    if (editedProduct.images.length >= MAX_IMAGES) {
      alert(`Max ${MAX_IMAGES} bilder per produkt`);
      return;
    }
    const imageIndex = editedProduct.images.length;
    const title = editedProduct.title || 'produkt';
    const alt = imageIndex === 0 ? title : `${title} - bild ${imageIndex + 1}`;
    const newImage = {
      id: `img_${Date.now()}`,
      url: url,
      position: imageIndex + 1,
      alt: alt
    };
    setEditedProduct(prev => ({
      ...prev,
      images: [...prev.images, newImage]
    }));
  };

  const handleImageRemove = (imageId) => {
    setEditedProduct(prev => ({
      ...prev,
      images: prev.images.filter(img => img.id !== imageId).map((img, idx) => ({
        ...img,
        position: idx + 1
      }))
    }));
  };

  const handleImageAltChange = (imageId, alt) => {
    setEditedProduct(prev => ({
      ...prev,
      images: prev.images.map(img => img.id === imageId ? { ...img, alt } : img)
    }));
  };

  const handleImageDragStart = (e, index) => {
    e.dataTransfer.setData('text/plain', index);
  };

  const handleImageDrop = (e, dropIndex) => {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
    if (dragIndex === dropIndex) return;
    
    setEditedProduct(prev => {
      const newImages = [...prev.images];
      const [removed] = newImages.splice(dragIndex, 1);
      newImages.splice(dropIndex, 0, removed);
      return {
        ...prev,
        images: newImages.map((img, idx) => ({ ...img, position: idx + 1 }))
      };
    });
    setDragOverIndex(null);
  };

  const handleBulkImageUrls = (urlsText) => {
    const urls = urlsText.split('\n').filter(u => u.trim());
    const available = MAX_IMAGES - editedProduct.images.length;
    urls.slice(0, available).forEach(url => handleImageAdd(url.trim()));
  };

  const handleScrapeImages = async () => {
    if (!scrapeUrl) return;
    setScrapeStatus('loading');
    setScrapeResults(null);
    try {
      const res = await fetch(`${API_URL}/source/scrape-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: scrapeUrl,
          sku: editedProduct.sku || editedProduct.variants?.[0]?.sku || '',
          barcode: editedProduct.barcode || editedProduct.variants?.[0]?.barcode || '',
          title: editedProduct.title || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScrapeResults(data);
      setScrapeStatus('done');
    } catch (err) {
      setScrapeStatus('error');
      setScrapeResults({ error: err.message });
    }
  };

  const handleGenerateDescription = async () => {
    setIsGenerating(true);
    try {
      // Inkludera källmaterial om det finns och är aktiverat
      const sourceMaterial = generateOptions.useSourceMaterial !== false
        ? editedProduct.metafields?.['custom.source_material']
        : null;

      const response = await fetch(`${API_URL}/claude/generate-description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: editedProduct,
          ...generateOptions,
          sourceMaterial,
          includeShortDescription: generateOptions.includeShortDescription !== false
        })
      });
      if (!response.ok) throw new Error('Failed to generate');
      const data = await response.json();
      setEditedProduct(prev => ({
        ...prev,
        description: data.description,
        ...(data.seoTitle && { seoTitle: data.seoTitle }),
        ...(data.metaDescription && { seoDescription: data.metaDescription }),
        ...(data.shortDescription && {
          metafields: {
            ...prev.metafields,
            'custom.kort_produktbeskrivning': data.shortDescription
          }
        })
      }));
      setShowGenerateModal(false);
    } catch (error) {
      alert('Kunde inte generera text. Kontrollera att backend körs.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(editedProduct);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      await onDelete(editedProduct.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const addVariant = () => {
    const first = editedProduct.variants?.[0] || {};
    setEditedProduct(prev => ({
      ...prev,
      variants: [...(prev.variants || []), {
        id: `v_${Date.now()}`,
        sku: '',
        barcode: '',
        price: prev.default_price ?? null,
        compare_at_price: null,
        cost: prev.default_cost ?? null,
        inventory_quantity: 0,
        weight: prev.weight ?? null,
        option1_name: first.option1_name || null,
        option1_value: '',
        option2_name: first.option2_name || null,
        option2_value: '',
        option3_name: first.option3_name || null,
        option3_value: '',
      }]
    }));
  };

  const removeVariant = (variantId) => {
    if (editedProduct.variants.length <= 1) {
      alert('Minst en variant krävs');
      return;
    }
    setEditedProduct(prev => ({
      ...prev,
      variants: prev.variants.filter(v => v.id !== variantId)
    }));
  };

  const docFileRef = useRef(null);

  const handleFetchUrl = async () => {
    if (!sourceUrl) return;
    setUrlStatus('fetching');
    setUrlText('');
    try {
      const res = await fetch(`${API_URL}/source/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUrlText(data.text);
      setUrlStatus('done');
      handleMetafieldChange('custom.source_url', sourceUrl);
    } catch (err) {
      setUrlStatus('error');
      console.error('URL fetch failed:', err);
    }
  };

  const handleDocUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocStatus('loading');
    setDocText('');
    setDocName('');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API_URL}/source/extract-document`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDocText(data.text);
      setDocName(data.filename);
      setDocStatus('done');
    } catch (err) {
      setDocStatus('error');
      console.error('Doc extract failed:', err);
    }
    e.target.value = '';
  };

  const buildCombinedSourceMaterial = () => {
    const parts = [];
    const textSource = editedProduct.metafields?.['custom.source_material'];
    if (textSource) parts.push(textSource);
    if (urlText) parts.push(`--- Hämtat från ${sourceUrl} ---\n${urlText}`);
    if (docText) parts.push(`--- Dokument: ${docName} ---\n${docText}`);
    return parts.join('\n\n');
  };

  const handleImageUploadFromFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !product.id || product.id.toString().startsWith('new-')) {
      if (!product.id || product.id.toString().startsWith('new-')) alert('Spara produkten först innan du laddar upp bilder.');
      e.target.value = '';
      return;
    }
    if (editedProduct.images.length >= MAX_IMAGES) { alert(`Max ${MAX_IMAGES} bilder`); return; }
    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('productId', product.id);
      formData.append('productTitle', editedProduct.title || '');
      formData.append('sku', editedProduct.sku || editedProduct.variants?.[0]?.sku || '');
      formData.append('position', String(editedProduct.images.length + 1));
      const res = await fetch(`${API_URL}/images/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      handleImageAdd(data.url);
    } catch (err) {
      alert('Uppladdning misslyckades: ' + err.message);
    } finally {
      setUploadingImage(false);
      e.target.value = '';
    }
  };

  const handleGenerateAltText = async (imageId, imageUrl) => {
    setGeneratingAlt(imageId);
    try {
      const res = await fetch(`${API_URL}/images/generate-alt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl,
          productTitle: editedProduct.title,
          productType: editedProduct.product_type || editedProduct.type,
          vendor: editedProduct.vendor,
        }),
      });
      const data = await res.json();
      if (res.ok && data.altText) handleImageAltChange(imageId, data.altText);
    } catch (_) {}
    setGeneratingAlt(null);
  };

  const handleAIGenerate = async (field) => {
    setIsGenerating(true);
    try {
      const res = await fetch(`${API_URL}/claude/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field,
          product: editedProduct,
          sourceMaterial: buildCombinedSourceMaterial(),
        })
      });

      if (!res.ok) throw new Error('AI generation failed');
      const data = await res.json();

      if (field === 'all' && typeof data.result === 'object') {
        setEditedProduct(prev => ({
          ...prev,
          agentSummary: data.result.agentSummary || prev.agentSummary,
          shortDescription: data.result.shortDescription || prev.shortDescription,
          specifications: data.result.specifications || prev.specifications,
          faq: data.result.faq || prev.faq,
          useCases: data.result.useCases || prev.useCases,
          seoTitle: data.result.seoTitle || prev.seoTitle,
          seoDescription: data.result.seoDescription || prev.seoDescription,
          searchTerms: data.result.searchTerms || prev.searchTerms,
          tags: data.result.tags || prev.tags,
        }));
      } else if (field === 'specifications' || field === 'faq') {
        if (Array.isArray(data.result)) {
          setEditedProduct(prev => ({ ...prev, [field]: data.result }));
        }
      } else if (field === 'schema') {
        setEditedProduct(prev => ({ ...prev, schemaJson: data.result }));
      } else if (field === 'relatedProducts' && typeof data.result === 'object') {
        setEditedProduct(prev => ({
          ...prev,
          complementaryProducts: data.result.complementary || '',
          similarProducts: data.result.similar || '',
        }));
      } else if (typeof data.result === 'string') {
        setEditedProduct(prev => ({ ...prev, [field]: data.result }));
      }
    } catch (err) {
      console.error('AI generate error:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const tabs = [
    { id: 'general', label: 'Allmänt', icon: Package },
    { id: 'description', label: 'Beskrivning', icon: FileText },
    { id: 'ai-content', label: 'AI-innehåll', icon: Sparkles },
    { id: 'images', label: `Bilder (${editedProduct.images?.length || 0})`, icon: Image },
    { id: 'variants', label: 'Varianter', icon: Tag },
    { id: 'inventory', label: 'Lager', icon: Truck },
    { id: 'seo', label: 'SEO', icon: Search },
    { id: 'schema', label: 'Schema', icon: FileText },
    { id: 'search-discovery', label: 'Sök & Upptäck', icon: Search },
    { id: 'metafields', label: 'Metafält', icon: Settings },
    { id: 'google', label: 'Google Shopping', icon: ShoppingBag },
    { id: 'google-ads', label: 'Google Ads', icon: Megaphone },
    { id: 'quality', label: 'Kvalitet', icon: CheckCircle2 },
    { id: 'publish', label: 'Publicera', icon: Globe },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="product-detail-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="product-detail-header">
          <div className="product-detail-title-section">
            <div className="product-detail-image">
              {editedProduct.images?.length > 0 ? (
                <img src={editedProduct.images[0].url} alt={editedProduct.title} />
              ) : (
                <Image size={32} />
              )}
            </div>
            <div>
              <h2 className="product-detail-title">{editedProduct.title}</h2>
              <div className="product-detail-meta">
                <span className="product-sku">{editedProduct.variants?.[0]?.sku}</span>
                <span className={`status-pill ${editedProduct.status}`}>
                  {editedProduct.status === 'active' ? 'Aktiv' : 'Utkast'}
                </span>
              </div>
            </div>
          </div>
          <div className="product-detail-actions">
            {onDelete && !editedProduct.id?.startsWith('new-') && (
              <button
                className="btn btn-danger"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isDeleting}
              >
                <Trash2 size={18} />
                Ta bort
              </button>
            )}
            <button className="btn btn-secondary" onClick={onClose}>Avbryt</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 size={18} className="spin" /> : <Save size={18} />}
              Spara
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="product-detail-tabs">
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
        <div className="product-detail-content">
          {/* General Tab */}
          {activeTab === 'general' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Grundläggande information</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Titel *</label>
                    <input type="text" className="form-input" value={editedProduct.title}
                      onChange={e => handleFieldChange('title', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">URL Handle</label>
                    <input type="text" className="form-input mono" value={editedProduct.handle}
                      onChange={e => handleFieldChange('handle', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Varumärke *</label>
                    <input type="text" className="form-input" value={editedProduct.vendor}
                      onChange={e => handleFieldChange('vendor', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Produkttyp</label>
                    <input type="text" className="form-input" value={editedProduct.type}
                      onChange={e => handleFieldChange('type', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Status</label>
                    <select className="form-input" value={editedProduct.status}
                      onChange={e => handleFieldChange('status', e.target.value)}>
                      <option value="active">Aktiv</option>
                      <option value="draft">Utkast</option>
                      <option value="archived">Arkiverad</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Taggar</label>
                  <input type="text" className="form-input"
                    value={editedProduct.tags?.join(', ') || ''}
                    onChange={e => handleFieldChange('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                    placeholder="driver, taylormade, 2026" />
                  <span className="form-help">Separera med komma</span>
                </div>
                <div className="form-group">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={editedProduct.publishedOnOnlineStore !== false}
                      onChange={e => handleFieldChange('publishedOnOnlineStore', e.target.checked)} />
                    <span>Publicerad på webshop</span>
                  </label>
                </div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Prissättning (standardvärden)</h3>
                <div className="form-grid three-col">
                  <div className="form-group">
                    <label className="form-label">Inköpspris ex moms (SEK)</label>
                    <input type="number" step="0.01" className="form-input mono" value={editedProduct.cost || ''}
                      onChange={e => handleFieldChange('cost', e.target.value ? Number(e.target.value) : null)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Marginal-multiplikator</label>
                    <input
                      type="number" step="0.01" min="0"
                      className="form-input mono"
                      value={editedProduct.marginMultiplier ?? ''}
                      placeholder={(() => {
                        const m = resolveMargin({
                          product: { ...editedProduct, product_type: editedProduct.type, margin_multiplier: null },
                          categoryRules: pricingCtx.categoryRules,
                          supplier: pricingCtx.suppliers.find(s => s.id === editedProduct.supplierId) || null,
                          defaultMargin: pricingCtx.settings?.default_margin_multiplier ?? DEFAULT_MARGIN,
                        });
                        return `${m.value.toFixed(2)} (ärver från ${m.sourceLabel})`;
                      })()}
                      onChange={e => handleFieldChange('marginMultiplier', e.target.value === '' ? null : Number(e.target.value))}
                    />
                    <span className="form-help">Lämna tom för att ärva från kategori/leverantör/global</span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Jämförpris ink moms (SEK)</label>
                    <input type="number" step="0.01" className="form-input mono" value={editedProduct.compareAtPrice || ''}
                      onChange={e => handleFieldChange('compareAtPrice', e.target.value ? Number(e.target.value) : null)} />
                  </div>
                </div>

                {/* Live pricing preview */}
                {(() => {
                  const supplier = pricingCtx.suppliers.find(s => s.id === editedProduct.supplierId) || null;
                  const margin = resolveMargin({
                    product: { ...editedProduct, product_type: editedProduct.type, margin_multiplier: editedProduct.marginMultiplier },
                    categoryRules: pricingCtx.categoryRules,
                    supplier,
                    defaultMargin: pricingCtx.settings?.default_margin_multiplier ?? DEFAULT_MARGIN,
                  });
                  const pricing = computePricing({
                    cost: editedProduct.cost,
                    margin: margin.value,
                    supplierFeePercent: supplier?.supplier_fee_percent ?? 0,
                    vatRate: pricingCtx.settings?.default_vat_rate ?? DEFAULT_VAT_RATE,
                  });
                  return (
                    <div className="pricing-preview">
                      <div className="pricing-preview-row">
                        <div className="pricing-preview-cell">
                          <div className="cell-label">Marginal</div>
                          <div className="cell-value">{margin.value.toFixed(2)}× <small>({margin.sourceLabel})</small></div>
                        </div>
                        <div className="pricing-preview-cell">
                          <div className="cell-label">Utpris ink moms</div>
                          <div className="cell-value">{fmtKr(pricing.salePriceInclVat)}</div>
                        </div>
                        <div className="pricing-preview-cell">
                          <div className="cell-label">Utpris ex moms</div>
                          <div className="cell-value">{fmtKr(pricing.salePriceExVat)}</div>
                        </div>
                        <div className="pricing-preview-cell">
                          <div className="cell-label">Faktisk kostnad <small>(inkl lev-avgift)</small></div>
                          <div className="cell-value">{fmtKr(pricing.trueCost)}</div>
                        </div>
                        <div className="pricing-preview-cell highlight">
                          <div className="cell-label">Vinst per styck</div>
                          <div className={`cell-value ${pricing.profit >= 0 ? 'pos' : 'neg'}`}>
                            {fmtKr(pricing.profit)}
                          </div>
                        </div>
                        <div className="pricing-preview-cell">
                          <div className="cell-label">Vinstmarginal</div>
                          <div className="cell-value">{fmtPct(pricing.marginPct)}</div>
                        </div>
                      </div>
                      <div className="pricing-preview-note">
                        Utpris sparas automatiskt på Pris (SEK) i Shopify när du sparar.
                      </div>
                    </div>
                  );
                })()}
              </div>
              
              {/* SKU/Barcode section - shown when no variants */}
              {(!editedProduct.variants || editedProduct.variants.length === 0) && (
                <div className="form-section">
                  <h3 className="form-section-title">Artikelinformation</h3>
                  <p className="form-section-description">För produkter utan varianter</p>
                  <div className="form-grid two-col">
                    <div className="form-group">
                      <label className="form-label">SKU (artikelnummer)</label>
                      <input type="text" className="form-input mono" value={editedProduct.sku || ''}
                        onChange={e => handleFieldChange('sku', e.target.value)}
                        placeholder="ABC-123" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Streckkod (EAN/GTIN)</label>
                      <input type="text" className="form-input mono" value={editedProduct.barcode || ''}
                        onChange={e => handleFieldChange('barcode', e.target.value)}
                        placeholder="7350123456789" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Description Tab */}
          {activeTab === 'description' && (
            <div className="tab-content">
              {/* Källmaterial för AI */}
              <div className="form-section">
                <h3 className="form-section-title">Källmaterial för AI-generering</h3>
                <p className="form-section-description">
                  AI:n använder enbart detta material — den hittar aldrig på eget innehåll. Ju mer fakta du ger, desto bättre resultat.
                </p>

                {/* Text */}
                <div className="form-group">
                  <label className="form-label">Text / klistra in från leverantör</label>
                  <textarea
                    className="form-input"
                    value={editedProduct.metafields?.['custom.source_material'] || ''}
                    onChange={(e) => handleMetafieldChange('custom.source_material', e.target.value)}
                    placeholder="Klistra in produktspecifikationer, leverantörsinfo, tekniska data..."
                    rows={5}
                    style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' }}
                  />
                  <div className="form-help">{(editedProduct.metafields?.['custom.source_material'] || '').length} tecken</div>
                </div>

                {/* URL */}
                <div className="form-group">
                  <label className="form-label"><Link size={13} style={{verticalAlign:'middle',marginRight:4}}/>Produktsida / URL att hämta innehåll från</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="form-input"
                      type="url"
                      placeholder="https://leverantoren.se/produkt/..."
                      value={sourceUrl}
                      onChange={e => setSourceUrl(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={handleFetchUrl}
                      disabled={!sourceUrl || urlStatus === 'fetching'}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {urlStatus === 'fetching' ? <><Loader2 size={14} className="spin" /> Hämtar...</> : 'Hämta innehåll'}
                    </button>
                  </div>
                  {urlStatus === 'done' && (
                    <div className="form-help" style={{ color: 'var(--success)' }}>
                      <CheckCircle2 size={12} style={{verticalAlign:'middle',marginRight:4}}/>
                      {urlText.length} tecken hämtade — "{urlText.slice(0, 80)}..."
                    </div>
                  )}
                  {urlStatus === 'error' && (
                    <div className="form-help" style={{ color: 'var(--error)' }}>
                      <AlertCircle size={12} style={{verticalAlign:'middle',marginRight:4}}/>Kunde inte hämta URL. Prova att klistra in texten manuellt.
                    </div>
                  )}
                </div>

                {/* File upload */}
                <div className="form-group">
                  <label className="form-label"><Upload size={13} style={{verticalAlign:'middle',marginRight:4}}/>Dokument (PDF, Word, TXT)</label>
                  <input
                    ref={docFileRef}
                    type="file"
                    accept=".pdf,.docx,.doc,.txt"
                    style={{ display: 'none' }}
                    onChange={handleDocUpload}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => docFileRef.current?.click()}
                      disabled={docStatus === 'loading'}
                    >
                      {docStatus === 'loading' ? <><Loader2 size={14} className="spin" /> Läser...</> : <><Upload size={14} /> Välj fil</>}
                    </button>
                    {docStatus === 'done' && (
                      <span style={{ fontSize: 13, color: 'var(--success)', display:'flex',alignItems:'center',gap:4 }}>
                        <FileCheck size={14} /> {docName} ({docText.length} tecken)
                        <button onClick={() => { setDocText(''); setDocName(''); setDocStatus('idle'); }} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-secondary)',padding:0,marginLeft:4}}><X size={12}/></button>
                      </span>
                    )}
                    {docStatus === 'error' && (
                      <span style={{ fontSize: 13, color: 'var(--error)' }}><AlertCircle size={13}/> Kunde inte läsa filen</span>
                    )}
                  </div>
                </div>

                {/* Summary badge */}
                {(editedProduct.metafields?.['custom.source_material'] || urlText || docText) && (
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:4 }}>
                    {editedProduct.metafields?.['custom.source_material'] && <span style={{fontSize:12,background:'rgba(34,197,94,0.1)',color:'var(--success)',padding:'2px 8px',borderRadius:10}}>✓ Text</span>}
                    {urlText && <span style={{fontSize:12,background:'rgba(34,197,94,0.1)',color:'var(--success)',padding:'2px 8px',borderRadius:10}}>✓ URL</span>}
                    {docText && <span style={{fontSize:12,background:'rgba(34,197,94,0.1)',color:'var(--success)',padding:'2px 8px',borderRadius:10}}>✓ Dokument</span>}
                    <span style={{fontSize:12,color:'var(--text-secondary)'}}>— {buildCombinedSourceMaterial().length} tecken totalt tillgängligt för AI</span>
                  </div>
                )}
              </div>

              {/* Produktbeskrivning */}
              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Produktbeskrivning</h3>
                  <button className="btn btn-accent" onClick={() => setShowGenerateModal(true)}>
                    <Sparkles size={16} /> Generera med AI
                  </button>
                </div>
                <div className="form-group">
                  <ReactQuill
                    theme="snow"
                    value={editedProduct.description || ''}
                    onChange={(content) => handleFieldChange('description', content)}
                    placeholder="Skriv en produktbeskrivning eller klicka på 'Generera med AI'..."
                    modules={{
                      toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                        ['link'],
                        ['clean']
                      ]
                    }}
                    style={{
                      height: '300px',
                      marginBottom: '50px',
                      backgroundColor: 'var(--bg-secondary)',
                      borderRadius: '8px'
                    }}
                  />
                  <div className="form-help" style={{ marginTop: '8px' }}>
                    {editedProduct.description?.replace(/<[^>]*>/g, '').length || 0} tecken (utan HTML)
                    {!editedProduct.description && <span style={{color: 'var(--warning)'}}> • Beskrivning saknas</span>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AI Content Tab */}
          {activeTab === 'ai-content' && (
            <div className="tab-content">
              {/* Agent Summary / Snabbfakta */}
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Snabbfakta / Agent Summary</h3>
                    <p className="form-section-description">
                      6-8 punkter i köpordning. Löptext som AI-agenter och LLMs kan parsa. Renderas som punktlista i teman.
                    </p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('agentSummary')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea className="form-input form-textarea" rows={6}
                    value={editedProduct.agentSummary || ''}
                    onChange={e => handleFieldChange('agentSummary', e.target.value)}
                    placeholder="Viktigaste egenskapen först. En punkt per rad.&#10;T.ex: Vattentät Gore-Tex membran. Vikt 320g. Passar till terräng och stad." />
                  <span className="form-help">Sparas som metafält: custom.agent_summary</span>
                </div>
              </div>

              {/* Short Description / Kort ingress */}
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Kort ingress</h3>
                    <p className="form-section-description">2-3 säljande meningar. Löptext, inte punktlista. Ska inte upprepa snabbfakta.</p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('shortDescription')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea className="form-input form-textarea" rows={4}
                    value={editedProduct.shortDescription || ''}
                    onChange={e => handleFieldChange('shortDescription', e.target.value)}
                    placeholder="Nyttobaserad ingress som säljer produkten..." />
                  <span className="form-help">Sparas som metafält: custom.kort_beskrivning</span>
                </div>
              </div>

              {/* Specifications */}
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Specifikationer</h3>
                    <p className="form-section-description">Minimum 10 attribut. Inkludera alltid färg. Attributnamn på svenska.</p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('specifications')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(editedProduct.specifications || []).map((spec, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input type="text" className="form-input" style={{ flex: 1 }}
                        value={spec.name || ''} placeholder="Attributnamn"
                        onChange={e => {
                          const specs = [...(editedProduct.specifications || [])];
                          specs[idx] = { ...specs[idx], name: e.target.value };
                          handleFieldChange('specifications', specs);
                        }} />
                      <input type="text" className="form-input" style={{ flex: 1 }}
                        value={spec.value || ''} placeholder="Värde"
                        onChange={e => {
                          const specs = [...(editedProduct.specifications || [])];
                          specs[idx] = { ...specs[idx], value: e.target.value };
                          handleFieldChange('specifications', specs);
                        }} />
                      <button className="btn-icon-sm danger" onClick={() => {
                        const specs = (editedProduct.specifications || []).filter((_, i) => i !== idx);
                        handleFieldChange('specifications', specs);
                      }}><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}
                    onClick={() => handleFieldChange('specifications', [...(editedProduct.specifications || []), { name: '', value: '' }])}>
                    <Plus size={16} /> Lägg till specifikation
                  </button>
                  <span className="form-help">{(editedProduct.specifications || []).length} av minst 10 specifikationer</span>
                </div>
              </div>

              {/* FAQ */}
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">FAQ</h3>
                    <p className="form-section-description">5-8 frågor. Teman: passform, material, jämförelse, vad ingår, mått, teknologi.</p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('faq')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {(editedProduct.faq || []).map((item, idx) => (
                    <div key={idx} style={{ background: 'var(--bg)', borderRadius: '8px', padding: '12px', border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Fråga {idx + 1}</span>
                        <button className="btn-icon-sm danger" onClick={() => {
                          const faqs = (editedProduct.faq || []).filter((_, i) => i !== idx);
                          handleFieldChange('faq', faqs);
                        }}><Trash2 size={14} /></button>
                      </div>
                      <input type="text" className="form-input" style={{ marginBottom: '8px', fontWeight: 600 }}
                        value={item.question || ''} placeholder="Fråga"
                        onChange={e => {
                          const faqs = [...(editedProduct.faq || [])];
                          faqs[idx] = { ...faqs[idx], question: e.target.value };
                          handleFieldChange('faq', faqs);
                        }} />
                      <textarea className="form-input form-textarea" rows={3}
                        value={item.answer || ''} placeholder="Svar (2-4 meningar, konkret, med siffror)"
                        onChange={e => {
                          const faqs = [...(editedProduct.faq || [])];
                          faqs[idx] = { ...faqs[idx], answer: e.target.value };
                          handleFieldChange('faq', faqs);
                        }} />
                    </div>
                  ))}
                  <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}
                    onClick={() => handleFieldChange('faq', [...(editedProduct.faq || []), { question: '', answer: '' }])}>
                    <Plus size={16} /> Lägg till fråga
                  </button>
                  <span className="form-help">{(editedProduct.faq || []).length} av minst 5 frågor</span>
                </div>
              </div>

              {/* Use Cases (for AI agents) */}
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Användningsområden</h3>
                    <p className="form-section-description">AI-agenter söker efter användningskontext. Beskriv vem produkten passar för och när.</p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('useCases')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div className="form-group">
                  <textarea className="form-input form-textarea" rows={4}
                    value={editedProduct.useCases || ''}
                    onChange={e => handleFieldChange('useCases', e.target.value)}
                    placeholder="Passar till: löpning i terräng, vandring, vardagsbruk i regn. Idealisk för den som söker en lättviktig och vattentät sko..." />
                  <span className="form-help">Sparas som metafält: custom.use_cases</span>
                </div>
              </div>

              {/* Generate All button */}
              <div className="form-section" style={{ textAlign: 'center', padding: '24px' }}>
                <button className="btn btn-primary" style={{ fontSize: '15px', padding: '12px 32px' }}
                  onClick={() => handleAIGenerate('all')}
                  disabled={isGenerating}>
                  {isGenerating ? <><Loader2 size={18} className="spin" /> Genererar...</> : <><Sparkles size={18} /> Generera allt AI-innehåll</>}
                </button>
                <p style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Analyserar produktdata, källmaterial och källtext.
                  {editedProduct.images?.length > 0 && (
                    <span style={{ color: 'var(--accent, #6366f1)', marginLeft: 6 }}>
                      <Image size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                      {Math.min(editedProduct.images.length, 3)} bild{editedProduct.images.length > 1 ? 'er' : ''} analyseras med vision.
                    </span>
                  )}
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {editedProduct.metafields?.['custom.source_material'] && <span style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success, #16a34a)', padding: '2px 8px', borderRadius: 10 }}>✓ Text</span>}
                  {editedProduct.metafields?.['custom.source_url'] && <span style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success, #16a34a)', padding: '2px 8px', borderRadius: 10 }}>✓ URL</span>}
                  {editedProduct.images?.length > 0 && <span style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent, #6366f1)', padding: '2px 8px', borderRadius: 10 }}>✓ Bildanalys</span>}
                  {!editedProduct.metafields?.['custom.source_material'] && !editedProduct.images?.length && <span style={{ color: 'var(--warning)' }}>Tips: lägg till källmaterial eller bilder för bästa resultat</span>}
                </div>
              </div>
            </div>
          )}

          {/* Images Tab */}
          {activeTab === 'images' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Produktbilder ({editedProduct.images?.length || 0} av {MAX_IMAGES})</h3>
                <p className="form-section-description">Dra för att ändra ordning. Första bilden blir huvudbild.</p>
                
                <div className="images-edit-grid">
                  {editedProduct.images?.map((image, index) => (
                    <div
                      key={image.id}
                      className={`image-edit-item ${index === 0 ? 'main' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
                      draggable
                      onDragStart={e => handleImageDragStart(e, index)}
                      onDragOver={e => { e.preventDefault(); setDragOverIndex(index); }}
                      onDrop={e => handleImageDrop(e, index)}
                      onDragLeave={() => setDragOverIndex(null)}
                    >
                      <div className="image-edit-preview">
                        <img src={image.url} alt={image.alt || ''} />
                        <div className="image-edit-overlay">
                          <button className="overlay-btn danger" onClick={() => handleImageRemove(image.id)}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <span className="image-position-badge">{index + 1}</span>
                        {index === 0 && <span className="main-image-badge">Huvudbild</span>}
                      </div>
                      <div className="image-edit-meta">
                        <GripVertical size={14} className="drag-handle" />
                        <input
                          type="text"
                          className="image-alt-input"
                          value={image.alt || ''}
                          onChange={e => handleImageAltChange(image.id, e.target.value)}
                          placeholder="Alt-text..."
                        />
                        <button
                          title="Generera alt-text med AI"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: generatingAlt === image.id ? 'var(--accent)' : 'var(--text-secondary)', flexShrink: 0 }}
                          onClick={() => handleGenerateAltText(image.id, image.url)}
                          disabled={generatingAlt === image.id}
                        >
                          {generatingAlt === image.id ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                        </button>
                      </div>
                    </div>
                  ))}
                  
                  {editedProduct.images.length < MAX_IMAGES && (
                    <div className="image-edit-item add-image">
                      <Plus size={32} />
                      <span>Lägg till bild</span>
                    </div>
                  )}
                </div>

                {editedProduct.images?.length > 0 && (
                  <div className="image-optimize-section">
                    <button
                      className="btn btn-secondary"
                      disabled={isOptimizingImages || !product.id || product.id.toString().startsWith('new-')}
                      onClick={async () => {
                        setIsOptimizingImages(true);
                        setOptimizeResult(null);
                        try {
                          // Save first so images are in DB
                          await onSave(editedProduct);
                          const res = await fetch(`${API_URL}/products/${product.id}/optimize-images`, { method: 'POST' });
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error);
                          setOptimizeResult(data);
                          // Reload product to get updated URLs
                          const prodRes = await fetch(`${API_URL}/db/products/${product.id}`);
                          if (prodRes.ok) {
                            const updated = await prodRes.json();
                            setEditedProduct(prev => ({ ...prev, images: updated.images || prev.images }));
                          }
                        } catch (err) {
                          setOptimizeResult({ error: err.message });
                        } finally {
                          setIsOptimizingImages(false);
                        }
                      }}
                    >
                      {isOptimizingImages ? <><Loader2 size={16} className="spin" /> Optimerar...</> : <><RefreshCw size={16} /> Optimera bildnamn & URL</>}
                    </button>
                    <span style={{fontSize: 12, color: 'var(--text-muted)', marginLeft: 8}}>
                      Laddar ner bilder, byter filnamn till produktnamn och laddar upp till Supabase Storage
                    </span>
                    {optimizeResult && !optimizeResult.error && (
                      <div style={{marginTop: 8, padding: '8px 12px', background: 'var(--success-bg, #e8f5e9)', borderRadius: 8, fontSize: 13, color: 'var(--success, #2e7d32)'}}>
                        <CheckCircle2 size={14} style={{marginRight: 6, verticalAlign: -2}} />
                        {optimizeResult.message}
                      </div>
                    )}
                    {optimizeResult?.error && (
                      <div style={{marginTop: 8, padding: '8px 12px', background: 'var(--error-bg, #fbe9e7)', borderRadius: 8, fontSize: 13, color: 'var(--error, #c62828)'}}>
                        <AlertCircle size={14} style={{marginRight: 6, verticalAlign: -2}} />
                        {optimizeResult.error}
                      </div>
                    )}
                  </div>
                )}

                {/* Image scraper */}
                <div className="form-section" style={{ marginTop: 24 }}>
                  <h3 className="form-section-title">Hämta bilder från leverantörssida</h3>
                  <p className="form-section-description">
                    Klistra in URL till en produktsida eller bildkatalog. Bilder matchas mot SKU <strong>{editedProduct.sku || editedProduct.variants?.[0]?.sku || '—'}</strong> och sedan produktnamn.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="form-input"
                      type="url"
                      placeholder="https://b2b.leverantor.se/produkter/kategori"
                      value={scrapeUrl}
                      onChange={e => setScrapeUrl(e.target.value)}
                      style={{ flex: 1 }}
                      onKeyDown={e => e.key === 'Enter' && handleScrapeImages()}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={handleScrapeImages}
                      disabled={!scrapeUrl || scrapeStatus === 'loading'}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {scrapeStatus === 'loading' ? <><Loader2 size={14} className="spin" /> Söker...</> : <><Search size={14} /> Sök bilder</>}
                    </button>
                  </div>

                  {scrapeStatus === 'error' && (
                    <div style={{ marginTop: 12, fontSize: 13, color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertCircle size={14} /> {scrapeResults?.error}
                    </div>
                  )}

                  {scrapeStatus === 'done' && scrapeResults && (
                    <div style={{ marginTop: 16 }}>
                      {/* Matched images */}
                      {scrapeResults.matches?.length > 0 && (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--success, #16a34a)' }}>
                            <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            {scrapeResults.matches.length} matchande bild{scrapeResults.matches.length !== 1 ? 'er' : ''} hittade
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                            {scrapeResults.matches.map((img, i) => {
                              const alreadyAdded = editedProduct.images.some(im => im.url === img.url);
                              return (
                                <div key={i} style={{ position: 'relative', width: 110, flexShrink: 0 }}>
                                  <div style={{ width: 110, height: 110, border: '2px solid var(--success, #16a34a)', borderRadius: 8, overflow: 'hidden', background: '#f5f5f5' }}>
                                    <img src={img.url} alt={img.altText} style={{ width: '100%', height: '100%', objectFit: 'contain' }} onError={e => { e.target.style.display='none'; }} />
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {img.matchReason}
                                  </div>
                                  {alreadyAdded ? (
                                    <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 2 }}>✓ Tillagd</div>
                                  ) : (
                                    <button
                                      className="btn btn-primary"
                                      style={{ marginTop: 4, width: '100%', fontSize: 11, padding: '4px 0' }}
                                      disabled={editedProduct.images.length >= MAX_IMAGES}
                                      onClick={() => handleImageAdd(img.url)}
                                    >
                                      <Plus size={12} /> Lägg till
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {scrapeResults.matches?.length === 0 && (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                          Inga automatiska matchningar hittades på SKU eller titel. Välj manuellt nedan.
                        </div>
                      )}

                      {/* Other images for manual picking */}
                      {scrapeResults.others?.length > 0 && (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                            Övriga bilder på sidan — välj manuellt
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {scrapeResults.others.map((img, i) => {
                              const alreadyAdded = editedProduct.images.some(im => im.url === img.url);
                              return (
                                <div key={i} style={{ width: 80, flexShrink: 0 }}>
                                  <div style={{ width: 80, height: 80, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: '#f5f5f5', cursor: 'pointer' }}
                                    onClick={() => !alreadyAdded && editedProduct.images.length < MAX_IMAGES && handleImageAdd(img.url)}
                                    title={alreadyAdded ? 'Tillagd' : `${img.filename} — klicka för att lägga till`}
                                  >
                                    <img src={img.url} alt={img.altText} style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: alreadyAdded ? 0.4 : 1 }} onError={e => { e.target.style.display='none'; }} />
                                  </div>
                                  {alreadyAdded && <div style={{ fontSize: 10, color: 'var(--success)', textAlign: 'center' }}>✓</div>}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}

                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>
                        {scrapeResults.total} bilder hittades totalt på sidan
                      </div>
                    </div>
                  )}
                </div>

                <div className="image-add-section">
                  {/* Upload from computer */}
                  <h4>Ladda upp från dator</h4>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    Bilder laddas upp direkt till Supabase Storage och döps om till <code>{(editedProduct.sku || 'sku') + '-' + (editedProduct.title || 'produktnamn').toLowerCase().slice(0, 20).replace(/\s+/g, '-')}.jpg</code>
                  </p>
                  <input ref={imageUploadRef} type="file" accept="image/*" multiple hidden onChange={handleImageUploadFromFile} />
                  <button
                    className="btn btn-primary"
                    onClick={() => imageUploadRef.current?.click()}
                    disabled={uploadingImage || editedProduct.images.length >= MAX_IMAGES}
                  >
                    {uploadingImage ? <><Loader2 size={16} className="spin" /> Laddar upp...</> : <><Upload size={16} /> Välj bild från dator</>}
                  </button>
                  {!product.id?.toString().startsWith('new-') ? null : (
                    <span style={{ fontSize: 12, color: 'var(--warning)', marginLeft: 10 }}>Spara produkten först</span>
                  )}

                  <h4 style={{ marginTop: 24 }}>Lägg till bild via URL</h4>
                  <div className="url-add-row">
                    <input
                      type="url"
                      className="form-input"
                      placeholder="https://example.com/image.jpg"
                      id="imageUrlInput"
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          handleImageAdd(e.target.value);
                          e.target.value = '';
                        }
                      }}
                    />
                    <button className="btn btn-primary" onClick={() => {
                      const input = document.getElementById('imageUrlInput');
                      if (input.value) {
                        handleImageAdd(input.value);
                        input.value = '';
                      }
                    }}>
                      <Plus size={16} /> Lägg till
                    </button>
                  </div>

                  <h4 style={{marginTop: '24px'}}>Bulk-import (flera URLs)</h4>
                  <textarea
                    className="form-textarea"
                    rows={4}
                    placeholder="Klistra in URLs, en per rad..."
                    id="bulkImageUrls"
                  />
                  <button className="btn btn-secondary" style={{marginTop: '8px'}} onClick={() => {
                    const textarea = document.getElementById('bulkImageUrls');
                    handleBulkImageUrls(textarea.value);
                    textarea.value = '';
                  }}>
                    <Plus size={16} /> Lägg till alla
                  </button>

                  <div className="image-tips">
                    <h4>Tips för effektiv bildhantering</h4>
                    <ul>
                      <li><strong>SKU-mappning:</strong> Namnge bilder som <code>SKU-1.jpg</code>, <code>SKU-2.jpg</code> etc.</li>
                      <li><strong>EAN-mappning:</strong> Eller använd <code>EAN.jpg</code> för automatisk matchning</li>
                      <li><strong>Leverantörs-URL:</strong> Klistra in URLs direkt från leverantörens mediabank</li>
                      <li><strong>Rekommenderad storlek:</strong> 1200x1200px, kvadratiskt format</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Variants Tab */}
          {activeTab === 'variants' && (
            <div className="tab-content">
              <div className="form-section">
                {(() => {
                  const variants = editedProduct.variants || [];
                  const first = variants[0] || {};
                  const optCols = [
                    first.option1_name ? { name: first.option1_name, nameField: 'option1_name', valField: 'option1_value' } : null,
                    first.option2_name ? { name: first.option2_name, nameField: 'option2_name', valField: 'option2_value' } : null,
                    first.option3_name ? { name: first.option3_name, nameField: 'option3_name', valField: 'option3_value' } : null,
                  ].filter(Boolean);

                  return (
                    <>
                      {/* Option name editors */}
                      {optCols.length > 0 && (
                        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                          {optCols.map((col, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Alternativ {i + 1}:</span>
                              <input
                                className="form-input"
                                style={{ width: 130 }}
                                value={col.name}
                                onChange={e => {
                                  const newName = e.target.value;
                                  setEditedProduct(prev => ({
                                    ...prev,
                                    variants: prev.variants.map(v => ({ ...v, [col.nameField]: newName })),
                                  }));
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Variants table */}
                      {variants.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>
                          <p style={{ marginBottom: 16 }}>Inga varianter ännu.</p>
                          <button className="btn btn-secondary" onClick={addVariant}>
                            <Plus size={14} /> Lägg till variant
                          </button>
                        </div>
                      ) : (
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                {optCols.map((col, i) => (
                                  <th key={i} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{col.name || `Alt ${i+1}`}</th>
                                ))}
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)' }}>SKU</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)' }}>EAN</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }}>Pris</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }}>Inköp</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }}>Lager</th>
                                <th style={{ padding: '6px 8px', width: 32 }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {variants.map((v) => (
                                <tr key={v.id} style={{ borderBottom: '1px solid var(--border-light, #f0f0f0)' }}>
                                  {optCols.map((col, i) => (
                                    <td key={i} style={{ padding: '4px 6px' }}>
                                      <input
                                        className="form-input"
                                        style={{ minWidth: 80 }}
                                        value={v[col.valField] || ''}
                                        onChange={e => handleVariantChange(v.id, col.valField, e.target.value)}
                                      />
                                    </td>
                                  ))}
                                  <td style={{ padding: '4px 6px' }}>
                                    <input className="form-input" style={{ width: 110, fontFamily: 'monospace', fontSize: 12 }}
                                      value={v.sku || ''} onChange={e => handleVariantChange(v.id, 'sku', e.target.value)} />
                                  </td>
                                  <td style={{ padding: '4px 6px' }}>
                                    <input className="form-input" style={{ width: 120, fontFamily: 'monospace', fontSize: 12 }}
                                      value={v.barcode || ''} onChange={e => handleVariantChange(v.id, 'barcode', e.target.value)} />
                                  </td>
                                  <td style={{ padding: '4px 6px' }}>
                                    <input className="form-input" style={{ width: 80, textAlign: 'right' }} type="number"
                                      value={v.price ?? ''} onChange={e => handleVariantChange(v.id, 'price', e.target.value === '' ? null : Number(e.target.value))} />
                                  </td>
                                  <td style={{ padding: '4px 6px' }}>
                                    <input className="form-input" style={{ width: 80, textAlign: 'right' }} type="number"
                                      value={v.cost ?? ''} onChange={e => handleVariantChange(v.id, 'cost', e.target.value === '' ? null : Number(e.target.value))} />
                                  </td>
                                  <td style={{ padding: '4px 6px' }}>
                                    <input className="form-input" style={{ width: 70, textAlign: 'right' }} type="number"
                                      value={v.inventory_quantity ?? 0} onChange={e => handleVariantChange(v.id, 'inventory_quantity', Number(e.target.value))} />
                                  </td>
                                  <td style={{ padding: '4px 6px' }}>
                                    <button
                                      onClick={() => removeVariant(v.id)}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}
                                      title="Ta bort variant"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <div style={{ marginTop: 16 }}>
                        <button className="btn btn-secondary" onClick={addVariant}>
                          <Plus size={14} /> Lägg till variant
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Inventory & Shipping Tab */}
          {activeTab === 'inventory' && (
            <div className="tab-content">
              {/* Live lagersaldo från Shopify */}
              <div className="form-section">
                <h3 className="form-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  Lagersaldo per butik
                  {!inventoryLoading && inventoryData && (
                    <button className="btn-icon" onClick={loadInventory} title="Uppdatera" style={{ marginLeft: 'auto' }}>
                      <RefreshCw size={14} />
                    </button>
                  )}
                </h3>
                {inventoryLoading && (
                  <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={18} className="spin" />
                    <span>Hämtar lagersaldo...</span>
                  </div>
                )}
                {inventoryData && inventoryData.stores?.length === 0 && (
                  <p style={{ color: '#888', padding: '8px 0' }}>Produkten är inte kopplad till någon Shopify-butik</p>
                )}
                {inventoryData?.stores?.map(store => (
                  <div key={store.storeId} style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <Store size={16} />
                      <strong>{store.storeName}</strong>
                      {store.inventory && (
                        <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>
                          Totalt: {store.inventory.grandTotal}
                        </span>
                      )}
                    </div>
                    {store.error && <p style={{ color: '#dc2626', fontSize: 13 }}>{store.error}</p>}
                    {store.inventory && (
                      <>
                        <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                          {store.inventory.locationTotals.map(loc => (
                            <div key={loc.locationId} style={{ fontSize: 13 }}>
                              <MapPin size={12} style={{ display: 'inline', marginRight: 4 }} />
                              <span>{loc.locationName}: </span>
                              <strong>{loc.totalAvailable}</strong>
                            </div>
                          ))}
                        </div>
                        {store.inventory.variants.length > 1 && (
                          <table className="variants-table" style={{ fontSize: 12 }}>
                            <thead>
                              <tr>
                                <th>Variant</th>
                                <th>SKU</th>
                                {store.inventory.locationTotals.map(loc => (
                                  <th key={loc.locationId}>{loc.locationName}</th>
                                ))}
                                <th>Totalt</th>
                              </tr>
                            </thead>
                            <tbody>
                              {store.inventory.variants.map(v => (
                                <tr key={v.variantId}>
                                  <td>{v.displayName}</td>
                                  <td className="mono">{v.sku}</td>
                                  {store.inventory.locationTotals.map(loc => {
                                    const level = v.inventoryLevels.find(l => l.locationId === loc.locationId);
                                    return <td key={loc.locationId} className="mono">{level?.available ?? 0}</td>;
                                  })}
                                  <td className="mono"><strong>{v.totalAvailable}</strong></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {!inventoryLoading && !inventoryData && !product.id?.toString().startsWith('new-') && (
                  <button className="btn btn-secondary" onClick={loadInventory} style={{ marginTop: 8 }}>
                    <RefreshCw size={16} /> Hämta lagersaldo
                  </button>
                )}
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Lagerhantering</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Lagerhantering</label>
                    <select className="form-input" value={editedProduct.inventoryTracker || 'shopify'}
                      onChange={e => handleFieldChange('inventoryTracker', e.target.value)}>
                      <option value="shopify">Shopify spårar lager</option>
                      <option value="none">Spåra inte lager</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Vid slutsålt</label>
                    <select className="form-input" value={editedProduct.inventoryPolicy || 'deny'}
                      onChange={e => handleFieldChange('inventoryPolicy', e.target.value)}>
                      <option value="deny">Stoppa försäljning (DENY)</option>
                      <option value="continue">Fortsätt sälja (CONTINUE)</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Frakt</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={editedProduct.requiresShipping !== false}
                        onChange={e => handleFieldChange('requiresShipping', e.target.checked)} />
                      <span>Kräver frakt</span>
                    </label>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Standardvikt (gram)</label>
                    <input type="number" className="form-input mono" value={editedProduct.weight || ''}
                      onChange={e => handleFieldChange('weight', Number(e.target.value))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Viktenhet</label>
                    <select className="form-input" value={editedProduct.weightUnit || 'g'}
                      onChange={e => handleFieldChange('weightUnit', e.target.value)}>
                      <option value="g">Gram (g)</option>
                      <option value="kg">Kilogram (kg)</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Moms</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={editedProduct.chargeTax !== false}
                        onChange={e => handleFieldChange('chargeTax', e.target.checked)} />
                      <span>Ta ut moms (Charge tax = TRUE)</span>
                    </label>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Momskod</label>
                    <input type="text" className="form-input" value={editedProduct.taxCode || ''}
                      onChange={e => handleFieldChange('taxCode', e.target.value)}
                      placeholder="Lämna tomt för standard" />
                  </div>
                </div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Fulfillment</h3>
                <div className="form-group">
                  <label className="form-label">Fulfillment-tjänst</label>
                  <select className="form-input" value={editedProduct.fulfillmentService || 'manual'}
                    onChange={e => handleFieldChange('fulfillmentService', e.target.value)}>
                    <option value="manual">Manuell</option>
                  </select>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Tull & export</h3>
                <p className="form-section-description">
                  Krävs för försäljning till länder utanför EU (t.ex. Norge, Schweiz). Shopify skickar dessa till transportören vid skapande av fraktsedlar.
                </p>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">
                      Ursprungsland
                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>ISO-kod (2 tecken)</span>
                    </label>
                    <input
                      type="text"
                      className="form-input mono"
                      maxLength={2}
                      style={{ textTransform: 'uppercase', width: '80px' }}
                      value={editedProduct.country_of_origin || ''}
                      onChange={e => handleFieldChange('country_of_origin', e.target.value.toUpperCase())}
                      placeholder="SE"
                    />
                    <span className="form-help">
                      {editedProduct.country_of_origin && COUNTRY_NAMES[editedProduct.country_of_origin]}
                    </span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      HS-kod
                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>Tullkod</span>
                    </label>
                    <input
                      type="text"
                      className="form-input mono"
                      value={editedProduct.hs_code || ''}
                      onChange={e => handleFieldChange('hs_code', e.target.value)}
                      placeholder="6912.00.23"
                    />
                    <span className="form-help">Harmonized System-kod för tulldeklaration</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SEO Tab */}
          {activeTab === 'seo' && (
            <div className="tab-content">
              <div className="form-section">
                <div className="form-section-header">
                  <h3 className="form-section-title">Sökmotoroptimering (SEO)</h3>
                  <button className="btn btn-accent" onClick={() => {
                    setGenerateOptions(prev => ({ ...prev, includeSEO: true }));
                    setShowGenerateModal(true);
                  }}>
                    <Sparkles size={16} /> Generera SEO
                  </button>
                </div>
                <div className="seo-preview">
                  <div className="seo-preview-title">Förhandsvisning i Google</div>
                  <div className="seo-preview-box">
                    <div className="seo-preview-url">dinbutik.se › produkter › {editedProduct.handle || 'produkt'}</div>
                    <div className="seo-preview-headline">{editedProduct.seoTitle || editedProduct.title || 'Produkttitel'}</div>
                    <div className="seo-preview-description">{editedProduct.seoDescription || 'Lägg till en meta-beskrivning...'}</div>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    SEO-titel
                    <span className={`char-count ${(editedProduct.seoTitle?.length || 0) > 60 ? 'over' : ''}`}>
                      {editedProduct.seoTitle?.length || 0}/60
                    </span>
                  </label>
                  <input type="text" className="form-input" value={editedProduct.seoTitle || ''}
                    onChange={e => handleFieldChange('seoTitle', e.target.value)}
                    placeholder="Produkttitel | Köp online | Din Butik" />
                  {(editedProduct.seoTitle?.length || 0) > 60 && (
                    <span className="form-error"><AlertCircle size={12} /> Titeln är för lång</span>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Meta-beskrivning
                    <span className={`char-count ${(editedProduct.seoDescription?.length || 0) > 155 ? 'over' : ''}`}>
                      {editedProduct.seoDescription?.length || 0}/155
                    </span>
                  </label>
                  <textarea className="form-textarea" rows={3} value={editedProduct.seoDescription || ''}
                    onChange={e => handleFieldChange('seoDescription', e.target.value)}
                    placeholder="En kort, säljande beskrivning..." />
                </div>
              </div>
            </div>
          )}

          {/* Schema Tab */}
          {activeTab === 'schema' && (
            <div className="tab-content">
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">JSON-LD Product Schema</h3>
                    <p className="form-section-description">
                      Strukturerad data för sökmotorer. Genereras automatiskt från produktdata, specifikationer och FAQ.
                    </p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('schema')}>
                    <Sparkles size={16} /> Generera schema
                  </button>
                </div>
                <div className="form-group">
                  <textarea className="form-input form-textarea mono" rows={20}
                    value={editedProduct.schemaJson ? JSON.stringify(editedProduct.schemaJson, null, 2) : ''}
                    onChange={e => {
                      try { handleFieldChange('schemaJson', JSON.parse(e.target.value)); }
                      catch {}
                    }}
                    placeholder='{"@context": "https://schema.org", "@type": "Product", ...}'
                    style={{ fontSize: '12px', lineHeight: '1.5' }} />
                  <span className="form-help">
                    Validera med Google Rich Results Test. Inkluderar: Product, Offer, AggregateRating, FAQ, additionalProperty.
                  </span>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Schema-status</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {[
                    { label: 'Product @type', ok: !!editedProduct.schemaJson },
                    { label: 'SKU i schema', ok: editedProduct.schemaJson?.sku != null },
                    { label: 'Offer (pris)', ok: editedProduct.schemaJson?.offers != null },
                    { label: 'additionalProperty', ok: editedProduct.schemaJson?.additionalProperty?.length > 0 },
                    { label: 'FAQ schema', ok: editedProduct.faq?.length >= 3 },
                    { label: 'Bilder', ok: editedProduct.images?.length > 0 },
                  ].map(item => (
                    <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                      {item.ok
                        ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                        : <AlertCircle size={16} style={{ color: 'var(--warning)' }} />}
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Search & Discovery Tab */}
          {activeTab === 'search-discovery' && (
            <div className="tab-content">
              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Söktermer & Synonymer</h3>
                    <p className="form-section-description">
                      Hjälper Shopifys Search & Discovery att hitta produkten vid relevanta sökningar.
                    </p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('searchTerms')}>
                    <Sparkles size={16} /> Generera
                  </button>
                </div>
                <div className="form-group">
                  <label className="form-label">Söktermer (synonymer, alternativa namn)</label>
                  <textarea className="form-input form-textarea" rows={3}
                    value={editedProduct.searchTerms || ''}
                    onChange={e => handleFieldChange('searchTerms', e.target.value)}
                    placeholder="sneakers, löparskor, joggingskor, träningsskor, running shoes" />
                  <span className="form-help">Kommaseparerade. AI-agenter och intern sökning använder dessa.</span>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Filterattribut</h3>
                <p className="form-section-description">
                  Attribut som visas som filter i Shopifys Search & Discovery. Kopplas till Shopify taxonomy-attribut.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(editedProduct.filterAttributes || []).map((attr, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input type="text" className="form-input" style={{ flex: 1 }}
                        value={attr.name || ''} placeholder="Filternamn (t.ex. Färg)"
                        onChange={e => {
                          const attrs = [...(editedProduct.filterAttributes || [])];
                          attrs[idx] = { ...attrs[idx], name: e.target.value };
                          handleFieldChange('filterAttributes', attrs);
                        }} />
                      <input type="text" className="form-input" style={{ flex: 2 }}
                        value={attr.values || ''} placeholder="Värden (kommaseparerade: Svart, Blå, Röd)"
                        onChange={e => {
                          const attrs = [...(editedProduct.filterAttributes || [])];
                          attrs[idx] = { ...attrs[idx], values: e.target.value };
                          handleFieldChange('filterAttributes', attrs);
                        }} />
                      <button className="btn-icon-sm danger" onClick={() => {
                        handleFieldChange('filterAttributes', (editedProduct.filterAttributes || []).filter((_, i) => i !== idx));
                      }}><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}
                    onClick={() => handleFieldChange('filterAttributes', [...(editedProduct.filterAttributes || []), { name: '', values: '' }])}>
                    <Plus size={16} /> Lägg till filter
                  </button>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-header">
                  <div>
                    <h3 className="form-section-title">Relaterade produkter</h3>
                    <p className="form-section-description">
                      Kompletterande produkter och alternativ. Används av Search & Discovery för rekommendationer.
                    </p>
                  </div>
                  <button className="btn btn-accent" onClick={() => handleAIGenerate('relatedProducts')}>
                    <Sparkles size={16} /> Föreslå
                  </button>
                </div>
                <div className="form-group">
                  <label className="form-label">Kompletterande produkter (cross-sell)</label>
                  <textarea className="form-input form-textarea" rows={2}
                    value={editedProduct.complementaryProducts || ''}
                    onChange={e => handleFieldChange('complementaryProducts', e.target.value)}
                    placeholder="SKU eller produktnamn, kommaseparerade" />
                </div>
                <div className="form-group">
                  <label className="form-label">Alternativa produkter (liknande)</label>
                  <textarea className="form-input form-textarea" rows={2}
                    value={editedProduct.similarProducts || ''}
                    onChange={e => handleFieldChange('similarProducts', e.target.value)}
                    placeholder="SKU eller produktnamn, kommaseparerade" />
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Collections / Kategorier</h3>
                <div className="form-group">
                  <label className="form-label">Collections att inkludera i</label>
                  <input type="text" className="form-input"
                    value={editedProduct.collections || ''}
                    onChange={e => handleFieldChange('collections', e.target.value)}
                    placeholder="Nyheter, Herr, Skor, Rea" />
                  <span className="form-help">Kommaseparerade. Shopify collections som produkten ska läggas till i.</span>
                </div>
              </div>
            </div>
          )}

          {/* Metafields Tab */}
          {activeTab === 'metafields' && (
            <MetafieldsTab
              editedProduct={editedProduct}
              onMetafieldChange={handleMetafieldChange}
              stores={stores}
            />
          )}

          {/* Google Shopping Tab */}
          {activeTab === 'google' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Produktkategori</h3>
                <p className="form-section-description">
                  Välj kategori från Shopifys taxonomy. Google-kategorin mappas automatiskt.
                </p>
                <div className="form-group">
                  <label className="form-label">Shopify produktkategori</label>
                  <CategoryPicker
                    value={editedProduct.productCategory || ''}
                    onChange={val => handleFieldChange('productCategory', val)}
                  />
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Feed-optimerad titel & beskrivning</h3>
                <p className="form-section-description">
                  Google vill ha attribut-packade titlar (t.ex. "Nike Air Max 90 - Svart - Storlek 42 - Herr").
                  Butikstiteln behålls som den är — feed-titeln skickas bara till Google Merchant Center.
                </p>
                <div className="form-grid field-cards">
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label className="form-label">Feed-titel (max 150 tecken)</label>
                    <input type="text" className="form-input" maxLength={150}
                      value={editedProduct.feedTitle || ''}
                      onChange={e => handleFieldChange('feedTitle', e.target.value)}
                      placeholder={editedProduct.title || 'Lämna tomt för att använda butikstiteln'} />
                    <span className="form-help">
                      {(editedProduct.feedTitle || '').length}/150 tecken
                      {!editedProduct.feedTitle && ' — Butikstiteln används om detta är tomt'}
                    </span>
                  </div>
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label className="form-label">Feed-beskrivning</label>
                    <textarea className="form-input form-textarea" rows={3}
                      value={editedProduct.feedDescription || ''}
                      onChange={e => handleFieldChange('feedDescription', e.target.value)}
                      placeholder="Lämna tomt för att använda kort beskrivning eller produktbeskrivning" />
                    <span className="form-help">
                      Använd attribut-rik text optimerad för Google. Lämna tomt för att använda befintlig beskrivning.
                    </span>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Google Shopping-attribut</h3>
                <p className="form-section-description">
                  Produktegenskaper som skickas till Google Merchant Center.
                </p>
                <div className="form-grid field-cards">
                  <div className="form-group">
                    <label className="form-label">Kön</label>
                    <select className="form-input" value={editedProduct.googleShopping?.gender || ''}
                      onChange={e => handleGoogleShoppingChange('gender', e.target.value)}>
                      <option value="">-- Välj --</option>
                      <option value="Unisex">Unisex</option>
                      <option value="Male">Herr</option>
                      <option value="Female">Dam</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Åldersgrupp</label>
                    <select className="form-input" value={editedProduct.googleShopping?.ageGroup || ''}
                      onChange={e => handleGoogleShoppingChange('ageGroup', e.target.value)}>
                      <option value="">-- Välj --</option>
                      <option value="Adult">Vuxen</option>
                      <option value="Kids">Barn</option>
                      <option value="Toddler">Småbarn</option>
                      <option value="Infant">Spädbarn</option>
                      <option value="Newborn">Nyfödd</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Skick</label>
                    <select className="form-input" value={editedProduct.googleShopping?.condition || 'New'}
                      onChange={e => handleGoogleShoppingChange('condition', e.target.value)}>
                      <option value="New">Ny</option>
                      <option value="Used">Begagnad</option>
                      <option value="Refurbished">Renoverad</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">MPN</label>
                    <input type="text" className="form-input" value={editedProduct.googleShopping?.mpn || ''}
                      onChange={e => handleGoogleShoppingChange('mpn', e.target.value)}
                      placeholder="Tillverkarens artikelnummer" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Material</label>
                    <input type="text" className="form-input" value={editedProduct.googleShopping?.material || ''}
                      onChange={e => handleGoogleShoppingChange('material', e.target.value)}
                      placeholder="T.ex. Bomull, Polyester" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Mönster</label>
                    <input type="text" className="form-input" value={editedProduct.googleShopping?.pattern || ''}
                      onChange={e => handleGoogleShoppingChange('pattern', e.target.value)}
                      placeholder="T.ex. Randig, Prickig" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Storlek</label>
                    <input type="text" className="form-input" value={editedProduct.googleShopping?.size || ''}
                      onChange={e => handleGoogleShoppingChange('size', e.target.value)}
                      placeholder="T.ex. M, 42, One Size" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Färg</label>
                    <input type="text" className="form-input" value={editedProduct.googleShopping?.color || ''}
                      onChange={e => handleGoogleShoppingChange('color', e.target.value)}
                      placeholder="T.ex. Svart, Röd/Blå" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'google-ads' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Custom Labels</h3>
                <p className="form-section-description">
                  Används för att segmentera produkter i Google Shopping- och Performance Max-kampanjer.
                  Upp till 5 labels per produkt, max 100 tecken var.
                </p>
                <div className="form-grid field-cards">
                  <div className="form-group">
                    <label className="form-label">Custom Label 0</label>
                    <input type="text" className="form-input" maxLength={100}
                      value={editedProduct.googleShopping?.customLabel0 || ''}
                      onChange={e => handleGoogleShoppingChange('customLabel0', e.target.value)}
                      placeholder="T.ex. Bästsäljare, Säsong, Marginal" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Custom Label 1</label>
                    <input type="text" className="form-input" maxLength={100}
                      value={editedProduct.googleShopping?.customLabel1 || ''}
                      onChange={e => handleGoogleShoppingChange('customLabel1', e.target.value)}
                      placeholder="T.ex. Nyhet, Rea, Premium" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Custom Label 2</label>
                    <input type="text" className="form-input" maxLength={100}
                      value={editedProduct.googleShopping?.customLabel2 || ''}
                      onChange={e => handleGoogleShoppingChange('customLabel2', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Custom Label 3</label>
                    <input type="text" className="form-input" maxLength={100}
                      value={editedProduct.googleShopping?.customLabel3 || ''}
                      onChange={e => handleGoogleShoppingChange('customLabel3', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Custom Label 4</label>
                    <input type="text" className="form-input" maxLength={100}
                      value={editedProduct.googleShopping?.customLabel4 || ''}
                      onChange={e => handleGoogleShoppingChange('customLabel4', e.target.value)} />
                  </div>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Display & Remarketing</h3>
                <p className="form-section-description">
                  Fält för dynamisk remarketing och Display-kampanjer.
                </p>
                <div className="form-grid field-cards">
                  <div className="form-group">
                    <label className="form-label">Ads Grouping</label>
                    <input type="text" className="form-input"
                      value={editedProduct.googleShopping?.adsGrouping || ''}
                      onChange={e => handleGoogleShoppingChange('adsGrouping', e.target.value)}
                      placeholder="Gruppering för Display-annonser" />
                    <span className="form-help">Grupperar produkter i Display-kampanjer (ett värde per produkt)</span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Ads Redirect</label>
                    <input type="url" className="form-input"
                      value={editedProduct.googleShopping?.adsRedirect || ''}
                      onChange={e => handleGoogleShoppingChange('adsRedirect', e.target.value)}
                      placeholder="https://..." />
                    <span className="form-help">Alternativ URL med UTM-parametrar för annonsklick</span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Promotion ID</label>
                    <input type="text" className="form-input"
                      value={editedProduct.googleShopping?.promotionId || ''}
                      onChange={e => handleGoogleShoppingChange('promotionId', e.target.value)}
                      placeholder="T.ex. SUMMER_SALE_2026" />
                    <span className="form-help">Kopplar produkten till en kampanj i Merchant Center</span>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <h3 className="form-section-title">Annonsinnehåll</h3>
                <div className="form-grid field-cards">
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label className="form-label">Produkthöjdpunkter</label>
                    <textarea className="form-input form-textarea" rows={3}
                      value={editedProduct.googleShopping?.productHighlight || ''}
                      onChange={e => handleGoogleShoppingChange('productHighlight', e.target.value)}
                      placeholder="Korta punkter som visas i annonser (en per rad)" />
                    <span className="form-help">Max 150 tecken per rad. Visas som bullet points i Shopping-annonser.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Quality Tab */}
          {activeTab === 'quality' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Kvalitetspoäng</h3>
                <p className="form-section-description">
                  Baserat på Module J-standard. Mäter kompletthetsgrad för SEO, AI-agenter och konvertering.
                </p>

                {(() => {
                  const checks = [
                    { group: 'Content (40p)', items: [
                      { label: 'Produkttitel (utan butiksnamn, max 70 tecken)', weight: 5, pass: !!editedProduct.title && editedProduct.title.length <= 70 },
                      { label: 'Meta title (max 60 tecken)', weight: 5, pass: !!editedProduct.seoTitle && editedProduct.seoTitle.length <= 60 },
                      { label: 'Meta description (max 155 tecken)', weight: 5, pass: !!editedProduct.seoDescription && editedProduct.seoDescription.length <= 155 && editedProduct.seoDescription.length > 50 },
                      { label: 'Kort ingress (2-3 meningar)', weight: 5, pass: !!editedProduct.shortDescription && editedProduct.shortDescription.length > 50 },
                      { label: 'Snabbfakta / Agent summary', weight: 5, pass: !!editedProduct.agentSummary && editedProduct.agentSummary.length > 100 },
                      { label: 'Produktbeskrivning (>150 ord)', weight: 5, pass: !!editedProduct.description && editedProduct.description.replace(/<[^>]*>/g, '').split(/\s+/).length > 150 },
                      { label: 'Specifikationer (min 10)', weight: 5, pass: (editedProduct.specifications || []).length >= 10 },
                      { label: 'FAQ (min 5 frågor)', weight: 5, pass: (editedProduct.faq || []).length >= 5 },
                    ]},
                    { group: 'Taxonomy & Attribut (25p)', items: [
                      { label: 'Shopify produktkategori vald', weight: 8, pass: !!editedProduct.productCategory },
                      { label: 'Filterattribut definierade', weight: 7, pass: (editedProduct.filterAttributes || []).length >= 2 },
                      { label: 'Färg angiven', weight: 5, pass: !!(editedProduct.googleShopping?.color || (editedProduct.specifications || []).some(s => s.name?.toLowerCase().includes('färg'))) },
                      { label: 'Användningsområden', weight: 5, pass: !!editedProduct.useCases && editedProduct.useCases.length > 30 },
                    ]},
                    { group: 'Schema & Teknik (20p)', items: [
                      { label: 'JSON-LD schema genererat', weight: 8, pass: !!editedProduct.schemaJson },
                      { label: 'Bilder (minst 1)', weight: 4, pass: (editedProduct.images || []).length > 0 },
                      { label: 'Alt-text på alla bilder', weight: 4, pass: (editedProduct.images || []).length > 0 && editedProduct.images.every(i => !!i.alt) },
                      { label: 'Söktermer definierade', weight: 4, pass: !!editedProduct.searchTerms && editedProduct.searchTerms.length > 10 },
                    ]},
                    { group: 'Identifiering (15p)', items: [
                      { label: 'SKU', weight: 5, pass: !!editedProduct.sku || !!(editedProduct.variants || []).some(v => v.sku) },
                      { label: 'EAN/GTIN', weight: 5, pass: !!editedProduct.barcode || !!(editedProduct.variants || []).some(v => v.barcode) },
                      { label: 'Pris satt', weight: 5, pass: !!editedProduct.price || !!(editedProduct.variants || []).some(v => v.price) },
                    ]},
                  ];

                  let totalScore = 0;
                  let maxScore = 0;
                  const allItems = [];

                  checks.forEach(group => {
                    group.items.forEach(item => {
                      maxScore += item.weight;
                      if (item.pass) totalScore += item.weight;
                      allItems.push(item);
                    });
                  });

                  const percentage = Math.round((totalScore / maxScore) * 100);
                  const level = percentage >= 80 ? 'green' : percentage >= 50 ? 'yellow' : 'red';
                  const levelColor = level === 'green' ? 'var(--success)' : level === 'yellow' ? 'var(--warning)' : 'var(--error)';

                  return (
                    <>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '24px',
                        padding: '24px', background: 'var(--bg)', borderRadius: '12px',
                        border: `2px solid ${levelColor}`, marginBottom: '24px'
                      }}>
                        <div style={{
                          fontSize: '48px', fontWeight: 700, color: levelColor,
                          lineHeight: 1, minWidth: '80px', textAlign: 'center'
                        }}>
                          {percentage}
                        </div>
                        <div>
                          <div style={{ fontSize: '18px', fontWeight: 600 }}>
                            {level === 'green' ? 'Produkten är redo' : level === 'yellow' ? 'Behöver förbättring' : 'Bristfällig data'}
                          </div>
                          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                            {totalScore} av {maxScore} poäng • {allItems.filter(i => i.pass).length} av {allItems.length} kriterier uppfyllda
                          </div>
                        </div>
                      </div>

                      {checks.map(group => (
                        <div key={group.group} style={{ marginBottom: '20px' }}>
                          <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
                            {group.group}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {group.items.map(item => (
                              <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                                {item.pass
                                  ? <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
                                  : <AlertCircle size={16} style={{ color: 'var(--error)', flexShrink: 0 }} />}
                                <span style={{ color: item.pass ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{item.label}</span>
                                <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-secondary)' }}>{item.weight}p</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Publish Tab */}
          {activeTab === 'publish' && (
            <div className="tab-content">
              <div className="form-section">
                <h3 className="form-section-title">Publicera till Shopify</h3>
                <p className="form-section-description">Välj vilka butiker som ska ha denna produkt.</p>
                <div className="publish-stores-list">
                  {stores.filter(s => s.status === 'connected').map(store => {
                    const isPublished = editedProduct.publishedTo?.includes(store.id);
                    return (
                      <div 
                        key={store.id}
                        className={`publish-store-item ${isPublished ? 'published' : ''}`}
                        onClick={() => {
                          const newPublished = isPublished
                            ? editedProduct.publishedTo.filter(id => id !== store.id)
                            : [...(editedProduct.publishedTo || []), store.id];
                          handleFieldChange('publishedTo', newPublished);
                        }}
                      >
                        <div className={`publish-checkbox ${isPublished ? 'checked' : ''}`}>
                          {isPublished && <CheckCircle2 size={16} />}
                        </div>
                        <div className="publish-store-info">
                          <div className="publish-store-name">{store.name}</div>
                          <div className="publish-store-domain">{store.domain}</div>
                        </div>
                        {isPublished && <span className="publish-status">Publicerad</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Generate Modal */}
        {showGenerateModal && (
          <div className="generate-modal-overlay" onClick={() => setShowGenerateModal(false)}>
            <div className="generate-modal" onClick={e => e.stopPropagation()}>
              <div className="generate-modal-header">
                <Sparkles size={20} />
                <h3>Generera med AI</h3>
                <button className="btn-icon" onClick={() => setShowGenerateModal(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="generate-modal-body">
                <div className="form-group">
                  <label className="form-label">Stil</label>
                  <select className="form-input" value={generateOptions.style}
                    onChange={e => setGenerateOptions(prev => ({ ...prev, style: e.target.value }))}>
                    <option value="sales">Säljande</option>
                    <option value="technical">Teknisk</option>
                    <option value="neutral">Neutral</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Längd</label>
                  <select className="form-input" value={generateOptions.length}
                    onChange={e => setGenerateOptions(prev => ({ ...prev, length: e.target.value }))}>
                    <option value="short">Kort (50-100 ord)</option>
                    <option value="medium">Medium (100-200 ord)</option>
                    <option value="long">Lång (200-400 ord)</option>
                    <option value="extra_long">Extra lång (400-600 ord, med rubriker)</option>
                  </select>
                  <p className="form-help" style={{ marginTop: '4px', fontSize: '11px' }}>
                    Lång och Extra lång inkluderar rubriker och punktlistor automatiskt
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Språk</label>
                  <select className="form-input" value={generateOptions.language}
                    onChange={e => setGenerateOptions(prev => ({ ...prev, language: e.target.value }))}>
                    <option value="sv">Svenska</option>
                    <option value="en">Engelska</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={generateOptions.includeSEO}
                      onChange={e => setGenerateOptions(prev => ({ ...prev, includeSEO: e.target.checked }))} />
                    <span>Inkludera SEO (titel + meta description)</span>
                  </label>
                </div>
                <div className="form-group">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={generateOptions.includeShortDescription !== false}
                      onChange={e => setGenerateOptions(prev => ({ ...prev, includeShortDescription: e.target.checked }))} />
                    <span>Generera även kort beskrivning</span>
                  </label>
                </div>
                {editedProduct.metafields?.['custom.source_material'] && (
                  <div className="form-group" style={{
                    backgroundColor: 'var(--bg-tertiary)',
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)'
                  }}>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={generateOptions.useSourceMaterial !== false}
                        onChange={e => setGenerateOptions(prev => ({ ...prev, useSourceMaterial: e.target.checked }))} />
                      <span style={{ fontWeight: 500 }}>Använd källmaterial</span>
                    </label>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', marginLeft: '24px' }}>
                      {(editedProduct.metafields?.['custom.source_material'] || '').length} tecken källmaterial tillgängligt.
                      AI:n baserar texten på detta istället för att hitta på.
                    </p>
                  </div>
                )}
              </div>
              <div className="generate-modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowGenerateModal(false)}>Avbryt</button>
                <button className="btn btn-primary" onClick={handleGenerateDescription} disabled={isGenerating}>
                  {isGenerating ? <><Loader2 size={16} className="spin" /> Genererar...</> : <><Sparkles size={16} /> Generera</>}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <div className="generate-modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
            <div className="generate-modal delete-confirm-modal" onClick={e => e.stopPropagation()}>
              <div className="generate-modal-header">
                <Trash2 size={20} style={{ color: 'var(--error)' }} />
                <h3>Ta bort produkt</h3>
                <button className="btn-icon" onClick={() => setShowDeleteConfirm(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="generate-modal-body">
                <p style={{ marginBottom: '16px' }}>
                  Är du säker på att du vill ta bort <strong>{editedProduct.title || 'denna produkt'}</strong>?
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                  Denna åtgärd kan inte ångras. Produkten kommer att tas bort permanent från PIM.
                </p>
              </div>
              <div className="generate-modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>Avbryt</button>
                <button className="btn btn-danger" onClick={handleDelete} disabled={isDeleting}>
                  {isDeleting ? <><Loader2 size={16} className="spin" /> Tar bort...</> : <><Trash2 size={16} /> Ta bort</>}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
