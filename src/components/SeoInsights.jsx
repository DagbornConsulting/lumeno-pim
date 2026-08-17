import { useState, useEffect, useCallback } from 'react';
import { Search, TrendingUp, RefreshCw, CheckCircle2, AlertTriangle, Copy, ExternalLink } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const pct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('sv-SE'));
const pos = (n) => (n == null ? '—' : Number(n).toFixed(1));
const dur = (s) => (s == null ? '—' : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

export default function SeoInsights() {
  const [status, setStatus] = useState(null);
  const [days, setDays] = useState(28);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ga4, setGa4] = useState(null);
  const [queries, setQueries] = useState([]);
  const [pages, setPages] = useState([]);
  const [siteInput, setSiteInput] = useState('');
  const [propInput, setPropInput] = useState('');
  const [sites, setSites] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    const r = await fetch(`${API_URL}/seo/status`);
    const s = await r.json();
    setStatus(s);
    setSiteInput(s.gscSiteUrl || '');
    setPropInput(s.ga4PropertyId || '');
    return s;
  }, []);

  const loadData = useCallback(async (s) => {
    setError(null);
    const cfg = s || status;
    if (!cfg?.credentials) { setLoading(false); return; }
    setLoading(true);
    try {
      const jobs = [];
      if (cfg.ga4PropertyId) jobs.push(fetch(`${API_URL}/seo/ga4/summary?days=${days}`).then(r => r.json()).then(d => setGa4(d.metrics || null)).catch(() => {}));
      if (cfg.gscSiteUrl) {
        jobs.push(fetch(`${API_URL}/seo/gsc/queries?days=${days}&limit=100`).then(r => r.json()).then(d => setQueries(d.rows || [])).catch(() => {}));
        jobs.push(fetch(`${API_URL}/seo/gsc/pages?days=${days}&limit=100`).then(r => r.json()).then(d => setPages(d.rows || [])).catch(() => {}));
      }
      await Promise.all(jobs);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [days, status]);

  useEffect(() => { loadStatus().then(s => loadData(s)); }, []); // eslint-disable-line
  useEffect(() => { if (status?.credentials) loadData(); }, [days]); // eslint-disable-line

  const saveConfig = async () => {
    setSaving(true);
    try {
      await fetch(`${API_URL}/seo/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gscSiteUrl: siteInput.trim(), ga4PropertyId: propInput.trim() }),
      });
      const s = await loadStatus();
      await loadData(s);
    } finally { setSaving(false); }
  };

  const listSites = async () => {
    try {
      const r = await fetch(`${API_URL}/seo/gsc/sites`);
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setSites(d.sites || []);
    } catch (e) { setError(e.message); }
  };

  const copy = (t) => navigator.clipboard?.writeText(t);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div className="content-header">
        <div>
          <h1 className="content-title">SEO & Insikter</h1>
          <p className="content-subtitle">Search Console + GA4 — se vad som presterar, vad som ska optimeras och vilka artiklar som bör skapas.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="form-input" value={days} onChange={e => setDays(Number(e.target.value))} style={{ width: 130 }}>
            <option value={7}>7 dagar</option>
            <option value={28}>28 dagar</option>
            <option value={90}>90 dagar</option>
            <option value={180}>180 dagar</option>
          </select>
          <button className="btn btn-ghost" onClick={() => loadData()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} /> Uppdatera
          </button>
        </div>
      </div>

      {/* Connection / setup */}
      {status && !status.credentials && (
        <div className="settings-section" style={{ borderLeft: '3px solid #f59e0b' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <AlertTriangle size={18} color="#f59e0b" /> Google service-account saknas
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Lägg upp ett service-account i Google Cloud och sätt <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> som miljövariabel på servern. Se instruktionerna i din setup-guide.
          </p>
        </div>
      )}

      {status?.credentials && (
        <div className="settings-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <CheckCircle2 size={18} color="#22c55e" />
            <strong>Google anslutet</strong>
            {status.serviceAccountEmail && (
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {status.serviceAccountEmail}
                <button className="btn btn-ghost" style={{ padding: 2 }} title="Kopiera — ge detta konto åtkomst i GSC + GA4" onClick={() => copy(status.serviceAccountEmail)}><Copy size={12} /></button>
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>GSC-webbadress</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" placeholder="https://lumeno.se/ eller sc-domain:lumeno.se" value={siteInput} onChange={e => setSiteInput(e.target.value)} />
                <button className="btn btn-secondary" onClick={listSites} title="Lista tillgängliga siter">Lista</button>
              </div>
              {sites && (
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  {sites.length === 0 ? <span style={{ color: '#f59e0b' }}>Inga siter — lägg till service-account-mejlen som användare i Search Console.</span>
                    : sites.map(s => (
                      <div key={s.siteUrl} style={{ cursor: 'pointer', padding: '2px 0' }} onClick={() => setSiteInput(s.siteUrl)}>
                        <code>{s.siteUrl}</code> <span style={{ color: 'var(--text-secondary)' }}>({s.permissionLevel})</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>GA4 property-id</label>
              <input className="form-input" placeholder="t.ex. 312345678" value={propInput} onChange={e => setPropInput(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveConfig} disabled={saving}>{saving ? 'Sparar…' : 'Spara & hämta'}</button>
          </div>
        </div>
      )}

      {error && (
        <div className="settings-section" style={{ borderLeft: '3px solid #ef4444' }}>
          <span style={{ color: '#ef4444', fontSize: 13 }}>{error}</span>
        </div>
      )}

      {/* GA4 summary */}
      {status?.credentials && status.ga4PropertyId && ga4 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            ['Sessioner', num(ga4.sessions)],
            ['Användare', num(ga4.totalUsers)],
            ['Sidvisningar', num(ga4.screenPageViews)],
            ['Konverteringar', num(ga4.conversions)],
            ['Snittlängd', dur(ga4.averageSessionDuration)],
            ['Avvisning', pct(ga4.bounceRate)],
          ].map(([label, val]) => (
            <div key={label} className="settings-section" style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* GSC queries */}
      {status?.credentials && status.gscSiteUrl && (
        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><Search size={16} /> Toppfrågor (Search Console)</h3>
          {queries.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Ingen data ännu.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="margin-table">
                <thead><tr><th>Sökfråga</th><th className="num">Klick</th><th className="num">Visningar</th><th className="num">CTR</th><th className="num">Position</th></tr></thead>
                <tbody>
                  {queries.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.query}</td>
                      <td className="num">{num(r.clicks)}</td>
                      <td className="num">{num(r.impressions)}</td>
                      <td className="num">{pct(r.ctr)}</td>
                      <td className="num">{pos(r.position)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* GSC pages */}
      {status?.credentials && status.gscSiteUrl && pages.length > 0 && (
        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><TrendingUp size={16} /> Toppsidor</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="margin-table">
              <thead><tr><th>Sida</th><th className="num">Klick</th><th className="num">Visningar</th><th className="num">CTR</th><th className="num">Position</th></tr></thead>
              <tbody>
                {pages.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <a href={r.page} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {r.page?.replace(/^https?:\/\/[^/]+/, '')} <ExternalLink size={11} />
                      </a>
                    </td>
                    <td className="num">{num(r.clicks)}</td>
                    <td className="num">{num(r.impressions)}</td>
                    <td className="num">{pct(r.ctr)}</td>
                    <td className="num">{pos(r.position)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
