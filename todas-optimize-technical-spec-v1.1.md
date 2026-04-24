# Todas Product Data Pipeline — Teknisk Specifikation v1.0

> **Syfte:** Komplett teknisk blueprint för Tobias att bygga Modul 1 av Todas Optimize.
> **Målgrupp:** Tobias + Claude Code i VS Code.
> **Datum:** 2026-03-30
> **Arkitektur:** Next.js App Router + PostgreSQL + Shopify Admin API + Sharp + Claude API

---

## 1. Systemöversikt

### 1.1 Vad systemet gör (end-to-end)

```
LEVERANTÖRSFIL (CSV/Excel)
    ↓
[1. IMPORT] — Parser + encoding detection
    ↓
[2. MAPPNING] — Kolumner → Shopify-fält (leverantörsprofil sparas)
    ↓
[3. BILDER] — Hämta → .webp → 1000x1000 → frilägg → alt-text
    ↓
[4. AI-BERIKNING] — Module J: titel, meta, beskrivning, snabbfakta, FAQ, metafields, schema
    ↓
[5. PREVIEW] — Produktkort med kvalitetsindikator → kund redigerar
    ↓
[6. PUBLISH] — Shopify Admin API: produkt + metafields + bilder + schema
    ↓
[7. VERIFY] — Schema-validering + baseline-mätning (GSC/GA4 sparas)
```

### 1.2 Teknikstack

```yaml
frontend:
  framework: "Next.js 14+ (App Router)"
  ui: "React + Tailwind CSS + shadcn/ui"
  state: "React Query (TanStack Query) för server state"
  forms: "React Hook Form + Zod validation"

backend:
  runtime: "Node.js 20+ (Next.js API routes / Server Actions)"
  orm: "Prisma (type-safe, migrations, seeding)"
  queue: "BullMQ + Redis (bakgrundsjobb: bildbearbetning, AI-berikning, Shopify publish)"
  storage: "Cloudflare R2 (S3-kompatibel, billigare än AWS S3, bra för bilder)"
  
database:
  primary: "PostgreSQL 16 (Railway)"
  cache: "Redis (Railway — för BullMQ + session cache)"

external_apis:
  shopify: "Admin API (GraphQL, version 2024-10+)"
  ai: "Anthropic Claude API (sonnet för batch, opus för komplexa produkter)"
  images: "Sharp (Node.js native) + rembg (Python, friläggning)"
  search: "Todas MCP Server (befintliga skills)"

hosting:
  platform: "Railway"
  domains: "optimize.todas.se (eller app.todas.se/optimize)"
  
auth:
  method: "NextAuth.js + JWT"
  roles: "admin (Dan/Tobias), client (kund), api (extern integration)"
```

### 1.3 Multi-tenancy från dag 1

Även om MVP:n bara används internt MÅSTE arkitekturen vara multi-tenant:
- Varje kund (client) har isolerad data
- Varje leverantör (supplier) tillhör en kund
- Alla queries filtrerar på `client_id`
- Bilder lagras i separata R2-mappar per kund: `/{client_id}/products/{batch_id}/`
- Aldrig persondata — all data är produktrelaterad

---

## 2. Databasschema (Prisma)

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ══════════════════════════════════════════
// KUNDER
// ══════════════════════════════════════════

model Client {
  id               String   @id @default(cuid())
  name             String   // "PQ Golf", "Western Tack & Fashion"
  slug             String   @unique // "pq-golf", "western-tack"
  
  // Shopify-koppling
  shopifyDomain    String?  // "pqgolf.myshopify.com"
  shopifyToken     String?  // Encrypted — Admin API access token
  shopifyPlan      String?  // "basic" | "grow" | "advanced" | "plus"
  
  // ══════════════════════════════════════════════════════════════
  // BRAND VOICE — HÄMTAS FRÅN TODAS CLIENT CONTEXT ENGINE
  // ══════════════════════════════════════════════════════════════
  // KRITISKT: Brand voice dupliceras INTE här. Den lever i Todas-plattformens
  // Client Context Engine v1.2 (MCP: client_read → brand_voice).
  // Optimize-systemet hämtar brand voice vid varje AI-berikningsjobb.
  //
  // Varför: Client Context Engine har terminologi (use_english, use_swedish, 
  // never_write), content production gate som BLOCKERAR om brand voice saknas,
  // och nischbransch-detektion. Att duplicera detta skapar synk-problem.
  //
  // Fälten nedan är CACHE — uppdateras vid varje batch-start via syncBrandVoice()
  // ══════════════════════════════════════════════════════════════
  
  todasClientId    String?  // Todas Platform client_id (UUID) — koppling till MCP
  
  // Cachade fält (synkas från Todas MCP vid batch-start)
  toneOfVoice      String?  @db.Text  // Cache av brand_voice.tone
  brandProfile     Json?    // Cache av brand_voice (komplett: terminology, avoid, examples)
  colorLevel       String?  // "A" | "B" — per default, kan overridas per kategori
  defaultLanguage  String   @default("sv") // "sv" | "en" | "de" etc.
  
  // Relationer
  suppliers        Supplier[]
  batches          Batch[]
  products         Product[]
  categoryConfigs  CategoryConfig[]
  
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}

// ══════════════════════════════════════════
// LEVERANTÖRER
// ══════════════════════════════════════════

model Supplier {
  id              String   @id @default(cuid())
  clientId        String
  client          Client   @relation(fields: [clientId], references: [id])
  
  name            String   // "Ariat", "TaylorMade", "CycleEurope"
  
  // Import-konfiguration (sparas EN gång, återanvänds)
  importType      String   // "csv" | "excel" | "api" | "url" | "freetext"
  fileConfig      Json?    // CSV: separator, encoding, headerRow
                           // Excel: sheetIndex, headerRow
                           // API: endpoint, authMethod, fieldMapping
  
  // Kolumnmappning: { "leverantörens_kolumn": "shopify_fält" }
  // Exempel: { "Art.nr": "sku", "Produktnamn": "title", "Pris inkl moms": "price" }
  columnMapping   Json?
  
  // Variantlogik
  variantStrategy String?  // "separate_rows" | "comma_separated" | "matrix" | "single"
  variantConfig   Json?    // Detaljer beroende på strategy
  
  // Bildkonvention
  imageStrategy   String?  // "url_column" | "filename_pattern" | "attached" | "scrape"
  imageConfig     Json?    // { "urlColumn": "Bild-URL", "pattern": "{sku}-{n}.jpg" }
  
  // Prislogik
  priceIncludesVat Boolean @default(true)
  vatRate          Float   @default(0.25) // 25% svensk moms
  currency         String  @default("SEK")
  marginRule       Json?   // { "type": "markup", "percentage": 2.5 } etc.
  
  // Kategori-mappning: leverantörens kategorier → Shopify taxonomy
  categoryMapping  Json?   // { "Herr > Boots": "sg-4-17-2-17" }
  
  // Defaults
  defaults        Json?    // { "weight": "0.5", "weightUnit": "kg", "vendor": "Ariat" }
  
  batches         Batch[]
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@index([clientId])
}

// ══════════════════════════════════════════
// BATCHES (en import-körning)
// ══════════════════════════════════════════

model Batch {
  id              String   @id @default(cuid())
  clientId        String
  client          Client   @relation(fields: [clientId], references: [id])
  supplierId      String
  supplier        Supplier @relation(fields: [supplierId], references: [id])
  
  name            String   // "PQ Golf — TaylorMade våren 2026"
  status          String   @default("draft")
  // draft → importing → mapping → enriching → review → publishing → published → verified
  
  // Statistik
  totalProducts    Int     @default(0)
  enrichedCount    Int     @default(0)
  approvedCount    Int     @default(0)
  publishedCount   Int     @default(0)
  failedCount      Int     @default(0)
  
  // Tidsstämplar för KPI-mätning
  importStartedAt  DateTime?
  enrichStartedAt  DateTime?
  reviewStartedAt  DateTime?
  publishStartedAt DateTime?
  publishedAt      DateTime?
  verifiedAt       DateTime?
  
  // Käll-fil
  sourceFileName   String?
  sourceFileUrl    String?  // R2 URL till original-filen
  
  products        Product[]
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@index([clientId])
  @@index([status])
}

