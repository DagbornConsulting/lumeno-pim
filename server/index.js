import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import multer from 'multer';
import { db, supabase, isDbConfigured } from './db.js';
import shopifySync, { SyncWorker } from './shopify.js';
import shopifyApp from './shopify-app.js';
import { processImage, downloadImage, generateAltText, getImageMetadata } from './services/image-processor.js';
import { feedService } from './feed-generator.js';

// Heavy modules — loaded in the background so they don't block cold-start parsing
let anthropic = null;
let parseCsvBuffer = null;
let parseExcelBuffer = null;
let autoMapColumns = null, applyMapping = null, getMappingStats = null, SHOPIFY_FIELDS = null;

const _loadHeavyModules = async () => {
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  } catch {}
  try {
    ({ parseCsvBuffer } = await import('./services/csv-parser.js'));
  } catch {}
  try {
    ({ parseExcelBuffer } = await import('./services/excel-parser.js'));
  } catch {}
  try {
    ({ autoMapColumns, applyMapping, getMappingStats, SHOPIFY_FIELDS } = await import('./services/column-mapper.js'));
  } catch {}
};
_loadHeavyModules(); // fire-and-forget, runs in background

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const app = express();
const PORT = process.env.PORT || 3001;

// Initialize sync worker
const syncWorker = new SyncWorker();

// Middleware
// CORS - restrict in production, allow all in development
const isProduction = process.env.NODE_ENV === 'production';
const corsOrigins = isProduction && process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : true;
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// File upload config

// Anthropic and heavy parsers are background-loaded above

// ============================================
// AUTHENTICATION (User-based with admin/client roles)
// ============================================

// In-memory fallback stores — only used when Supabase is NOT configured (local dev without DB).
// In production these MUST stay empty; serverless invocations would otherwise see inconsistent state.
const memoryTokens = new Map(); // token -> { userId, expiresAt }
const memoryUsers = new Map(); // id -> { id, name, email, password_hash, role }
const memoryUserStores = new Map(); // userId -> [{ store_id, store_name, store_domain }]

// Cryptographically secure random token (256 bits, base64url).
const generateToken = () => 'pim_' + crypto.randomBytes(32).toString('base64url');

// bcrypt password hashing (cost factor 10 ≈ ~70ms per hash on modern hw).
const hashPassword = (password) => bcrypt.hashSync(String(password), 10);
const verifyPassword = (password, hash) => {
  if (!hash) return false;
  // Legacy support: SHA-256 hashes (64 hex chars, no $) from before bcrypt.
  if (/^[a-f0-9]{64}$/.test(hash)) {
    const sha = crypto.createHash('sha256').update(String(password)).digest('hex');
    return sha === hash;
  }
  try { return bcrypt.compareSync(String(password), hash); } catch { return false; }
};

// Session duration: 7 days
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Always use Supabase for sessions when DB is configured.
// In-memory fallback only applies to local dev with no Supabase set up.
const useSupabaseSessions = isDbConfigured();
if (useSupabaseSessions) {
  console.log('✅ Using Supabase for sessions');
} else {
  console.log('⚠️ Supabase not configured — falling back to in-memory sessions (dev only)');
}

// Create session
const createSession = async (token, userId) => {
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  if (useSupabaseSessions) {
    try {
      const { error } = await supabase
        .from('sessions')
        .insert({ token, user_id: userId, expires_at: expiresAt.toISOString() });
      if (!error) return true;
    } catch (e) {
      console.error('Supabase session create failed, using memory:', e.message);
    }
  }

  // Fallback to memory
  memoryTokens.set(token, { userId, expiresAt });
  return true;
};

// Verify session - returns { userId, role, storeIds } or false
const verifySession = async (token) => {
  if (!token) return false;

  let userId = null;

  if (useSupabaseSessions) {
    try {
      const { data, error } = await supabase
        .from('sessions')
        .select('id, user_id, expires_at')
        .eq('token', token)
        .single();

      if (!error && data) {
        if (new Date(data.expires_at) < new Date()) {
          await supabase.from('sessions').delete().eq('token', token);
          return false;
        }
        // Update last_used_at
        await supabase
          .from('sessions')
          .update({ last_used_at: new Date().toISOString() })
          .eq('token', token);
        userId = data.user_id;
      }
    } catch (e) {
      // Fall through to memory check
    }
  }

  // Check in memory if not found in Supabase
  if (!userId) {
    const session = memoryTokens.get(token);
    if (session && session.expiresAt > new Date()) {
      userId = session.userId;
    } else {
      if (session) memoryTokens.delete(token);
      return false;
    }
  }

  // Look up user info
  let user = null;
  let storeIds = [];

  if (useSupabaseSessions) {
    try {
      const { data: userData } = await supabase
        .from('users')
        .select('id, role')
        .eq('id', userId)
        .single();
      if (userData) {
        user = userData;
        const { data: userStores } = await supabase
          .from('user_stores')
          .select('store_id')
          .eq('user_id', userId);
        storeIds = (userStores || []).map(us => us.store_id);
      }
    } catch (e) {
      // Fall through to memory
    }
  }

  if (!user) {
    const memUser = memoryUsers.get(userId);
    if (memUser) {
      user = { id: memUser.id, role: memUser.role };
      const memStores = memoryUserStores.get(userId);
      storeIds = (memStores || []).map(us => us.store_id);
    }
  }

  if (!user) return false;

  return { userId: user.id, role: user.role, storeIds };
};

// Delete session
const deleteSession = async (token) => {
  if (!token) return;

  if (useSupabaseSessions) {
    try {
      await supabase.from('sessions').delete().eq('token', token);
    } catch (e) {
      // Ignore
    }
  }
  memoryTokens.delete(token);
};

// Clean up expired sessions
const cleanupExpiredSessions = async () => {
  // Clean memory tokens
  const now = new Date();
  for (const [token, session] of memoryTokens) {
    if (session.expiresAt < now) {
      memoryTokens.delete(token);
    }
  }

  // Clean Supabase if available
  if (useSupabaseSessions) {
    try {
      await supabase.from('sessions').delete().lt('expires_at', now.toISOString());
    } catch (e) {
      // Ignore
    }
  }
};

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

// Get full user info with stores
const getUserWithStores = async (userId) => {
  let user = null;
  let stores = [];

  if (useSupabaseSessions) {
    try {
      const { data: userData } = await supabase
        .from('users')
        .select('id, name, email, role')
        .eq('id', userId)
        .single();
      if (userData) {
        user = userData;
        const { data: userStores } = await supabase
          .from('user_stores')
          .select('store_id, stores(id, name, domain)')
          .eq('user_id', userId);
        stores = (userStores || []).map(us => us.stores).filter(Boolean);
      }
    } catch (e) {
      // Fall through to memory
    }
  }

  if (!user) {
    const memUser = memoryUsers.get(userId);
    if (memUser) {
      user = { id: memUser.id, name: memUser.name, email: memUser.email, role: memUser.role };
      const memStores = memoryUserStores.get(userId) || [];
      stores = memStores.map(us => ({ id: us.store_id, name: us.store_name || '', domain: us.store_domain || '' }));
    }
  }

  return user ? { ...user, stores } : null;
};

// Auth middleware - checks for valid token and attaches user info
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  const session = await verifySession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = {
    id: session.userId,
    role: session.role,
    storeIds: session.storeIds,
    activeStoreId: req.headers['x-store-id'] || (session.storeIds.length > 0 ? session.storeIds[0] : null)
  };
  next();
};

// Admin middleware - checks that user has admin role
const requireAdmin = async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - admin access required' });
  }
  next();
};

// ============================================
// STORE ID HELPER
// ============================================
const getStoreId = (req) => {
  return req.headers['x-store-id'] || req.query.storeId || req.user?.activeStoreId;
};

// Async version: falls back to user's first store from DB
const resolveStoreId = async (req) => {
  const fromReq = getStoreId(req);
  if (fromReq) return fromReq;
  if (!supabase || !req.user?.id) return null;
  const { data } = await supabase.from('stores').select('id').limit(1).single();
  return data?.id || null;
};

// ============================================
// PROTECT DATA + AI ENDPOINTS
// Anything under /api/db, /api/claude, /api/shopify, /api/import, /api/images,
// /api/mappings and /api/feeds requires a valid session token.
// /api/auth/* and /api/health stay open.
// ============================================
const protectedPrefixes = ['/api/db', '/api/claude', '/api/shopify', '/api/import', '/api/images', '/api/mappings', '/api/feeds', '/api/inventory'];
const publicShopifyPaths = ['/api/shopify/callback', '/api/shopify/install', '/api/shopify/app-status', '/api/shopify/webhooks'];
app.use((req, res, next) => {
  // Public feed URLs use a per-feed token, not a session token
  if (req.path.startsWith('/api/feeds/') && req.method === 'GET') return next();
  // Shopify OAuth endpoints must be public (no auth header from Shopify)
  if (publicShopifyPaths.some(p => req.path.startsWith(p))) return next();
  if (protectedPrefixes.some(p => req.path.startsWith(p))) {
    return requireAuth(req, res, next);
  }
  next();
});

// Health / ping — no auth, no DB
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Login endpoint
app.post('/api/auth/login', async (req, res) => {

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-post och lösenord krävs' });
  }

  let user = null;

  // Look up user in Supabase
  if (useSupabaseSessions) {

    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email, password_hash, role')
        .eq('email', email.toLowerCase())
        .single();

      if (!error && data) {
        user = data;
      }
    } catch (e) {

      // Fall through to memory
    }
  }

  // Check in memory
  if (!user) {
    for (const [id, memUser] of memoryUsers) {
      if (memUser.email === email.toLowerCase()) {
        user = memUser;
        break;
      }
    }
  }

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Felaktig e-post eller lösenord' });
  }

  const token = generateToken();
  const created = await createSession(token, user.id);

  if (!created) {
    return res.status(500).json({ error: 'Kunde inte skapa session' });
  }

  // Get user with stores
  const userInfo = await getUserWithStores(user.id);

  res.json({
    success: true,
    token,
    user: {
      id: userInfo.id,
      name: userInfo.name,
      email: userInfo.email,
      role: userInfo.role,
      stores: userInfo.stores
    }
  });
});

// Verify token endpoint
app.get('/api/auth/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  const session = await verifySession(token);
  if (!session) {
    return res.status(401).json({ valid: false });
  }

  const userInfo = await getUserWithStores(session.userId);
  if (!userInfo) {
    return res.status(401).json({ valid: false });
  }

  res.json({
    valid: true,
    user: {
      id: userInfo.id,
      name: userInfo.name,
      email: userInfo.email,
      role: userInfo.role,
      stores: userInfo.stores
    }
  });
});

// Logout endpoint
app.post('/api/auth/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  await deleteSession(token);
  res.json({ success: true });
});

// Register new user (admin only)
app.post('/api/auth/register', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Namn, e-post och lösenord krävs' });
  }

  const validRoles = ['admin', 'client'];
  const userRole = validRoles.includes(role) ? role : 'client';
  const passwordHash = hashPassword(password);
  const userEmail = email.toLowerCase();

  let newUser = null;

  if (useSupabaseSessions) {
    try {
      // Check if email already exists
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', userEmail)
        .single();
      if (existing) {
        return res.status(409).json({ error: 'E-postadressen används redan' });
      }

      const { data, error } = await supabase
        .from('users')
        .insert({ name, email: userEmail, password_hash: passwordHash, role: userRole })
        .select('id, name, email, role')
        .single();
      if (!error && data) {
        newUser = data;
      }
    } catch (e) {
      // Fall through to memory
    }
  }

  if (!newUser) {
    // Check memory for duplicate email
    for (const [id, memUser] of memoryUsers) {
      if (memUser.email === userEmail) {
        return res.status(409).json({ error: 'E-postadressen används redan' });
      }
    }

    const id = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const memEntry = { id, name, email: userEmail, password_hash: passwordHash, role: userRole };
    memoryUsers.set(id, memEntry);
    newUser = { id, name, email: userEmail, role: userRole };
  }

  res.json({ success: true, user: newUser });
});

// List all users (admin only)
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  let users = [];

  if (useSupabaseSessions) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email, role, created_at');
      if (!error && data) {
        users = data;
      }
    } catch (e) {
      // Fall through to memory
    }
  }

  if (users.length === 0) {
    for (const [id, memUser] of memoryUsers) {
      users.push({ id: memUser.id, name: memUser.name, email: memUser.email, role: memUser.role });
    }
  }

  res.json({ users });
});

// Assign stores to a user (admin only)
app.post('/api/users/:id/stores', requireAuth, requireAdmin, async (req, res) => {
  const { id: userId } = req.params;
  const { store_ids } = req.body;

  if (!Array.isArray(store_ids)) {
    return res.status(400).json({ error: 'store_ids måste vara en array' });
  }

  let success = false;

  if (useSupabaseSessions) {
    try {
      // Remove existing store assignments
      await supabase.from('user_stores').delete().eq('user_id', userId);

      // Insert new assignments
      if (store_ids.length > 0) {
        const rows = store_ids.map(store_id => ({ user_id: userId, store_id }));
        const { error } = await supabase.from('user_stores').insert(rows);
        if (!error) success = true;
      } else {
        success = true;
      }
    } catch (e) {
      // Fall through to memory
    }
  }

  if (!success) {
    memoryUserStores.set(userId, store_ids.map(store_id => ({ store_id })));
    success = true;
  }

  res.json({ success: true, user_id: userId, store_ids });
});

// ============================================
// CLAUDE AI ENDPOINTS
// ============================================

// Chat with Claude (general sidekick)
app.post('/api/claude/chat', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(400).json({ 
        error: 'API key not configured',
        message: 'Please add ANTHROPIC_API_KEY to your .env file'
      });
    }

    const { messages, context } = req.body;

    const systemPrompt = `Du är en AI-assistent i ett PIM-system (Product Information Management) för golfprodukter.
Du hjälper användaren att:
- Analysera och importera leverantörsfiler
- Extrahera produktattribut från produktnamn (varumärke, loft, shaft, fattning, storlek, färg)
- Generera produkttexter och SEO-innehåll
- Svara på frågor om produktdata

Produkttyper och deras varianter:
- Metalwoods (Drivers, Fairways, Hybrider): Fattning (Höger/Vänster), Loft (9°, 10.5°, etc), Skaft (Stiff, Regular, Senior)
- Järnset: Fattning, Antal klubbor (5-PW, 4-PW), Skaft
- Wedges: Fattning, Loft/Bounce (52°/09, 56°/12), Skaft
- Kläder: Färg, Storlek (S, M, L, XL)
- Tillbehör: Hand, Storlek

${context ? `Aktuell kontext:\n${context}` : ''}

Svara alltid på svenska om inte användaren skriver på engelska.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    });

    res.json({
      content: response.content[0].text,
      usage: response.usage
    });

  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate product description
app.post('/api/claude/generate-description', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(400).json({ error: 'API key not configured' });
    }

    const { product, style, language, length, includeSEO, sourceMaterial, includeShortDescription } = req.body;

    const lengthGuide = {
      short: '50-100 ord, kort och koncis',
      medium: '100-200 ord',
      long: '200-400 ord med mer detaljer',
      extra_long: '400-600 ord, omfattande med flera sektioner'
    };

    const styleGuide = {
      technical: 'Fokusera på tekniska specifikationer och prestanda',
      sales: 'Fokusera på fördelar och säljargument',
      neutral: 'Balanserad mix av teknik och fördelar'
    };

    // Formaterings-instruktioner baserat på längd
    const formattingGuide = length === 'extra_long'
      ? `
