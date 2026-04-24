# PQ Golf PIM System

Multi-store Product Information Management system for Shopify stores with Claude AI integration.

## Features

- 🏪 **Multi-Store Support** - Manage products across multiple Shopify stores from one place
- 🤖 **AI-Powered** - Claude AI for product descriptions, SEO, and file parsing
- 📦 **Complete Product Management** - All 51 Shopify CSV fields supported
- 🖼️ **Image Sync** - Automatic image matching from supplier servers
- 💰 **Price Campaigns** - Bulk pricing for sales periods with one-click restore
- 🔄 **Background Sync** - Queue-based syncing with retry logic
- 📊 **Metafield Support** - Standard metafields pushed to all stores

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        PIM SYSTEM                            │
├──────────────────────────────────────────────────────────────┤
│  React Frontend          │  Node.js Backend                  │
│  ├── Product Management  │  ├── REST API                     │
│  ├── Price Manager       │  ├── Claude AI Integration        │
│  ├── Image Sync          │  ├── Shopify Sync Service         │
│  └── Store Configuration │  └── Background Worker            │
├──────────────────────────────────────────────────────────────┤
│                     PostgreSQL (Supabase)                    │
│  products, variants, images, stores, sync_queue, campaigns   │
├──────────────────────────────────────────────────────────────┤
│                      Shopify Stores                          │
│  pqgolf.se  │  pqgolf.dk  │  pqgolf.no  │  pqgolf.fi         │
└──────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Clone and Install

```bash
git clone <repo>
cd pim-project-v2
npm install
```

### 2. Set Up Database

**Option A: Supabase (Recommended)**

1. Create project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run `database/schema.sql`
3. Copy API keys from Settings > API

**Option B: Local PostgreSQL**

```bash
createdb pim_db
psql pim_db < database/schema.sql
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your keys
```

### 4. Run

```bash
# Development (frontend + backend)
npm run dev

# Production
npm run build
npm run server
```

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| `products` | Main product data, metafields, SEO |
| `variants` | SKU, barcode, pricing per variant |
| `images` | Up to 8 images per product |
| `stores` | Shopify store connections |
| `store_products` | Product ↔ Store mapping + sync status |

### Supporting Tables

| Table | Description |
|-------|-------------|
| `sync_queue` | Background sync jobs |
| `price_campaigns` | Sales periods with restore data |
| `metafield_definitions` | Standard metafields for all stores |
| `supplier_profiles` | Import configurations per supplier |
| `activity_log` | Audit trail |

## Metafields

These metafields are automatically synced to all stores:

| Field | Namespace.Key | Type |
|-------|---------------|------|
| Varumärke | `custom.varumarke` | metaobject_reference |
| Kategori | `filters.kategori` | single_line_text |
| Golfkläder | `custom.golfklader` | single_line_text |
| Sortering | `filters.sortering` | single_line_text |
| Kort beskrivning | `custom.kort_produktbeskrivning` | multi_line_text |
| Product Label | `theme.label` | single_line_text |
| Label Color | `theme.label_color` | color |

## API Endpoints

### Products

```
GET    /api/db/products          - List products
GET    /api/db/products/:id      - Get product
POST   /api/db/products          - Create product
PUT    /api/db/products/:id      - Update product
DELETE /api/db/products/:id      - Delete product
POST   /api/db/products/bulk-update - Bulk update
```

### Stores

```
GET    /api/db/stores            - List stores
POST   /api/db/stores            - Create store
POST   /api/db/stores/:id/test   - Test connection
POST   /api/db/stores/:id/sync   - Sync pending products
POST   /api/db/stores/:id/sync-metafields - Sync metafield definitions
```

### Publishing

```
POST   /api/db/products/:id/publish - Publish to stores
GET    /api/db/products/:id/sync-status - Get sync status
```

### Price Campaigns

```
GET    /api/db/campaigns         - List campaigns
POST   /api/db/campaigns         - Create campaign
POST   /api/db/campaigns/:id/end - End campaign (restore prices)
```

### AI

```
POST   /api/claude/chat          - Chat with Claude
POST   /api/claude/generate-description - Generate product text
POST   /api/claude/batch-generate - Batch generate
POST   /api/claude/parse-products - Parse supplier file
```

## Sync Flow

```
1. Save product in PIM
   ↓
2. store_products.sync_status = 'pending'
   ↓
3. Background worker picks up job
   ↓
4. Shopify API: Create/Update product
   ↓
5. store_products.sync_status = 'synced'
```

## Shopify App Setup

For each store:

1. Go to **Admin > Settings > Apps > Develop apps**
2. Create new app with scopes:
   - `read_products`, `write_products`
   - `read_inventory`, `write_inventory`
   - `read_metaobject_definitions`, `write_metaobject_definitions`
3. Install app and copy Admin API access token
4. Add token to store in PIM

## Price Campaign Example

```javascript
// Create 20% off campaign for TaylorMade
POST /api/db/campaigns
{
  "campaign": {
    "name": "Black Friday 2024",
    "discountPercent": 20,
    "filters": { "vendors": ["TaylorMade"] }
  },
  "productPrices": [
    {
      "productId": "uuid",
      "originalPrice": 6499,
      "originalCompareAt": null,
      "newPrice": 5199
    }
  ]
}

// End campaign (restore all prices)
POST /api/db/campaigns/:id/end
```

## Development

```bash
# Run frontend only
npm run dev:client

# Run backend only
npm run dev:server

# Run both
npm run dev

# Test database connection
npm run db:setup
```

## File Structure

```
pim-project-v2/
├── src/
│   ├── components/
│   │   ├── ProductDetail.jsx    # Product editor (9 tabs)
│   │   ├── PriceManager.jsx     # Bulk pricing
│   │   ├── ImageSync.jsx        # Image import
│   │   ├── ShopifyExport.jsx    # CSV export
│   │   └── Sidekick.jsx         # AI assistant
│   ├── data/
│   │   └── demoData.js          # Demo products
│   └── App.jsx                  # Main app
├── server/
│   ├── index.js                 # Express server
│   ├── db.js                    # Database module
│   └── shopify.js               # Shopify sync
├── database/
│   ├── schema.sql               # Full database schema
│   └── SETUP.md                 # Setup guide
└── package.json
```

## License

Private - PQ Golf
