import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard, Scale, TrendingDown, AlertTriangle, CheckCircle2, RefreshCw,
  ArrowRight, Package, PackagePlus, Link2, Activity, Search, FolderInput, Zap,
} from 'lucide-react';
import './Dashboard.css';
import './PriceWatch.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const kr = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`);
const pct = v => (v == null ? '–' : `${Math.round(Number(v) * 100)} %`);
const ago = (v) => {
  if (!v) return 'aldrig';
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 2) return 'nyss';
  if (m < 60) return `${m} min sedan`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} tim sedan`;
  return `${Math.round(h / 24)} dagar sedan`;
};

const HEALTH = [
  { key: 'noImages', label: 'Saknar bild', tone: '#b83a3a' },
  { key: 'missingDescription', label: 'Saknar / kort beskrivning', tone: '#c98a16' },
  { key: 'missingCategory', label: 'Saknar Shopify-kategori', tone: '#c98a16' },
  { key: 'thinAttributes', label: 'Saknar attribut', tone: '#c98a16' },
  { key: 'missingSeoTitle', label: 'Saknar SEO-titel', tone: '#2a6fb0' },
  { key: 'missingSeoDescription', label: 'Saknar SEO-beskrivning', tone: '#2a6fb0' },
];

const CONNECTIONS = [
  { key: 'shopify', label: 'Shopify' },
  { key: 'googleServiceAccount', label: 'Google service-konto' },
  { key: 'merchantCenter', label: 'Merchant Center' },
  { key: 'searchConsole', label: 'Search Console', optional: true },
  { key: 'ga4', label: 'GA4', optional: true },
  { key: 'cronSecret', label: 'Nattjobb (CRON_SECRET)' },
  { key: 'anthropic', label: 'Claude AI', optional: true },
];

function Card({ title, icon: Icon, span = 4, linkLabel, onLink, children }) {
  return (
    <div className={`dash-card dash-span-${span}`}>
      <div className="dash-card-head">
        {Icon && <Icon size={15} />} {title}
        <span className="spacer" />
        {onLink && <button className="dash-link" onClick={onLink}>{linkLabel || 'Öppna'} <ArrowRight size={12} /></button>}
      </div>
      {children}
    </div>
  );
}

function Tile({ value, label, sub, tone = 'grey', icon: Icon, onClick }) {
  return (
    <div className={`dash-card dash-tile dash-span-3 tone-${tone}`} onClick={onClick}>
      <div className="dash-tile-label">{Icon && <Icon size={13} />} {label}</div>
      <div className={`dash-tile-value ${value ? `tone-${tone}` : ''}`}>{value ?? '–'}</div>
      {sub && <div className="dash-tile-sub">{sub}</div>}
    </div>
  );
}

export default function Dashboard({ onNavigate, onOpenProduct }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_URL}/dashboard`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte läsa översikten');
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pw = data?.priceWatch || {};
  const open = pw.open || {};
  const openTotal = (open['RÖD'] || 0) + (open['BLÅ'] || 0) + (open['GUL'] || 0);
  const health = data?.catalogue?.health?.buckets;
  const active = data?.catalogue?.active || 0;
  const healthTotal = data?.catalogue?.health?.totalProducts || active; // health is computed over the whole catalogue (incl. drafts)
  const gaps = health ? (health.noImages?.count || 0) + (health.missingDescription?.count || 0) : null;
  const conn = data?.connections || {};
  const missingConn = CONNECTIONS.filter(c => !c.optional && !conn[c.key]).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><LayoutDashboard size={22} /> Översikt</h1>
          <div className="pw-sub" style={{ marginTop: 4 }}>
            {data?.store?.domain ? `${data.store.domain} · ` : ''}Det som behöver koll just nu. Ingen automatik – allt här är läsning och förslag.
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Uppdatera</button>
        </div>
      </div>

      {error && <div className="settings-section pw-error" style={{ padding: 12, fontSize: 13, color: '#b83a3a' }}>{error}</div>}
      {loading && !data && <div className="pw-empty">Laddar översikt…</div>}

      {data && (
        <div className="dash-grid">
          {/* Attention tiles */}
          <Tile icon={Scale} label="Prisvarningar att granska" value={openTotal}
            sub={`${open['RÖD'] || 0} röda · ${open['BLÅ'] || 0} blå · ${open['GUL'] || 0} gula`}
            tone={open['RÖD'] ? 'red' : openTotal ? 'amber' : 'green'} onClick={() => onNavigate('price-watch')} />
          <Tile icon={TrendingDown} label="Säljs under golvpris" value={pw.underFloor?.length ?? 0}
            sub="pris under inköp + avgift + moms + marginal" tone={pw.underFloor?.length ? 'red' : 'green'} onClick={() => onNavigate('price-watch')} />
          <Tile icon={PackagePlus} label="Nya produkter att granska" value={data.catalogue?.staged ?? 0}
            sub="importerade från Shopify/leverantör, ej i katalogen" tone={data.catalogue?.staged ? 'amber' : 'green'} onClick={() => onNavigate('staging')} />
          <Tile icon={Zap} label="Katalogluckor" value={gaps}
            sub={`utan bild eller beskrivning, av ${healthTotal} produkter`} tone={gaps ? 'amber' : 'green'} onClick={() => onNavigate('seo')} />

          {/* Price comparison */}
          <Card title="Prisjämförelse mot marknaden" icon={Scale} span={8} linkLabel="Öppna prisbevakning" onLink={() => onNavigate('price-watch')}>
            {pw.error ? <div className="dash-empty"><AlertTriangle size={14} /> {pw.error}</div> : (
              <>
                <div className="dash-stats">
                  <span><b>{pw.total || 0}</b> produkter med benchmark</span>
                  {['RÖD', 'BLÅ', 'GUL', 'OK'].map(s => <span key={s}><i className={`pw-dot pw-${s}`} /> <b>{pw.byStatus?.[s] || 0}</b> {s.toLowerCase()}</span>)}
                  <span>· hämtat {ago(pw.lastFetched)}</span>
                  {pw.unmatched > 0 && <span style={{ color: '#c98a16' }}><AlertTriangle size={12} /> {pw.unmatched} saknar PIM-produkt (inget golvpris)</span>}
                </div>
                {pw.topOpen?.length ? (
                  <ul className="dash-list">
                    {pw.topOpen.map(r => (
                      <li key={r.id} className={r.product_id ? 'clickable' : ''} onClick={() => r.product_id && onOpenProduct?.(r.product_id)}>
                        <span className={`pw-badge pw-${r.price_status}`}>{r.price_status}</span>
                        <span className="grow"><span className="title">{r.title || r.offer_id}</span><span className="sub">{r.sku}{r.pack_qty > 1 ? ` · ${r.pack_qty}-pack` : ''}</span></span>
                        <span className="num">{kr(r.our_price)} <span className="sub">vs {kr(r.benchmark_price)}</span></span>
                        <span className={`num ${r.price_index > 1 ? 'pw-index-up' : 'pw-index-down'}`} style={{ width: 52 }}>{Number(r.price_index).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="dash-empty"><CheckCircle2 size={14} color="#2f8f55" /> {pw.total ? 'Inga okvitterade varningar.' : 'Ingen data hämtad ännu – öppna Prisbevakning och klicka "Hämta från Merchant Center".'}</div>
                )}
              </>
            )}
          </Card>

          {/* Under floor */}
          <Card title="Under golvpris" icon={TrendingDown} span={4} linkLabel="Visa alla" onLink={() => onNavigate('price-watch')}>
            {pw.underFloor?.length ? (
              <ul className="dash-list">
                {pw.underFloor.slice(0, 6).map(r => (
                  <li key={r.id} className={r.product_id ? 'clickable' : ''} onClick={() => r.product_id && onOpenProduct?.(r.product_id)}>
                    <span className="grow"><span className="title">{r.title || r.sku}</span><span className="sub">{r.sku}{r.pack_qty > 1 ? ` · ${r.pack_qty}-pack` : ''}</span></span>
                    <span className="num" style={{ color: '#b83a3a' }}>{kr(r.our_price)}<br /><span className="sub">golv {kr(r.floor_price)}</span></span>
                  </li>
                ))}
              </ul>
            ) : <div className="dash-empty"><CheckCircle2 size={14} color="#2f8f55" /> Inga produkter under golvpris.</div>}
          </Card>

          {/* Catalogue health */}
          <Card title="Kataloghälsa" icon={Search} span={6} linkLabel="SEO & Insikter" onLink={() => onNavigate('seo')}>
            <div className="dash-stats">
              <span><b>{active}</b> aktiva</span>
              <span><b>{data.catalogue?.draft ?? 0}</b> utkast</span>
              <span><b>{data.catalogue?.staged ?? 0}</b> i staging</span>
            </div>
            {health ? HEALTH.map(h => {
              const n = health[h.key]?.count || 0;
              const w = healthTotal ? Math.min(100, Math.round((n / healthTotal) * 100)) : 0;
              return (
                <div key={h.key} className="dash-bar" onClick={() => onNavigate('seo')}>
                  <span className="lbl">{h.label}</span>
                  <span className="track"><span className="fill" style={{ width: `${w}%`, background: h.tone }} /></span>
                  <span className="val">{n} <span className="sub">({w} %)</span></span>
                </div>
              );
            }) : <div className="dash-empty">{data.catalogue?.health?.error || 'Ingen data'}</div>}
          </Card>

          {/* Sync + connections */}
          <Card title="Kopplingar & synk" icon={Link2} span={3}>
            <div className="dash-conn" style={{ gridTemplateColumns: '1fr' }}>
              {CONNECTIONS.map(c => (
                <span key={c.key}><i className={`dot ${conn[c.key] ? 'ok' : c.optional ? 'off' : 'missing'}`} /> {c.label}{!conn[c.key] && c.optional ? <span className="sub"> (ej kopplad)</span> : ''}</span>
              ))}
            </div>
            <div className="dash-stats" style={{ marginTop: 12, marginBottom: 0 }}>
              <span style={{ color: data.sync?.errors ? '#b83a3a' : 'inherit' }}><b>{data.sync?.errors ?? '–'}</b> synkfel</span>
              <span><b>{data.sync?.queued ?? '–'}</b> i kö</span>
            </div>
            {missingConn > 0 && <div className="dash-empty" style={{ paddingBottom: 0 }}><AlertTriangle size={13} color="#c98a16" /> {missingConn} koppling{missingConn > 1 ? 'ar' : ''} saknas</div>}
          </Card>

          {/* Activity */}
          <Card title="Senaste händelser" icon={Activity} span={3}>
            {data.activity?.length ? (
              <ul className="dash-list">
                {data.activity.map((a, i) => (
                  <li key={i}>
                    <span className="grow"><span className="title">{a.description || a.action}</span><span className="sub">{ago(a.created_at)}</span></span>
                  </li>
                ))}
              </ul>
            ) : <div className="dash-empty">Inga händelser loggade ännu. Kvitteringar och importer hamnar här.</div>}
          </Card>

          {/* Shortcuts */}
          <Card title="Genvägar" icon={Package} span={12}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('products')}><Package size={14} /> Alla produkter</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('staging')}><PackagePlus size={14} /> Nya produkter</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('import')}><FolderInput size={14} /> Importera produkter</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('price-watch')}><Scale size={14} /> Prisbevakning</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('margin')}><TrendingDown size={14} /> Marginal & Vinst</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('seo')}><Search size={14} /> SEO & Insikter</button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
