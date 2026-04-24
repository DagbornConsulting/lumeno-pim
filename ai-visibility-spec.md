# AI-synlighetsspec — E-handel 2026

> **Scope:** ACP · UCP · WebMCP · schema.org · GMC · feeds · topical authority  
> **Stack:** Shopify (primär) · Google · OpenAI · Bing/Copilot · Perplexity  
> **Uppdaterad:** April 2026

---

## Arkitekturöversikt

```
Lager 4B  WebMCP / browser-agenter                          [Sedan]
Lager 4A  UCP / Shopify agentic commerce                    [Sedan]
Lager 3   Topical authority & innehåll                      [Snart]
Lager 2B  AI-feeds (ACP · llms.txt · Bing · robots.txt)    [Nu/Snart]
Lager 2A  Google-ekosystemet (GMC · Shopping Graph)         [Nu]
Lager 1   Strukturerad data på sidan (schema.org)           [Nu]
Lager 0   Shopify som source of truth                       [Nu]
```

**Grundprincipen:** En enda sann produktmodell i Shopify — publicerad i olika format till olika kanaler. Aldrig tre separata datakällor som drar isär över tid.

---

## Protokoll och standarder — Snabbförklaring

| Term | Vad det är | Vad det inte är |
|------|-----------|-----------------|
| **schema.org** | Markup för att beskriva innehåll på en sida (produktnamn, pris, recensioner, FAQ) | Ett integrationslager eller protokoll |
| **ACP** | OpenAIs Agentic Commerce Protocol — strukturerad produktfeed till ChatGPT | En feed du laddar upp i ett UI |
| **UCP** | Googles Universal Commerce Protocol — protokoll för discovery + checkout via AI-ytor | En klassisk feed-fil |
| **WebMCP** | Chrome-lager för att låta AI-agenter använda en live-webbsida som verktyg | En produktkatalog |
| **llms.txt** | Strukturerad textfil som beskriver sajten för AI-system | SEO-metadata |

**Tumregel:**  
- `schema.org` = "Här är vad den här produkten är"  
- `ACP/UCP` = "Här är min katalog och mina handelsfunktioner så AI kan rekommendera eller köpa"  
- `WebMCP` = "Här är verktyg på min webbplats som en AI-agent kan använda i browsern"  

De ersätter inte schema.org — de är nästa lager ovanpå.

---

## Lager 0 — Shopify som source of truth

Förutsättningen för att alla övriga lager ska fungera. Utan ren och komplett data hjälper ingen feed eller schema.

### Produktnivå (obligatoriskt)

- Titel (sökordsstyrd, ej bara intern produktkod)
- Beskrivning (unik per produkt, ej kopierad från leverantör)
- Brand/leverantör (strukturerat fält, inte i titeln)
- Produktkategori (Shopify standard taxonomy)
- Canonical URL (Shopifys default — kontrollera att inga konflikter finns)
- Bilder: minst en vit bakgrund + en livsstil, rätt `alt`-text

### Variantnivå (obligatoriskt)

- SKU (stabilt, unikt, aldrig ändra efter publicering)
- GTIN/EAN (streckkod — kritisk för Google Shopping Graph och ACP)
- Pris (måste matcha exakt det som visas på sidan)
- Compare-at price (rea-pris, används i structured data)
- Lagerstatus och faktisk quantity
- Vikt och mått (för fraktberäkning och structured data)
- Variantbild
- Option values som strukturerade fält — inte "Blå XL" i ett enda fält

### Via metafields (rekommenderat)

| Metafield | Syfte |
|-----------|-------|
| `MPN` | Manufacturer Part Number — komplement till GTIN |
| `google_product_category` | Numerisk GMC-kategori (t.ex. `3950`) |
| Kön / åldersgrupp | Obligatoriskt för kläder i Google Shopping |
| Material / mönster | Obligatoriskt för kläder, smycken |
| `custom_label_0–4` | Annonskampanjsegmentering i Google Ads / Meta |
| Returinfo | Antal dagar, metod — används i `MerchantReturnPolicy` |
| Fraktinfo | Zoner, tider — används i `OfferShippingDetails` |
| Energiklass | Obligatoriskt för vitvaror inom EU |

