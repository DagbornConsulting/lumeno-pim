import { useState, useEffect, useCallback, useRef } from 'react';
import {
  LayoutDashboard, Scale, TrendingDown, AlertTriangle, CheckCircle2, RefreshCw,
  ArrowRight, Package, PackagePlus, Link2, Activity, Search, FolderInput, Zap,
  ShoppingBag, Globe, Upload, Truck, Loader2,
} from 'lucide-react';
import './Dashboard.css';
import './PriceWatch.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const kr = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`);
const n = v => (v == null ? '–' : Number(v).toLocaleString('sv-SE'));
const ago = (v) => {
  if (!v) return 'aldrig';
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 2) return 'nyss';
  if (m < 60) return `${m} min sedan`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} tim sedan`;
  return `${Math.round(h / 24)} dagar sedan`;
};
// Change vs previous period, as a coloured "+12 %" / "−4 %".
const Delta = ({ cur, prev }) => {
  if (!prev) return <span className="sub">—</span>;
  const d = (cur - prev) / prev;
  const col = d > 0.02 ? '#2f8f55' : d < -0.02 ? '#b83a3a' : 'inherit';
  return <span style={{ color: col, fontSize: 12 }}>{d >= 0 ? '+' : '−'}{Math.abs(Math.round(d * 100))} %</span>;
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

// Small fetch hook for the lazily loaded cards (external APIs).
function useLazy(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const load = useCallback(async (refresh = false) => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch(`${API_URL}${path}${refresh ? (path.includes('?') ? '&' : '?') + 'refresh=1' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Fel');
      setState({ loading: false, data: d, error: null });
    } catch (e) { setState({ loading: false, data: null, error: e.message }); }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return [state, load];
}

