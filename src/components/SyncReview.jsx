import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ArrowUpToLine, ArrowDownToLine, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// Human-readable, truncated rendering of a field value (string / array / object).
function renderVal(v) {
  if (v == null || v === '') return <span style={{ opacity: 0.4 }}>—</span>;
  let s;
  if (Array.isArray(v)) s = v.join(', ');
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // strip HTML for preview
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

const STATUS_META = {
  pim_changed:    { label: 'PIM ändrat → pushas',      color: '#3b82f6', Icon: ArrowUpToLine },
  shopify_changed:{ label: 'Shopify ändrat → dras in', color: '#a855f7', Icon: ArrowDownToLine },
  conflict:       { label: 'Konflikt — välj',          color: '#ef4444', Icon: AlertTriangle },
  no_baseline:    { label: 'Ingen baseline — välj',    color: '#f59e0b', Icon: HelpCircle },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status];
  if (!m) return null;
  const { label, color, Icon } = m;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, fontWeight: 600, fontSize: 12 }}>
      <Icon size={12} /> {label}
    </span>
  );
}

export default function SyncReview({ storeId, productId }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [resolutions, setResolutions] = useState({}); // { key: 'pim' | 'shopify' }

  const load = useCallback(async () => {
    if (!storeId || !productId) return;
    setLoading(true); setError(''); setResult(null); setResolutions({});
    try {
      const r = await fetch(`${API_URL}/shopify/stores/${storeId}/products/${productId}/sync-diff`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Kunde inte hämta synk-status');
      setDiff(data);
    } catch (e) {
      setError(e.message);
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, [storeId, productId]);

  useEffect(() => { load(); }, [load]);

  // Rows that differ: scalar/tag fields (status !== in_sync) + metafields.
  const rows = diff
    ? [
        ...diff.fields.filter(f => f.status !== 'in_sync').map(f => ({ key: f.field, label: f.label, ...f })),
        ...diff.metafields.map(m => ({ key: `metafield:${m.key}`, label: m.key, pim: m.pim, shopify: m.shopify, status: m.status })),
      ]
    : [];

  const needsChoice = rows.filter(r => r.status === 'conflict' || r.status === 'no_baseline');
  const unresolvedCount = needsChoice.filter(r => !resolutions[r.key]).length;

  const setResolution = (key, choice) =>
    setResolutions(prev => ({ ...prev, [key]: prev[key] === choice ? undefined : choice }));

  const runSync = async () => {
    setSyncing(true); setError(''); setResult(null);
    try {
      const clean = Object.fromEntries(Object.entries(resolutions).filter(([, v]) => v));
      const r = await fetch(`${API_URL}/shopify/stores/${storeId}/products/${productId}/push-safe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: clean }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Synk misslyckades');
      setResult(data);
      await load(); // refresh the diff after syncing
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary,#888)' }}>
      <RefreshCw size={18} className="spin" /> Hämtar synk-status…
    </div>;
  }

  if (error && !diff) {
    return <div style={{ padding: 16 }}>
      <div className="pricing-flash error" style={{ marginBottom: 12 }}>{error}</div>
      <button className="btn btn-secondary" onClick={load}><RefreshCw size={14} /> Försök igen</button>
    </div>;
  }

  if (!diff) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0 }}>Synk & granskning</h3>
          <div style={{ fontSize: 13, color: 'var(--text-secondary,#888)' }}>
            Jämför PIM mot Shopify. Ändringar pushas fält för fält — Shopify-ändringar skrivs aldrig över utan ditt val.
            {diff.baselineSyncedAt
              ? ` Senaste baseline: ${new Date(diff.baselineSyncedAt).toLocaleString('sv-SE')}.`
              : ' Ingen baseline ännu — skillnader måste bekräftas manuellt första gången.'}
          </div>
        </div>
        <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={load} disabled={syncing}>
          <RefreshCw size={14} /> Uppdatera
        </button>
      </div>

      {result && (
        <div className={`pricing-flash ${result.status === 'conflict' ? 'warning' : 'success'}`} style={{ marginBottom: 12 }}>
          {result.status === 'conflict'
            ? `Synkat delvis — ${result.unresolved.length} olöst(a) konflikt(er) kvarstår och flaggas.`
            : `Synkat: ${result.pushedFields + result.pushedMetafields} fält pushade till Shopify, ${result.pulled} indragna till PIM.`}
        </div>
      )}
      {error && <div className="pricing-flash error" style={{ marginBottom: 12 }}>{error}</div>}

      {rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 0', color: '#22c55e', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          <CheckCircle2 size={22} /> PIM och Shopify är i synk. Inget att göra.
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="margin-table">
              <thead>
                <tr>
                  <th>Fält</th>
                  <th>PIM</th>
                  <th>Shopify</th>
                  <th>Status / val</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const choosable = row.status === 'conflict' || row.status === 'no_baseline';
                  const choice = resolutions[row.key];
                  return (
                    <tr key={row.key}>
                      <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{row.label}</td>
                      <td style={{ maxWidth: 260, background: choice === 'pim' ? 'rgba(59,130,246,0.12)' : undefined }}>{renderVal(row.pim)}</td>
                      <td style={{ maxWidth: 260, background: choice === 'shopify' ? 'rgba(168,85,247,0.12)' : undefined }}>{renderVal(row.shopify)}</td>
                      <td>
                        <StatusBadge status={row.status} />
                        {choosable && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button
                              className={`btn ${choice === 'pim' ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              onClick={() => setResolution(row.key, 'pim')}
                            >Behåll PIM</button>
                            <button
                              className={`btn ${choice === 'shopify' ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              onClick={() => setResolution(row.key, 'shopify')}
                            >Behåll Shopify</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bulk-bar" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary,#888)' }}>
              {diff.counts.pim_changed} pushas · {diff.counts.shopify_changed} dras in · {needsChoice.length} kräver val
              {unresolvedCount > 0 && <span style={{ color: '#ef4444' }}> ({unresolvedCount} ovalda hoppas över)</span>}
            </span>
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={runSync} disabled={syncing}>
              {syncing ? <RefreshCw size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {syncing ? 'Synkar…' : 'Synka säkert'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