### Saknas ofta men är viktigt

- **Produktrecensioner som strukturerat data** — koppla recensionsapp (Judge.me, Yotpo) som genererar `AggregateRating` i JSON-LD. Google kräver att betyg i structured data faktiskt visas för användaren.
- **Shopify Markets-koppling** — om ni kör flera marknader (US/UK/SE), säkerställ att marknadspecifika priser, valutor och hreflang är korrekt konfigurerade. Fel hreflang är en vanlig orsak till att fel marknad rankar.
- **Return policy som strukturerat fält** — behövs för `MerchantReturnPolicy` i schema och för Merchant Center-godkännande.

---

## Lager 1 — Strukturerad data på sidan (schema.org)

### Shopifys inbyggda filter

```liquid
{% if template.name == 'product' %}
  <script type="application/ld+json">
    {{ product | structured_data }}
  </script>
{% endif %}
```

Genererar automatiskt: `Product`, `ProductGroup` (varianter), offer-data.

> **OBS:** Google kräver att structured data finns i den HTML servern returnerar — inte bara genereras i efterhand med JavaScript.

### Vad du behöver lägga till manuellt

**BreadcrumbList** (alla sidor):
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Hem", "item": "https://dinbutik.se"},
    {"@type": "ListItem", "position": 2, "name": "Drivrar", "item": "https://dinbutik.se/collections/drivers"},
    {"@type": "ListItem", "position": 3, "name": "TaylorMade Stealth Driver", "item": "https://dinbutik.se/products/..."}
  ]
}
```

**MerchantReturnPolicy + OfferShippingDetails** — krävs av Google för Shopping-godkännande i flera marknader:
```json
{
  "@type": "MerchantReturnPolicy",
  "applicableCountry": "SE",
  "returnPolicyCategory": "MerchantReturnFiniteReturnWindow",
  "merchantReturnDays": 30,
  "returnMethod": "ReturnByMail"
}
```

**FAQPage** (på kategorisidor och guider):
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "Vad är skillnaden mellan en 9° och 10,5° driver?",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "..."
    }
  }]
}
```