// ══════════════════════════════════════════
// PRODUKTER (kärnan)
// ══════════════════════════════════════════

model Product {
  id              String   @id @default(cuid())
  clientId        String
  client          Client   @relation(fields: [clientId], references: [id])
  batchId         String
  batch           Batch    @relation(fields: [batchId], references: [id])
  
  status          String   @default("imported")
  // imported → enriching → enriched → approved → publishing → published → verified
  // rejected (kund avvisade) → enriching (ombearbetas)
  
  // ── LEVERANTÖRSDATA (rådata, aldrig ändras) ──
  rawData         Json     // Hela raden från leverantörsfilen som JSON
  
  // ── SHOPIFY-IDENTIFIERING ──
  sku             String
  shopifyProductId String?  // Fylls i efter publish (gid://shopify/Product/xxx)
  shopifyHandle    String?  // Fylls i efter publish
  isNewProduct     Boolean  @default(true) // true = skapa, false = uppdatera
  
  // ── OPTIMERAD DATA (AI-genererad + manuellt redigerad) ──
  
  // Grunddata
  title           String?  // "[Varumärke] [Modell] – [Kategori]"
  vendor          String?  // Varumärke
  productType     String?  // Shopify product_type
  tags            String[] // Shopify tags
  
  // SEO
  metaTitle       String?  // Max 60 tecken, utan butiksnamn
  metaDescription String?  // Max 155 tecken
  
  // Content (Module J)
  shortDescription String? @db.Text // Kort ingress (2-3 meningar)
  agentSummary     String? @db.Text // Snabbfakta (löptext för AI, renderas som punktlista)
  description      String? @db.Text // Fullständig produktbeskrivning (HTML)
  
  // Strukturerad data
  specifications   Json?   // Array: [{ "name": "Skafthöjd", "value": "30 cm" }]
  faq              Json?   // Array: [{ "question": "...", "answer": "..." }]
  
  // Shopify Taxonomy
  taxonomyCategoryId String? // Shopify taxonomy category ID (t.ex. "sg-4-17-2-17")
  taxonomyAttributes Json?   // Ifyllda taxonomy-attribut: { "color": "Brown", ... }
  
  // Custom attributes (BARA det som saknas i taxonomy, på sidans språk)
  customAttributes Json?    // Array: [{ "name": "Skafthöjd", "value": "30 cm" }]
  
  // Schema (JSON-LD, genereras från ovan)
  schemaJson      Json?    // Komplett Product schema enligt Module J2.I
  
  // Prissättning
  price           Float?
  compareAtPrice  Float?
  costPerItem     Float?   // Inköpspris (för marginalberäkning)
  
  // Färgklassificering
  colorLevel      String?  // "A" | "B" (ärvs från CategoryConfig eller Client default)
  color           String?  // Färgnamn
  
  // Prioritering
  priorityScore   Float?   // Beräknad prioritet (försäljning × marginal × sökdemand / datakvalitet)
  
  // Kvalitetsindikator
  qualityScore    Float?   // 0-100 baserat på Module J DoD kompletthetsgrad
  qualityDetails  Json?    // { "missingFields": [...], "warnings": [...] }
  
  // Bilder
  images          ProductImage[]
  
  // Varianter
  variants        ProductVariant[]
  
  // Kundredigering
  customerEdits   Json?    // Sparar kundens ändringar separat (diff)
  rejectionReason String?  // Om kund avvisade
  
  // Mätning (baseline)
  publishedUrl    String?
  baselineData    Json?    // GSC/GA4-data vid publiceringstillfället
  day30Data       Json?    // Mätning dag 30
  day90Data       Json?    // Mätning dag 90
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@unique([clientId, sku])
  @@index([clientId])
  @@index([batchId])
  @@index([status])
}

// ══════════════════════════════════════════
// PRODUKTBILDER
// ══════════════════════════════════════════

model ProductImage {
  id              String   @id @default(cuid())
  productId       String
  product         Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  position        Int      // 1 = huvudbild
  
  // Källa
  sourceUrl       String?  // Original-URL (leverantörens)
  sourceType      String   // "url" | "upload" | "scrape"
  
  // Bearbetad bild
  processedUrl    String?  // R2 URL till .webp
  fallbackUrl     String?  // R2 URL till .jpg fallback
  
  // Metadata
  width           Int?
  height          Int?
  fileSize        Int?     // bytes
  format          String?  // "webp" | "jpg" | "png"
  
  // Alt-text
  altText         String?  // "[Varumärke] [Modell] — [Kategori] [Färg] [Vinkel]"
  
  // Bearbetningsstatus
  processingStatus String  @default("pending")
  // pending → downloading → processing → done → failed
  backgroundRemoved Boolean @default(false)
  qualityFlag      String? // null = OK, "low_resolution" | "processing_failed"
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@index([productId])
}

// ══════════════════════════════════════════
// PRODUKTVARIANTER
// ══════════════════════════════════════════

model ProductVariant {
  id              String   @id @default(cuid())
  productId       String
  product         Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  sku             String
  title           String   // "42" eller "L / Svart"
  
  option1Name     String?  // "Storlek"
  option1Value    String?  // "42"
  option2Name     String?  // "Färg"
  option2Value    String?  // "Svart"
  option3Name     String?
  option3Value    String?
  
  price           Float
  compareAtPrice  Float?
  costPerItem     Float?
  
  inventoryQty    Int?
  weight          Float?
  weightUnit      String?  @default("kg")
  barcode         String?  // EAN/GTIN
  
  shopifyVariantId String? // gid://shopify/ProductVariant/xxx
  
  @@index([productId])
}

// ══════════════════════════════════════════
// KATEGORI-KONFIGURATION (färgklassificering etc.)
// ══════════════════════════════════════════

model CategoryConfig {
  id              String   @id @default(cuid())
  clientId        String
  client          Client   @relation(fields: [clientId], references: [id])
  
  categoryName    String   // "Boots", "Golfklubbor", "Traktorer"
  taxonomyId      String?  // Shopify taxonomy category ID
  colorLevel      String   // "A" | "B"
  
  // Kategori-specifika prompts för AI-berikning
  enrichmentHints Json?    // { "focusAttributes": ["motor", "effekt"], "avoidTerms": [...] }
  
  @@unique([clientId, categoryName])
}

// ══════════════════════════════════════════
// JOBB-KÖ / PROCESSING LOG
// ══════════════════════════════════════════

