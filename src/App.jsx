import React, { useState, useEffect } from 'react';
import {
  Package, Store, Upload, Settings, Search, Plus, Check, X,
  ChevronRight, ChevronUp, ChevronDown, Image, MoreHorizontal, Sparkles, Server, DollarSign,
  FileSpreadsheet, Link2, ExternalLink, Filter, Download, Trash2,
  Zap, Database, RefreshCw, PanelRightOpen, PanelRightClose,
  Globe, Tag, Layers, Box, ShoppingBag, Shirt, CircleDot,
  CheckCircle2, AlertCircle, FileText, Wand2, Loader2, LogOut,
  Users, FolderInput, TrendingUp
} from 'lucide-react';
import Login from './components/Login';
import './components/Login.css';
import ProductDetail from './components/ProductDetail';
import BatchGenerate from './components/BatchGenerate';
import MappingConfig from './components/MappingConfig';
import ShopifyExport from './components/ShopifyExport';
import ImageSync from './components/ImageSync';
import PriceManager from './components/PriceManager';
import MarginEngine from './components/MarginEngine';
import InventorySync from './components/InventorySync';
import ProductImport from './components/ProductImport';
import ShopifyImport from './components/ShopifyImport';
import StoreManager from './components/StoreManager';
import CollectionsView from './components/CollectionsView';
import ImageImportView from './components/ImageImportView';
import './components/ShopifyImport.css';
import './components/PriceManager.css';
import './components/MarginEngine.css';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export default function App() {
  // Auth state - check localStorage immediately
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem('pim_token');
  });
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const stored = localStorage.getItem('pim_user');
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });

  const [activeView, setActiveView] = useState('products');
  const [products, setProducts] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterBrand, setFilterBrand] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterTags, setFilterTags] = useState([]);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [selectedProductForEdit, setSelectedProductForEdit] = useState(null);
  const [showBatchGenerate, setShowBatchGenerate] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImageSync, setShowImageSync] = useState(false);
  const [selectedStoreForMapping, setSelectedStoreForMapping] = useState(null);
  const [hasMoreProducts, setHasMoreProducts] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalProductCount, setTotalProductCount] = useState(0);
  const [allBrands, setAllBrands] = useState([]);
  const [allTypes, setAllTypes] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [filterLoading, setFilterLoading] = useState(false); // Separate loading state for filters
  const [sortBy, setSortBy] = useState('title'); // 'title', 'price', 'vendor', 'created_at'
  const [sortDirection, setSortDirection] = useState('asc'); // 'asc' or 'desc'

  // Load filter metadata (all brands, types, tags from database)
  const loadFilterMetadata = async () => {
    try {
      const res = await fetch(`${API_URL}/db/products/metadata/filters`);
      if (res.ok) {
        const data = await res.json();
        setAllBrands(data.brands || []);
        setAllTypes(data.types || []);
        setAllTags(data.tags || []);
      }
    } catch (err) {
      console.error('Failed to load filter metadata:', err);
    }
  };

  // Listen for 401 from fetch interceptor → force logout
  useEffect(() => {
    const forceLogout = () => {
      setIsAuthenticated(false);
      setCurrentUser(null);
      setError(null);
    };
    window.addEventListener('pim:unauthorized', forceLogout);
    return () => window.removeEventListener('pim:unauthorized', forceLogout);
  }, []);

  // Verify token on mount (in background) and refresh user info
  useEffect(() => {
    const token = localStorage.getItem('pim_token');
    if (token) {
      fetch(`${API_URL}/auth/verify`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(res => {
        if (!res.ok) {
          localStorage.removeItem('pim_token');
          localStorage.removeItem('pim_user');
          localStorage.removeItem('pim_active_store_id');
          setIsAuthenticated(false);
          setCurrentUser(null);
        } else {
          return res.json();
        }
      }).then(data => {
        if (data && data.user) {
          localStorage.setItem('pim_user', JSON.stringify(data.user));
          setCurrentUser(data.user);
        }
      }).catch(() => {
        // Keep authenticated if can't verify (offline mode)
      });
    }
  }, []);

  // Load data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadData();
      loadFilterMetadata();
    }
  }, [isAuthenticated]);

  // Reload data when filters change (use filterLoading instead of full loading screen)
  useEffect(() => {
    // Skip on initial mount (loading is already true from useState)
    if (loading) return;

    loadData(false, true); // append=false, isFilterChange=true
  }, [filterBrand, filterType, filterStatus, filterTags, searchQuery]);

  const loadData = async (append = false, isFilterChange = false) => {
    if (append) {
      setLoadingMore(true);
    } else if (isFilterChange) {
      setFilterLoading(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // Load products with pagination
      const offset = append ? products.length : 0;

      const limit = 200;

      // Build query parameters with filters
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString()
      });

      // Add active filters
      if (filterBrand && filterBrand !== 'all') {
        params.append('vendor', filterBrand);
      }
      if (filterType && filterType !== 'all') {
        params.append('type', filterType);
      }
      if (filterStatus && filterStatus !== 'all') {
        params.append('status', filterStatus);
      }
      if (filterTags.length > 0) {
        params.append('tags', filterTags.join(','));
      }
      if (searchQuery) {
        params.append('search', searchQuery);
      }

      const productsRes = await fetch(`${API_URL}/db/products?${params.toString()}`);
      if (!productsRes.ok) throw new Error('Kunde inte ladda produkter');
      const productsData = await productsRes.json();
      
      // Transform database format to app format
      const transformedProducts = (productsData.data || []).map(p => {
        try {
          return {
            id: p.id,
            title: p.title || '',
            handle: p.handle || '',
            description: p.description || '',
            vendor: p.vendor || '',
            type: p.product_type || '',
            productCategory: p.product_category || '',
            tags: p.tags || [],
            status: p.status || 'draft',
            publishedOnOnlineStore: p.published_on_online_store ?? true,
            price: p.default_price,
            compareAtPrice: p.default_compare_at_price,
            cost: p.default_cost,
            marginMultiplier: p.margin_multiplier,
            supplierId: p.supplier_id,
            sku: p.sku || '',
            barcode: p.barcode || '',
            seoTitle: p.seo_title || '',
            seoDescription: p.seo_description || '',
            chargeTax: p.charge_tax ?? true,
            taxCode: p.tax_code || '',
            requiresShipping: p.requires_shipping ?? true,
            inventoryPolicy: p.inventory_policy || 'deny',
            weight: p.weight,
            weightUnit: p.weight_unit || 'kg',
            variantSchema: p.variant_schema || '',
            metafields: p.metafields || {},
            // Google Shopping
            googleProductCategory: p.google_product_category || '',
            googleGender: p.google_gender || '',
            googleAgeGroup: p.google_age_group || '',
            googleMpn: p.google_mpn || '',
            googleCondition: p.google_condition || '',
            googleCustomLabel0: p.google_custom_label_0 || '',
            googleCustomLabel1: p.google_custom_label_1 || '',
            // Feed
            feedTitle: p.feed_title || '',
            feedDescription: p.feed_description || '',
            // Relations
            variants: (p.variants || []).map(v => ({
              id: v.id,
              sku: v.sku || '',
              barcode: v.barcode || '',
              option1Name: v.option1_name || '',
              option1Value: v.option1_value || '',
              option2Name: v.option2_name || '',
              option2Value: v.option2_value || '',
              option3Name: v.option3_name || '',
              option3Value: v.option3_value || '',
              price: v.price,
              compareAtPrice: v.compare_at_price,
              cost: v.cost,
              weight: v.weight,
              weightUnit: v.weight_unit || 'kg',
              inventoryQuantity: v.inventory_quantity || 0,
              inventoryPolicy: v.inventory_policy || 'deny',
              position: v.position
            })),
            images: (p.images || []).map(img => ({
              id: img.id,
              url: img.url || '',
              alt: img.alt_text || '',
              position: img.position
            })),
            storeProducts: p.store_products || [],
            createdAt: p.created_at,
            updatedAt: p.updated_at
          };
        } catch (e) {
          console.error('Error transforming product:', p.id, e);
          return null;
        }
      }).filter(Boolean);

      // Set total count and check if there are more products
      setTotalProductCount(productsData.total || productsData.count || transformedProducts.length);
      const hasMore = (offset + transformedProducts.length) < (productsData.total || productsData.count || 0);
      setHasMoreProducts(hasMore);

      if (append) {
        setProducts(prev => [...prev, ...transformedProducts]);
      } else {
        setProducts(transformedProducts);
      }

      // Load stores (only on initial load)
      if (!append) {
        const storesRes = await fetch(`${API_URL}/db/stores`);
        if (!storesRes.ok) throw new Error('Kunde inte ladda butiker');
        const storesData = await storesRes.json();

        const transformedStores = (storesData || []).map(s => ({
          id: s.id,
          name: s.name,
          domain: s.domain,
          customDomain: s.custom_domain,
          countryCode: s.country_code,
          currency: s.currency,
          status: s.status,
          lastSyncAt: s.last_sync_at
        }));

        setStores(transformedStores);

        // Pin first store as active if not already set
        if (transformedStores.length > 0) {
          if (!localStorage.getItem('pim_active_store_id')) {
            localStorage.setItem('pim_active_store_id', transformedStores[0].id);
          }
          if (!selectedStoreForMapping) {
            setSelectedStoreForMapping(transformedStores[0].id);
          }
        }
      }

    } catch (err) {
      console.error('Error loading data:', err);
      // Auth errors → redirect to login, not error screen
      if (err.message?.includes('Unauthorized') || err.message?.includes('401') || err.message?.includes('Kunde inte ladda produkter')) {
        const token = localStorage.getItem('pim_token');
        if (!token) {
          setIsAuthenticated(false);
          setCurrentUser(null);
          return;
        }
      }
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setFilterLoading(false);
    }
  };

  const loadMoreProducts = () => {
    loadData(true);
  };

  // Auth handlers - must be defined before early returns
  const handleLogin = (token, user) => {
    setIsAuthenticated(true);
    setCurrentUser(user);
    // Pin first store as active so the fetch interceptor can attach x-store-id.
    const firstStore = user?.stores?.[0]?.store_id || user?.stores?.[0]?.id;
    if (firstStore) localStorage.setItem('pim_active_store_id', firstStore);
  };

  const handleLogout = async () => {
    const token = localStorage.getItem('pim_token');
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error('Logout error:', err);
    }
    localStorage.removeItem('pim_token');
    localStorage.removeItem('pim_user');
    localStorage.removeItem('pim_active_store_id');
    setIsAuthenticated(false);
    setCurrentUser(null);
  };

  // Early return for loading state
  // Show login if not authenticated
  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  if (loading) {
    return (
      <div className="pim-app">
        <div className="loading-screen">
          <Loader2 size={48} className="spin" />
          <h2>Laddar PIM...</h2>
          <p>Ansluter till databasen</p>
        </div>
      </div>
    );
  }

  // Early return for error state (only if authenticated — otherwise show login)
  if (error && isAuthenticated) {
    return (
      <div className="pim-app">
        <div className="error-screen">
          <AlertCircle size={48} />
          <h2>Kunde inte ansluta</h2>
          <p>{error}</p>
          <div className="error-help">
            <p>Kontrollera att:</p>
            <ul>
              <li>Backend-servern körs på port 3001</li>
              <li>Supabase är konfigurerat i .env</li>
              <li>Databasschemat är kört</li>
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-secondary" onClick={() => {
              localStorage.removeItem('pim_token');
              localStorage.removeItem('pim_user');
              localStorage.removeItem('pim_active_store_id');
              setIsAuthenticated(false);
              setError(null);
            }}>
              Logga in igen
            </button>
            <button className="btn btn-primary" onClick={() => { setError(null); loadData(); }}>
              <RefreshCw size={18} />
              Försök igen
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Products are already filtered by the server, no need for client-side filtering
  const filteredProducts = products;

  const totalVariants = products.reduce((acc, p) => acc + (p.variants?.length || 0), 0);

  const toggleProductSelection = (productId) => {
    setSelectedProducts(prev => 
      prev.includes(productId) 
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const selectAllProducts = () => {
    if (selectedProducts.length === filteredProducts.length) {
      setSelectedProducts([]);
    } else {
      setSelectedProducts(filteredProducts.map(p => p.id));
    }
  };

  // Sort products
  const handleSort = (column) => {
    if (sortBy === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortDirection('asc');
    }
  };

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    let aVal, bVal;

    switch (sortBy) {
      case 'title':
        aVal = (a.title || '').toLowerCase();
        bVal = (b.title || '').toLowerCase();
        break;
      case 'price':
        aVal = a.price ?? -1;
        bVal = b.price ?? -1;
        break;
      case 'vendor':
        aVal = (a.vendor || '').toLowerCase();
        bVal = (b.vendor || '').toLowerCase();
        break;
      case 'created_at':
        aVal = new Date(a.createdAt || 0).getTime();
        bVal = new Date(b.createdAt || 0).getTime();
        break;
      default:
        return 0;
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  // Transform app format to database format
  const transformToDbFormat = (product) => {
    // Helper to convert empty strings to null
    const emptyToNull = (val) => (val === '' || val === undefined) ? null : val;
    const emptyToNullNumber = (val) => {
      if (val === '' || val === undefined || val === null) return null;
      const num = parseFloat(val);
      return isNaN(num) ? null : num;
    };
    
    return {
      title: product.title || 'Ny produkt',
      handle: emptyToNull(product.handle),
      description: emptyToNull(product.description),
      vendor: emptyToNull(product.vendor),
      product_type: emptyToNull(product.type),
      product_category: emptyToNull(product.productCategory),
      tags: product.tags || [],
      status: product.status || 'draft',
      published_on_online_store: product.publishedOnOnlineStore ?? true,
      default_price: emptyToNullNumber(product.price),
      default_compare_at_price: emptyToNullNumber(product.compareAtPrice),
      default_cost: emptyToNullNumber(product.cost),
      margin_multiplier: emptyToNullNumber(product.marginMultiplier),
      sku: emptyToNull(product.sku),
      barcode: emptyToNull(product.barcode),
      seo_title: emptyToNull(product.seoTitle),
      seo_description: emptyToNull(product.seoDescription),
      charge_tax: product.chargeTax ?? true,
      tax_code: emptyToNull(product.taxCode),
      requires_shipping: product.requiresShipping ?? true,
      inventory_policy: product.inventoryPolicy || 'deny',
      weight: emptyToNullNumber(product.weight),
      weight_unit: product.weightUnit || 'kg',
      variant_schema: emptyToNull(product.variantSchema),
      metafields: product.metafields || {},
      google_product_category: emptyToNull(product.googleProductCategory),
      google_gender: emptyToNull(product.googleGender),
      google_age_group: emptyToNull(product.googleAgeGroup),
      google_mpn: emptyToNull(product.googleMpn),
      google_condition: emptyToNull(product.googleCondition),
      google_custom_label_0: emptyToNull(product.googleCustomLabel0),
      google_custom_label_1: emptyToNull(product.googleCustomLabel1),
      feed_title: emptyToNull(product.feedTitle),
      feed_description: emptyToNull(product.feedDescription),
      variants: (product.variants || []).map(v => ({
        sku: emptyToNull(v.sku),
        barcode: emptyToNull(v.barcode),
        option1_name: emptyToNull(v.option1Name),
        option1_value: emptyToNull(v.option1Value),
        option2_name: emptyToNull(v.option2Name),
        option2_value: emptyToNull(v.option2Value),
        option3_name: emptyToNull(v.option3Name),
        option3_value: emptyToNull(v.option3Value),
        price: emptyToNullNumber(v.price),
        compare_at_price: emptyToNullNumber(v.compareAtPrice),
        cost: emptyToNullNumber(v.cost),
        weight: emptyToNullNumber(v.weight),
        weight_unit: v.weightUnit || 'kg',
        inventory_quantity: parseInt(v.inventoryQuantity) || 0,
        inventory_policy: v.inventoryPolicy || 'deny',
        position: v.position
      })),
      images: (product.images || []).map(img => ({
        url: img.url,
        alt_text: emptyToNull(img.alt),
        position: img.position
      }))
    };
  };

  const handleProductSave = async (updatedProduct) => {
    try {
      const dbProduct = transformToDbFormat(updatedProduct);
      
      // Check if this is a new product (has temp id) or existing
      const isNew = String(updatedProduct.id).startsWith('new-');
      
      if (isNew) {
        // Create new product
        const response = await fetch(`${API_URL}/db/products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dbProduct)
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Kunde inte skapa produkt');
        }
        
        // Close the modal first
        setSelectedProductForEdit(null);
        
        // Then reload data to get the new product with correct ID
        await loadData();
      } else {
        // Update existing product
        const response = await fetch(`${API_URL}/db/products/${updatedProduct.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dbProduct)
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Kunde inte spara produkt');
        }
        
        // Update local state
        setProducts(prev => prev.map(p => 
          p.id === updatedProduct.id ? updatedProduct : p
        ));
      }
      
      return true;
    } catch (err) {
      console.error('Error saving product:', err);
      alert('Fel vid sparande: ' + err.message);
      return false;
    }
  };

  const handleDeleteProduct = async (productId) => {
    if (!productId || productId.startsWith('new-')) {
      setSelectedProductForEdit(null);
      return true;
    }

    try {
      const response = await fetch(`${API_URL}/db/products/${productId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Kunde inte ta bort produkt');
      }

      // Remove from local state
      setProducts(prev => prev.filter(p => p.id !== productId));
      setSelectedProductForEdit(null);
      return true;
    } catch (err) {
      console.error('Error deleting product:', err);
      alert('Fel vid borttagning: ' + err.message);
      return false;
    }
  };

  const handleAddProduct = () => {
    const newProduct = {
      id: `new-${Date.now()}`,
      title: '',
      handle: '',
      description: '',
      vendor: '',
      type: '',
      productCategory: '',
      tags: [],
      status: 'draft',
      publishedOnOnlineStore: false,
      price: '',
      compareAtPrice: '',
      cost: '',
      sku: '',
      barcode: '',
      seoTitle: '',
      seoDescription: '',
      chargeTax: true,
      taxCode: '',
      requiresShipping: true,
      inventoryPolicy: 'deny',
      weight: '',
      weightUnit: 'kg',
      variantSchema: '',
      variants: [],
      images: [],
      metafields: {},
      storeData: {}
    };
    setSelectedProductForEdit(newProduct);
  };

  const handleImageSyncUpdate = async (updatedProductsMap) => {
    try {
      // Bulk update in database
      const updates = {};
      for (const [id, product] of Object.entries(updatedProductsMap)) {
        updates[id] = {
          images: (product.images || []).map(img => ({
            url: img.url,
            alt_text: img.alt,
            position: img.position
          }))
        };
      }
      
      await fetch(`${API_URL}/db/products/bulk-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      
      // Update local state
      setProducts(prev => prev.map(p => 
        updatedProductsMap[p.id] ? updatedProductsMap[p.id] : p
      ));
    } catch (err) {
      console.error('Error updating images:', err);
    }
  };

  const handleImportComplete = async (parsedProducts) => {
    const newProducts = parsedProducts.map((p, idx) => {
      const product = {
        title: `${p.brand || ''} ${p.model || ''}`.trim() || p._original || 'Ny produkt',
        vendor: p.brand || 'Okänt',
        type: p.type || 'Uncategorized',
        description: '',
        price: p.Pris || p.pris || p.price || 0,
        compareAtPrice: null,
        cost: p.Inköpspris || p.cost || null,
        status: 'draft',
        images: [],
        seoTitle: '',
        seoDescription: '',
        metafields: {},
        variants: [{
          sku: p.EAN || p.ean || p.Artikelnummer || `NEW-${Date.now()}-${idx}`,
          barcode: p.EAN || p.ean || '',
          option1Name: p.fattning ? 'Fattning' : (p.färg ? 'Färg' : null),
          option1Value: p.fattning || p.färg || null,
          option2Name: p.loft ? 'Loft' : (p.storlek ? 'Storlek' : null),
          option2Value: p.loft || p.storlek || null,
          option3Name: p.skaft ? 'Skaft' : null,
          option3Value: p.skaft || null,
          price: p.Pris || p.pris || p.price || 0,
          inventoryQuantity: 0
        }],
        variantSchema: detectVariantType(p),
        tags: []
      };
      return product;
    });

    // Save to database
    try {
      for (const product of newProducts) {
        const dbProduct = transformToDbFormat(product);
        const response = await fetch(`${API_URL}/db/products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dbProduct)
        });
        
        if (!response.ok) {
          console.error('Failed to create product:', product.title);
        }
      }
      
      // Reload all products
      loadData();
    } catch (err) {
      console.error('Error importing products:', err);
      alert('Fel vid import: ' + err.message);
    }
  };

  const handleBatchGenerateComplete = async (results) => {
    // Update products with generated content
    const updates = {};
    
    results.forEach(result => {
      if (result.success) {
        updates[result.productId] = {
          description: result.description,
          seo_title: result.seoTitle,
          seo_description: result.metaDescription
        };
      }
    });
    
    if (Object.keys(updates).length > 0) {
      try {
        await fetch(`${API_URL}/db/products/bulk-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates })
        });
        
        // Update local state
        setProducts(prev => prev.map(product => {
          const result = results.find(r => r.productId === product.id);
          if (result && result.success) {
            return {
              ...product,
              description: result.description || product.description,
              seoTitle: result.seoTitle || product.seoTitle,
              seoDescription: result.metaDescription || product.seoDescription
            };
          }
          return product;
        }));
      } catch (err) {
        console.error('Error saving generated content:', err);
      }
    }
  };

  const detectVariantType = (p) => {
    if (p.storlek && p.färg) return 'clothing';
    if (p.loft && p.skaft) return 'metalwoods';
    if (p.storlek) return 'accessories';
    return 'metalwoods';
  };

  const stats = {
    missingDescription: products.filter(p => !p.description || p.description.length < 50).length,
    missingSeoTitle: products.filter(p => !p.seoTitle).length,
    missingMetaDescription: products.filter(p => !p.seoDescription && !p.metaDescription).length
  };

  return (
    <div className="pim-app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo-text">Lumeno</span>
        </div>
        
        <nav className="nav-section">
          <div className="nav-section-title">Produkter</div>
          <div
            className={`nav-item ${activeView === 'products' ? 'active' : ''}`}
            onClick={() => setActiveView('products')}
          >
            <Package size={20} />
            <span className="nav-label">Alla produkter</span>
            <span className="nav-badge">{totalProductCount || products.length}</span>
          </div>
          <div
            className={`nav-item ${activeView === 'collections' ? 'active' : ''}`}
            onClick={() => setActiveView('collections')}
          >
            <Layers size={20} />
            <span className="nav-label">Collections</span>
          </div>
          <div
            className={`nav-item ${activeView === 'image-import' ? 'active' : ''}`}
            onClick={() => setActiveView('image-import')}
          >
            <Image size={20} />
            <span className="nav-label">Bildimport</span>
          </div>
          <div
            className={`nav-item ${activeView === 'prices' ? 'active' : ''}`}
            onClick={() => setActiveView('prices')}
          >
            <DollarSign size={20} />
            <span className="nav-label">Priser & Rea</span>
          </div>
          <div
            className={`nav-item ${activeView === 'margin' ? 'active' : ''}`}
            onClick={() => setActiveView('margin')}
          >
            <TrendingUp size={20} />
            <span className="nav-label">Marginal & Vinst</span>
          </div>
          <div
            className={`nav-item ${activeView === 'feeds' ? 'active' : ''}`}
            onClick={() => setActiveView('feeds')}
          >
            <Zap size={20} />
            <span className="nav-label">Produkt feeds</span>
          </div>
        </nav>

        <nav className="nav-section">
          <div className="nav-section-title">Import</div>
          <div
            className={`nav-item ${activeView === 'suppliers' ? 'active' : ''}`}
            onClick={() => setActiveView('suppliers')}
          >
            <Users size={20} />
            <span className="nav-label">Leverantörer</span>
          </div>
          <div
            className={`nav-item ${activeView === 'import' ? 'active' : ''}`}
            onClick={() => setActiveView('import')}
          >
            <FolderInput size={20} />
            <span className="nav-label">Importera produkter</span>
          </div>
          <div
            className={`nav-item ${activeView === 'inventory' ? 'active' : ''}`}
            onClick={() => setActiveView('inventory')}
          >
            <RefreshCw size={20} />
            <span className="nav-label">Uppdatera lagersaldo</span>
          </div>
        </nav>

        <nav className="nav-section">
          <div className="nav-section-title">Distribution</div>
          <div 
            className={`nav-item ${activeView === 'stores' ? 'active' : ''}`}
            onClick={() => setActiveView('stores')}
          >
            <Store size={20} />
            <span className="nav-label">Butiker</span>
            <span className="nav-badge">{stores.filter(s => s.status === 'connected').length}</span>
          </div>
          <div 
            className={`nav-item ${activeView === 'mapping' ? 'active' : ''}`}
            onClick={() => setActiveView('mapping')}
          >
            <Link2 size={20} />
            <span className="nav-label">Fältmappning</span>
          </div>
        </nav>
        
        <nav className="nav-section" style={{ marginTop: 'auto' }}>
          <div
            className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
          >
            <Settings size={20} />
            <span className="nav-label">Inställningar</span>
          </div>
          <div
            className="nav-item logout"
            onClick={handleLogout}
          >
            <LogOut size={20} />
            <span className="nav-label">Logga ut</span>
          </div>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {/* Top Bar */}
        <header className="topbar">
          <div className="search-container">
            <Search className="search-icon" />
            <input 
              type="text" 
              className="search-input" 
              placeholder="Sök produkter, SKU, varumärke..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
        </header>

        {/* Content Area */}
        <div className="content-area">
          {activeView === 'products' && (
            <ProductsView
              products={sortedProducts}
              stores={stores}
              totalProducts={totalProductCount}
              totalVariants={totalVariants}
              selectedProducts={selectedProducts}
              toggleProductSelection={toggleProductSelection}
              selectAllProducts={selectAllProducts}
              filterBrand={filterBrand}
              setFilterBrand={setFilterBrand}
              filterType={filterType}
              setFilterType={setFilterType}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              filterTags={filterTags}
              setFilterTags={setFilterTags}
              brands={allBrands}
              types={allTypes}
              allTags={allTags}
              stats={stats}
              onPublish={() => setShowPublishModal(true)}
              onEditProduct={setSelectedProductForEdit}
              onBatchGenerate={() => setShowBatchGenerate(true)}
              onExport={() => setShowExportModal(true)}
              onAddProduct={handleAddProduct}
              hasMoreProducts={hasMoreProducts}
              loadingMore={loadingMore}
              filterLoading={filterLoading}
              onLoadMore={loadMoreProducts}
              currentlyLoaded={products.length}
              sortBy={sortBy}
              sortDirection={sortDirection}
              onSort={handleSort}
              onGoToShopifyImport={() => setActiveView('import')}
              onDelete={handleDeleteProduct}
            />
          )}
          
          {activeView === 'collections' && (
            <CollectionsView stores={stores} />
          )}

          {activeView === 'image-import' && (
            <ImageImportView />
          )}

          {activeView === 'stores' && (
            <StoreManager
              stores={stores}
              onStoresChange={loadData}
            />
          )}
          
          {activeView === 'prices' && (
            <PriceManager
              products={products}
              onUpdateProducts={handleImageSyncUpdate}
            />
          )}

          {activeView === 'margin' && (
            <MarginEngine />
          )}

          {activeView === 'inventory' && (
            <InventorySync />
          )}

          {activeView === 'mapping' && (
            <MappingView 
              stores={stores}
              selectedStoreId={selectedStoreForMapping}
              onStoreSelect={setSelectedStoreForMapping}
            />
          )}
          
          {activeView === 'feeds' && (
            <FeedsView stores={stores} />
          )}

          {activeView === 'suppliers' && (
            <SuppliersView onConfigureMapping={() => setActiveView('mapping')} />
          )}

          {activeView === 'import' && (
            <ImportView onSelectCsv={() => setActiveView('inventory')} storeId={stores[0]?.id || localStorage.getItem('pim_active_store_id')} />
          )}

          {activeView === 'settings' && (
            <SettingsView />
          )}
        </div>
      </main>

      {/* Product Detail Modal */}
      {selectedProductForEdit && (
        <ProductDetail
          product={selectedProductForEdit}
          stores={stores}
          onSave={handleProductSave}
          onDelete={handleDeleteProduct}
          onClose={() => setSelectedProductForEdit(null)}
        />
      )}

      {/* Batch Generate Modal */}
      {showBatchGenerate && (
        <BatchGenerate
          products={products}
          onComplete={handleBatchGenerateComplete}
          onClose={() => setShowBatchGenerate(false)}
        />
      )}

      {/* Shopify Export Modal */}
      {showExportModal && (
        <ShopifyExport
          products={products}
          stores={stores}
          onClose={() => setShowExportModal(false)}
        />
      )}

      {/* Image Sync Modal */}
      {showImageSync && (
        <ImageSync
          products={products}
          onUpdateProducts={handleImageSyncUpdate}
          onClose={() => setShowImageSync(false)}
        />
      )}
      
      {/* Publish Modal */}
      {showPublishModal && (
        <PublishModal
          onClose={() => setShowPublishModal(false)}
          stores={stores}
          selectedCount={selectedProducts.length}
          selectedProductIds={selectedProducts}
          onPublishComplete={() => {
            setSelectedProducts([]);
            loadData();
          }}
        />
      )}
    </div>
  );
}