**Organization** (i layout.liquid, en gång per sajt):
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Din Butik",
  "url": "https://dinbutik.se",
  "logo": "https://dinbutik.se/logo.png",
  "sameAs": [
    "https://www.instagram.com/dinbutik",
    "https://www.facebook.com/dinbutik"
  ]
}
```

**WebSite med SearchAction** (sitelinks search box):
```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "url": "https://dinbutik.se",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://dinbutik.se/search?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
```

### Schema-typer som saknas ofta

| Schema-typ | Var det används | Effekt |
|-----------|----------------|--------|
| `AggregateRating` | Produktsidor | Stjärnor i SERP + Shopping |
| `VideoObject` | Produktsidor med video | Visas i Shopping och AI-svar |
| `ItemList` | Kategorisidor | Hjälper AI förstå katalogstruktur |
| `SpeakableSpecification` | Produktsidor, guider | Röstbaserade AI-svar |

---

## Lager 2A — Google-ekosystemet

### Primary source — Shopify Google & YouTube-kanal

Shopifys officiella kanal synkar produkter direkt till Merchant Center. Bygg inte en egen primärfeed parallellt — de skriver över varandra.

**Steg:**
1. Installera Google & YouTube i Shopify App Store
2. Koppla Google-konto + Merchant Center
3. Låt Shopify synka produkter tillgängliga för onlinebutiken
4. Komplettera saknade attribut i kanalen

### Supplemental feed i GMC

Läggs ovanpå primary-källan för att berika eller justera specifika attribut. Ladda upp via GMC > Produkter > Feeds > Kompletterande feed.

**Vad du bör ha i supplemental feed:**

| Attribut | Syfte |
|----------|-------|
| `product_highlight` | Punktlista med produktfördelar i Shopping-annonser |
| `custom_label_0–4` | Kampanjsegmentering i Google Ads |
| Justerade titlar | Om Shopify-titeln inte är sökordsoptimerad |
| `lifestyle_image_link` | Extra bildformat (livsstilsbild) |
| `additional_image_link` | Fler produktvinklar |
| `excluded_destination` | Uteslut varianter från annonser men behåll i fria listningar |

**Rekommenderad titelstruktur:**
```
Brand + Produktnamn + Viktig egenskap + Variant
```
Exempel: `TaylorMade Stealth Driver 9° RH Stiff`  
Inte: `Stealth Driver Svart snygg premiumklubba`

### Merchant Center policies (ofta bortglömda)

Blockar annonser om de saknas eller inte matchar sidan:

- **Return policy** — måste matcha exakt vad som visas på sidan
- **Shipping** — zoner, tider, priser
- **Business info** — VAT-nummer för EU, fysisk adress

### Google Shopping Graph

Googles parallella produktentitetsdatabas. Stärks automatiskt när GTIN matchar Googles produktdatabas. Korrekt GTIN → bättre synlighet i price comparison och AI Mode utan extra åtgärd.

### Saknas i ursprungsdokumentet

- **Performance Max** — förutsätter komplett produktfeed. Kör inte P-Max utan bra data.
- **Brand verification i GMC** — verifierar att du äger ett varumärke, viktigt för Brand Shopping-annonser.
- **Consent Mode v2** — påverkar vilka produkter Google optimerar mot i annonserna.

---

## Lager 2B — AI-feeds och AI-discovery

### ACP — OpenAI Agentic Commerce Protocol

**Vad det är:** En strukturerad produktfeed du hostar själv och delar med OpenAI via deras onboarding-process.

**Var den ligger:** Hos dig på en publik URL — inte i Shopify-temat, inte i GMC.

```
https://dinbutik.se/feeds/openai/products.json
https://dinbutik.se/feeds/openai/promotions.json
```

**Rekommenderad arkitektur:**

```
Shopify Admin API → Feed-generator (Vercel/Cloudflare Workers) → Cached JSON-fil
```

- Daglig regeneration via cron eller Shopify webhook
- Hämtar: products, variants, inventory, images, collections, metafields
- Transformerar till ACP-format (CSV eller JSON enligt OpenAIs spec)
- Exponerar på publik URL

**Normaliserat produktformat (intern modell → mappar till alla feeds):**
```json
{
  "id": "shopify-product-123",
  "handle": "taylormade-stealth-driver",
  "title": "TaylorMade Stealth Driver",
  "brand": "TaylorMade",
  "description": "Low spin driver for advanced players",
  "product_type": "Driver",
  "categories": ["Golf", "Golf Clubs", "Drivers"],
  "images": ["https://cdn.shopify.com/..."],
  "variants": [
    {
      "id": "shopify-variant-456",
      "sku": "TM-STL-9-RH-S",
      "gtin": "0123456789012",
      "title": "9° / RH / Stiff",
      "price": 5499,
      "currency": "SEK",
      "available": true,
      "inventory_quantity": 7,
      "image": "https://cdn.shopify.com/..."
    }
  ]
}
```

> **Status:** Onboarding av produktfeeds i ChatGPT är fortfarande partner-/inbjudningsstyrd (april 2026). Ha feeden redo.

### llms.txt — saknas ofta

Ska finnas på `https://dinbutik.se/llms.txt` och `https://dinbutik.se/llms-full.txt`.

**Innehåll:**
- Beskrivning av butiken och dess syfte
- Länk till strukturerad produktkatalog
- Vilka sidor AI-system bör prioritera
- Kontaktinfo för indexeringsfrågor
- Vad butiken säljer och till vem

