import React, { useState } from 'react';
import { 
  X, Sparkles, Loader2, CheckCircle2, AlertCircle, 
  FileText, Search, Play, Pause
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function BatchGenerate({ products, onComplete, onClose }) {
  const [step, setStep] = useState('config'); // config, progress, complete
  const [selectedProducts, setSelectedProducts] = useState(
    products.filter(p => !p.description || p.description.length < 50).map(p => p.id)
  );
  const [options, setOptions] = useState({
    style: 'sales',
    language: 'sv',
    length: 'medium',
    includeSEO: true,
    generateDescription: true,
    generateSeoTitle: true,
    generateMetaDescription: true
  });
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const productsToProcess = products.filter(p => selectedProducts.includes(p.id));

  const toggleProduct = (productId) => {
    setSelectedProducts(prev => 
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const selectAll = () => {
    if (selectedProducts.length === products.length) {
      setSelectedProducts([]);
    } else {
      setSelectedProducts(products.map(p => p.id));
    }
  };

  const selectMissing = (field) => {
    const missing = products.filter(p => {
      if (field === 'description') return !p.description || p.description.length < 50;
      if (field === 'seoTitle') return !p.seoTitle;
      if (field === 'metaDescription') return !p.metaDescription;
      return false;
    }).map(p => p.id);
    setSelectedProducts(missing);
  };

  const startBatchGeneration = async () => {
    setStep('progress');
    setIsRunning(true);
    setProgress({ current: 0, total: productsToProcess.length });
    setResults([]);

    try {
      const response = await fetch(`${API_URL}/claude/batch-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: productsToProcess,
          ...options
        })
      });

      if (!response.ok) throw new Error('Batch generation failed');

      const data = await response.json();
      
      setResults(data.results);
      setProgress({ current: productsToProcess.length, total: productsToProcess.length });
      setStep('complete');
      
    } catch (error) {
      console.error('Batch generate error:', error);
      alert('Kunde inte köra batch-generering. Kontrollera att backend körs.');
    } finally {
      setIsRunning(false);
    }
  };

  const handleApplyResults = () => {
    const successfulResults = results.filter(r => r.success);
    onComplete(successfulResults);
    onClose();
  };

  const stats = {
    total: products.length,
    missingDescription: products.filter(p => !p.description || p.description.length < 50).length,
    missingSeoTitle: products.filter(p => !p.seoTitle).length,
    missingMetaDescription: products.filter(p => !p.metaDescription).length,
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="batch-modal" onClick={e => e.stopPropagation()}>
        <div className="batch-modal-header">
          <div className="batch-modal-title">
            <Sparkles size={24} />
            <h2>Batch-generering av innehåll</h2>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        {/* Step: Config */}
        {step === 'config' && (
          <>
            <div className="batch-modal-body">
              {/* Stats Overview */}
              <div className="batch-stats">
                <div className="batch-stat">
                  <div className="batch-stat-value">{stats.total}</div>
                  <div className="batch-stat-label">Totalt produkter</div>
                </div>
                <div className="batch-stat warning">
                  <div className="batch-stat-value">{stats.missingDescription}</div>
                  <div className="batch-stat-label">Saknar beskrivning</div>
                </div>
                <div className="batch-stat warning">
                  <div className="batch-stat-value">{stats.missingSeoTitle}</div>
                  <div className="batch-stat-label">Saknar SEO-titel</div>
                </div>
                <div className="batch-stat warning">
                  <div className="batch-stat-value">{stats.missingMetaDescription}</div>
                  <div className="batch-stat-label">Saknar meta-beskrivning</div>
                </div>
              </div>

              {/* What to generate */}
              <div className="batch-section">
                <h3>Vad ska genereras?</h3>
                <div className="batch-checkboxes">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={options.generateDescription}
                      onChange={e => setOptions(prev => ({ ...prev, generateDescription: e.target.checked }))}
                    />
                    <FileText size={16} />
                    <span>Produktbeskrivning</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={options.generateSeoTitle}
                      onChange={e => setOptions(prev => ({ ...prev, generateSeoTitle: e.target.checked }))}
                    />
                    <Search size={16} />
                    <span>SEO-titel (max 60 tecken)</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={options.generateMetaDescription}
                      onChange={e => setOptions(prev => ({ ...prev, generateMetaDescription: e.target.checked }))}
                    />
                    <Search size={16} />
                    <span>Meta-beskrivning (max 155 tecken)</span>
                  </label>
                </div>
              </div>

              {/* Options */}
              <div className="batch-section">
                <h3>Inställningar</h3>
                <div className="batch-options-grid">
                  <div className="form-group">
                    <label className="form-label">Stil</label>
                    <select
                      className="form-input"
                      value={options.style}
                      onChange={e => setOptions(prev => ({ ...prev, style: e.target.value }))}
                    >
                      <option value="sales">Säljande</option>
                      <option value="technical">Teknisk</option>
                      <option value="neutral">Neutral</option>
                    </select>
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label">Längd</label>
                    <select
                      className="form-input"
                      value={options.length}
                      onChange={e => setOptions(prev => ({ ...prev, length: e.target.value }))}
                    >
                      <option value="short">Kort (50-100 ord)</option>
                      <option value="medium">Medium (100-200 ord)</option>
                      <option value="long">Lång (200-400 ord)</option>
                    </select>
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label">Språk</label>
                    <select
                      className="form-input"
                      value={options.language}
                      onChange={e => setOptions(prev => ({ ...prev, language: e.target.value }))}
                    >
                      <option value="sv">Svenska</option>
                      <option value="en">Engelska</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Product Selection */}
              <div className="batch-section">
                <div className="batch-section-header">
                  <h3>Välj produkter ({selectedProducts.length} valda)</h3>
                  <div className="batch-quick-select">
                    <button className="btn-sm" onClick={selectAll}>
                      {selectedProducts.length === products.length ? 'Avmarkera alla' : 'Välj alla'}
                    </button>
                    <button className="btn-sm" onClick={() => selectMissing('description')}>
                      Utan beskrivning ({stats.missingDescription})
                    </button>
                    <button className="btn-sm" onClick={() => selectMissing('seoTitle')}>
                      Utan SEO ({stats.missingSeoTitle})
                    </button>
                  </div>
                </div>
                
                <div className="batch-product-list">
                  {products.map(product => (
                    <div
                      key={product.id}
                      className={`batch-product-item ${selectedProducts.includes(product.id) ? 'selected' : ''}`}
                      onClick={() => toggleProduct(product.id)}
                    >
                      <div className={`batch-checkbox ${selectedProducts.includes(product.id) ? 'checked' : ''}`}>
                        {selectedProducts.includes(product.id) && <CheckCircle2 size={14} />}
                      </div>
                      <div className="batch-product-info">
                        <div className="batch-product-title">{product.title}</div>
                        <div className="batch-product-meta">
                          <span className="batch-product-brand">{product.brand}</span>
                          {!product.description && <span className="missing-badge">Saknar beskrivning</span>}
                          {!product.seoTitle && <span className="missing-badge">Saknar SEO-titel</span>}
                          {!product.metaDescription && <span className="missing-badge">Saknar meta</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="batch-modal-footer">
              <div className="batch-estimate">
                <span>Uppskattad tid: ~{Math.ceil(selectedProducts.length * 3 / 60)} min</span>
                <span className="batch-cost">~${(selectedProducts.length * 0.003).toFixed(2)} API-kostnad</span>
              </div>
              <div className="batch-footer-actions">
                <button className="btn btn-secondary" onClick={onClose}>
                  Avbryt
                </button>
                <button 
                  className="btn btn-primary"
                  onClick={startBatchGeneration}
                  disabled={selectedProducts.length === 0}
                >
                  <Sparkles size={16} />
                  Starta generering ({selectedProducts.length} produkter)
                </button>
              </div>
            </div>
          </>
        )}

        {/* Step: Progress */}
        {step === 'progress' && (
          <>
            <div className="batch-modal-body">
              <div className="batch-progress-section">
                <div className="batch-progress-icon">
                  <Loader2 size={48} className="spin" />
                </div>
                <h3>Genererar innehåll...</h3>
                <p>Bearbetar {progress.current} av {progress.total} produkter</p>
                
                <div className="batch-progress-bar">
                  <div 
                    className="batch-progress-fill"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
                
                <div className="batch-progress-stats">
                  <span>{Math.round((progress.current / progress.total) * 100)}% klart</span>
                </div>
              </div>
            </div>

            <div className="batch-modal-footer">
              <button className="btn btn-secondary" onClick={() => setIsPaused(!isPaused)}>
                {isPaused ? <Play size={16} /> : <Pause size={16} />}
                {isPaused ? 'Fortsätt' : 'Pausa'}
              </button>
              <button className="btn btn-danger" onClick={onClose}>
                Avbryt
              </button>
            </div>
          </>
        )}

        {/* Step: Complete */}
        {step === 'complete' && (
          <>
            <div className="batch-modal-body">
              <div className="batch-complete-section">
                <div className="batch-complete-icon">
                  <CheckCircle2 size={48} />
                </div>
                <h3>Generering klar!</h3>
                
                <div className="batch-results-summary">
                  <div className="batch-result-stat success">
                    <CheckCircle2 size={20} />
                    <span>{results.filter(r => r.success).length} lyckades</span>
                  </div>
                  {results.filter(r => !r.success).length > 0 && (
                    <div className="batch-result-stat error">
                      <AlertCircle size={20} />
                      <span>{results.filter(r => !r.success).length} misslyckades</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="batch-results-list">
                <h4>Resultat</h4>
                {results.map((result, idx) => {
                  const product = products.find(p => p.id === result.productId);
                  return (
                    <div key={idx} className={`batch-result-item ${result.success ? 'success' : 'error'}`}>
                      <div className="batch-result-icon">
                        {result.success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                      </div>
                      <div className="batch-result-info">
                        <div className="batch-result-title">{product?.title}</div>
                        {result.success ? (
                          <div className="batch-result-preview">
                            {result.description?.substring(0, 100)}...
                          </div>
                        ) : (
                          <div className="batch-result-error">{result.error}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="batch-modal-footer">
              <button className="btn btn-secondary" onClick={onClose}>
                Stäng
              </button>
              <button className="btn btn-primary" onClick={handleApplyResults}>
                <CheckCircle2 size={16} />
                Tillämpa {results.filter(r => r.success).length} resultat
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
