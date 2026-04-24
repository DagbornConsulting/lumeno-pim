# PQ Golf PIM - Databasuppsättning

## Snabbstart med Supabase

### 1. Skapa Supabase-projekt

1. Gå till [supabase.com](https://supabase.com) och skapa konto
2. Klicka "New Project"
3. Välj organisation och fyll i:
   - **Name:** `pqgolf-pim`
   - **Database Password:** Generera ett starkt lösenord (spara det!)
   - **Region:** `eu-north-1` (Stockholm) för bäst prestanda
4. Klicka "Create new project" och vänta ~2 min

### 2. Hämta anslutningsuppgifter

I Supabase Dashboard:
1. Gå till **Settings** → **API**
2. Kopiera:
   - **Project URL:** `https://xxxxx.supabase.co`
   - **anon/public key:** `eyJhbG...` (för frontend)
   - **service_role key:** `eyJhbG...` (för backend - HEMLIGHÅLL!)

3. Gå till **Settings** → **Database**
4. Kopiera **Connection string** (URI format)

### 3. Kör databasschema

1. Gå till **SQL Editor** i Supabase Dashboard
2. Kopiera innehållet från `database/schema.sql`
3. Klicka "Run" (grön knapp)
4. Verifiera i **Table Editor** att alla tabeller skapats

### 4. Konfigurera miljövariabler

Skapa `.env` i projektets rot:

```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...
SUPABASE_SERVICE_KEY=eyJhbG...

# Database (för direkt anslutning om behövs)
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.xxxxx.supabase.co:5432/postgres

# Anthropic (för AI-funktioner)
ANTHROPIC_API_KEY=sk-ant-...

# Shopify (läggs till per butik)
# SHOPIFY_PQGOLF_SE_TOKEN=shpat_...
# SHOPIFY_PQGOLF_DK_TOKEN=shpat_...

# Server
PORT=3001
NODE_ENV=development
```

---

## Alternativ: Lokal PostgreSQL

### Med Docker

```bash
# Starta PostgreSQL container
docker run --name pim-postgres \
  -e POSTGRES_USER=pim \
  -e POSTGRES_PASSWORD=pim_secret \
  -e POSTGRES_DB=pim_db \
  -p 5432:5432 \
  -d postgres:15

# Kör schema
docker exec -i pim-postgres psql -U pim -d pim_db < database/schema.sql
```

`.env` för lokal:
```bash
DATABASE_URL=postgresql://pim:pim_secret@localhost:5432/pim_db
```

### Med Homebrew (Mac)

```bash
brew install postgresql@15
brew services start postgresql@15
createdb pim_db
psql pim_db < database/schema.sql
```

---

## Databasstruktur

```
┌─────────────────────────────────────────────────────────────┐
│                         STORES                               │
│  Shopify-butiker (pqgolf.se, pqgolf.dk, etc.)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ store_products
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        PRODUCTS                              │
│  Huvudprodukter med all info                                │
│  ├── variants (SKU, pris, lager per variant)                │
│  ├── images (upp till 8 bilder)                             │
│  └── metafields (JSONB)                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ price_campaign_products
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    PRICE_CAMPAIGNS                           │
│  Rea-perioder med backup för återställning                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Viktiga tabeller

| Tabell | Beskrivning |
|--------|-------------|
| `products` | Alla produkter med titel, beskrivning, SEO, metafields |
| `variants` | Varianter (SKU, EAN, pris, storlek/färg/loft) |
| `images` | Produktbilder med position och alt-text |
| `stores` | Shopify-butiker med API-tokens |
| `store_products` | Koppling produkt ↔ butik + sync-status |
| `sync_queue` | Kö för bakgrundssynkning |
| `price_campaigns` | Rea-perioder |
| `metafield_definitions` | Dina 7 standardmetafält |
| `supplier_profiles` | Leverantörsprofiler för import |

---

## Nästa steg

Efter setup:

1. **Testa anslutning:**
   ```bash
   cd server
   node -e "require('./db').testConnection()"
   ```

2. **Starta backend:**
   ```bash
   npm run server
   ```

3. **Koppla första butiken:**
   - Skapa Shopify Custom App i butiken
   - Lägg till API-token i PIM
   - Synka metafield-definitioner