### robots.txt för AI-crawlers

Shopifys standard-robots.txt blockerar ingenting. Du måste ta ett aktivt beslut:

```
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Googlebot
Allow: /
```

Besluta aktivt om varje bot. Standard = tillåt alla om du vill synas i AI-sökmotorer.

### Bing / Microsoft Copilot — saknas i ursprungsdokumentet

Komplett kanal som inte nämns alls i källmaterialet.

- Registrera i **Bing Webmaster Tools** (separat från GSC)
- **Bing Shopping** — feed via Merchant Center eller separat Bing Merchant Center
- **Copilot** indexerar från Bing-indexet — bra Bing-SEO = bra Copilot-synlighet
- **IndexNow** — Shopify stödjer nativt, aktiverar snabbare indexering i Bing och Yandex

### Perplexity — saknas i ursprungsdokumentet

- PerplexityBot crawlar fritt om inte blockad
- Perplexity använder structured data och llms.txt för produktsvar
- Hög användning i research-fas av köpresor — viktig kanal

---

## Lager 3 — Topical authority och innehåll

### Varför det fortfarande är avgörande

- Feeds hjälper dig att bli korrekt tolkad och visad
- Topical authority hjälper dig att bli vald och betrodd
- AI-svar kräver källmaterial — utan bra guider citerar AI en konkurrents sida

### Innehållstyper med störst effekt

| Innehållstyp | SEO-effekt | AI-effekt | Prioritet |
|-------------|-----------|-----------|-----------|
| Köpguider | Hög | Hög (citeras direkt) | 🔴 Nu |
| Jämförelsesidor (A vs B) | Hög | Hög | 🔴 Nu |
| FAQ-sidor med FAQPage schema | Hög | Hög | 🔴 Nu |
| "Bästa X för Y" | Hög | Hög | 🔴 Nu |
| Kategoritexter (substantiella) | Medel | Medel | 🟡 Snart |
| Produktrecensioner/UGC | Medel | Hög (E-E-A-T) | 🟡 Snart |
| Expert-artiklar | Medel | Hög | 🟡 Snart |
| Videocontent med VideoObject | Medel | Medel | 🟢 Sedan |

### E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)

- Author-markup på guider och artiklar (`Person` schema med `knowsAbout`)
- "Om oss"-sida med faktisk personal och kompetens
- Org-nummer, adress, branschkoppling synliga på sidan
- Extern press och omnämnanden
- Certifieringar om relevanta

### Entity building — saknas i ursprungsdokumentet

Google arbetar med entiteter, inte bara keywords. Stärk er entitet:

1. **Organization-schema** med `sameAs` till alla sociala profiler
2. **Google Business Profile** om ni har fysisk adress
3. **Wikidata-post** om varumärket är tillräckligt etablerat
4. **Brand-konsistens** — samma namn, logga, beskrivning överallt
5. **Leverantörslänkar** — om ni är auktoriserad återförsäljare, be om en länk från leverantörens sida

### Produktrecensioner och UGC

- Trustpilot, Google Reviews, produktspecifika recensioner
- Genererar `AggregateRating` i structured data
- Stärker E-E-A-T-signaler
- Citeras av AI-system som externt bevis på kvalitet

### YouTube / video — saknas i ursprungsdokumentet

- Produktvideor med `VideoObject`-markup syns i Shopping och AI-svar
- Shopify stödjer videouppladdning direkt på produktsidor
- YouTube-kanal med produktguider stärker topical authority och entity

### Brand SERP — saknas i ursprungsdokumentet

Vad syns när någon söker på ditt varumärke?

- Knowledge panel (byggs via Organization-schema + Google Business Profile)
- Sitelinks (byggs via korrekt internlänkning och sitemap)
- Recensioner i SERP (via AggregateRating)
- Sociala profiler i sökresultaten

### Internlänkning