FORMATERING (OBLIGATORISKT - du MÅSTE följa detta exakt):
Du MÅSTE strukturera texten med HTML-rubriker och punktlistor enligt detta mönster:

<p>Engagerande inledning som fångar läsarens intresse...</p>

<h2>Egenskaper</h2>
<ul>
<li><strong>Egenskap 1:</strong> Beskrivning av egenskapen</li>
<li><strong>Egenskap 2:</strong> Beskrivning av egenskapen</li>
<li><strong>Egenskap 3:</strong> Beskrivning av egenskapen</li>
</ul>

<h2>Teknologi</h2>
<p>Beskrivning av teknologin...</p>

<h2>För vem passar denna produkt?</h2>
<p>Beskrivning av målgruppen...</p>

VIKTIGT: Använd MINST 2-3 <h2>-rubriker och MINST en punktlista med <ul><li>. Detta är ett krav.`
      : length === 'long'
      ? `
FORMATERING (OBLIGATORISKT):
Du MÅSTE inkludera minst EN rubrik (<h2>) och EN punktlista (<ul><li>) i texten.
Exempel på struktur:
<p>Inledande text...</p>
<h2>Egenskaper</h2>
<ul><li>Punkt 1</li><li>Punkt 2</li></ul>
<p>Avslutande text...</p>`
      : `
FORMATERING:
- Använd <p>-taggar för paragrafer
- Kan använda <ul><li> för korta punktlistor om relevant`;

    // Bygg prompt baserat på om källmaterial finns
    let prompt;

    // Gemensam systemprompt för ton, SEO och AEO
    const systemPrompt = `Du är en expert-copywriter specialiserad på e-handel och produkttexter för golf- och sportprodukter.

SKRIVREGLER:
- Skriv ALLTID på professionell, korrekt svenska (om inte engelska begärs)
- Tonen ska vara professionell och säljande - som en premiummärkes produktsida
- Texten ska ALLTID vara helt omskriven och unik - ALDRIG kopiera meningar rakt av från källmaterial
- Använd varierade meningsbyggnader. Undvik upprepningar
- Skriv i tredje person eller direkt tilltal ("du/dig"), aldrig "vi"
- Undvik klyschor som "ta ditt spel till nästa nivå" och liknande uttjatade fraser

SEO-OPTIMERING (produktbeskrivning):
- Placera det viktigaste nyckelordet (produktnamn + typ) inom de första 100 tecknen
- Använd naturliga variationer av söktermer (t.ex. "driver", "drivern", "golfdrivern")
- Strukturera med H2-rubriker som innehåller relevanta sökfraser
- Inkludera long-tail-sökfraser naturligt i brödtexten
- Skriv för Featured Snippets: besvara "Vad är...", "Vilken... passar..." implicit i texten

AEO-OPTIMERING (Answer Engine Optimization - för AI-sökmotorer):
- Kort beskrivning ska vara en faktamättad, koncis mening som direkt besvarar "Vad är [produkten]?"
- Inkludera entydiga attribut: varumärke, produkttyp, huvudegenskap, målgrupp
- Använd schema-vänligt språk: tydliga subjekt-predikat-objekt-meningar
- Undvik subjektiva påståenden utan kontext i kort beskrivning - fokusera på verifierbara fakta

SEO TITLE (max 60 tecken):
- Format: [Produkt] [Typ] | [Varumärke] - Köp online
- Eller: [Varumärke] [Produkt] - [Nyckelord] | [Butik]
- Huvudnyckelordet FÖRST, varumärke inkluderat, max 60 tecken

META DESCRIPTION (max 155 tecken):
- Inled med en fördel eller unik egenskap
- Inkludera en CTA (call-to-action): "Beställ", "Upptäck", "Handla"
- Inkludera pris eller "fri frakt" om tillgängligt
- Ska locka till klick från sökresultat`;

    if (sourceMaterial && sourceMaterial.trim()) {
      // Med källmaterial - omskrivet baserat på fakta
      prompt = `${systemPrompt}

UPPGIFT: Skriv en unik, omskriven produktbeskrivning baserad på källmaterialet nedan. Du ska använda fakta från materialet men formulera ALLT med egna ord. Kopiera ALDRIG meningar direkt.

Produkt: ${product.title}
Varumärke: ${product.brand}
Typ: ${product.type}

===== KÄLLMATERIAL (fakta att utgå ifrån) =====
${sourceMaterial}
===== SLUT KÄLLMATERIAL =====

Krav:
- Längd: ${lengthGuide[length] || lengthGuide.medium}
- Stil: ${styleGuide[style] || styleGuide.neutral}
- Språk: ${language === 'en' ? 'English' : 'Svenska'}
- Basera på fakta från källmaterialet men skriv om ALLT med egna formuleringar
- Hitta INTE på specifikationer som inte finns i källmaterialet
${formattingGuide}
${includeShortDescription ? `
shortDescription (OBLIGATORISK):
- Max 200 tecken
- En faktamättad mening som besvarar "Vad är denna produkt?"
- Format: "[Varumärke] [Produkt] är en [typ] med/för [huvudegenskap/målgrupp]"
- Optimerad för AI-agenter och LLM-sökmotorer (AEO)
- Inga subjektiva superlativer - fokusera på verifierbara egenskaper
` : ''}
${includeSEO ? `
seoTitle (OBLIGATORISK, max 60 tecken):
- Huvudnyckelord först, varumärke inkluderat
- Format: "[Produkt] [Typ] | [Varumärke]" eller "[Varumärke] [Produkt] - [Nyckelord]"

metaDescription (OBLIGATORISK, max 155 tecken):
- Inled med unik fördel/egenskap
- Avsluta med CTA
- Ska locka klick från Google-resultat
` : ''}

Svara ENBART med giltig JSON:
{
  "description": "HTML-formaterad beskrivning här"${includeShortDescription ? `,
  "shortDescription": "AEO-optimerad kort beskrivning"` : ''}${includeSEO ? `,
  "seoTitle": "SEO-optimerad titel",
  "metaDescription": "Säljande metabeskrivning med CTA"` : ''}
}`;
    } else {
      // Utan källmaterial - generera baserat på produktinfo
      prompt = `${systemPrompt}

UPPGIFT: Skriv en unik produktbeskrivning baserad på produktinformationen nedan.

Produkt: ${product.title}
Varumärke: ${product.brand}
Typ: ${product.type}
${product.variants ? `Varianter: ${JSON.stringify(product.variants.slice(0, 3))}` : ''}
${product.existingDescription ? `Befintlig beskrivning (omskriv helt, kopiera INTE): ${product.existingDescription}` : ''}

Krav:
- Längd: ${lengthGuide[length] || lengthGuide.medium}
- Stil: ${styleGuide[style] || styleGuide.neutral}
- Språk: ${language === 'en' ? 'English' : 'Svenska'}
${formattingGuide}
${includeShortDescription ? `
shortDescription (OBLIGATORISK):
- Max 200 tecken
- En faktamättad mening som besvarar "Vad är denna produkt?"
- Format: "[Varumärke] [Produkt] är en [typ] med/för [huvudegenskap/målgrupp]"
- Optimerad för AI-agenter och LLM-sökmotorer (AEO)
- Inga subjektiva superlativer - fokusera på verifierbara egenskaper
` : ''}
${includeSEO ? `
seoTitle (OBLIGATORISK, max 60 tecken):
- Huvudnyckelord först, varumärke inkluderat
- Format: "[Produkt] [Typ] | [Varumärke]" eller "[Varumärke] [Produkt] - [Nyckelord]"

metaDescription (OBLIGATORISK, max 155 tecken):
- Inled med unik fördel/egenskap
- Avsluta med CTA
- Ska locka klick från Google-resultat
` : ''}

Svara ENBART med giltig JSON:
{
  "description": "HTML-formaterad beskrivning här"${includeShortDescription ? `,
  "shortDescription": "AEO-optimerad kort beskrivning"` : ''}${includeSEO ? `,
  "seoTitle": "SEO-optimerad titel",
  "metaDescription": "Säljande metabeskrivning med CTA"` : ''}
}`;
    }

    const models = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    let response;
    let usedModel;

    for (const model of models) {
      let succeeded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          response = await anthropic.messages.create({
            model,
            max_tokens: length === 'extra_long' ? 4096 : 2048,
            messages: [{ role: 'user', content: prompt }]
          });
          usedModel = model;
          succeeded = true;
          break;
        } catch (apiError) {
          if (apiError.status === 529 && attempt < 2) {
            console.log(`${model} overloaded, retry ${attempt}/2 in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (apiError.status === 529 && model !== models[models.length - 1]) {
            console.log(`${model} overloaded, falling back to next model...`);
            break;
          }
          throw apiError;
        }
      }
      if (succeeded) break;
    }

    console.log(`Generated description using ${usedModel}`);

    // Parse JSON from response
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      res.json(result);
    } else {
      res.json({ description: text });
    }

  } catch (error) {
    console.error('Generate description error:', error);
    const msg = error.status === 529
      ? 'Claude API är överbelastad just nu. Försök igen om en stund.'
      : error.message;
    res.status(500).json({ error: msg });
  }
});

