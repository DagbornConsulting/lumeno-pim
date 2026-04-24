# 🛍️ Shopify App Setup via Dev Dashboard (2026)

Sedan 1 januari 2026 måste alla nya appar skapas via **dev.shopify.com** istället för inne i Shopify Admin.

---

## 📋 Översikt

```
┌─────────────────────────────────────────────────────────────┐
│  1. Skapa app i Dev Dashboard (dev.shopify.com)             │
│  2. Konfigurera API scopes                                  │
│  3. Skapa en app-version                                    │
│  4. Installera appen i dina butiker                         │
│  5. Koppla till PIM                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Steg 1: Logga in på Dev Dashboard

1. Gå till **[dev.shopify.com](https://dev.shopify.com)**
2. Logga in med ditt Shopify-konto (samma som du använder för din butik)
3. Du kommer till **Dev Dashboard**

---

## Steg 2: Skapa en ny app

1. Klicka **"Apps"** i vänstermenyn
2. Klicka **"Create app"** (övre högra hörnet)
3. Välj **"Start from Dev Dashboard"** (inte CLI)
4. Ange app-namn: `PQ Golf PIM`
5. Klicka **"Create"**

---

## Steg 3: Konfigurera appen

### 3.1 App Configuration

1. Gå till fliken **"Configuration"**
2. Fyll i följande:

| Fält | Värde |
|------|-------|
| App URL | `https://pim.pqgolf.se` (eller `http://localhost:3001` för utveckling) |
| Allowed redirection URLs | `https://pim.pqgolf.se/api/shopify/callback` |
| | `http://localhost:3001/api/shopify/callback` |

### 3.2 API Access Scopes

Scrolla ner till **"Admin API access scopes"** och välj dessa:

#### Produkter & Lager (Obligatoriska)
```
✅ read_products          - Läsa produkter
✅ write_products         - Skapa/uppdatera produkter
✅ read_inventory         - Läsa lagersaldon
✅ write_inventory        - Uppdatera lagersaldon
✅ read_locations         - Lista lagerplatser
```

#### Metafält & Metaobjekt (För varumärken, etiketter etc)
```
✅ read_metaobject_definitions    - Läsa metaobjekt-definitioner
✅ write_metaobject_definitions   - Skapa metaobjekt-definitioner
✅ read_metaobjects               - Läsa metaobjekt (varumärken)
✅ write_metaobjects              - Skapa metaobjekt
```

#### Valfria (men rekommenderade)
```
✅ read_price_rules       - Läsa rabatter (för PriceManager)
✅ write_price_rules      - Skapa rabatter
✅ read_discounts         - Läsa rabattkoder
✅ write_discounts        - Skapa rabattkoder
✅ read_publications      - Läsa publiceringskanaler
✅ write_publications     - Publicera till kanaler
✅ read_translations      - Läsa översättningar
✅ write_translations     - Skapa översättningar (för multi-språk)
```

3. Klicka **"Save"**

---

## Steg 4: Skapa en App Version

En "version" är en snapshot av din app-konfiguration.

1. Gå till fliken **"Versions"**
2. Klicka **"Create version"**
3. Fyll i:
   - Version name: `1.0.0`
   - (Valfritt) Release notes: `Initial PIM integration`
4. Klicka **"Create"**

---

## Steg 5: Hämta Client Credentials

1. Gå till fliken **"Overview"** eller **"Client credentials"**
2. Kopiera:
   - **Client ID** → `SHOPIFY_API_KEY`
   - **Client secret** → `SHOPIFY_API_SECRET` (klicka "Show" först)

3. Lägg till i din `.env`:

```env
SHOPIFY_API_KEY=ditt-client-id-här
SHOPIFY_API_SECRET=ditt-client-secret-här
APP_URL=https://pim.pqgolf.se
FRONTEND_URL=https://pim.pqgolf.se
```

---

## Steg 6: Installera appen i dina butiker

### Alternativ A: Via Dev Dashboard

1. Gå till fliken **"Home"** i din app
2. Scrolla ner till **"Install app"**
3. Klicka **"Select store"**
4. Välj butiken du vill installera i (t.ex. `pqgolf.myshopify.com`)
5. Klicka **"Install"**
6. Godkänn behörigheterna i Shopify