function Card({ title, icon: Icon, span = 4, linkLabel, onLink, right, children }) {
  return (
    <div className={`dash-card dash-span-${span}`}>
      <div className="dash-card-head">
        {Icon && <Icon size={15} />} {title}
        <span className="spacer" />
        {right}
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

const Spinner = ({ text = 'Hämtar…' }) => <div className="dash-empty"><Loader2 size={14} className="spin" /> {text}</div>;
const Err = ({ text }) => <div className="dash-empty"><AlertTriangle size={14} color="#b83a3a" /> {text}</div>;

// --- Sales (Shopify orders) -----------------------------------------------
function SalesCard({ onNavigate }) {
  const [{ loading, data, error }, reload] = useLazy('/dashboard/sales');
  return (
    <Card title="Försäljning (Shopify)" icon={ShoppingBag} span={6}
      right={<button className="dash-link" onClick={() => reload(true)} title="Hämta igen"><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>}>
      {loading && !data ? <Spinner text="Hämtar ordrar…" /> : error ? <Err text={error} /> : data && (
        <>
          <div className="dash-stats">
            <span><b>{kr(data.revenue7)}</b> 7 dagar <span className="sub">({data.orders7} ordrar)</span></span>
            <span><b>{kr(data.revenue30)}</b> 30 dagar <span className="sub">({data.orders30} ordrar · {data.units30} enheter)</span></span>
            <span>snittorder <b>{kr(data.avgOrder30)}</b></span>
          </div>
          {data.top?.length ? (
            <ul className="dash-list">
              {data.top.slice(0, 6).map(r => (
                <li key={r.sku}>
                  <span className="grow"><span className="title">{r.title}</span><span className="sub">{r.sku}</span></span>
                  <span className="num">{r.units} st<br /><span className="sub">{kr(r.revenue)}</span></span>
                </li>
              ))}
            </ul>
          ) : <div className="dash-empty">Inga ordrar de senaste 30 dagarna.</div>}
          <div className="dash-tile-sub" style={{ marginTop: 8 }}>Sålda enheter per produkt används för att sortera prisvarningarna efter påverkan.</div>
        </>
      )}
    </Card>
  );
}

// --- Merchant Center -----------------------------------------------------
function MerchantCard({ onNavigate }) {
  const [{ loading, data, error }, reload] = useLazy('/dashboard/merchant');
  const sev = { disapproved: '#b83a3a', demoted: '#c98a16', unaffected: '#2a6fb0' };
  return (
    <Card title="Merchant Center" icon={Zap} span={6} linkLabel="Alla fel" onLink={() => onNavigate('seo')}
      right={<button className="dash-link" onClick={() => reload(true)} title="Hämta igen"><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>}>
      {loading && !data ? <Spinner text="Hämtar produktstatus från Google…" /> : error ? <Err text={error} /> : data?.notConfigured ? (
        <div className="dash-empty"><AlertTriangle size={14} color="#c98a16" /> {data.notConfigured === 'merchant-id' ? 'Merchant-id saknas – ange det under Prisbevakning.' : 'Google service-konto saknas på servern.'}</div>
      ) : data && (
        <>
          <div className="dash-stats">
            <span><b>{n(data.total)}</b> produkter i feed</span>
            <span style={{ color: data.disapproved ? '#b83a3a' : 'inherit' }}><b>{n(data.disapproved)}</b> underkända</span>
            <span><b>{n(data.withIssues)}</b> med anmärkning</span>
            {data.account?.websiteClaimed === false && <span style={{ color: '#b83a3a' }}><AlertTriangle size={12} /> webbplats ej verifierad</span>}
            {data.account?.accountLevelIssues?.length > 0 && <span style={{ color: '#b83a3a' }}><AlertTriangle size={12} /> {data.account.accountLevelIssues.length} kontoproblem</span>}
          </div>
          {data.topIssues?.length ? (
            <ul className="dash-list">
              {data.topIssues.map(g => (
                <li key={g.code} className="clickable" onClick={() => onNavigate('seo')}>
                  <span className="pw-badge" style={{ background: sev[g.servability] || '#9a9895' }}>{g.servability === 'disapproved' ? 'Underkänd' : g.servability === 'demoted' ? 'Nedgraderad' : 'Info'}</span>
                  <span className="grow"><span className="title">{g.description || g.code}</span>{g.attributeName && <span className="sub">[{g.attributeName}]</span>}</span>
                  <span className="num">{g.count}</span>
                </li>
              ))}
            </ul>
          ) : <div className="dash-empty"><CheckCircle2 size={14} color="#2f8f55" /> Inga produktfel i feeden.</div>}
        </>
      )}
    </Card>
  );
}

// --- Google (Search Console + GA4) ---------------------------------------
function GoogleCard({ onNavigate }) {
  const [{ loading, data, error }, reload] = useLazy('/dashboard/google');
  return (
    <Card title="Google-trafik, 28 dagar" icon={Globe} span={6} linkLabel="SEO & Insikter" onLink={() => onNavigate('seo')}
      right={<button className="dash-link" onClick={() => reload(true)} title="Hämta igen"><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>}>
      {loading && !data ? <Spinner /> : error ? <Err text={error} /> : data?.notConfigured ? (
        <div className="dash-empty"><AlertTriangle size={14} color="#c98a16" /> {data.notConfigured === 'properties' ? 'Search Console och GA4 är inte kopplade – ange dem under SEO & Insikter.' : 'Google service-konto saknas på servern.'}</div>
      ) : data && (
        <div className="dash-stats" style={{ flexDirection: 'column', gap: 8 }}>
          {data.gsc ? data.gsc.error ? <Err text={`Search Console: ${data.gsc.error}`} /> : (
            <>
              <span><b>{n(data.gsc.clicks)}</b> klick från Google-sök <Delta cur={data.gsc.clicks} prev={data.gsc.prevClicks} /></span>
              <span><b>{n(data.gsc.impressions)}</b> visningar <Delta cur={data.gsc.impressions} prev={data.gsc.prevImpressions} /></span>
            </>
          ) : <span className="sub">Search Console ej kopplad</span>}
          {data.ga4 ? data.ga4.error ? <Err text={`GA4: ${data.ga4.error}`} /> : (
            <>
              <span><b>{n(data.ga4.sessions)}</b> sessioner <Delta cur={data.ga4.sessions} prev={data.ga4.prevSessions} /></span>
              <span><b>{n(data.ga4.purchases)}</b> köp · <b>{kr(data.ga4.revenue)}</b> <Delta cur={data.ga4.revenue} prev={data.ga4.prevRevenue} /></span>
            </>
          ) : <span className="sub">GA4 ej kopplad</span>}
          <span className="sub">jämfört med föregående 28 dagar</span>
        </div>
      )}
    </Card>
  );
}

// --- Supplier (Affari) ---------------------------------------------------
function SupplierCard({ onOpenProduct }) {
  const [{ loading, data, error }, reload] = useLazy('/dashboard/supplier');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const [tab, setTab] = useState('priceChanged');

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(`${API_URL}/supplier/import`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import misslyckades');
      setMsg(`${d.imported} artiklar inlästa (${d.type === 'dropship' ? 'lager & pris' : 'förpackningsantal & pris'})${d.pack?.productsUpdated != null ? `, förpackningsantal satt på ${d.pack.productsUpdated} produkter` : ''}.`);
      await reload(true);
    } catch (e) { setMsg(`Fel: ${e.message}`); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const TABS = [
    { key: 'priceChanged', label: 'Inköpspris ändrat', tone: '#c98a16' },
    { key: 'outOfStock', label: 'Slut hos Affari', tone: '#b83a3a' },
    { key: 'notDropship', label: 'Ej dropship-godkänd', tone: '#b83a3a' },
    { key: 'notInSupplier', label: 'Finns ej i filen', tone: '#9a9895' },
  ];
  const list = data?.[tab] || [];

  return (
    <Card title="Leverantör (Affari)" icon={Truck} span={6}
      right={<>
        <button className="dash-link" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={12} /> {busy ? 'Läser…' : 'Ladda upp Affari-fil'}</button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0])} />
      </>}>
      {msg && <div className="dash-tile-sub" style={{ marginBottom: 8, color: msg.startsWith('Fel') ? '#b83a3a' : '#2f8f55' }}>{msg}</div>}
      {loading && !data ? <Spinner /> : error ? <Err text={error} /> : data?.migrationMissing ? (
        <Err text="Kör database/add-dashboard.sql i Supabase för att aktivera leverantörsfilen." />
      ) : data && !data.lastImport ? (
        <div className="dash-empty">Ingen leverantörsfil inläst ännu. Ladda upp Affaris dagliga <em>Dropship.csv</em> (lager + pris) eller <em>ExcelExportGeneral</em> (förpackningsantal).</div>
      ) : data && (
        <>
          <div className="dash-stats">
            {TABS.map(t => (
              <span key={t.key} style={{ cursor: 'pointer', textDecoration: tab === t.key ? 'underline' : 'none' }} onClick={() => setTab(t.key)}>
                <i className="pw-dot" style={{ background: t.tone }} /> <b>{data.counts?.[t.key] ?? 0}</b> {t.label.toLowerCase()}
              </span>
            ))}
            <span className="sub">· fil {ago(data.lastImport)}</span>
          </div>
          {list.length ? (
            <ul className="dash-list">
              {list.slice(0, 6).map(r => (
                <li key={r.sku} className={r.productId ? 'clickable' : ''} onClick={() => r.productId && onOpenProduct?.(r.productId)}>
                  <span className="grow"><span className="title">{r.title}</span><span className="sub">{r.sku}{r.pack > 1 ? ` · ${r.pack}-pack` : ''}{r.deliveryWeek ? ` · lev. v${r.deliveryWeek}` : ''}</span></span>
                  {tab === 'priceChanged' && (
                    <span className="num">{kr(r.oldCost)} → <b style={{ color: r.change > 0 ? '#b83a3a' : '#2f8f55' }}>{kr(r.newCost)}</b><br /><span className="sub">pris {kr(r.currentPrice)} → bör {kr(r.suggestedPrice)}</span></span>
                  )}
                  {tab === 'outOfStock' && <span className="num" style={{ color: '#b83a3a' }}>lager {r.stock ?? 0}</span>}
                </li>
              ))}
            </ul>
          ) : <div className="dash-empty"><CheckCircle2 size={14} color="#2f8f55" /> Inget här.</div>}
          <div className="dash-tile-sub" style={{ marginTop: 8 }}>Inga priser eller kostnader ändras automatiskt – listan är underlag.</div>
        </>
      )}
    </Card>
  );
}