// Batch generate descriptions
app.post('/api/claude/batch-generate', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(400).json({ error: 'API key not configured' });
    }

    const { products, style, language, length, includeSEO } = req.body;

    const results = [];
    
    for (const product of products) {
      try {
        const lengthGuide = {
          short: '50-100 ord',
          medium: '100-200 ord', 
          long: '200-400 ord'
        };

        const prompt = `Du är en expert-copywriter för golf- och sportprodukter. Skriv professionell, säljande svenska. Texten ska vara unik och omskriven - aldrig generisk.

Produkt: ${product.title}
Varumärke: ${product.brand}
Typ: ${product.type}

Krav:
- Längd: ${lengthGuide[length] || lengthGuide.medium}
- Stil: ${style === 'technical' ? 'Teknisk med fokus på specifikationer' : style === 'sales' ? 'Säljande med fokus på fördelar' : 'Balanserad'}
- Språk: ${language === 'en' ? 'English' : 'Svenska'}
- SEO: Placera nyckelord (produktnamn + typ) tidigt i texten
- Beskrivningen ska vara HTML-formaterad med <p>-taggar

Svara ENDAST med JSON:
{
  "description": "HTML-formaterad unik produktbeskrivning",
  "shortDescription": "Max 200 tecken. Faktamättad mening: [Varumärke] [Produkt] är en [typ] för [målgrupp]. Optimerad för AI-sökmotorer.",
  "seoTitle": "Max 60 tecken. Nyckelord först, varumärke inkluderat.",
  "metaDescription": "Max 155 tecken. Unik fördel + CTA. Ska locka klick."
}`;

        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }]
        });

        const text = response.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          results.push({
            productId: product.id,
            success: true,
            ...JSON.parse(jsonMatch[0])
          });
        } else {
          results.push({
            productId: product.id,
            success: true,
            description: text
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (err) {
        results.push({
          productId: product.id,
          success: false,
          error: err.message
        });
      }
    }

    res.json({ results });

  } catch (error) {
    console.error('Batch generate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Parse product names from file data
app.post('/api/claude/parse-products', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(400).json({ error: 'API key not configured' });
    }

    const { products, columns } = req.body;

    const prompt = `Analysera dessa produktrader från en leverantörsfil och extrahera strukturerad data.

Kolumner i filen: ${columns.join(', ')}

Produktdata (första 10 raderna):
${JSON.stringify(products.slice(0, 10), null, 2)}

Extrahera för varje produkt:
- brand (varumärke)
- model (modellnamn)
- type (produkttyp: Driver, Fairway, Hybrid, Irons, Wedge, Putter, Polo, Jacket, Glove, etc)
- loft (om tillämpligt, t.ex. "10.5°")
- fattning (Höger/Vänster, baserat på RH/LH/Right/Left)
- skaft (Stiff/Regular/Senior/Ladies)
- färg (om tillämpligt)
- storlek (om tillämpligt, t.ex. S/M/L/XL)

Regler för parsing:
- "RH" eller "Right" = Höger
- "LH" eller "Left" = Vänster
- "STF" eller "Stiff" = Stiff
- "REG" eller "Regular" = Regular
- Loft är oftast ett tal som 9, 10.5, 12 etc

Svara med JSON-array:
[
  {
    "original": "original produktnamn",
    "brand": "...",
    "model": "...",
    "type": "...",
    "loft": "...",
    "fattning": "...",
    "skaft": "...",
    "färg": "...",
    "storlek": "...",
    "confidence": 0-100
  }
]`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    
    if (jsonMatch) {
      res.json({ parsed: JSON.parse(jsonMatch[0]) });
    } else {
      res.status(400).json({ error: 'Could not parse response' });
    }

  } catch (error) {
    console.error('Parse products error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI Content Generation (Module J enrichment)
app.post('/api/claude/enrich', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }

    const { field, product, storeId, sourceMaterial } = req.body;

    // Get store's brand voice if available
    let brandVoice = null;
    if (storeId && supabase) {
      const { data: store } = await supabase
        .from('stores')
        .select('tone_of_voice, brand_profile, default_language')
        .eq('id', storeId)
        .single();
      if (store) brandVoice = store;
    }

    const language = brandVoice?.default_language || 'sv';
    const tone = brandVoice?.tone_of_voice || '';
    const brandProfile = brandVoice?.brand_profile || {};

    // Combined source material (text field + fetched URL + extracted doc)
    const combinedSource = sourceMaterial || product.metafields?.['custom.source_material'] || '';

    // Full product context — include ALL existing data so AI enriches, not invents
    const variantsSummary = (product.variants || []).slice(0, 20).map(v =>
      [v.option1_name && `${v.option1_name}: ${v.option1_value}`, v.option2_name && `${v.option2_name}: ${v.option2_value}`, v.option3_name && `${v.option3_name}: ${v.option3_value}`, v.sku && `SKU: ${v.sku}`, v.price != null && `Pris: ${v.price}`].filter(Boolean).join(', ')
    ).join('\n');

    const productContext = `
=== BEFINTLIG PRODUKTDATA (utgå alltid från detta) ===
Titel: ${product.title || ''}
Varumärke: ${product.vendor || ''}
Produkttyp: ${product.product_type || product.type || ''}
SKU: ${product.sku || ''}
EAN: ${product.barcode || ''}
Pris: ${product.default_price ?? ''}
Inköpspris: ${product.default_cost ?? ''}
Vikt: ${product.weight ?? ''}
Taggar: ${(product.tags || []).join(', ')}
Befintlig beskrivning: ${product.description ? product.description.replace(/<[^>]*>/g, '').substring(0, 800) : '(saknas)'}
Befintlig ingress: ${product.metafields?.['custom.kort_produktbeskrivning'] || '(saknas)'}
Befintliga specifikationer: ${product.specifications?.length ? JSON.stringify(product.specifications) : '(saknas)'}
Befintlig FAQ: ${product.faq?.length ? JSON.stringify(product.faq) : '(saknas)'}
Befintliga metafält: ${Object.entries(product.metafields || {}).filter(([k]) => k !== 'custom.source_material').map(([k,v]) => `${k}: ${v}`).join(', ') || '(saknas)'}
Varianter:
${variantsSummary || '(inga varianter)'}
${combinedSource ? `\n=== KÄLLMATERIAL (använd för fakta — hitta aldrig på eget) ===\n${combinedSource.slice(0, 12000)}\n=== SLUT KÄLLMATERIAL ===` : ''}`;

    let prompt = '';
    let maxTokens = 2048;

    if (field === 'all') {
      maxTokens = 4096;
      prompt = `Generera ALLT AI-innehåll för denna produkt. ${productContext}

Svara ENBART med JSON:
{
  "agentSummary": "6-8 punkter i köpordning, en per rad",
  "shortDescription": "2-3 säljande meningar, löptext",
  "specifications": [{"name": "Attributnamn", "value": "Värde"}],
  "faq": [{"question": "Fråga", "answer": "Svar 2-4 meningar"}],
  "useCases": "Användningsområden, vem produkten passar för",
  "seoTitle": "Max 60 tecken SEO-titel",
  "seoDescription": "Max 155 tecken meta description",
  "searchTerms": "kommaseparerade söktermer och synonymer",
  "tags": ["relevanta", "taggar"]
}`;
    } else if (field === 'agentSummary') {
      prompt = `Generera snabbfakta/agent summary för denna produkt. 6-8 punkter i köpordning (viktigast först). Löptext som AI-agenter kan parsa. En punkt per rad. ${productContext}

Svara ENBART med den genererade texten, ingen JSON.`;
    } else if (field === 'shortDescription') {
      prompt = `Generera en kort ingress (2-3 säljande meningar) för denna produkt. Löptext, nyttobaserad. Ska INTE upprepa information från snabbfakta. ${productContext}

Svara ENBART med den genererade texten.`;
    } else if (field === 'specifications') {
      prompt = `Generera en specifikationstabell för denna produkt. Minimum 10 attribut. Inkludera ALLTID färg. Attributnamn på ${language === 'sv' ? 'svenska' : language}. ${productContext}

Svara ENBART med JSON-array: [{"name": "Attributnamn", "value": "Värde"}]`;
    } else if (field === 'faq') {
      prompt = `Generera 5-8 FAQ-frågor för denna produkt. Teman: passform/användning, material, jämförelse, vad ingår, mått, teknologi. Svar: 2-4 meningar, konkreta, med siffror. ${productContext}

Svara ENBART med JSON-array: [{"question": "Fråga", "answer": "Svar"}]`;
    } else if (field === 'useCases') {
      prompt = `Generera användningsområden för denna produkt. Beskriv vem produkten passar för och i vilka situationer. ${productContext}

Svara ENBART med den genererade texten.`;
    } else if (field === 'searchTerms') {
      prompt = `Generera söktermer och synonymer för denna produkt. Inkludera alternativa namn, relaterade termer, vardagliga uttryck. ${productContext}

Svara ENBART med kommaseparerade termer.`;
    } else if (field === 'schema') {
      maxTokens = 4096;
      prompt = `Generera JSON-LD Product schema (schema.org) för denna produkt. Inkludera: @type Product, name, description, sku, brand, offers, additionalProperty (från specifikationer). ${productContext}
Specifikationer: ${JSON.stringify(product.specifications || [])}
FAQ: ${JSON.stringify(product.faq || [])}

Svara ENBART med valid JSON-LD objekt.`;
    } else if (field === 'relatedProducts') {
      prompt = `Föreslå kompletterande produkter (cross-sell) och alternativa produkter (liknande) baserat på denna produkt. ${productContext}

Svara ENBART med JSON: {"complementary": "kommaseparerade förslag", "similar": "kommaseparerade förslag"}`;
    } else {
      return res.status(400).json({ error: `Okänt fält: ${field}` });
    }

    const systemPrompt = `Du är en expert-copywriter för Shopify e-handel. Du optimerar produktdata för tre målgrupper: människor (konvertering), sökmotorer (SEO), och AI-agenter (AEO/GEO).

Språk: ${language === 'sv' ? 'Svenska' : language}
${tone ? `Ton: ${tone}` : ''}
${brandProfile?.terminology ? `Terminologi: ${JSON.stringify(brandProfile.terminology)}` : ''}
${brandProfile?.avoid ? `Undvik: ${brandProfile.avoid.join(', ')}` : ''}

ABSOLUT VIKTIGASTE REGEL — FÖLJ ALLTID:
- Använd ENBART information som finns i produktdatan och källmaterialet ovan
- Hitta ALDRIG på fakta, mått, material, teknologi, priser eller egenskaper som inte nämns
- Om ett faktum saknas i källmaterialet: utelämna det eller skriv "Kontakta oss för mer info"
- Du är en redaktör som strukturerar och förbättrar befintlig data — inte en fantasiförfattare

REGLER:
- Produkttitel: [Varumärke] [Modell] – [Kategori], max 70 tecken, ALDRIG butiksnamn
- Meta title: max 60 tecken
- Meta description: HÅRDGRÄNS max 155 tecken
- Snabbfakta: 6-8 punkter i köpordning, löptext
- Beskrivning: benefit-driven, >150 ord, clean HTML
- Specifikationer: min 10 attribut om data finns, annars så många som källmaterialet tillåter
- FAQ: 5-8 frågor baserade på faktisk produktdata, 2-4 meningar per svar`;

    // Build message content — add product images for visual analysis if available
    const imageUrls = (product.images || [])
      .map(img => img.url || img.src)
      .filter(u => u && u.startsWith('http'))
      .slice(0, 3); // max 3 images to manage token cost

    const messageContent = [];

    // Fetch and attach images as base64 (vision)
    let imagesAnalyzed = 0;
    for (const imgUrl of imageUrls) {
      try {
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(6000) });
        if (!imgRes.ok) continue;
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        const mediaType = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
        const buf = Buffer.from(await imgRes.arrayBuffer());
        // Skip tiny images (likely icons/placeholders < 5KB)
        if (buf.length < 5000) continue;
        messageContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
        imagesAnalyzed++;
      } catch (_) { /* skip unloadable image */ }
    }

    if (imagesAnalyzed > 0) {
      messageContent.push({
        type: 'text',
        text: `[Bildanalys: ${imagesAnalyzed} produktbild${imagesAnalyzed > 1 ? 'er' : ''} bifogas ovan. Analysera dem och använd visuell information (färg, form, material, ytstruktur, vad som ingår, synliga detaljer) som komplement till produktdatan nedan. Rapportera ENBART vad du faktiskt ser — gissa inte.]\n\n${prompt}`,
      });
    } else {
      messageContent.push({ type: 'text', text: prompt });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: messageContent }],
    });

    const text = response.content[0].text;

    // Try to parse as JSON if applicable
    let result;
    if (field === 'all' || field === 'specifications' || field === 'faq' || field === 'schema' || field === 'relatedProducts') {
      try {
        const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : text;
      } catch {
        result = text;
      }
    } else {
      result = text.trim();
    }

    res.json({ field, result });

  } catch (error) {
    console.error('AI enrich error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMAGE SCRAPER
// ============================================

app.post('/api/source/scrape-images', async (req, res) => {
  const { url, sku, title, barcode } = req.body;
  if (!url) return res.status(400).json({ error: 'url krävs' });

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PIM-bot/1.0)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    // Extract base URL for resolving relative paths
    const baseUrl = new URL(url);
    const NOISE_PATH = /\/(icon|logo|arrow|banner|flag|pixel|spacer|sprite)/i;
    const IMAGE_EXT = /\.(jpe?g|png|webp|avif)(\?|$)/i;

    const resolveUrl = (raw) => {
      if (!raw || raw.startsWith('data:')) return null;
      try {
        if (raw.startsWith('//')) return baseUrl.protocol + raw;
        if (raw.startsWith('/')) return baseUrl.origin + raw;
        if (raw.startsWith('http')) return raw;
        return baseUrl.href.replace(/\/[^/]*$/, '/') + raw;
      } catch { return null; }
    };

    // Map<identity, bestVariant> — collapses CDN-resized duplicates of the same
    // source image (e.g. /storage/webp/720-720-… vs /media/{guid}/{file}) so we
    // surface one entry per logical image at the highest available resolution.
    const byIdentity = new Map();
    const addCandidate = (imgUrl, altText, titleText, source) => {
      if (!imgUrl) return;
      if (/\.(svg|gif)$/i.test(imgUrl)) return;
      if (NOISE_PATH.test(imgUrl)) return;
      const id = imageIdentity(imgUrl);
      const score = imageVariantScore({ url: imgUrl, source });
      const existing = byIdentity.get(id);
      if (existing && existing._score >= score) return;
      const filename = decodeURIComponent(imgUrl.split('/').pop().split('?')[0]);
      const filenameBase = filename.replace(/\.[^.]+$/, '');
      const searchText = `${filename} ${filenameBase} ${altText} ${titleText}`.toLowerCase();
      byIdentity.set(id, { url: imgUrl, filename, filenameBase, altText, titleText, searchText, _score: score });
    };

    // <a data-src="..."> — click-to-enlarge / gallery lightbox links typically
    // point to the original full-resolution file.
    for (const m of html.matchAll(/<a[^>]+data-src=["']([^"']+)["'][^>]*>/gi)) {
      const u = resolveUrl(m[1]);
      if (u && IMAGE_EXT.test(u)) addCandidate(u, '', '', 'gallery');
    }

    // <img> tags — prefer data-src (lazy) over srcset over src
    for (const match of html.matchAll(/<img[^>]+>/gi)) {
      const tag = match[0];
      const srcMatch = tag.match(/src=["']([^"']+)["']/i);
      const dataSrcMatch = tag.match(/data-src=["']([^"']+)["']/i);
      const srcsetMatch = tag.match(/srcset=["']([^"']+)["']/i);
      const altMatch = tag.match(/alt=["']([^"']*?)["']/i);
      const titleMatch = tag.match(/title=["']([^"']*?)["']/i);
      const altText = altMatch?.[1] || '';
      const titleText = titleMatch?.[1] || '';

      if (dataSrcMatch) {
        const u = resolveUrl(dataSrcMatch[1]);
        if (u && IMAGE_EXT.test(u)) { addCandidate(u, altText, titleText, 'gallery'); continue; }
      }
      if (srcsetMatch) {
        const parts = srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/));
        const largest = parts.sort((a, b) => parseInt(b[1]) - parseInt(a[1]))[0];
        const u = largest?.[0] ? resolveUrl(largest[0]) : null;
        if (u) { addCandidate(u, altText, titleText, 'img'); continue; }
      }
      if (srcMatch) {
        const u = resolveUrl(srcMatch[1]);
        if (u) addCandidate(u, altText, titleText, 'img');
      }
    }

    const unique = [...byIdentity.values()].map(({ _score, ...img }) => img);

    // Score each image against product identifiers
    const skuClean = (sku || '').toLowerCase().replace(/[-_\s]/g, '');
    const barcodeClean = (barcode || '').toLowerCase();
    const titleWords = (title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);

    const scored = unique.map(img => {
      const searchClean = img.searchText.replace(/[-_\s]/g, '');
      let score = 0;
      let matchReason = '';

      // SKU match (strongest signal — exact or normalized)
      if (sku && img.searchText.includes(sku.toLowerCase())) {
        score = 100;
        matchReason = 'SKU';
      } else if (skuClean && searchClean.includes(skuClean)) {
        score = 90;
        matchReason = 'SKU (normaliserad)';
      }
      // Barcode match
      else if (barcode && img.searchText.includes(barcodeClean)) {
        score = 80;
        matchReason = 'EAN/Streckkod';
      }
      // Title word match
      else if (titleWords.length) {
        const matchedWords = titleWords.filter(w => img.searchText.includes(w));
        if (matchedWords.length >= 2) {
          score = 40 + matchedWords.length * 10;
          matchReason = `Titel (${matchedWords.join(', ')})`;
        } else if (matchedWords.length === 1) {
          score = 20;
          matchReason = `Titel (${matchedWords[0]})`;
        }
      }

      return { ...img, score, matchReason };
    });

    // Return all with score > 0 first, then top 20 others for manual picking
    const matches = scored.filter(i => i.score > 0).sort((a, b) => b.score - a.score);
    const others = scored.filter(i => i.score === 0).slice(0, 20);

    res.json({ matches, others, total: unique.length });
  } catch (err) {
    res.status(422).json({ error: `Kunde inte hämta sidan: ${err.message}` });
  }
});

// Canonical identity for an image URL — variants of the same logical image
// (different sizes, formats or CDN transformer paths) collapse to the same key.
function imageIdentity(rawUrl) {
  try {
    const u = new URL(rawUrl);

    // Strong signal: many CDNs (e.g. affariofsweden, Episerver-style media stores)
    // expose an immutable /media/{guid}/{filename} segment that's identical across
    // all rendered variants. Use that as the key when present and drop the file
    // extension so .jpg/.jpeg/.webp variants of the same source collapse.
    const mediaMatch = u.pathname.match(/\/media\/([a-f0-9-]{16,}\/[^/]+)$/i);
    if (mediaMatch) {
      return 'media/' + mediaMatch[1].replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    }

    // Generic fallback: strip common size suffixes from the filename and known
    // size query params. Catches Shopify (foo_300x.jpg), WooCommerce
    // (foo-300x300.jpg), and most ?width=/?w= patterns.
    const segs = u.pathname.split('/');
    const last = segs[segs.length - 1];
    const extMatch = last.match(/\.[a-z0-9]+$/i);
    const ext = extMatch ? extMatch[0] : '';
    const base = last.slice(0, last.length - ext.length);
    const stripped = base.replace(
      /[_-](\d+x\d+|\d+x|x\d+|thumb(?:nail)?|small|medium|large|grande|compact|tiny|mini)$/i,
      ''
    );
    segs[segs.length - 1] = stripped + ext;

    const params = new URLSearchParams(u.search);
    ['width', 'w', 'h', 'height', 'size', 'v', 't'].forEach(k => params.delete(k));
    const q = params.toString();
    return (u.host + segs.join('/') + (q ? '?' + q : '')).toLowerCase();
  } catch {
    return rawUrl;
  }
}

