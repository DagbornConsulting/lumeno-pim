// REST-lager ("Actions") ovanpå samma operationer som MCP-servern — för
// Custom GPT i ChatGPT (fungerar på Plus, där egna MCP-anslutningar inte gör
// det). Auth: header X-API-Key = MCP_SECRET. OpenAPI-specen serveras öppet på
// /actions/openapi.json (innehåller inga hemligheter) så GPT-editorn kan
// importera den. Skrivande operationer är märkta x-openai-isConsequential så
// ChatGPT alltid frågar användaren innan de körs.

import express from 'express';
import crypto from 'crypto';
import { buildOps, getStore } from './mcp.js';

const router = express.Router();

const PROD_URL = 'https://lumeno-pim.vercel.app';

// --- OpenAPI-spec (öppen, importeras av GPT-editorn) ------------------------
const P = (props, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const S = { str: { type: 'string' }, int: { type: 'integer' }, bool: { type: 'boolean' }, arr: { type: 'array', items: { type: 'string' } } };
// GPT-editorns validator kräver `properties` på objektscheman och en
// components.schemas-sektion — svaren är fria JSON-objekt, så vi deklarerar
// ett tomt properties-objekt med additionalProperties.
const RESP = { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } } } };
const q = (name, desc, type = 'string') => ({ name, in: 'query', required: false, description: desc, schema: { type } });

const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Lumeno PIM Actions',
    version: '1.1.0',
    description: 'Bloggskrivande och butiksdata för Lumeno Home. Läs alltid skrivguiden innan du skriver. Nya artiklar skapas som utkast om inte publicering uttryckligen begärts.',
  },
  servers: [{ url: PROD_URL }],
  components: { schemas: {}, securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/actions/skrivguide': { get: { operationId: 'skrivguide', 'x-openai-isConsequential': false, summary: 'Hämta skrivguiden (tonalitet, regler, format) och blogglistan. Läs ALLTID denna före skrivande.', responses: RESP } },
    '/actions/lardom': { post: { operationId: 'sparaLardom', 'x-openai-isConsequential': true, summary: 'Spara en ny stil-/språkregel i skrivguiden utifrån användarens feedback.', requestBody: { required: true, content: { 'application/json': { schema: P({ regel: { ...S.str, description: 'Regeln, kort och generell' } }, ['regel']) } } }, responses: RESP } },
    '/actions/lardom-ta-bort': { post: { operationId: 'taBortLardom', 'x-openai-isConsequential': true, summary: 'Ta bort en regel ur skrivguiden (id från skrivguiden).', requestBody: { required: true, content: { 'application/json': { schema: P({ regel_id: S.str }, ['regel_id']) } } }, responses: RESP } },
    '/actions/blogg': { get: { operationId: 'bloggLista', 'x-openai-isConsequential': false, summary: 'Lista bloggens artiklar (id, titel, status, taggar) — för dubbelkoll, internlänkar och redigering.', parameters: [q('blogg_id', 'Bloggens id, utelämna för första bloggen')], responses: RESP } },
    '/actions/artikel': {
      get: { operationId: 'artikelLas', 'x-openai-isConsequential': false, summary: 'Hämta en artikels fulla HTML inför redigering.', parameters: [{ ...q('artikel_id', 'Artikelns id'), required: true }], responses: RESP },
      post: { operationId: 'artikelSkapa', 'x-openai-isConsequential': true, summary: 'Skapa ett nytt blogginlägg i Shopify (UTKAST om inte publicera=true uttryckligen begärts av användaren). Svara användaren med adminUrl för granskning.', requestBody: { required: true, content: { 'application/json': { schema: P({ titel: S.str, html: { ...S.str, description: 'Brödtext som HTML: h2/h3/p/ul/a, ingen h1, minst 200 tecken' }, sammanfattning: S.str, taggar: S.arr, blogg_id: S.str, publicera: { ...S.bool, description: 'true endast om användaren uttryckligen bett om publicering' }, forfattare: S.str }, ['titel', 'html']) } } }, responses: RESP },
    },
    '/actions/artikel-uppdatera': { post: { operationId: 'artikelUppdatera', 'x-openai-isConsequential': true, summary: 'Uppdatera ett befintligt blogginlägg och/eller publicera/avpublicera. Läs artikeln först (artikelLas) så inget innehåll tappas.', requestBody: { required: true, content: { 'application/json': { schema: P({ artikel_id: S.str, titel: S.str, html: S.str, sammanfattning: S.str, taggar: S.arr, publicera: S.bool }, ['artikel_id']) } } }, responses: RESP } },
    '/actions/produkter': { get: { operationId: 'produktSok', 'x-openai-isConsequential': false, summary: 'Sök produkter (namn/SKU) för att länka till dem i texter. Använd ALLTID dessa URL:er, hitta aldrig på länkar.', parameters: [{ ...q('sokord', 'Del av produktnamn eller SKU'), required: true }], responses: RESP } },
    '/actions/historik': { get: { operationId: 'historik', 'x-openai-isConsequential': false, summary: 'Senaste ändringarna gjorda via assistenten, med händelse-id för ångra.', parameters: [q('antal', 'Max antal, standard 10', 'integer')], responses: RESP } },
    '/actions/angra': { post: { operationId: 'angra', 'x-openai-isConsequential': true, summary: 'Ångra en tidigare ändring: skapad artikel raderas, uppdaterad återställs till före-läget, guideregler läggs tillbaka/tas bort.', requestBody: { required: true, content: { 'application/json': { schema: P({ handelse_id: S.str }, ['handelse_id']) } } }, responses: RESP } },
    '/actions/oversikt': { get: { operationId: 'butiksoversikt', 'x-openai-isConsequential': false, summary: 'Snabb överblick: antal produkter (totalt/aktiva/utkast), varianter, antal på rea, försäljning 30 dagar och bloggens storlek.', responses: RESP } },
    '/actions/sokdata': { get: { operationId: 'sokdata', 'x-openai-isConsequential': false, summary: 'Google Search Console: toppsökfrågor + artikelmöjligheter (många visningar, svag position/CTR).', parameters: [q('dagar', 'Period bakåt 7–90, standard 28', 'integer')], responses: RESP } },
    '/actions/trafik': { get: { operationId: 'trafikdata', 'x-openai-isConsequential': false, summary: 'GA4-totaler (sessioner, köp, intäkt) och mest besökta sidorna från Google-sök.', parameters: [q('dagar', 'Period bakåt 7–90, standard 28', 'integer')], responses: RESP } },
    '/actions/toppsaljare': { get: { operationId: 'toppsaljare', 'x-openai-isConsequential': false, summary: 'Bäst säljande produkter med butiks-URL:er för perioden.', parameters: [q('dagar', 'Period bakåt 7–365, standard 30', 'integer')], responses: RESP } },
    '/actions/nyhetsbrev': { get: { operationId: 'nyhetsbrevUnderlag', 'x-openai-isConsequential': false, summary: 'Underlag för nyhetsbrev: toppsäljare, nyinkomna produkter, pågående rea med lagenligt "lägsta pris 30 dagar" (måste anges vid reapriser). Skickar inget själv.', parameters: [q('dagar', 'Försäljningsperiod 7–90, standard 30', 'integer')], responses: RESP } },
  },
};

