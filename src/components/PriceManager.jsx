import React, { useState, useMemo } from 'react';
import { 
  DollarSign, Percent, Tag, Package, Filter, Play, RotateCcw,
  CheckCircle2, AlertCircle, History, Trash2, Calendar, Clock,
  ChevronDown, ChevronUp, Search, X, Save, RefreshCw, Eye
} from 'lucide-react';
import './PriceManager.css';

export default function PriceManager({ products, onUpdateProducts }) {
  // Filter state
  const [filters, setFilters] = useState({
    vendors: [],
    tags: [],
    types: [],
    searchQuery: ''
  });
  
  // Discount state
  const [discountPercent, setDiscountPercent] = useState(20);
  const [roundTo, setRoundTo] = useState(0); // 0 = no rounding, 9 = round to X9, 5 = round to X5
  
  // Campaign history (stored in localStorage in real app)
  const [campaigns, setCampaigns] = useState(() => {
    const saved = localStorage.getItem('pim_price_campaigns');
    return saved ? JSON.parse(saved) : [];
  });
  
  // UI state
  const [showFilters, setShowFilters] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [previewMode, setPreviewMode] = useState(false);

  // Get unique values for filters
  const filterOptions = useMemo(() => ({
    vendors: [...new Set(products.map(p => p.vendor || p.brand).filter(Boolean))].sort(),
    tags: [...new Set(products.flatMap(p => p.tags || []))].sort(),
    types: [...new Set(products.map(p => p.type).filter(Boolean))].sort()
  }), [products]);

  // Filter products
  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const vendor = p.vendor || p.brand || '';
      const productTags = p.tags || [];
      
      // Search query
      if (filters.searchQuery) {
        const query = filters.searchQuery.toLowerCase();
        const matchesSearch = 
          p.title.toLowerCase().includes(query) ||
          vendor.toLowerCase().includes(query) ||
          (p.variants?.[0]?.sku || '').toLowerCase().includes(query);
        if (!matchesSearch) return false;
      }
      
      // Vendor filter
      if (filters.vendors.length > 0 && !filters.vendors.includes(vendor)) {
        return false;
      }
      
      // Tag filter (product must have at least one of the selected tags)
      if (filters.tags.length > 0 && !filters.tags.some(t => productTags.includes(t))) {
        return false;
      }
      
      // Type filter
      if (filters.types.length > 0 && !filters.types.includes(p.type)) {
        return false;
      }
      
      return true;
    });
  }, [products, filters]);

  // Products with active discounts
  const discountedProducts = useMemo(() => {
    return products.filter(p => p.compareAtPrice && p.compareAtPrice > p.price);
  }, [products]);

  // Calculate new price with discount
  const calculateDiscountedPrice = (originalPrice, percent) => {
    const discounted = originalPrice * (1 - percent / 100);
    
    if (roundTo === 9) {
      return Math.floor(discounted / 10) * 10 + 9;
    } else if (roundTo === 5) {
      return Math.round(discounted / 5) * 5;
    } else if (roundTo === 10) {
      return Math.round(discounted / 10) * 10;
    }
    
    return Math.round(discounted);
  };

  // Toggle filter value
  const toggleFilter = (type, value) => {
    setFilters(prev => ({
      ...prev,
      [type]: prev[type].includes(value)
        ? prev[type].filter(v => v !== value)
        : [...prev[type], value]
    }));
  };

  // Clear all filters
  const clearFilters = () => {
    setFilters({ vendors: [], tags: [], types: [], searchQuery: '' });
  };

  // Toggle product selection
  const toggleProductSelection = (productId) => {
    setSelectedProducts(prev => 
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  // Select all filtered products
  const selectAllFiltered = () => {
    const allFilteredIds = filteredProducts.map(p => p.id);
    const allSelected = allFilteredIds.every(id => selectedProducts.includes(id));
    
    if (allSelected) {
      setSelectedProducts(prev => prev.filter(id => !allFilteredIds.includes(id)));
    } else {
      setSelectedProducts(prev => [...new Set([...prev, ...allFilteredIds])]);
    }
  };

  // Apply discount to selected products
  const applyDiscount = () => {
    const productsToUpdate = selectedProducts.length > 0
      ? products.filter(p => selectedProducts.includes(p.id))
      : filteredProducts;
    
    if (productsToUpdate.length === 0) {
      alert('Inga produkter valda');
      return;
    }

    // Create campaign record
    const campaign = {
      id: `campaign_${Date.now()}`,
      createdAt: new Date().toISOString(),
      discountPercent,
      productCount: productsToUpdate.length,
      filters: { ...filters },
      products: productsToUpdate.map(p => ({
        id: p.id,
        title: p.title,
        originalPrice: p.price,
        originalCompareAt: p.compareAtPrice,
        newPrice: calculateDiscountedPrice(p.price, discountPercent),
        // Store variant prices too
        variants: p.variants?.map(v => ({
          id: v.id,
          originalPrice: v.price,
          originalCompareAt: v.compareAtPrice
        }))
      }))
    };

    // Update products
    const updates = {};
    productsToUpdate.forEach(product => {
      const newPrice = calculateDiscountedPrice(product.price, discountPercent);
      
      updates[product.id] = {
        ...product,
        compareAtPrice: product.price, // Original price becomes compare-at
        price: newPrice,
        // Update variants too
        variants: product.variants?.map(v => ({
          ...v,
          compareAtPrice: v.price,
          price: calculateDiscountedPrice(v.price, discountPercent)
        }))
      };
    });

    // Save campaign to history
    const newCampaigns = [campaign, ...campaigns];
    setCampaigns(newCampaigns);
    localStorage.setItem('pim_price_campaigns', JSON.stringify(newCampaigns));

    // Apply updates
    onUpdateProducts(updates);
    
    // Clear selection
    setSelectedProducts([]);
    
    alert(`✅ Priserna sänkta med ${discountPercent}% på ${productsToUpdate.length} produkter!`);
  };

  // Reset prices from a campaign
  const resetCampaign = (campaign) => {
    if (!confirm(`Vill du återställa priserna för ${campaign.productCount} produkter?`)) {
      return;
    }

    const updates = {};
    
    campaign.products.forEach(savedProduct => {
      const currentProduct = products.find(p => p.id === savedProduct.id);
      if (!currentProduct) return;

      updates[savedProduct.id] = {
        ...currentProduct,
        price: savedProduct.originalPrice,
        compareAtPrice: savedProduct.originalCompareAt || null, // null, not 0
        variants: currentProduct.variants?.map((v, idx) => {
          const savedVariant = savedProduct.variants?.[idx];
          return {
            ...v,
            price: savedVariant?.originalPrice || v.price,
            compareAtPrice: savedVariant?.originalCompareAt || null
          };
        })
      };
    });

    // Remove campaign from history
    const newCampaigns = campaigns.filter(c => c.id !== campaign.id);
    setCampaigns(newCampaigns);
    localStorage.setItem('pim_price_campaigns', JSON.stringify(newCampaigns));

    // Apply updates
    onUpdateProducts(updates);
    
    alert(`✅ Priserna återställda för ${campaign.productCount} produkter!`);
  };

  // Delete campaign without resetting (if already manually fixed)
  const deleteCampaign = (campaignId) => {
    if (!confirm('Ta bort kampanjen från historiken? (Priserna ändras inte)')) {
      return;
    }
    
    const newCampaigns = campaigns.filter(c => c.id !== campaignId);
    setCampaigns(newCampaigns);
    localStorage.setItem('pim_price_campaigns', JSON.stringify(newCampaigns));
  };

  // Reset ALL discounted products (emergency reset)
  const resetAllDiscounts = () => {
    if (!confirm(`⚠️ Detta återställer ALLA ${discountedProducts.length} produkter med rea-pris. Fortsätt?`)) {
      return;
    }

    const updates = {};
    
    discountedProducts.forEach(product => {
      updates[product.id] = {
        ...product,
        price: product.compareAtPrice,
        compareAtPrice: null,
        variants: product.variants?.map(v => ({
          ...v,
          price: v.compareAtPrice || v.price,
          compareAtPrice: null
        }))
      };
    });

    onUpdateProducts(updates);
    
    // Clear all campaigns
    setCampaigns([]);
    localStorage.setItem('pim_price_campaigns', JSON.stringify([]));
    
    alert(`✅ Alla ${discountedProducts.length} produkter återställda!`);
  };

  const activeFiltersCount = filters.vendors.length + filters.tags.length + filters.types.length;

  return (
    <div className="price-manager">
      {/* Header */}
      <div className="price-manager-header">
        <div>
          <h1 className="content-title">Prishantering</h1>
          <p className="content-subtitle">
            Bulk-ändra priser för rea-perioder • {discountedProducts.length} produkter har rea-pris
          </p>
        </div>
        <div className="header-actions">
          <button 
            className="btn btn-secondary"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History size={18} />
            Kampanjhistorik ({campaigns.length})
          </button>
          {discountedProducts.length > 0 && (
            <button 
              className="btn btn-warning"
              onClick={resetAllDiscounts}
            >
              <RotateCcw size={18} />
              Återställ alla rea-priser
            </button>
          )}
        </div>
      </div>

      {/* Campaign History Panel */}
      {showHistory && (
        <div className="campaign-history-panel">
          <div className="panel-header">
            <h3><History size={18} /> Kampanjhistorik</h3>
            <button className="btn-icon" onClick={() => setShowHistory(false)}>
              <X size={20} />
            </button>
          </div>
          
          {campaigns.length === 0 ? (
            <div className="empty-history">
              <Clock size={32} />
              <p>Ingen kampanjhistorik ännu</p>
            </div>
          ) : (
            <div className="campaign-list">
              {campaigns.map(campaign => (
                <div key={campaign.id} className="campaign-item">
                  <div className="campaign-info">
                    <div className="campaign-date">
                      <Calendar size={14} />
                      {new Date(campaign.createdAt).toLocaleString('sv-SE')}
                    </div>
                    <div className="campaign-details">
                      <span className="campaign-discount">-{campaign.discountPercent}%</span>
                      <span className="campaign-count">{campaign.productCount} produkter</span>
                    </div>
                  </div>
                  <div className="campaign-actions">
                    <button 
                      className="btn btn-sm btn-primary"
                      onClick={() => resetCampaign(campaign)}
                    >
                      <RotateCcw size={14} />
                      Återställ
                    </button>
                    <button 
                      className="btn btn-sm btn-ghost"
                      onClick={() => deleteCampaign(campaign.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="price-manager-content">
        {/* Left: Filters */}
        <div className="price-filters-panel">
          <div className="panel-header" onClick={() => setShowFilters(!showFilters)}>
            <h3>
              <Filter size={18} />
              Filter
              {activeFiltersCount > 0 && (
                <span className="filter-count">{activeFiltersCount}</span>
              )}
            </h3>
            {showFilters ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </div>

          {showFilters && (
            <div className="filters-content">
              {/* Search */}
              <div className="filter-section">
                <div className="filter-search">
                  <Search size={16} />
                  <input
                    type="text"
                    placeholder="Sök produkt, SKU..."
                    value={filters.searchQuery}
                    onChange={e => setFilters(prev => ({ ...prev, searchQuery: e.target.value }))}
                  />
                  {filters.searchQuery && (
                    <button onClick={() => setFilters(prev => ({ ...prev, searchQuery: '' }))}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Vendors */}
              <div className="filter-section">
                <h4><Package size={14} /> Varumärke</h4>
                <div className="filter-chips">
                  {filterOptions.vendors.map(vendor => (
                    <button
                      key={vendor}
                      className={`filter-chip ${filters.vendors.includes(vendor) ? 'active' : ''}`}
                      onClick={() => toggleFilter('vendors', vendor)}
                    >
                      {vendor}
                      <span className="chip-count">
                        {products.filter(p => (p.vendor || p.brand) === vendor).length}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div className="filter-section">
                <h4><Tag size={14} /> Taggar</h4>
                <div className="filter-chips">
                  {filterOptions.tags.slice(0, 15).map(tag => (
                    <button
                      key={tag}
                      className={`filter-chip ${filters.tags.includes(tag) ? 'active' : ''}`}
                      onClick={() => toggleFilter('tags', tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              {/* Types */}
              <div className="filter-section">
                <h4><Package size={14} /> Produkttyp</h4>
                <div className="filter-chips">
                  {filterOptions.types.map(type => (
                    <button
                      key={type}
                      className={`filter-chip ${filters.types.includes(type) ? 'active' : ''}`}
                      onClick={() => toggleFilter('types', type)}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {activeFiltersCount > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  <X size={14} /> Rensa filter
                </button>
              )}
            </div>
          )}

          {/* Discount Controls */}
          <div className="discount-controls">
            <h3><Percent size={18} /> Rabatt</h3>
            
            <div className="discount-input-group">
              <label>Procent</label>
              <div className="discount-input-wrapper">
                <input
                  type="number"
                  min="1"
                  max="90"
                  value={discountPercent}
                  onChange={e => setDiscountPercent(Number(e.target.value))}
                />
                <span>%</span>
              </div>
            </div>

            <div className="discount-presets">
              {[10, 15, 20, 25, 30, 40, 50].map(p => (
                <button
                  key={p}
                  className={`preset-btn ${discountPercent === p ? 'active' : ''}`}
                  onClick={() => setDiscountPercent(p)}
                >
                  {p}%
                </button>
              ))}
            </div>

            <div className="discount-input-group">
              <label>Avrundning</label>
              <select
                value={roundTo}
                onChange={e => setRoundTo(Number(e.target.value))}
              >
                <option value={0}>Närmaste krona</option>
                <option value={9}>Sluta på 9 (ex: 1299)</option>
                <option value={5}>Närmaste 5-tal</option>
                <option value={10}>Närmaste 10-tal</option>
              </select>
            </div>

            <div className="discount-summary">
              <div className="summary-row">
                <span>Valda produkter:</span>
                <strong>{selectedProducts.length || filteredProducts.length}</strong>
              </div>
              <div className="summary-row">
                <span>Exempel: 1000 kr →</span>
                <strong>{calculateDiscountedPrice(1000, discountPercent)} kr</strong>
              </div>
            </div>

            <button 
              className="btn btn-primary btn-large"
              onClick={applyDiscount}
              disabled={filteredProducts.length === 0}
            >
              <Play size={18} />
              Aktivera -{discountPercent}% på {selectedProducts.length || filteredProducts.length} produkter
            </button>
          </div>
        </div>

        {/* Right: Product List */}
        <div className="price-products-panel">
          <div className="panel-header">
            <h3>
              Produkter
              <span className="product-count">{filteredProducts.length} av {products.length}</span>
            </h3>
            <div className="panel-actions">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={filteredProducts.length > 0 && filteredProducts.every(p => selectedProducts.includes(p.id))}
                  onChange={selectAllFiltered}
                />
                <span>Välj alla</span>
              </label>
              <button 
                className={`btn btn-sm ${previewMode ? 'btn-accent' : 'btn-ghost'}`}
                onClick={() => setPreviewMode(!previewMode)}
              >
                <Eye size={14} />
                {previewMode ? 'Visa nuvarande' : 'Förhandsgranska'}
              </button>
            </div>
          </div>

          <div className="price-product-list">
            {filteredProducts.length === 0 ? (
              <div className="empty-products">
                <Package size={48} />
                <h4>Inga produkter matchar filtren</h4>
                <p>Ändra filter för att se produkter</p>
              </div>
            ) : (
              filteredProducts.map(product => {
                const isSelected = selectedProducts.includes(product.id);
                const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
                const previewPrice = calculateDiscountedPrice(product.price, discountPercent);
                
                return (
                  <div 
                    key={product.id} 
                    className={`price-product-row ${isSelected ? 'selected' : ''} ${hasDiscount ? 'has-discount' : ''}`}
                    onClick={() => toggleProductSelection(product.id)}
                  >
                    <div className={`row-checkbox ${isSelected ? 'checked' : ''}`}>
                      {isSelected && <CheckCircle2 size={14} />}
                    </div>
                    
                    <div className="product-image-small">
                      {product.images?.[0] ? (
                        <img src={product.images[0].url} alt="" />
                      ) : (
                        <Package size={20} />
                      )}
                    </div>
                    
                    <div className="product-info">
                      <div className="product-title">{product.title}</div>
                      <div className="product-meta">
                        <span>{product.vendor || product.brand}</span>
                        <span>{product.variants?.[0]?.sku}</span>
                      </div>
                    </div>
                    
                    <div className="product-prices">
                      {previewMode ? (
                        // Preview mode - show what prices will be
                        <>
                          <span className="price-compare">{product.price} kr</span>
                          <span className="price-new">{previewPrice} kr</span>
                          <span className="price-savings">-{discountPercent}%</span>
                        </>
                      ) : (
                        // Current mode - show actual prices
                        <>
                          {hasDiscount && (
                            <span className="price-compare">{product.compareAtPrice} kr</span>
                          )}
                          <span className={`price-current ${hasDiscount ? 'discounted' : ''}`}>
                            {product.price} kr
                          </span>
                          {hasDiscount && (
                            <span className="price-savings">
                              -{Math.round((1 - product.price / product.compareAtPrice) * 100)}%
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
