import { useState, useEffect, useCallback } from 'react';
import {
  ShoppingBag, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, TrendingUp, Truck, Percent,
} from 'lucide-react';
import './Dashboard.css';
import './PriceWatch.css';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const kr = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`);
const kr2 = v => (v == null ? '–' : `${Number(v).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`);
const pct = v => (v == null ? '–' : `${Math.round(Number(v) * 100)} %`);
const dt = v => (v ? new Date(v).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const profitColor = v => (v == null ? 'inherit' : v < 0 ? '#b83a3a' : '#2f8f55');

export default function SalesView({ onOpenProduct }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('orders');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_URL}/sales/report?days=${days}${refresh ? '&refresh=1' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Kunde inte hämta försäljningen');
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  const s = data?.settings;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><ShoppingBag size={22} /> Försäljning</h1>
          <div className="pw-sub" style={{ marginTop: 4 }}>
            Ordrar från Shopify med vinst per order och produkt. Vinst = intäkt ex moms − inköp × förp. − Affari-avgift {s ? pct(s.handling_fee) : '20 %'} − Affari-frakt {s ? kr(s.freight_fee) : '79 kr'} när inköpsvärdet är under {s ? kr(s.freight_threshold) : '700 kr'}.
          </div>
        </div>
        <div className="actions">
          <select className="form-input" value={days} onChange={e => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={7}>7 dagar</option>
            <option value={30}>30 dagar</option>
            <option value={90}>90 dagar</option>
            <option value={365}>12 månader</option>
          </select>
          <button className="btn btn-secondary" onClick={() => load(true)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Uppdatera</button>
        </div>
      </div>

      {error && <div className="settings-section pw-error" style={{ padding: 12, fontSize: 13, color: '#b83a3a' }}>{error}</div>}
      {loading && !data && <div className="pw-empty">Hämtar ordrar…</div>}

      {data && (
        <>
          <div className="pw-tiles">
            <div className="pw-tile"><div className="pw-tile-label"><ShoppingBag size={13} /> Omsättning</div><div className="pw-tile-value">{kr(t.revenue)}</div><div className="pw-tile-sub">{t.orders} ordrar · snitt {kr(t.avgOrder)}</div></div>
            <div className="pw-tile"><div className="pw-tile-label">Intäkt ex moms</div><div className="pw-tile-value">{kr(t.revenueExVat)}</div><div className="pw-tile-sub">moms {pct(s.vat)}</div></div>
            <div className="pw-tile"><div className="pw-tile-label">Inköp + avgift</div><div className="pw-tile-value">{kr(t.purchase + t.fee)}</div><div className="pw-tile-sub">inköp {kr(t.purchase)} · avgift {kr(t.fee)}</div></div>
            <div className="pw-tile"><div className="pw-tile-label"><Truck size={13} /> Affari-frakt</div><div className="pw-tile-value">{kr(t.freight)}</div><div className="pw-tile-sub">{s ? `${kr(s.freight_fee)} per order under ${kr(s.freight_threshold)} i inköp` : ''}</div></div>
            <div className="pw-tile" style={{ borderLeft: `3px solid ${profitColor(t.profit)}` }}><div className="pw-tile-label"><TrendingUp size={13} /> Bruttovinst</div><div className="pw-tile-value" style={{ color: profitColor(t.profit) }}>{kr(t.profit)}</div><div className="pw-tile-sub"><Percent size={11} /> marginal {pct(t.margin)}</div></div>
          </div>

          {t.unitsMissingCost > 0 && (
            <div className="settings-section pw-warn" style={{ padding: 10, fontSize: 13, marginBottom: 12 }}>
              <AlertTriangle size={14} /> {t.unitsMissingCost} sålda enheter saknar inköpspris i PIM – deras ordrar visas utan vinst. Ladda upp Affari-filen och rätta kostnaden så fylls de i.
            </div>
          )}

          <div className="pw-toolbar">
            <button className={`btn ${tab === 'orders' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('orders')}>Ordrar ({data.orders.length})</button>
            <button className={`btn ${tab === 'products' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('products')}>Per produkt ({data.products.length})</button>
            <span style={{ marginLeft: 'auto' }} className="pw-sub">sedan {data.since} · hämtat {dt(data.fetchedAt)}</span>
          </div>

          {tab === 'orders' && (
            <div className="settings-section pw-table-wrap" style={{ padding: 0 }}>
              {data.orders.length === 0 ? <div className="pw-empty">Inga ordrar i perioden.</div> : (
                <table className="margin-table pw-table">
                  <thead>
                    <tr>
                      <th>Order</th><th>Datum</th><th>Status</th>
                      <th className="num">Totalt</th><th className="num">Frakt (kund)</th>
                      <th className="num">Inköp</th><th className="num">Avgift 20 %</th><th className="num">Affari-frakt</th>
                      <th className="num">Vinst</th><th className="num">Marginal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map(o => {
                      const open = expanded === o.id;
                      return [
                        <tr key={o.id} className="pw-row" onClick={() => setExpanded(open ? null : o.id)}>
                          <td>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <strong>{o.name}</strong></td>
                          <td className="pw-sub">{dt(o.createdAt)}</td>
                          <td className="pw-sub">{o.financial}{o.missingCostUnits ? <span style={{ color: '#c98a16' }}> · inköp saknas</span> : ''}</td>
                          <td className="num">{kr2(o.total)}</td>
                          <td className="num">{o.shipping ? kr2(o.shipping) : <span className="pw-sub">fraktfritt</span>}</td>
                          <td className="num">{kr2(o.purchase)}</td>
                          <td className="num">{kr2(o.fee)}</td>
                          <td className="num">{o.freight ? kr2(o.freight) : '–'}</td>
                          <td className="num" style={{ color: profitColor(o.profit), fontWeight: 600 }}>{kr2(o.profit)}</td>
                          <td className="num">{pct(o.margin)}</td>
                        </tr>,
                        open && (
                          <tr key={`${o.id}-d`}>
                            <td colSpan={10} style={{ background: 'var(--bg-sunken, #f0ede8)' }}>
                              <table className="margin-table" style={{ margin: '4px 0' }}>
                                <thead><tr><th>Produkt</th><th className="num">Antal</th><th className="num">Radbelopp</th><th className="num">Ex moms</th><th className="num">Inköp/artikel</th><th className="num">Avgift</th><th className="num">Vinst</th></tr></thead>
                                <tbody>
                                  {o.lines.map((li, i) => (
                                    <tr key={i}>
                                      <td>{li.title} <span className="pw-sub">{li.sku}</span></td>
                                      <td className="num">{li.qty}</td>
                                      <td className="num">{kr2(li.lineTotal)}</td>
                                      <td className="num">{kr2(li.lineExVat)}</td>
                                      <td className="num">{li.costPerArticle != null ? kr2(li.costPerArticle) : <span style={{ color: '#c98a16' }}>saknas</span>}</td>
                                      <td className="num">{kr2(li.fee)}</td>
                                      <td className="num" style={{ color: profitColor(li.profit) }}>{kr2(li.profit)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <div className="pw-sub" style={{ padding: '2px 8px 8px' }}>Affari-frakten ({o.freight ? kr(o.freight) : '0 kr'}) ligger på ordernivå och ingår inte i radernas vinst.</div>
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'products' && (
            <div className="settings-section pw-table-wrap" style={{ padding: 0 }}>
              {data.products.length === 0 ? <div className="pw-empty">Inga sålda produkter i perioden.</div> : (
                <table className="margin-table pw-table">
                  <thead>
                    <tr>
                      <th>Produkt</th><th className="num">Antal</th><th className="num">Omsättning</th><th className="num">Ex moms</th>
                      <th className="num">Inköp</th><th className="num">Avgift</th><th className="num">Vinst</th><th className="num">Marginal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.products.map((p, i) => (
                      <tr key={i} className={p.productId ? 'pw-row' : ''} onClick={() => p.productId && onOpenProduct?.(p.productId)}>
                        <td><span className="pw-title">{p.title}</span> <span className="pw-sub">{p.sku}</span></td>
                        <td className="num">{p.units}</td>
                        <td className="num">{kr2(p.revenue)}</td>
                        <td className="num">{kr2(p.revenueExVat)}</td>
                        <td className="num">{p.missingCost ? <span style={{ color: '#c98a16' }}>saknas</span> : kr2(p.purchase)}</td>
                        <td className="num">{kr2(p.fee)}</td>
                        <td className="num" style={{ color: profitColor(p.profit), fontWeight: 600 }}>{kr2(p.profit)}</td>
                        <td className="num">{pct(p.margin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="pw-sub" style={{ padding: '8px 12px' }}>Per produkt räknas utan Affari-frakten (den är per order). Klicka på en rad för att öppna produkten.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
