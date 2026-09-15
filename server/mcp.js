// Verktygslager för AI-assistenter (Martinas ChatGPT/Claude): blogg,
// skrivguide, ångra och datadrivet innehåll. Samma operationer exponeras på
// två sätt:
//   1. MCP  — POST /mcp/<MCP_SECRET>  (Claude, ChatGPT Pro/Business)
//   2. REST — /actions/* + OpenAPI     (Custom GPT med Actions, funkar på Plus)
// All logik bor i buildOps(); transporterna är tunna omslag. Endast blogg/
// skrivguide/läsdata — inga priser, ordrar eller inställningar. Nya artiklar
// skapas som UTKAST om inte `publicera` uttryckligen sätts, varje skrivning
// loggas med före-läge och kan ångras.

import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { db, supabase } from './db.js';
import shopifySync from './shopify.js';
import * as googleSeo from './services/google-seo.js';
import * as shopifySales from './services/shopify-sales.js';
import * as priceHistory from './services/price-history.js';

// Startregler — växer via spara_lardom.
const DEFAULT_RULES = [
  'Skriv på naturlig, varm svenska — aldrig översatt engelska ("unna dig", "must-have" och liknande undviks).',
  'Tonen är personlig och jordnära, som en kunnig vän med känsla för skandinavisk heminredning. Inte säljig.',
  'Rubriker: en tydlig huvudrubrik (sätts som titel), mellanrubriker som <h2>, aldrig <h1> i brödtexten.',
  'Stycken korta (2–4 meningar). Använd punktlistor när det passar.',
  'Länka naturligt till 2–4 produkter i löptexten med fullständiga URL:er (hämta via produkt_sok). Aldrig påhittade länkar.',
  'Mått skrivs som Ø12 × H23 cm. Priser nämns inte i bloggtexter (de ändras).',
  'Avsluta med en mjuk uppmaning, t.ex. att utforska en kollektion — inte "KÖP NU".',
  'Artikeln ska vara 400–800 ord och svara på en fråga läsaren faktiskt har (AEO): tänk "hur", "vilken", "när".',
];

const gid = (id, type) => String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${String(id).trim()}`;
const numId = (g) => String(g).split('/').pop();
const ymdAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export async function getStore() {
  const stores = await db.getStores();
  const store = (stores || []).find(s => s.access_token);
  if (!store) throw new Error('Ingen Shopify-kopplad butik i PIM');
  return store;
}

async function getGuide(store) {
  const wg = store.settings?.writing_guide || {};
  return { rules: Array.isArray(wg.rules) && wg.rules.length ? wg.rules : DEFAULT_RULES.map((text, i) => ({ id: `std-${i + 1}`, text, source: 'standard' })), updated_at: wg.updated_at || null };
}

async function saveGuide(store, rules) {
  const settings = { ...(store.settings || {}), writing_guide: { rules, updated_at: new Date().toISOString() } };
  const { error } = await supabase.from('stores').update({ settings }).eq('id', store.id);
  if (error) throw new Error(error.message);
  store.settings = settings;
}

const publicUrl = (store, path) => `https://${store.custom_domain || store.domain}${path}`;
const adminUrl = (store, path) => `https://admin.shopify.com/store/${String(store.domain).replace('.myshopify.com', '')}${path}`;

const ARTICLE_FIELDS = 'id title handle isPublished publishedAt tags summary blog { id title handle }';
const UNDOABLE = ['blog_article_created', 'blog_article_updated', 'writing_rule_added', 'writing_rule_removed'];