// --- Page --------------------------------------------------------------------
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

          {/* Sales + price comparison */}
          <SalesCard onNavigate={onNavigate} />

          <Card title="Prisjämförelse mot marknaden" icon={Scale} span={6} linkLabel="Öppna prisbevakning" onLink={() => onNavigate('price-watch')}>
            {pw.error ? <Err text={pw.error} /> : (
              <>
                <div className="dash-stats">
                  <span><b>{pw.total || 0}</b> med benchmark</span>
                  {['RÖD', 'BLÅ', 'GUL', 'OK'].map(s => <span key={s}><i className={`pw-dot pw-${s}`} /> <b>{pw.byStatus?.[s] || 0}</b> {s.toLowerCase()}</span>)}
                  <span className="sub">· hämtat {ago(pw.lastFetched)}</span>
                  {pw.unmatched > 0 && <span style={{ color: '#c98a16' }}><AlertTriangle size={12} /> {pw.unmatched} saknar PIM-produkt</span>}
                </div>
                {pw.topOpen?.length ? (
                  <ul className="dash-list">
                    {pw.topOpen.map(r => (
                      <li key={r.id} className={r.product_id ? 'clickable' : ''} onClick={() => r.product_id && onOpenProduct?.(r.product_id)}>
                        <span className={`pw-badge pw-${r.price_status}`}>{r.price_status}</span>
                        <span className="grow"><span className="title">{r.title || r.offer_id}</span><span className="sub">{r.sku}{r.pack_qty > 1 ? ` · ${r.pack_qty}-pack` : ''}{r.units_30d ? ` · ${r.units_30d} sålda` : ''}</span></span>
                        <span className="num">{kr(r.our_price)} <span className="sub">vs {kr(r.benchmark_price)}</span></span>
                        <span className={`num ${r.price_index > 1 ? 'pw-index-up' : 'pw-index-down'}`} style={{ width: 44 }}>{Number(r.price_index).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="dash-empty"><CheckCircle2 size={14} color="#2f8f55" /> {pw.total ? 'Inga okvitterade varningar.' : 'Ingen data hämtad ännu – öppna Prisbevakning och klicka "Hämta från Merchant Center".'}</div>
                )}
              </>
            )}
          </Card>

          {/* Supplier + under floor */}
          <SupplierCard onOpenProduct={onOpenProduct} />

          <Card title="Under golvpris" icon={TrendingDown} span={6} linkLabel="Visa alla" onLink={() => onNavigate('price-watch')}>
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

          {/* Merchant + Google */}
          <MerchantCard onNavigate={onNavigate} />
          <GoogleCard onNavigate={onNavigate} />

          {/* Catalogue health */}
          <Card title="Kataloghälsa" icon={Search} span={6} linkLabel="SEO & Insikter" onLink={() => onNavigate('seo')}>
            <div className="dash-stats">
              <span><b>{active}</b> aktiva</span>
              <span><b>{data.catalogue?.draft ?? 0}</b> utkast</span>
              <span><b>{data.catalogue?.staged ?? 0}</b> i staging</span>
            </div>
            {health ? HEALTH.map(h => {
              const c = health[h.key]?.count || 0;
              const w = healthTotal ? Math.min(100, Math.round((c / healthTotal) * 100)) : 0;
              return (
                <div key={h.key} className="dash-bar" onClick={() => onNavigate('seo')}>
                  <span className="lbl">{h.label}</span>
                  <span className="track"><span className="fill" style={{ width: `${w}%`, background: h.tone }} /></span>
                  <span className="val">{c} <span className="sub">({w} %)</span></span>
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