### Alternativ B: Via installationslänk

1. Gå till fliken **"Distribution"**
2. Kopiera **Installation URL**
3. Öppna länken i en webbläsare där du är inloggad i rätt butik
4. Godkänn installationen

---

## Steg 7: Upprepa för alla butiker

Installera appen i alla dina butiker:

- ✅ pqgolf.myshopify.com (Sverige)
- ✅ pqgolf-dk.myshopify.com (Danmark)
- ✅ pqgolf-no.myshopify.com (Norge)
- ✅ pqgolf-fi.myshopify.com (Finland)

---

## Steg 8: Anslut till PIM

När appen är installerad i dina butiker:

1. Öppna PIM (`http://localhost:5173` eller din produktions-URL)
2. Gå till **Butiker**
3. Klicka **"Anslut butik"**
4. Ange butiksdomän (t.ex. `pqgolf`)
5. Klicka **"Fortsätt till Shopify"**
6. Du skickas till Shopify → Godkänn → Tillbaka till PIM
7. ✅ Butiken är ansluten!

---

## 🔑 Sammanfattning: Alla API Scopes

Kopiera denna lista när du konfigurerar scopes:

```
read_products
write_products
read_inventory
write_inventory
read_locations
read_metaobject_definitions
write_metaobject_definitions
read_metaobjects
write_metaobjects
read_price_rules
write_price_rules
read_discounts
write_discounts
read_publications
write_publications
read_translations
write_translations
```

---

## 🔄 Client Credentials Grant (Ny autentisering)

Det nya Dev Dashboard använder **Client Credentials Grant** istället för de gamla access tokens. Detta betyder:

1. **Tokens utgår** - Automatisk förnyelse hanteras av PIM
2. **Säkrare** - Ingen permanent token som kan läcka
3. **Automatiskt** - Du behöver inte hantera tokens manuellt

PIM hanterar detta automatiskt när du ansluter via OAuth.

---

## 📁 Struktur i Dev Dashboard

```
Dev Dashboard
├── Apps
│   └── PQ Golf PIM
│       ├── Overview (Client ID, Install)
│       ├── Configuration (URLs, Scopes)
│       ├── Versions (1.0.0)
│       ├── Distribution (Install links)
│       └── Insights (Usage, Errors)
│
└── Dev stores (Test-butiker)
    ├── pqgolf-test.myshopify.com
    └── ...
```

---

## ⚠️ Vanliga problem

### "Invalid client credentials"
→ Kontrollera att Client ID och Secret är korrekt i `.env`

### "Redirect URI mismatch"
→ Lägg till exakt URL under "Allowed redirection URLs":
  - `http://localhost:3001/api/shopify/callback`
  - `https://pim.pqgolf.se/api/shopify/callback`

### "App not installed"
→ Du måste installera appen i butiken först via Dev Dashboard

### "Insufficient scopes"
→ Lägg till saknade scopes under Configuration → Admin API access scopes
→ Skapa en ny version
→ Användare måste godkänna de nya behörigheterna

---

## 🚀 Produktionsinstallation

För produktion:

1. **Uppdatera URLs** i Dev Dashboard Configuration:
   ```
   App URL: https://pim.pqgolf.se
   Redirect URLs: https://pim.pqgolf.se/api/shopify/callback
   ```

2. **Uppdatera .env** på servern:
   ```env
   APP_URL=https://pim.pqgolf.se
   FRONTEND_URL=https://pim.pqgolf.se
   ```

3. **HTTPS krävs** - Shopify kräver HTTPS för produktionsappar

---

## 📚 Läs mer

- [Dev Dashboard dokumentation](https://shopify.dev/docs/apps/build/dev-dashboard)
- [API Access Scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Client Credentials Grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials)

---

## ✅ Checklista

- [ ] Skapat app i dev.shopify.com
- [ ] Lagt till alla API scopes
- [ ] Skapat app version
- [ ] Kopierat Client ID och Secret till .env
- [ ] Installerat appen i alla butiker
- [ ] Anslutit butikerna i PIM

Lycka till! 🏌️