// ============================================================
// Operationerna — delas av MCP och REST/Actions. Kastar Error vid fel.
// ============================================================
export function buildOps(store) {
  const client = shopifySync.getClient(store);

  const logga = async (action, desc, changes) => {
    try {
      const { data } = await supabase.from('activity_log')
        .insert({ store_id: store.id, action, entity_type: 'store', entity_id: store.id, description: desc, changes })
        .select('id').single();
      return data?.id || null;
    } catch (_) { return null; }
  };
  const lasArtikel = async (id) => {
    const d = await client.graphql(`query($id: ID!) { article(id: $id) { ${ARTICLE_FIELDS} body author { name } } }`, { id: gid(id, 'Article') });
    return d.article;
  };
  const forstaBloggId = async () => numId((await client.graphql('{ blogs(first: 1) { nodes { id } } }')).blogs.nodes[0].id);

  return {
    async skrivguide() {
      const guide = await getGuide(store);
      const d = await client.graphql('{ blogs(first: 10) { nodes { id title handle articlesCount { count } } } }');
      return {
        butik: { namn: store.name, url: publicUrl(store, '') },
        regler: guide.rules,
        format: 'Artikelns brödtext skrivs som HTML (h2, h3, p, ul/li, a, strong). Ingen h1, ingen inline-CSS. Nya artiklar skapas som utkast — säg till användaren att granska i Shopify-admin innan publicering.',
        arbetsgang: '1) skrivguide → 2) blogg_lista (undvik dubbletter, hitta internlänkar) → 3) produkt_sok för produktlänkar → 4) skapa/uppdatera artikel. Vid stil- eller språkfeedback: spara den som lärdom så guiden växer.',
        bloggar: d.blogs.nodes.map(b => ({ id: numId(b.id), titel: b.title, handle: b.handle, antalArtiklar: b.articlesCount?.count ?? null })),
        senastUppdaterad: guide.updated_at,
      };
    },

    async sparaLardom({ regel }) {
      if (!regel || String(regel).trim().length < 5) throw new Error('Regeln är för kort');
      const guide = await getGuide(store);
      const rule = { id: crypto.randomBytes(4).toString('hex'), text: String(regel).trim().slice(0, 500), source: 'assistant', added_at: new Date().toISOString() };
      await saveGuide(store, [...guide.rules, rule]);
      const handelseId = await logga('writing_rule_added', `Skrivguide: ny regel — "${rule.text}"`, { rule });
      return { sparad: rule, antalRegler: guide.rules.length + 1, handelse_id: handelseId };
    },

    async taBortLardom({ regel_id }) {
      const guide = await getGuide(store);
      const removed = guide.rules.find(r => r.id === regel_id);
      if (!removed) throw new Error(`Ingen regel med id ${regel_id}`);
      await saveGuide(store, guide.rules.filter(r => r.id !== regel_id));
      const handelseId = await logga('writing_rule_removed', `Skrivguide: regel ${regel_id} borttagen`, { rule: removed });
      return { borttagen: regel_id, antalRegler: guide.rules.length - 1, handelse_id: handelseId };
    },

    async bloggLista({ blogg_id } = {}) {
      const d = await client.graphql(
        `query($id: ID!) { blog(id: $id) { id title handle articles(first: 100) { nodes { ${ARTICLE_FIELDS} } } } }`,
        { id: gid(blogg_id || await forstaBloggId(), 'Blog') });
      if (!d.blog) throw new Error('Bloggen hittades inte');
      const sorted = [...d.blog.articles.nodes].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      return {
        blogg: { id: numId(d.blog.id), titel: d.blog.title },
        artiklar: sorted.map(a => ({
          id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast',
          publicerad: a.publishedAt, taggar: a.tags, url: a.isPublished ? publicUrl(store, `/blogs/${d.blog.handle}/${a.handle}`) : null,
        })),
      };
    },

    async artikelLas({ artikel_id }) {
      const a = await lasArtikel(artikel_id);
      if (!a) throw new Error('Artikeln hittades inte');
      return { id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast', taggar: a.tags, sammanfattning: a.summary, forfattare: a.author?.name, html: a.body };
    },

    async artikelSkapa({ titel, html, sammanfattning, taggar, blogg_id, publicera, forfattare }) {
      if (!titel || String(titel).length < 5) throw new Error('Titel saknas eller är för kort');
      if (!html || String(html).length < 200) throw new Error('HTML-brödtexten är för kort (minst 200 tecken)');
      const blogGid = gid(blogg_id || await forstaBloggId(), 'Blog');
      const m = await client.graphql(
        `mutation($article: ArticleCreateInput!) { articleCreate(article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { article: { blogId: blogGid, title: titel, body: html, summary: sammanfattning || undefined, tags: taggar || undefined, isPublished: publicera === true, author: { name: forfattare || 'Lumeno Home' } } });
      const errs = m.articleCreate?.userErrors || [];
      if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
      const a = m.articleCreate.article;
      const handelseId = await logga('blog_article_created', `Blogginlägg ${publicera ? 'publicerat' : 'skapat som utkast'} via assistent: "${a.title}"`, { articleId: numId(a.id), published: !!publicera });
      return {
        skapad: true, id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast', handelse_id: handelseId,
        adminUrl: adminUrl(store, `/content/articles/${numId(a.id)}`),
        webbUrl: a.isPublished ? publicUrl(store, `/blogs/${a.blog.handle}/${a.handle}`) : null,
        notera: a.isPublished ? undefined : 'Utkast — be användaren granska via adminUrl och publicera där, eller uppdatera med publicera=true.',
      };
    },

    async artikelUppdatera({ artikel_id, titel, html, sammanfattning, taggar, publicera }) {
      const article = {};
      if (titel !== undefined) article.title = titel;
      if (html !== undefined) article.body = html;
      if (sammanfattning !== undefined) article.summary = sammanfattning;
      if (taggar !== undefined) article.tags = taggar;
      if (publicera !== undefined) article.isPublished = publicera;
      if (!Object.keys(article).length) throw new Error('Inget att uppdatera');
      const before = await lasArtikel(artikel_id);
      if (!before) throw new Error('Artikeln hittades inte');
      const m = await client.graphql(
        `mutation($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { id: gid(artikel_id, 'Article'), article });
      const errs = m.articleUpdate?.userErrors || [];
      if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
      const a = m.articleUpdate.article;
      const handelseId = await logga('blog_article_updated', `Blogginlägg uppdaterat via assistent: "${a.title}"${publicera === true ? ' (publicerat)' : publicera === false ? ' (avpublicerat)' : ''}`, {
        articleId: numId(a.id), fields: Object.keys(article),
        before: { title: before.title, body: before.body, summary: before.summary, tags: before.tags, isPublished: before.isPublished },
      });
      return {
        uppdaterad: true, id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast', handelse_id: handelseId,
        adminUrl: adminUrl(store, `/content/articles/${numId(a.id)}`),
        webbUrl: a.isPublished ? publicUrl(store, `/blogs/${a.blog.handle}/${a.handle}`) : null,
      };
    },

    async produktSok({ sokord }) {
      if (!sokord || String(sokord).length < 2) throw new Error('Ange minst två tecken');
      const s = String(sokord).replace(/[%_,()]/g, ' ').trim();
      const { data, error } = await supabase.from('products')
        .select('title, handle, sku, status, product_type')
        .eq('store_id', store.id).eq('status', 'active')
        .or(`title.ilike.%${s}%,sku.ilike.%${s}%,product_type.ilike.%${s}%`)
        .limit(12);
      if (error) throw new Error(error.message);
      return {
        traffar: (data || []).map(p => ({ namn: p.title, typ: p.product_type, url: publicUrl(store, `/products/${p.handle}`) })),
        tips: (data || []).length ? undefined : 'Inga träffar — prova ett kortare sökord.',
      };
    },

    async historik({ antal } = {}) {
      const { data, error } = await supabase.from('activity_log')
        .select('id, action, description, changes, created_at')
        .eq('store_id', store.id).in('action', UNDOABLE)
        .order('created_at', { ascending: false }).limit(Math.min(50, Math.max(1, Number(antal) || 10)));
      if (error) throw new Error(error.message);
      return (data || []).map(r => ({
        handelse_id: r.id, nar: r.created_at, vad: r.description,
        angerbar: !r.changes?.undone_at, ...(r.changes?.undone_at ? { angrad: r.changes.undone_at } : {}),
      }));
    },

    async angra({ handelse_id }) {
      const { data: ev, error } = await supabase.from('activity_log').select('*').eq('id', handelse_id).eq('store_id', store.id).single();
      if (error || !ev) throw new Error('Händelsen hittades inte');
      if (!UNDOABLE.includes(ev.action)) throw new Error(`Händelsen (${ev.action}) går inte att ångra`);
      if (ev.changes?.undone_at) throw new Error(`Redan ångrad ${ev.changes.undone_at}`);

      let result;
      if (ev.action === 'blog_article_created') {
        const m = await client.graphql('mutation($id: ID!) { articleDelete(id: $id) { deletedArticleId userErrors { message } } }', { id: gid(ev.changes.articleId, 'Article') });
        const errs = m.articleDelete?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
        result = { raderadArtikel: ev.changes.articleId };
      } else if (ev.action === 'blog_article_updated') {
        const b = ev.changes.before;
        if (!b) throw new Error('Före-läget saknas för den här händelsen (äldre ändring)');
        const m = await client.graphql(
          `mutation($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } } }`,
          { id: gid(ev.changes.articleId, 'Article'), article: { title: b.title, body: b.body, summary: b.summary ?? undefined, tags: b.tags ?? undefined, isPublished: b.isPublished } });
        const errs = m.articleUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
        result = { aterstalldArtikel: ev.changes.articleId, titel: b.title, status: b.isPublished ? 'publicerad' : 'utkast' };
      } else if (ev.action === 'writing_rule_added') {
        const guide = await getGuide(store);
        await saveGuide(store, guide.rules.filter(r => r.id !== ev.changes.rule?.id));
        result = { borttagenRegel: ev.changes.rule?.id };
      } else if (ev.action === 'writing_rule_removed') {
        const guide = await getGuide(store);
        await saveGuide(store, [...guide.rules, ev.changes.rule]);
        result = { aterstalldRegel: ev.changes.rule?.id };
      }

      await supabase.from('activity_log').update({ changes: { ...(ev.changes || {}), undone_at: new Date().toISOString() } }).eq('id', ev.id);
      await logga('mcp_undo', `Ångrade: ${ev.description}`, { undid: ev.id });
      return { angrad: true, handelse: ev.description, ...result };
    },

    async sokdata({ dagar } = {}) {
      const siteUrl = store.settings?.google?.gsc_site_url;
      if (!googleSeo.isConfigured() || !siteUrl) throw new Error('Search Console är inte kopplad i PIM ännu (SEO & Insikter).');
      const d = Math.min(90, Math.max(7, Number(dagar) || 28));
      const rows = await googleSeo.gscSearchAnalytics({ siteUrl, startDate: ymdAgo(d), endDate: ymdAgo(1), dimensions: ['query'], rowLimit: 100 });
      const fm = r => ({ sokfraga: r.query, klick: r.clicks, visningar: r.impressions, ctr: Math.round(r.ctr * 1000) / 10 + ' %', position: Math.round(r.position * 10) / 10 });
      return {
        period: `${ymdAgo(d)} – ${ymdAgo(1)}`,
        toppSokfragor: rows.slice(0, 25).map(fm),
        artikelmojligheter: rows.filter(r => r.impressions >= 30 && (r.position > 8 || (r.ctr < 0.02 && r.position > 3))).slice(0, 20).map(fm),
        tips: 'En bra artikel svarar på sökfrågan i rubriken och första stycket. Kolla blogg_lista först.',
      };
    },

    async trafikdata({ dagar } = {}) {
      const g = store.settings?.google || {};
      if (!googleSeo.isConfigured() || (!g.gsc_site_url && !g.ga4_property_id)) throw new Error('Google-kopplingen är inte klar i PIM ännu (SEO & Insikter).');
      const d = Math.min(90, Math.max(7, Number(dagar) || 28));
      const out = { period: `${ymdAgo(d)} – ${ymdAgo(1)}` };
      if (g.ga4_property_id) {
        try {
          const rep = await googleSeo.ga4RunReport({ propertyId: g.ga4_property_id, startDate: `${d}daysAgo`, endDate: 'yesterday', metrics: ['sessions', 'ecommercePurchases', 'purchaseRevenue'] });
          const r = rep.rows[0] || {};
          out.ga4 = { sessioner: r.sessions || 0, kop: r.ecommercePurchases || 0, intakt: Math.round(r.purchaseRevenue || 0) + ' kr' };
        } catch (e) { out.ga4 = { fel: e.message }; }
      }
      if (g.gsc_site_url) {
        try {
          const pages = await googleSeo.gscSearchAnalytics({ siteUrl: g.gsc_site_url, startDate: ymdAgo(d), endDate: ymdAgo(1), dimensions: ['page'], rowLimit: 20 });
          out.toppsidorFranGoogle = pages.map(p => ({ sida: p.page, klick: p.clicks, visningar: p.impressions }));
        } catch (e) { out.toppsidorFranGoogle = { fel: e.message }; }
      }
      return out;
    },

    async toppsaljare({ dagar } = {}) {
      const d = Math.min(365, Math.max(7, Number(dagar) || 30));
      const sales = await shopifySales.getSales(store, { days: d });
      const skus = sales.top.map(t => t.sku).filter(Boolean);
      const { data: prods } = await supabase.from('products').select('sku, handle, status').eq('store_id', store.id).in('sku', skus.length ? skus : ['-']);
      const bySku = new Map((prods || []).map(p => [p.sku, p]));
      return {
        period: `senaste ${d} dagarna`,
        totalt: { ordrar: sales.orders30, omsattning: sales.revenue30 + ' kr' },
        toppsaljare: sales.top.map(t => {
          const p = bySku.get(t.sku);
          return { namn: t.title, antal: t.units, omsattning: t.revenue + ' kr', url: p?.handle ? publicUrl(store, `/products/${p.handle}`) : null, status: p?.status };
        }),
      };
    },

    async nyhetsbrev({ dagar } = {}) {
      const d = Math.min(90, Math.max(7, Number(dagar) || 30));
      const [sales, rea, nya] = await Promise.all([
        shopifySales.getSales(store, { days: d }).catch(e => ({ error: e.message, top: [] })),
        priceHistory.saleReport(store.id).catch(e => ({ error: e.message, items: [] })),
        supabase.from('products').select('title, handle, created_at').eq('store_id', store.id).eq('status', 'active').or('is_staged.is.null,is_staged.eq.false').order('created_at', { ascending: false }).limit(8),
      ]);
      const skus = (sales.top || []).map(t => t.sku).filter(Boolean);
      const { data: prods } = await supabase.from('products').select('sku, handle').eq('store_id', store.id).in('sku', skus.length ? skus : ['-']);
      const bySku = new Map((prods || []).map(p => [p.sku, p]));
      return {
        toppsaljare: (sales.top || []).slice(0, 6).map(t => ({ namn: t.title, antal: t.units, url: bySku.get(t.sku)?.handle ? publicUrl(store, `/products/${bySku.get(t.sku).handle}`) : null })),
        nyaProdukter: (nya.data || []).map(p => ({ namn: p.title, url: publicUrl(store, `/products/${p.handle}`), inkom: String(p.created_at).slice(0, 10) })),
        pagaendeRea: (rea.items || []).slice(0, 10).map(r => ({ namn: r.title, pris: r.price + ' kr', ordinarie: r.compareAt + ' kr', lagsta30dgr: r.displayLowest + ' kr' })),
        viktigt: 'Vid reapriser i nyhetsbrevet MÅSTE "Lägsta pris senaste 30 dagarna" anges (prisinformationslagen) — använd lagsta30dgr-värdet. Skriv enligt skrivguiden och ge texten till användaren för utskick.',
      };
    },
  };
}

// ============================================================
// MCP-transporten
// ============================================================
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `FEL: ${msg}` }], isError: true });