- Guider → relevanta produktkategorier
- Produktsidor → relevanta guider
- Kategorisidor → underkategorier och relaterade
- Filternavigation hanteras med canonical (se nedan)

### Faceted navigation / filter-canonical — saknas i ursprungsdokumentet

I Shopify genererar kollektionsfilter nya URL:er (`/collections/drivers?sort=price`). Utan hantering:

- Crawl budget läcks på värdelösa filter-URL:er
- Duplicate content på filtrerade vyer

**Lösning:** Lägg `<link rel="canonical" href="{{ collection.url }}">` på alla filtrerade samlingssidor.

---

## Lager 4A — UCP och Shopify agentic commerce

### Vad UCP är

Universal Commerce Protocol — Googles öppna standard för handel via AI-ytor (AI Mode, Gemini). Inkluderar capability negotiation, business profile, identity linking och embedded checkout.

**Viktigt:** UCP är inte en feed du laddar upp. Det är ett protokoll och integrationslager.

### Shopifys implementering

Shopify bygger UCP-stöd som ett integrerat lager:

- **Shopify Catalog MCP** — discovery av produkter för AI-agenter
- **Checkout MCP** — agent skapar checkout via Shopifys UCP-endpoints (`/api/ucp/mcp`)
- **Agentic storefronts** — produkter som säljs direkt via AI-kanaler

**Praktisk åtgärd nu:** Se till att produktdata är komplett och konsistent — det är vad som gör produkter "UCP-eligible". Shopify hanterar protokollagret.

### URL-struktur för egna feeds

```
https://dinbutik.se/feeds/openai/products.json     ← ACP
https://dinbutik.se/feeds/openai/promotions.json   ← ACP promotions
https://dinbutik.se/feeds/google/supplemental.tsv  ← GMC supplemental
https://dinbutik.se/llms.txt                       ← AI-system
```

---

## Lager 4B — WebMCP / browser-agenter

### Vad det är

Chrome-lager som låter AI-agenter i browsern använda en live-webbsida som verktyg — inklusive DOM, cookies och sessionstillstånd. Verktygen existerar bara medan sidan är öppen.

### Relevant för e-handel när

- En AI-agent ska konfigurera en produkt direkt på sidan (t.ex. golfklubbkonfigurator)
- Agenten ska läsa kundvagn och sessionsdata i realtid
- Agentstyrda köpflöden på sajten

### Prioritet

Lägst av alla lager för e-handel idag. Bevaka, bygg inte ännu — utom om du har specifika konfiguratorflöden där det ger direkt affärsnytta.

---

## Teknisk SEO-grund — saknas i ursprungsdokumentet

Feeds och schema hjälper inte om den tekniska grunden är trasig.

### Core Web Vitals

| Signal | Mål | Påverkan |
|--------|-----|----------|
| LCP (Largest Contentful Paint) | < 2,5s | Ranking-signal |
| INP (Interaction to Next Paint) | < 200ms | Ranking-signal |
| CLS (Cumulative Layout Shift) | < 0,1 | Ranking-signal + UX |

Shopify Horizon-teman är generellt bra, men custom-sektioner kan bryta det. Mät i Google Search Console och PageSpeed Insights.

### Sitemap

- `sitemap.xml` — Shopify genererar automatiskt
- **Image sitemap** — Shopify inkluderar bilder, kontrollera att produktbilder finns med
- **Samlingar** — kontrollera att viktiga samlingar inkluderas

### robots.txt

```
# Standardinnehåll + AI-bottar (lägg till manuellt i Shopify)
User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts
Disallow: /account

User-agent: GPTBot
Allow: /

User-agent: PerplexityBot
Allow: /
```

### Search Console-monitoring

Löpande, inte engångskontroll:

- Indexeringsfel (404, soft 404, blocked by robots)
- Core Web Vitals-rapport per URL-grupp
- Produktdisapprovals från Merchant Center-koppling
- Search performance per produktkategori och guide

