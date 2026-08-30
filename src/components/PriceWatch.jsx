import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw, Download, Upload, AlertTriangle, Check, Undo2, Settings2,
  ChevronDown, ChevronRight, ExternalLink, Scale, Info,
} from 'lucide-react';
import './PriceWatch.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const STATUS_META = {
  'RÖD': { label: 'Röd', hint: 'Klart över marknaden och utrymme nedåt' },
  'BLÅ': { label: 'Blå', hint: 'Klart under marknaden – vi ger bort marginal' },
  'GUL': { label: 'Gul', hint: 'Avviker uppåt, eller över utan utrymme nedåt' },
  'OK': { label: 'OK', hint: 'Inom spannet' },
  'GRÅ': { label: 'Grå', hint: 'Google saknar benchmark för denna produkt' },
};
const STATUS_ORDER = ['RÖD', 'BLÅ', 'GUL', 'OK', 'GRÅ'];

const kr = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`);
const kr2 = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`);
const idxFmt = v => (v == null ? '–' : Number(v).toFixed(2));
const pct = v => (v == null ? '–' : `${Math.round(Number(v) * 100)} %`);
const dt = v => (v ? new Date(v).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–');

const SETTING_FIELDS = [
  { key: 'min_margin', label: 'Lägsta täckningsbidrag (%)', pct: true, hint: 'Ovanpå inköp + avgift + moms. Styr golvpriset.' },
  { key: 'handling_fee', label: 'Affaris hanteringsavgift (%)', pct: true },
  { key: 'vat', label: 'Moms (%)', pct: true },
  { key: 'high', label: 'Index för RÖD/GUL (över)', pct: false, hint: 't.ex. 1.20 = 20 % över benchmark' },
  { key: 'warn', label: 'Index för GUL (från)', pct: false },
  { key: 'low', label: 'Index för BLÅ (under)', pct: false },
  { key: 'ack_threshold', label: 'Väck kvitterad varning vid benchmark-rörelse (%)', pct: true },
];

export default function PriceWatch({ onOpenProduct }) {
  const [status, setStatus] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState({ status: '', open: true, q: '', sort: 'impact' });
  const [expanded, setExpanded] = useState(null);
  const [ackNote, setAckNote] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [merchantInput, setMerchantInput] = useState('');
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [packResult, setPackResult] = useState(null);
  const [devEmail, setDevEmail] = useState('');
  const [registering, setRegistering] = useState(false);
  const fileRef = useRef(null);

  const registerGcp = async () => {
    setRegistering(true); setError(null); setNotice(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/register-gcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ developerEmail: devEmail.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Registrering misslyckades');
      const ids = d.registration?.gcpIds || [];
      setNotice(`GCP-projektet är registrerat mot Merchant Center${ids.length ? ` (${ids.join(', ')})` : ''}. Vänta ca 5 minuter och klicka sedan "Hämta från Merchant Center".`);
    } catch (e) { setError(e.message); }
    finally { setRegistering(false); }
  };
  const needsGcpRegistration = !!error && /not registered with the merchant account|registerGcp|register_as_a_developer/i.test(error);

  const loadStatus = useCallback(async () => {
    const r = await fetch(`${API_URL}/price-watch/status`);
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || 'Kunde inte läsa status');
    setStatus(s);
    setMerchantInput(s.merchantId || '');
    setDraft(Object.fromEntries(Object.entries(s.settings || {}).map(([k, v]) => {
      const f = SETTING_FIELDS.find(x => x.key === k);
      return [k, f?.pct ? String(Math.round(v * 1000) / 10) : String(v)];
    })));
    return s;
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filter.status) p.set('status', filter.status);
      if (filter.open) p.set('open', '1');
      if (filter.q) p.set('q', filter.q);
      p.set('sort', filter.sort);
      const r = await fetch(`${API_URL}/price-watch/items?${p}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte hämta lista');
      setItems(d.items || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { loadStatus().catch(e => setError(e.message)); }, [loadStatus]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const saveConfig = async (body) => {
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte spara');
      await loadStatus();
      setNotice('Inställningar sparade.');
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const saveSettings = () => {
    const settings = {};
    for (const f of SETTING_FIELDS) {
      const v = Number(String(draft[f.key] ?? '').replace(',', '.'));
      if (!Number.isFinite(v)) continue;
      settings[f.key] = f.pct ? v / 100 : v;
    }
    return saveConfig({ settings });
  };

  const runFetch = async () => {
    setFetching(true); setError(null); setNotice(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/fetch`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Hämtning misslyckades');
      setNotice(`Hämtat ${d.offers} produkter från Merchant Center – ${d.withBenchmark} med benchmark (${pct(d.coverage)} täckning), ${d.matched} matchade mot PIM${d.reopened ? `, ${d.reopened} kvitterade varningar väcktes` : ''}.`);
      await loadStatus(); await loadItems();
    } catch (e) { setError(e.message); }
    finally { setFetching(false); }
  };

  const ack = async (id) => {
    setError(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/items/${id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: ackNote }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte kvittera');
      setAckNote(''); setExpanded(null);
      await loadStatus(); await loadItems();
    } catch (e) { setError(e.message); }
  };

  const unack = async (id) => {
    setError(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/items/${id}/ack`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte ångra');
      await loadStatus(); await loadItems();
    } catch (e) { setError(e.message); }
  };

  const exportCsv = async () => {
    try {
      const r = await fetch(`${API_URL}/price-watch/export.csv`);
      if (!r.ok) throw new Error('Export misslyckades');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `prisbevakning-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setError(e.message); }
  };

  const importPack = async (file) => {
    if (!file) return;
    setPackResult(null); setError(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(`${API_URL}/price-watch/pack-import`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import misslyckades');
      setPackResult(d);
      await loadStatus();
    } catch (e) { setError(e.message); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };

  const openCount = status?.open ? Object.values(status.open).reduce((a, b) => a + b, 0) : 0;
  const needsSetup = status && (!status.credentials || !status.merchantId || status.migrationMissing);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Scale size={22} /> Prisbevakning</h1>
          <div className="pw-sub" style={{ marginTop: 4 }}>
            Vårt pris mot Googles benchmark (Merchant Center Market Insights). Ändrar aldrig ett pris – bara status som en människa granskar.
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => setShowSettings(s => !s)}><Settings2 size={16} /> Inställningar</button>
          <button className="btn btn-secondary" onClick={exportCsv} disabled={!status?.total}><Download size={16} /> Exportera CSV</button>
          <button className="btn btn-primary" onClick={runFetch} disabled={fetching || needsSetup}>
            <RefreshCw size={16} className={fetching ? 'spin' : ''} /> {fetching ? 'Hämtar…' : 'Hämta från Merchant Center'}
          </button>
        </div>
      </div>

      {error && <div className="settings-section pw-error" style={{ padding: 12, fontSize: 13, color: '#b83a3a' }}>{error}</div>}
      {(needsGcpRegistration || (showSettings && status?.credentials && status?.merchantId)) && (
        <div className={`settings-section ${needsGcpRegistration ? 'pw-warn' : ''}`} style={{ padding: 16 }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Info size={16} /> Registrera GCP-projektet mot Merchant Center (engångssteg)</strong>
          <p className="pw-hint">
            Merchant API kräver att service-kontots Google Cloud-projekt registreras på Merchant Center-kontot. Ange e-posten för en <em>användare på Merchant Center-kontot</em>
            (t.ex. den du loggar in i Merchant Center med) – den får rollen API-utvecklare. Efter registreringen tar det ca 5 minuter innan hämtning fungerar.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input className="form-input" style={{ width: 280 }} placeholder="namn@foretag.se" value={devEmail} onChange={e => setDevEmail(e.target.value)} />
            <button className="btn btn-primary" disabled={registering || !devEmail.trim()} onClick={registerGcp}>{registering ? 'Registrerar…' : 'Registrera GCP-projekt'}</button>
          </div>
        </div>
      )}
      {notice && <div className="settings-section" style={{ padding: 12, fontSize: 13, borderLeft: '3px solid #2f8f55' }}>{notice}</div>}

      {status?.migrationMissing && (
        <div className="settings-section pw-error" style={{ padding: 16 }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={16} /> Databasen saknar tabellerna för prisbevakning</strong>
          <p className="pw-hint">Kör <code>database/add-price-watch.sql</code> i Supabase SQL Editor och ladda om sidan.</p>
        </div>
      )}

      {status && !status.credentials && (
        <div className="settings-section pw-warn" style={{ padding: 16 }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={16} /> Google service-account saknas</strong>
          <p className="pw-hint">Prisbevakningen använder samma service-account som SEO & Insikter. Sätt <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> på servern.</p>
        </div>
      )}

      {status && status.credentials && !status.merchantId && (
        <div className="settings-section pw-warn" style={{ padding: 16 }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={16} /> Merchant Center account-id saknas</strong>
          <p className="pw-hint">
            Ange kontots id (siffrorna uppe till höger i Merchant Center). Ge <code>{status.serviceAccountEmail}</code> åtkomst under Inställningar → Användare,
            och aktivera <em>Market Insights</em> (Tillväxt → Hantera program) så att prisjämförelserapporten finns.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="form-input" style={{ width: 220 }} placeholder="t.ex. 5123456789" value={merchantInput} onChange={e => setMerchantInput(e.target.value)} />
            <button className="btn btn-primary" disabled={saving || !merchantInput.trim()} onClick={() => saveConfig({ merchantId: merchantInput.trim() })}>Spara</button>
          </div>
        </div>
      )}

      {showSettings && status && (
        <div className="settings-section" style={{ padding: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Inställningar</h3>
          <div className="pw-settings-grid">
            <div>
              <label>Merchant Center account-id</label>
              <input className="form-input" value={merchantInput} onChange={e => setMerchantInput(e.target.value)} />
            </div>
            {SETTING_FIELDS.map(f => (
              <div key={f.key}>
                <label title={f.hint}>{f.label}</label>
                <input className="form-input" value={draft[f.key] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div className="pw-hint">
            Golvpris = inköp per artikel × (1 + avgift) × (1 + moms) × (1 + täckningsbidrag). Index = vårt pris / benchmark.
            Inköp per artikel = styckpris från Affari × förpackningsantal.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={saving} onClick={async () => { await saveConfig({ merchantId: merchantInput.trim() || null }); await saveSettings(); }}>{saving ? 'Sparar…' : 'Spara inställningar'}</button>
            <span style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}><Upload size={16} /> Importera förpackningsantal (Affari-export)</button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importPack(e.target.files?.[0])} />
          </div>
          {packResult && (
            <div className="pw-hint" style={{ marginTop: 8 }}>
              <Check size={12} /> {packResult.parsed} rader lästa, {packResult.multiPackInFile} med förpackning &gt; 1. Uppdaterade {packResult.productsUpdated} produkter och {packResult.variantsUpdated} varianter i PIM.
              Kör "Hämta från Merchant Center" för att räkna om golvpriser.
            </div>
          )}
          <div className="pw-hint">
            {status.packProducts} produkter i PIM har förpackningsantal &gt; 1. Nattlig hämtning kl. {status.scheduleHour ?? 4}:00 (servertid) när Merchant-id är satt.
            {status.lastRun && <> Senaste körning: {dt(status.lastRun.started_at)} – {status.lastRun.status === 'ok' ? `${status.lastRun.offers_total} produkter, ${status.lastRun.with_benchmark} med benchmark` : status.lastRun.status === 'error' ? `fel: ${status.lastRun.error}` : 'pågår'}.</>}
          </div>
        </div>
      )}

      {/* Summary tiles */}
      {status && !status.migrationMissing && (
        <div className="pw-tiles">
          <div className={`pw-tile ${!filter.status && filter.open ? 'active' : ''}`} onClick={() => setFilter(f => ({ ...f, status: '', open: true }))}>
            <div className="pw-tile-label"><AlertTriangle size={13} /> Att granska</div>
            <div className="pw-tile-value">{openCount}</div>
            <div className="pw-tile-sub">okvitterade varningar</div>
          </div>
          {STATUS_ORDER.map(s => (
            <div key={s} className={`pw-tile ${filter.status === s ? 'active' : ''}`} onClick={() => setFilter(f => ({ ...f, status: f.status === s ? '' : s, open: ['RÖD', 'BLÅ', 'GUL'].includes(s) ? f.open : false }))} title={STATUS_META[s].hint}>
              <div className="pw-tile-label"><span className={`pw-dot pw-${s}`} /> {STATUS_META[s].label}</div>
              <div className="pw-tile-value">{status.byStatus?.[s] || 0}</div>
              <div className="pw-tile-sub">{['RÖD', 'BLÅ', 'GUL'].includes(s) ? `${status.open?.[s] || 0} öppna` : STATUS_META[s].hint}</div>
            </div>
          ))}
          <div className="pw-tile" style={{ cursor: 'default' }}>
            <div className="pw-tile-label"><Info size={13} /> Täckning</div>
            <div className="pw-tile-value">{pct(status.coverage)}</div>
            <div className="pw-tile-sub">{status.withBenchmark} av {status.total} med benchmark · {status.lastFetched ? dt(status.lastFetched) : 'aldrig hämtat'}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="pw-toolbar">
        <input className="form-input" placeholder="Sök titel eller SKU…" value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        <label><input type="checkbox" checked={filter.open} onChange={e => setFilter(f => ({ ...f, open: e.target.checked }))} /> Endast okvitterade varningar</label>
        <label>Sortera
          <select className="form-input" value={filter.sort} onChange={e => setFilter(f => ({ ...f, sort: e.target.value }))}>
            <option value="impact">Påverkan (kr-avvikelse × sålda 30 d)</option>
            <option value="index">Index (störst avvikelse)</option>
            <option value="title">Titel</option>
          </select>
        </label>
        {filter.status && <button className="btn btn-ghost btn-sm" onClick={() => setFilter(f => ({ ...f, status: '' }))}>Rensa statusfilter ({filter.status})</button>}
        <span style={{ marginLeft: 'auto' }} className="pw-sub">{loading ? 'Laddar…' : `${items.length} rader`}</span>
      </div>

      {/* Table */}
      <div className="settings-section pw-table-wrap" style={{ padding: 0 }}>
        {items.length === 0 && !loading ? (
          <div className="pw-empty">
            {status?.total ? 'Inga rader matchar filtret.' : 'Ingen data ännu. Kör "Hämta från Merchant Center".'}
          </div>
        ) : (
          <table className="margin-table pw-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Produkt</th>
                <th className="num">Förp.</th>
                <th className="num">Vårt pris</th>
                <th className="num">Styck</th>
                <th className="num">Benchmark</th>
                <th className="num">Index</th>
                <th className="num">Golvpris</th>
                <th className="num" title="Sålda enheter senaste 30 dagarna (från Shopify-ordrar, uppdateras när Översikten laddas)">Sålda 30 d</th>
                <th>Hämtad</th>
                <th>Kvittering</th>
              </tr>
            </thead>
            <tbody>
              {items.map(r => {
                const isOpen = expanded === r.id;
                const up = r.price_index != null && r.price_index > 1.0;
                return [
                  <tr key={r.id} className={`pw-row ${r.acknowledged_at ? 'pw-ack' : ''}`} onClick={() => { setExpanded(isOpen ? null : r.id); setAckNote(''); }}>
                    <td><span className={`pw-badge pw-${r.price_status}`}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {r.price_status}</span></td>
                    <td>
                      <div className="pw-title">{r.title || r.offer_id}</div>
                      <div className="pw-sub">{r.sku || r.offer_id}{!r.product_id && ' · ej matchad mot PIM'}</div>
                    </td>
                    <td className="num">{r.pack_qty > 1 ? `${r.pack_qty}-pack` : '1'}</td>
                    <td className="num">{kr(r.our_price)}</td>
                    <td className="num">{r.pack_qty > 1 ? kr2(r.unit_price_ours) : '–'}</td>
                    <td className="num">{kr(r.benchmark_price)}</td>
                    <td className={`num ${r.price_index == null ? '' : up ? 'pw-index-up' : r.price_index < 1 ? 'pw-index-down' : ''}`}>{idxFmt(r.price_index)}</td>
                    <td className="num">{kr(r.floor_price)}</td>
                    <td className="num">{r.units_30d ? r.units_30d : <span className="pw-sub">0</span>}</td>
                    <td className="pw-sub">{r.benchmark_fetched_at ? new Date(r.benchmark_fetched_at).toLocaleDateString('sv-SE') : '–'}</td>
                    <td className="pw-sub">
                      {r.acknowledged_at ? <><Check size={12} /> {r.acknowledged_by} {new Date(r.acknowledged_at).toLocaleDateString('sv-SE')}</> : (['RÖD', 'BLÅ', 'GUL'].includes(r.price_status) ? 'öppen' : '')}
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${r.id}-d`}>
                      <td colSpan={11} style={{ background: 'transparent' }}>
                        <dl className="pw-detail">
                          <div><dt>Status</dt><dd><span className={`pw-badge pw-${r.price_status}`}>{r.price_status}</span> <span className="pw-sub">{STATUS_META[r.price_status]?.hint}</span></dd></div>
                          <div><dt>Vårt pris</dt><dd>{kr(r.our_price)}{r.pack_qty > 1 && <span className="pw-sub"> ({kr2(r.unit_price_ours)}/st)</span>}</dd></div>
                          <div><dt>Benchmark (Google)</dt><dd>{kr(r.benchmark_price)}</dd></div>
                          <div><dt>Index</dt><dd>{idxFmt(r.price_index)}{r.price_index != null && <span className="pw-sub"> ({r.price_index >= 1 ? '+' : ''}{Math.round((r.price_index - 1) * 100)} %)</span>}</dd></div>
                          <div><dt>Inköp per artikel</dt><dd>{kr(r.cost_price)} <span className="pw-sub">exkl. moms</span></dd></div>
                          <div><dt>Golvpris</dt><dd>{kr(r.floor_price)}{r.floor_price != null && r.our_price != null && <span className="pw-sub"> · utrymme {kr(r.our_price - r.floor_price)}</span>}</dd></div>
                          <div><dt>Källa</dt><dd>{r.reference_source === 'merchant' ? 'Merchant Center' : r.reference_source || '–'} {r.source_count ? `(${r.source_count} källor)` : ''}</dd></div>
                          <div><dt>Hämtad</dt><dd>{dt(r.benchmark_fetched_at)}</dd></div>
                          <div><dt>Offer-id</dt><dd style={{ fontWeight: 400, fontSize: 12 }}>{r.offer_id}</dd></div>
                          <div><dt>Först sedd</dt><dd>{dt(r.first_seen_at)}{r.reopened_count ? <span className="pw-sub"> · återöppnad {r.reopened_count} ggr</span> : null}</dd></div>
                          <div className="pw-detail-wide">
                            <dt>Kvittering</dt>
                            <dd>
                              {r.acknowledged_at ? (
                                <div className="pw-ack-form">
                                  <div className="pw-ack-info">
                                    Kvitterad av <strong>{r.acknowledged_by}</strong> {dt(r.acknowledged_at)} vid benchmark {kr(r.acknowledged_benchmark)}.
                                    {r.acknowledged_note && <> Motivering: <em>{r.acknowledged_note}</em>.</>}
                                    <br />Väcks igen när benchmark rört sig mer än {pct(status?.settings?.ack_threshold)}.
                                  </div>
                                  <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); unack(r.id); }}><Undo2 size={14} /> Ångra kvittering</button>
                                </div>
                              ) : ['RÖD', 'BLÅ', 'GUL'].includes(r.price_status) ? (
                                <div className="pw-ack-form" onClick={e => e.stopPropagation()}>
                                  <textarea className="form-input" placeholder="Motivering (valfritt) – t.ex. 'medvetet lågt, kampanj' eller 'konkurrenten säljer 1-pack'" value={ackNote} onChange={e => setAckNote(e.target.value)} />
                                  <button className="btn btn-primary btn-sm" onClick={() => ack(r.id)}><Check size={14} /> Kvittera – priset står kvar</button>
                                </div>
                              ) : <span className="pw-sub">Ingen varning att kvittera.</span>}
                            </dd>
                          </div>
                          {(r.product_id || r.sku) && (
                            <div className="pw-detail-wide" style={{ display: 'flex', gap: 12 }}>
                              {r.product_id && onOpenProduct && <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); onOpenProduct(r.product_id); }}>Öppna produkt i PIM</button>}
                              {r.sku && <a className="btn btn-ghost btn-sm" href={`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(r.title || r.sku)}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Google Shopping <ExternalLink size={12} /></a>}
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
