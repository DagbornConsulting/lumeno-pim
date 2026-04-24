# Todas PIM — Statusöversikt & TODO

> Uppdaterad: 2026-03-31

---

## Byggt & klart

### Frontend — Produktflikar (14 st)
- [x] Allmänt (title, handle, vendor, type, status, taggar, pris, SKU/EAN)
- [x] Beskrivning (källmaterial, kort beskrivning, produktbeskrivning med rich text editor, AI-generering)
- [x] AI-innehåll (snabbfakta/agent summary, kort ingress, specifikationer, FAQ, användningsområden, "Generera allt")
- [x] Bilder (drag-and-drop ordning, alt-text, bildoptimering via Supabase Storage)
- [x] Varianter (placeholder — byggs om)
- [x] Lager (visar lagerstatus per butik/location)
- [x] SEO (SEO-titel med teckenräknare, meta description med teckenräknare)
- [x] Schema (JSON-LD editor, schema-statuschecklist)
- [x] Sök & Upptäck (söktermer/synonymer, filterattribut, relaterade produkter, collections)
- [x] Metafält (systemfält + egna fält, CRUD, AI-förslag, synk till Shopify)
- [x] Google Shopping (Shopify taxonomy-picker med 12 378 kategorier, attribut)
- [x] Google Ads (custom labels 0-4, ads grouping, redirect, promotion ID, produkthöjdpunkter)
- [x] Kvalitet (100-poängs scorer, 19 kriterier, 4 grupper, färgkodad)
- [x] Publicera till Shopify (välj butik, publicera)

### Frontend — Sidebar & Sidor
- [x] Alla produkter (lista med filter: varumärke, typ, status, taggar)
- [x] Priser & Rea (kampanjhantering)
- [x] Produkt feeds (skapa feed-länkar för Merchant Center — UI placeholder)
- [x] Leverantörer (skapa/hantera leverantörsprofiler — UI placeholder)
- [x] Importera produkter (4 importvägar: CSV/Excel, API, Shopify, fritext — UI placeholder)
- [x] Butiker (Shopify-butiker, anslutning, synk)
- [x] Fältmappning (PIM-fält → Shopify per butik)
- [x] Inställningar

### Backend — Infrastruktur
- [x] Auth med email/lösenord + roller (admin/client)
- [x] User-tabell, user_stores koppling
- [x] Sessions med user_id (Supabase + in-memory fallback)
- [x] requireAuth middleware (req.user med id, role, storeIds)
- [x] requireAdmin middleware
- [x] Register user (admin only)
- [x] Lista users (admin only)
- [x] Tilldela butiker till user (admin only)
- [x] store_id-filtrering på alla produkt-queries
- [x] store_id-filtrering på kampanjer, leverantörer, metadata

### Backend — Shopify-integration
- [x] Shopify GraphQL client (create/update produkt, varianter, bilder)
- [x] Metafield-definitioner: CRUD + synk till Shopify (metafieldDefinitionCreate)
- [x] Metafield-värden: pushas vid publicering (metafieldsSet)
- [x] Synkstatus-tracking (pending/syncing/synced/error) direkt på produkt
- [x] Auto-pending trigger vid produktändringar

### Backend — AI
- [x] POST /api/claude/enrich — Module J enrichment endpoint
- [x] Stöd för alla fält individuellt + "generera allt"
- [x] System prompt med Module J-regler (SEO, AEO, konvertering)
- [x] Brand voice hämtas från butikens inställningar
- [x] AI-förslag för metafält-definitioner

### Databas
- [x] Multi-tenant schema med store_id på alla tabeller
- [x] users + user_stores + sessions
- [x] products med AI-fält (short_description, agent_summary, faq, specifications, schema_json, etc.)
- [x] Shopify sync direkt på produkt (shopify_product_id, sync_status, pim_version)
- [x] metafield_definitions med is_system, store_id, synced_to_shopify
- [x] supplier_profiles med store_id
- [x] price_campaigns med store_id
- [x] activity_log med store_id + user_id
- [x] Auto-triggers (updated_at, handle-generering, sync-status pending)

### Data & Taxonomy
- [x] Shopify taxonomy (12 378 kategorier) med sökbar picker
- [x] Google category mapping (12 301 mappningar)
- [x] Lazy-loading av taxonomy (code-split, 225 KB gzipped)
- [x] Produktschema (Liquid) — todas-schema-product med multimarket, 7 review-appar, taxonomy-attribut

---

## Att bygga — Kritiskt (behövs för fungerande flöde)

### Import-pipeline
- [ ] CSV/Excel parser backend (encoding detection, separator detection)
- [ ] Kolumnmappning backend (auto-mapping med regex-patterns)
- [ ] Kolumnmappning UI (drag-and-drop, förhandsvisning, spara leverantörsprofil)
- [ ] Variantdetektering (separate_rows, comma_separated, matrix, single)
- [ ] Priskalkylering (moms-hantering, marginalberäkning, avrundning)
- [ ] Kategori-mappning (leverantörskategori → Shopify taxonomy per leverantörsprofil)
- [ ] Fritext-parser (AI: ostrukturerad text → produktdata)
- [ ] Import från Shopify-butik (hämta befintliga produkter för optimering)
- [ ] Hämta nya produkter från Shopify (banner/notis i toppen när det finns produkter i Shopify som inte finns i PIMet)
- [ ] Import från API/annat PIM

