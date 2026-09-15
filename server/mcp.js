// MCP-server för Lumeno PIM — låter ChatGPT (och Claude) skriva och redigera
// blogginlägg direkt i Shopify, med en levande skrivguide som växer via
// sparade lärdomar. Nås på POST /mcp/<MCP_SECRET> (streamable HTTP, stateless
// — fungerar på Vercel serverless). Exponerar ENDAST blogg + skrivguide +
// produktsök; inga priser, ordrar eller inställningar.
//
// Säkerhet: den hemliga nyckeln i URL:en är enda spärren (ChatGPT:s
// connectors stödjer inte egna headers utan OAuth), så nyckeln ska vara lång
// och alla skrivningar loggas i activity_log. Nya artiklar skapas som UTKAST
// om inte `publicera` uttryckligen sätts.

import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { db, supabase } from './db.js';
import shopifySync from './shopify.js';

const router = express.Router();

// Startregler — Martina bygger vidare med spara_lardom.
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

async function getStore() {
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

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `FEL: ${msg}` }], isError: true });

const ARTICLE_FIELDS = 'id title handle isPublished publishedAt tags summary blog { id title handle }';

function buildServer(store) {
  const mcp = new McpServer({ name: 'lumeno-pim', version: '1.0.0' });
  const client = shopifySync.getClient(store);
  const logga = (action, desc, changes) => db.logActivity(action, 'store', store.id, desc, changes, store.id).catch(() => {});

  mcp.tool(
    'skrivguide',
    'Hämta Lumeno Homes skrivguide (tonalitet, språkregler, format) och listan över bloggar. LÄS ALLTID denna innan du skriver eller redigerar ett blogginlägg, och följ varje regel.',
    {},
    async () => {
      const guide = await getGuide(store);
      const d = await client.graphql('{ blogs(first: 10) { nodes { id title handle articlesCount { count } } } }');
      return ok({
        butik: { namn: store.name, url: publicUrl(store, '') },
        regler: guide.rules,
        format: 'Artikelns brödtext skrivs som HTML (h2, h3, p, ul/li, a, strong). Ingen h1, ingen inline-CSS. Nya artiklar skapas som utkast — säg till användaren att granska i Shopify-admin innan publicering.',
        arbetsgang: '1) skrivguide → 2) blogg_lista (undvik dubbletter, hitta internlänkar) → 3) produkt_sok för produktlänkar → 4) artikel_skapa/artikel_uppdatera. Om användaren ger feedback på stil eller språk: spara den med spara_lardom så guiden växer.',
        bloggar: d.blogs.nodes.map(b => ({ id: numId(b.id), titel: b.title, handle: b.handle, antalArtiklar: b.articlesCount?.count ?? null })),
        senastUppdaterad: guide.updated_at,
      });
    }
  );

  mcp.tool(
    'spara_lardom',
    'Spara en ny regel/lärdom i skrivguiden (t.ex. "vi skriver aldrig \'unna dig\'"). Används när användaren ger stil-, tonalitets- eller språkfeedback, så att alla framtida texter följer den.',
    { regel: z.string().min(5).max(500).describe('Regeln, formulerad kort och generellt') },
    async ({ regel }) => {
      const guide = await getGuide(store);
      const rule = { id: crypto.randomBytes(4).toString('hex'), text: regel.trim(), source: 'chatgpt', added_at: new Date().toISOString() };
      await saveGuide(store, [...guide.rules, rule]);
      await logga('writing_rule_added', `Skrivguide: ny regel — "${rule.text}"`, { rule });
      return ok({ sparad: rule, antalRegler: guide.rules.length + 1 });
    }
  );

  mcp.tool(
    'ta_bort_lardom',
    'Ta bort en regel ur skrivguiden (ange regelns id från skrivguide-verktyget). Används när en regel var fel eller inte längre gäller.',
    { regel_id: z.string().describe('Regelns id') },
    async ({ regel_id }) => {
      const guide = await getGuide(store);
      const next = guide.rules.filter(r => r.id !== regel_id);
      if (next.length === guide.rules.length) return fail(`Ingen regel med id ${regel_id}`);
      await saveGuide(store, next);
      await logga('writing_rule_removed', `Skrivguide: regel ${regel_id} borttagen`, { regel_id });
      return ok({ borttagen: regel_id, antalRegler: next.length });
    }
  );

  mcp.tool(
    'blogg_lista',
    'Lista bloggens artiklar (titel, handle, status, taggar) — använd för att undvika dubbletter, hitta artiklar att internlänka till och för att hitta id på artiklar som ska redigeras.',
    { blogg_id: z.string().optional().describe('Bloggens id (utelämna för första bloggen)') },
    async ({ blogg_id }) => {
      const d = await client.graphql(
        `query($id: ID!) { blog(id: $id) { id title handle articles(first: 100) { nodes { ${ARTICLE_FIELDS} } } } }`,
        { id: gid(blogg_id || (await client.graphql('{ blogs(first: 1) { nodes { id } } }')).blogs.nodes[0].id, 'Blog') });
      if (!d.blog) return fail('Bloggen hittades inte');
      const sorted = [...d.blog.articles.nodes].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      return ok({
        blogg: { id: numId(d.blog.id), titel: d.blog.title },
        artiklar: sorted.map(a => ({
          id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast',
          publicerad: a.publishedAt, taggar: a.tags, url: a.isPublished ? publicUrl(store, `/blogs/${d.blog.handle}/${a.handle}`) : null,
        })),
      });
    }
  );

  mcp.tool(
    'artikel_las',
    'Hämta en artikels fulla innehåll (HTML) inför redigering.',
    { artikel_id: z.string().describe('Artikelns id (från blogg_lista)') },
    async ({ artikel_id }) => {
      const d = await client.graphql(`query($id: ID!) { article(id: $id) { ${ARTICLE_FIELDS} body author { name } } }`, { id: gid(artikel_id, 'Article') });
      if (!d.article) return fail('Artikeln hittades inte');
      const a = d.article;
      return ok({ id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast', taggar: a.tags, sammanfattning: a.summary, forfattare: a.author?.name, html: a.body });
    }
  );

  mcp.tool(
    'artikel_skapa',
    'Skapa ett nytt blogginlägg i Shopify. Skapas som UTKAST om inte publicera=true uttryckligen begärts av användaren. Följ skrivguiden. Svara alltid användaren med admin-länken för granskning.',
    {
      titel: z.string().min(5).max(255),
      html: z.string().min(200).describe('Brödtexten som HTML (h2/h3/p/ul/a, ingen h1)'),
      sammanfattning: z.string().max(500).optional().describe('Kort utdrag/excerpt'),
      taggar: z.array(z.string()).max(10).optional(),
      blogg_id: z.string().optional().describe('Bloggens id (utelämna för första bloggen)'),
      publicera: z.boolean().optional().describe('true = publicera direkt (endast om användaren uttryckligen bett om det), annars utkast'),
      forfattare: z.string().optional().describe('Författarnamn, standard "Lumeno Home"'),
    },
    async ({ titel, html, sammanfattning, taggar, blogg_id, publicera, forfattare }) => {
      const blogGid = gid(blogg_id || numId((await client.graphql('{ blogs(first: 1) { nodes { id } } }')).blogs.nodes[0].id), 'Blog');
      const m = await client.graphql(
        `mutation($article: ArticleCreateInput!) { articleCreate(article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { article: { blogId: blogGid, title: titel, body: html, summary: sammanfattning || undefined, tags: taggar || undefined, isPublished: publicera === true, author: { name: forfattare || 'Lumeno Home' } } });
      const errs = m.articleCreate?.userErrors || [];
      if (errs.length) return fail(errs.map(e => e.message).join('; '));
      const a = m.articleCreate.article;
      await logga('blog_article_created', `Blogginlägg ${publicera ? 'publicerat' : 'skapat som utkast'} via MCP: "${a.title}"`, { articleId: numId(a.id), published: !!publicera });
      return ok({
        skapad: true, id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast',
        adminUrl: adminUrl(store, `/content/articles/${numId(a.id)}`),
        webbUrl: a.isPublished ? publicUrl(store, `/blogs/${a.blog.handle}/${a.handle}`) : null,
        notera: a.isPublished ? undefined : 'Utkast — be användaren granska via adminUrl och publicera där, eller uppdatera med publicera=true.',
      });
    }
  );

  mcp.tool(
    'artikel_uppdatera',
    'Uppdatera ett befintligt blogginlägg (titel, HTML, utdrag, taggar) och/eller publicera/avpublicera det. Läs artikeln med artikel_las först så inget innehåll tappas.',
    {
      artikel_id: z.string(),
      titel: z.string().min(5).max(255).optional(),
      html: z.string().min(50).optional(),
      sammanfattning: z.string().max(500).optional(),
      taggar: z.array(z.string()).max(10).optional(),
      publicera: z.boolean().optional().describe('true = publicera, false = gör till utkast, utelämna = oförändrat'),
    },
    async ({ artikel_id, titel, html, sammanfattning, taggar, publicera }) => {
      const article = {};
      if (titel !== undefined) article.title = titel;
      if (html !== undefined) article.body = html;
      if (sammanfattning !== undefined) article.summary = sammanfattning;
      if (taggar !== undefined) article.tags = taggar;
      if (publicera !== undefined) article.isPublished = publicera;
      if (!Object.keys(article).length) return fail('Inget att uppdatera');
      const m = await client.graphql(
        `mutation($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ${ARTICLE_FIELDS} } userErrors { field message } } }`,
        { id: gid(artikel_id, 'Article'), article });
      const errs = m.articleUpdate?.userErrors || [];
      if (errs.length) return fail(errs.map(e => e.message).join('; '));
      const a = m.articleUpdate.article;
      await logga('blog_article_updated', `Blogginlägg uppdaterat via MCP: "${a.title}"${publicera === true ? ' (publicerat)' : publicera === false ? ' (avpublicerat)' : ''}`, { articleId: numId(a.id), fields: Object.keys(article) });
      return ok({
        uppdaterad: true, id: numId(a.id), titel: a.title, status: a.isPublished ? 'publicerad' : 'utkast',
        adminUrl: adminUrl(store, `/content/articles/${numId(a.id)}`),
        webbUrl: a.isPublished ? publicUrl(store, `/blogs/${a.blog.handle}/${a.handle}`) : null,
      });
    }
  );

  mcp.tool(
    'produkt_sok',
    'Sök produkter i butiken (namn eller SKU) för att länka till dem i artiklar. Returnerar namn och URL — länka bara till aktiva produkter.',
    { sokord: z.string().min(2).describe('Del av produktnamn eller SKU') },
    async ({ sokord }) => {
      const s = sokord.replace(/[%_,()]/g, ' ').trim();
      const { data, error } = await supabase.from('products')
        .select('title, handle, sku, status, product_type')
        .eq('store_id', store.id).eq('status', 'active')
        .or(`title.ilike.%${s}%,sku.ilike.%${s}%,product_type.ilike.%${s}%`)
        .limit(12);
      if (error) return fail(error.message);
      return ok({
        traffar: (data || []).map(p => ({ namn: p.title, typ: p.product_type, url: publicUrl(store, `/products/${p.handle}`) })),
        tips: (data || []).length ? undefined : 'Inga träffar — prova ett kortare sökord.',
      });
    }
  );

  return mcp;
}

// Streamable HTTP, stateless: en transport per request (serverless-vänligt).
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
// Sessions används inte (stateless) — GET/DELETE besvaras enligt spec.
router.get('/:secret', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP — använd POST' }));
router.delete('/:secret', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP — använd POST' }));

export default router;