### IndexNow

Shopify stödjer IndexNow nativt — aktiverar snabbare indexering i Bing, Yandex. Kontrollera att det är aktiverat i Shopify-inställningarna.

---

## Prioriteringsplan

### Fas 1 — Gör nu

| Åtgärd | Lager | Verktyg |
|--------|-------|---------|
| Komplettera SKU, GTIN, brand i alla produkter | 0 | Shopify Admin / bulk edit |
| Sätt upp metafields (kategori, retur, frakt) | 0 | Shopify Admin |
| Kontrollera `{{ product \| structured_data }}` på alla produktsidor | 1 | Liquid + GSC |
| Lägg till BreadcrumbList i layout | 1 | JSON-LD i Liquid |
| Lägg till MerchantReturnPolicy + OfferShippingDetails | 1 | JSON-LD i Liquid |
| Koppla Google & YouTube-kanalen | 2A | Shopify App Store |
| Fixa alla disapprovals i Merchant Center | 2A | Google Merchant Center |
| Lägg till return policy och shipping i GMC | 2A | Google Merchant Center |
| Skapa/uppdatera robots.txt med AI-bottar | 2B | Shopify Admin |
| Publicera llms.txt | 2B | Shopify filer |
| Registrera i Bing Webmaster Tools | 2B | Bing Webmaster Tools |

### Fas 2 — Gör snart

| Åtgärd | Lager | Verktyg |
|--------|-------|---------|
| Bygg normaliserad intern produktmodell (JSON) | 0 | Node/Python-script |
| Lägg till AggregateRating via recensionsapp | 1 | Judge.me / Yotpo |
| Skapa supplemental feed i GMC | 2A | TSV/CSV → GMC UI |
| Bygg feed-generator för ACP-URL | 2B | Vercel / Cloudflare Workers |
| Starta innehållsplan: 4–6 köpguider | 3 | CMS / Shopify Blog |
| Hantera filter-canonicals i kollektioner | Teknisk | Liquid |
| Sätt upp Search Console-alerts | Teknisk | GSC |
| Bygg Organization + WebSite schema | 1 | Liquid JSON-LD |

### Fas 3 — Bevaka och bygg sedan

| Åtgärd | Lager | Beroende |
|--------|-------|----------|
| Ansök om ACP-onboarding hos OpenAI | 2B | Feed-generator klar |
| Bing Shopping-feed | 2B | GMC-feed stabil |
| UCP / Shopify agentic storefront | 4A | Shopifys roadmap |
| VideoObject + YouTube-produktion | 3 | Innehållsstrategi |
| WebMCP för konfiguratorflöden | 4B | Specifika use cases |

---

## Prioriteringsmodell (förenklad)

```
40% → Produktdata / feed / teknisk konsekvens
30% → Topical authority / hjälpinnehåll
20% → Länkar / varumärkessignaler / entity building
10% → UX, internlänkning, crawlbarhet, hastighet
```

Den vinnande kombinationen: **auktoritet + korrekt data + stark ämnestäckning + tydlig entitet**

---

## Vanliga misstag att undvika

1. **Mismatch mellan feed, structured data och sida** — Google blockar annonser vid prisdiskrepans
2. **Köra P-Max utan komplett produktfeed** — slänger annonsbudget
3. **Tro att AI-synlighet bara handlar om feeds** — feeds gör dig maskinläsbar, topical authority gör dig vald
4. **Ignorera Bing/Copilot-kanalen** — separat indexering, separat Merchant Center
5. **robots.txt blockerar AI-bottar oavsiktligt** — kontrollera aktivt
6. **Supplemental feed utan stabil primary-källa** — supplemental data appliceras bara på matchade produkter
7. **GTIN saknas** — utan GTIN matchas inte produkten mot Shopping Graph
8. **Faceted navigation utan canonical** — duplicate content och bortkastade crawl-resurser

---

*Senast reviderad: April 2026*
