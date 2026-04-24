import React, { useState, useRef, useCallback } from 'react';
import { 
  Image, Upload, X, Plus, Trash2, GripVertical, Link2, 
  FolderOpen, Download, CheckCircle2, AlertCircle, Loader2,
  FileImage, Sparkles, Search, Filter, ZoomIn, ExternalLink
} from 'lucide-react';

const MAX_IMAGES = 8;

export default function ImageManager({ 
  product, 
  onImagesChange, 
  onClose,
  allProducts = [] // For bulk operations
}) {
  const [images, setImages] = useState(product?.images || []);
  const [activeTab, setActiveTab] = useState('upload'); // upload, url, bulk, mediabank
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [bulkUrls, setBulkUrls] = useState('');
  const [previewImage, setPreviewImage] = useState(null);
  const [editingAlt, setEditingAlt] = useState(null);
  const fileInputRef = useRef(null);

  // Handle file selection
  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (images.length + files.length > MAX_IMAGES) {
      alert(`Du kan max ha ${MAX_IMAGES} bilder per produkt`);
      return;
    }

    setIsUploading(true);
    
    // In real implementation, upload to server/CDN
    // For now, create local URLs
    const newImages = files.map((file, idx) => ({
      id: `img_${Date.now()}_${idx}`,
      url: URL.createObjectURL(file),
      file: file, // Keep file reference for upload
      position: images.length + idx + 1,
      alt: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
      isNew: true
    }));

    setImages(prev => [...prev, ...newImages]);
    setIsUploading(false);
  };

  // Add image from URL
  const handleAddUrl = () => {
    if (!urlInput.trim()) return;
    if (images.length >= MAX_IMAGES) {
      alert(`Du kan max ha ${MAX_IMAGES} bilder per produkt`);
      return;
    }

    const newImage = {
      id: `img_${Date.now()}`,
      url: urlInput.trim(),
      position: images.length + 1,
      alt: '',
      isNew: true
    };

    setImages(prev => [...prev, newImage]);
    setUrlInput('');
  };

  // Add multiple URLs
  const handleAddBulkUrls = () => {
    const urls = bulkUrls.split('\n').filter(u => u.trim());
    const available = MAX_IMAGES - images.length;
    
    if (urls.length > available) {
      alert(`Kan bara lägga till ${available} fler bilder (max ${MAX_IMAGES})`);
    }

    const newImages = urls.slice(0, available).map((url, idx) => ({
      id: `img_${Date.now()}_${idx}`,
      url: url.trim(),
      position: images.length + idx + 1,
      alt: '',
      isNew: true
    }));

    setImages(prev => [...prev, ...newImages]);
    setBulkUrls('');
  };

  // Remove image
  const handleRemove = (imageId) => {
    setImages(prev => {
      const updated = prev.filter(img => img.id !== imageId);
      // Reorder positions
      return updated.map((img, idx) => ({ ...img, position: idx + 1 }));
    });
  };

  // Update alt text
  const handleAltChange = (imageId, alt) => {
    setImages(prev => prev.map(img => 
      img.id === imageId ? { ...img, alt } : img
    ));
  };

  // Drag & drop reordering
  const handleDragStart = (e, index) => {
    e.dataTransfer.setData('text/plain', index);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
    
    if (dragIndex === dropIndex) return;

    setImages(prev => {
      const newImages = [...prev];
      const [removed] = newImages.splice(dragIndex, 1);
      newImages.splice(dropIndex, 0, removed);
      return newImages.map((img, idx) => ({ ...img, position: idx + 1 }));
    });
    
    setDragOverIndex(null);
  };

  // Save changes
  const handleSave = () => {
    onImagesChange(images);
    onClose();
  };

  // Generate alt text with AI (placeholder)
  const handleGenerateAlt = async (imageId) => {
    // In real implementation, call Claude Vision API
    const image = images.find(img => img.id === imageId);
    const generatedAlt = `${product?.vendor || ''} ${product?.title || ''} produktbild`.trim();
    handleAltChange(imageId, generatedAlt);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="image-manager-modal" onClick={e => e.stopPropagation()}>
        <div className="image-manager-header">
          <div className="image-manager-title">
            <Image size={24} />
            <div>
              <h2>Hantera bilder</h2>
              <span className="image-count">{images.length} av {MAX_IMAGES} bilder</span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="image-manager-tabs">
          <button 
            className={`tab-btn ${activeTab === 'upload' ? 'active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            <Upload size={16} />
            Ladda upp
          </button>
          <button 
            className={`tab-btn ${activeTab === 'url' ? 'active' : ''}`}
            onClick={() => setActiveTab('url')}
          >
            <Link2 size={16} />
            URL
          </button>
          <button 
            className={`tab-btn ${activeTab === 'bulk' ? 'active' : ''}`}
            onClick={() => setActiveTab('bulk')}
          >
            <FolderOpen size={16} />
            Bulk-import
          </button>
          <button 
            className={`tab-btn ${activeTab === 'mediabank' ? 'active' : ''}`}
            onClick={() => setActiveTab('mediabank')}
          >
            <ExternalLink size={16} />
            Mediabank
          </button>
        </div>

        <div className="image-manager-body">
          {/* Current Images */}
          <div className="current-images-section">
            <h3>Produktbilder</h3>
            <p className="section-description">
              Dra för att ändra ordning. Första bilden blir huvudbild.
            </p>
            
            <div className="images-grid">
              {images.map((image, index) => (
                <div
                  key={image.id}
                  className={`image-item ${dragOverIndex === index ? 'drag-over' : ''} ${index === 0 ? 'main-image' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragLeave={() => setDragOverIndex(null)}
                >
                  <div className="image-preview">
                    <img src={image.url} alt={image.alt || ''} />
                    <div className="image-overlay">
                      <button 
                        className="overlay-btn"
                        onClick={() => setPreviewImage(image)}
                      >
                        <ZoomIn size={16} />
                      </button>
                      <button 
                        className="overlay-btn danger"
                        onClick={() => handleRemove(image.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="image-position">{index + 1}</div>
                    {index === 0 && <div className="main-badge">Huvudbild</div>}
                  </div>
                  
                  <div className="image-meta">
                    <div className="image-drag-handle">
                      <GripVertical size={14} />
                    </div>
                    {editingAlt === image.id ? (
                      <input
                        type="text"
                        className="alt-input"
                        value={image.alt || ''}
                        onChange={(e) => handleAltChange(image.id, e.target.value)}
                        onBlur={() => setEditingAlt(null)}
                        onKeyDown={(e) => e.key === 'Enter' && setEditingAlt(null)}
                        placeholder="Alt-text..."
                        autoFocus
                      />
                    ) : (
                      <div 
                        className="alt-display"
                        onClick={() => setEditingAlt(image.id)}
                      >
                        {image.alt || <span className="placeholder">Lägg till alt-text...</span>}
                      </div>
                    )}
                    <button 
                      className="ai-alt-btn"
                      onClick={() => handleGenerateAlt(image.id)}
                      title="Generera alt-text med AI"
                    >
                      <Sparkles size={12} />
                    </button>
                  </div>
                </div>
              ))}

              {images.length < MAX_IMAGES && (
                <div 
                  className="image-item add-image"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus size={32} />
                  <span>Lägg till bild</span>
                </div>
              )}
            </div>
          </div>

          {/* Tab Content */}
          <div className="add-images-section">
            {activeTab === 'upload' && (
              <div className="upload-section">
                <div 
                  className="upload-zone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const files = Array.from(e.dataTransfer.files);
                    handleFileSelect({ target: { files } });
                  }}
                >
                  <FileImage size={48} />
                  <div className="upload-text">
                    <strong>Dra bilder hit eller klicka för att välja</strong>
                    <span>JPG, PNG, WEBP (max 5MB per bild)</span>
                  </div>
                  {isUploading && (
                    <div className="uploading-indicator">
                      <Loader2 size={20} className="spin" />
                      <span>Laddar upp...</span>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
              </div>
            )}

            {activeTab === 'url' && (
              <div className="url-section">
                <div className="form-group">
                  <label className="form-label">Bild-URL</label>
                  <div className="url-input-group">
                    <input
                      type="url"
                      className="form-input"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://example.com/image.jpg"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddUrl()}
                    />
                    <button 
                      className="btn btn-primary"
                      onClick={handleAddUrl}
                      disabled={!urlInput.trim()}
                    >
                      <Plus size={16} />
                      Lägg till
                    </button>
                  </div>
                </div>
                
                <div className="url-tips">
                  <h4>Tips</h4>
                  <ul>
                    <li>Använd direktlänkar till bilder (slutar på .jpg, .png, etc)</li>
                    <li>Bilderna måste vara publikt tillgängliga</li>
                    <li>Rekommenderad storlek: 1200x1200px</li>
                  </ul>
                </div>
              </div>
            )}

            {activeTab === 'bulk' && (
              <div className="bulk-section">
                <div className="bulk-method">
                  <h4>
                    <Link2 size={16} />
                    Importera via URL-lista
                  </h4>
                  <div className="form-group">
                    <label className="form-label">Klistra in URLs (en per rad)</label>
                    <textarea
                      className="form-textarea"
                      rows={6}
                      value={bulkUrls}
                      onChange={(e) => setBulkUrls(e.target.value)}
                      placeholder="https://dam.taylormade.com/product1-front.jpg&#10;https://dam.taylormade.com/product1-side.jpg&#10;https://dam.taylormade.com/product1-back.jpg"
                    />
                  </div>
                  <button 
                    className="btn btn-primary"
                    onClick={handleAddBulkUrls}
                    disabled={!bulkUrls.trim()}
                  >
                    <Plus size={16} />
                    Lägg till {bulkUrls.split('\n').filter(u => u.trim()).length} bilder
                  </button>
                </div>

                <div className="bulk-method">
                  <h4>
                    <FolderOpen size={16} />
                    SKU-baserad mappning
                  </h4>
                  <p className="method-description">
                    Ladda upp bilder med filnamn som matchar SKU:
                  </p>
                  <div className="sku-pattern-example">
                    <code>{product?.variants?.[0]?.sku || 'SKU'}-1.jpg</code> → Bild 1<br/>
                    <code>{product?.variants?.[0]?.sku || 'SKU'}-2.jpg</code> → Bild 2<br/>
                    <code>{product?.variants?.[0]?.sku || 'SKU'}-3.jpg</code> → Bild 3
                  </div>
                  <button 
                    className="btn btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={16} />
                    Välj bildmapp
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'mediabank' && (
              <div className="mediabank-section">
                <div className="mediabank-search">
                  <div className="form-group">
                    <label className="form-label">Sök i leverantörens mediabank</label>
                    <div className="search-input-group">
                      <Search size={16} />
                      <input
                        type="text"
                        className="form-input"
                        placeholder={`Sök "${product?.title || 'produktnamn'}"...`}
                      />
                      <select className="form-select">
                        <option value="">Alla leverantörer</option>
                      </select>
                      <button className="btn btn-primary">
                        <Search size={16} />
                      </button>
                    </div>
                  </div>
                </div>
                
                <div className="mediabank-placeholder">
                  <ExternalLink size={48} />
                  <h4>Mediabank-integration kommer snart</h4>
                  <p>
                    Anslut till leverantörernas DAM-system för att söka och importera
                    produktbilder direkt.
                  </p>
                  <div className="mediabank-list">
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Lägg till leverantörer under Leverantörer för att koppla deras mediabänkar här.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="image-manager-footer">
          <div className="footer-info">
            <span>{images.filter(i => i.isNew).length} nya bilder</span>
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              Avbryt
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <CheckCircle2 size={16} />
              Spara bilder
            </button>
          </div>
        </div>

        {/* Image Preview Modal */}
        {previewImage && (
          <div className="image-preview-modal" onClick={() => setPreviewImage(null)}>
            <img src={previewImage.url} alt={previewImage.alt || ''} />
            <button className="close-preview" onClick={() => setPreviewImage(null)}>
              <X size={24} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Bulk Image Manager for multiple products
export function BulkImageManager({ products, onUpdate, onClose }) {
  const [mappingMode, setMappingMode] = useState('sku'); // sku, ean, folder
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [mappingResults, setMappingResults] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);

  const handleFilesUpload = async (e) => {
    const files = Array.from(e.target.files);
    setUploadedFiles(files);
    
    // Auto-map files to products
    setIsProcessing(true);
    
    const results = [];
    
    files.forEach(file => {
      const fileName = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
      
      let matchedProduct = null;
      let position = 1;
      
      if (mappingMode === 'sku') {
        // Pattern: SKU-1.jpg, SKU-2.jpg
        const match = fileName.match(/^(.+?)[-_]?(\d)?$/);
        if (match) {
          const sku = match[1];
          position = match[2] ? parseInt(match[2]) : 1;
          matchedProduct = products.find(p => 
            p.variants?.some(v => v.sku.toLowerCase() === sku.toLowerCase()) ||
            p.sku?.toLowerCase() === sku.toLowerCase()
          );
        }
      } else if (mappingMode === 'ean') {
        // Pattern: EAN.jpg or EAN-1.jpg
        const match = fileName.match(/^(\d{8,13})[-_]?(\d)?$/);
        if (match) {
          const ean = match[1];
          position = match[2] ? parseInt(match[2]) : 1;
          matchedProduct = products.find(p =>
            p.variants?.some(v => v.barcode === ean) ||
            p.barcode === ean
          );
        }
      }
      
      results.push({
        file,
        fileName: file.name,
        matchedProduct,
        position,
        url: URL.createObjectURL(file)
      });
    });
    
    setMappingResults(results);
    setIsProcessing(false);
  };

  const handleApply = () => {
    const updates = {};
    
    mappingResults.filter(r => r.matchedProduct).forEach(result => {
      const productId = result.matchedProduct.id;
      if (!updates[productId]) {
        updates[productId] = {
          product: result.matchedProduct,
          newImages: []
        };
      }
      updates[productId].newImages.push({
        id: `img_${Date.now()}_${Math.random()}`,
        url: result.url,
        position: result.position,
        alt: '',
        isNew: true
      });
    });
    
    onUpdate(updates);
    onClose();
  };

  const matchedCount = mappingResults.filter(r => r.matchedProduct).length;
  const unmatchedCount = mappingResults.filter(r => !r.matchedProduct).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="bulk-image-modal" onClick={e => e.stopPropagation()}>
        <div className="bulk-image-header">
          <h2>Bulk-import av bilder</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="bulk-image-body">
          <div className="mapping-mode-section">
            <h3>Mappningsläge</h3>
            <div className="mapping-modes">
              <label className={`mapping-mode ${mappingMode === 'sku' ? 'active' : ''}`}>
                <input 
                  type="radio" 
                  name="mode" 
                  value="sku" 
                  checked={mappingMode === 'sku'}
                  onChange={(e) => setMappingMode(e.target.value)}
                />
                <div className="mode-info">
                  <strong>SKU-baserad</strong>
                  <code>TM-QI4D-DRV-1.jpg</code>
                </div>
              </label>
              <label className={`mapping-mode ${mappingMode === 'ean' ? 'active' : ''}`}>
                <input 
                  type="radio" 
                  name="mode" 
                  value="ean"
                  checked={mappingMode === 'ean'}
                  onChange={(e) => setMappingMode(e.target.value)}
                />
                <div className="mode-info">
                  <strong>EAN-baserad</strong>
                  <code>0196523145892-1.jpg</code>
                </div>
              </label>
            </div>
          </div>

          <div 
            className="bulk-upload-zone"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={48} />
            <div>
              <strong>Välj bildmapp eller dra hit filer</strong>
              <span>JPG, PNG, WEBP - Max 100 bilder åt gången</span>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            webkitdirectory=""
            style={{ display: 'none' }}
            onChange={handleFilesUpload}
          />

          {mappingResults.length > 0 && (
            <div className="mapping-results">
              <div className="results-summary">
                <div className="summary-stat success">
                  <CheckCircle2 size={16} />
                  <span>{matchedCount} matchade</span>
                </div>
                <div className="summary-stat warning">
                  <AlertCircle size={16} />
                  <span>{unmatchedCount} utan matchning</span>
                </div>
              </div>

              <div className="results-list">
                {mappingResults.slice(0, 20).map((result, idx) => (
                  <div key={idx} className={`result-item ${result.matchedProduct ? 'matched' : 'unmatched'}`}>
                    <img src={result.url} alt="" className="result-thumb" />
                    <div className="result-file">{result.fileName}</div>
                    {result.matchedProduct ? (
                      <div className="result-product">
                        <CheckCircle2 size={14} />
                        {result.matchedProduct.title}
                      </div>
                    ) : (
                      <div className="result-no-match">
                        <AlertCircle size={14} />
                        Ingen matchning
                      </div>
                    )}
                  </div>
                ))}
                {mappingResults.length > 20 && (
                  <div className="results-more">
                    ...och {mappingResults.length - 20} till
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="bulk-image-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Avbryt
          </button>
          <button 
            className="btn btn-primary"
            onClick={handleApply}
            disabled={matchedCount === 0}
          >
            <CheckCircle2 size={16} />
            Applicera {matchedCount} bilder
          </button>
        </div>
      </div>
    </div>
  );
}