// Products View Component
function ProductsView({
  products, stores, totalProducts, totalVariants, selectedProducts,
  toggleProductSelection, selectAllProducts,
  filterBrand, setFilterBrand, filterType, setFilterType,
  filterStatus, setFilterStatus, filterTags, setFilterTags,
  brands, types, allTags,
  stats, onPublish, onEditProduct, onBatchGenerate, onExport, onAddProduct,
  hasMoreProducts, loadingMore, filterLoading, onLoadMore, currentlyLoaded,
  sortBy, sortDirection, onSort,
  onGoToShopifyImport, onDelete,
}) {
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [shopifyGap, setShopifyGap] = useState(null);

  useEffect(() => {
    const storeId = localStorage.getItem('pim_active_store_id');
    if (!storeId) return;
    fetch(`${API_URL}/shopify/stores/${storeId}/product-diff`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.newInShopify?.length > 0) setShopifyGap(data.newInShopify.length); })
      .catch(() => {});
  }, []);
  // Close filter dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showTagFilter && !e.target.closest('.tag-filter-container')) {
        setShowTagFilter(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTagFilter]);

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Produkter</h1>
          <p className="content-subtitle">
            {totalProducts} produkter, {totalVariants} varianter
            {products.length < totalProducts && (
              <span style={{ color: 'var(--accent)', marginLeft: '8px' }}>
                • Visar {products.length} filtrerade
              </span>
            )}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={onExport}>
            <Download size={18} />
            Exportera till Shopify
          </button>
          <button className="btn btn-accent" onClick={onBatchGenerate}>
            <Wand2 size={18} />
            Batch-generera innehåll
          </button>
          <button className="btn btn-primary" onClick={onAddProduct}>
            <Plus size={18} /> Lägg till produkt
          </button>
        </div>
      </div>
      
      {/* Shopify gap notification */}
      {shopifyGap > 0 && (
        <div className="shopify-gap-banner">
          <Globe size={15} />
          <span className="gap-count">{shopifyGap}</span>
          <span>produkter finns i Shopify men saknas i PIM</span>
          <button className="gap-link" onClick={onGoToShopifyImport}>
            Hämta till PIM →
          </button>
        </div>
      )}

      {/* Content Stats */}
      {(stats.missingDescription > 0 || stats.missingSeoTitle > 0) && (
        <div className="content-warnings">
          {stats.missingDescription > 0 && (
            <div className="warning-badge">
              <AlertCircle size={14} />
              <span>{stats.missingDescription} produkter saknar beskrivning</span>
            </div>
          )}
          {stats.missingSeoTitle > 0 && (
            <div className="warning-badge">
              <AlertCircle size={14} />
              <span>{stats.missingSeoTitle} produkter saknar SEO-titel</span>
            </div>
          )}
        </div>
      )}
      
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Totalt produkter</div>
          <div className="stat-value">{totalProducts}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Totalt varianter</div>
          <div className="stat-value">{totalVariants}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pushade till butiker</div>
          <div className="stat-value">{products.filter(p => p.storeProducts && p.storeProducts.length > 0).length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Endast i PIM</div>
          <div className="stat-value">{products.filter(p => !p.storeProducts || p.storeProducts.length === 0).length}</div>
        </div>
      </div>
      
      <div className="filters-bar">
        <select
          className="filter-select"
          value={filterBrand}
          onChange={(e) => setFilterBrand(e.target.value)}
        >
          <option value="all">Alla varumärken ({brands.length})</option>
          {brands.map(brand => (
            <option key={brand} value={brand}>{brand}</option>
          ))}
        </select>

        <select
          className="filter-select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="all">Alla typer ({types.length})</option>
          {types.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>

        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="all">Alla status</option>
          <option value="draft">Utkast</option>
          <option value="active">Aktiv</option>
          <option value="archived">Arkiverad</option>
        </select>

        <div className="tag-filter-container" style={{ position: 'relative' }}>
          <button
            className={`filter-select ${filterTags.length > 0 ? 'active-filter' : ''}`}
            onClick={() => setShowTagFilter(!showTagFilter)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: 'pointer',
              background: filterTags.length > 0 ? 'var(--accent-dim)' : 'var(--surface)',
              border: filterTags.length > 0 ? '1px solid var(--accent)' : '1px solid var(--border)'
            }}
          >
            <Tag size={16} />
            <span>
              {filterTags.length === 0
                ? `Taggar (${allTags.length})`
                : `${filterTags.length} valda`}
            </span>
            <ChevronRight
              size={16}
              style={{
                transform: showTagFilter ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s'
              }}
            />
          </button>

          {showTagFilter && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '8px',
              minWidth: '250px',
              maxHeight: '300px',
              overflowY: 'auto',
              zIndex: 1000,
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px',
                paddingBottom: '8px',
                borderBottom: '1px solid var(--border)'
              }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>Välj taggar</span>
                {filterTags.length > 0 && (
                  <button
                    className="btn-icon"
                    onClick={() => setFilterTags([])}
                    style={{ fontSize: '11px', color: 'var(--text-secondary)' }}
                  >
                    Rensa alla
                  </button>
                )}
              </div>
              {allTags.map(tag => (
                <label
                  key={tag}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 8px',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    fontSize: '13px',
                    transition: 'background 0.1s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-hover)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <input
                    type="checkbox"
                    checked={filterTags.includes(tag)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setFilterTags([...filterTags, tag]);
                      } else {
                        setFilterTags(filterTags.filter(t => t !== tag));
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{tag}</span>
                </label>
              ))}
              {allTags.length === 0 && (
                <div style={{
                  padding: '12px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '13px'
                }}>
                  Inga taggar hittades
                </div>
              )}
            </div>
          )}
        </div>

        {(filterBrand !== 'all' || filterType !== 'all' || filterStatus !== 'all' || filterTags.length > 0) && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setFilterBrand('all');
              setFilterType('all');
              setFilterStatus('all');
              setFilterTags([]);
            }}
            style={{ fontSize: '13px' }}
          >
            <X size={14} />
            Rensa filter
          </button>
        )}

        {filterLoading && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: 'var(--accent)',
            fontSize: '13px',
            padding: '8px 12px'
          }}>
            <Loader2 size={16} className="spin" />
            <span>Filtrerar...</span>
          </div>
        )}

        {selectedProducts.length > 0 && (
          <div className="selection-info">
            <span>{selectedProducts.length} valda</span>
            <button className="btn btn-primary" onClick={onPublish}>
              <Globe size={16} /> Publicera till butiker
            </button>
          </div>
        )}
      </div>
      
      <div className="products-table">
        <div className="table-header">
          <div
            className={`checkbox ${selectedProducts.length === products.length && products.length > 0 ? 'checked' : ''}`}
            onClick={selectAllProducts}
          >
            {selectedProducts.length === products.length && products.length > 0 && <Check size={14} />}
          </div>
          <div>Bild</div>
          <div className="sortable" onClick={() => onSort('title')}>
            Produkt
            {sortBy === 'title' && (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
          </div>
          <div>Innehåll</div>
          <div className="sortable" onClick={() => onSort('price')}>
            Pris
            {sortBy === 'price' && (sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
          </div>
          <div>Varianter</div>
          <div>Publicerad</div>
          <div></div>
        </div>

        {products.map(product => (
          <div 
            key={product.id} 
            className={`table-row ${selectedProducts.includes(product.id) ? 'selected' : ''}`}
            onClick={() => onEditProduct(product)}
          >
            <div 
              className={`checkbox ${selectedProducts.includes(product.id) ? 'checked' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggleProductSelection(product.id); }}
            >
              {selectedProducts.includes(product.id) && <Check size={14} />}
            </div>
            <div className="product-image">
              {product.images?.[0] ? (
                <img src={product.images[0].url} alt="" style={{width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px'}} />
              ) : (
                <Image size={24} />
              )}
            </div>
            <div className="product-info">
              <div className="product-title">
                {product.title}
                {/* Indikator för osynkade ändringar till Central */}
                {product.storeProducts?.some(sp =>
                  sp.sync_status === 'pending'
                ) && (
                  <span
                    className="sync-pending-badge"
                    title="Ändringar i PIM som inte är synkade till Central"
                  >
                    <RefreshCw size={12} /> Osynkad
                  </span>
                )}
              </div>
              <div className="product-meta">
                <span className="product-sku">{product.variants?.[0]?.sku || product.sku}</span>
                <span className="product-brand">{product.vendor || product.brand}</span>
              </div>
            </div>
            <div className="content-status">
              {product.description && product.description.replace(/<[^>]*>/g, '').trim().length > 20 ? (
                <span className="content-ok"><CheckCircle2 size={14} /> Beskrivning</span>
              ) : (
                <span className="content-missing"><AlertCircle size={14} /> Beskrivning</span>
              )}
              {product.seoTitle ? (
                <span className="content-ok"><CheckCircle2 size={14} /> SEO</span>
              ) : (
                <span className="content-missing"><AlertCircle size={14} /> SEO</span>
              )}
            </div>
            <div className="product-price">{product.price?.toLocaleString()} kr</div>
            <div className="product-variants">{product.variants?.length || 0} st</div>
            <div className="published-stores">
              {stores.slice(0, 4).map(store => {
                const storeProduct = product.storeProducts?.find(sp => sp.store_id === store.id);
                const syncStatus = storeProduct?.sync_status;
                const isPublished = storeProduct?.is_published;

                // Determine dot class based on sync status
                let dotClass = 'inactive';
                let statusText = 'Ej publicerad';

                if (isPublished) {
                  if (syncStatus === 'synced') {
                    dotClass = 'published';
                    statusText = 'Publicerad & synkad';
                  } else if (syncStatus === 'error') {
                    dotClass = 'error';
                    statusText = `Synkfel: ${storeProduct?.last_sync_error || 'Okänt fel'}`;
                  } else if (syncStatus === 'pending') {
                    dotClass = 'pending';
                    statusText = 'Väntar på synk';
                  } else {
                    dotClass = 'published';
                    statusText = 'Publicerad';
                  }
                }

                return (
                  <div
                    key={store.id}
                    className={`store-dot ${dotClass}`}
                    data-tooltip={`${store.name}: ${statusText}`}
                  />
                );
              })}
              {stores.length > 4 && (
                <div
                  className="store-dot-more"
                  title={`+${stores.length - 4} fler butiker`}
                >
                  +{stores.length - 4}
                </div>
              )}
            </div>
            <button
              className="action-btn delete-btn"
              title="Ta bort produkt"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Ta bort "${product.title}"? Det går inte att ångra.`)) {
                  onDelete(product.id);
                }
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      {/* Load More Button */}
      {hasMoreProducts && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '32px',
          gap: '16px'
        }}>
          <button
            className="btn btn-secondary"
            onClick={onLoadMore}
            disabled={loadingMore}
            style={{ minWidth: '200px' }}
          >
            {loadingMore ? (
              <>
                <Loader2 size={18} className="spin" />
                Laddar fler...
              </>
            ) : (
              <>
                <RefreshCw size={18} />
                Ladda fler produkter
              </>
            )}
          </button>
          <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Visar {currentlyLoaded} av {totalProducts}
          </span>
        </div>
      )}
    </>
  );
}

// Mapping View Component
function MappingView({ stores, selectedStoreId, onStoreSelect }) {
  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Fältmappning</h1>
          <p className="content-subtitle">Konfigurera hur PIM-fält mappas till Shopify per butik</p>
        </div>
      </div>
      
      <div className="mapping-layout">
        <div className="mapping-stores-sidebar">
          <h3>Välj butik</h3>
          {stores.filter(s => s.status === 'connected').map(store => (
            <div
              key={store.id}
              className={`mapping-store-item ${selectedStoreId === store.id ? 'selected' : ''}`}
              onClick={() => onStoreSelect(store.id)}
            >
              <Store size={18} />
              <div>
                <div className="mapping-store-name">{store.name}</div>
                <div className="mapping-store-domain">{store.domain}</div>
              </div>
            </div>
          ))}
        </div>
        
        <div className="mapping-config-area">
          <MappingConfig 
            stores={stores}
            selectedStoreId={selectedStoreId}
            onStoreSelect={onStoreSelect}
          />
        </div>
      </div>
    </>
  );
}