// Higher score = preferred variant when multiple URLs share an identity.
function imageVariantScore({ url, source, width }) {
  let s = 0;
  if (source === 'gallery') s += 100;
  if (/\/storage\/webp\//i.test(url)) s -= 50;
  if (/\/(thumb|thumbnail|small|tiny)\//i.test(url)) s -= 30;
  // CDN size-transformer pattern in path, e.g. .../720-720-0-png.../ or .../300x300/
  if (/\/\d{2,4}-\d{2,4}-\d/i.test(url) || /\/\d{2,4}x\d{2,4}\//i.test(url)) s -= 30;
  // size suffix on filename, e.g. foo_300x300.jpg or Shopify foo_300x.jpg
  if (/[_-]\d{2,4}x\d{0,4}\./i.test(url)) s -= 20;
  if (width) s += Math.min(parseInt(width) || 0, 5000) / 100;
  return s;
}

// Helper: extract and resolve images from HTML
function extractImages(html, pageUrl) {
  const baseUrl = new URL(pageUrl);
  const IMAGE_EXT = /\.(jpe?g|png|webp|avif)(\?|$)/i;
  const NOISE_PATH = /\/(icon|logo|arrow|banner|flag|pixel|spacer|sprite|placeholder)/i;

  const resolveUrl = (raw) => {
    if (!raw || raw.startsWith('data:')) return null;
    try {
      if (raw.startsWith('//')) return baseUrl.protocol + raw;
      if (raw.startsWith('/')) return baseUrl.origin + raw;
      if (raw.startsWith('http')) return raw;
      return baseUrl.href.replace(/\/[^/]*$/, '/') + raw;
    } catch { return null; }
  };

  // Map<identity, bestVariant> — replaces an exact-URL Set so that compressed
  // CDN variants (webp transformers, _300x suffixes, ?width=) of the same source
  // image collapse into one entry instead of being kept as duplicates.
  const byIdentity = new Map();

  // source: 'gallery' = <a data-src> or <img data-src> (explicit gallery/lazy pattern)
  //         'img'     = plain <img src> (may include site furniture)
  const addImage = (url, altText = '', source = 'img', width = null) => {
    if (!url) return;
    if (/\.(svg|gif)$/i.test(url)) return;
    if (NOISE_PATH.test(url)) return;
    const id = imageIdentity(url);
    const score = imageVariantScore({ url, source, width });
    const existing = byIdentity.get(id);
    if (existing && existing._score >= score) return;
    const filename = decodeURIComponent(url.split('/').pop().split('?')[0]);
    const filenameBase = filename.replace(/\.[^.]+$/, '');
    const searchText = `${filename} ${filenameBase} ${altText}`.toLowerCase();
    byIdentity.set(id, { url, filename, altText, searchText, source, _score: score });
  };

  // <a data-src="..."> — click-to-enlarge / gallery lightbox pattern
  for (const m of html.matchAll(/<a[^>]+data-src=["']([^"']+)["'][^>]*>/gi)) {
    const url = resolveUrl(m[1]);
    if (url && IMAGE_EXT.test(url)) addImage(url, '', 'gallery');
  }

  // <img> tags — prefer data-src (lazy) over srcset over src
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const srcMatch = tag.match(/src=["']([^"']+)["']/i);
    const dataSrcMatch = tag.match(/data-src=["']([^"']+)["']/i);
    const srcsetMatch = tag.match(/srcset=["']([^"']+)["']/i);
    const altMatch = tag.match(/alt=["']([^"']*?)["']/i);
    const widthMatch = tag.match(/\bwidth=["']?(\d+)/i);
    const altText = altMatch?.[1] || '';
    const width = widthMatch?.[1] || null;

    if (dataSrcMatch) {
      const u = resolveUrl(dataSrcMatch[1]);
      if (u && IMAGE_EXT.test(u)) { addImage(u, altText, 'gallery', width); continue; }
    }
    if (srcsetMatch) {
      const parts = srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/));
      const largest = parts.sort((a, b) => parseInt(b[1]) - parseInt(a[1]))[0];
      const u = largest?.[0] ? resolveUrl(largest[0]) : null;
      if (u && IMAGE_EXT.test(u)) { addImage(u, altText, 'img', width); continue; }
    }
    if (srcMatch) {
      const u = resolveUrl(srcMatch[1]);
      if (u) addImage(u, altText, 'img', width);
    }
  }

  return [...byIdentity.values()].map(({ _score, ...img }) => img);
}

// Helper: score image against a product (SKU/barcode only)
function scoreImage(img, product) {
  const sku = (product.sku || '').toLowerCase();
  const skuClean = sku.replace(/[-_\s]/g, '');
  const barcodeClean = (product.barcode || '').toLowerCase();
  const searchClean = img.searchText.replace(/[-_\s]/g, '');

  if (sku && sku.length >= 4 && img.searchText.includes(sku)) return { score: 100, reason: 'SKU' };
  if (skuClean && skuClean.length >= 4 && searchClean.includes(skuClean)) return { score: 90, reason: 'SKU (normaliserad)' };
  if (barcodeClean && barcodeClean.length >= 8 && img.searchText.includes(barcodeClean)) return { score: 80, reason: 'EAN/Streckkod' };
  return { score: 0, reason: '' };
}

// Bulk image scrape: crawl entire site (SSE streaming)
app.post('/api/images/bulk-scrape', async (req, res) => {
  const { url, maxProducts } = req.body;
  const storeId = await resolveStoreId(req);
  if (!url) return res.status(400).json({ error: 'url krävs' });
  if (!storeId) return res.status(400).json({ error: 'storeId krävs' });
  const productLimit = maxProducts ? parseInt(maxProducts) : null;
  console.log('[bulk-scrape] productLimit=', productLimit, 'maxProducts=', maxProducts);

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id, title, sku, barcode')
      .eq('store_id', storeId);
    if (prodErr) throw prodErr;

    if (!products?.length) {
      send({ type: 'done', autoMatched: [], pagesScanned: 0, imagesScanned: 0 });
      return res.end();
    }

    const baseUrl = new URL(url);
    const domain = baseUrl.hostname;
    const SKIP_PATHS = /\/(cart|checkout|account|login|logout|search|cdn|assets|fonts|\.css|\.js)\b/i;
    // No page limit — crawl until time expires or user aborts
    const MAX_TIME_MS = 600000; // 10 minutes

    // Priority queue: product-page-looking URLs (deeper paths) go first
    const isProductLike = (pathname) => {
      const depth = pathname.split('/').filter(Boolean).length;
      return depth >= 2; // category/product-slug is depth 2+
    };
    let queue = [url];
    const visited = new Set([url]);
    // productId → { product, images: Map<imgUrl, bestMatch> }
    const productMap = new Map();
    const seenImages = new Set();

    let pagesScanned = 0;
    let imagesScanned = 0;
    const startTime = Date.now();

    while (queue.length && (Date.now() - startTime) < MAX_TIME_MS && !aborted && !(productLimit && productMap.size >= productLimit)) {
      const pageUrl = queue.shift();
      pagesScanned++;

      send({ type: 'progress', page: pagesScanned, queued: queue.length, url: pageUrl, matched: productMap.size, elapsed: Math.round((Date.now() - startTime) / 1000) });

      try {
        const pageRes = await fetch(pageUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PIM-bot/1.0)' },
          signal: AbortSignal.timeout(8000),
        });
        if (!pageRes.ok) continue;
        const html = await pageRes.text();

        // Page-level matching: only collect all images if exactly ONE product matches on
        // this page (= product page). Multiple matches = category page → skip sibling collection.
        const imgs = extractImages(html, pageUrl);
        imagesScanned += imgs.length;

        // Find all distinct products matched on this page
        const pageMatches = new Map(); // productId → { product, score, reason }
        for (const img of imgs) {
          for (const product of products) {
            const { score, reason } = scoreImage(img, product);
            if (score >= 80) {
              const existing = pageMatches.get(product.id);
              if (!existing || score > existing.score) {
                pageMatches.set(product.id, { product, score, reason });
              }
            }
          }
        }

        if (pageMatches.size === 1) {
          // Product page — collect images that share the same path prefix as the SKU-matched image.
          // This excludes navigation, related products, and other page furniture.
          const { product: pageProduct, score: pageScore, reason: pageReason } = [...pageMatches.values()][0];
          const pid = pageProduct.id;
          if (!productMap.has(pid)) productMap.set(pid, { product: pageProduct, images: new Map() });

          // Find path prefixes of all SKU-matched images on this page
          const matchedPrefixes = new Set();
          for (const img of imgs) {
            const { score } = scoreImage(img, pageProduct);
            if (score >= 80) {
              // Use directory path (everything up to last slash) as prefix
              const pathDir = new URL(img.url).pathname.replace(/\/[^/]+$/, '/');
              matchedPrefixes.add(pathDir);
            }
          }

          const prevSize = productMap.get(pid).images.size;
          for (const img of imgs) {
            if (seenImages.has(img.url)) continue;
            seenImages.add(img.url);

            const { score: imgScore, reason: imgReason } = scoreImage(img, pageProduct);
            let finalScore = 0, finalReason = '';

            if (imgScore >= 80) {
              finalScore = imgScore; finalReason = imgReason;
            } else if (matchedPrefixes.size > 0) {
              const imgDir = new URL(img.url).pathname.replace(/\/[^/]+$/, '/');
              if (matchedPrefixes.has(imgDir)) {
                finalScore = 70; finalReason = `Produktsida (${pageReason})`;
              }
            }

            if (finalScore > 0) {
              const existing = productMap.get(pid).images.get(img.url);
              if (!existing || finalScore > existing.score) {
                productMap.get(pid).images.set(img.url, { url: img.url, filename: img.filename, altText: img.altText, score: finalScore, matchReason: finalReason });
              }
            }
          }
          // Emit match event whenever images change for this product (client accumulates for mid-crawl save)
          if (productMap.get(pid).images.size !== prevSize) {
            const images = [...productMap.get(pid).images.values()].sort((a, b) => b.score - a.score);
            send({ type: 'match', product: pageProduct, images });
          }

          // Stop crawl immediately when product limit is reached
          if (productLimit && productMap.size >= productLimit) {
            aborted = true;
          }
        }

        // Enqueue internal links
        const linkMatches = [...html.matchAll(/href=["']([^"'#?][^"']*?)["']/gi)];
        for (const lm of linkMatches) {
          try {
            let href = lm[1];
            if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
            let abs;
            if (href.startsWith('//')) abs = baseUrl.protocol + href;
            else if (href.startsWith('/')) abs = baseUrl.origin + href;
            else if (href.startsWith('http')) abs = href;
            else abs = baseUrl.origin + '/' + href;

            const lu = new URL(abs);
            if (lu.hostname !== domain) continue;
            if (SKIP_PATHS.test(lu.pathname)) continue;
            const clean = lu.origin + lu.pathname;
            if (!visited.has(clean)) {
              visited.add(clean);
              // Product-like URLs go to front of queue, category/root pages to back
              if (isProductLike(lu.pathname)) queue.unshift(clean);
              else queue.push(clean);
            }
          } catch {}
        }
      } catch { /* skip failed pages */ }
    }

    // Build result
    const autoMatched = [];
    for (const entry of productMap.values()) {
      const images = [...entry.images.values()].sort((a, b) => b.score - a.score);
      autoMatched.push({ product: entry.product, images });
    }

    send({ type: 'done', autoMatched, pagesScanned, imagesScanned });
    res.end();
  } catch (err) {
    console.error('[bulk-scrape]', err);
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// Bulk apply: insert matched images into the images table for each product
app.post('/api/images/bulk-apply', async (req, res) => {
  const { matches } = req.body; // [{ productId, images: [{ url, altText, filename, score, matchReason }] }]
  if (!Array.isArray(matches) || !matches.length) return res.status(400).json({ error: 'matches krävs' });

  try {
    let applied = 0;
    let skipped = 0;

    for (const match of matches) {
      const { productId, images } = match;
      if (!productId || !images?.length) continue;

      // Existing image URLs for dedup
      const { data: existing } = await supabase.from('images').select('url').eq('product_id', productId);
      const existingUrls = new Set((existing || []).map(i => i.url));

      // Current max position
      const { data: positions } = await supabase.from('images').select('position').eq('product_id', productId).order('position', { ascending: false }).limit(1);
      let nextPos = (positions?.[0]?.position || 0) + 1;

      for (const img of images) {
        if (existingUrls.has(img.url)) { skipped++; continue; }
        await supabase.from('images').insert({
          product_id: productId,
          url: img.url,
          alt_text: img.altText || null,
          position: nextPos++,
          source: 'scraped',
          original_filename: img.filename || null,
        });
        applied++;
      }
    }

    res.json({ applied, skipped, message: `${applied} bilder sparade${skipped ? `, ${skipped} fanns redan` : ''}` });
  } catch (err) {
    console.error('[bulk-apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SOURCE MATERIAL HELPERS
// ============================================

// Fetch URL and return plain text
app.post('/api/source/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url krävs' });
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PIM-bot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    // Strip HTML tags and collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 15000); // cap at 15k chars
    res.json({ text, length: text.length });
  } catch (err) {
    res.status(422).json({ error: `Kunde inte hämta URL: ${err.message}` });
  }
});

// Extract text from uploaded file (PDF, DOCX, TXT)
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/source/extract-document', documentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ingen fil' });
  const { mimetype, originalname, buffer } = req.file;
  try {
    let text = '';
    if (mimetype === 'application/pdf' || originalname.endsWith('.pdf')) {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      originalname.endsWith('.docx')
    ) {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      text = buffer.toString('utf-8');
    }
    text = text.replace(/\s{3,}/g, '\n\n').trim().slice(0, 15000);
    res.json({ text, filename: originalname, length: text.length });
  } catch (err) {
    res.status(422).json({ error: `Kunde inte läsa fil: ${err.message}` });
  }
});

// ============================================
// SHOPIFY METAFIELDS (mock for now)
// ============================================

