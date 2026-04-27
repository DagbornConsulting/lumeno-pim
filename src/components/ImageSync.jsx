import React, { useState } from 'react';
import { 
  Image, Link2, RefreshCw, CheckCircle2, AlertCircle, 
  Loader2, X, Server, FolderOpen, Zap, Download,
  Settings, Play, Pause, RotateCcw, ExternalLink, Plus, Trash2, Save
} from 'lucide-react';
import './ImageSync.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// Default supplier image profiles
const defaultSupplierProfiles = {
  '_default': {
    baseUrl: '',
    pattern: '{sku}-{n}.jpg',
    altPatterns: ['{sku}.jpg', '{ean}.jpg'],
    maxImages: 8
  }
};

export default function ImageSync({ products, onUpdateProducts, onClose }) {
  const [supplierProfiles, setSupplierProfiles] = useState(defaultSupplierProfiles);
  const [activeTab, setActiveTab] = useState('scan'); // scan, profiles, import-urls
  const [selectedVendor, setSelectedVendor] = useState('_all');
  
  // Get unique vendors from products
  const vendors = [...new Set(products.map(p => p.vendor || p.brand).filter(Boolean))];
  
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, vendor: '' });
  const [logs, setLogs] = useState([]);
  
  // URL import state
  const [urlImportText, setUrlImportText] = useState('');
  const [urlImportResults, setUrlImportResults] = useState(null);

  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev.slice(-100), { message, type, time: new Date().toLocaleTimeString() }]);
  };

  // Get profile for a vendor
  const getProfile = (vendor) => {
    return supplierProfiles[vendor] || supplierProfiles['_default'];
  };

  // Build image URL from pattern
  const buildImageUrl = (baseUrl, pattern, product, variant, imageNumber) => {
    let url = baseUrl + pattern;
    
    const sku = variant?.sku || product.variants?.[0]?.sku || '';
    const ean = variant?.barcode || product.variants?.[0]?.barcode || '';
    const handle = product.handle || '';
    const vendor = (product.vendor || product.brand || '').toLowerCase().replace(/\s+/g, '-');
    
    url = url.replace('{sku}', sku);
    url = url.replace('{SKU}', sku.toUpperCase());
    url = url.replace('{ean}', ean);
    url = url.replace('{handle}', handle);
    url = url.replace('{vendor}', vendor);
    url = url.replace('{n}', imageNumber.toString());
    
    return url;
  };

  // Check if image exists
  const checkImageExists = async (url) => {
    try {
      const response = await fetch(`${API_URL}/images/check?url=${encodeURIComponent(url)}`);
      const data = await response.json();
      return data.exists;
    } catch (error) {
      return true; // Assume exists if can't check
    }
  };

  // Scan products for images
  const handleScan = async () => {
    setIsScanning(true);
    setScanResults(null);
    setLogs([]);
    
    const productsToScan = selectedVendor === '_all' 
      ? products 
      : products.filter(p => (p.vendor || p.brand) === selectedVendor);
    
    addLog(`Startar skanning av ${productsToScan.length} produkter...`, 'info');
    
    const results = { found: [], notFound: [], errors: [] };
    
    setProgress({ current: 0, total: productsToScan.length, vendor: selectedVendor });
    
    for (let i = 0; i < productsToScan.length; i++) {
      const product = productsToScan[i];
      const vendor = product.vendor || product.brand || '';
      const profile = getProfile(vendor);
      const sku = product.variants?.[0]?.sku || '';
      
      setProgress({ current: i + 1, total: productsToScan.length, vendor });
      
      const productImages = [];
      let foundWithPattern = null;
      
      // Try main pattern first, then alternatives
      const patternsToTry = [profile.pattern, ...(profile.altPatterns || [])];
      
      for (const pattern of patternsToTry) {
        if (foundWithPattern) break; // Already found images
        
        for (let n = 1; n <= profile.maxImages; n++) {
          const imageUrl = buildImageUrl(profile.baseUrl, pattern, product, product.variants?.[0], n);
          
          try {
            const exists = await checkImageExists(imageUrl);
            
            if (exists) {
              productImages.push({
                id: `img_${Date.now()}_${n}`,
                url: imageUrl,
                position: productImages.length + 1,
                alt: `${product.title} - Bild ${productImages.length + 1}`
              });
              foundWithPattern = pattern;
              addLog(`✓ ${sku} [${pattern}] - Bild ${n}`, 'success');
            } else if (n === 1 && pattern === profile.pattern) {
              // Only log if first image of main pattern fails
            }
          } catch (error) {
            // Silent fail
          }
          
          // Stop if image not found (sequential numbering)
          if (productImages.length < n && n > 1) break;
        }
      }
      
      if (productImages.length > 0) {
        results.found.push({ product, images: productImages, pattern: foundWithPattern });
      } else {
        results.notFound.push(product);
        addLog(`✗ ${sku} (${vendor}) - Ingen bild`, 'warning');
      }
      
      await new Promise(r => setTimeout(r, 30));
    }
    
    addLog(`Klart! ${results.found.length} med bilder, ${results.notFound.length} utan`, 'info');
    setScanResults(results);
    setIsScanning(false);
  };

  // Parse URL import text (SKU,URL format or just URLs)
  const handleParseUrls = () => {
    const lines = urlImportText.trim().split('\n').filter(l => l.trim());
    const results = { matched: [], unmatched: [] };
    
    for (const line of lines) {
      // Try to parse as "SKU,URL" or "SKU;URL" or "SKU\tURL"
      const parts = line.split(/[,;\t]/).map(p => p.trim());
      
      if (parts.length >= 2 && parts[1].startsWith('http')) {
        // Format: SKU,URL
        const [identifier, url] = parts;
        const product = products.find(p => 
          p.variants?.some(v => v.sku === identifier || v.barcode === identifier) ||
          p.handle === identifier
        );
        
        if (product) {
          results.matched.push({ product, url, identifier });
        } else {
          results.unmatched.push({ identifier, url });
        }
      } else if (parts[0].startsWith('http')) {
        // Just URL - try to extract SKU from filename
        const url = parts[0];
        const filename = url.split('/').pop()?.split('.')[0] || '';
        const product = products.find(p => 
          p.variants?.some(v => filename.includes(v.sku) || filename.includes(v.barcode))
        );
        
        if (product) {
          results.matched.push({ product, url, identifier: filename });
        } else {
          results.unmatched.push({ identifier: filename, url });
        }
      }
    }
    
    setUrlImportResults(results);
    addLog(`Parsade ${lines.length} rader: ${results.matched.length} matchade, ${results.unmatched.length} utan matchning`, 'info');
  };

  // Apply URL import
  const handleApplyUrlImport = () => {
    if (!urlImportResults) return;
    
    const updates = {};
    
    urlImportResults.matched.forEach(({ product, url }) => {
      if (!updates[product.id]) {
        updates[product.id] = { ...product, images: [...(product.images || [])] };
      }
      
      if (updates[product.id].images.length < 8) {
        updates[product.id].images.push({
          id: `img_${Date.now()}_${Math.random()}`,
          url,
          position: updates[product.id].images.length + 1,
          alt: ''
        });
      }
    });
    
    onUpdateProducts(updates);
    addLog(`Lade till bilder på ${Object.keys(updates).length} produkter`, 'success');
    setUrlImportText('');
    setUrlImportResults(null);
  };

  // Apply scan results
  const handleApply = (mode = 'add') => {
    if (!scanResults) return;
    
    const updates = {};
    
    scanResults.found.forEach(({ product, images }) => {
      let newImages;
      
      if (mode === 'replace') {
        newImages = images;
      } else {
        const existing = product.images || [];
        const maxNew = 8 - existing.length;
        newImages = [
          ...existing,
          ...images.slice(0, maxNew).map((img, idx) => ({
            ...img,
            position: existing.length + idx + 1
          }))
        ];
      }
      
      updates[product.id] = { ...product, images: newImages };
    });
    
    onUpdateProducts(updates);
    addLog(`Uppdaterade ${Object.keys(updates).length} produkter!`, 'success');
  };

  // Update supplier profile
  const updateProfile = (vendor, field, value) => {
    setSupplierProfiles(prev => ({
      ...prev,
      [vendor]: { ...prev[vendor], [field]: value }
    }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="image-sync-modal" onClick={e => e.stopPropagation()}>
        <div className="image-sync-header">
          <div className="image-sync-title">
            <Server size={24} />
            <div>
              <h2>Synka bilder</h2>
              <span>Hämta bilder automatiskt per leverantör</span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        {/* Tabs */}
        <div className="image-sync-tabs">
          <button 
            className={`tab-btn ${activeTab === 'scan' ? 'active' : ''}`}
            onClick={() => setActiveTab('scan')}
          >
            <RefreshCw size={16} /> Skanna server
          </button>
          <button 
            className={`tab-btn ${activeTab === 'import-urls' ? 'active' : ''}`}
            onClick={() => setActiveTab('import-urls')}
          >
            <Link2 size={16} /> Importera URL:er
          </button>
          <button 
            className={`tab-btn ${activeTab === 'profiles' ? 'active' : ''}`}
            onClick={() => setActiveTab('profiles')}
          >
            <Settings size={16} /> Leverantörsprofiler
          </button>
        </div>

        <div className="image-sync-body">
          {/* SCAN TAB */}
          {activeTab === 'scan' && (
            <>
              <div className="sync-section">
                <h3><FolderOpen size={16} /> Välj leverantör att skanna</h3>
                
                <div className="vendor-select-grid">
                  <button 
                    className={`vendor-btn ${selectedVendor === '_all' ? 'active' : ''}`}
                    onClick={() => setSelectedVendor('_all')}
                  >
                    <span className="vendor-count">{products.length}</span>
                    <span>Alla leverantörer</span>
                  </button>
                  {vendors.map(vendor => {
                    const count = products.filter(p => (p.vendor || p.brand) === vendor).length;
                    const profile = getProfile(vendor);
                    return (
                      <button 
                        key={vendor}
                        className={`vendor-btn ${selectedVendor === vendor ? 'active' : ''}`}
                        onClick={() => setSelectedVendor(vendor)}
                      >
                        <span className="vendor-count">{count}</span>
                        <span>{vendor}</span>
                        <code className="vendor-pattern">{profile.pattern}</code>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedVendor !== '_all' && (
                <div className="sync-section">
                  <h3><Settings size={16} /> Profil för {selectedVendor}</h3>
                  <div className="profile-preview">
                    <div className="profile-field">
                      <label>Bas-URL:</label>
                      <code>{getProfile(selectedVendor).baseUrl}</code>
                    </div>
                    <div className="profile-field">
                      <label>Mönster:</label>
                      <code>{getProfile(selectedVendor).pattern}</code>
                    </div>
                    <div className="profile-field">
                      <label>Alt. mönster:</label>
                      <code>{getProfile(selectedVendor).altPatterns?.join(', ') || 'Inga'}</code>
                    </div>
                  </div>
                </div>
              )}

              {!scanResults && (
                <div className="sync-action-section">
                  <button 
                    className="btn btn-primary btn-large"
                    onClick={handleScan}
                    disabled={isScanning}
                  >
                    {isScanning ? (
                      <>
                        <Loader2 size={20} className="spin" />
                        Skannar {progress.vendor}... ({progress.current}/{progress.total})
                      </>
                    ) : (
                      <>
                        <RefreshCw size={20} />
                        Skanna {selectedVendor === '_all' ? 'alla' : selectedVendor} ({
                          selectedVendor === '_all' 
                            ? products.length 
                            : products.filter(p => (p.vendor || p.brand) === selectedVendor).length
                        } produkter)
                      </>
                    )}
                  </button>
                </div>
              )}

              {scanResults && (
                <div className="sync-section">
                  <h3><CheckCircle2 size={16} /> Resultat</h3>
                  
                  <div className="sync-results-summary">
                    <div className="result-stat success">
                      <CheckCircle2 size={20} />
                      <div>
                        <span className="result-value">{scanResults.found.length}</span>
                        <span className="result-label">med bilder</span>
                      </div>
                    </div>
                    <div className="result-stat warning">
                      <AlertCircle size={20} />
                      <div>
                        <span className="result-value">{scanResults.notFound.length}</span>
                        <span className="result-label">utan bilder</span>
                      </div>
                    </div>
                    <div className="result-stat info">
                      <Image size={20} />
                      <div>
                        <span className="result-value">
                          {scanResults.found.reduce((acc, r) => acc + r.images.length, 0)}
                        </span>
                        <span className="result-label">totalt</span>
                      </div>
                    </div>
                  </div>

                  {scanResults.found.length > 0 && (
                    <div className="sync-results-list">
                      <h4>Hittade bilder</h4>
                      <div className="results-scroll">
                        {scanResults.found.slice(0, 15).map(({ product, images, pattern }) => (
                          <div key={product.id} className="result-item">
                            <div className="result-product">
                              <span className="result-sku">{product.variants?.[0]?.sku}</span>
                              <span className="result-title">{product.title}</span>
                              <span className="result-pattern">{pattern}</span>
                            </div>
                            <div className="result-images">
                              {images.slice(0, 4).map(img => (
                                <img 
                                  key={img.id} 
                                  src={img.url} 
                                  alt=""
                                  className="result-thumb"
                                  onError={e => e.target.style.opacity = 0.3}
                                />
                              ))}
                            </div>
                            <span className="result-count">{images.length}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="sync-apply-actions">
                    <button className="btn btn-secondary" onClick={() => setScanResults(null)}>
                      <RotateCcw size={16} /> Skanna igen
                    </button>
                    <button 
                      className="btn btn-primary"
                      onClick={() => handleApply('add')}
                      disabled={scanResults.found.length === 0}
                    >
                      <Download size={16} /> Lägg till bilder
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* IMPORT URLS TAB */}
          {activeTab === 'import-urls' && (
            <div className="sync-section">
              <h3><Link2 size={16} /> Importera bild-URL:er</h3>
              <p className="section-description">
                Klistra in URL:er från leverantörens fil. Format: <code>SKU,URL</code> eller bara URL:er.
              </p>
              
              <textarea
                className="url-import-textarea"
                rows={10}
                value={urlImportText}
                onChange={e => setUrlImportText(e.target.value)}
                placeholder={`TM-QI4D-DRV,https://dam.taylormade.com/qi4d-front.jpg
TM-QI4D-DRV,https://dam.taylormade.com/qi4d-side.jpg
CB-DARK-DRV,https://assets.cobra.com/darkspeed.jpg

Eller bara URL:er (SKU extraheras från filnamn):
https://dam.taylormade.com/TM-QI4D-DRV-1.jpg
https://dam.taylormade.com/TM-QI4D-DRV-2.jpg`}
              />
              
              <div className="url-import-actions">
                <button 
                  className="btn btn-secondary"
                  onClick={handleParseUrls}
                  disabled={!urlImportText.trim()}
                >
                  <Search size={16} /> Analysera
                </button>
              </div>

              {urlImportResults && (
                <div className="url-import-results">
                  <div className="sync-results-summary">
                    <div className="result-stat success">
                      <CheckCircle2 size={20} />
                      <div>
                        <span className="result-value">{urlImportResults.matched.length}</span>
                        <span className="result-label">matchade</span>
                      </div>
                    </div>
                    <div className="result-stat warning">
                      <AlertCircle size={20} />
                      <div>
                        <span className="result-value">{urlImportResults.unmatched.length}</span>
                        <span className="result-label">ej matchade</span>
                      </div>
                    </div>
                  </div>
                  
                  <button 
                    className="btn btn-primary"
                    onClick={handleApplyUrlImport}
                    disabled={urlImportResults.matched.length === 0}
                  >
                    <Download size={16} /> Importera {urlImportResults.matched.length} bilder
                  </button>
                </div>
              )}
            </div>
          )}

          {/* PROFILES TAB */}
          {activeTab === 'profiles' && (
            <div className="sync-section">
              <h3><Settings size={16} /> Leverantörsprofiler</h3>
              <p className="section-description">
                Konfigurera bild-URL mönster per leverantör.
              </p>
              
              <div className="profiles-list">
                {Object.entries(supplierProfiles).map(([vendor, profile]) => (
                  <div key={vendor} className="profile-card">
                    <div className="profile-header">
                      <span className="profile-vendor">
                        {vendor === '_default' ? '🌐 Standard (alla andra)' : vendor}
                      </span>
                    </div>
                    <div className="profile-fields">
                      <div className="profile-field-edit">
                        <label>Bas-URL</label>
                        <input
                          type="url"
                          value={profile.baseUrl}
                          onChange={e => updateProfile(vendor, 'baseUrl', e.target.value)}
                          placeholder="https://images.example.com/"
                        />
                      </div>
                      <div className="profile-field-edit">
                        <label>Mönster</label>
                        <input
                          type="text"
                          value={profile.pattern}
                          onChange={e => updateProfile(vendor, 'pattern', e.target.value)}
                          placeholder="{sku}-{n}.jpg"
                        />
                      </div>
                      <div className="profile-field-edit">
                        <label>Max bilder</label>
                        <input
                          type="number"
                          min="1"
                          max="8"
                          value={profile.maxImages}
                          onChange={e => updateProfile(vendor, 'maxImages', Number(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pattern-help">
                <h4>Tillgängliga variabler</h4>
                <div className="pattern-vars">
                  <code>{'{sku}'}</code> <span>Variant-SKU</span>
                  <code>{'{ean}'}</code> <span>Streckkod/EAN</span>
                  <code>{'{handle}'}</code> <span>URL-handle</span>
                  <code>{'{vendor}'}</code> <span>Leverantör (lowercase)</span>
                  <code>{'{n}'}</code> <span>Bildnummer (1-8)</span>
                </div>
              </div>
            </div>
          )}

          {/* LOG */}
          {logs.length > 0 && (
            <div className="sync-section">
              <h3><FolderOpen size={16} /> Logg</h3>
              <div className="sync-log">
                {logs.slice(-30).map((log, idx) => (
                  <div key={idx} className={`log-entry ${log.type}`}>
                    <span className="log-time">{log.time}</span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="image-sync-footer">
          <button className="btn btn-secondary" onClick={onClose}>Stäng</button>
        </div>
      </div>
    </div>
  );
}
