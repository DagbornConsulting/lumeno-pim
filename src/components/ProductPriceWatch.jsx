import { useState } from 'react';
import { Check, Undo2, Loader2, AlertTriangle, Scale, ExternalLink } from 'lucide-react';
import './PriceWatch.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const STATUS_META = {
  'RÖD': { hint: 'Klart över marknaden och utrymme nedåt – granska.' },
  'BLÅ': { hint: 'Klart under marknaden – vi ger bort marginal.' },
  'GUL': { hint: 'Avviker uppåt, eller över utan utrymme nedåt.' },
  'OK': { hint: 'Inom spannet mot marknaden.' },
  'GRÅ': { hint: 'Google saknar benchmark för den här artikeln.' },
};
const kr = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`);
const kr2 = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`);
const dt = v => (v ? new Date(v).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const pct = v => (v == null ? '–' : `${Math.round(Number(v) * 100)} %`);
// Retail rounding: whole kronor ending in 9 when above 100, else whole kronor.
const nice = v => { const n = Math.round(Number(v)); return n >= 100 ? Math.floor(n / 10) * 10 + 9 : n; };

function Row({ row, productId, settings, onReload, onPriceChanged }) {
  const [price, setPrice] = useState(String(Math.round(row.our_price || 0)));
  const [cmp, setCmp] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [ackNote, setAckNote] = useState('');
  const [confirm, setConfirm] = useState(false);

  const isAlert = ['RÖD', 'BLÅ', 'GUL'].includes(row.price_status);
  const newPrice = Math.round(Number(String(price).replace(',', '.')));
  const validPrice = Number.isFinite(newPrice) && newPrice > 0 && newPrice !== Math.round(row.our_price || 0);
  const belowFloor = row.floor_price != null && validPrice && newPrice < Number(row.floor_price);
  const previewIndex = row.benchmark_price && validPrice ? (newPrice / Number(row.benchmark_price)) : null;

  const setPriceInShopify = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/set-price`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, sku: row.sku || undefined, price: newPrice, ...(cmp.trim() ? { compareAtPrice: Number(cmp) } : {}), note }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte uppdatera priset');
      setMsg({ ok: true, text: `Priset är uppdaterat i Shopify: ${d.updated.map(u => `${u.from} → ${u.to} kr`).join(', ')}.` });
      setConfirm(false); setNote('');
      onPriceChanged?.({ sku: row.sku, price: newPrice, compareAtPrice: d.compareAtPrice });
      await onReload?.();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const ack = async (undo = false) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API_URL}/price-watch/items/${row.id}/ack`, undo ? { method: 'DELETE' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: ackNote }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Fel');
      setAckNote('');
      await onReload?.();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="settings-section" style={{ padding: 16, marginBottom: 12, borderLeft: `3px solid var(--pw-c)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className={`pw-badge pw-${row.price_status}`}>{row.price_status}</span>
        <strong>{row.sku || row.offer_id}</strong>
        <span className="pw-sub">{STATUS_META[row.price_status]?.hint}</span>
        {row.acknowledged_at && <span className="pw-sub"><Check size={12} /> kvitterad av {row.acknowledged_by} {dt(row.acknowledged_at)}</span>}
        <a className="pw-sub" style={{ marginLeft: 'auto' }} href={`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(row.title || row.sku || '')}`} target="_blank" rel="noreferrer">Google Shopping <ExternalLink size={11} /></a>
      </div>

      <dl className="pw-detail" style={{ marginBottom: 12 }}>
        <div><dt>Vårt pris (Shopify)</dt><dd>{kr(row.our_price)}{row.pack_qty > 1 && <span className="pw-sub"> · {row.pack_qty}-pack, {kr2(row.unit_price_ours)}/st</span>}</dd></div>
        <div><dt>Marknadens pris (benchmark)</dt><dd>{kr(row.benchmark_price)}</dd></div>
        <div><dt>Index</dt><dd>{row.price_index != null ? <span className={row.price_index > 1 ? 'pw-index-up' : row.price_index < 1 ? 'pw-index-down' : ''}>{Number(row.price_index).toFixed(2)} <span className="pw-sub">({row.price_index >= 1 ? '+' : ''}{Math.round((row.price_index - 1) * 100)} %)</span></span> : '–'}</dd></div>
        <div><dt>Inköp per artikel</dt><dd>{kr(row.cost_price)} <span className="pw-sub">exkl. moms</span></dd></div>
        <div><dt>Golvpris</dt><dd>{kr(row.floor_price)}{row.floor_price != null && row.our_price != null && <span className="pw-sub"> · utrymme {kr(row.our_price - row.floor_price)}</span>}</dd></div>
        <div><dt>Sålda 30 d</dt><dd>{row.units_30d || 0} st{row.revenue_30d ? <span className="pw-sub"> · {kr(row.revenue_30d)}</span> : null}</dd></div>
        <div><dt>Benchmark hämtad</dt><dd>{dt(row.benchmark_fetched_at)}</dd></div>
      </dl>

      {/* Set price */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Ändra pris (skrivs direkt till Shopify)</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          {row.benchmark_price != null && <>
            <button className="btn btn-secondary btn-sm" onClick={() => setPrice(String(nice(row.benchmark_price)))}>Matcha marknaden ({kr(nice(row.benchmark_price))})</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPrice(String(nice(row.benchmark_price * 0.95)))}>5 % under marknaden</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPrice(String(nice(row.benchmark_price * 1.05)))}>5 % över marknaden</button>
          </>}
          {row.floor_price != null && <button className="btn btn-secondary btn-sm" onClick={() => setPrice(String(nice(row.floor_price)))}>Golvpris ({kr(nice(row.floor_price))})</button>}
        </div>
        <div className="pw-ack-form" style={{ marginTop: 0, alignItems: 'flex-end' }}>
          <div>
            <label className="pw-sub">Nytt pris (kr inkl. moms)</label><br />
            <input className="form-input mono" style={{ width: 140 }} value={price} onChange={e => setPrice(e.target.value)} />
          </div>
          <div>
            <label className="pw-sub">Jämförpris (valfritt)</label><br />
            <input className="form-input mono" style={{ width: 140 }} placeholder="t.ex. 599" value={cmp} onChange={e => setCmp(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="pw-sub">Notering (valfritt, loggas)</label><br />
            <input className="form-input" style={{ width: '100%' }} value={note} onChange={e => setNote(e.target.value)} placeholder="t.ex. matchar Ellos" />
          </div>
          {!confirm ? (
            <button className="btn btn-primary btn-sm" disabled={!validPrice || busy} onClick={() => setConfirm(true)}>Uppdatera pris i Shopify</button>
          ) : (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span className="pw-sub">Sätt {kr(newPrice)}{row.sku ? ` på ${row.sku}` : ''}?</span>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={setPriceInShopify}>{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Ja, uppdatera</button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirm(false)}>Avbryt</button>
            </span>
          )}
        </div>
        {validPrice && (
          <div className="pw-sub" style={{ marginTop: 6 }}>
            {previewIndex != null && <>Nytt index {previewIndex.toFixed(2)} ({previewIndex >= 1 ? '+' : ''}{Math.round((previewIndex - 1) * 100)} % mot marknaden). </>}
            {row.floor_price != null && <>Marginalutrymme efter ändring: {kr(newPrice - row.floor_price)}. </>}
            {belowFloor && <span style={{ color: '#b83a3a' }}><AlertTriangle size={12} /> Under golvpriset – du säljer med lägre marginal än inställt.</span>}
          </div>
        )}
        {msg && <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? '#2f8f55' : '#b83a3a' }}>{msg.text}</div>}
      </div>

      {/* Acknowledge */}
      {isAlert && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          {row.acknowledged_at ? (
            <div className="pw-ack-form" style={{ marginTop: 0 }}>
              <div className="pw-ack-info">Kvitterad {dt(row.acknowledged_at)} av {row.acknowledged_by} vid benchmark {kr(row.acknowledged_benchmark)}{row.acknowledged_note ? ` – "${row.acknowledged_note}"` : ''}. Väcks igen om benchmark rör sig mer än {pct(settings?.ack_threshold)}.</div>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => ack(true)}><Undo2 size={14} /> Ångra kvittering</button>
            </div>
          ) : (
            <div className="pw-ack-form" style={{ marginTop: 0 }}>
              <textarea className="form-input" placeholder="Priset står kvar – motivering (valfritt)" value={ackNote} onChange={e => setAckNote(e.target.value)} />
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => ack(false)}><Check size={14} /> Kvittera – priset står kvar</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProductPriceWatch({ productId, data, loading, onReload, onPriceChanged, onGoToPriceWatch }) {
  if (loading && !data) return <div className="pw-empty"><Loader2 size={14} className="spin" /> Hämtar prisjämförelse…</div>;
  if (!data) return null;
  if (!data.merchantConfigured) return <div className="pw-empty"><AlertTriangle size={14} color="#c98a16" /> Merchant Center är inte kopplat – ange Merchant-id under Prisbevakning.</div>;
  if (!data.rows?.length) {
    return (
      <div className="pw-empty" style={{ textAlign: 'left', display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Scale size={14} /> Google har ingen prisjämförelse för den här produkten.</div>
        <div style={{ marginTop: 6 }}>Det betyder oftast att ingen annan butik annonserar samma EAN på Google Shopping just nu, eller att produkten inte har hämtats än (nattlig hämtning från Merchant Center).</div>
      </div>
    );
  }
  return (
    <div>
      {data.rows.map(r => (
        <div key={r.id} className={`pw-${r.price_status}`}>
          <Row row={r} productId={productId} settings={data.settings} onReload={onReload} onPriceChanged={onPriceChanged} />
        </div>
      ))}
      <div className="pw-sub">Marknadens pris är Googles benchmark (Merchant Center Market Insights) för samma EAN. Inköp per artikel = leverantörens styckpris × förpackningsantal. Golvpris = inköp × (1 + avgift) × (1 + moms) × (1 + lägsta täckningsbidrag).</div>
    </div>
  );
}