model ProcessingJob {
  id              String   @id @default(cuid())
  batchId         String
  productId       String?  // null om batch-level job
  
  type            String   // "import" | "image_process" | "enrich" | "publish" | "verify"
  status          String   @default("queued")
  // queued → processing → completed → failed
  
  attempts        Int      @default(0)
  maxAttempts     Int      @default(3)
  
  input           Json?    // Job-specifik input
  output          Json?    // Job-specifik output (resultat eller error)
  error           String?
  
  startedAt       DateTime?
  completedAt     DateTime?
  
  createdAt       DateTime @default(now())
  
  @@index([batchId])
  @@index([status])
  @@index([type])
}
```


---

## 3. Mappstruktur

```
todas-optimize/
├── prisma/
│   ├── schema.prisma          # Databasschema (ovan)
│   ├── migrations/            # Prisma migrations
│   └── seed.ts                # Testdata (PQ Golf supplier profile)
│
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── layout.tsx         # Root layout med providers
│   │   ├── page.tsx           # Dashboard / Landing
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── ...
│   │   ├── clients/
│   │   │   ├── page.tsx                    # Lista kunder
│   │   │   └── [clientId]/
│   │   │       ├── page.tsx                # Kund-dashboard
│   │   │       ├── suppliers/
│   │   │       │   ├── page.tsx            # Lista leverantörer
│   │   │       │   ├── new/page.tsx        # Ny leverantör + mappning
│   │   │       │   └── [supplierId]/
│   │   │       │       └── page.tsx        # Redigera leverantörsprofil
│   │   │       ├── batches/
│   │   │       │   ├── page.tsx            # Lista batches
│   │   │       │   ├── new/page.tsx        # Ny batch (filuppladdning)
│   │   │       │   └── [batchId]/
│   │   │       │       ├── page.tsx        # Batch-översikt
│   │   │       │       ├── mapping/page.tsx # Kolumnmappning (om ny leverantör)
│   │   │       │       ├── review/page.tsx  # Preview + godkännande
│   │   │       │       └── results/page.tsx # Publiceringsresultat
│   │   │       └── settings/page.tsx       # Kund-inställningar
│   │   └── api/
│   │       ├── batches/
│   │       │   ├── route.ts               # POST: skapa batch
│   │       │   └── [batchId]/
│   │       │       ├── route.ts           # GET, PATCH: batch CRUD
│   │       │       ├── import/route.ts    # POST: starta import
│   │       │       ├── enrich/route.ts    # POST: starta AI-berikning
│   │       │       ├── publish/route.ts   # POST: publicera till Shopify
│   │       │       └── verify/route.ts    # POST: verifiera publicering
│   │       ├── products/
│   │       │   ├── [productId]/
│   │       │   │   ├── route.ts           # GET, PATCH: produkt CRUD
│   │       │   │   ├── approve/route.ts   # POST: godkänn produkt
│   │       │   │   └── reject/route.ts    # POST: avvisa produkt
│   │       │   └── bulk/
│   │       │       ├── approve/route.ts   # POST: bulk-godkänn
│   │       │       └── reject/route.ts    # POST: bulk-avvisa
│   │       ├── images/
│   │       │   ├── upload/route.ts        # POST: manuell bilduppladdning
│   │       │   └── [imageId]/
│   │       │       └── reprocess/route.ts # POST: kör om bildbearbetning
│   │       ├── suppliers/
│   │       │   ├── route.ts               # POST: skapa leverantör
│   │       │   └── [supplierId]/
│   │       │       └── route.ts           # PATCH: uppdatera leverantörsprofil
│   │       ├── shopify/
│   │       │   ├── products/route.ts      # GET: hämta befintliga produkter (SKU-check)
│   │       │   └── taxonomy/route.ts      # GET: sök taxonomy-kategorier
│   │       └── webhooks/
│   │           └── shopify/route.ts       # POST: Shopify webhooks (framtid)
│   │
│   ├── lib/
│   │   ├── db.ts                          # Prisma client singleton
│   │   ├── auth.ts                        # NextAuth config
│   │   ├── r2.ts                          # Cloudflare R2 client (S3-kompatibel)
│   │   ├── queue.ts                       # BullMQ queue setup
│   │   └── shopify/
│   │       ├── client.ts                  # Shopify GraphQL client factory
│   │       ├── queries.ts                 # GraphQL queries
│   │       ├── mutations.ts               # GraphQL mutations (create/update product)
│   │       └── bulk-operations.ts         # Bulk mutations för >50 produkter
│   │
│   ├── services/                          # Affärslogik (KÄRNAN)
│   │   ├── import/
│   │   │   ├── csv-parser.ts              # CSV/TSV parser med encoding detection
│   │   │   ├── excel-parser.ts            # Excel parser (xlsx)
│   │   │   ├── freetext-parser.ts         # Fritext → strukturerad data (Claude)
│   │   │   └── import-service.ts          # Orchestrator: fil → parsed rows
│   │   │
│   │   ├── mapping/
│   │   │   ├── column-mapper.ts           # Kolumn → Shopify-fält mappning
│   │   │   ├── variant-detector.ts        # Detekterar variant-mönster i data
│   │   │   ├── price-calculator.ts        # Moms, marginaler, avrundning
│   │   │   └── category-mapper.ts         # Leverantörs-kategori → Shopify taxonomy
│   │   │
│   │   ├── images/
│   │   │   ├── downloader.ts              # Hämta bilder från URL:er
│   │   │   ├── processor.ts               # Sharp: resize, .webp, padding, komprimering
│   │   │   ├── background-remover.ts      # Friläggning (rembg eller remove.bg API)
│   │   │   ├── alt-text-generator.ts      # AI-genererad alt-text
│   │   │   └── image-service.ts           # Orchestrator: källa → bearbetad bild i R2
│   │   │
│   │   ├── enrichment/
│   │   │   ├── enrichment-service.ts      # Orchestrator: produkt → berikad produkt
│   │   │   ├── title-generator.ts         # Produkttitel enligt Module J2.C
│   │   │   ├── meta-generator.ts          # Meta title + description enligt Module J2.D
│   │   │   ├── description-generator.ts   # Kort ingress + fullständig beskrivning
│   │   │   ├── summary-generator.ts       # Agent summary / snabbfakta (Module J2.F)
│   │   │   ├── faq-generator.ts           # FAQ-generering (Module J2.H)
│   │   │   ├── spec-table-builder.ts      # Specifikationstabell (Module J2.G)
│   │   │   ├── schema-generator.ts        # JSON-LD Product schema (Module J2.I)
│   │   │   ├── taxonomy-mapper.ts         # Shopify taxonomy + attribut
│   │   │   ├── quality-scorer.ts          # Module J DoD-kompletthetsgrad (0-100)
│   │   │   └── prompts/
│   │   │       ├── system-prompt.ts       # Bas-systemprompt med Module J-regler
│   │   │       ├── title-prompt.ts        # Prompt för titlar
│   │   │       ├── description-prompt.ts  # Prompt för beskrivningar
│   │   │       ├── faq-prompt.ts          # Prompt för FAQ
│   │   │       └── prompt-builder.ts      # Bygger komplett prompt med brand voice + kontext
│   │   │
│   │   ├── publish/
│   │   │   ├── publish-service.ts         # Orchestrator: godkänd produkt → Shopify
│   │   │   ├── product-creator.ts         # Shopify GraphQL: skapa ny produkt
│   │   │   ├── product-updater.ts         # Shopify GraphQL: uppdatera befintlig
│   │   │   ├── metafield-sync.ts          # Synka metafields (faq, agent_summary, attributes)
│   │   │   ├── image-uploader.ts          # Ladda upp bilder till Shopify
│   │   │   └── bulk-publisher.ts          # GraphQL Bulk Operations (>50 produkter)
│   │   │
│   │   └── verification/
│   │       ├── schema-validator.ts        # Rich Results Test (samplade URL:er)
│   │       ├── metafield-checker.ts       # Verifiera att metafields publicerades
│   │       ├── search-discovery-test.ts   # Testa intern sökning
│   │       └── baseline-recorder.ts       # Spara GSC/GA4 baseline per URL
│   │
│   ├── workers/                           # BullMQ workers (bakgrundsjobb)
│   │   ├── import-worker.ts               # Processar import-jobb
│   │   ├── image-worker.ts                # Processar bildbearbetning
│   │   ├── enrichment-worker.ts           # Processar AI-berikning
│   │   ├── publish-worker.ts              # Processar Shopify-publicering
│   │   └── verification-worker.ts         # Processar verifiering
│   │
│   ├── components/                        # React-komponenter
│   │   ├── ui/                            # shadcn/ui bas-komponenter
│   │   ├── batch/
│   │   │   ├── BatchList.tsx
│   │   │   ├── BatchProgress.tsx          # Statusindikator per steg
│   │   │   └── BatchActions.tsx           # Knappar: Starta import/berikning/publicering
│   │   ├── mapping/
│   │   │   ├── ColumnMapper.tsx           # Drag-and-drop kolumnmappning
│   │   │   ├── VariantDetector.tsx        # Visa detekterade varianter
│   │   │   ├── MappingPreview.tsx         # Förhandsvisning 5 produkter
│   │   │   └── SupplierProfileSave.tsx    # Spara som leverantörsprofil
│   │   ├── product/
│   │   │   ├── ProductCard.tsx            # Produktkort med all data
│   │   │   ├── ProductEditor.tsx          # Inline-redigering
│   │   │   ├── QualityBadge.tsx           # Grön/gul/röd kvalitetsindikator
│   │   │   ├── ImageGallery.tsx           # Bildvisning + hantering
│   │   │   └── ProductDiff.tsx            # Visa före/efter (original vs berikad)
│   │   ├── review/
│   │   │   ├── ReviewGrid.tsx             # Batch-vy med alla produkter
│   │   │   ├── BulkActions.tsx            # Godkänn alla / markerade
│   │   │   └── ApprovalStatus.tsx         # Status per produkt
│   │   └── common/
│   │       ├── FileUpload.tsx             # Fil-uppladdning (CSV, Excel, ZIP)
│   │       ├── StatusBadge.tsx
│   │       └── DataTable.tsx
│   │
│   └── types/
│       ├── shopify.ts                     # Shopify API-typer
│       ├── product.ts                     # Produkt-relaterade typer
│       └── enrichment.ts                  # AI-berikning typer
│
├── scripts/
│   ├── rembg-server.py                    # Python-server för friläggning
│   └── seed-supplier-profiles.ts          # Skapa test-leverantörsprofiler
│
├── .env.example                           # Alla miljövariabler
├── docker-compose.yml                     # Lokal dev (PostgreSQL + Redis)
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── README.md
```


---

## 4. Implementation per steg

### 4.1 Steg 1: Import (csv-parser.ts / excel-parser.ts)

```typescript
// src/services/import/csv-parser.ts