router.get('/openapi.json', (req, res) => res.json(OPENAPI));

// --- Auth (allt utom specen) ------------------------------------------------
router.use((req, res, next) => {
  const secret = process.env.MCP_SECRET || '';
  const given = String(req.get('x-api-key') || req.query.key || '');
  const authorized = secret.length >= 24 && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// --- Endpoints — tunna omslag runt buildOps ---------------------------------
const run = (opName, pickArgs) => async (req, res) => {
  try {
    const store = await getStore();
    const ops = buildOps(store);
    res.json(await ops[opName](pickArgs ? pickArgs(req) : {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

router.get('/skrivguide', run('skrivguide'));
router.post('/lardom', run('sparaLardom', r => r.body || {}));
router.post('/lardom-ta-bort', run('taBortLardom', r => r.body || {}));
router.get('/blogg', run('bloggLista', r => ({ blogg_id: r.query.blogg_id })));
router.get('/artikel', run('artikelLas', r => ({ artikel_id: r.query.artikel_id })));
router.post('/artikel', run('artikelSkapa', r => r.body || {}));
router.post('/artikel-uppdatera', run('artikelUppdatera', r => r.body || {}));
router.get('/produkter', run('produktSok', r => ({ sokord: r.query.sokord })));
router.get('/historik', run('historik', r => ({ antal: r.query.antal })));
router.post('/angra', run('angra', r => r.body || {}));
router.get('/oversikt', run('butiksoversikt'));
router.get('/sokdata', run('sokdata', r => ({ dagar: r.query.dagar })));
router.get('/trafik', run('trafikdata', r => ({ dagar: r.query.dagar })));
router.get('/toppsaljare', run('toppsaljare', r => ({ dagar: r.query.dagar })));
router.get('/nyhetsbrev', run('nyhetsbrev', r => ({ dagar: r.query.dagar })));

export default router;
