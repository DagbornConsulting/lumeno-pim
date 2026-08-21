import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, ExternalLink, ShoppingCart, ChevronDown, ChevronRight } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const SEV = {
  disapproved: { label: 'Underkänd', color: '#ef4444' },
  demoted: { label: 'Nedgraderad', color: '#f59e0b' },
  unaffected: { label: 'Info', color: '#3b82f6' },
};

export default function MerchantIssues() {
  const [status, setStatus] = useState(null);
  const [mid, setMid] = useState('');
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openCode, setOpenCode] = useState(null);

  const loadStatus = useCallback(async () => {
    const r = await fetch(`${API_URL}/seo/status`);
    const s = await r.json();
    setStatus(s);
    setMid(s.merchantId || '');
    return s;
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      await fetch(`${API_URL}/seo/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId: mid.trim() }),
      });
      await loadStatus();
      await loadIssues();
    } finally { setSaving(false); }
  };

  const loadIssues = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_URL}/seo/merchant/issues`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Fel');
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  if (status && !status.credentials) {
    return (
      <div className="settings-section" style={{ borderLeft: '3px solid #f59e0b' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={18} color="#f59e0b" /> Google service-account saknas</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Merchant Center använder samma service-account som SEO. Sätt <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> på servern först.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Config */}
      <div className="settings-section" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <ShoppingCart size={16} /> <strong>Merchant Center</strong>
          {status?.serviceAccountEmail && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
              Ge <code>{status.serviceAccountEmail}</code> åtkomst i Merchant Center (Inställningar → Användare)
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Merchant Center account-id</label>
            <input className="form-input" placeholder="t.ex. 5123456789" value={mid} onChange={e => setMid(e.target.value)} style={{ width: 220 }} />
          </div>
          <button className="btn btn-primary" onClick={saveConfig} disabled={saving || !mid.trim()}>{saving ? 'Sparar…' : 'Spara & hämta'}</button>
          {status?.merchantId && <button className="btn btn-ghost" onClick={loadIssues} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Hämta fel</button>}
        </div>
      </div>

      {error && <div className="settings-section" style={{ borderLeft: '3px solid #ef4444' }}><span style={{ color: '#ef4444', fontSize: 13 }}>{error}</span></div>}

      {loading && <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Hämtar feed-status…</div>}

      {data && (
        <>
          {/* Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[
              ['Produkter i feed', data.products.total, 'inherit'],
              ['Med problem', data.products.withIssues, data.products.withIssues ? '#f59e0b' : '#22c55e'],
              ['Underkända', data.products.disapproved, data.products.disapproved ? '#ef4444' : '#22c55e'],
            ].map(([l, v, c]) => (
              <div key={l} className="settings-section" style={{ padding: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{l}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Account-level issues */}
          {data.account?.accountLevelIssues?.length > 0 && (
            <div className="settings-section" style={{ marginBottom: 16, borderLeft: '3px solid #ef4444' }}>
              <h3 style={{ marginBottom: 8 }}>Kontonivå-problem</h3>
              {data.account.accountLevelIssues.map((i, ix) => (
                <div key={ix} style={{ fontSize: 13, marginBottom: 6 }}>
                  <strong>{i.title}</strong> {i.country ? `(${i.country})` : ''} — <span style={{ color: 'var(--text-secondary)' }}>{i.detail}</span>
                  {i.documentation && <> · <a href={i.documentation} target="_blank" rel="noreferrer">åtgärd <ExternalLink size={11} /></a></>}
                </div>
              ))}
            </div>
          )}

          {/* Product issues grouped */}
          {data.products.byIssue.length === 0 ? (
            <div className="settings-section" style={{ textAlign: 'center', padding: 32 }}>
              <CheckCircle2 size={32} color="#22c55e" /><p style={{ marginTop: 8 }}>Inga produktfel i feeden. 🎉</p>
            </div>
          ) : (
            <div className="settings-section">
              <h3 style={{ marginBottom: 12 }}>Produktfel att åtgärda ({data.products.byIssue.length} typer)</h3>
              {data.products.byIssue.map((g) => {
                const sev = SEV[g.servability] || SEV.unaffected;
                const isOpen = openCode === g.code;
                return (
                  <div key={g.code} style={{ borderTop: '1px solid var(--border, #333)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setOpenCode(isOpen ? null : g.code)}>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: sev.color, color: '#fff' }}>{sev.label}</span>
                      <strong style={{ fontSize: 14 }}>{g.description || g.code}</strong>
                      {g.attributeName && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>[{g.attributeName}]</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-secondary)' }}>{g.count} produkter</span>
                    </div>
                    {isOpen && (
                      <div style={{ paddingLeft: 26, marginTop: 8 }}>
                        {g.resolution && <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Åtgärd: {g.resolution === 'merchant_action' ? 'Fixas av dig (i PIM/Shopify)' : g.resolution}</p>}
                        {g.documentation && <p style={{ fontSize: 12, marginBottom: 6 }}><a href={g.documentation} target="_blank" rel="noreferrer">Googles guide <ExternalLink size={11} /></a></p>}
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Exempelprodukter:</div>
                        <ul style={{ fontSize: 12, margin: '4px 0 0 16px' }}>
                          {g.samples.map((s, si) => (
                            <li key={si}>{s.link ? <a href={s.link} target="_blank" rel="noreferrer">{s.title || s.productId}</a> : (s.title || s.productId)}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
