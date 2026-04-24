import React, { useState } from 'react';
import { 
  Download, X, CheckCircle2, AlertCircle, FileSpreadsheet,
  Store, Filter, Settings, FileDown, Loader2
} from 'lucide-react';
import { exportToShopifyCSV, shopifyExportHeaders } from '../data/demoData';

export default function ShopifyExport({ products, stores, onClose }) {
  const [selectedProducts, setSelectedProducts] = useState(products.map(p => p.id));
  const [selectedStore, setSelectedStore] = useState(stores.find(s => s.status === 'connected')?.id || '');
  const [includeImages, setIncludeImages] = useState(true);
  const [includeSEO, setIncludeSEO] = useState(true);
  const [includeGoogleShopping, setIncludeGoogleShopping] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportComplete, setExportComplete] = useState(false);

  const productsToExport = products.filter(p => selectedProducts.includes(p.id));

  const stats = {
    products: productsToExport.length,
    variants: productsToExport.reduce((acc, p) => acc + (p.variants?.length || 0), 0),
    images: productsToExport.reduce((acc, p) => acc + (p.images?.length || 0), 0),
    missingDescription: productsToExport.filter(p => !p.description || p.description.length < 50).length,
    missingSEO: productsToExport.filter(p => !p.seoTitle).length,
  };

  const handleExport = async () => {
    setIsExporting(true);

    try {
      // Generate CSV data
      const csvData = exportToShopifyCSV(productsToExport);

      // Filter columns based on options
      let headers = [...shopifyExportHeaders];
      if (!includeGoogleShopping) {
        headers = headers.filter(h => !h.startsWith('Google Shopping'));
      }

      // Create CSV string
      const csvString = [
        headers.join(','),
        ...csvData.map(row => 
          headers.map(header => {
            const value = row[header] || '';
            // Escape quotes and wrap in quotes if contains comma or newline
            if (typeof value === 'string' && (value.includes(',') || value.includes('\n') || value.includes('"'))) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          }).join(',')
        )
      ].join('\n');

      // Create and download file
      const blob = new Blob(['\ufeff' + csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `shopify-export-${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setExportComplete(true);
    } catch (error) {
      console.error('Export error:', error);
      alert('Kunde inte exportera. Försök igen.');
    } finally {
      setIsExporting(false);
    }
  };

  const toggleProduct = (productId) => {
    setSelectedProducts(prev =>
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const selectAll = () => {
    setSelectedProducts(
      selectedProducts.length === products.length 
        ? [] 
        : products.map(p => p.id)
    );
  };

  if (exportComplete) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="export-modal" onClick={e => e.stopPropagation()}>
          <div className="export-complete">
            <CheckCircle2 size={64} />
            <h2>Export klar!</h2>
            <p>
              <strong>{stats.products} produkter</strong> med <strong>{stats.variants} varianter</strong> exporterades.
            </p>
            <div className="export-complete-actions">
              <button className="btn btn-secondary" onClick={onClose}>
                Stäng
              </button>
              <button className="btn btn-primary" onClick={() => setExportComplete(false)}>
                Exportera fler
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="export-modal" onClick={e => e.stopPropagation()}>
        <div className="export-header">
          <div className="export-title">
            <FileSpreadsheet size={24} />
            <h2>Exportera till Shopify CSV</h2>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="export-body">
          {/* Stats */}
          <div className="export-stats">
            <div className="export-stat">
              <div className="export-stat-value">{stats.products}</div>
              <div className="export-stat-label">Produkter</div>
            </div>
            <div className="export-stat">
              <div className="export-stat-value">{stats.variants}</div>
              <div className="export-stat-label">Varianter</div>
            </div>
            <div className="export-stat">
              <div className="export-stat-value">{stats.images}</div>
              <div className="export-stat-label">Bilder</div>
            </div>
          </div>

          {/* Warnings */}
          {(stats.missingDescription > 0 || stats.missingSEO > 0) && (
            <div className="export-warnings">
              {stats.missingDescription > 0 && (
                <div className="export-warning">
                  <AlertCircle size={16} />
                  <span>{stats.missingDescription} produkter saknar beskrivning</span>
                </div>
              )}
              {stats.missingSEO > 0 && (
                <div className="export-warning">
                  <AlertCircle size={16} />
                  <span>{stats.missingSEO} produkter saknar SEO-titel</span>
                </div>
              )}
            </div>
          )}

          {/* Options */}
          <div className="export-section">
            <h3>
              <Settings size={16} />
              Exportinställningar
            </h3>
            
            <div className="export-options">
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={includeImages}
                  onChange={(e) => setIncludeImages(e.target.checked)}
                />
                <span>Inkludera bilder (URLs)</span>
              </label>
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={includeSEO}
                  onChange={(e) => setIncludeSEO(e.target.checked)}
                />
                <span>Inkludera SEO-fält</span>
              </label>
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={includeGoogleShopping}
                  onChange={(e) => setIncludeGoogleShopping(e.target.checked)}
                />
                <span>Inkludera Google Shopping-fält</span>
              </label>
            </div>
          </div>

          {/* Product Selection */}
          <div className="export-section">
            <div className="export-section-header">
              <h3>
                <Filter size={16} />
                Välj produkter
              </h3>
              <button className="btn-sm" onClick={selectAll}>
                {selectedProducts.length === products.length ? 'Avmarkera alla' : 'Välj alla'}
              </button>
            </div>
            
            <div className="export-product-list">
              {products.map(product => (
                <label 
                  key={product.id} 
                  className={`export-product-item ${selectedProducts.includes(product.id) ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(product.id)}
                    onChange={() => toggleProduct(product.id)}
                  />
                  <div className="export-product-info">
                    <div className="export-product-title">{product.title}</div>
                    <div className="export-product-meta">
                      <span>{product.vendor}</span>
                      <span>{product.variants?.length || 0} varianter</span>
                      {!product.description && <span className="warning">Saknar beskrivning</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="export-footer">
          <div className="export-summary">
            Exporterar <strong>{selectedProducts.length} produkter</strong> med{' '}
            <strong>{productsToExport.reduce((acc, p) => acc + (p.variants?.length || 0), 0)} varianter</strong>
          </div>
          <div className="export-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              Avbryt
            </button>
            <button 
              className="btn btn-primary"
              onClick={handleExport}
              disabled={selectedProducts.length === 0 || isExporting}
            >
              {isExporting ? (
                <>
                  <Loader2 size={16} className="spin" />
                  Exporterar...
                </>
              ) : (
                <>
                  <FileDown size={16} />
                  Ladda ner CSV
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