// Feeds View Component
function FeedsView({ stores }) {
  const [feeds, setFeeds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedStore, setSelectedStore] = useState(stores[0]?.id || '');
  const [showCreate, setShowCreate] = useState(false);
  const [editingFeed, setEditingFeed] = useState(null);
  const [newFeed, setNewFeed] = useState({ name: '', format: 'xml', filters: {}, settings: {} });
  const [previews, setPreviews] = useState({});
  const [copiedId, setCopiedId] = useState(null);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
  const BASE_URL = import.meta.env.VITE_API_URL?.replace('/api', '') || 'http://localhost:3001';

  useEffect(() => {
    if (selectedStore) loadFeeds();
  }, [selectedStore]);

  const loadFeeds = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/db/feeds?storeId=${selectedStore}`);
      const data = await res.json();
      setFeeds(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load feeds:', err);
    } finally {
      setLoading(false);
    }
  };

  const createFeed = async () => {
    if (!newFeed.name.trim()) return;
    try {
      const res = await fetch(`${API_URL}/db/feeds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: selectedStore, ...newFeed })
      });
      const feed = await res.json();
      setFeeds(prev => [feed, ...prev]);
      setNewFeed({ name: '', format: 'xml', filters: {}, settings: {} });
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create feed:', err);
    }
  };

  const updateFeed = async (feedId, updates) => {
    try {
      const res = await fetch(`${API_URL}/db/feeds/${feedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const updated = await res.json();
      setFeeds(prev => prev.map(f => f.id === feedId ? updated : f));
      if (editingFeed?.id === feedId) setEditingFeed(null);
    } catch (err) {
      console.error('Failed to update feed:', err);
    }
  };

  const deleteFeed = async (feedId) => {
    if (!confirm('Vill du ta bort denna feed? GMC kommer inte längre kunna hämta data.')) return;
    try {
      await fetch(`${API_URL}/db/feeds/${feedId}`, { method: 'DELETE' });
      setFeeds(prev => prev.filter(f => f.id !== feedId));
    } catch (err) {
      console.error('Failed to delete feed:', err);
    }
  };

  const previewFeed = async (feedId) => {
    try {
      const res = await fetch(`${API_URL}/db/feeds/${feedId}/preview`, { method: 'POST' });
      const data = await res.json();
      setPreviews(prev => ({ ...prev, [feedId]: data }));
    } catch (err) {
      console.error('Failed to preview feed:', err);
    }
  };

  const copyFeedUrl = (token, format) => {
    const ext = format === 'xml' ? 'xml' : format === 'tsv' ? 'tsv' : 'csv';
    const url = `${BASE_URL}/api/feeds/${token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(token);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const feedUrl = (token) => `${BASE_URL}/api/feeds/${token}`;

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Produkt feeds</h1>
          <p className="content-subtitle">Skapa och hantera produktflöden för Google Merchant Center</p>
        </div>
        <div className="header-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {stores.length > 1 && (
            <select className="form-input" style={{ width: 'auto', fontSize: '13px' }}
              value={selectedStore} onChange={e => setSelectedStore(e.target.value)}>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={18} /> Skapa feed
          </button>
        </div>
      </div>

      {/* Create feed form */}
      {showCreate && (
        <div className="settings-section" style={{ padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ marginBottom: '12px', fontSize: '15px' }}>Ny feed</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' }}>
            <div>
              <label className="form-label">Namn</label>
              <input type="text" className="form-input" placeholder="T.ex. Google Shopping — Alla produkter"
                value={newFeed.name} onChange={e => setNewFeed(prev => ({ ...prev, name: e.target.value }))} />
            </div>
            <div>
              <label className="form-label">Format</label>
              <select className="form-input" value={newFeed.format}
                onChange={e => setNewFeed(prev => ({ ...prev, format: e.target.value }))}>
                <option value="xml">XML (Google Shopping)</option>
                <option value="csv">CSV</option>
                <option value="tsv">TSV</option>
              </select>
            </div>
          </div>

          {/* Filter section */}
          <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Filter (valfritt)</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div>
                <label className="form-label" style={{ fontSize: '12px' }}>Varumärken (kommaseparerat)</label>
                <input type="text" className="form-input" placeholder="t.ex. Nike, Adidas"
                  value={(newFeed.filters.vendors || []).join(', ')}
                  onChange={e => setNewFeed(prev => ({
                    ...prev, filters: { ...prev.filters, vendors: e.target.value ? e.target.value.split(',').map(v => v.trim()).filter(Boolean) : [] }
                  }))} />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '12px' }}>Custom Label 0</label>
                <input type="text" className="form-input" placeholder="T.ex. Bästsäljare"
                  value={newFeed.filters.customLabel0 || ''}
                  onChange={e => setNewFeed(prev => ({
                    ...prev, filters: { ...prev.filters, customLabel0: e.target.value || undefined }
                  }))} />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '12px' }}>Custom Label 1</label>
                <input type="text" className="form-input" placeholder="T.ex. Nyhet"
                  value={newFeed.filters.customLabel1 || ''}
                  onChange={e => setNewFeed(prev => ({
                    ...prev, filters: { ...prev.filters, customLabel1: e.target.value || undefined }
                  }))} />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
            <button className="btn btn-primary" onClick={createFeed} disabled={!newFeed.name.trim()}>
              Skapa feed
            </button>
            <button className="btn btn-ghost" onClick={() => { setShowCreate(false); setNewFeed({ name: '', format: 'xml', filters: {}, settings: {} }); }}>
              Avbryt
            </button>
          </div>
        </div>
      )}

      {/* Feed list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : feeds.length === 0 && !showCreate ? (
        <div className="settings-section">
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-secondary)' }}>
            <Zap size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
            <h3 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>Inga feeds ännu</h3>
            <p>Skapa en feed för att generera en URL som du kan lägga till i Google Merchant Center.</p>
            <p style={{ marginTop: '8px', fontSize: '13px' }}>
              GMC hämtar feeden automatiskt — du behöver aldrig ladda upp en CSV manuellt.
              Prisändringar och nya produkter kommer med automatiskt.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {feeds.map(feed => {
            const preview = previews[feed.id];
            const isEditing = editingFeed?.id === feed.id;

            return (
              <div key={feed.id} className="settings-section" style={{ padding: '20px' }}>
                {/* Header row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, fontSize: '15px' }}>{feed.name}</span>
                      <span style={{
                        fontSize: '11px', padding: '2px 8px', borderRadius: '10px',
                        background: feed.status === 'active' ? 'var(--success-bg, #dcfce7)' : 'var(--warning-bg, #fef3c7)',
                        color: feed.status === 'active' ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)'
                      }}>
                        {feed.status === 'active' ? 'Aktiv' : 'Pausad'}
                      </span>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      Format: {feed.format.toUpperCase()}
                      {feed.product_count > 0 && <> &bull; {feed.product_count} produkter</>}
                      {feed.last_generated_at && <> &bull; Senast hämtad: {new Date(feed.last_generated_at).toLocaleString('sv-SE')}</>}
                    </div>

                    {/* Filters display */}
                    {Object.keys(feed.filters || {}).some(k => {
                      const v = feed.filters[k];
                      return v && (Array.isArray(v) ? v.length > 0 : true);
                    }) && (
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <Filter size={12} style={{ marginTop: '1px' }} />
                        {feed.filters.vendors?.length > 0 && (
                          <span style={{ background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: '4px' }}>
                            Varumärken: {feed.filters.vendors.join(', ')}
                          </span>
                        )}
                        {feed.filters.customLabel0 && (
                          <span style={{ background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: '4px' }}>
                            Label 0: {feed.filters.customLabel0}
                          </span>
                        )}
                        {feed.filters.customLabel1 && (
                          <span style={{ background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: '4px' }}>
                            Label 1: {feed.filters.customLabel1}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => previewFeed(feed.id)}>
                      Förhandsgranska
                    </button>
                    <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => updateFeed(feed.id, { status: feed.status === 'active' ? 'paused' : 'active' })}>
                      {feed.status === 'active' ? 'Pausa' : 'Aktivera'}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '4px 10px', color: 'var(--error)' }}
                      onClick={() => deleteFeed(feed.id)}>
                      Ta bort
                    </button>
                  </div>
                </div>

                {/* Feed URL */}
                <div style={{
                  marginTop: '12px', padding: '10px 14px', background: 'var(--bg-secondary)',
                  borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px'
                }}>
                  <Link2 size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                  <code style={{ fontSize: '12px', flex: 1, wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                    {feedUrl(feed.auth_token)}
                  </code>
                  <button className="btn btn-secondary" style={{ fontSize: '11px', padding: '3px 8px', flexShrink: 0 }}
                    onClick={() => copyFeedUrl(feed.auth_token, feed.format)}>
                    {copiedId === feed.auth_token ? <><Check size={12} /> Kopierad</> : 'Kopiera URL'}
                  </button>
                  <a href={feedUrl(feed.auth_token)} target="_blank" rel="noopener noreferrer"
                    style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                    <ExternalLink size={14} />
                  </a>
                </div>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', marginLeft: '14px' }}>
                  Lägg till denna URL i Google Merchant Center under Produkter &rarr; Feeds &rarr; Supplemental feed.
                  GMC hämtar feeden automatiskt — prisändringar och nya produkter kommer med direkt.
                </p>

                {/* Preview */}
                {preview && (
                  <div style={{ marginTop: '12px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
                      {preview.productCount} produkter matchar filtren
                    </div>
                    {preview.sample?.length > 0 && (
                      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)' }}>ID</th>
                            <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)' }}>Titel</th>
                            <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)' }}>Varumärke</th>
                            <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-secondary)' }}>Pris</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample.map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{p.id}</td>
                              <td style={{ padding: '4px 8px' }}>{p.title}</td>
                              <td style={{ padding: '4px 8px' }}>{p.vendor}</td>
                              <td style={{ padding: '4px 8px', textAlign: 'right' }}>{p.price ? `${p.price} kr` : '–'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// Suppliers View Component
function SuppliersView({ onConfigureMapping }) {
  const [suppliers, setSuppliers] = useState([]);

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Leverantörer</h1>
          <p className="content-subtitle">Hantera leverantörsprofiler med kolumnmappningar och importinställningar</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => {
            setSuppliers(prev => [...prev, {
              id: `sup_${Date.now()}`,
              name: '',
              importType: 'csv',
              status: 'draft',
              createdAt: new Date().toISOString()
            }]);
          }}>
            <Plus size={18} /> Lägg till leverantör
          </button>
        </div>
      </div>

      {suppliers.length === 0 ? (
        <div className="settings-section">
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-secondary)' }}>
            <Users size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
            <h3 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>Inga leverantörer ännu</h3>
            <p>Skapa en leverantörsprofil för att spara kolumnmappningar, prisregler och bildkonventioner.</p>
            <p style={{ marginTop: '8px', fontSize: '13px' }}>
              Profilen återanvänds vid varje import — du behöver bara mappa kolumner en gång per leverantör.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {suppliers.map(sup => (
            <div key={sup.id} className="settings-section" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <input type="text" className="form-input" style={{ fontWeight: 600, fontSize: '15px', border: 'none', padding: 0, background: 'transparent' }}
                    value={sup.name} placeholder="Leverantörsnamn"
                    onChange={e => setSuppliers(prev => prev.map(s => s.id === sup.id ? { ...s, name: e.target.value } : s))} />
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Format: {sup.importType.toUpperCase()} &bull; Kolumnmappning: Ej konfigurerad
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-secondary" style={{ fontSize: '13px' }} onClick={onConfigureMapping}>Konfigurera mappning</button>
                  <button className="btn btn-ghost" style={{ fontSize: '13px', color: 'var(--error)' }}
                    onClick={() => setSuppliers(prev => prev.filter(s => s.id !== sup.id))}>
                    Ta bort
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Import View Component
function ImportView({ onSelectCsv, storeId }) {
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showShopifyImport, setShowShopifyImport] = useState(false);

  if (showCsvImport) {
    return (
      <ProductImport
        onClose={() => setShowCsvImport(false)}
        onImportComplete={() => setShowCsvImport(false)}
      />
    );
  }

  if (showShopifyImport) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="content-header" style={{ flexShrink: 0 }}>
          <div>
            <h1 className="content-title">Hämta från Shopify</h1>
            <p className="content-subtitle">Produkter i Shopify som inte finns i PIM</p>
          </div>
          <button className="btn btn-ghost" onClick={() => setShowShopifyImport(false)}>
            <X size={18} /> Tillbaka
          </button>
        </div>
        <ShopifyImport
          storeId={storeId}
          onClose={() => setShowShopifyImport(false)}
          onImportComplete={() => {}}
        />
      </div>
    );
  }

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Importera produkter</h1>
          <p className="content-subtitle">Importera produkter från leverantörsfiler, API:er eller andra system</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
        <div className="settings-section" style={{ padding: '24px', cursor: 'pointer' }} onClick={() => setShowCsvImport(true)}>
          <FileSpreadsheet size={32} style={{ marginBottom: '12px', color: 'var(--accent)' }} />
          <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>Leverantörsfil (CSV/Excel)</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Ladda upp en CSV- eller Excel-fil och mappa kolumner mot PIM-fält.
          </p>
        </div>

        <div
          className="settings-section"
          style={{ padding: '24px', cursor: storeId ? 'pointer' : 'default', opacity: storeId ? 1 : 0.5 }}
          onClick={() => storeId && setShowShopifyImport(true)}
        >
          <Globe size={32} style={{ marginBottom: '12px', color: 'var(--accent)' }} />
          <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>Från Shopify-butik</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            {storeId
              ? 'Hämta produkter som finns i Shopify men saknas i PIM.'
              : 'Koppla en Shopify-butik under Butiker för att aktivera.'}
          </p>
        </div>

        <div className="settings-section" style={{ padding: '24px', opacity: 0.6 }}>
          <Database size={32} style={{ marginBottom: '12px', color: 'var(--accent)' }} />
          <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>Från annat PIM/system</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Koppla till ett externt system via API. Kommer snart.
          </p>
        </div>

        <div className="settings-section" style={{ padding: '24px', opacity: 0.6 }}>
          <Sparkles size={32} style={{ marginBottom: '12px', color: 'var(--accent)' }} />
          <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>Fritext / AI-parsning</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Klistra in produktinformation i fritext. Kommer snart.
          </p>
        </div>
      </div>
    </>
  );
}

// Settings View Component
function SettingsView() {
  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="content-title">Inställningar</h1>
          <p className="content-subtitle">Konfigurera ditt PIM-system</p>
        </div>
      </div>
      
      <div className="settings-section">
        <div className="settings-header">
          <div className="settings-title">Valuta & Region</div>
          <div className="settings-description">Standardinställningar för priser och språk</div>
        </div>
        <div className="settings-body">
          <div className="settings-grid">
            <div className="form-group">
              <label className="form-label">Standardvaluta</label>
              <select className="form-input">
                <option>SEK - Svenska kronor</option>
                <option>EUR - Euro</option>
                <option>USD - US Dollar</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Standardspråk för genererad text</label>
              <select className="form-input">
                <option>Svenska</option>
                <option>English</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      
      <div className="settings-section">
        <div className="settings-header">
          <div className="settings-title">AI-inställningar</div>
          <div className="settings-description">Standardinställningar för textgenerering</div>
        </div>
        <div className="settings-body">
          <div className="settings-grid">
            <div className="form-group">
              <label className="form-label">Textstil</label>
              <select className="form-input">
                <option value="sales">Säljande</option>
                <option value="technical">Teknisk</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Textlängd</label>
              <select className="form-input">
                <option value="short">Kort (50-100 ord)</option>
                <option value="medium">Medium (100-200 ord)</option>
                <option value="long">Lång (200-400 ord)</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Publish Modal Component
function PublishModal({ onClose, stores, selectedCount, selectedProductIds, onPublishComplete }) {
  const [selectedStores, setSelectedStores] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState('select'); // 'select' | 'progress' | 'done'
  const [currentProduct, setCurrentProduct] = useState(0);
  const [storeProgress, setStoreProgress] = useState({});
  const [showErrors, setShowErrors] = useState({});

  const toggleStore = (storeId) => {
    if (phase !== 'select') return;
    setSelectedStores(prev =>
      prev.includes(storeId)
        ? prev.filter(id => id !== storeId)
        : [...prev, storeId]
    );
  };

  const handlePublish = async () => {
    if (selectedStores.length === 0 || selectedProductIds.length === 0) return;

    setPublishing(true);
    setError(null);
    setPhase('progress');
    setCurrentProduct(0);

    // Initialize per-store progress
    const initialProgress = {};
    for (const storeId of selectedStores) {
      initialProgress[storeId] = { success: 0, errors: 0, total: selectedProductIds.length, errorDetails: [] };
    }
    setStoreProgress(initialProgress);

    for (let i = 0; i < selectedProductIds.length; i++) {
      setCurrentProduct(i + 1);
      const productId = selectedProductIds[i];

      try {
        const response = await fetch(`http://localhost:3001/api/db/products/${productId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeIds: selectedStores })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const errMsg = data.error || 'Publicering misslyckades';
          setStoreProgress(prev => {
            const updated = {};
            for (const sid of selectedStores) {
              const p = prev[sid];
              updated[sid] = {
                ...p,
                errors: p.errors + 1,
                errorDetails: [...p.errorDetails, { productId, error: errMsg }]
              };
            }
            return updated;
          });
          continue;
        }

        const data = await response.json();

        setStoreProgress(prev => {
          const updated = {};
          for (const sid of selectedStores) {
            updated[sid] = { ...prev[sid] };
          }
          for (const sr of (data.syncResults || [])) {
            if (updated[sr.storeId]) {
              if (sr.success) {
                updated[sr.storeId].success += 1;
              } else {
                updated[sr.storeId].errors += 1;
                updated[sr.storeId].errorDetails = [...updated[sr.storeId].errorDetails, { productId, error: sr.error }];
              }
            }
          }
          return updated;
        });

      } catch (err) {
        setStoreProgress(prev => {
          const updated = {};
          for (const sid of selectedStores) {
            const p = prev[sid];
            updated[sid] = {
              ...p,
              errors: p.errors + 1,
              errorDetails: [...p.errorDetails, { productId, error: err.message }]
            };
          }
          return updated;
        });
      }
    }

    setPublishing(false);
    setPhase('done');
    onPublishComplete?.();
  };

  const handleClose = () => {
    if (publishing) return;
    onClose();
  };

  const totalProducts = selectedProductIds.length;
  const overallPercent = totalProducts > 0 ? Math.round((currentProduct / totalProducts) * 100) : 0;

  const totalSuccess = Object.values(storeProgress).reduce((sum, p) => sum + p.success, 0);
  const totalErrors = Object.values(storeProgress).reduce((sum, p) => sum + p.errors, 0);

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal publish-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {phase === 'select' && 'Publicera till butiker'}
            {phase === 'progress' && 'Synkar produkter...'}
            {phase === 'done' && 'Synkning klar'}
          </div>
          {!publishing && (
            <button className="btn btn-ghost btn-icon-only" onClick={handleClose}>
              <X size={20} />
            </button>
          )}
        </div>

        <div className="modal-body">
          {/* Phase: Select stores */}
          {phase === 'select' && (
            <>
              <p className="modal-description">
                Välj vilka butiker som ska ta emot de <strong>{selectedCount} valda produkterna</strong>
              </p>

              {error && (
                <div className="publish-error-banner">
                  {error}
                </div>
              )}

              <div className="store-select-list">
                {stores.filter(s => s.status === 'connected').map(store => (
                  <div
                    key={store.id}
                    className={`store-select-item ${selectedStores.includes(store.id) ? 'selected' : ''}`}
                    onClick={() => toggleStore(store.id)}
                  >
                    <div className={`checkbox ${selectedStores.includes(store.id) ? 'checked' : ''}`}>
                      {selectedStores.includes(store.id) && <Check size={14} />}
                    </div>
                    <div className="store-select-icon">
                      <Store size={18} />
                    </div>
                    <div className="store-select-info">
                      <div className="store-select-name">{store.name}</div>
                      <div className="store-select-domain">{store.domain}</div>
                    </div>
                  </div>
                ))}

                {stores.filter(s => s.status === 'connected').length === 0 && (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Inga anslutna butiker. Gå till Butiker för att ansluta.
                  </div>
                )}
              </div>
            </>
          )}

          {/* Phase: Progress */}
          {(phase === 'progress' || phase === 'done') && (
            <div className="publish-progress">
              {/* Overall progress */}
              <div className="publish-overall">
                <div className="publish-overall-header">
                  {phase === 'progress' ? (
                    <>
                      <Loader2 size={18} className="spin" />
                      <span>Synkar produkt {currentProduct} av {totalProducts}</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={18} className="publish-done-icon" />
                      <span>{totalProducts} produkter behandlade</span>
                    </>
                  )}
                </div>
                <div className="publish-progress-bar">
                  <div
                    className={`publish-progress-fill ${phase === 'done' ? 'done' : ''}`}
                    style={{ width: `${phase === 'done' ? 100 : overallPercent}%` }}
                  />
                </div>
                {phase === 'done' && (
                  <div className="publish-summary">
                    <span className="publish-summary-success">{totalSuccess} lyckade</span>
                    {totalErrors > 0 && (
                      <span className="publish-summary-errors">{totalErrors} fel</span>
                    )}
                  </div>
                )}
              </div>

              {/* Per-store progress */}
              <div className="publish-stores">
                {selectedStores.map(storeId => {
                  const store = stores.find(s => s.id === storeId);
                  const progress = storeProgress[storeId] || { success: 0, errors: 0, total: totalProducts, errorDetails: [] };
                  const processed = progress.success + progress.errors;
                  const percent = progress.total > 0 ? Math.round((processed / progress.total) * 100) : 0;
                  const hasErrors = progress.errors > 0;
                  const errorsExpanded = showErrors[storeId];

                  return (
                    <div key={storeId} className={`publish-store-item ${hasErrors ? 'has-errors' : ''}`}>
                      <div className="publish-store-header">
                        <div className="publish-store-info">
                          <Store size={16} />
                          <span className="publish-store-name">{store?.name || storeId}</span>
                        </div>
                        <div className="publish-store-stats">
                          {progress.success > 0 && (
                            <span className="publish-stat success">
                              <CheckCircle2 size={13} />
                              {progress.success}
                            </span>
                          )}
                          {progress.errors > 0 && (
                            <span
                              className="publish-stat error clickable"
                              onClick={() => setShowErrors(prev => ({ ...prev, [storeId]: !prev[storeId] }))}
                            >
                              <AlertCircle size={13} />
                              {progress.errors} fel
                            </span>
                          )}
                          <span className="publish-stat-percent">{percent}%</span>
                        </div>
                      </div>
                      <div className="publish-progress-bar small">
                        <div
                          className={`publish-progress-fill ${hasErrors ? 'has-errors' : ''} ${phase === 'done' && !hasErrors ? 'done' : ''}`}
                          style={{ width: `${phase === 'done' ? 100 : percent}%` }}
                        />
                        {hasErrors && (
                          <div
                            className="publish-progress-fill error-fill"
                            style={{ width: `${Math.round((progress.errors / progress.total) * 100)}%` }}
                          />
                        )}
                      </div>
                      {errorsExpanded && progress.errorDetails.length > 0 && (
                        <div className="publish-error-list">
                          {progress.errorDetails.slice(0, 10).map((err, idx) => (
                            <div key={idx} className="publish-error-item">
                              <AlertCircle size={12} />
                              <span>{err.error}</span>
                            </div>
                          ))}
                          {progress.errorDetails.length > 10 && (
                            <div className="publish-error-more">
                              ...och {progress.errorDetails.length - 10} till
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {phase === 'select' && (
            <>
              <button className="btn btn-secondary" onClick={onClose}>Avbryt</button>
              <button
                className="btn btn-primary"
                disabled={selectedStores.length === 0 || publishing}
                onClick={handlePublish}
              >
                <Zap size={16} />
                Publicera till {selectedStores.length} butiker
              </button>
            </>
          )}
          {phase === 'progress' && (
            <button className="btn btn-secondary" disabled>
              <Loader2 size={16} className="spin" />
              Synkar...
            </button>
          )}
          {phase === 'done' && (
            <button className="btn btn-primary" onClick={handleClose}>
              Stäng
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
