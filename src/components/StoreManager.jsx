import React, { useState, useEffect } from 'react';
import { 
  Store, Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle, 
  ExternalLink, Loader2, X, Link2, Unplug, Settings
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export default function StoreManager({ stores, onStoresChange }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [shopDomain, setShopDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [appStatus, setAppStatus] = useState(null);
  const [connectionMethod, setConnectionMethod] = useState('oauth'); // 'oauth' or 'manual'
  const [manualToken, setManualToken] = useState('');
  const [testingStore, setTestingStore] = useState(null);

  // Check if Shopify App is configured
  useEffect(() => {
    checkAppStatus();
  }, []);

  // Check URL params for OAuth callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const storeConnected = params.get('store_connected');
    const storeName = params.get('name');
    const errorMsg = params.get('error');
    
    if (storeConnected) {
      // Clear URL params
      window.history.replaceState({}, '', window.location.pathname);
      // Pin the connected store as active
      if (storeConnected && !localStorage.getItem('pim_active_store_id')) {
        localStorage.setItem('pim_active_store_id', storeConnected);
      }
      // Refresh stores list
      onStoresChange?.();
    }
    
    if (errorMsg) {
      setError(decodeURIComponent(errorMsg));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const checkAppStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/shopify/app-status`);
      const data = await res.json();
      setAppStatus(data);
      
      // If OAuth not configured, default to manual
      if (!data.configured) {
        setConnectionMethod('manual');
      }
    } catch (err) {
      console.error('Failed to check app status:', err);
    }
  };

  const handleConnect = async () => {
    if (!shopDomain.trim()) {
      setError('Ange butiksdomän');
      return;
    }

    const normalizedShop = shopDomain.trim().replace('.myshopify.com', '') + '.myshopify.com';

    setLoading(true);
    setError(null);

    try {
      if (connectionMethod === 'oauth') {
        // OAuth flow - redirect to Shopify
        const res = await fetch(`${API_URL}/shopify/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shop: normalizedShop })
        });
        
        const data = await res.json();
        
        if (data.error) {
          throw new Error(data.error);
        }
        
        // Redirect to Shopify OAuth
        window.location.href = data.installUrl;
      } else {
        // Manual connection with access token
        if (!manualToken.trim()) {
          throw new Error('Access token krävs för manuell anslutning');
        }
        
        const res = await fetch(`${API_URL}/db/stores/connect-manual`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shop: normalizedShop,
            accessToken: manualToken
          })
        });
        
        const data = await res.json();
        
        if (data.error) {
          throw new Error(data.error);
        }

        // Pin as active store so the fetch interceptor sends x-store-id
        if (data.store?.id) {
          localStorage.setItem('pim_active_store_id', data.store.id);
        }

        // Success - close modal and refresh
        setShowAddModal(false);
        setShopDomain('');
        setManualToken('');
        onStoresChange?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (store) => {
    if (!confirm(`Ta bort ${store.name}? Detta tar bort butiken från PIM men påverkar inte din Shopify-butik.`)) {
      return;
    }
    
    try {
      const res = await fetch(`${API_URL}/db/stores/${store.id}`, {
        method: 'DELETE'
      });
      
      if (!res.ok) throw new Error('Kunde inte ta bort butik');
      
      onStoresChange?.();
    } catch (err) {
      alert('Fel: ' + err.message);
    }
  };

  const handleTest = async (store) => {
    setTestingStore(store.id);
    
    try {
      const res = await fetch(`${API_URL}/db/stores/${store.id}/test`, {
        method: 'POST'
      });
      
      const data = await res.json();
      
      if (data.success) {
        alert(`✅ Anslutning OK!\n\nButik: ${data.shop.name}\nPlan: ${data.shop.plan_name}`);
      } else {
        alert(`❌ Anslutningsfel: ${data.error}`);
      }
      
      onStoresChange?.();
    } catch (err) {
      alert('Fel: ' + err.message);
    } finally {
      setTestingStore(null);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'connected': return 'var(--success)';
      case 'error': return 'var(--error)';
      case 'disconnected': return 'var(--text-tertiary)';
      default: return 'var(--warning)';
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'connected': return 'Ansluten';
      case 'error': return 'Fel';
      case 'disconnected': return 'Frånkopplad';
      default: return 'Väntar';
    }
  };

  return (
    <div className="store-manager">
      <div className="store-manager-header">
        <h2>Butiker</h2>
        <button 
          className="btn btn-primary"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={18} />
          Anslut butik
        </button>
      </div>

      {stores.length === 0 ? (
        <div className="empty-state">
          <Store size={48} />
          <h3>Inga butiker anslutna</h3>
          <p>Anslut din första Shopify-butik för att börja synka produkter</p>
          <button 
            className="btn btn-primary"
            onClick={() => setShowAddModal(true)}
          >
            <Plus size={18} />
            Anslut butik
          </button>
        </div>
      ) : (
        <div className="stores-grid">
          {stores.map(store => (
            <div key={store.id} className="store-card">
              <div className="store-card-header">
                <div className="store-icon">
                  <Store size={24} />
                </div>
                <div className="store-info">
                  <h3>{store.name}</h3>
                  <span className="store-domain">{store.customDomain || store.domain}</span>
                </div>
                <div 
                  className="store-status"
                  style={{ color: getStatusColor(store.status) }}
                >
                  {store.status === 'connected' ? (
                    <CheckCircle2 size={18} />
                  ) : store.status === 'error' ? (
                    <AlertCircle size={18} />
                  ) : (
                    <Unplug size={18} />
                  )}
                  <span>{getStatusText(store.status)}</span>
                </div>
              </div>
              
              <div className="store-card-details">
                <div className="detail-row">
                  <span className="detail-label">Land</span>
                  <span className="detail-value">{store.countryCode}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Valuta</span>
                  <span className="detail-value">{store.currency}</span>
                </div>
                {store.lastSyncAt && (
                  <div className="detail-row">
                    <span className="detail-label">Senast synkad</span>
                    <span className="detail-value">
                      {new Date(store.lastSyncAt).toLocaleString('sv-SE')}
                    </span>
                  </div>
                )}
              </div>
              
              <div className="store-card-actions">
                <button 
                  className="btn btn-small"
                  onClick={() => handleTest(store)}
                  disabled={testingStore === store.id}
                >
                  {testingStore === store.id ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Testa
                </button>
                <a 
                  href={`https://${store.domain}/admin`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-small"
                >
                  <ExternalLink size={14} />
                  Öppna
                </a>
                <button 
                  className="btn btn-small btn-danger"
                  onClick={() => handleDelete(store)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Store Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Anslut Shopify-butik</h3>
              <button className="btn-icon" onClick={() => setShowAddModal(false)}>
                <X size={20} />
              </button>
            </div>
            
            <div className="modal-body">
              {error && (
                <div className="alert alert-error">
                  <AlertCircle size={18} />
                  {error}
                </div>
              )}

              {/* Connection method tabs */}
              <div className="connection-tabs">
                {appStatus?.configured && (
                  <button 
                    className={`tab ${connectionMethod === 'oauth' ? 'active' : ''}`}
                    onClick={() => setConnectionMethod('oauth')}
                  >
                    <Link2 size={16} />
                    OAuth (Rekommenderat)
                  </button>
                )}
                <button 
                  className={`tab ${connectionMethod === 'manual' ? 'active' : ''}`}
                  onClick={() => setConnectionMethod('manual')}
                >
                  <Settings size={16} />
                  Manuell (Access Token)
                </button>
              </div>

              <div className="form-group">
                <label>Butiksdomän</label>
                <div className="input-with-suffix">
                  <input
                    type="text"
                    placeholder="dinbutik"
                    value={shopDomain.replace('.myshopify.com', '')}
                    onChange={(e) => setShopDomain(e.target.value.replace('.myshopify.com', ''))}
                  />
                  <span className="input-suffix">.myshopify.com</span>
                </div>
                <span className="form-help">
                  T.ex. "min-butik" för min-butik.myshopify.com
                </span>
              </div>

              {connectionMethod === 'manual' && (
                <div className="form-group">
                  <label>Admin API Access Token</label>
                  <input
                    type="password"
                    placeholder="shpat_xxxxxxxxxxxxx"
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                  />
                  <span className="form-help">
                    Skapa en Custom App i Shopify Admin → Settings → Apps → Develop apps
                  </span>
                </div>
              )}

              {connectionMethod === 'oauth' && (
                <div className="oauth-info">
                  <p>
                    Du kommer att skickas till Shopify för att godkänna anslutningen. 
                    Efter godkännande kommer du tillbaka hit automatiskt.
                  </p>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={() => setShowAddModal(false)}
              >
                Avbryt
              </button>
              <button 
                className="btn btn-primary"
                onClick={handleConnect}
                disabled={loading || !shopDomain.trim()}
              >
                {loading ? (
                  <>
                    <Loader2 size={18} className="spin" />
                    Ansluter...
                  </>
                ) : connectionMethod === 'oauth' ? (
                  <>
                    <ExternalLink size={18} />
                    Fortsätt till Shopify
                  </>
                ) : (
                  <>
                    <Link2 size={18} />
                    Anslut
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .store-manager {
          padding: 24px;
        }
        
        .store-manager-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
        }
        
        .store-manager-header h2 {
          font-size: 24px;
          font-weight: 600;
        }
        
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 60px 20px;
          text-align: center;
          color: var(--text-secondary);
        }
        
        .empty-state svg {
          margin-bottom: 16px;
          opacity: 0.5;
        }
        
        .empty-state h3 {
          font-size: 18px;
          margin-bottom: 8px;
          color: var(--text-primary);
        }
        
        .empty-state p {
          margin-bottom: 24px;
        }
        
        .stores-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 20px;
        }
        
        .store-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 20px;
        }
        
        .store-card-header {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .store-icon {
          width: 48px;
          height: 48px;
          background: var(--accent-dim);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
        }
        
        .store-info {
          flex: 1;
        }
        
        .store-info h3 {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 2px;
        }
        
        .store-domain {
          font-size: 13px;
          color: var(--text-secondary);
        }
        
        .store-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
        }
        
        .store-card-details {
          padding: 12px 0;
          border-top: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          margin-bottom: 16px;
        }
        
        .detail-row {
          display: flex;
          justify-content: space-between;
          padding: 4px 0;
        }
        
        .detail-label {
          color: var(--text-secondary);
          font-size: 13px;
        }
        
        .detail-value {
          font-size: 13px;
          font-weight: 500;
        }
        
        .store-card-actions {
          display: flex;
          gap: 8px;
        }
        
        .btn-small {
          padding: 6px 12px;
          font-size: 13px;
        }
        
        .btn-danger {
          color: var(--error);
        }
        
        .btn-danger:hover {
          background: rgba(239, 68, 68, 0.1);
        }
        
        /* Modal styles */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        
        .modal {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
          width: 100%;
          max-width: 480px;
          max-height: 90vh;
          overflow: hidden;
        }
        
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
        }
        
        .modal-header h3 {
          font-size: 18px;
          font-weight: 600;
        }
        
        .modal-body {
          padding: 24px;
        }
        
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 24px;
          border-top: 1px solid var(--border);
        }
        
        .connection-tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 20px;
        }
        
        .tab {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }
        
        .tab:hover {
          border-color: var(--border-light);
        }
        
        .tab.active {
          background: var(--accent-dim);
          border-color: var(--accent);
          color: var(--accent);
        }
        
        .form-group {
          margin-bottom: 20px;
        }
        
        .form-group label {
          display: block;
          font-size: 14px;
          font-weight: 500;
          margin-bottom: 8px;
        }
        
        .form-group input {
          width: 100%;
          padding: 12px 14px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text-primary);
          font-size: 14px;
        }
        
        .form-group input:focus {
          outline: none;
          border-color: var(--accent);
        }
        
        .input-with-suffix {
          display: flex;
          align-items: stretch;
        }
        
        .input-with-suffix input {
          border-radius: 8px 0 0 8px;
          border-right: none;
        }
        
        .input-suffix {
          display: flex;
          align-items: center;
          padding: 0 14px;
          background: var(--surface-hover);
          border: 1px solid var(--border);
          border-left: none;
          border-radius: 0 8px 8px 0;
          color: var(--text-secondary);
          font-size: 14px;
        }
        
        .form-help {
          display: block;
          margin-top: 6px;
          font-size: 12px;
          color: var(--text-tertiary);
        }
        
        .alert {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          border-radius: 8px;
          margin-bottom: 20px;
          font-size: 14px;
        }
        
        .alert-error {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: var(--error);
        }
        
        .oauth-info {
          padding: 16px;
          background: var(--bg-secondary);
          border-radius: 8px;
          font-size: 14px;
          color: var(--text-secondary);
          line-height: 1.6;
        }
        
        .btn-icon {
          background: none;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          padding: 4px;
        }
        
        .btn-icon:hover {
          color: var(--text-primary);
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  );
}