### Shopify-synk & statusindikatorer
- [ ] Indikation i produktlistan: vilka produkter som INTE finns i Shopify (saknar shopify_product_id)
- [ ] Indikation i produktlistan: vilka produkter som har opushade ändringar (ändrad i PIM men ej synkad)
- [ ] Banner i toppen av produktlistan: "X nya produkter i Shopify som inte hämtats till PIMet"
- [ ] Polling/cron som jämför Shopify-produkter mot PIM-produkter för att upptäcka nya

### Batch-system
- [ ] Batch-tabell i databas (draft → importing → enriching → review → publishing → verified)
- [ ] Batch-skapande vid import
- [ ] Batch-översikt med statusindikator per steg
- [ ] Bulk AI-berikning (köra enrichment på alla produkter i en batch)
- [ ] Review-vy (produktkort med all data, inline-redigering)
- [ ] Bulk godkänn/avvisa
- [ ] Bulk publicering till Shopify

### Brand Voice
- [ ] Brand Voice Sync från Todas MCP (client_read → brand_voice)
- [ ] Content Production Gate (blockerar AI om brand voice saknas)
- [ ] Terminologi-stöd i AI-prompts (use_english, use_swedish, never_write)
- [ ] Cacha brand voice i stores-tabellen vid batch-start
- [ ] Brand Voice onboarding-flöde i PIM om brand voice saknas

### Varianter
- [ ] Bygga om varianter-tab med dynamiska options (inte hårdkodade scheman)
- [ ] Stöd för Shopifys 3 option-nivåer
- [ ] Variant-specifik prissättning, lager, bilder
- [ ] Bulk-redigering av varianter

---

## Att bygga — Viktigt (behövs för komplett produkt)

### Bildpipeline
- [ ] Sharp: resize → 1000x1000 → .webp → komprimering (200KB max)
- [ ] Friläggning (rembg Python-server eller remove.bg API)
- [ ] AI-genererad alt-text per bild
- [ ] Bildkvalitetskontroll (flagga lågupplösta bilder)
- [ ] Smart padding (centrera i 1:1)
- [ ] Bilddownloader (hämta från URL i leverantörsdata)

### Produkt feeds (backend)
- [ ] XML-generering (Google Shopping format)
- [ ] CSV/TSV-generering
- [ ] Filtrera produkter per feed (varumärke, typ, taggar, status)
- [ ] Publika feed-URLs med auth-token
- [ ] Schema-validering av genererade feeds

### Verifiering
- [ ] Schema-validering (Rich Results Test)
- [ ] Metafield-check (verifiera att metafields publicerades korrekt)
- [ ] Baseline-mätning (spara GSC/GA4-data vid publiceringstillfället)
- [ ] Search & Discovery-test (testa intern sökning)

### Admin-panel
- [ ] Super admin dashboard (alla butiker, statistik)
- [ ] Hantera butiker (lägg till, redigera, ta bort)
- [ ] Hantera användare (skapa, tilldela butiker, inaktivera)
- [ ] Aktivitetslogg (vem gjorde vad, per butik)

### Kundinlogg
- [ ] Kund ser bara sin butiks data
- [ ] Begränsade rättigheter (kan inte skapa butiker, users, etc.)
- [ ] Store-switcher i header om kund har flera butiker (admin)

---

## Att bygga — Trevligt att ha (framtid)

### Prestanda & Skalning
- [ ] BullMQ + Redis för bakgrundsjobb (batch-berikning, bildbearbetning)
- [ ] Cloudflare R2 för bildlagring (istället för Supabase Storage)
- [ ] Rate limiting på AI-anrop (max 10/min)
- [ ] Webhook-mottagare från Shopify

### Avancerad AI
- [ ] Internlänksförslag i beskrivning ([INTERNLÄNK: kategori] → matcha mot collections)
- [ ] Konkurrent-benchmark FAQ (jämför med andra produkter i samma kategori)
- [ ] A/B-testning av titlar/descriptions
- [ ] AI-agent discovery tracking (dyker produkten upp i AI-svar?)

### Mätning & KPI
- [ ] Prioriteringspoäng (försäljning × marginal × sökdemand / datakvalitet)
- [ ] Dag 30/90-mätning (GSC/GA4 uppföljning per publicerad URL)
- [ ] Click-through rate tracking från GSC per produktsida
- [ ] Dashboard med KPI:er per kund

### Search & Discovery automation
- [ ] Auto-konfigurera synonymer i Shopify (boots → stövlar, etc.)
- [ ] Boosts baserat på kvalitetspoäng
- [ ] Auto-relaterade produkter baserat på delade attribut

---

## Teknikstack

| Lager | Teknik |
|-------|--------|
| Frontend | React 18 + Vite |
| Backend | Node.js + Express |
| Databas | PostgreSQL (Supabase) |
| AI | Anthropic Claude API (Sonnet för batch, Opus för komplexa) |
| Shopify | Admin API (GraphQL) |
| Bildlagring | Supabase Storage (R2 senare) |
| Auth | Email/lösenord + JWT-liknande tokens + roller |
| Schema | Liquid-template (todas-schema-product) |
| Taxonomy | Shopify Product Taxonomy (12 378 kategorier, lokal JSON) |