import { parse } from 'csv-parse/sync';
import chardet from 'chardet';
import iconv from 'iconv-lite';

interface ParsedRow {
  [key: string]: string;
}

interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  encoding: string;
  separator: string;
  totalRows: number;
}

export async function parseCsvFile(buffer: Buffer): Promise<ParseResult> {
  // 1. Detektera encoding
  const detectedEncoding = chardet.detect(buffer) || 'utf-8';
  const decoded = iconv.decode(buffer, detectedEncoding);
  
  // 2. Detektera separator (tab, semicolon, comma)
  const firstLine = decoded.split('\n')[0];
  const separator = detectSeparator(firstLine);
  
  // 3. Parsa
  const records = parse(decoded, {
    columns: true,
    delimiter: separator,
    skip_empty_lines: true,
    trim: true,
    relaxColumnCount: true,
  });
  
  const headers = Object.keys(records[0] || {});
  
  return {
    headers,
    rows: records,
    encoding: detectedEncoding,
    separator,
    totalRows: records.length,
  };
}

function detectSeparator(line: string): string {
  const counts = {
    '\t': (line.match(/\t/g) || []).length,
    ';': (line.match(/;/g) || []).length,
    ',': (line.match(/,/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
```

**NPM-paket för import:**
```json
{
  "csv-parse": "^5.5.0",
  "chardet": "^2.0.0",
  "iconv-lite": "^0.6.3",
  "xlsx": "^0.18.5"
}
```

### 4.2 Steg 2: Mappning (column-mapper.ts)

```typescript
// src/services/mapping/column-mapper.ts

// Shopify-fält som kan mappas till
export const SHOPIFY_FIELDS = {
  // Obligatoriska
  sku: { label: 'Artikelnummer (SKU)', required: true },
  title: { label: 'Produktnamn', required: true },
  price: { label: 'Pris', required: true },
  
  // Viktiga
  vendor: { label: 'Varumärke', required: false },
  description: { label: 'Beskrivning (leverantörens)', required: false },
  productType: { label: 'Produkttyp / Kategori', required: false },
  
  // Bilder
  imageUrl: { label: 'Bild-URL (huvudbild)', required: false },
  imageUrl2: { label: 'Bild-URL 2', required: false },
  imageUrl3: { label: 'Bild-URL 3', required: false },
  
  // Varianter
  option1Name: { label: 'Variant 1 namn (t.ex. Storlek)', required: false },
  option1Value: { label: 'Variant 1 värde', required: false },
  option2Name: { label: 'Variant 2 namn (t.ex. Färg)', required: false },
  option2Value: { label: 'Variant 2 värde', required: false },
  
  // Attribut
  color: { label: 'Färg', required: false },
  material: { label: 'Material', required: false },
  weight: { label: 'Vikt', required: false },
  barcode: { label: 'EAN / Streckkod', required: false },
  
  // Pris
  compareAtPrice: { label: 'Ordinarie pris (jämförpris)', required: false },
  costPerItem: { label: 'Inköpspris', required: false },
  
  // Övrigt
  tags: { label: 'Taggar (kommaseparerade)', required: false },
  collection: { label: 'Collection / Kollektion', required: false },
} as const;

export interface ColumnMapping {
  [supplierColumn: string]: keyof typeof SHOPIFY_FIELDS | null;
}

// Auto-mapping: försöker matcha leverantörens kolumner automatiskt
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  
  const patterns: Record<string, RegExp> = {
    sku: /^(sku|art\.?nr|artikelnr|artikelnummer|item.?number|product.?id|varunr)/i,
    title: /^(title|namn|produktnamn|product.?name|benämning|beskrivning.?kort)/i,
    price: /^(price|pris|försäljningspris|price.?incl|pris.?inkl)/i,
    vendor: /^(brand|vendor|varumärke|märke|tillverkare|manufacturer)/i,
    description: /^(description|beskrivning|product.?description|text)/i,
    imageUrl: /^(image|bild|image.?url|bild.?url|foto|picture|main.?image)/i,
    color: /^(color|colour|färg)/i,
    material: /^(material|materials)/i,
    weight: /^(weight|vikt|gross.?weight)/i,
    barcode: /^(ean|barcode|gtin|streckkod|upc)/i,
    compareAtPrice: /^(compare|ordinarie|rek.?pris|msrp|rrp|jämförpris)/i,
    costPerItem: /^(cost|inköp|inköpspris|purchase.?price|supplier.?price)/i,
    tags: /^(tags|taggar|category|kategori)/i,
  };
  
  for (const header of headers) {
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(header.trim())) {
        mapping[header] = field as keyof typeof SHOPIFY_FIELDS;
        break;
      }
    }
    if (!mapping[header]) {
      mapping[header] = null; // Omappad — kunden väljer manuellt
    }
  }
  
  return mapping;
}
```

### 4.3 Steg 3: Bildpipeline (processor.ts)

```typescript
// src/services/images/processor.ts

import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const TARGET_SIZE = 1000;
const WEBP_QUALITY = 82;
const JPG_QUALITY = 82;
const MAX_FILE_SIZE = 200 * 1024; // 200KB

interface ProcessedImage {
  webpUrl: string;     // R2 URL
  jpgUrl: string;      // R2 URL (fallback)
  width: number;
  height: number;
  fileSize: number;
  backgroundRemoved: boolean;
}

export async function processImage(
  inputBuffer: Buffer,
  options: {
    clientId: string;
    batchId: string;
    sku: string;
    position: number;
    removeBackground: boolean;
  }
): Promise<ProcessedImage> {
  let buffer = inputBuffer;
  
  // 1. Friläggning (valfritt)
  if (options.removeBackground) {
    buffer = await removeBackground(buffer);
  }
  
  // 2. Metadata
  const metadata = await sharp(buffer).metadata();
  const { width = 0, height = 0 } = metadata;
  
  // 3. Resize + padding till 1000x1000
  let processed = sharp(buffer);
  
  if (width < TARGET_SIZE && height < TARGET_SIZE) {
    // Bild är för liten — flagga men bearbeta ändå
    // Centrera med vit padding
    processed = processed.resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  } else {
    // Resize ner med bibehållen proportion + vit padding till 1:1
    processed = processed.resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }
  
  // 4. Generera .webp
  const webpBuffer = await processed.webp({ quality: WEBP_QUALITY }).toBuffer();
  
  // 5. Om för stor, komprimera mer
  let finalWebp = webpBuffer;
  if (webpBuffer.length > MAX_FILE_SIZE) {
    finalWebp = await sharp(webpBuffer)
      .webp({ quality: Math.max(50, WEBP_QUALITY - 15) })
      .toBuffer();
  }
  
  // 6. Generera .jpg fallback
  const jpgBuffer = await processed.jpeg({ quality: JPG_QUALITY }).toBuffer();
  
  // 7. Ladda upp till R2
  const basePath = `${options.clientId}/products/${options.batchId}`;
  const filename = `${options.sku}-${options.position}`;
  
  const webpUrl = await uploadToR2(`${basePath}/${filename}.webp`, finalWebp, 'image/webp');
  const jpgUrl = await uploadToR2(`${basePath}/${filename}.jpg`, jpgBuffer, 'image/jpeg');
  
  return {
    webpUrl,
    jpgUrl,
    width: TARGET_SIZE,
    height: TARGET_SIZE,
    fileSize: finalWebp.length,
    backgroundRemoved: options.removeBackground,
  };
}

// Friläggning via Python rembg (körs som subprocess eller mikrotjänst)
async function removeBackground(buffer: Buffer): Promise<Buffer> {
  // Option A: HTTP-anrop till lokal rembg-server (Python)
  const response = await fetch('http://localhost:5100/remove', {
    method: 'POST',
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  
  if (!response.ok) throw new Error('Background removal failed');
  return Buffer.from(await response.arrayBuffer());
}
```

**rembg Python-server (scripts/rembg-server.py):**
```python
from flask import Flask, request, send_file
from rembg import remove
from io import BytesIO

app = Flask(__name__)

@app.route('/remove', methods=['POST'])
def remove_bg():
    input_data = request.get_data()
    output_data = remove(input_data)
    return send_file(BytesIO(output_data), mimetype='image/png')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5100)
```

### 4.4 Brand Voice Sync + Content Production Gate

```typescript
// src/services/enrichment/brand-voice-sync.ts

// Synkar brand voice från Todas MCP Client Context Engine
// Körs ALLTID vid batch-start, INNAN AI-berikning

interface BrandVoice {
  tone: string;
  language_style: string;
  target_audience: string;
  avoid: string[];
  terminology: {
    use_swedish: string[];
    use_english: string[];
    never_write: string[];
    product_naming: string;
    brand_names: string;
  };
  examples: {
    good: string;
    bad: string;
  };
  brand_voice_onboarding_completed: boolean;
}

export async function syncBrandVoice(client: Client): Promise<BrandVoice> {
  if (!client.todasClientId) {
    throw new Error(`Client ${client.name} har ingen todasClientId — kan inte hämta brand voice`);
  }
  
  // Hämta från Todas MCP
  const response = await fetch(process.env.TODAS_MCP_URL!, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TODAS_MCP_KEY}` 
    },
    body: JSON.stringify({
      method: 'client_read',
      params: { name: client.name }
    }),
  });
  
  const clientData = await response.json();
  const brandVoice = clientData.brand_voice;
  
  // CONTENT PRODUCTION GATE (från Client Context Engine v1.2)
  if (!brandVoice?.tone) {
    throw new ContentProductionGateError(
      `⛔ STOP — brand_voice.tone är tomt för ${client.name}. ` +
      `Kör Brand Voice Onboarding-protokollet innan content produceras.`
    );
  }
  
  // Nischbransch-check
  const isNiche = clientData.identity?.industry_niche_language === true;
  if (isNiche && (!brandVoice.terminology?.use_swedish?.length && !brandVoice.terminology?.use_english?.length)) {
    throw new ContentProductionGateError(
      `⛔ STOP — ${client.name} är i en nischbransch men terminology saknas. ` +
      `Fyll i brand_voice.terminology innan content produceras.`
    );
  }
  
  // Cacha i lokal DB (för snabb åtkomst under batch)
  await prisma.client.update({
    where: { id: client.id },
    data: {
      toneOfVoice: brandVoice.tone,
      brandProfile: brandVoice, // Hela brand_voice-objektet som JSON
    },
  });
  
  return brandVoice;
}

export class ContentProductionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentProductionGateError';
  }
}
```

**Viktig konsekvens:** Om brand voice inte är ifyllt i Todas-plattformen kommer batchen INTE köra AI-berikning. Istället visas ett tydligt felmeddelande: "Kör Brand Voice Onboarding-protokollet för [kund] innan produkter kan berikas." Det förhindrar "stövlar"-problemet från grunden.

### 4.5 Steg 4: AI-berikning (enrichment-service.ts)

```typescript
// src/services/enrichment/enrichment-service.ts

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { buildEnrichmentPrompt } from './prompts/prompt-builder';
import { calculateQualityScore } from './quality-scorer';

const anthropic = new Anthropic();

interface EnrichmentInput {
  product: Product;          // Importerad produkt med rawData
  client: Client;            // Brand voice, tone_of_voice
  categoryConfig: CategoryConfig | null; // Färgklassificering, hints
  supplierDefaults: Supplier; // Leverantörsinfo
}

interface EnrichmentOutput {
  title: string;
  metaTitle: string;
  metaDescription: string;
  shortDescription: string;
  agentSummary: string;
  description: string;
  specifications: Array<{ name: string; value: string }>;
  faq: Array<{ question: string; answer: string }>;
  taxonomyCategoryId: string;
  taxonomyAttributes: Record<string, string>;
  customAttributes: Array<{ name: string; value: string }>;
  schemaJson: object;
  tags: string[];
  qualityScore: number;
  qualityDetails: object;
}

export async function enrichProduct(input: EnrichmentInput): Promise<EnrichmentOutput> {
  const { product, client, categoryConfig } = input;
  
  // 1. Bygg prompt med all kontext (inkl. komplett brand voice från MCP)
  const brandVoice = client.brandProfile as BrandVoice; // Cachad från syncBrandVoice()
  
  const prompt = buildEnrichmentPrompt({
    rawData: product.rawData,
    // Komplett brand voice — INTE bara tone, utan hela terminologi-strukturen
    brandVoice: {
      tone: brandVoice.tone,
      language_style: brandVoice.language_style,
      target_audience: brandVoice.target_audience,
      avoid: brandVoice.avoid,                          // ["Överdriven corporate-jargong", ...]
      terminology: brandVoice.terminology,               // { use_english: ["boots"], never_write: ["stövlar"], ... }
      examples: brandVoice.examples,                     // { good: "...", bad: "..." }
    },
    colorLevel: categoryConfig?.colorLevel || client.colorLevel || 'B',
    language: client.defaultLanguage,
    enrichmentHints: categoryConfig?.enrichmentHints,
    existingTitle: product.title,
    color: product.color,
    vendor: product.vendor,
  });
  
  // 2. Anropa Claude API
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', // Sonnet för batch (snabbt, billigt)
    max_tokens: 4000,
    system: getSystemPrompt(client.defaultLanguage),
    messages: [{ role: 'user', content: prompt }],
  });
  
  // 3. Parsa JSON-svar
  const enriched = parseEnrichmentResponse(response.content[0].text);
  
  // 4. Generera schema (separat — schema-architect logik)
  const schemaJson = generateProductSchema({
    ...enriched,
    sku: product.sku,
    price: product.price,
    vendor: product.vendor,
    color: product.color,
    colorLevel: categoryConfig?.colorLevel || client.colorLevel || 'B',
    images: [], // Fylls i separat
  });
  
  // 5. Beräkna kvalitetspoäng
  const { score, details } = calculateQualityScore(enriched, product);
  
  return {
    ...enriched,
    schemaJson,
    qualityScore: score,
    qualityDetails: details,
  };
}
```

**System-prompt (Module J-regler inbäddade):**

```typescript
// src/services/enrichment/prompts/system-prompt.ts

export function getSystemPrompt(language: string = 'sv'): string {
  return `Du är en expert-copywriter för Shopify e-handel. Du optimerar produktdata för tre målgrupper samtidigt: människor (konvertering), sökmotorer (SEO), och AI-agenter (AEO/GEO).

## TERMINOLOGI — KRITISKT (läs INNAN du skriver ett enda ord)

Du kommer få en terminologi-lista med fälten:
- use_swedish: Svenska termer som SKA användas
- use_english: Engelska termer som SKA behållas i svensk text (lånas in)
- never_write: Termer som ALDRIG får förekomma i texten

REGLER:
1. Om "boots" finns i use_english → skriv ALLTID "boots", ALDRIG "stövlar"
2. Om "stövlar" finns i never_write → om du skriver "stövlar" är det ett KRITISKT FEL
3. Om "harv" finns i use_swedish → använd "harv", aldrig "disk harrow"
4. Varumärkesnamn (brand_names) översätts ALDRIG
5. Produktnamn följer product_naming-regeln (t.ex. "Ariat-produkter behåller engelska namn")
6. Om du är osäker på en term: använd leverantörens originalterm framför en översättning

## TONE OF VOICE

Du kommer få ton-instruktioner med:
- tone: Övergripande tonbeskrivning
- target_audience: Vem du skriver för
- avoid: Saker som ALDRIG ska stå i texten
- examples.good: Så HÄR ska det låta
- examples.bad: Så HÄR ska det ALDRIG låta

Följ dessa EXAKT. Om "Generiska modeord (trendig, fantastisk, unik)" finns i avoid-listan,
skriv ALDRIG de orden.

## KRITISKA REGLER (Module J-standard)

### Produkttitel
- Format: [Varumärke] [Modellnamn] – [Kategori]
- ALDRIG inkludera butiksnamnet
- Max 70 tecken

### Meta title
- Max 60 tecken
- Utan butiksnamn (Shopify-tema lägger till det automatiskt)

### Meta description
- HÅRDGRÄNS: MAX 155 TECKEN. Räkna tecknen. Om det blir 156 — skriv om.
- Nivå A (färg köpbeslutande): inkludera färg
- Nivå B (standardfärg): använd utrymmet för köpbeslutande attribut

### Kort ingress (short_description)
- 2-3 meningar, nyttobaserad, SÄLJER
- Löptext — inte punktlista
- ALDRIG upprepa samma information som snabbfakta

### Snabbfakta / Agent summary
- 6-8 punkter i KÖPORDNING (viktigast först)
- Löptext för metafield (AI-crawlers läser löptext)
- Renderas som punktlista i UI (Liquid-template)
- Primärt köpbeslutande attribut först

### Produktbeskrivning (description)
- Benefit-driven
- >150 ord
- Internlänkar där relevant (markera med [INTERNLÄNK: kategori])
- Clean HTML: <h3>, <p>, <ul>, <li> — inga klasser, inga styles, inga divs

### Specifikationstabell
- Minimum 10 attribut
- Inkludera ALLTID: Färg (oavsett Nivå A/B)
- Attributnamn på ${language === 'sv' ? 'svenska' : language}
- BARA attribut som SAKNAS i Shopify Taxonomy

### FAQ
- 5-8 frågor
- Teman: passform/användning, material/motor, jämförelse, vad ingår, mått, teknologi
- Svar: 2-4 meningar, konkreta, med siffror där möjligt

## OUTPUT FORMAT
Svara ENBART med JSON (ingen markdown, inga backticks):
{
  "title": "...",
  "metaTitle": "...",
  "metaDescription": "...",
  "shortDescription": "...",
  "agentSummary": "...",
  "description": "<h3>...</h3><p>...</p>",
  "specifications": [{"name": "...", "value": "..."}],
  "faq": [{"question": "...", "answer": "..."}],
  "tags": ["...", "..."],
  "suggestedTaxonomyCategory": "...",
  "customAttributes": [{"name": "...", "value": "..."}]
}`;
}
```

### 4.5 Steg 5: Preview + Godkännande

```typescript
// Bygger på befintliga task_send_approval men utökat med batch-vy

// API route: POST /api/products/[productId]/approve
export async function approveProduct(productId: string, edits?: Partial<Product>) {
  // 1. Om kunden gjort redigeringar, spara dem
  if (edits) {
    await prisma.product.update({
      where: { id: productId },
      data: {
        ...edits,
        customerEdits: edits, // Spara diff separat
        status: 'approved',
      },
    });
  } else {
    await prisma.product.update({
      where: { id: productId },
      data: { status: 'approved' },
    });
  }
}

// API route: POST /api/products/bulk/approve
export async function bulkApprove(productIds: string[]) {
  await prisma.product.updateMany({
    where: { id: { in: productIds } },
    data: { status: 'approved' },
  });
  
  // Uppdatera batch-statistik
  // ...
}
```

### 4.6 Steg 6: Shopify Publish

```typescript
// src/services/publish/product-creator.ts

import { shopifyClient } from '@/lib/shopify/client';

const CREATE_PRODUCT_MUTATION = `
  mutation productCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product {
        id
        handle
        variants(first: 100) {
          edges {
            node {
              id
              sku
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createShopifyProduct(
  product: Product & { images: ProductImage[]; variants: ProductVariant[] },
  shopifyClient: ShopifyClient
) {
  // 1. Bygg produktinput
  const input = {
    title: product.title,
    bodyHtml: product.description,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    seo: {
      title: product.metaTitle,
      description: product.metaDescription,
    },
    variants: product.variants.map(v => ({
      sku: v.sku,
      price: String(v.price),
      compareAtPrice: v.compareAtPrice ? String(v.compareAtPrice) : null,
      inventoryQuantities: v.inventoryQty ? [{
        locationId: 'gid://shopify/Location/PRIMARY', // Konfigureras per kund
        quantity: v.inventoryQty,
      }] : undefined,
      weight: v.weight,
      weightUnit: v.weightUnit?.toUpperCase(),
      barcode: v.barcode,
      options: [v.option1Value, v.option2Value, v.option3Value].filter(Boolean),
    })),
    // Bilder läggs till via media-input
  };
  
  // 2. Bygg media-input (bilder)
  const media = product.images
    .sort((a, b) => a.position - b.position)
    .map(img => ({
      originalSource: img.processedUrl, // .webp URL från R2
      alt: img.altText,
      mediaContentType: 'IMAGE',
    }));
  
  // 3. Skapa produkt
  const result = await shopifyClient.graphql(CREATE_PRODUCT_MUTATION, {
    input,
    media,
  });
  
  if (result.productCreate.userErrors.length > 0) {
    throw new Error(result.productCreate.userErrors.map(e => e.message).join(', '));
  }
  
  const shopifyProduct = result.productCreate.product;
  
  // 4. Skapa metafields (separat mutation — Shopify kräver det)
  await syncMetafields(shopifyProduct.id, product);
  
  return {
    shopifyProductId: shopifyProduct.id,
    shopifyHandle: shopifyProduct.handle,
  };
}

// Metafield-synk
async function syncMetafields(shopifyProductId: string, product: Product) {
  const metafields = [];
  
  // FAQ (custom.faq — JSON)
  if (product.faq) {
    metafields.push({
      namespace: 'custom',
      key: 'faq',
      value: JSON.stringify(product.faq),
      type: 'json',
    });
  }
  
  // Agent summary (custom.agent_summary — text)
  if (product.agentSummary) {
    metafields.push({
      namespace: 'custom',
      key: 'agent_summary',
      value: product.agentSummary,
      type: 'multi_line_text_field',
    });
  }
  
  // Custom attributes (custom.attributes — JSON)
  if (product.customAttributes) {
    metafields.push({
      namespace: 'custom',
      key: 'attributes',
      value: JSON.stringify(product.customAttributes),
      type: 'json',
    });
  }
  
  // Kort beskrivning
  if (product.shortDescription) {
    metafields.push({
      namespace: 'custom',
      key: 'kort_beskrivning',
      value: product.shortDescription,
      type: 'multi_line_text_field',
    });
  }
  
  // Publicera metafields via mutation
  const METAFIELD_MUTATION = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  
  await shopifyClient.graphql(METAFIELD_MUTATION, {
    metafields: metafields.map(mf => ({
      ...mf,
      ownerId: shopifyProductId,
    })),
  });
}
```

### 4.7 Steg 7: Verifiering

```typescript
// src/services/verification/schema-validator.ts

// Validera schema via Google Rich Results Test API (eller manuellt via URL)
export async function validateSchema(productUrl: string): Promise<{
  valid: boolean;
  validItems: number;
  errors: string[];
}> {
  // Google Rich Results Test API kräver API-nyckel
  // Alternativ: använd web_fetch mot search.google.com/test/rich-results
  
  // Enklaste MVP-approach: bygg schema lokalt och validera med schema.org/validator
  // POST till https://validator.schema.org/
  
  return {
    valid: true, // Placeholder — implementera mot Rich Results API
    validItems: 5,
    errors: [],
  };
}

// Spara baseline-mätning
export async function recordBaseline(productId: string, url: string) {
  // Hämta GSC-data för URL:en (via Todas MCP gsc_top_pages)
  // Hämta GA4-data (sessioner, konvertering)
  // Spara i product.baselineData
  
  await prisma.product.update({
    where: { id: productId },
    data: {
      publishedUrl: url,
      baselineData: {
        recordedAt: new Date().toISOString(),
        // GSC-data fylls i asynkront (data tar 2-3 dagar att bli tillgänglig)
      },
    },
  });
}
```


---

## 5. Kvalitetspoäng (Module J DoD)

```typescript
// src/services/enrichment/quality-scorer.ts

// Baserat på Module J7 checklista — varje punkt ger poäng

interface QualityResult {
  score: number;        // 0-100
  level: 'green' | 'yellow' | 'red';
  details: {
    passed: string[];
    missing: string[];
    warnings: string[];
  };
}

export function calculateQualityScore(
  enriched: EnrichmentOutput,
  product: Product
): QualityResult {
  const checks: Array<{ name: string; weight: number; pass: boolean }> = [
    // COPY (40 poäng)
    { name: 'Produkttitel (utan butiksnamn)', weight: 5,
      pass: !!enriched.title && !enriched.title.includes(product.client?.name || '') },
    { name: 'Meta title (max 60 tecken)', weight: 5,
      pass: !!enriched.metaTitle && enriched.metaTitle.length <= 60 },
    { name: 'Meta description (max 155 tecken)', weight: 5,
      pass: !!enriched.metaDescription && enriched.metaDescription.length <= 155 },
    { name: 'Kort ingress (2-3 meningar)', weight: 5,
      pass: !!enriched.shortDescription && enriched.shortDescription.length > 50 },
    { name: 'Snabbfakta / Agent summary', weight: 5,
      pass: !!enriched.agentSummary && enriched.agentSummary.length > 100 },
    { name: 'Produktbeskrivning (>150 ord)', weight: 5,
      pass: !!enriched.description && enriched.description.split(/\s+/).length > 150 },
    { name: 'Specifikationstabell (min 10 attribut)', weight: 5,
      pass: enriched.specifications?.length >= 10 },
    { name: 'FAQ (min 5 frågor)', weight: 5,
      pass: enriched.faq?.length >= 5 },
    
    // TAXONOMY & ATTRIBUTES (25 poäng)
    { name: 'Shopify Taxonomy ifylld', weight: 8,
      pass: !!enriched.taxonomyCategoryId },
    { name: 'Taxonomy-attribut ifyllda', weight: 7,
      pass: Object.keys(enriched.taxonomyAttributes || {}).length >= 3 },
    { name: 'Färg i attribut (alltid)', weight: 5,
      pass: enriched.specifications?.some(s => 
        s.name.toLowerCase().includes('färg') || s.name.toLowerCase().includes('color')) },
    { name: 'Custom attributes på svenska', weight: 5,
      pass: enriched.customAttributes?.every(a => !/^[a-zA-Z\s]+$/.test(a.name)) || true },
    
    // SCHEMA (20 poäng)
    { name: 'Product schema genererad', weight: 8,
      pass: !!enriched.schemaJson },
    { name: 'SKU i schema', weight: 4,
      pass: enriched.schemaJson?.['sku'] != null },
    { name: 'Color i schema', weight: 4,
      pass: enriched.schemaJson?.['color'] != null },
    { name: 'additionalProperty finns', weight: 4,
      pass: enriched.schemaJson?.['additionalProperty']?.length > 0 },
    
    // BILDER (15 poäng)
    { name: 'Minst 1 bild', weight: 8,
      pass: product.images?.length > 0 },
    { name: 'Alt-text på alla bilder', weight: 7,
      pass: product.images?.every(i => !!i.altText) },
  ];
  
  const passed = checks.filter(c => c.pass);
  const missing = checks.filter(c => !c.pass);
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = passed.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((earnedWeight / totalWeight) * 100);
  
  return {
    score,
    level: score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red',
    details: {
      passed: passed.map(c => c.name),
      missing: missing.map(c => c.name),
      warnings: [
        ...(enriched.metaDescription?.length > 145 ? ['Meta description nära gränsen (145+)'] : []),
        ...(enriched.faq?.length < 6 ? ['FAQ under rekommenderat minimum (6)'] : []),
      ],
    },
  };
}
```

---

## 6. Miljövariabler (.env.example)

```bash
# ══════════════════════════════════════════
# DATABASE
# ══════════════════════════════════════════
DATABASE_URL="postgresql://user:pass@host:5432/todas_optimize"
REDIS_URL="redis://host:6379"

# ══════════════════════════════════════════
# AUTH
# ══════════════════════════════════════════
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"
NEXTAUTH_URL="https://optimize.todas.se"

# ══════════════════════════════════════════
# SHOPIFY (per kund — lagras krypterat i DB, inte här)
# Default/test-kund för utveckling:
# ══════════════════════════════════════════
SHOPIFY_DEV_DOMAIN="pqgolf-dev.myshopify.com"
SHOPIFY_DEV_TOKEN="shpat_xxx"

# ══════════════════════════════════════════
# AI
# ══════════════════════════════════════════
ANTHROPIC_API_KEY="sk-ant-xxx"
CLAUDE_MODEL_BATCH="claude-sonnet-4-20250514"
CLAUDE_MODEL_COMPLEX="claude-opus-4-20250514"

# ══════════════════════════════════════════
# BILDLAGRING (Cloudflare R2, S3-kompatibel)
# ══════════════════════════════════════════
R2_ACCOUNT_ID="xxx"
R2_ACCESS_KEY_ID="xxx"
R2_SECRET_ACCESS_KEY="xxx"
R2_BUCKET_NAME="todas-optimize-images"
R2_PUBLIC_URL="https://images.optimize.todas.se"

# ══════════════════════════════════════════
# BAKGRUNDSTJÄNSTER
# ══════════════════════════════════════════
REMBG_SERVER_URL="http://localhost:5100"  # Lokal rembg Python-server

# ══════════════════════════════════════════
# TODAS MCP (befintligt system)
# ══════════════════════════════════════════
TODAS_MCP_URL="https://todas-dashboard-production.up.railway.app/mcp"
TODAS_MCP_KEY="xxx"
```

---

## 7. BullMQ Worker-arkitektur

```typescript
// src/workers/enrichment-worker.ts

import { Worker, Job } from 'bullmq';
import { enrichProduct } from '@/services/enrichment/enrichment-service';
import { prisma } from '@/lib/db';

const enrichmentWorker = new Worker(
  'enrichment',
  async (job: Job) => {
    const { productId } = job.data;
    
    // 1. Hämta produkt med alla relationer
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        client: true,
        batch: { include: { supplier: true } },
        images: true,
      },
    });
    
    if (!product) throw new Error(`Product ${productId} not found`);
    
    // 2. Hämta kategori-config
    const categoryConfig = await prisma.categoryConfig.findFirst({
      where: {
        clientId: product.clientId,
        categoryName: product.productType || '',
      },
    });
    
    // 3. Uppdatera status
    await prisma.product.update({
      where: { id: productId },
      data: { status: 'enriching' },
    });
    
    // 4. Kör berikning
    const enriched = await enrichProduct({
      product,
      client: product.client,
      categoryConfig,
      supplierDefaults: product.batch.supplier,
    });
    
    // 5. Spara resultat
    await prisma.product.update({
      where: { id: productId },
      data: {
        status: 'enriched',
        title: enriched.title,
        metaTitle: enriched.metaTitle,
        metaDescription: enriched.metaDescription,
        shortDescription: enriched.shortDescription,
        agentSummary: enriched.agentSummary,
        description: enriched.description,
        specifications: enriched.specifications,
        faq: enriched.faq,
        taxonomyCategoryId: enriched.taxonomyCategoryId,
        taxonomyAttributes: enriched.taxonomyAttributes,
        customAttributes: enriched.customAttributes,
        schemaJson: enriched.schemaJson,
        tags: enriched.tags,
        qualityScore: enriched.qualityScore,
        qualityDetails: enriched.qualityDetails,
      },
    });
    
    // 6. Uppdatera batch-statistik
    await prisma.batch.update({
      where: { id: product.batchId },
      data: { enrichedCount: { increment: 1 } },
    });
    
    return { productId, qualityScore: enriched.qualityScore };
  },
  {
    connection: { url: process.env.REDIS_URL },
    concurrency: 3, // Max 3 parallella Claude-anrop
    limiter: {
      max: 10,
      duration: 60000, // Max 10 per minut (rate limiting)
    },
  }
);

enrichmentWorker.on('failed', async (job, err) => {
  console.error(`Enrichment failed for ${job?.data.productId}:`, err);
  if (job) {
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: 'failed', error: err.message },
    });
  }
});
```

---

## 8. MVP Milestones (exakta leverabler)

### Sprint 1 (v14-16): Import + Mappning
- [ ] `prisma migrate dev` — alla tabeller skapade
- [ ] CSV/Excel parser med encoding detection
- [ ] Kolumnmappnings-UI (dropdown per kolumn, auto-mapping)
- [ ] Leverantörsprofil: spara mappning (Supplier-tabell)
- [ ] Förhandsvisning: 5 produkter efter mappning
- [ ] Batch skapas med status `imported`
- [ ] **Testcase:** PQ Golf leverantörsfil (20 produkter) importerad och mappad korrekt

### Sprint 2 (v17-18): Bilder + Grundläggande publish
- [ ] Bilddownloader (från URL i kolumn)
- [ ] Sharp: resize 1000x1000, .webp, komprimering
- [ ] R2 upload + URL-generering
- [ ] Alt-text placeholder (fylls i av AI i sprint 3)
- [ ] Shopify Products API: skapa produkt (titel, beskrivning, pris, bilder)
- [ ] Shopify Metafields API: faq, agent_summary, attributes
- [ ] **Testcase:** 5 PQ Golf-produkter publicerade i Shopify dev-store med bilder

### Sprint 3 (v19-20): AI-berikning + Review
- [ ] Enrichment service med Claude API
- [ ] System prompt med Module J-regler
- [ ] Kvalitetsscorer (0-100)
- [ ] Batch-review-vy (produktkort med all data)
- [ ] Inline-redigering (kund kan ändra text)
- [ ] Godkänn/avvisa per produkt + bulk
- [ ] **Testcase:** Western Tack 25 produkter berikade, review-vy, publicerade

### Sprint 4 (v21-22): Bildpipeline v2 + Polish
- [ ] Friläggning (rembg-server)
- [ ] Smart padding (centrera i 1:1)
- [ ] Alt-text-generering (AI)
- [ ] Bildkvalitetskontroll (flaggning)
- [ ] Felhantering och retry-logik
- [ ] **Testcase:** Hallant batch med friläggning och komplett flöde

---

## 9. Säkerhet och GDPR

```yaml
security:
  shopify_tokens:
    storage: "Krypterade i PostgreSQL (AES-256)"
    access: "Aldrig exponerade i frontend"
    rotation: "Collaborator tokens förnyas vid behov"
  
  api_keys:
    storage: "Railway miljövariabler"
    access: "Aldrig i kod eller git"
  
  authentication:
    method: "NextAuth.js med JWT"
    session: "Server-side sessions i Redis"
    roles: ["admin", "client"]
  
  data_isolation:
    principle: "Varje kund ser BARA sin egen data"
    implementation: "client_id filter på ALLA queries"
    enforcement: "Prisma middleware som alltid filtrerar på klientId"

gdpr:
  principle: "Systemet hanterar ENBART produktdata — aldrig persondata"
  inga_kundprofiler: "Inga namn, email, adresser lagras"
  inga_orderdata: "Orderstatistik aggregeras — enskilda ordrar aldrig"
  bilddata: "Produktbilder — ingen personlig data"
  radering: "Om kund avslutar → alla produkter + bilder raderas"
```

---

## 10. Module J-förbättringar att implementera

Baserat på nuvarande erfarenhet — saker som kan göra AI-berikningen ÄNNU bättre:

### 10.1 Bättre snabbfakta-generering
Nuvarande Module J2.F specificerar "6-8 punkter i köpordning" men definierar inte köpordning per vertikal. Implementera vertikala templates:
```typescript
const QUICK_FACTS_ORDER = {
  'footwear': ['material', 'sole', 'shaft_height', 'technology', 'fit', 'weight', 'color', 'origin'],
  'golf_clubs': ['club_type', 'shaft', 'loft', 'flex', 'length', 'grip', 'technology', 'target'],
  'machinery': ['engine', 'power', 'start_method', 'transmission', 'weight', 'dimensions', 'features', 'certification'],
  'default': ['primary_material', 'key_feature', 'dimensions', 'weight', 'color', 'origin', 'certification', 'target_audience'],
};
```

### 10.2 Internlänksförslag i beskrivning
AI-berikningen bör markera var internlänkar bör placeras:
```html
<p>Ariat Renegade är perfekt för <a href="/collections/westernriding">[INTERNLÄNK: westernridning]</a> och passar utmärkt med...</p>
```
Systemet kan sedan matcha mot kundens faktiska collections och ersätta med riktiga URL:er.

### 10.3 Konkurrent-benchmark i FAQ
Generera FAQ-frågor som jämför med konkurrentprodukter:
"Hur skiljer sig Ariat Renegade från Ariat Heritage Roper?"
Kräver att systemet vet vilka andra produkter kunden säljer i samma kategori.

### 10.4 Search & Discovery-optimering
Efter publicering: automatiskt konfigurera:
- Synonymer: "boots" → "stövlar", "western" → "cowboy"
- Boosts: produkter med hög kvalitetspoäng boosted i sökning
- Relaterade produkter: baserat på delade attribut (samma märke + kategori)

---

## 11. Docker Compose (lokal utveckling)

```yaml
# docker-compose.yml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: todas
      POSTGRES_PASSWORD: localdev
      POSTGRES_DB: todas_optimize
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  rembg:
    build:
      context: ./scripts
      dockerfile: Dockerfile.rembg
    ports:
      - "5100:5100"

volumes:
  pgdata:
```

```dockerfile
# scripts/Dockerfile.rembg
FROM python:3.11-slim
RUN pip install flask rembg onnxruntime
COPY rembg-server.py /app/server.py
WORKDIR /app
EXPOSE 5100
CMD ["python", "server.py"]
```

---

## 12. Kom-igång-guide för Tobias

```bash
# 1. Klona och installera
git clone [repo] && cd todas-optimize
npm install

# 2. Starta lokala tjänster
docker compose up -d

# 3. Skapa databas
npx prisma migrate dev

# 4. Seeda testdata
npx prisma db seed

# 5. Starta dev-server
npm run dev

# 6. Öppna http://localhost:3000
```

### Utvecklingsordning (rekommenderad)

1. **Dag 1-2:** Sätt upp projekt med Next.js + Prisma + Docker. Skapa alla tabeller. Verifiera att databas fungerar.
2. **Dag 3-5:** Bygg CSV/Excel-parser. Testa med PQ Golf-fil. Bygg kolumnmappnings-UI.
3. **Dag 6-8:** Bygg leverantörsprofil (spara mappning). Bygg batch-skapande-flöde.
4. **Dag 9-11:** Bygg grundläggande bildbearbetning (Sharp). Testa resize + .webp.
5. **Dag 12-14:** Koppla Shopify Admin API. Testa: skapa 1 produkt med bilder och metafields.
6. **Dag 15-17:** Bygg enrichment service med Claude API. Testa: 5 produkter berikade.
7. **Dag 18-20:** Bygg review-vy. Produktkort, inline-redigering, godkännande.
8. **Dag 21-25:** Integrera allt end-to-end. Testa komplett flöde med PQ Golf.

---

*Dokumentet uppdateras löpande. Version 1.0 — 2026-03-30.*