const TOOLS = [
  { name: 'skrivguide', op: 'skrivguide', shape: {}, desc: 'Hämta Lumeno Homes skrivguide (tonalitet, språkregler, format) och listan över bloggar. LÄS ALLTID denna innan du skriver eller redigerar ett blogginlägg, och följ varje regel.' },
  { name: 'spara_lardom', op: 'sparaLardom', shape: { regel: z.string().min(5).max(500).describe('Regeln, formulerad kort och generellt') }, desc: 'Spara en ny regel/lärdom i skrivguiden. Används när användaren ger stil-, tonalitets- eller språkfeedback, så att alla framtida texter följer den.' },
  { name: 'ta_bort_lardom', op: 'taBortLardom', shape: { regel_id: z.string() }, desc: 'Ta bort en regel ur skrivguiden (id från skrivguide-verktyget).' },
  { name: 'blogg_lista', op: 'bloggLista', shape: { blogg_id: z.string().optional() }, desc: 'Lista bloggens artiklar — undvik dubbletter, hitta internlänkar och artikel-id för redigering.' },
  { name: 'artikel_las', op: 'artikelLas', shape: { artikel_id: z.string() }, desc: 'Hämta en artikels fulla innehåll (HTML) inför redigering.' },
  { name: 'artikel_skapa', op: 'artikelSkapa', shape: { titel: z.string().min(5).max(255), html: z.string().min(200), sammanfattning: z.string().max(500).optional(), taggar: z.array(z.string()).max(10).optional(), blogg_id: z.string().optional(), publicera: z.boolean().optional(), forfattare: z.string().optional() }, desc: 'Skapa ett nytt blogginlägg i Shopify. UTKAST om inte publicera=true uttryckligen begärts. Följ skrivguiden. Svara med admin-länken.' },
  { name: 'artikel_uppdatera', op: 'artikelUppdatera', shape: { artikel_id: z.string(), titel: z.string().min(5).max(255).optional(), html: z.string().min(50).optional(), sammanfattning: z.string().max(500).optional(), taggar: z.array(z.string()).max(10).optional(), publicera: z.boolean().optional() }, desc: 'Uppdatera ett blogginlägg och/eller publicera/avpublicera. Läs artikeln först så inget tappas.' },
  { name: 'produkt_sok', op: 'produktSok', shape: { sokord: z.string().min(2) }, desc: 'Sök produkter (namn/SKU) för att länka till dem i artiklar.' },
  { name: 'historik', op: 'historik', shape: { antal: z.number().int().min(1).max(50).optional() }, desc: 'Visa senaste ändringarna gjorda via assistenten, med händelse-id för angra.' },
  { name: 'angra', op: 'angra', shape: { handelse_id: z.string() }, desc: 'Ångra en tidigare ändring: skapad artikel raderas, uppdaterad återställs, guideregler läggs tillbaka/tas bort.' },
  { name: 'sokdata', op: 'sokdata', shape: { dagar: z.number().int().min(7).max(90).optional() }, desc: 'Search Console-data med artikelmöjligheter (många visningar, svag position/CTR).' },
  { name: 'trafikdata', op: 'trafikdata', shape: { dagar: z.number().int().min(7).max(90).optional() }, desc: 'GA4-totaler och mest besökta sidorna från Google-sök.' },
  { name: 'toppsaljare', op: 'toppsaljare', shape: { dagar: z.number().int().min(7).max(365).optional() }, desc: 'Bäst säljande produkter med butiks-URL:er för perioden.' },
  { name: 'nyhetsbrev_underlag', op: 'nyhetsbrev', shape: { dagar: z.number().int().min(7).max(90).optional() }, desc: 'Underlag för nyhetsbrev: toppsäljare, nyheter, pågående rea med lagenligt "lägsta pris 30 dagar". Skickar inget själv.' },
];

function buildServer(store) {
  const mcp = new McpServer({ name: 'lumeno-pim', version: '1.1.0' });
  const ops = buildOps(store);
  for (const t of TOOLS) {
    mcp.tool(t.name, t.desc, t.shape, async (args) => {
      try { return ok(await ops[t.op](args || {})); }
      catch (e) { return fail(e.message); }
    });
  }
  return mcp;
}

const router = express.Router();
router.post('/:secret', async (req, res) => {
  try {
    const secret = process.env.MCP_SECRET || '';
    const given = String(req.params.secret || '');
    const authorized = secret.length >= 24 && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

    const store = await getStore();
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});
router.get('/:secret', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP — använd POST' }));
router.delete('/:secret', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP — använd POST' }));

export default router;
