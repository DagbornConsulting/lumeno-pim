import { useState, useEffect, useCallback } from 'react';
import {
  Tag, Layers, FileText, Search, Image as ImageIcon, RefreshCw, Sparkles,
  ChevronDown, ChevronRight, CheckCircle2, Lightbulb, ExternalLink,
} from 'lucide-react';
import { matchCategoryId } from '../lib/taxonomyMatch';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const BUCKETS = [
  { key: 'missingCategory', label: 'Saknar Shopify-kategori', icon: Tag, tone: '#ef4444', ai: 'category' },
  { key: 'thinAttributes', label: 'Saknar attribut (metafält)', icon: Layers, tone: '#f59e0b', ai: 'enrich' },
  { key: 'missingDescription', label: 'Saknar / kort beskrivning', icon: FileText, tone: '#f59e0b', ai: 'enrich' },
  { key: 'noImages', label: 'Saknar bild', icon: ImageIcon, tone: '#ef4444' },
  { key: 'missingSeoTitle', label: 'Saknar SEO-titel', icon: Search, tone: '#3b82f6', ai: 'enrich' },
  { key: 'missingSeoDescription', label: 'Saknar SEO-beskrivning', icon: Search, tone: '#3b82f6', ai: 'enrich' },
];

export default function Opportunities({ onOpenProduct }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState('missingCategory');
  const [toast, setToast] = useState(null);
  // Bulk category AI
  const [catBusy, setCatBusy] = useState(false);
  const [catSug, setCatSug] = useState({}); // sku -> { path, id, productId, title }
  const [applying, setApplying] = useState(false);
  // Articles
  const [articles, setArticles] = useState(null);
  const [artBusy, setArtBusy] = useState(false);
  const [blogs, setBlogs] = useState(null);
  const [blogId, setBlogId] = useState('');
  const [genBusy, setGenBusy] = useState(''); // article key being generated
  const [genResult, setGenResult] = useState({}); // key -> { adminUrl, title }

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 4500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/seo/opportunities`);
      setReport(await r.json());
    } catch (e) { showToast('Kunde inte ladda: ' + e.message, 'error'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const suggestCategories = async () => {
    const items = report?.buckets?.missingCategory?.items || [];
    if (!items.length) return;
    setCatBusy(true);
    try {
      const batch = items.slice(0, 40);
      const r = await fetch(`${API_URL}/seo/suggest-categories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: batch.map(p => ({ sku: p.sku, title: p.title, product_type: p.product_type })) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel');
      const { shopifyCategories } = await import('../data/taxonomy.js');
      const map = {};
      for (const s of data.suggestions || []) {
        const src = batch.find(b => b.sku === s.sku);
        if (!src) continue;
        map[s.sku] = { path: s.category, id: matchCategoryId(s.category, shopifyCategories), productId: src.id, title: src.title };
      }
      setCatSug(map);
      showToast(`${Object.keys(map).length} kategoriförslag från AI (av ${batch.length})`);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setCatBusy(false); }
  };

  const applyCategories = async () => {
    const entries = Object.values(catSug).filter(s => s.id);
    if (!entries.length) return;
    setApplying(true);
    let ok = 0;
    for (const s of entries) {
      try {
        const r = await fetch(`${API_URL}/db/products/${s.productId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_category: s.id }),
        });
        if (r.ok) ok++;
      } catch { /* ignore */ }
    }
    setApplying(false);
    setCatSug({});
    showToast(`${ok} kategorier satta i PIM. Pushas till Shopify vid nästa synk/publicering.`);
    await load();
  };

  const suggestArticles = async () => {
    setArtBusy(true);
    try {
      const r = await fetch(`${API_URL}/seo/suggest-articles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel');
      setArticles(data.clusters || []);
      // Load target blogs for publishing drafts.
      if (!blogs) {
        try {
          const br = await fetch(`${API_URL}/seo/blogs`);
          const bd = await br.json();
          setBlogs(bd.blogs || []);
          if (bd.blogs?.[0]) setBlogId(String(bd.blogs[0].id));
        } catch { /* ignore */ }
      }
    } catch (e) { showToast(e.message, 'error'); }
    finally { setArtBusy(false); }
  };

  const generateArticle = async (key, a) => {
    setGenBusy(key);
    try {
      const r = await fetch(`${API_URL}/seo/generate-article`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: a.title, type: a.type, angle: a.angle, keywords: a.keywords || [], blogId: blogId || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Fel');
      setGenResult(prev => ({ ...prev, [key]: { adminUrl: data.adminUrl, title: data.article?.title, blog: data.blog?.title, faq: data.meta?.faqCount } }));
      showToast(`Utkast skapat i Shopify (${data.blog?.title || 'blogg'})`);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setGenBusy(''); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary,#888)' }}>Analyserar katalogen…</div>;
  if (!report) return null;

  return (
    <div>
      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 1000, padding: '10px 16px', borderRadius: 8,
          background: toast.type === 'error' ? '#7f1d1d' : '#14532d', color: '#fff', fontSize: 13, maxWidth: 380 }}>{toast.msg}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary,#888)' }}>{report.totalProducts} produkter analyserade</span>
        <button className="btn btn-ghost" onClick={load}><RefreshCw size={16} /> Uppdatera</button>
      </div>

      {/* Summary grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {BUCKETS.map(b => {
          const c = report.buckets[b.key]?.count || 0;
          const Icon = b.icon;
          return (
            <div key={b.key} className="settings-section" style={{ padding: 16, cursor: 'pointer', borderLeft: `3px solid ${c ? b.tone : '#22c55e'}` }}
              onClick={() => setOpen(open === b.key ? null : b.key)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary,#888)', fontSize: 12 }}>
                <Icon size={14} /> {b.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: c ? 'inherit' : '#22c55e' }}>{c || '✓'}</div>
            </div>
          );
        })}
      </div>

      {/* Expanded bucket */}
      {BUCKETS.filter(b => open === b.key).map(b => {
        const bucket = report.buckets[b.key];
        const items = bucket?.items || [];
        return (
          <div key={b.key} className="settings-section" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b.icon size={16} /> {b.label} ({bucket.count})</h3>
              {b.ai === 'category' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" onClick={suggestCategories} disabled={catBusy || !items.length}>
                    <Sparkles size={14} /> {catBusy ? 'Frågar AI…' : 'AI-föreslå kategorier (40)'}
                  </button>
                  {Object.keys(catSug).length > 0 && (
                    <button className="btn btn-primary" onClick={applyCategories} disabled={applying}>
                      <CheckCircle2 size={14} /> {applying ? 'Sätter…' : `Applicera ${Object.values(catSug).filter(s => s.id).length}`}
                    </button>
                  )}
                </div>
              )}
            </div>
            {b.ai === 'enrich' && (
              <p style={{ fontSize: 12, color: 'var(--text-secondary,#888)', marginBottom: 10 }}>
                Klicka en produkt → använd <b>Berika (AI)</b> i produktvyn för att fylla i automatiskt.
              </p>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table className="margin-table">
                <thead><tr><th>Produkt</th><th>SKU</th><th>Typ</th>{b.ai === 'category' && <th>AI-förslag</th>}</tr></thead>
                <tbody>
                  {items.slice(0, 100).map(p => {
                    const sug = catSug[p.sku];
                    return (
                      <tr key={p.id}>
                        <td style={{ cursor: 'pointer', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          onClick={() => onOpenProduct?.(p.id)}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{p.title} <ExternalLink size={11} /></span>
                        </td>
                        <td><code style={{ fontSize: 12 }}>{p.sku || '—'}</code></td>
                        <td style={{ fontSize: 12, color: 'var(--text-secondary,#888)' }}>{p.product_type || '—'}</td>
                        {b.ai === 'category' && (
                          <td style={{ fontSize: 12 }}>
                            {sug ? (sug.id
                              ? <span style={{ color: '#22c55e' }}>{sug.path}</span>
                              : <span style={{ color: '#f59e0b' }}>{sug.path} (ingen match)</span>) : '—'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {items.length > 100 && <p style={{ fontSize: 12, color: 'var(--text-secondary,#888)', marginTop: 8 }}>Visar 100 av {bucket.count}.</p>}
          </div>
        );
      })}

      {/* Article suggestions */}
      <div className="settings-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Lightbulb size={16} /> Artiklar för topical authority</h3>
          <button className="btn btn-primary" onClick={suggestArticles} disabled={artBusy}>
            <Sparkles size={14} /> {artBusy ? 'Genererar…' : 'Föreslå artiklar (AI)'}
          </button>
        </div>
        {!articles && <p style={{ fontSize: 13, color: 'var(--text-secondary,#888)' }}>AI föreslår artiklar utifrån ditt faktiska sortiment (produkttyper + kategorier). Klicka sedan "Generera artikel" så skrivs en färdig artikel i butikens ton och skapas som <b>utkast</b> i Shopify (internlänkar, FAQ/AEO, rätt SEO, inga tankstreck). Senare vässas urvalet av Search Console-data.</p>}

        {articles && blogs && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
            <span style={{ color: 'var(--text-secondary,#888)' }}>Publicera utkast till blogg:</span>
            <select className="form-input" style={{ width: 220 }} value={blogId} onChange={e => setBlogId(e.target.value)}>
              {blogs.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
          </div>
        )}

        {articles && articles.map((cl, ci) => (
          <div key={ci} style={{ marginBottom: 16 }}>
            <h4 style={{ margin: '8px 0', color: 'var(--accent)' }}>{cl.cluster}</h4>
            <div style={{ display: 'grid', gap: 8 }}>
              {(cl.articles || []).map((a, ai) => {
                const key = `${ci}-${ai}`;
                const res = genResult[key];
                return (
                  <div key={ai} className="settings-section" style={{ padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{a.title}</strong>
                      <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--bg-secondary,#222)', color: 'var(--text-secondary,#aaa)' }}>{a.type}</span>
                      <div style={{ marginLeft: 'auto' }}>
                        {res ? (
                          <a href={res.adminUrl} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                            <CheckCircle2 size={14} /> Utkast skapat – öppna
                          </a>
                        ) : (
                          <button className="btn btn-primary" onClick={() => generateArticle(key, a)} disabled={!!genBusy}>
                            <Sparkles size={14} /> {genBusy === key ? 'Skriver…' : 'Generera artikel (draft)'}
                          </button>
                        )}
                      </div>
                    </div>
                    {a.angle && <p style={{ fontSize: 12, color: 'var(--text-secondary,#888)', margin: '4px 0' }}>{a.angle}</p>}
                    {a.keywords?.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {a.keywords.map((k, ki) => <span key={ki} style={{ fontSize: 11, color: 'var(--text-secondary,#888)' }}>#{k}</span>)}
                      </div>
                    )}
                    {res && <p style={{ fontSize: 12, color: '#22c55e', marginTop: 6 }}>Skapat som utkast i "{res.blog}" · {res.faq || 0} FAQ-frågor (AEO)</p>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