// Get available metafield definitions from Shopify (live from central store)
app.get('/api/shopify/metafields/:storeId', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.storeId);
    if (!store || !store.access_token) {
      return res.status(400).json({ error: 'Store not connected' });
    }
    const definitions = await shopifySync.getShopifyMetafieldDefinitions(store);
    res.json({ metafields: definitions });
  } catch (error) {
    console.error('Metafield definitions error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get store mapping configuration
app.get('/api/mappings/:storeId', (req, res) => {
  // Mock mapping configuration
  const mockMapping = {
    storeId: req.params.storeId,
    standardFields: {
      title: { pimField: 'title', enabled: true },
      body_html: { pimField: 'description', enabled: true },
      vendor: { pimField: 'brand', enabled: true },
      product_type: { pimField: 'type', enabled: true },
      tags: { pimField: 'tags', enabled: true },
    },
    variantFields: {
      sku: { pimField: 'sku', enabled: true },
      price: { pimField: 'price', enabled: true },
      compare_at_price: { pimField: 'compareAtPrice', enabled: true },
      cost: { pimField: 'cost', enabled: true },
      barcode: { pimField: 'barcode', enabled: true },
    },
    metafields: [
      { pimField: 'seoTitle', namespace: 'seo', key: 'title', enabled: true },
      { pimField: 'metaDescription', namespace: 'seo', key: 'description', enabled: true },
      { pimField: 'material', namespace: 'custom', key: 'material', enabled: true },
      { pimField: 'technology', namespace: 'custom', key: 'technology', enabled: true },
    ]
  };

  res.json(mockMapping);
});

// Save mapping configuration
app.post('/api/mappings/:storeId', (req, res) => {
  const { mapping } = req.body;
  // Would save to database
  console.log('Saving mapping for store:', req.params.storeId, mapping);
  res.json({ success: true });
});


// ============================================
// FILE IMPORT & MAPPING
// ============================================

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/import/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Ingen fil uppladdad' });
    }

    const fileName = req.file.originalname;
    const ext = fileName.split('.').pop().toLowerCase();
    let result;

    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      result = parseCsvBuffer(req.file.buffer);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const sheetIndex = parseInt(req.body.sheetIndex) || 0;
      const headerRow = parseInt(req.body.headerRow) || 1;
      result = parseExcelBuffer(req.file.buffer, { sheetIndex, headerRow });
    } else {
      return res.status(400).json({ error: `Filtyp "${ext}" stöds inte. Använd CSV, TSV, XLSX eller XLS.` });
    }

    const autoMapping = autoMapColumns(result.headers);
    const mappingStats = getMappingStats(autoMapping);

    res.json({
      fileName,
      ...result,
      preview: result.rows.slice(0, 5),
      autoMapping,
      mappingStats,
      shopifyFields: SHOPIFY_FIELDS,
    });
  } catch (error) {
    console.error('File parse error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/import/apply-mapping', async (req, res) => {
  try {
    const { rows, mapping } = req.body;
    if (!rows || !mapping) {
      return res.status(400).json({ error: 'rows och mapping krävs' });
    }

    const mappedProducts = applyMapping(rows, mapping);
    const stats = getMappingStats(mapping);

    res.json({
      products: mappedProducts,
      preview: mappedProducts.slice(0, 10),
      totalProducts: mappedProducts.length,
      stats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/import/shopify-fields', (req, res) => {
  res.json(SHOPIFY_FIELDS);
});

// ============================================
// INVENTORY SYNC (daily CSV diff + apply)
// ============================================

// POST /api/inventory/preview
// Body: multipart form — file + storeId + skuColumn + qtyColumn
// Returns: rows with { sku, productTitle, currentQty, newQty, delta, inventoryItemId, locationId }
app.post('/api/inventory/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ingen fil uppladdad' });
    const { storeId, skuColumn, qtyColumn } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId krävs' });

    // Parse file
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let parsed;
    if (['csv', 'tsv', 'txt'].includes(ext)) {
      parsed = parseCsvBuffer(req.file.buffer);
    } else if (['xlsx', 'xls'].includes(ext)) {
      parsed = parseExcelBuffer(req.file.buffer, {});
    } else {
      return res.status(400).json({ error: `Filtyp "${ext}" stöds inte` });
    }

    // Auto-detect columns if not specified
    const headers = parsed.headers;
    const resolvedSkuCol = skuColumn || headers.find(h => /sku|artnr|artikel/i.test(h)) || headers[0];
    const resolvedQtyCol = qtyColumn || headers.find(h => /qty|quantity|antal|lager|stock|saldo/i.test(h)) || headers[1];

    // Build SKU→newQty map from CSV
    const csvMap = {};
    for (const row of parsed.rows) {
      const sku = String(row[resolvedSkuCol] || '').trim();
      const qty = parseInt(row[resolvedQtyCol], 10);
      if (sku && !isNaN(qty)) csvMap[sku] = qty;
    }

    const skus = Object.keys(csvMap);
    if (!skus.length) return res.status(400).json({ error: 'Inga giltiga SKU/antal-rader hittades' });

    // Look up variants by SKU in Supabase (only this store)
    const { data: variants, error: varErr } = await supabase
      .from('variants')
      .select('sku, shopify_inventory_item_id, shopify_variant_id, products(title, store_id)')
      .in('sku', skus);

    if (varErr) throw varErr;

    // Filter to this store
    const storeVariants = (variants || []).filter(v => String(v.products?.store_id) === String(storeId));

    // Get the store
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad till Shopify' });

    // Fetch current inventory from Shopify for matched inventory_item_ids
    const itemIds = storeVariants
      .map(v => v.shopify_inventory_item_id)
      .filter(Boolean)
      .map(Number);

    const shopifyLevels = itemIds.length
      ? await shopifySync.getInventoryLevelsByItemIds(store, itemIds)
      : {};

    // Get primary location
    const primaryLocationId = await shopifySync.getPrimaryLocationId(store);

    // Build diff rows
    const diff = [];
    const notFound = [];

    for (const sku of skus) {
      const variant = storeVariants.find(v => v.sku === sku);
      if (!variant || !variant.shopify_inventory_item_id) {
        notFound.push(sku);
        continue;
      }

      const itemId = String(variant.shopify_inventory_item_id);
      const levels = shopifyLevels[itemId] || [];
      const currentQty = levels.reduce((sum, l) => sum + (l.available || 0), 0);
      const newQty = csvMap[sku];
      const delta = newQty - currentQty;

      // Pick best location (first, or primary)
      const locationId = levels[0]?.locationId ?? primaryLocationId;

      diff.push({
        sku,
        productTitle: variant.products?.title || '',
        inventoryItemId: variant.shopify_inventory_item_id,
        locationId,
        currentQty,
        newQty,
        delta,
        changed: delta !== 0,
      });
    }

    diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    res.json({
      diff,
      notFound,
      headers,
      resolvedSkuCol,
      resolvedQtyCol,
      totalRows: parsed.totalRows,
      matched: diff.length,
      changed: diff.filter(r => r.changed).length,
    });
  } catch (error) {
    console.error('Inventory preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/inventory/apply
// Body: { storeId, items: [{ inventoryItemId, locationId, newQty }] }
app.post('/api/inventory/apply', async (req, res) => {
  try {
    const { storeId, items } = req.body;
    if (!storeId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'storeId och items[] krävs' });
    }

    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad till Shopify' });

    const results = { ok: [], failed: [] };

    for (const item of items) {
      try {
        await shopifySync.updateInventory(store, item.inventoryItemId, item.locationId, item.newQty);
        results.ok.push(item.inventoryItemId);
      } catch (err) {
        results.failed.push({ inventoryItemId: item.inventoryItemId, error: err.message });
      }
    }

    res.json({
      updated: results.ok.length,
      failed: results.failed.length,
      errors: results.failed,
    });
  } catch (error) {
    console.error('Inventory apply error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMAGE PROCESSING
// ============================================

// Upload image from computer → Supabase Storage
app.post('/api/images/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ingen fil' });
  if (!supabase) return res.status(503).json({ error: 'Storage ej konfigurerat' });

  const { productId, productTitle, sku, position } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId krävs' });

  try {
    // Build SEO filename from SKU + title
    const slugTitle = (productTitle || 'produkt')
      .toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const skuSlug = sku ? sku.toLowerCase().replace(/[^a-z0-9]/g, '-') : null;
    const pos = parseInt(position) || 1;
    const suffix = pos === 1 ? '' : `-${pos}`;

    // Determine extension
    const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' };
    const ext = extMap[req.file.mimetype] || '.jpg';

    const filename = skuSlug ? `${skuSlug}-${slugTitle}${suffix}${ext}` : `${slugTitle}${suffix}${ext}`;
    const storagePath = `${productId}/${filename}`;

    // Resize/optimize with sharp if available
    let buffer = req.file.buffer;
    try {
      const sharp = (await import('sharp')).default;
      buffer = await sharp(buffer).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch (_) {}

    const { error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(storagePath, buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(storagePath);
    res.json({ url: urlData.publicUrl, filename, storagePath });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// AI-generate alt text for an image
app.post('/api/images/generate-alt', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'Anthropic API ej konfigurerat' });
  const { imageUrl, productTitle, productType, vendor } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl krävs' });

  try {
    // Fetch image as base64 for vision
    let imageContent;
    try {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
      if (!imgRes.ok) throw new Error('HTTP ' + imgRes.status);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ct = imgRes.headers.get('content-type') || 'image/jpeg';
      const mediaType = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
      imageContent = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
        { type: 'text', text: `Skriv en SEO-optimerad alt-text på svenska för denna produktbild.\nProdukt: ${productTitle || ''}\nTyp: ${productType || ''}\nVarumärke: ${vendor || ''}\n\nAlt-texten ska:\n- Beskriva vad som syns i bilden\n- Inkludera produktnamnet naturligt\n- Max 125 tecken\n- Inga citattecken eller prefix som "Alt-text:"\n\nSvara ENBART med alt-texten.` }
      ];
    } catch (_) {
      // Fallback without vision
      imageContent = [{ type: 'text', text: `Generera en kort SEO-optimerad alt-text på svenska för en produktbild av: ${productTitle || 'produkt'}. Typ: ${productType || ''}. Varumärke: ${vendor || ''}. Max 125 tecken. Svara ENBART med alt-texten.` }];
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: imageContent }],
    });
    res.json({ altText: response.content[0].text.trim().replace(/^["']|["']$/g, '') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/images/process', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Ingen bild uppladdad' });
    }

    const targetSize = parseInt(req.body.targetSize) || 1000;
    const result = await processImage(req.file.buffer, {
      targetSize,
      outputFormat: req.body.format || 'both',
    });

    res.json({
      metadata: result.metadata,
      webp: result.webp ? { size: result.webp.length, base64: result.webp.toString('base64').substring(0, 100) + '...' } : null,
      jpg: result.jpg ? { size: result.jpg.length } : null,
    });
  } catch (error) {
    console.error('Image process error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/images/process-url', async (req, res) => {
  try {
    const { url, targetSize } = req.body;
    if (!url) return res.status(400).json({ error: 'url krävs' });

    const { buffer, contentType } = await downloadImage(url);
    const result = await processImage(buffer, {
      targetSize: targetSize || 1000,
      outputFormat: 'webp',
    });

    res.json({
      originalContentType: contentType,
      metadata: result.metadata,
      webpSize: result.webp?.length || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/images/metadata', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ingen bild uppladdad' });
    const meta = await getImageMetadata(req.file.buffer);
    res.json(meta);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    apiKeyConfigured: !!anthropic,
    timestamp: new Date().toISOString()
  });
});

// ============================================
// IMAGE SYNC ENDPOINTS
// ============================================

// Check if an image URL exists (HEAD request)
app.get('/api/images/check', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    const response = await fetch(url, { 
      method: 'HEAD',
      timeout: 5000 
    });
    
    const exists = response.ok && 
      response.headers.get('content-type')?.startsWith('image/');
    
    res.json({ 
      exists,
      url,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length')
    });
  } catch (error) {
    // Network error or timeout means image doesn't exist/unreachable
    res.json({ exists: false, url: req.query.url, error: error.message });
  }
});

// Batch check multiple image URLs
app.post('/api/images/batch-check', async (req, res) => {
  try {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: 'urls array required' });
    }

    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await fetch(url, { method: 'HEAD' });
          return { 
            url, 
            exists: response.ok && response.headers.get('content-type')?.startsWith('image/')
          };
        } catch (error) {
          return { url, exists: false };
        }
      })
    );
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DATABASE API ENDPOINTS
// ============================================

// --- PRODUCTS ---

// Get all products
app.get('/api/db/products', async (req, res) => {
  try {
    // Return empty if no database configured
    if (!isDbConfigured()) {
      return res.json({ data: [], count: 0, total: 0 });
    }

    const storeId = getStoreId(req);
    if (!storeId) return res.json({ data: [], count: 0, total: 0 });

    const { vendor, type, status, tags, search, storeFilter, syncFilter, limit, offset } = req.query;

    const result = await db.getProducts({
      vendor,
      type,
      status,
      tags: tags ? tags.split(',') : undefined,
      search,
      storeId,
      storeFilter, // 'published', 'unpublished', or 'error'
      syncFilter, // 'pending' - visar produkter som behöver synkas
      limit: parseInt(limit) || 3000, // Max 3000 per request
      offset: parseInt(offset) || 0
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get filter metadata (brands, types, tags)
app.get('/api/db/products/metadata/filters', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.json({ brands: [], types: [], tags: [] });
    }

    const storeId = getStoreId(req);
    if (!storeId) return res.json({ brands: [], types: [], tags: [] });

    const metadata = await db.getFilterMetadata(storeId);
    res.json(metadata);
  } catch (error) {
    console.error('Filter metadata error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single product
app.get('/api/db/products/:id', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    const product = await db.getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (String(product.store_id) !== String(storeId)) {
      return res.status(403).json({ error: 'Produkten tillhör inte denna butik' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup duplicate products
app.post('/api/db/products/cleanup-duplicates', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const result = await db.cleanupDuplicateProducts();
    res.json(result);
  } catch (error) {
    console.error('Cleanup duplicates error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create product
app.post('/api/db/products', async (req, res) => {
  try {
    // Check if database is configured
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    // Ensure title is set (required by database)
    const productData = {
      ...req.body,
      title: req.body.title || 'Ny produkt',
      store_id: storeId
    };

    console.log('Creating product:', JSON.stringify(productData, null, 2));

    const product = await db.createProduct(productData);
    res.status(201).json(product);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// Bulk import products from CSV/Excel
app.post('/api/db/products/import', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Database not configured' });
  const storeId = await resolveStoreId(req);
  if (!storeId) return res.status(400).json({ error: 'store_id krävs — ingen butik hittades' });

  const { products } = req.body;
  if (!Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'Ingen produktdata skickades' });
  }

  let created = 0, updated = 0, errors = 0;
  const errorDetails = [];

  for (const p of products) {
    try {
      if (!p.title) { errors++; errorDetails.push('Produkt saknar titel — hoppades över'); continue; }

      const firstVariant = p.variants?.[0] || {};

      const productData = {
        title: p.title,
        description: p.description || '',
        vendor: p.vendor || '',
        product_type: p.type || p.product_type || '',
        // tags must be a PostgreSQL array — keep as JS array, Supabase handles conversion
        tags: Array.isArray(p.tags) ? p.tags : (p.tags ? [p.tags] : []),
        status: p.status || 'draft',
        seo_title: p.seoTitle || '',
        seo_description: p.seoDescription || '',
        country_of_origin: p.country_of_origin || null,
        hs_code: p.hs_code || null,
        store_id: storeId,
        metafields: p.metafields || {},
        images: (p.images || []).map(img => ({
          url: img.url,
          alt_text: img.alt || img.alt_text || p.title,
          position: img.position || 1,
          source: img.source || 'import',
          shopify_image_id: img.shopify_image_id || null,
        })),
        // First variant defaults on product level
        default_price: firstVariant.price ?? null,
        default_cost: firstVariant.cost ?? null,
        sku: firstVariant.sku || '',
        barcode: firstVariant.barcode || '',
        weight: firstVariant.weight ?? null,
        // Full variants array for multi-variant products
        variants: (p.variants || []).map(v => ({
          sku: v.sku || '',
          barcode: v.barcode || '',
          price: v.price ?? null,
          compare_at_price: v.compareAtPrice ?? null,
          cost: v.cost ?? null,
          inventory_quantity: v.inventoryQuantity ?? 0,
          weight: v.weight ?? null,
          option1_name: v.option1Name || null,
          option1_value: v.option1Value || null,
          option2_name: v.option2Name || null,
          option2_value: v.option2Value || null,
          option3_name: v.option3Name || null,
          option3_value: v.option3Value || null,
        })),
      };

      // Duplicate check: SKU first, then barcode
      const sku = productData.sku;
      const barcode = productData.barcode;
      let existing = null;
      if (supabase) {
        if (sku) {
          const { data } = await supabase.from('products').select('id').eq('store_id', storeId).eq('sku', sku).maybeSingle();
          existing = data;
        }
        if (!existing && barcode) {
          const { data } = await supabase.from('products').select('id').eq('store_id', storeId).eq('barcode', barcode).maybeSingle();
          existing = data;
        }
      }

      if (existing) {
        await db.updateProduct(existing.id, productData);
        updated++;
      } else {
        await db.createProduct(productData);
        created++;
      }
    } catch (err) {
      errors++;
      errorDetails.push(`${p.title}: ${err.message}`);
    }
  }

  // Save mapping profile if requested
  const { supplierName, mapping: mappingToSave, groupCol, variantOptions, headers: savedHeaders } = req.body;
  if (supplierName && mappingToSave && supabase) {
    try {
      await supabase.from('import_mappings').upsert({
        store_id: storeId,
        supplier_name: supplierName,
        headers: savedHeaders || [],
        mapping: mappingToSave,
        group_col: groupCol || null,
        variant_options: variantOptions || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'store_id,supplier_name' });
    } catch (e) {
      console.warn('Could not save import mapping:', e.message);
    }
  }

  res.json({ created, updated, errors, errorDetails: errorDetails.slice(0, 10) });
});

// --- IMPORT MAPPINGS ---

// Match headers to a saved supplier mapping
app.post('/api/db/import-mappings/match', async (req, res) => {
  if (!isDbConfigured()) return res.json(null);
  const storeId = await resolveStoreId(req);
  if (!storeId) return res.json(null);

  const { headers } = req.body;
  if (!Array.isArray(headers) || !headers.length) return res.json(null);

  try {
    const { data, error } = await supabase
      .from('import_mappings')
      .select('*')
      .eq('store_id', storeId);
    if (error || !data?.length) return res.json(null);

    const headerSet = new Set(headers);
    let bestMatch = null;
    let bestScore = 0;

    for (const profile of data) {
      const saved = Array.isArray(profile.headers) ? profile.headers : [];
      if (!saved.length) continue;
      const overlap = saved.filter(h => headerSet.has(h)).length;
      const score = overlap / Math.max(saved.length, headers.length);
      if (score > bestScore && score >= 0.8) {
        bestScore = score;
        bestMatch = profile;
      }
    }

    res.json(bestMatch || null);
  } catch (e) {
    res.json(null);
  }
});

// List all import mappings for store
app.get('/api/db/import-mappings', async (req, res) => {
  if (!isDbConfigured()) return res.json([]);
  const storeId = await resolveStoreId(req);
  if (!storeId) return res.json([]);
  try {
    const { data } = await supabase.from('import_mappings').select('id,supplier_name,headers,updated_at').eq('store_id', storeId).order('supplier_name');
    res.json(data || []);
  } catch (e) {
    res.json([]);
  }
});

// Delete import mapping
app.delete('/api/db/import-mappings/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'DB not configured' });
  try {
    await supabase.from('import_mappings').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update product
app.put('/api/db/products/:id', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    // Verify product belongs to store before updating
    const existing = await db.getProductById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (String(existing.store_id) !== String(storeId)) {
      return res.status(403).json({ error: 'Produkten tillhör inte denna butik' });
    }

    const product = await db.updateProduct(req.params.id, req.body);

    // Recompute default_price if pricing inputs changed
    const pricingFields = ['default_cost', 'margin_multiplier', 'product_type', 'supplier_id'];
    if (pricingFields.some(f => f in req.body)) {
      try {
        await db.recomputeProductPrice(req.params.id, storeId);
      } catch (e) {
        console.log('Price recompute failed:', e.message);
      }
    }

    // Markera produkten som "pending" — på produkten direkt och i alla store_products
    try {
      await supabase
        .from('products')
        .update({ sync_status: 'pending' })
        .eq('id', req.params.id);
      await supabase
        .from('store_products')
        .update({ sync_status: 'pending', updated_at: new Date().toISOString() })
        .eq('product_id', req.params.id);
    } catch (syncErr) {
      console.log('Could not mark product as pending:', syncErr.message);
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product
app.delete('/api/db/products/:id', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    // Verify product belongs to store before deleting
    const existing = await db.getProductById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (String(existing.store_id) !== String(storeId)) {
      return res.status(403).json({ error: 'Produkten tillhör inte denna butik' });
    }

    await db.deleteProduct(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk update products (for price changes etc)
app.post('/api/db/products/bulk-update', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    const { updates } = req.body;
    const results = await db.bulkUpdateProducts(updates, storeId);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- STORES ---

// Get all stores
app.get('/api/db/stores', async (req, res) => {
  try {
    // Return empty if no database configured
    if (!isDbConfigured()) {
      return res.json([]);
    }
    
    const stores = await db.getStores();
    res.json(stores);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single store
app.get('/api/db/stores/:id', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create store
app.post('/api/db/stores', async (req, res) => {
  try {
    const store = await db.createStore(req.body);
    res.status(201).json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update store
app.put('/api/db/stores/:id', async (req, res) => {
  try {
    const store = await db.updateStore(req.params.id, req.body);
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test store connection
app.post('/api/db/stores/:id/test', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    
    const result = await shopifySync.testConnection(store);
    
    // Update store status
    await db.updateStore(store.id, {
      status: result.success ? 'connected' : 'error'
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PUBLISHING ---

// Publish product to stores
// In-memory lock to prevent concurrent publish of the same product
const publishingLocks = new Map();

app.post('/api/db/products/:id/publish', async (req, res) => {
  const productId = req.params.id;
  const { storeIds } = req.body;

  // Check for concurrent publish lock
  for (const storeId of storeIds) {
    const lockKey = `${productId}-${storeId}`;
    if (publishingLocks.has(lockKey)) {
      console.log(`Publish blocked - already in progress for product ${productId} to store ${storeId}`);
      return res.status(409).json({
        error: 'Publicering pågår redan för denna produkt. Vänta tills den är klar.',
        alreadyInProgress: true
      });
    }
  }

  // Set locks for all store combinations
  for (const storeId of storeIds) {
    publishingLocks.set(`${productId}-${storeId}`, Date.now());
  }

  // Auto-release locks after 5 minutes (safety net)
  const lockTimeout = setTimeout(() => {
    for (const storeId of storeIds) {
      publishingLocks.delete(`${productId}-${storeId}`);
    }
  }, 5 * 60 * 1000);

  try {
    console.log('=== PUBLISH REQUEST ===');
    console.log('Product ID:', productId);
    console.log('Store IDs:', storeIds);

    // First, mark product for publishing in database
    const result = await db.publishProductToStores(productId, storeIds);

    // Then, actually sync to Shopify for each store
    const syncResults = [];
    for (const storeId of storeIds) {
      try {
        // Get store details
        const store = await db.getStoreById(storeId);
        if (!store || !store.access_token) {
          syncResults.push({ storeId, success: false, error: 'Store not connected or missing access token' });
          continue;
        }

        // Get full product data
        const product = await db.getProductById(productId);
        if (!product) {
          syncResults.push({ storeId, success: false, error: 'Product not found' });
          continue;
        }

        console.log('=== PRODUCT FROM DATABASE ===');
        console.log('Title:', product.title);
        console.log('default_price:', product.default_price);
        console.log('default_cost:', product.default_cost);
        console.log('Variants:', product.variants?.length || 0);
        if (product.variants?.length) {
          product.variants.forEach((v, i) => {
            console.log(`  Variant ${i}: sku=${v.sku}, price=${v.price}, cost=${v.cost}`);
          });
        }

        // Check if product already exists in Shopify (in store_products table)
        const storeProduct = result.find(sp => sp.store_id === storeId);

        if (storeProduct?.shopify_product_id) {
          // Update existing
          await shopifySync.updateProduct(store, product, storeProduct.shopify_product_id);
          syncResults.push({ storeId, success: true, action: 'updated' });
        } else {
          // Create new (createProduct now includes duplicate check against Shopify)
          await shopifySync.createProduct(store, product);
          syncResults.push({ storeId, success: true, action: 'created' });
        }
      } catch (syncError) {
        console.error(`Sync error for store ${storeId}:`, syncError);
        syncResults.push({ storeId, success: false, error: syncError.message });

        // Update sync status to error
        await db.updateStoreProductSyncStatus(productId, storeId, 'error', syncError.message);
      }
    }

    res.json({
      published: result,
      syncResults,
      allSynced: syncResults.every(r => r.success)
    });
  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Release locks
    clearTimeout(lockTimeout);
    for (const storeId of storeIds) {
      publishingLocks.delete(`${productId}-${storeId}`);
    }
  }
});

// Unpublish product from store
app.delete('/api/db/products/:productId/stores/:storeId', async (req, res) => {
  try {
    await db.unpublishProductFromStore(req.params.productId, req.params.storeId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get product sync status
app.get('/api/db/products/:id/sync-status', async (req, res) => {
  try {
    const status = await db.getProductSyncStatus(req.params.id);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hämta live lagersaldo per butik/location för en produkt (bara PIM-konfigurerade locations)
app.get('/api/db/products/:id/inventory', async (req, res) => {
  try {
    const productId = req.params.id;

    const { data: storeProducts, error } = await supabase
      .from('store_products')
      .select('store_id, shopify_product_id, shopify_product_gid, stores(id, name, domain, access_token, api_version)')
      .eq('product_id', productId)
      .not('shopify_product_id', 'is', null);

    if (error) throw error;
    if (!storeProducts?.length) {
      return res.json({ stores: [], message: 'Produkten är inte kopplad till någon butik' });
    }

    const results = [];
    for (const sp of storeProducts) {
      try {
        const store = sp.stores;
        if (!store?.access_token) continue;

        const inventory = await shopifySync.getProductInventoryLevels(
          store,
          sp.shopify_product_gid || String(sp.shopify_product_id)
        );

        results.push({
          storeId: store.id,
          storeName: store.name,
          inventory
        });
      } catch (err) {
        results.push({
          storeId: sp.store_id,
          storeName: sp.stores?.name,
          error: err.message
        });
      }
    }

    res.json({ stores: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retry all failed syncs for a store
app.post('/api/db/stores/:storeId/retry-failed', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await db.getStoreById(storeId);
    if (!store || !store.access_token) {
      return res.status(400).json({ error: 'Store not connected' });
    }

    // Get all failed products for this store
    const { data: failedProducts } = await supabase
      .from('store_products')
      .select('product_id, shopify_product_id')
      .eq('store_id', storeId)
      .eq('sync_status', 'error');

    if (!failedProducts?.length) {
      return res.json({ retried: 0, message: 'Inga misslyckade produkter att synka om' });
    }

    const results = { total: failedProducts.length, success: 0, failed: 0, errors: [] };

    for (const sp of failedProducts) {
      try {
        const product = await db.getProductById(sp.product_id);
        if (!product) {
          results.failed++;
          results.errors.push({ productId: sp.product_id, error: 'Product not found' });
          continue;
        }

        if (sp.shopify_product_id) {
          await shopifySync.updateProduct(store, product, sp.shopify_product_id);
        } else {
          await shopifySync.createProduct(store, product);
        }
        results.success++;
      } catch (syncError) {
        results.failed++;
        results.errors.push({ productId: sp.product_id, error: syncError.message });
        await db.updateStoreProductSyncStatus(sp.product_id, storeId, 'error', syncError.message);
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Retry failed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get sync error summary for a store
app.get('/api/db/stores/:storeId/sync-errors', async (req, res) => {
  try {
    const { storeId } = req.params;
    const errors = await db.getSyncErrors(storeId);
    res.json(errors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PRICE CAMPAIGNS ---

// Get campaigns
app.get('/api/db/campaigns', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    const campaigns = await db.getCampaigns(storeId);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create campaign
app.post('/api/db/campaigns', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    const { campaign, productPrices } = req.body;
    const result = await db.createCampaign({ ...campaign, store_id: storeId }, productPrices);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// End campaign (restore prices)
app.post('/api/db/campaigns/:id/end', async (req, res) => {
  try {
    await db.endCampaign(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- METAFIELD DEFINITIONS ---

// Get metafield definitions (global + store-specific)
app.get('/api/db/metafields', async (req, res) => {
  try {
    const { storeId } = req.query;
    const { data, error } = await supabase
      .from('metafield_definitions')
      .select('*')
      .or(storeId ? `store_id.is.null,store_id.eq.${storeId}` : 'store_id.is.null')
      .order('sort_order');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create metafield definition
app.post('/api/db/metafields', async (req, res) => {
  try {
    const { name, key, namespace, field_type, description, store_id } = req.body;
    if (!name || !key || !namespace || !field_type) {
      return res.status(400).json({ error: 'name, key, namespace och field_type krävs' });
    }
    const safeKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const { data, error } = await supabase
      .from('metafield_definitions')
      .insert({
        name,
        key: safeKey,
        namespace: namespace || 'custom',
        field_type,
        description: description || '',
        store_id: store_id || null,
        is_system: false,
        sort_order: 100
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update metafield definition
app.put('/api/db/metafields/:id', async (req, res) => {
  try {
    const { name, description, is_required, show_in_list, sort_order } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (is_required !== undefined) updates.is_required = is_required;
    if (show_in_list !== undefined) updates.show_in_list = show_in_list;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    const { data, error } = await supabase
      .from('metafield_definitions')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete metafield definition (only non-system)
app.delete('/api/db/metafields/:id', async (req, res) => {
  try {
    const { data: def } = await supabase
      .from('metafield_definitions')
      .select('is_system')
      .eq('id', req.params.id)
      .single();
    if (def?.is_system) {
      return res.status(400).json({ error: 'Systemfält kan inte tas bort' });
    }
    const { error } = await supabase
      .from('metafield_definitions')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI suggest metafield definitions based on product type
app.post('/api/db/metafields/ai-suggest', async (req, res) => {
  try {
    const { productType, category, existingFields } = req.body;
    if (!anthropic) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Du är expert på Shopify-metafält för e-handel. Föreslå metafält för produkttypen "${productType || 'okänd'}"${category ? ` i kategorin "${category}"` : ''}.

Befintliga fält (föreslå INTE dessa): ${(existingFields || []).join(', ')}

Svara ENBART med JSON-array (inga backticks, ingen markdown):
[{"name":"Fältnamn på svenska","key":"falt_key_snake_case","namespace":"custom","field_type":"single_line_text|multi_line_text|json|number|boolean","description":"Kort beskrivning"}]

Föreslå 3-8 relevanta fält. Tänk på: specifikationer, skötselråd, material, certifieringar, mått, tekniska data. Använd rätt field_type (json för strukturerad data, multi_line_text för längre text).`
      }]
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Kunde inte parsa AI-svar' });
    }
    const suggestions = JSON.parse(jsonMatch[0]);
    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync metafield definitions to Shopify store
app.post('/api/db/stores/:id/sync-metafields', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    const results = await shopifySync.syncMetafieldDefinitions(store);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get store's Shopify metafields
app.get('/api/db/stores/:id/shopify-metafields', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    const definitions = await shopifySync.getShopifyMetafieldDefinitions(store);
    res.json(definitions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- COLLECTIONS ---

// GET /api/db/collections — list collections for store
app.get('/api/db/collections', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const { data, error } = await supabase
      .from('collections')
      .select('*')
      .eq('store_id', storeId)
      .order('title');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('GET collections error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/db/collections/:id — get single collection with products
app.get('/api/db/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('collections')
      .select(`*, collection_products(*, products(id, title, sku, images(*)))`)
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Collection not found' });
    res.json(data);
  } catch (error) {
    console.error('GET collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/db/collections — create collection
app.post('/api/db/collections', async (req, res) => {
  try {
    const storeId = await resolveStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const { title, handle, description, collection_type, sort_order, published,
      image_url, image_alt, rules, disjunctive, seo_title, seo_description,
      agent_summary, short_description, use_cases, faq, metafields } = req.body;
    if (!title) return res.status(400).json({ error: 'title krävs' });

    const slug = handle || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const { data, error } = await supabase
      .from('collections')
      .insert({
        store_id: storeId,
        title,
        handle: slug,
        description: description || null,
        collection_type: collection_type || 'manual',
        sort_order: sort_order || 'best-selling',
        published: published !== undefined ? published : true,
        image_url: image_url || null,
        image_alt: image_alt || null,
        rules: rules || [],
        disjunctive: disjunctive || false,
        seo_title: seo_title || null,
        seo_description: seo_description || null,
        agent_summary: agent_summary || null,
        short_description: short_description || null,
        use_cases: use_cases || null,
        faq: faq || null,
        metafields: metafields || {},
        sync_status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error('POST collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/db/collections/:id — update collection
app.put('/api/db/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    // Remove id from fields if present
    delete fields.id;
    // Ensure sync_status is marked pending if content changed (unless explicitly set)
    if (!fields.sync_status) fields.sync_status = 'pending';

    const { data, error } = await supabase
      .from('collections')
      .update(fields)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('PUT collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/db/collections/:id
app.delete('/api/db/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('collections').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('DELETE collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/shopify/stores/:storeId/collections — fetch all collections from Shopify
app.get('/api/shopify/stores/:storeId/collections', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const client = shopifySync.getClient(store);

    // Fetch custom (manual) collections
    const customRes = await client.request('/custom_collections.json?limit=250');
    const customCollections = (customRes.custom_collections || []).map(c => ({
      shopify_collection_id: c.id,
      title: c.title,
      handle: c.handle,
      description: c.body_html || '',
      image: c.image || null,
      products_count: c.products_count || 0,
      collection_type: 'manual',
      published: !!c.published_at,
      sort_order: c.sort_order || 'best-selling',
      rules: [],
    }));

    // Fetch smart collections
    const smartRes = await client.request('/smart_collections.json?limit=250');
    const smartCollections = (smartRes.smart_collections || []).map(c => ({
      shopify_collection_id: c.id,
      title: c.title,
      handle: c.handle,
      description: c.body_html || '',
      image: c.image || null,
      products_count: c.products_count || 0,
      collection_type: 'smart',
      published: !!c.published_at,
      sort_order: c.sort_order || 'best-selling',
      rules: c.rules || [],
      disjunctive: c.disjunctive || false,
    }));

    res.json([...customCollections, ...smartCollections]);
  } catch (error) {
    console.error('GET Shopify collections error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/shopify/stores/:storeId/import-collections — import selected Shopify collections
app.post('/api/shopify/stores/:storeId/import-collections', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { collectionIds } = req.body; // array of shopify collection IDs (numbers)
    if (!collectionIds || !Array.isArray(collectionIds) || collectionIds.length === 0) {
      return res.status(400).json({ error: 'collectionIds array krävs' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const client = shopifySync.getClient(store);

    let imported = 0;
    let skipped = 0;

    for (const shopifyId of collectionIds) {
      // Check if already imported
      const { data: existing } = await supabase
        .from('collections')
        .select('id')
        .eq('store_id', storeId)
        .eq('shopify_collection_id', shopifyId)
        .maybeSingle();

      if (existing) {
        skipped++;
        continue;
      }

      // Determine type: try custom first, then smart
      let collectionData = null;
      let collectionType = 'manual';
      try {
        const r = await client.request(`/custom_collections/${shopifyId}.json`);
        if (r.custom_collection) { collectionData = r.custom_collection; collectionType = 'manual'; }
      } catch (_) {}
      if (!collectionData) {
        try {
          const r = await client.request(`/smart_collections/${shopifyId}.json`);
          if (r.smart_collection) { collectionData = r.smart_collection; collectionType = 'smart'; }
        } catch (_) {}
      }

      if (!collectionData) { skipped++; continue; }

      const slug = collectionData.handle || collectionData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      const { error: insertError } = await supabase.from('collections').upsert({
        store_id: storeId,
        title: collectionData.title,
        handle: slug,
        description: collectionData.body_html || null,
        collection_type: collectionType,
        sort_order: collectionData.sort_order || 'best-selling',
        published: !!collectionData.published_at,
        image_url: collectionData.image?.src || null,
        image_alt: collectionData.image?.alt || null,
        rules: collectionData.rules || [],
        disjunctive: collectionData.disjunctive || false,
        metafields: {},
        shopify_collection_id: shopifyId,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'store_id,handle', ignoreDuplicates: false });

      if (!insertError) imported++;
      else { console.error('Import collection error:', insertError); skipped++; }
    }

    res.json({ imported, skipped });
  } catch (error) {
    console.error('Import collections error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/db/collections/:id/sync — push collection to Shopify
app.post('/api/db/collections/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: collection, error: fetchError } = await supabase
      .from('collections')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchError || !collection) return res.status(404).json({ error: 'Collection not found' });

    const store = await db.getStoreById(collection.store_id);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const client = shopifySync.getClient(store);

    const isManual = collection.collection_type === 'manual';
    const endpoint = isManual ? 'custom_collections' : 'smart_collections';
    const resourceKey = isManual ? 'custom_collection' : 'smart_collection';

    // Build base payload
    const payload = {
      title: collection.title,
      body_html: collection.description || '',
      handle: collection.handle || '',
      published: collection.published !== false,
      sort_order: collection.sort_order || 'best-selling',
    };

    // Add image if present
    if (collection.image_url) {
      payload.image = { src: collection.image_url, alt: collection.image_alt || '' };
    }

    // Smart collection rules
    if (!isManual && collection.rules && collection.rules.length > 0) {
      payload.rules = collection.rules;
      payload.disjunctive = collection.disjunctive || false;
    }

    // Metafields
    if (collection.metafields && Object.keys(collection.metafields).length > 0) {
      payload.metafields = Object.entries(collection.metafields)
        .filter(([k, v]) => v !== null && v !== undefined && v !== '')
        .map(([key, value]) => {
          const parts = key.split('.');
          const namespace = parts.length > 1 ? parts[0] : 'custom';
          const metaKey = parts.length > 1 ? parts.slice(1).join('.') : parts[0];
          return { namespace, key: metaKey, value: String(value), type: 'single_line_text' };
        });
    }

    let shopifyId = collection.shopify_collection_id;
    let result;

    if (shopifyId) {
      // Update existing
      result = await client.request(`/${endpoint}/${shopifyId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ [resourceKey]: payload }),
      });
    } else {
      // Create new
      result = await client.request(`/${endpoint}.json`, {
        method: 'POST',
        body: JSON.stringify({ [resourceKey]: payload }),
      });
      shopifyId = result[resourceKey]?.id;
    }

    // Update DB
    const { data: updated } = await supabase
      .from('collections')
      .update({
        shopify_collection_id: shopifyId,
        shopify_collection_gid: `gid://shopify/Collection/${shopifyId}`,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    res.json({ success: true, collection: updated, shopifyResult: result[resourceKey] });
  } catch (error) {
    console.error('Sync collection error:', error);
    // Mark as error in DB
    await supabase.from('collections').update({ sync_status: 'error' }).eq('id', req.params.id);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/db/collections/:id/add-product — add product to manual collection
app.post('/api/db/collections/:id/add-product', async (req, res) => {
  try {
    const { id } = req.params;
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId krävs' });

    // Get max position
    const { data: existing } = await supabase
      .from('collection_products')
      .select('position')
      .eq('collection_id', id)
      .order('position', { ascending: false })
      .limit(1);
    const nextPos = ((existing?.[0]?.position) || 0) + 1;

    const { data, error } = await supabase
      .from('collection_products')
      .insert({ collection_id: id, product_id: productId, position: nextPos })
      .select('*, products(id, title, sku, images(*))')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error('Add product to collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/db/collections/:id/products/:productId — remove product from collection
app.delete('/api/db/collections/:id/products/:productId', async (req, res) => {
  try {
    const { id, productId } = req.params;
    const { error } = await supabase
      .from('collection_products')
      .delete()
      .eq('collection_id', id)
      .eq('product_id', productId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Remove product from collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/claude/collections/:id/enrich — AI enrich collection
app.post('/api/claude/collections/:id/enrich', async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'Anthropic API not configured' });

    const { id } = req.params;
    const { field } = req.body;

    // Load collection + products
    const { data: collection, error: fetchError } = await supabase
      .from('collections')
      .select(`*, collection_products(*, products(id, title, sku))`)
      .eq('id', id)
      .single();
    if (fetchError || !collection) return res.status(404).json({ error: 'Collection not found' });

    const productTitles = (collection.collection_products || [])
      .slice(0, 20)
      .map(cp => cp.products?.title)
      .filter(Boolean);

    const collectionContext = `
=== KATEGORISIDA (utgå alltid från detta) ===
Titel: ${collection.title}
Handle: ${collection.handle || ''}
Typ: ${collection.collection_type === 'smart' ? 'Smart collection (dynamisk)' : 'Manuell collection'}
Befintlig beskrivning: ${collection.description ? collection.description.replace(/<[^>]*>/g, '').substring(0, 600) : '(saknas)'}
Antal produkter: ${(collection.collection_products || []).length}
Produkter i kategorin (upp till 20): ${productTitles.length ? productTitles.join(', ') : '(inga produkter tillagda ännu)'}
Regler: ${collection.rules?.length ? JSON.stringify(collection.rules) : '(inga regler)'}`;

    let prompt = '';
    let maxTokens = 2048;

    if (field === 'all') {
      maxTokens = 4096;
      prompt = `Generera allt AI-innehåll för denna kategorisida i en Shopify-butik. ${collectionContext}

Svara ENBART med JSON:
{
  "description": "HTML-beskrivning för kategorisidan, 150-300 ord, benefit-driven, SEO-optimerad",
  "agentSummary": "6-8 punkter om vad kategorin innehåller, en per rad",
  "shortDescription": "2-3 meningar som sammanfattar kategorin",
  "faq": [{"question": "Fråga om kategorin", "answer": "Konkret svar 2-4 meningar"}],
  "useCases": "Vem kategorin passar för och i vilka situationer",
  "seoTitle": "Max 60 tecken SEO-titel",
  "seoDescription": "Max 155 tecken meta description"
}`;
    } else if (field === 'description') {
      prompt = `Generera en HTML-beskrivning för denna kategorisida (150-300 ord). Benefit-driven, SEO-optimerad. Använd <p>, <ul>, <li>-taggar. ${collectionContext}

Svara ENBART med HTML-texten.`;
    } else if (field === 'agentSummary') {
      prompt = `Generera en snabbfakta/agent summary för denna kategorisida. 6-8 punkter om vad kategorin innehåller och varför. En punkt per rad. ${collectionContext}

Svara ENBART med den genererade texten.`;
    } else if (field === 'shortDescription') {
      prompt = `Generera en kort ingress (2-3 meningar) för denna kategorisida. Sammanfattar vad man hittar i kategorin. ${collectionContext}

Svara ENBART med texten.`;
    } else if (field === 'faq') {
      prompt = `Generera 4-6 FAQ-frågor för denna kategorisida. Teman: vad ingår, hur väljer man, vad passar för vem, leverans/retur, skillnader inom kategorin. ${collectionContext}

Svara ENBART med JSON-array: [{"question": "Fråga", "answer": "Svar"}]`;
    } else if (field === 'useCases') {
      prompt = `Generera en beskrivning av användningsområden för denna kategori. Vem passar produkterna för, i vilka situationer används de. ${collectionContext}

Svara ENBART med texten.`;
    } else if (field === 'seo') {
      prompt = `Generera SEO-titel (max 60 tecken) och meta description (max 155 tecken) för denna kategorisida. ${collectionContext}

Svara ENBART med JSON: {"seoTitle": "...", "seoDescription": "..."}`;
    } else {
      return res.status(400).json({ error: `Okänt fält: ${field}` });
    }

    const systemPrompt = `Du är en expert på e-handels SEO och kategorisidor. Optimera för SEO, AEO och GEO.

ABSOLUT VIKTIGASTE REGEL:
- Använd ENBART information som finns i kategoridatan och produktlistan ovan
- Hitta ALDRIG på fakta, mått, priser, varumärken eller egenskaper som inte nämns
- Om ett faktum saknas: utelämna det eller skriv generellt
- Du är en redaktör som strukturerar och förbättrar befintlig data — inte en fantasiförfattare

REGLER:
- Skriv på svenska
- SEO-titel: max 60 tecken, inkludera huvudnyckelord
- Meta description: HÅRDGRÄNS max 155 tecken
- Beskrivning: benefit-driven, >150 ord, clean HTML
- FAQ: baseras på produkternas innehåll, konkreta svar`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    let result;

    if (field === 'all' || field === 'faq' || field === 'seo') {
      try {
        const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : text;
      } catch {
        result = text;
      }
    } else {
      result = text.trim();
    }

    res.json({ field, result });
  } catch (error) {
    console.error('AI enrich collection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- SUPPLIER PROFILES ---

// Get supplier profiles
app.get('/api/db/suppliers', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });

    const profiles = await db.getSupplierProfiles(storeId);
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create supplier profile
app.post('/api/db/suppliers', async (req, res) => {
  try {
    const profile = await db.createSupplierProfile(req.body);
    res.status(201).json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SYNC ---

// Trigger sync for store
app.post('/api/db/stores/:id/sync', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    
    const results = await shopifySync.syncPendingProducts(store);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sync queue status
app.get('/api/db/sync-queue', async (req, res) => {
  try {
    const jobs = await db.getPendingSyncJobs(50);
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SYNC WORKER CONTROL ---

// Start sync worker
app.post('/api/sync-worker/start', (req, res) => {
  syncWorker.start();
  res.json({ status: 'started' });
});

// Stop sync worker
app.post('/api/sync-worker/stop', (req, res) => {
  syncWorker.stop();
  res.json({ status: 'stopped' });
});

// ============================================
// SHOPIFY APP OAUTH ENDPOINTS
// ============================================

// Shopify install entry point — Shopify redirects here with ?shop=xxx&hmac=xxx
// when the merchant clicks the install link from Partner Dashboard.
app.get('/', (req, res) => {
  const { shop, hmac, timestamp } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (shop && hmac && timestamp && shopifyApp.isConfigured()) {
    try {
      const { installUrl } = shopifyApp.getInstallUrl(shop);
      return res.redirect(installUrl);
    } catch (err) {
      return res.redirect(`${frontendUrl}/?error=${encodeURIComponent(err.message)}`);
    }
  }

  // No Shopify params — send to frontend
  res.redirect(frontendUrl);
});

// Check if Shopify App is configured
app.get('/api/shopify/app-status', (req, res) => {
  res.json({
    configured: shopifyApp.isConfigured(),
    appUrl: process.env.APP_URL || 'http://localhost:3001'
  });
});

// Start installation - returns URL to redirect user to
app.post('/api/shopify/install', (req, res) => {
  try {
    let { shop } = req.body;
    
    if (!shop) {
      return res.status(400).json({ error: 'Shop domain required' });
    }
    
    // Normalize shop domain
    shop = shop.toLowerCase().trim();
    if (!shop.includes('.myshopify.com')) {
      shop = shop.replace('.myshopify.com', '') + '.myshopify.com';
    }
    
    const { installUrl } = shopifyApp.getInstallUrl(shop);
    console.log('[Shopify install] shop:', shop);
    console.log('[Shopify install] installUrl:', installUrl);
    res.json({ installUrl, shop });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// OAuth callback from Shopify
app.get('/api/shopify/callback', async (req, res) => {
  try {
    const store = await shopifyApp.handleCallback(req.query);
    
    // Redirect to frontend with success
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/?store_connected=${store.id}&name=${encodeURIComponent(store.name)}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/?error=${encodeURIComponent(error.message)}`);
  }
});

// Webhook: App uninstalled
app.post('/api/shopify/webhooks/uninstalled', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const shop = req.headers['x-shopify-shop-domain'];
    
    if (!shopifyApp.verifyWebhook(req.body.toString(), hmac)) {
      return res.status(401).send('Invalid webhook signature');
    }
    
    await shopifyApp.handleUninstall(shop);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Uninstall webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============================================
// SHOPIFY → PIM: Gap detection & pull import
// ============================================

// GET /api/shopify/stores/:storeId/product-diff
// Returns Shopify products that are NOT yet in PIM
app.get('/api/shopify/stores/:storeId/product-diff', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const client = shopifySync.getClient(store);

    // Fetch all Shopify product IDs (paginated)
    const shopifyProducts = [];
    let pageInfo = null;
    do {
      const params = new URLSearchParams({ limit: '250', fields: 'id,title,status,variants,images,vendor,product_type,handle' });
      if (pageInfo) params.set('page_info', pageInfo);
      const data = await client.request(`/products.json?${params}`);
      shopifyProducts.push(...(data.products || []));
      // Parse Link header for cursor pagination
      pageInfo = null; // REST pagination via page_info not always available; loop once for simplicity
    } while (pageInfo);

    // Get all shopify_product_ids already in PIM for this store
    const { data: linked } = await supabase
      .from('store_products')
      .select('shopify_product_id')
      .eq('store_id', storeId)
      .not('shopify_product_id', 'is', null);

    const linkedIds = new Set((linked || []).map(r => String(r.shopify_product_id)));

    const newInShopify = shopifyProducts
      .filter(p => !linkedIds.has(String(p.id)))
      .map(p => ({
        shopifyId: p.id,
        title: p.title,
        vendor: p.vendor || '',
        productType: p.product_type || '',
        handle: p.handle,
        status: p.status,
        variantCount: p.variants?.length || 0,
        imageUrl: p.images?.[0]?.src || null,
      }));

    res.json({
      shopifyTotal: shopifyProducts.length,
      pimLinked: linkedIds.size,
      newInShopify,
    });
  } catch (err) {
    console.error('product-diff error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shopify/stores/:storeId/import-from-shopify
// Import selected Shopify products into PIM
app.post('/api/shopify/stores/:storeId/import-from-shopify', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { shopifyIds } = req.body;
    if (!Array.isArray(shopifyIds) || !shopifyIds.length) {
      return res.status(400).json({ error: 'Inga produkter valda' });
    }

    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const client = shopifySync.getClient(store);
    let created = 0, errors = 0;
    const errorDetails = [];

    // Get already-imported shopify IDs to skip duplicates
    const { data: existingLinks } = await supabase
      .from('store_products')
      .select('shopify_product_id')
      .eq('store_id', storeId)
      .not('shopify_product_id', 'is', null);
    const alreadyImported = new Set((existingLinks || []).map(r => String(r.shopify_product_id)));

    for (const shopifyId of shopifyIds) {
      // Skip if already in PIM
      if (alreadyImported.has(String(shopifyId))) {
        errorDetails.push(`Shopify #${shopifyId}: redan importerad — hoppades över`);
        continue;
      }

      try {
        const data = await client.request(`/products/${shopifyId}.json`);
        const sp = data.product;
        if (!sp) continue;

        const options = sp.options || [];
        const variants = (sp.variants || []).map(v => ({
          sku: v.sku || '',
          barcode: v.barcode || '',
          price: parseFloat(v.price) || null,
          compare_at_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
          inventory_quantity: v.inventory_quantity ?? 0,
          weight: v.grams || null,
          option1_name: options[0]?.name || null,
          option1_value: v.option1 || null,
          option2_name: options[1]?.name || null,
          option2_value: v.option2 || null,
          option3_name: options[2]?.name || null,
          option3_value: v.option3 || null,
          shopify_variant_id: v.id,
          shopify_inventory_item_id: v.inventory_item_id,
        }));

        // Images: correct column names (alt_text, not alt)
        const images = (sp.images || []).map((img, idx) => ({
          url: img.src,
          alt_text: img.alt || sp.title,
          position: idx + 1,
          source: 'shopify',
          shopify_image_id: String(img.id),
        }));

        const pimProduct = {
          store_id: storeId,
          title: sp.title,
          vendor: sp.vendor || '',
          product_type: sp.product_type || '',
          description: sp.body_html || '',
          tags: sp.tags ? sp.tags.split(', ').filter(Boolean) : [],
          status: sp.status === 'active' ? 'active' : 'draft',
          variants,
          images,
        };

        const created_product = await db.createProduct(pimProduct);

        // Link to store via store_products
        await supabase.from('store_products').upsert({
          product_id: created_product.id,
          store_id: storeId,
          shopify_product_id: sp.id,
          shopify_product_gid: `gid://shopify/Product/${sp.id}`,
          sync_status: 'synced',
          is_published: sp.status === 'active',
          last_synced_at: new Date().toISOString(),
        }, { onConflict: 'store_id,product_id' });

        created++;
      } catch (err) {
        errors++;
        errorDetails.push(`Shopify #${shopifyId}: ${err.message}`);
        console.error(`import-from-shopify #${shopifyId}:`, err);
      }
    }

    res.json({ created, errors, errorDetails });
  } catch (err) {
    console.error('import-from-shopify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a store
app.delete('/api/db/stores/:id', async (req, res) => {
  try {
    await shopifyApp.deleteStore(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual store connection (without OAuth - for custom apps)
app.post('/api/db/stores/connect-manual', async (req, res) => {
  try {
    const { shop, accessToken, name } = req.body;
    
    if (!shop || !accessToken) {
      return res.status(400).json({ error: 'Shop domain and access token required' });
    }
    
    // Normalize shop domain
    let domain = shop.toLowerCase().trim();
    if (!domain.includes('.myshopify.com')) {
      domain = domain.replace('.myshopify.com', '') + '.myshopify.com';
    }
    
    // Test the token
    const testResponse = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    
    if (!testResponse.ok) {
      return res.status(400).json({ error: 'Invalid access token or shop domain' });
    }
    
    const shopData = await testResponse.json();
    
    // Save store
    const store = await shopifyApp.saveStore({
      domain,
      accessToken,
      shopInfo: shopData.shop
    });
    
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMAGE OPTIMIZATION - Download, rename & upload to Supabase Storage
// ============================================
app.post('/api/products/:id/optimize-images', async (req, res) => {
  const { id } = req.params;

  try {
    const product = await db.getProductById(id);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    if (!product.images?.length) return res.json({ message: 'Inga bilder att optimera', optimized: 0 });

    // Build SEO slug: SKU + title (e.g. "081-619-01-annabelle-tallrik-gron")
    const skuSlug = (product.sku || product.variants?.[0]?.sku || '')
      .toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-|-$/g, '');
    const titleSlug = (product.title || 'produkt')
      .toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = skuSlug ? `${skuSlug}-${titleSlug}` : titleSlug;

    const results = [];
    for (let i = 0; i < product.images.length; i++) {
      const img = product.images[i];

      // Skip if already in Supabase Storage
      if (img.url?.includes('supabase.co/storage')) {
        results.push({ id: img.id, status: 'skipped', reason: 'Redan optimerad' });
        continue;
      }

      try {
        // Download original image
        const response = await fetch(img.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        // Determine extension from content type
        const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
        const ext = extMap[contentType] || '.jpg';

        // Build filename: produktnamn.jpg, produktnamn-2.jpg, etc.
        const suffix = i === 0 ? '' : `-${i + 1}`;
        const filename = `${slug}${suffix}${ext}`;
        const storagePath = `${id}/${filename}`;

        // Upload to Supabase Storage (overwrite if exists)
        const { error: uploadError } = await supabase.storage
          .from('product-images')
          .upload(storagePath, buffer, {
            contentType,
            upsert: true
          });

        if (uploadError) throw uploadError;

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('product-images')
          .getPublicUrl(storagePath);

        const newUrl = urlData.publicUrl;
        const altText = i === 0 ? product.title : `${product.title} - bild ${i + 1}`;

        // Update image in database - clear shopify_image_id to force re-upload on next push
        await supabase
          .from('images')
          .update({ url: newUrl, alt_text: altText, shopify_image_id: null })
          .eq('id', img.id);

        results.push({ id: img.id, status: 'optimized', filename, url: newUrl });
        console.log(`[Image Optimize] ${img.url.substring(0, 60)}... → ${filename}`);

      } catch (imgError) {
        console.error(`[Image Optimize] Failed for image ${i}:`, imgError.message);
        results.push({ id: img.id, status: 'error', error: imgError.message });
      }
    }

    const optimized = results.filter(r => r.status === 'optimized').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    res.json({
      message: `${optimized} bilder optimerade${skipped ? `, ${skipped} redan klara` : ''}`,
      optimized,
      skipped,
      results
    });
  } catch (error) {
    console.error('Optimize images error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PRODUCT FEEDS (Google Merchant Center)
// ============================================

// PUBLIC endpoint — no auth needed, uses token in URL
// GMC fetches this URL on a schedule
app.get('/api/feeds/:token', async (req, res) => {
  try {
    const feed = await feedService.getFeedByToken(req.params.token);
    if (!feed) return res.status(404).send('Feed not found');
    if (feed.status !== 'active') return res.status(403).send('Feed is paused');

    const { content, contentType, productCount } = await feedService.generateFeed(feed);

    const ext = feed.format === 'xml' ? 'xml' : feed.format === 'tsv' ? 'tsv' : 'csv';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${feed.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.${ext}"`);
    res.setHeader('X-Product-Count', productCount);
    res.send(content);
  } catch (error) {
    console.error('Feed generation error:', error);
    res.status(500).send('Feed generation failed');
  }
});

// ============================================
// PRICING ENGINE
// ============================================

app.get('/api/db/pricing-settings', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const settings = await db.getPricingSettings(storeId);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/db/pricing-settings', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const { default_margin_multiplier, default_vat_rate } = req.body;
    const updated = await db.upsertPricingSettings({
      store_id: storeId,
      default_margin_multiplier,
      default_vat_rate,
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/db/category-margin-rules', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const rules = await db.getCategoryMarginRules(storeId);
    res.json(rules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/db/category-margin-rules', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const { category, margin_multiplier } = req.body;
    if (!category || margin_multiplier == null) {
      return res.status(400).json({ error: 'category och margin_multiplier krävs' });
    }
    const rule = await db.upsertCategoryMarginRule({
      store_id: storeId,
      category,
      margin_multiplier,
    });
    res.json(rule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/db/category-margin-rules/:id', async (req, res) => {
  try {
    await db.deleteCategoryMarginRule(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk-set margin on selected products (margin_multiplier=null clears override).
app.post('/api/db/products/bulk-margin', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    const { productIds, margin_multiplier } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) {
      return res.status(400).json({ error: 'productIds krävs' });
    }
    const m = margin_multiplier === null || margin_multiplier === '' ? null : Number(margin_multiplier);
    const updated = await db.bulkSetProductMargin(productIds, m, storeId);
    const recomputed = await db.recomputeProductPrices(productIds, storeId);
    res.json({ updated: updated?.length || 0, recomputed: recomputed.filter(r => r.success).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recompute default_price for a list of products (or all in a store).
// Use after changing category rules or global settings.
app.post('/api/db/products/recompute-prices', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'store_id krävs' });
    let { productIds } = req.body || {};
    if (!Array.isArray(productIds) || !productIds.length) {
      const products = await db.getProducts({ storeId, limit: 10000 });
      productIds = products.map(p => p.id);
    }
    const results = await db.recomputeProductPrices(productIds, storeId);
    res.json({
      total: productIds.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all feeds for a store
app.get('/api/db/feeds', async (req, res) => {
  try {
    const storeId = req.query.storeId;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });

    const feeds = await feedService.getFeeds(storeId);
    res.json(feeds);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new feed
app.post('/api/db/feeds', async (req, res) => {
  try {
    const { storeId, name, format, filters, settings } = req.body;
    if (!storeId || !name) return res.status(400).json({ error: 'storeId and name required' });

    const feed = await feedService.createFeed(storeId, { name, format, filters, settings });
    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a feed
app.put('/api/db/feeds/:id', async (req, res) => {
  try {
    const { name, format, filters, settings, status } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (format !== undefined) updates.format = format;
    if (filters !== undefined) updates.filters = filters;
    if (settings !== undefined) updates.settings = settings;
    if (status !== undefined) updates.status = status;

    const feed = await feedService.updateFeed(req.params.id, updates);
    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a feed
app.delete('/api/db/feeds/:id', async (req, res) => {
  try {
    await feedService.deleteFeed(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Preview feed (returns JSON with product count and sample)
app.post('/api/db/feeds/:id/preview', async (req, res) => {
  try {
    const feed = await feedService.getFeed(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const products = await feedService.getFeedProducts(feed);
    res.json({
      productCount: products.length,
      sample: products.slice(0, 5).map(p => ({
        id: p.sku || p.id,
        title: p.feed_title || p.title,
        vendor: p.vendor,
        price: p.default_price
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Skip listen() in serverless environments (Vercel sets VERCEL=1).
// In serverless, the Express app is consumed by api/[...slug].js via serverless-http.
const isServerless = !!process.env.VERCEL;

if (!isServerless) app.listen(PORT, async () => {
  // Test database connection
  const dbConnected = await db.testConnection();

  console.log(`
🚀 PIM Backend Server running on http://localhost:${PORT}

Database Endpoints:
  GET    /api/db/products          - Get all products
  GET    /api/db/products/:id      - Get single product
  POST   /api/db/products          - Create product
  PUT    /api/db/products/:id      - Update product
  DELETE /api/db/products/:id      - Delete product
  POST   /api/db/products/bulk-update - Bulk update products
  
  GET    /api/db/stores            - Get all stores
  POST   /api/db/stores            - Create store
  POST   /api/db/stores/:id/test   - Test store connection
  POST   /api/db/stores/:id/sync   - Sync pending products
  POST   /api/db/stores/:id/sync-metafields - Sync metafield definitions
  
  POST   /api/db/products/:id/publish - Publish to stores
  GET    /api/db/products/:id/sync-status - Get sync status
  
  GET    /api/db/campaigns         - Get price campaigns
  POST   /api/db/campaigns         - Create campaign
  POST   /api/db/campaigns/:id/end - End campaign
  
  GET    /api/db/metafields        - Get metafield definitions
  GET    /api/db/suppliers         - Get supplier profiles

Feed Endpoints:
  GET    /api/feeds/:token         - Public feed URL (for GMC)
  GET    /api/db/feeds?storeId=    - Get all feeds for store
  POST   /api/db/feeds             - Create feed
  PUT    /api/db/feeds/:id         - Update feed
  DELETE /api/db/feeds/:id         - Delete feed
  POST   /api/db/feeds/:id/preview - Preview feed products

AI Endpoints:
  POST   /api/claude/chat          - Chat with Claude
  POST   /api/claude/generate-description - Generate description
  POST   /api/claude/batch-generate - Batch generate
  POST   /api/claude/parse-products - Parse product names

Status:
${dbConnected ? '✅ Database connected' : '⚠️  Database not configured - add SUPABASE_URL to .env'}
${anthropic ? '✅ Anthropic API configured' : '⚠️  Anthropic not configured - add ANTHROPIC_API_KEY to .env'}
  `);
});

export default app;