import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import sanitizeHtmlLib from 'sanitize-html';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dns from 'dns';
import net from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import multer from 'multer';
import { db, supabase, isDbConfigured } from './db.js';
import shopifySync, { SyncWorker } from './shopify.js';
import shopifyApp from './shopify-app.js';
import { processImage, downloadImage, generateAltText, getImageMetadata } from './services/image-processor.js';
import { feedService } from './feed-generator.js';
import { computeProductDiff, buildSyncPlan } from './services/sync-engine.js';
import * as googleSeo from './services/google-seo.js';
import * as priceWatch from './services/price-watch.js';
import * as shopifySales from './services/shopify-sales.js';
import * as supplierFile from './services/supplier-file.js';

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

// ============================================
// SSRF GUARD
// Any endpoint that fetches a user-supplied URL server-side must route through
// safeFetch(). It enforces http(s) only and resolves the hostname, rejecting
// private / loopback / link-local / cloud-metadata targets so the URL can't be
// used to reach internal services (e.g. 169.254.169.254, localhost, 10.x).
// ============================================
const isPrivateIp = (ip) => {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;                         // 10.0.0.0/8
    if (p[0] === 127) return true;                        // loopback
    if (p[0] === 0) return true;                          // 0.0.0.0/8
    if (p[0] === 169 && p[1] === 254) return true;        // link-local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;        // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;            // loopback / unspecified
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true; // link-local / ULA
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // not a literal IP → treat as unresolvable/unsafe
};

const assertUrlAllowed = async (rawUrl) => {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Ogiltig URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Endast http/https tillåts');
  }
  const host = u.hostname;
  // Literal IP in the URL → check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Intern adress blockerad');
    return;
  }
  // Hostname → resolve all A/AAAA records and reject if any is private.
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error('Kunde inte slå upp värdnamn');
  }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('Intern adress blockerad');
  }
};

// Drop-in replacement for fetch() on user-supplied URLs.
const safeFetch = async (url, options = {}) => {
  await assertUrlAllowed(url);
  return fetch(url, options);
};

// ============================================
// HTML SANITIZATION
// All rich-text (product/collection descriptions) can come from AI generation,
// imported files or scraped pages. Sanitize on the way in so neither the DB nor
// the Shopify storefront ever holds executable HTML. The allowlist keeps the
// formatting Quill produces (headings, lists, links, images, basic styling) and
// strips scripts, event handlers and javascript:/data: URLs.
// ============================================
const sanitizeHtml = (dirty) => {
  if (typeof dirty !== 'string' || dirty === '') return dirty;
  return sanitizeHtmlLib(dirty, {
    allowedTags: [
      'p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
      'ul', 'ol', 'li', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'pre', 'code', 'hr',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] }, // no data: URIs
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        'color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
        'background-color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'text-decoration': [/^(underline|line-through|none)$/],
      },
    },
    transformTags: {
      // Force safe rel on any link that opens a new tab.
      a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer' }, false),
    },
  });
};

// Sanitize the known HTML-bearing fields of a product/collection object in place.
const HTML_FIELDS = ['description', 'short_description', 'use_cases', 'body_html', 'intro'];
const sanitizeHtmlFields = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  for (const f of HTML_FIELDS) {
    if (typeof obj[f] === 'string') obj[f] = sanitizeHtml(obj[f]);
  }
  return obj;
};

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const app = express();
const PORT = process.env.PORT || 3001;
// Behind Vercel/Railway proxies — trust the first proxy so req.ip and
// x-forwarded-for reflect the real client for rate limiting.
app.set('trust proxy', 1);

// Initialize sync worker
const syncWorker = new SyncWorker();

// Middleware
// CORS - restrict in production, allow all in development.
// In production we require an explicit FRONTEND_URL allowlist and fail closed
// (no reflected origin) if it is missing, rather than echoing any origin.
const isProduction = process.env.NODE_ENV === 'production';
const corsOrigins = isProduction
  ? (process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)
      : false)
  : true;
if (isProduction && corsOrigins === false) {
  console.warn('⚠️ FRONTEND_URL not set in production — CORS will reject all cross-origin requests');
}
// Security headers. CSP is intentionally disabled here — this Express app
// serves the JSON API, not the HTML page, so the Content-Security-Policy that
// protects the frontend belongs on the static host (vercel.json). helmet still
// gives us HSTS, nosniff, frame-denial, referrer policy and X-Powered-By removal.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: corsOrigins, credentials: true }));
// Body size limits kept modest to reduce memory-exhaustion DoS surface.
// File uploads go through multer with their own limits, not JSON.
app.use(express.json({ limit: '10mb' }));

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

  // Resolve the active store from the client-supplied header/query, but never
  // trust it blindly: a non-admin may only act on stores they are assigned to.
  // Admins may act on any store (they manage all tenants).
  const requestedStoreId = req.headers['x-store-id'] || req.query.storeId || null;
  if (requestedStoreId && session.role !== 'admin' && !session.storeIds.includes(requestedStoreId)) {
    return res.status(403).json({ error: 'Forbidden - no access to this store' });
  }
  const activeStoreId = requestedStoreId || (session.storeIds.length > 0 ? session.storeIds[0] : null);

  req.user = {
    id: session.userId,
    role: session.role,
    storeIds: session.storeIds,
    activeStoreId
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

// Store-access middleware - for routes with a store id in the path
// (:id or :storeId). Admins pass; others must have the store assigned.
const requireStoreAccess = async (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const storeId = req.params.storeId || req.params.id;
  if (storeId && (req.user.storeIds || []).includes(storeId)) return next();
  return res.status(403).json({ error: 'Forbidden - no access to this store' });
};

// ============================================
// STORE ID HELPER
// ============================================
// Return the store the request is authorized to act on. This is the value
// validated in requireAuth (header/query checked against the user's stores),
// NOT the raw header — so callers can't reach across tenants.
const getStoreId = (req) => {
  return req.user?.activeStoreId || null;
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
// RATE LIMITING (lightweight, in-memory)
// Note: on serverless (Vercel) memory is per-instance and resets on cold start,
// so this is best-effort there. On a persistent host (Railway) it is effective.
// For strong guarantees behind multiple instances, back this with Redis/DB.
// ============================================
const _rlBuckets = new Map(); // key -> { count, resetAt }
const rateLimit = ({ windowMs, max, keyFn, message }) => (req, res, next) => {
  const key = keyFn(req);
  const now = Date.now();
  let bucket = _rlBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + windowMs };
    _rlBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > max) {
    res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: message || 'För många förfrågningar, försök igen senare' });
  }
  next();
};
// Occasionally evict stale buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of _rlBuckets) if (b.resetAt < now) _rlBuckets.delete(k);
}, 10 * 60 * 1000);

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || req.socket?.remoteAddress || 'unknown';

// Brute-force protection on login: 10 attempts / 15 min per IP+email.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `login:${clientIp(req)}:${(req.body?.email || '').toLowerCase()}`,
  message: 'För många inloggningsförsök. Vänta en stund och försök igen.',
});

// ============================================
// PROTECT DATA + AI ENDPOINTS  (default-deny)
// Every /api/* route requires a valid session token EXCEPT an explicit
// allowlist of public endpoints below. This is default-deny: a newly added
// route is protected automatically unless someone opts it out here.
// ============================================
// Exact public paths (no auth needed).
const publicExactPaths = new Set([
  '/api/ping',
  '/api/health',
  '/api/auth/login',
  '/api/auth/verify',   // validates its own bearer token internally
  '/api/auth/logout',
  '/api/price-watch/cron', // Vercel Cron — authenticates with CRON_SECRET, not a session
  '/api/cron/shopify-pull', // Vercel Cron — same secret
]);
// Public path prefixes — Shopify OAuth/webhooks send no session header.
const publicPrefixes = [
  '/api/shopify/callback',
  '/api/shopify/install',
  '/api/shopify/app-status',
  '/api/shopify/webhooks',
];
app.use((req, res, next) => {
  // Non-/api routes (static assets, SPA) are not gated here.
  if (!req.path.startsWith('/api/')) return next();
  // Public feed URLs authenticate with a per-feed token, not a session token.
  if (req.path.startsWith('/api/feeds/') && req.method === 'GET') return next();
  if (publicExactPaths.has(req.path)) return next();
  if (publicPrefixes.some(p => req.path.startsWith(p))) return next();
  // Everything else under /api requires a valid session.
  return requireAuth(req, res, next);
});

// Health / ping — no auth, no DB
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Login endpoint
app.post('/api/auth/login', loginLimiter, async (req, res) => {

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
        .select('id, name, email, password_hash, role, is_active')
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

  // Deactivated accounts cannot log in, even with valid credentials.
  if (user.is_active === false) {
    return res.status(403).json({ error: 'Kontot är inaktiverat' });
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
      if (typeof result.description === 'string') result.description = sanitizeHtml(result.description);
      res.json(result);
    } else {
      res.json({ description: sanitizeHtml(text) });
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

    // Cap batch size: each product triggers a paid Anthropic call, so an
    // unbounded array is a cost-DoS. Reject oversized batches outright.
    const MAX_BATCH = 50;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products måste vara en icke-tom lista' });
    }
    if (products.length > MAX_BATCH) {
      return res.status(413).json({ error: `Max ${MAX_BATCH} produkter per batch (fick ${products.length})` });
    }

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
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.description === 'string') parsed.description = sanitizeHtml(parsed.description);
          results.push({
            productId: product.id,
            success: true,
            ...parsed
          });
        } else {
          results.push({
            productId: product.id,
            success: true,
            description: sanitizeHtml(text)
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

// Suggest product_type + tags for a batch of products from their names.
// Body: { products: [{ sku, title }], language? }. Returns { suggestions: [{ sku, product_type, tags[] }] }.
app.post('/api/claude/suggest-taxonomy', async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'API key not configured' });
    const { products, language } = req.body;
    const MAX = 50;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products måste vara en icke-tom lista' });
    }
    if (products.length > MAX) {
      return res.status(413).json({ error: `Max ${MAX} produkter per anrop (fick ${products.length})` });
    }

    const list = products
      .map((p, i) => `${i + 1}. SKU ${String(p.sku || '').trim()}: ${String(p.title || '').trim()}`)
      .join('\n');

    const prompt = `Du är en e-handelskatalog-expert. För varje produkt nedan, härled produkttyp och relevanta taggar utifrån namnet. Produkttyp = den generiska varukategorin (t.ex. "Urna", "Bordslampa", "Kuddfodral"). Taggar = 3-6 korta, sökbara ${language === 'en' ? 'English' : 'svenska'} ord (material, färg, stil, rum, användning) — inga varumärkesnamn som taggar.

Produkter:
${list}

Svara ENBART med giltig JSON, en post per produkt i samma ordning:
{"suggestions":[{"sku":"...","product_type":"...","tags":["...","..."]}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let suggestions = [];
    if (jsonMatch) {
      try { suggestions = JSON.parse(jsonMatch[0]).suggestions || []; } catch { suggestions = []; }
    }
    // Normalize: strip any HTML the model may have slipped into fields.
    suggestions = suggestions.map(s => ({
      sku: String(s.sku || '').trim(),
      product_type: sanitizeHtmlLib(String(s.product_type || ''), { allowedTags: [], allowedAttributes: {} }).trim(),
      tags: Array.isArray(s.tags)
        ? s.tags.map(t => sanitizeHtmlLib(String(t), { allowedTags: [], allowedAttributes: {} }).trim()).filter(Boolean)
        : [],
    }));

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggest taxonomy error:', error);
    const msg = error.status === 529 ? 'Claude API är överbelastad. Försök igen.' : error.message;
    res.status(500).json({ error: msg });
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
      maxTokens = 8192;
      prompt = `Generera ALLT AI-innehåll för denna produkt i ett svep — beskrivning, ingress, snabbfakta, specs, FAQ, användningsområden, SEO. Använd visuell info från bifogade bilder, källmaterial och befintlig produktdata. ${productContext}

Svara ENBART med JSON (inga kommentarer, ingen markdown):
{
  "description": "Huvudbeskrivning som HTML. Benefit-driven, >150 ord. Använd <p>, <ul><li>, <strong>. Inga <h1>/<h2>. Ingen platshållartext.",
  "intro": "Kort ingress, 1-2 meningar, säljande hook. Ska komplettera beskrivningen, inte upprepa snabbfakta.",
  "agentSummary": "6-8 punkter i köpordning (viktigast först), en per rad, löptext som AI-agenter kan parsa.",
  "shortDescription": "2-3 säljande meningar löptext. Nyttobaserad. Ska INTE upprepa snabbfakta eller ingress.",
  "specifications": [{"name": "Attributnamn", "value": "Värde"}],
  "faq": [{"question": "Fråga", "answer": "Svar 2-4 meningar"}],
  "useCases": "Användningsområden, vem produkten passar för, i vilka situationer.",
  "seoTitle": "Max 60 tecken SEO-titel",
  "seoDescription": "Max 155 tecken meta description",
  "searchTerms": "kommaseparerade söktermer och synonymer",
  "tags": ["relevanta", "taggar"],
  "productType": "generisk varukategori/produkttyp, t.ex. Urna, Bordslampa, Kuddfodral",
  "material": "huvudmaterial, t.ex. Keramik, Mässing, Linne, Glas (tom om okänt)",
  "care": "kort skötselråd, t.ex. torka av med fuktig trasa (tom om ej relevant)",
  "series": "produktserie/kollektion om den framgår av namnet (t.ex. TREASURE, COTE NORD), annars tom",
  "scent": "doft om det är ett doftljus e.d., annars tom",
  "category": "Shopify standard product category as the ENGLISH taxonomy path, e.g. 'Home & Garden > Decor > Vases' or 'Home & Garden > Kitchen & Dining > Tableware > Coffee & Tea Cups' (best guess, English so it matches Shopify's taxonomy)"
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

    // Sanitize any HTML the model returned before it reaches the editor.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const f of ['description', 'intro', 'useCases']) {
        if (typeof result[f] === 'string') result[f] = sanitizeHtml(result[f]);
      }
    } else if (typeof result === 'string' && ['description', 'intro', 'useCases'].includes(field)) {
      result = sanitizeHtml(result);
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
    const response = await safeFetch(url, {
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
    const response = await safeFetch(url, {
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
      result = await parseExcelBuffer(req.file.buffer, { sheetIndex, headerRow });
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
      parsed = await parseExcelBuffer(req.file.buffer, {});
    } else {
      return res.status(400).json({ error: `Filtyp "${ext}" stöds inte` });
    }

    // The daily Affari file also feeds the dashboard's supplier snapshot
    // (stock, dropship approval, purchase price) — same upload, no extra step.
    // Awaited (serverless would kill a fire-and-forget), but never fatal.
    let supplierSnapshot = null;
    if (supplierFile.detectFileType(parsed.headers)) {
      try {
        const r = await supplierFile.importSupplierFile({ storeId, rows: parsed.rows, filename: req.file.originalname });
        supplierSnapshot = { type: r.type, imported: r.imported, counts: r.report?.counts };
        try { await db.logActivity('supplier_import', 'store', storeId, `Leverantörsfil inläst via lagerimport: ${req.file.originalname} (${r.imported} artiklar)`, { type: r.type }); } catch (_) {}
      } catch (e) {
        supplierSnapshot = { error: e.message };
        console.warn('Supplier snapshot skipped:', e.message);
      }
    }

    // Auto-detect columns if not specified
    const headers = parsed.headers;
    const resolvedSkuCol = skuColumn || headers.find(h => /sku|artnr|artikel/i.test(h)) || headers[0];
    const resolvedQtyCol = qtyColumn || headers.find(h => /qty|quantity|antal|lager|stock|saldo/i.test(h)) || headers[1];
    // Extra columns used when creating products that don't exist in Shopify yet.
    // "Benämning" is the TITLE in the inventory CSV but the TYPE in the rich
    // product export (which has a separate "Namn" column) — resolve accordingly.
    const H = (re) => headers.find(h => re.test(h));
    const namnCol = H(/^namn$/i);
    const benamningCol = H(/^benämning$/i);
    const nameCol = namnCol || benamningCol || H(/name|title|beskrivning/i);
    const typeCol = H(/produkttyp|kategori|^typ$/i) || (namnCol ? benamningCol : null);
    const eanCol = H(/ean|barcode|gtin|streckkod/i);
    const costCol = H(/grundpris|inköp/i) || H(/^pris/i) || H(/cost/i);
    const weightCol = H(/vikt|weight/i);
    const sizeCol = H(/produktens storlek|^storlek$/i);
    const dropshipCol = H(/godkänd.*dropship|dropship.*godkänd|^godkänd/i);
    // Rich metafield columns → Shopify metafield keys.
    const metaCols = {
      'custom.kollektion': H(/produktkollektion|^kollektion$/i),
      'custom.fargnyans': H(/färgnyans|^färg$|color/i),
      'custom.material': H(/^material$/i),
      'custom.doft': H(/^doft$/i),
      'custom.brinntid': H(/brinntid/i),
      'custom.tvattrad': H(/tvättråd|tvattrad|skötsel/i),
      'custom.info': H(/^information$|^info$/i),
      'custom.hs_kod': H(/hs.?kod/i),
      'custom.ursprungsland': H(/ursprung/i),
      'custom.forpackningsantal': H(/förpackningsantal|forpackningsantal/i),
      'custom.nyhet': H(/^nyhet$/i),
    };
    // Individual dimension columns (composed into custom.storlek + kept as own metafields).
    const dimCols = {
      diameter: H(/diameter/i), langd: H(/^längd$|^langd$/i), bredd: H(/^bredd$/i),
      djup: H(/^djup$/i), hojd: H(/^höjd$|^hojd$/i),
      specialmatt: H(/specialmått|specialmatt/i), innermatt: H(/innermått|innermatt/i),
    };
    const hasDimCols = Object.values(dimCols).some(Boolean);

    // Parse a Swedish/European decimal ("179,00" or "179.00") to a number.
    const parseNum = (val) => {
      if (val == null) return null;
      const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
      return isNaN(n) ? null : n;
    };
    const cell = (row, col) => (col ? String(row[col] ?? '').trim() : '');
    // Color: prefer the dedicated column, else the part after the last comma in
    // the supplier name ("TREASURE Urna S, Brun" -> "Brun").
    const parseColor = (name) => (name && name.includes(',') ? name.slice(name.lastIndexOf(',') + 1).trim() : '');
    // Compose individual dimensions into a readable size string ("Ø12,5×H8 cm").
    const composeStorlek = (row) => {
      const p = [];
      const d = cell(row, dimCols.diameter); if (d) p.push('Ø' + d);
      const l = cell(row, dimCols.langd); if (l) p.push('L' + l);
      const b = cell(row, dimCols.bredd); if (b) p.push('B' + b);
      const dj = cell(row, dimCols.djup); if (dj) p.push('D' + dj);
      const h = cell(row, dimCols.hojd); if (h) p.push('H' + h);
      let s = p.join('×');
      if (s) s += ' cm';
      const spec = cell(row, dimCols.specialmatt);
      const inner = cell(row, dimCols.innermatt);
      if (spec) s = (s ? s + ' · ' : '') + spec;
      if (inner) s = (s ? s + ' · innermått ' : 'innermått ') + inner;
      return s;
    };

    // Build SKU→newQty map + full row data from CSV
    const csvMap = {};
    const csvRows = {};
    for (const row of parsed.rows) {
      const sku = String(row[resolvedSkuCol] || '').trim();
      if (!sku) continue;
      const qty = parseInt(row[resolvedQtyCol], 10);
      if (!isNaN(qty)) csvMap[sku] = qty;
      const name = cell(row, nameCol);
      // Size: composed from dimension columns, else the single size column.
      const size = hasDimCols ? composeStorlek(row) : cell(row, sizeCol);
      const color = cell(row, metaCols['custom.fargnyans']) || parseColor(name);

      // Build the metafields object from the rich columns.
      const metafields = {};
      for (const [key, col] of Object.entries(metaCols)) {
        if (key === 'custom.fargnyans') continue; // handled via `color` below
        const v = cell(row, col);
        if (v) metafields[key] = v;
      }
      if (color) metafields['custom.fargnyans'] = color;
      if (size) metafields['custom.storlek'] = size;
      // Keep individual dimensions as their own metafields too.
      for (const [k, col] of Object.entries(dimCols)) {
        const v = cell(row, col);
        if (v) metafields['custom.' + k] = v;
      }

      csvRows[sku] = {
        sku,
        name,
        product_type: cell(row, typeCol),
        barcode: cell(row, eanCol),
        cost: costCol ? parseNum(row[costCol]) : null,
        weight: weightCol ? parseNum(row[weightCol]) : null,
        size,
        color,
        metafields,
        // Approved for dropship? If the column is absent, treat as approved.
        dropshipOk: dropshipCol ? /^(ja|yes|true|1)$/i.test(cell(row, dropshipCol)) : true,
        qty: isNaN(qty) ? null : qty,
      };
    }

    // SKUs to consider = every row (qty is optional; product-only files have no stock).
    const skus = Object.keys(csvRows);
    if (!skus.length) return res.status(400).json({ error: 'Inga giltiga SKU-rader hittades i filen' });
    const hasQty = Object.keys(csvMap).length > 0;

    // Get the store
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad till Shopify' });

    // Resolve the inventory location (only needed when the file carries stock).
    // Prefer the stored GID; else the locations API (needs read_locations); else
    // derive it from a product's inventory levels (works with read_inventory) and
    // persist it so a cleared settings object self-heals and never breaks again.
    let locationGid = store.settings?.inventory_location_gid || null;
    if (hasQty && !locationGid) {
      try { locationGid = await shopifySync.getPrimaryLocationGid(store); } catch { locationGid = null; }
      if (!locationGid) {
        try { locationGid = await shopifySync.getAnyInventoryLocationGid(store); } catch { locationGid = null; }
      }
      if (locationGid) {
        try {
          await supabase.from('stores')
            .update({ settings: { ...(store.settings || {}), inventory_location_gid: locationGid } })
            .eq('id', storeId);
        } catch (_) { /* best-effort cache */ }
      }
    }
    if (hasQty && !locationGid) {
      return res.status(400).json({
        error: 'Ingen lagerplats konfigurerad. Sätt store.settings.inventory_location_gid (t.ex. "gid://shopify/Location/123") eller ge appen read_locations-scope.',
      });
    }

    // Match live against Shopify (independent of local sync state): build a
    // SKU -> variants map straight from the store.
    const { map: shop, duplicateSkus } = await shopifySync.fetchInventoryMapFromShopify(store);

    // Build diff rows, tracking why SKUs are skipped.
    const diff = [];
    const notFound = [];       // SKU not present in Shopify
    const duplicates = [];     // SKU maps to >1 variant — must be resolved manually
    const untracked = [];      // variant has inventory tracking turned off

    for (const sku of skus) {
      const variants = shop.get(sku);
      if (!variants || variants.length === 0) { notFound.push(sku); continue; }
      if (variants.length > 1) { duplicates.push(sku); continue; }
      const v = variants[0];
      // Product is in Shopify → not a "new" candidate. Only build an inventory
      // diff row when the file actually carries a quantity for this SKU.
      if (!hasQty || csvMap[sku] == null) continue;
      if (!v.tracked) { untracked.push(sku); continue; }

      const currentQty = v.currentQty;
      const newQty = csvMap[sku];
      const delta = newQty - currentQty;

      diff.push({
        sku,
        productTitle: v.productTitle || '',
        productStatus: v.productStatus,
        inventoryItemId: v.inventoryItemId, // GID
        locationId: locationGid,
        currentQty,
        newQty,
        delta,
        changed: delta !== 0,
      });
    }

    diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    // Cost check: supplier unit price (file) × pack_qty (PIM) vs Shopify's
    // "cost per item". Flags missing cost, per-unit cost on a pack article,
    // supplier price changes, and plain mismatches. Read-only here; fixing
    // is a separate explicit action (/api/inventory/apply-cost).
    const costDiff = [];
    let costChecked = 0;
    if (costCol) {
      const packBySku = new Map(), pimCostBySku = new Map();
      try {
        for (let from = 0; ; from += 1000) {
          const { data } = await supabase.from('products').select('sku, pack_qty, default_cost').eq('store_id', storeId).range(from, from + 999);
          for (const p of data || []) if (p.sku) { packBySku.set(String(p.sku).trim(), p.pack_qty || 1); if (p.default_cost != null) pimCostBySku.set(String(p.sku).trim(), Number(p.default_cost)); }
          if (!data || data.length < 1000) break;
        }
        for (let from = 0; ; from += 1000) {
          const { data } = await supabase.from('variants').select('sku, pack_qty, cost').range(from, from + 999);
          for (const v of data || []) if (v.sku) { if (v.pack_qty) packBySku.set(String(v.sku).trim(), v.pack_qty); if (v.cost != null && !pimCostBySku.has(String(v.sku).trim())) pimCostBySku.set(String(v.sku).trim(), Number(v.cost)); }
          if (!data || data.length < 1000) break;
        }
      } catch (_) { /* pack_qty column missing → assume 1 */ }
      let multiplier = 2.5;
      try { multiplier = Number((await db.getPricingSettings(storeId))?.default_margin_multiplier) || 2.5; } catch (_) {}

      for (const sku of skus) {
        const variants = shop.get(sku);
        if (!variants || variants.length !== 1) continue;
        const v = variants[0];
        const unit = csvRows[sku]?.cost;
        if (unit == null || unit <= 0) continue;
        costChecked++;
        const pack = Math.max(1, Number(packBySku.get(sku)) || 1);
        const expected = Math.round(unit * pack * 100) / 100;
        const current = v.unitCost;
        if (current != null && Math.abs(current - expected) <= 0.5) continue;
        const pimCost = pimCostBySku.get(sku);
        let kind = 'mismatch';
        if (current == null) kind = 'missing';
        else if (pack > 1 && Math.abs(current - unit) <= 0.5) kind = 'unit-on-pack';
        else if (pimCost != null && Math.abs(pimCost - unit) > 0.5 && Math.abs(current - pimCost * pack) <= 0.5) kind = 'supplier-change';
        costDiff.push({
          sku, productTitle: v.productTitle || '', inventoryItemId: v.inventoryItemId,
          supplierUnitCost: unit, pack, expectedCost: expected, shopifyCost: current, kind,
          price: v.price, suggestedPrice: Math.round(expected * multiplier),
        });
      }
      const sev = { missing: 0, 'unit-on-pack': 1, mismatch: 2, 'supplier-change': 3 };
      costDiff.sort((a, b) => sev[a.kind] - sev[b.kind] || Math.abs((b.shopifyCost ?? 0) - b.expectedCost) - Math.abs((a.shopifyCost ?? 0) - a.expectedCost));
    }

    // Split the "not in Shopify" SKUs into two buckets:
    //  - alreadyInPim: exist as products in this PIM store but aren't pushed yet
    //  - newProducts:  don't exist anywhere → candidates to create from CSV data
    let alreadyInPim = [];
    let newProducts = [];
    let skippedNonDropship = 0;
    if (notFound.length) {
      const { data: pimVariants } = await supabase
        .from('variants')
        .select('sku, products!inner(store_id)')
        .in('sku', notFound)
        .eq('products.store_id', storeId);
      const pimSkus = new Set((pimVariants || []).map(v => v.sku));

      // Default margin for the suggested selling price (cost × margin).
      const pricing = await db.getPricingSettings(storeId).catch(() => null);
      const defaultMargin = Number(pricing?.default_margin_multiplier) || 2.0;

      for (const sku of notFound) {
        if (pimSkus.has(sku)) { alreadyInPim.push(sku); continue; }
        const row = csvRows[sku] || { sku };
        // Only create products approved for dropshipping.
        if (row.dropshipOk === false) { skippedNonDropship++; continue; }
        const cost = row.cost;
        const suggestedPrice = cost != null ? Math.round(cost * defaultMargin) : null;
        newProducts.push({
          sku,
          title: row.name || sku,
          barcode: row.barcode || '',
          cost,
          suggestedPrice,
          margin: defaultMargin,
          weight: row.weight,
          size: row.size || '',
          color: row.color || '',
          qty: row.qty,
          product_type: row.product_type || '',
          metafields: row.metafields || {},
          tags: [],
          imageUrl: '',
        });
      }
    }

    res.json({
      diff,
      notFound,
      duplicates,
      untracked,
      alreadyInPim,
      newProducts,
      headers,
      resolvedSkuCol,
      resolvedQtyCol,
      supplierSnapshot,
      costDiff: costCol ? costDiff : null,
      costChecked,
      totalRows: parsed.totalRows,
      matched: diff.length,
      changed: diff.filter(r => r.changed).length,
      skippedDuplicate: duplicates.length,
      skippedUntracked: untracked.length,
      newCount: newProducts.length,
      alreadyInPimCount: alreadyInPim.length,
      skippedNonDropship,
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

    // Group items by location, then push each location's changes in batches of
    // 100 via the batched inventorySetQuantities mutation (one API call each).
    const byLocation = new Map();
    for (const item of items) {
      if (!item.inventoryItemId || item.locationId == null || item.newQty == null) continue;
      if (!byLocation.has(item.locationId)) byLocation.set(item.locationId, []);
      byLocation.get(item.locationId).push({
        inventoryItemId: item.inventoryItemId,
        quantity: Number(item.newQty),
      });
    }

    const BATCH_SIZE = 100;
    let updated = 0;
    const errors = [];

    for (const [locationId, changes] of byLocation) {
      for (let i = 0; i < changes.length; i += BATCH_SIZE) {
        const batch = changes.slice(i, i + BATCH_SIZE);
        try {
          await shopifySync.setInventoryQuantitiesBatch(store, batch, locationId);
          updated += batch.length;
        } catch (batchErr) {
          // A batched inventorySetQuantities is atomic — one bad item fails the
          // whole call. Retry the batch item by item so one bad row doesn't kill
          // the rest, and report exactly which items failed and why.
          for (const item of batch) {
            try {
              await shopifySync.setInventoryQuantitiesBatch(store, [item], locationId);
              updated++;
            } catch (itemErr) {
              errors.push({ inventoryItemId: item.inventoryItemId, quantity: item.quantity, error: itemErr.message });
            }
            await new Promise(r => setTimeout(r, 150));
          }
        }
        // Gentle pacing between batches to stay within API limits.
        await new Promise(r => setTimeout(r, 500));
      }
    }

    res.json({
      updated,
      failed: errors.length,
      errors: errors.slice(0, 50),
    });
  } catch (error) {
    console.error('Inventory apply error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/inventory/create-products
// Create products (as drafts in the PIM) for SKUs found in the CSV but not in
// Shopify. Price is derived from the pricing engine: default_cost = CSV cost,
// selling price = cost × margin (2.0 global default) unless an explicit price
// is provided (which is stored as a per-product margin override).
// Fix the "cost per item" in Shopify from the supplier file: cost per sold
// article = supplier unit price × pack_qty. Mirrors the per-unit price into
// PIM (variants.cost / products.default_cost). Never touches the sale price.
app.post('/api/inventory/apply-cost', async (req, res) => {
  try {
    const { storeId, items } = req.body || {};
    if (!storeId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'storeId och items[] krävs' });
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad till Shopify' });
    const client = shopifySync.getClient(store);

    let updated = 0;
    const errors = [];
    for (const it of items) {
      const cost = Number(it.expectedCost);
      if (!it.inventoryItemId || !Number.isFinite(cost) || cost <= 0) continue;
      try {
        const m = await client.graphql(`mutation($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id unitCost { amount } } userErrors { field message } } }`,
          { id: it.inventoryItemId, input: { cost: cost.toFixed(2) } });
        const errs = m.inventoryItemUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
        updated++;
        // PIM keeps the supplier's per-unit price as cost.
        const unit = Number(it.supplierUnitCost);
        if (it.sku && Number.isFinite(unit) && unit > 0) {
          await supabase.from('variants').update({ cost: unit }).eq('sku', it.sku);
          await supabase.from('products').update({ default_cost: unit }).eq('store_id', storeId).eq('sku', it.sku);
        }
      } catch (e) {
        errors.push({ sku: it.sku, error: e.message });
      }
      await new Promise(r => setTimeout(r, 120)); // stay well under Shopify's rate limit
    }
    try {
      await db.logActivity('cost_fix', 'store', storeId,
        `Inköpspris rättat i Shopify för ${updated} artiklar från leverantörsfil${errors.length ? ` (${errors.length} misslyckades)` : ''}`,
        { skus: items.slice(0, 200).map(i => i.sku), errors: errors.slice(0, 20), by: currentUserLabel(req) }, storeId);
    } catch (_) {}
    res.json({ updated, failed: errors.length, errors });
  } catch (error) {
    console.error('apply-cost error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/inventory/create-products', async (req, res) => {
  try {
    const { storeId, products } = req.body;
    if (!storeId || !Array.isArray(products) || !products.length) {
      return res.status(400).json({ error: 'storeId och products[] krävs' });
    }
    const MAX = 500;
    if (products.length > MAX) {
      return res.status(413).json({ error: `Max ${MAX} produkter per körning (fick ${products.length})` });
    }

    const pricing = await db.getPricingSettings(storeId).catch(() => null);
    const defaultMargin = Number(pricing?.default_margin_multiplier) || 2.0;

    const created = [];
    const errors = [];

    for (const p of products) {
      const sku = String(p.sku || '').trim();
      try {
        if (!sku) { errors.push({ sku: p.sku, error: 'SKU saknas' }); continue; }

        const cost = p.cost != null && p.cost !== '' ? Number(p.cost) : null;
        const explicitPrice = p.price != null && p.price !== '' ? Number(p.price) : null;
        const price = explicitPrice != null
          ? explicitPrice
          : (cost != null ? Math.round(cost * defaultMargin) : null);

        // If the user set a price that differs from cost × default margin, store
        // the implied margin so the pricing engine reproduces it later.
        let marginOverride = null;
        if (cost && explicitPrice != null && Math.round(cost * defaultMargin) !== Math.round(explicitPrice)) {
          marginOverride = Number((explicitPrice / cost).toFixed(3));
        }

        const tags = Array.isArray(p.tags)
          ? p.tags
          : (p.tags ? String(p.tags).split(',').map(t => t.trim()).filter(Boolean) : []);

        // Metafields: the full object mapped from the file (material, kollektion,
        // storlek, etc.), plus size/colour fallbacks for older callers.
        const metafields = { ...(p.metafields && typeof p.metafields === 'object' ? p.metafields : {}) };
        if (p.size && String(p.size).trim() && !metafields['custom.storlek']) metafields['custom.storlek'] = String(p.size).trim();
        if (p.color && String(p.color).trim() && !metafields['custom.fargnyans']) metafields['custom.fargnyans'] = String(p.color).trim();

        const productData = sanitizeHtmlFields({
          title: String(p.title || sku),
          sku,
          barcode: p.barcode ? String(p.barcode) : null,
          product_type: p.product_type || null,
          tags,
          default_cost: cost,
          default_price: price,
          margin_multiplier: marginOverride,
          weight: p.weight != null && p.weight !== '' ? Number(p.weight) : null,
          metafields,
          status: 'draft',
          is_staged: true, // lands in the "Nya produkter" staging list, not the main catalogue
          store_id: storeId,
          variants: [{
            sku,
            barcode: p.barcode ? String(p.barcode) : null,
            price,
            cost,
            inventory_quantity: p.qty != null ? Number(p.qty) : 0,
          }],
          images: p.imageUrl
            ? [{ url: String(p.imageUrl).trim(), alt_text: String(p.title || sku) }]
            : [],
        });

        const createdProduct = await db.createProduct(productData);
        // Let the pricing engine set the canonical price (applies category rules etc.)
        try { await db.recomputeProductPrice(createdProduct.id, storeId); } catch (_) {}
        created.push({ id: createdProduct.id, sku });
      } catch (err) {
        errors.push({ sku, error: err.message });
      }
    }

    res.json({ created: created.length, failed: errors.length, errors, ids: created });
  } catch (error) {
    console.error('Create products error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/db/products/merge
// Merge several PIM products into ONE product with variants (e.g. same item in
// different sizes). Each source product becomes a variant; the size (from
// custom.storlek) is pre-filled as the variant option. Only for draft products
// not yet in Shopify. Body: { productIds: [...], title?, optionName? }
app.post('/api/db/products/merge', async (req, res) => {
  try {
    const { productIds, title, optionName } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length < 2) {
      return res.status(400).json({ error: 'Minst 2 produkter krävs för att slå ihop' });
    }
    const optName = (optionName || 'Storlek').trim();

    // Load full products (with variants, metafields, images).
    const products = [];
    for (const id of productIds) {
      const p = await db.getProductById(id);
      if (p) products.push(p);
    }
    if (products.length < 2) return res.status(400).json({ error: 'Produkterna hittades inte' });

    // Refuse if any is already linked to Shopify (merging live products is unsafe).
    const { data: links } = await supabase
      .from('store_products').select('product_id, shopify_product_id')
      .in('product_id', productIds).not('shopify_product_id', 'is', null);
    if (links && links.length) {
      return res.status(400).json({ error: 'Kan inte slå ihop produkter som redan finns i Shopify. Slå bara ihop utkast.' });
    }

    const primary = products[0];
    const storeId = primary.store_id;

    // Suggested common title: primary title with a trailing size code stripped
    // ("ROMANCE Vas M, Klar" -> "ROMANCE Vas, Klar").
    const deriveTitle = (t) => {
      const [base, color] = (String(t || '').split(/,(.*)/s).slice(0, 2));
      const stripped = base.replace(/\s+(XXS|XS|S|M|L|XL|XXL|XXXL)\s*$/i, '').trim();
      return color != null ? `${stripped},${color}` : stripped;
    };
    const finalTitle = (title && title.trim()) || deriveTitle(primary.title);

    // Build merged variants: one per source product, size as the option value.
    const mergedVariants = [];
    for (const p of products) {
      const v = (p.variants && p.variants[0]) || {};
      const size = p.metafields?.['custom.storlek'] || v.option1_value || '';
      mergedVariants.push({
        sku: v.sku || p.sku || '',
        barcode: v.barcode || p.barcode || null,
        price: v.price ?? p.default_price ?? null,
        compare_at_price: v.compare_at_price ?? null,
        cost: v.cost ?? p.default_cost ?? null,
        inventory_quantity: v.inventory_quantity ?? 0,
        weight: v.weight ?? p.weight ?? null,
        option1_name: optName,
        option1_value: String(size) || p.title,
      });
    }

    // Merged metafields: keep the primary's, but drop custom.storlek (now per-variant).
    const mergedMetafields = { ...(primary.metafields || {}) };
    delete mergedMetafields['custom.storlek'];

    // Merged images: combine all, dedupe by url.
    const seenUrls = new Set();
    const mergedImages = [];
    for (const p of products) {
      for (const img of (p.images || [])) {
        const url = img.url;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        mergedImages.push({ url, alt_text: img.alt_text || finalTitle, position: mergedImages.length + 1 });
      }
    }

    // Update the primary product in place: title + metafields.
    await supabase.from('products').update({
      title: finalTitle,
      metafields: mergedMetafields,
      status: 'draft',
    }).eq('id', primary.id);

    // Replace the primary's variants with the merged set.
    await supabase.from('variants').delete().eq('product_id', primary.id);
    await supabase.from('variants').insert(
      mergedVariants.map((v, i) => ({ ...v, product_id: primary.id, position: i + 1 }))
    );

    // Replace the primary's images with the combined set.
    await supabase.from('images').delete().eq('product_id', primary.id);
    if (mergedImages.length) {
      await supabase.from('images').insert(mergedImages.map(im => ({ ...im, product_id: primary.id })));
    }

    // Delete the absorbed products (variants/images/links cascade).
    const absorbed = products.slice(1).map(p => p.id);
    if (absorbed.length) {
      await supabase.from('products').delete().in('id', absorbed);
    }

    const merged = await db.getProductById(primary.id);
    res.json({ mergedInto: primary.id, absorbed: absorbed.length, variants: mergedVariants.length, product: merged });
  } catch (error) {
    console.error('Merge products error:', error);
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
// SEO & INSIGHTS (Google Search Console + GA4)
// Native integration via a Google service account. Property/site config lives
// in store.settings.google; the service-account key is a server secret.
// ============================================

// YYYY-MM-DD for `days` ago (or today when days=0). Avoids timezone drift.
function ymdDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function seoRange(req) {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 28));
  return { days, startDate: ymdDaysAgo(days), endDate: ymdDaysAgo(1) };
}
async function seoConfig(req) {
  const storeId = await resolveStoreId(req);
  const store = storeId ? await db.getStoreById(storeId) : null;
  const g = store?.settings?.google || {};
  return { storeId, store, siteUrl: g.gsc_site_url || null, propertyId: g.ga4_property_id || null, merchantId: g.merchant_id || null };
}

// Connection status: is the service account present + what is configured.
app.get('/api/seo/status', async (req, res) => {
  try {
    const { store, siteUrl, propertyId, merchantId } = await seoConfig(req);
    let email = null;
    try { email = googleSeo.getServiceAccount()?.client_email || null; } catch (_) {}
    res.json({
      credentials: googleSeo.isConfigured(),
      serviceAccountEmail: email,
      gscSiteUrl: siteUrl,
      ga4PropertyId: propertyId,
      merchantId: merchantId,
      storeConnected: !!store,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save GSC site url + GA4 property id to store.settings.google.
app.post('/api/seo/config', async (req, res) => {
  try {
    const storeId = await resolveStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Ingen butik' });
    const store = await db.getStoreById(storeId);
    const { gscSiteUrl, ga4PropertyId, merchantId } = req.body || {};
    const google = {
      ...(store.settings?.google || {}),
      ...(gscSiteUrl !== undefined ? { gsc_site_url: gscSiteUrl || null } : {}),
      ...(ga4PropertyId !== undefined ? { ga4_property_id: ga4PropertyId || null } : {}),
      ...(merchantId !== undefined ? { merchant_id: merchantId || null } : {}),
    };
    const { error } = await supabase.from('stores')
      .update({ settings: { ...(store.settings || {}), google } }).eq('id', storeId);
    if (error) throw error;
    res.json({ ok: true, google });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List GSC sites the service account can see (to pick the exact siteUrl).
app.get('/api/seo/gsc/sites', async (req, res) => {
  try { res.json({ sites: await googleSeo.gscListSites() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Merchant Center: account-level issues + product feed problems, grouped by
// issue type so they read as an actionable to-fix list.
// Fetch account + product statuses from Merchant Center and group product
// issues by code (severity first, then count). Cached 30 min per merchant so
// the dashboard and the SEO tab don't page through the whole feed on every load.
const _merchantCache = new Map(); // merchantId -> { at, data }
const fetchMerchantSummary = async (merchantId, { force = false } = {}) => {
  const hit = _merchantCache.get(merchantId);
  if (!force && hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;

  const [account, productStatuses] = await Promise.all([
    googleSeo.merchantAccountStatus({ merchantId }).catch(e => ({ error: e.message })),
    googleSeo.merchantProductStatuses({ merchantId }),
  ]);
  const byCode = new Map();
  let withIssues = 0, disapproved = 0;
  for (const p of productStatuses) {
    if (p.issues.length) withIssues++;
    if (p.issues.some(i => i.servability === 'disapproved')) disapproved++;
    for (const i of p.issues) {
      if (!byCode.has(i.code)) {
        byCode.set(i.code, {
          code: i.code, description: i.description, servability: i.servability,
          resolution: i.resolution, documentation: i.documentation,
          attributeName: i.attributeName, count: 0, samples: [],
        });
      }
      const g = byCode.get(i.code);
      g.count++;
      if (g.samples.length < 8) g.samples.push({ productId: p.productId, title: p.title, link: p.link });
    }
  }
  const rank = s => (s === 'disapproved' ? 0 : s === 'demoted' ? 1 : 2);
  const groups = [...byCode.values()].sort((a, b) => rank(a.servability) - rank(b.servability) || b.count - a.count);
  const data = {
    fetchedAt: new Date().toISOString(),
    account: account?.error ? { error: account.error } : {
      accountId: account.accountId,
      websiteClaimed: account.websiteClaimed,
      accountLevelIssues: account.accountLevelIssues,
    },
    products: { total: productStatuses.length, withIssues, disapproved, byIssue: groups },
  };
  _merchantCache.set(merchantId, { at: Date.now(), data });
  return data;
};

app.get('/api/seo/merchant/issues', async (req, res) => {
  try {
    const { merchantId } = await seoConfig(req);
    if (!merchantId) return res.status(400).json({ error: 'Merchant Center account-id ej konfigurerat' });
    res.json(await fetchMerchantSummary(merchantId, { force: req.query.refresh === '1' }));
  } catch (e) {
    console.error('Merchant issues error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// PRISBEVAKNING (price watch)
// Merchant Center price benchmark vs our price → status per offer.
// Read-only towards Shopify: nothing here ever writes a price.
// ============================================
const priceWatchStore = async (req) => {
  const storeId = await resolveStoreId(req);
  const store = storeId ? await db.getStoreById(storeId) : null;
  if (!store) throw new Error('Ingen butik vald');
  return store;
};
const currentUserLabel = (req) => req.user?.email || req.user?.username || req.user?.name || req.user?.id || 'okänd';
const PRICE_WATCH_HOUR = process.env.PRICE_WATCH_HOUR === 'off' ? null
  : (Number.isFinite(Number(process.env.PRICE_WATCH_HOUR)) && process.env.PRICE_WATCH_HOUR !== '' ? Number(process.env.PRICE_WATCH_HOUR) : 4);

app.get('/api/price-watch/status', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    let email = null;
    try { email = googleSeo.getServiceAccount()?.client_email || null; } catch (_) {}
    const summary = await priceWatch.summary(store.id);
    res.json({
      credentials: googleSeo.isConfigured(),
      serviceAccountEmail: email,
      merchantId: store.settings?.google?.merchant_id || null,
      settings: priceWatch.getSettings(store),
      scheduleHour: PRICE_WATCH_HOUR,
      ...summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save Merchant id (shared with SEO & Insikter) and/or price-watch thresholds.
app.post('/api/price-watch/config', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const { merchantId, settings } = req.body || {};
    const next = { ...(store.settings || {}) };
    if (merchantId !== undefined) next.google = { ...(next.google || {}), merchant_id: merchantId ? String(merchantId).replace(/[^0-9]/g, '') || null : null };
    if (settings && typeof settings === 'object') next.price_watch = { ...(next.price_watch || {}), ...priceWatch.sanitizeSettings(settings) };
    const { error } = await supabase.from('stores').update({ settings: next }).eq('id', store.id);
    if (error) throw error;
    res.json({ ok: true, merchantId: next.google?.merchant_id || null, settings: priceWatch.getSettings({ settings: next }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time: register the service account's GCP project with the Merchant
// Center account (Merchant API refuses calls until this is done).
app.post('/api/price-watch/register-gcp', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const merchantId = store.settings?.google?.merchant_id;
    if (!merchantId) return res.status(400).json({ error: 'Merchant Center account-id ej konfigurerat' });
    const developerEmail = String(req.body?.developerEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(developerEmail)) return res.status(400).json({ error: 'Ange en giltig e-postadress (en användare på Merchant Center-kontot)' });
    const result = await googleSeo.merchantRegisterGcp({ merchantId, developerEmail });
    res.json({ ok: true, registration: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/price-watch/register-gcp', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const merchantId = store.settings?.google?.merchant_id;
    if (!merchantId) return res.status(400).json({ error: 'Merchant Center account-id ej konfigurerat' });
    res.json({ ok: true, registration: await googleSeo.merchantDeveloperRegistration({ merchantId }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily fetch on serverless hosts (Vercel Cron, see vercel.json "crons").
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET env
// var is set on the project. No session — guarded by the secret only.
const cronAuthorized = (req) => {
  const secret = process.env.CRON_SECRET || '';
  const auth = String(req.headers.authorization || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query.secret || '');
  return secret.length > 0 && provided.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
};

// Daily Shopify → PIM pull for serverless hosts (the SHOPIFY_PULL_MINUTES
// poll never fires on Vercel). Imports new Shopify products into staging,
// pulls content changes and collections. Pull-only: never writes to Shopify.
app.get('/api/cron/shopify-pull', async (req, res) => {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!isDbConfigured()) return res.status(503).json({ error: 'Databas ej konfigurerad' });
  // Vercel kills the function at maxDuration (60s), which used to truncate the
  // import mid-loop (~40 products/night). Budget the time instead: the import
  // stops cleanly, and the content/collection pulls only run when time remains
  // — they get their turn on nights without an import backlog.
  const startedAt = Date.now();
  const deadlineMs = startedAt + 40_000;
  const results = [];
  for (const store of (await db.getStores()) || []) {
    if (!store.access_token) continue;
    const r = { store: store.name };
    try { r.newProducts = await importNewProductsFromShopify(store, { deadlineMs }); } catch (e) { r.newProductsError = e.message; }
    if (Date.now() < deadlineMs) {
      try { r.pull = await pullAllFromShopify(store); } catch (e) { r.pullError = e.message; }
    } else r.pullSkipped = 'tidsbudget slut';
    if (Date.now() < deadlineMs + 5_000) {
      try { r.collections = await pullCollectionsFromShopify(store); } catch (e) { r.collectionsError = e.message; }
    } else r.collectionsSkipped = 'tidsbudget slut';
    r.elapsedMs = Date.now() - startedAt;
    console.log(`🔄 Cron Shopify→PIM ${store.name}:`, JSON.stringify(r));
    results.push(r);
  }
  res.json({ ok: true, results });
});

app.get('/api/price-watch/cron', async (req, res) => {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!isDbConfigured()) return res.status(503).json({ error: 'Databas ej konfigurerad' });
  if (!googleSeo.isConfigured()) return res.status(400).json({ error: 'Google service-account saknas' });
  const results = [];
  for (const store of (await db.getStores()) || []) {
    if (!store.settings?.google?.merchant_id) continue;
    try { results.push({ store: store.name, ...(await priceWatch.runFetch({ store, trigger: 'scheduled' })) }); }
    catch (e) { console.error(`Prisbevakning (cron) misslyckades för ${store.name}:`, e.message); results.push({ store: store.name, error: e.message }); }
  }
  res.json({ ok: true, results });
});

// Fetch benchmarks now (same job as the nightly run).
app.post('/api/price-watch/fetch', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    if (!googleSeo.isConfigured()) return res.status(400).json({ error: 'Google service-account saknas (GOOGLE_SERVICE_ACCOUNT_JSON)' });
    res.json(await priceWatch.runFetch({ store, trigger: 'manual' }));
  } catch (e) {
    console.error('Price watch fetch error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/price-watch/items', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const { status, open, q, sort, limit } = req.query;
    const items = await priceWatch.listItems({ storeId: store.id, status, open: open === '1' || open === 'true', q, sort, limit });
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Benchmark rows for one product (shown in the product popup).
app.get('/api/price-watch/product/:productId', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const product = await db.getProductById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const skus = [product.sku, ...(product.variants || []).map(v => v.sku)];
    const rows = await priceWatch.productRows({ storeId: store.id, productId: product.id, skus });
    res.json({ rows, settings: priceWatch.getSettings(store), merchantConfigured: !!store.settings?.google?.merchant_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual price change from the product popup. This is the ONLY place in the
// price-watch area that writes a price, and it only happens on an explicit
// click: Shopify variant price → PIM variant/product price → benchmark row.
app.post('/api/price-watch/set-price', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const { productId, sku, compareAtPrice, note } = req.body || {};
    const price = Math.round(Number(req.body?.price));
    if (!productId) return res.status(400).json({ error: 'productId saknas' });
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Ange ett pris i hela kronor' });
    const cmp = compareAtPrice === undefined ? undefined : (compareAtPrice === null || compareAtPrice === '' ? null : Math.round(Number(compareAtPrice)));
    if (cmp !== undefined && cmp !== null && (!Number.isFinite(cmp) || cmp <= price)) return res.status(400).json({ error: 'Jämförpriset måste vara högre än priset (eller tomt)' });

    const product = await db.getProductById(productId);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const { data: link } = await supabase.from('store_products').select('shopify_product_id')
      .eq('store_id', store.id).eq('product_id', productId).maybeSingle();
    const shopifyProductId = link?.shopify_product_id || product.shopify_product_id;
    if (!shopifyProductId) return res.status(400).json({ error: 'Produkten är inte kopplad till Shopify' });

    const client = shopifySync.getClient(store);
    const gid = `gid://shopify/Product/${shopifyProductId}`;
    const d = await client.graphql(`query($id: ID!) { product(id: $id) { id title variants(first: 100) { nodes { id sku price compareAtPrice title } } } }`, { id: gid });
    const variants = d.product?.variants?.nodes || [];
    if (!variants.length) return res.status(400).json({ error: 'Hittar inga varianter i Shopify' });
    const wanted = String(sku || '').trim();
    const targets = wanted ? variants.filter(v => String(v.sku || '').trim() === wanted) : (variants.length === 1 ? variants : []);
    if (!targets.length) return res.status(400).json({ error: wanted ? `Varianten ${wanted} finns inte i Shopify` : 'Produkten har flera varianter – ange vilken (SKU)' });

    const m = await client.graphql(`mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $pid, variants: $v) { productVariants { id sku price compareAtPrice } userErrors { field message } } }`,
      { pid: gid, v: targets.map(v => ({ id: v.id, price: price.toFixed(2), ...(cmp !== undefined ? { compareAtPrice: cmp === null ? null : cmp.toFixed(2) } : {}) })) });
    const errs = m.productVariantsBulkUpdate?.userErrors || [];
    if (errs.length) return res.status(400).json({ error: `Shopify: ${errs.map(e => e.message).join('; ')}` });

    // Mirror into PIM so the popup and the catalogue agree with Shopify.
    const targetSkus = targets.map(v => String(v.sku || '').trim()).filter(Boolean);
    const pimPatch = { price, ...(cmp !== undefined ? { compare_at_price: cmp } : {}) };
    if (targetSkus.length) await supabase.from('variants').update(pimPatch).eq('product_id', productId).in('sku', targetSkus);
    if (targets.length === variants.length) {
      await supabase.from('products').update({ default_price: price, ...(cmp !== undefined ? { default_compare_at_price: cmp } : {}) }).eq('id', productId);
    }

    // Recompute the benchmark rows for these variants.
    const rows = await priceWatch.productRows({ storeId: store.id, productId, skus: targetSkus });
    const targetIds = new Set(targets.map(v => v.id.split('/').pop()));
    const affected = rows.filter(r => targetSkus.includes(String(r.sku || '').trim()) || [...targetIds].some(id => String(r.offer_id).endsWith(`_${id}`)));
    const updatedRows = await priceWatch.applyPriceChange({ storeId: store.id, rowIds: affected.map(r => r.id), price, settings: priceWatch.getSettings(store) });

    const from = targets.map(v => Number(v.price));
    try {
      await db.logActivity('price_change', 'product', productId,
        `Pris ändrat ${from.join('/')} → ${price} kr på ${product.title}${targetSkus.length ? ` (${targetSkus.join(', ')})` : ''}${note ? ` – ${note}` : ''}`,
        { from, to: price, compareAtPrice: cmp, skus: targetSkus, by: currentUserLabel(req), note: note || null });
    } catch (_) {}

    res.json({ ok: true, price, compareAtPrice: cmp, updated: targets.map((v, i) => ({ sku: v.sku, from: from[i], to: price })), rows: updatedRows });
  } catch (e) {
    console.error('set-price error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/price-watch/runs', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    res.json({ runs: await priceWatch.listRuns(store.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Acknowledge: the alert stays silent until the benchmark moves > ack_threshold.
app.post('/api/price-watch/items/:id/ack', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    res.json(await priceWatch.acknowledge({ storeId: store.id, id: req.params.id, user: currentUserLabel(req), note: req.body?.note }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/price-watch/items/:id/ack', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    res.json(await priceWatch.unacknowledge({ storeId: store.id, id: req.params.id, user: currentUserLabel(req) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/price-watch/export.csv', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const csv = await priceWatch.exportCsv(store.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prisbevakning-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import pack_qty (Affari "Förpackningsantal dropship") from an xlsx/csv export.
app.post('/api/price-watch/pack-import', upload.single('file'), async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    if (!req.file) return res.status(400).json({ error: 'Ingen fil' });
    const name = (req.file.originalname || '').toLowerCase();
    let parsed;
    if (name.endsWith('.csv')) {
      if (!parseCsvBuffer) ({ parseCsvBuffer } = await import('./services/csv-parser.js'));
      parsed = await parseCsvBuffer(req.file.buffer, {});
    } else {
      if (!parseExcelBuffer) ({ parseExcelBuffer } = await import('./services/excel-parser.js'));
      parsed = await parseExcelBuffer(req.file.buffer, {});
    }
    res.json(await priceWatch.importPackQty({ storeId: store.id, rows: parsed.rows }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Top search queries (clicks/impressions/ctr/position).
app.get('/api/seo/gsc/queries', async (req, res) => {
  try {
    const { siteUrl } = await seoConfig(req);
    if (!siteUrl) return res.status(400).json({ error: 'GSC-webbadress ej konfigurerad' });
    const { startDate, endDate } = seoRange(req);
    const rows = await googleSeo.gscSearchAnalytics({
      siteUrl, startDate, endDate, dimensions: ['query'],
      rowLimit: Math.min(500, parseInt(req.query.limit) || 200),
    });
    res.json({ rows, startDate, endDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Top pages by search performance.
app.get('/api/seo/gsc/pages', async (req, res) => {
  try {
    const { siteUrl } = await seoConfig(req);
    if (!siteUrl) return res.status(400).json({ error: 'GSC-webbadress ej konfigurerad' });
    const { startDate, endDate } = seoRange(req);
    const rows = await googleSeo.gscSearchAnalytics({
      siteUrl, startDate, endDate, dimensions: ['page'],
      rowLimit: Math.min(500, parseInt(req.query.limit) || 200),
    });
    res.json({ rows, startDate, endDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GA4 summary metrics for the period.
app.get('/api/seo/ga4/summary', async (req, res) => {
  try {
    const { propertyId } = await seoConfig(req);
    if (!propertyId) return res.status(400).json({ error: 'GA4 property ej konfigurerad' });
    const { startDate, endDate } = seoRange(req);
    const { rows } = await googleSeo.ga4RunReport({
      propertyId, startDate, endDate, dimensions: [],
      metrics: ['sessions', 'totalUsers', 'screenPageViews', 'conversions', 'averageSessionDuration', 'bounceRate'],
    });
    res.json({ metrics: rows[0] || {}, startDate, endDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GA4 top landing pages (organic-relevant) by sessions.
app.get('/api/seo/ga4/landing-pages', async (req, res) => {
  try {
    const { propertyId } = await seoConfig(req);
    if (!propertyId) return res.status(400).json({ error: 'GA4 property ej konfigurerad' });
    const { startDate, endDate } = seoRange(req);
    const { rows } = await googleSeo.ga4RunReport({
      propertyId, startDate, endDate, dimensions: ['landingPagePlusQueryString'],
      metrics: ['sessions', 'conversions'], limit: Math.min(500, parseInt(req.query.limit) || 100),
      orderByMetric: 'sessions',
    });
    res.json({ rows, startDate, endDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// SEO OPPORTUNITIES (catalog health + AI suggestions)
// Works without Google: analyses the PIM catalogue for gaps and asks Claude for
// topical-authority article ideas. Enriched later by GSC/GA4 data.
// ============================================

const CORE_ATTR_KEYS = ['custom.material', 'custom.fargnyans', 'custom.storlek', 'custom.kollektion'];
const stripHtmlLen = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length;

// Catalogue health: which live products lack category, attributes, description,
// SEO fields or images. Shared by the SEO tab and the dashboard.
const computeCatalogueHealth = (products, cap = 300) => {
  const buckets = {
    missingCategory: [], thinAttributes: [], missingDescription: [],
    missingSeoTitle: [], missingSeoDescription: [], noImages: [],
  };
  const slim = (p) => ({ id: p.id, title: p.title, sku: p.sku, product_type: p.product_type });
  for (const p of products) {
    const mfKeys = p.metafields && typeof p.metafields === 'object' ? Object.keys(p.metafields) : [];
    const coreAttrs = mfKeys.filter(k => CORE_ATTR_KEYS.includes(k)).length;
    if (!p.product_category) buckets.missingCategory.push(slim(p));
    if (coreAttrs < 2) buckets.thinAttributes.push(slim(p));
    if (stripHtmlLen(p.description) < 60) buckets.missingDescription.push(slim(p));
    if (!p.seo_title) buckets.missingSeoTitle.push(slim(p));
    if (!p.seo_description) buckets.missingSeoDescription.push(slim(p));
    if (!(p.images?.length > 0)) buckets.noImages.push(slim(p));
  }
  const summarise = (arr) => ({ count: arr.length, items: arr.slice(0, cap) });
  return {
    totalProducts: products.length,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, summarise(v)])),
  };
};

app.get('/api/seo/opportunities', async (req, res) => {
  try {
    const storeId = await resolveStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Ingen butik' });
    const { data } = await db.getProducts({ storeId, limit: 20000 });
    res.json(computeCatalogueHealth(data || []));
  } catch (e) {
    console.error('SEO opportunities error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// DASHBOARD ("kontrollrum") — one call that gathers what needs attention.
// Read-only. Every block is fetched independently so one failure doesn't
// blank the page.
// ============================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    const storeId = store.id;
    const safe = (p) => p.catch(e => ({ error: e.message }));
    const countWhere = (table, apply) => safe((async () => {
      const { count, error } = await apply(supabase.from(table).select('*', { count: 'exact', head: true }));
      if (error) throw error;
      return count || 0;
    })());

    const [pw, openItems, underFloor, unmatched, health, active, draft, staged, syncErrorCount, queuePending, activity] = await Promise.all([
      safe(priceWatch.summary(storeId)),
      safe(priceWatch.listItems({ storeId, open: true, limit: 400 })),
      safe(priceWatch.underFloor({ storeId, limit: 8 })),
      countWhere('price_benchmarks', q => q.eq('store_id', storeId).is('product_id', null)),
      safe(db.getProducts({ storeId, limit: 20000 }).then(r => computeCatalogueHealth(r.data || [], 0))),
      countWhere('products', q => q.eq('store_id', storeId).eq('status', 'active').or('is_staged.is.null,is_staged.eq.false')),
      countWhere('products', q => q.eq('store_id', storeId).eq('status', 'draft').or('is_staged.is.null,is_staged.eq.false')),
      countWhere('products', q => q.eq('store_id', storeId).eq('is_staged', true)),
      countWhere('store_products', q => q.eq('store_id', storeId).eq('sync_status', 'error')),
      countWhere('sync_queue', q => q.eq('store_id', storeId).in('status', ['pending', 'processing'])),
      safe((async () => {
        const { data, error } = await supabase.from('activity_log').select('action, entity_type, entity_id, description, created_at')
          .or(`store_id.eq.${storeId},store_id.is.null`).order('created_at', { ascending: false }).limit(8);
        if (error) throw error;
        return data || [];
      })()),
    ]);

    const g = store.settings?.google || {};
    res.json({
      store: { name: store.name, domain: store.custom_domain || store.domain },
      priceWatch: {
        ...(pw.error ? { error: pw.error } : pw),
        topOpen: Array.isArray(openItems) ? openItems.slice(0, 6) : [],
        underFloor: Array.isArray(underFloor) ? underFloor : [],
        unmatched: typeof unmatched === 'number' ? unmatched : 0,
      },
      catalogue: {
        active: typeof active === 'number' ? active : null,
        draft: typeof draft === 'number' ? draft : null,
        staged: typeof staged === 'number' ? staged : null,
        health: health?.error ? { error: health.error } : health,
      },
      sync: {
        errors: typeof syncErrorCount === 'number' ? syncErrorCount : null,
        queued: typeof queuePending === 'number' ? queuePending : null,
      },
      activity: Array.isArray(activity) ? activity : [],
      connections: {
        shopify: !!store.access_token,
        googleServiceAccount: googleSeo.isConfigured(),
        merchantCenter: !!g.merchant_id,
        searchConsole: !!g.gsc_site_url,
        ga4: !!g.ga4_property_id,
        cronSecret: !!process.env.CRON_SECRET,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        serverless: !!process.env.VERCEL,
      },
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Dashboard blocks that call external APIs load separately so the core page
// renders at once. All read-only.

// Sales (Shopify orders, last 30 days) + push per-SKU units onto price
// benchmarks so price alerts can rank by impact.
app.get('/api/dashboard/sales', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    if (!store.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad till Shopify' });
    const sales = await shopifySales.getSales(store, { days: 30, force: req.query.refresh === '1' });
    priceWatch.applySales(store.id, sales.bySku).catch(e => console.error('applySales:', e.message));
    const { bySku, ...rest } = sales;
    res.json(rest);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merchant Center: disapprovals + top issue groups (Merchant API, cached).
app.get('/api/dashboard/merchant', async (req, res) => {
  try {
    const { merchantId } = await seoConfig(req);
    if (!googleSeo.isConfigured()) return res.json({ notConfigured: 'service-account' });
    if (!merchantId) return res.json({ notConfigured: 'merchant-id' });
    const m = await fetchMerchantSummary(merchantId, { force: req.query.refresh === '1' });
    res.json({
      fetchedAt: m.fetchedAt,
      account: m.account,
      total: m.products.total, withIssues: m.products.withIssues, disapproved: m.products.disapproved,
      topIssues: m.products.byIssue.slice(0, 5).map(g => ({ code: g.code, description: g.description, servability: g.servability, count: g.count, attributeName: g.attributeName })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search Console + GA4: last 28 days vs the 28 before.
const _googleCache = new Map();
app.get('/api/dashboard/google', async (req, res) => {
  try {
    const { storeId, siteUrl, propertyId } = await seoConfig(req);
    if (!googleSeo.isConfigured()) return res.json({ notConfigured: 'service-account' });
    if (!siteUrl && !propertyId) return res.json({ notConfigured: 'properties' });
    const key = `${storeId}:${siteUrl}:${propertyId}`;
    const hit = _googleCache.get(key);
    if (req.query.refresh !== '1' && hit && Date.now() - hit.at < 30 * 60 * 1000) return res.json(hit.data);

    const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const out = { fetchedAt: new Date().toISOString(), gsc: null, ga4: null };
    if (siteUrl) {
      try {
        const [cur, prev] = await Promise.all([
          googleSeo.gscSearchAnalytics({ siteUrl, startDate: ymdDaysAgo(28), endDate: ymdDaysAgo(1), dimensions: ['date'], rowLimit: 100 }),
          googleSeo.gscSearchAnalytics({ siteUrl, startDate: ymdDaysAgo(56), endDate: ymdDaysAgo(29), dimensions: ['date'], rowLimit: 100 }),
        ]);
        out.gsc = { clicks: sum(cur, 'clicks'), impressions: sum(cur, 'impressions'), prevClicks: sum(prev, 'clicks'), prevImpressions: sum(prev, 'impressions') };
      } catch (e) { out.gsc = { error: e.message }; }
    }
    if (propertyId) {
      try {
        const metrics = ['sessions', 'ecommercePurchases', 'purchaseRevenue'];
        const [cur, prev] = await Promise.all([
          googleSeo.ga4RunReport({ propertyId, startDate: '28daysAgo', endDate: 'yesterday', metrics }),
          googleSeo.ga4RunReport({ propertyId, startDate: '56daysAgo', endDate: '29daysAgo', metrics }),
        ]);
        const c = cur.rows[0] || {}, p = prev.rows[0] || {};
        out.ga4 = { sessions: c.sessions || 0, purchases: c.ecommercePurchases || 0, revenue: Math.round(c.purchaseRevenue || 0), prevSessions: p.sessions || 0, prevPurchases: p.ecommercePurchases || 0, prevRevenue: Math.round(p.purchaseRevenue || 0) };
      } catch (e) { out.ga4 = { error: e.message }; }
    }
    _googleCache.set(key, { at: Date.now(), data: out });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supplier (Affari) snapshot vs live catalogue.
app.get('/api/dashboard/supplier', async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    res.json(await supplierFile.supplierReport(store.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload Affari's Dropship.csv (stock/price) or ExcelExportGeneral (pack_qty).
app.post('/api/supplier/import', upload.single('file'), async (req, res) => {
  try {
    const store = await priceWatchStore(req);
    if (!req.file) return res.status(400).json({ error: 'Ingen fil' });
    const name = req.file.originalname || 'fil';
    let parsed;
    if (name.toLowerCase().endsWith('.csv')) {
      if (!parseCsvBuffer) ({ parseCsvBuffer } = await import('./services/csv-parser.js'));
      parsed = await parseCsvBuffer(req.file.buffer, {});
    } else {
      if (!parseExcelBuffer) ({ parseExcelBuffer } = await import('./services/excel-parser.js'));
      parsed = await parseExcelBuffer(req.file.buffer, {});
    }
    const result = await supplierFile.importSupplierFile({ storeId: store.id, rows: parsed.rows, filename: name });
    try { await db.logActivity('supplier_import', 'store', store.id, `Leverantörsfil importerad: ${name} (${result.imported} artiklar${result.type === 'export' ? ', förpackningsantal' : ''})`, { type: result.type, rows: result.rows }); } catch (_) {}
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI article ideas for topical authority, derived from the catalogue's own
// product types + categories (so the topics map to what the store actually sells).
app.post('/api/seo/suggest-articles', async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'API key not configured' });
    const storeId = await resolveStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Ingen butik' });
    const { data } = await db.getProducts({ storeId, limit: 20000 });
    const products = data || [];

    // Aggregate the catalogue's shape: top product types + category leaves.
    const typeCount = {}, catCount = {};
    for (const p of products) {
      if (p.product_type) typeCount[p.product_type] = (typeCount[p.product_type] || 0) + 1;
      if (p.product_category) {
        const leaf = String(p.product_category).split('>').pop().trim();
        if (leaf) catCount[leaf] = (catCount[leaf] || 0) + 1;
      }
    }
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);
    const topTypes = top(typeCount, 30);
    const topCats = top(catCount, 20);
    const focus = String(req.body?.focus || '').trim();

    const prompt = `Du är SEO- och content-strateg för en svensk e-handel som säljer heminredning (dropshipping). Målet är topical authority + AEO (svar som AI-motorer plockar upp).

Butikens sortiment (produkttyper med antal):
${topTypes.join(', ') || '(okänt)'}
${topCats.length ? `\nVanliga kategorier: ${topCats.join(', ')}` : ''}
${focus ? `\nExtra fokus: ${focus}` : ''}

Föreslå 12 artiklar som bygger topical authority runt detta sortiment. Blanda: köpguider, "hur väljer man"-guider, stil-/inspirationsartiklar, skötselråd, säsong/högtid och FAQ-artiklar. Varje artikel ska kunna länka till relevanta produktkategorier internt.

Svara ENBART med giltig JSON:
{"clusters":[{"cluster":"temaområde","articles":[{"title":"...","type":"guide|inspiration|skötsel|säsong|FAQ|jämförelse","angle":"kort vinkel/varför den bygger auktoritet","keywords":["sökord","..."]}]}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let clusters = [];
    if (jsonMatch) { try { clusters = JSON.parse(jsonMatch[0]).clusters || []; } catch { clusters = []; } }
    res.json({ clusters, basedOn: { productTypes: topTypes.length, products: products.length } });
  } catch (e) {
    console.error('Suggest articles error:', e);
    const msg = e.status === 529 ? 'Claude API är överbelastad. Försök igen.' : e.message;
    res.status(500).json({ error: msg });
  }
});

// AI category paths for a batch of products (used to bulk-fill missing Shopify
// categories). Returns an English taxonomy path per SKU; the client matches it
// to the exact node id and applies it.
app.post('/api/seo/suggest-categories', async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'API key not configured' });
    const { products } = req.body || {};
    const MAX = 40;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'products krävs' });
    if (products.length > MAX) return res.status(413).json({ error: `Max ${MAX} produkter per anrop` });

    const list = products.map((p, i) => `${i + 1}. SKU ${String(p.sku || '').trim()}: ${String(p.title || '').trim()}${p.product_type ? ` (typ: ${p.product_type})` : ''}`).join('\n');
    const prompt = `Du klassificerar heminredningsprodukter mot Shopifys standardtaxonomi. För varje produkt, ge den mest passande kategorin som en ENGELSK taxonomisökväg, t.ex. "Home & Garden > Decor > Vases" eller "Home & Garden > Kitchen & Dining > Tableware > Dinnerware". Var så specifik som möjligt (använd lövnivån).

Produkter:
${list}

Svara ENBART med giltig JSON i samma ordning:
{"suggestions":[{"sku":"...","category":"Home & Garden > ..."}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let suggestions = [];
    if (jsonMatch) { try { suggestions = JSON.parse(jsonMatch[0]).suggestions || []; } catch { suggestions = []; } }
    suggestions = suggestions.map(s => ({ sku: String(s.sku || '').trim(), category: String(s.category || '').trim() }));
    res.json({ suggestions });
  } catch (e) {
    console.error('Suggest categories error:', e);
    const msg = e.status === 529 ? 'Claude API är överbelastad. Försök igen.' : e.message;
    res.status(500).json({ error: msg });
  }
});

// List the store's blogs so the UI can pick where to publish drafts.
app.get('/api/seo/blogs', async (req, res) => {
  try {
    const storeId = await resolveStoreId(req);
    const store = storeId ? await db.getStoreById(storeId) : null;
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad' });
    res.json({ blogs: await shopifySync.getBlogs(store) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Never let an em dash through (store style rule).
const noEmDash = (s) => String(s || '').replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ' - ');

// Generate a full article with Claude, in the store's tone and grounded in the
// catalogue, with internal links + FAQ (AEO), and create it as a DRAFT in Shopify.
app.post('/api/seo/generate-article', async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'API key not configured' });
    const storeId = await resolveStoreId(req);
    const store = storeId ? await db.getStoreById(storeId) : null;
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken är inte kopplad' });

    const { title, type, angle, keywords = [], blogId: reqBlogId } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title krävs' });

    // Resolve target blog (default: first).
    const blogs = await shopifySync.getBlogs(store);
    if (!blogs.length) return res.status(400).json({ error: 'Ingen blogg finns i Shopify. Skapa en blogg (Content → Blogginlägg) först.' });
    const blogId = reqBlogId || blogs[0].id;

    // Catalogue grounding: tone samples + relevant products + collections.
    const { data: allProducts } = await db.getProducts({ storeId, limit: 20000 });
    const products = allProducts || [];
    const kw = [title, type, ...(Array.isArray(keywords) ? keywords : [])].join(' ').toLowerCase();
    const kwTokens = kw.split(/[^a-zåäö0-9]+/i).filter(t => t.length > 2);
    const scoreP = (p) => {
      const hay = `${p.title} ${p.product_type || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
      return kwTokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    };
    const relevant = products
      .filter(p => p.handle)
      .map(p => ({ p, s: scoreP(p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 14)
      .map(({ p }) => ({ title: p.title, url: `/products/${p.handle}`, type: p.product_type || '' }));
    // Tone: a few of the richest existing descriptions.
    const toneSamples = products
      .filter(p => stripHtmlLen(p.description) > 120)
      .sort((a, b) => stripHtmlLen(b.description) - stripHtmlLen(a.description))
      .slice(0, 3)
      .map(p => String(p.description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400));
    let collections = [];
    try { collections = (await shopifySync.getCollectionsForLinks(store)).slice(0, 40).map(c => ({ title: c.title, url: `/collections/${c.handle}` })); } catch (_) {}
    // Prefer collections whose title matches the topic for internal links.
    const relCollections = collections.filter(c => kwTokens.some(t => c.title.toLowerCase().includes(t))).slice(0, 8);

    const linkList = [...relCollections, ...relevant].slice(0, 16)
      .map(l => `- ${l.title}: ${l.url}`).join('\n');

    const prompt = `Du är innehållsskribent för den svenska heminredningsbutiken "Lumeno Home". Skriv en komplett, säljande men trovärdig bloggartikel på svenska.

ARTIKEL: "${title}"
Typ: ${type || 'guide'}${angle ? `\nVinkel: ${angle}` : ''}${keywords?.length ? `\nSökord att väva in naturligt: ${keywords.join(', ')}` : ''}

BUTIKENS TON (härma stil och tilltal, inte innehållet):
${toneSamples.map((t, i) => `${i + 1}. ${t}`).join('\n') || '(vänlig, konkret, inspirerande svensk heminredningston)'}

INTERNLÄNKAR (använd 4-8 av dessa som <a href="URL">ankartext</a>, väv in naturligt i brödtexten):
${linkList || '(inga tillgängliga)'}

HÅRDA KRAV:
- Skriv på svenska. Använd ALDRIG tankstreck (em dash "—" eller "–"). Använd komma, punkt eller parentes i stället.
- SEO-struktur: en tydlig inledning, flera <h2>-sektioner, <h3> vid behov, punktlistor (<ul><li>). INGEN <h1> (titeln blir H1 automatiskt).
- Avsluta med en sektion "<h2>Vanliga frågor</h2>" med 4-6 konkreta fråga/svar (AEO), där varje fråga är en <h3> och svaret ett kort stycke.
- Internlänkarna ska peka på URL:erna ovan (relativa, /collections/... eller /products/...).
- Naturligt språk, inga påhittade fakta om specifika produkter.

Svara ENBART med giltig JSON:
{"metaTitle":"<=60 tecken","metaDescription":"<=155 tecken","excerpt":"1-2 meningar","tags":["3-6 taggar"],"bodyHtml":"<p>...</p><h2>...</h2>...","faq":[{"q":"...","a":"..."}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Kunde inte tolka AI-svaret' });
    let art;
    try { art = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'Ogiltig JSON från AI' }); }

    // Sanitise + enforce no em dash, then append FAQ JSON-LD for AEO.
    let bodyHtml = noEmDash(sanitizeHtmlLib(String(art.bodyHtml || ''), {
      allowedTags: ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'blockquote', 'br'],
      allowedAttributes: { a: ['href', 'title'] },
    }));
    const faq = Array.isArray(art.faq) ? art.faq.filter(f => f?.q && f?.a) : [];
    if (faq.length) {
      const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: noEmDash(f.q), acceptedAnswer: { '@type': 'Answer', text: noEmDash(f.a) } })) };
      bodyHtml += `\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    }

    const created = await shopifySync.createArticle(store, blogId, {
      title: noEmDash(title),
      bodyHtml,
      summaryHtml: noEmDash(art.excerpt || ''),
      tags: Array.isArray(art.tags) ? art.tags : [],
      metaTitle: noEmDash(art.metaTitle || title).slice(0, 70),
      metaDescription: noEmDash(art.metaDescription || '').slice(0, 320),
      published: false, // DRAFT
    });

    res.json({
      ok: true,
      article: { id: created?.id, handle: created?.handle, title: created?.title },
      blog: blogs.find(b => String(b.id) === String(blogId)) || blogs[0],
      adminUrl: `https://${store.domain}/admin/blogs/${String(blogId).replace(/\D/g, '')}/articles/${created?.id}`,
      meta: { metaTitle: art.metaTitle, metaDescription: art.metaDescription, tags: art.tags, faqCount: faq.length },
    });
  } catch (e) {
    console.error('Generate article error:', e);
    const msg = e.status === 529 ? 'Claude API är överbelastad. Försök igen.' : e.message;
    res.status(500).json({ error: msg });
  }
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

    const { vendor, type, status, tags, search, storeFilter, syncFilter, imageFilter, staging, limit, offset } = req.query;

    const result = await db.getProducts({
      vendor,
      type,
      status,
      tags: tags ? tags.split(',') : undefined,
      search,
      storeId,
      storeFilter, // 'published', 'unpublished', or 'error'
      syncFilter, // 'pending' - visar produkter som behöver synkas
      imageFilter, // 'with' eller 'without' — produkter med/utan bilder
      staging, // 'only' — bara staging-utkast (Nya produkter)
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
    const productData = sanitizeHtmlFields({
      ...req.body,
      title: req.body.title || 'Ny produkt',
      store_id: storeId
    });

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

      const productData = sanitizeHtmlFields({
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
      });

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

    const product = await db.updateProduct(req.params.id, sanitizeHtmlFields(req.body));

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
// Never expose the Shopify Admin token (or other secrets) to any client.
// The UI only needs to know whether a token is configured.
const sanitizeStore = (store) => {
  if (!store || typeof store !== 'object') return store;
  const { access_token, ...rest } = store;
  return { ...rest, has_access_token: Boolean(access_token) };
};

app.get('/api/db/stores', async (req, res) => {
  try {
    // Return empty if no database configured
    if (!isDbConfigured()) {
      return res.json([]);
    }

    let stores = await db.getStores();
    // Non-admins only see the stores they are assigned to.
    if (req.user.role !== 'admin') {
      const allowed = new Set(req.user.storeIds || []);
      stores = stores.filter(s => allowed.has(s.id));
    }
    res.json(stores.map(sanitizeStore));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single store
app.get('/api/db/stores/:id', async (req, res) => {
  try {
    // Non-admins may only read stores they are assigned to.
    if (req.user.role !== 'admin' && !(req.user.storeIds || []).includes(req.params.id)) {
      return res.status(403).json({ error: 'Forbidden - no access to this store' });
    }
    const store = await db.getStoreById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    res.json(sanitizeStore(store));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create store (admin only — store configuration)
app.post('/api/db/stores', requireAdmin, async (req, res) => {
  try {
    const store = await db.createStore(req.body);
    res.status(201).json(sanitizeStore(store));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update store (admin only)
app.put('/api/db/stores/:id', requireAdmin, async (req, res) => {
  try {
    const store = await db.updateStore(req.params.id, req.body);
    res.json(sanitizeStore(store));
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

        // Look up the Shopify link fresh (id + baseline needed for safe push).
        const { data: link } = await supabase
          .from('store_products')
          .select('id, shopify_product_id, shopify_baseline')
          .eq('store_id', storeId).eq('product_id', productId).maybeSingle();

        if (link?.shopify_product_id) {
          // EXISTING product → safe, field-level push. Never full-overwrites
          // Shopify; Shopify-side changes are pulled in and conflicts flagged.
          const r = await safePushProduct(store, product, link);
          syncResults.push({ storeId, success: true, action: 'safe-push', pushedFields: r.pushedFields + r.pushedMetafields, pulled: r.pulled, conflicts: r.unresolved.length });
        } else {
          // NEW product → create in Shopify (createProduct only creates or links,
          // it never overwrites an existing product), then capture the baseline.
          const created = await shopifySync.createProduct(store, product);
          const newShopifyId = created?.id || created?.product?.id || null;
          if (newShopifyId) {
            const { data: up } = await supabase.from('store_products').upsert({
              product_id: productId, store_id: storeId,
              shopify_product_id: newShopifyId,
              shopify_product_gid: `gid://shopify/Product/${newShopifyId}`,
              is_published: true, last_synced_at: new Date().toISOString(),
            }, { onConflict: 'store_id,product_id' }).select('id').single();
            if (up?.id) { try { await captureProductBaseline(store, up.id, newShopifyId); } catch (_) {} }
            if (product.product_category) {
              try { await shopifySync.setProductCategory(store, newShopifyId, product.product_category); } catch (e) { console.warn('category push:', e.message); }
            }
            // Now live in Shopify → leave the staging list, join the main catalogue.
            try { await supabase.from('products').update({ is_staged: false }).eq('id', productId); } catch (_) {}
          }
          syncResults.push({ storeId, success: true, action: created?.linkedExisting ? 'linked' : 'created' });
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
      .select('id, product_id, shopify_product_id, shopify_baseline')
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
          // EXISTING → safe field-level push (never full-overwrites Shopify).
          await safePushProduct(store, product, sp);
        } else {
          const c = await shopifySync.createProduct(store, product);
          const nid = c?.id || c?.product?.id || null;
          if (nid) {
            const { data: up } = await supabase.from('store_products').upsert({
              product_id: sp.product_id, store_id: storeId,
              shopify_product_id: nid, shopify_product_gid: `gid://shopify/Product/${nid}`,
              is_published: true, last_synced_at: new Date().toISOString(),
            }, { onConflict: 'store_id,product_id' }).select('id').single();
            if (up?.id) { try { await captureProductBaseline(store, up.id, nid); } catch (_) {} }
          }
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
        description: sanitizeHtml(description) || null,
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
        short_description: sanitizeHtml(short_description) || null,
        use_cases: sanitizeHtml(use_cases) || null,
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
    const fields = sanitizeHtmlFields(req.body);
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

    // Sanitize any HTML the model returned before it reaches the editor.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const f of ['description', 'intro', 'useCases', 'short_description']) {
        if (typeof result[f] === 'string') result[f] = sanitizeHtml(result[f]);
      }
    } else if (typeof result === 'string' && ['description', 'intro'].includes(field)) {
      result = sanitizeHtml(result);
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

// Trigger sync for store — SAFE bulk push of pending products.
// Each product goes through the field-level safe push (never full-overwrites
// Shopify); products not yet in Shopify are created.
app.post('/api/db/stores/:id/sync', async (req, res) => {
  try {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const pending = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from('store_products')
        .select('id, product_id, shopify_product_id, shopify_baseline')
        .eq('store_id', storeId).eq('sync_status', 'pending')
        .range(from, from + 999);
      pending.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    let pushed = 0, created = 0, conflicts = 0, failed = 0;
    const errors = [];
    for (const link of pending) {
      try {
        const product = await db.getProductById(link.product_id);
        if (!product) continue;
        if (link.shopify_product_id) {
          const r = await safePushProduct(store, product, link);
          pushed++;
          if (r.unresolved.length) conflicts++;
        } else {
          const c = await shopifySync.createProduct(store, product);
          const nid = c?.id || c?.product?.id || null;
          if (nid) {
            const { data: up } = await supabase.from('store_products').upsert({
              product_id: link.product_id, store_id: storeId,
              shopify_product_id: nid, shopify_product_gid: `gid://shopify/Product/${nid}`,
              is_published: true, last_synced_at: new Date().toISOString(),
            }, { onConflict: 'store_id,product_id' }).select('id').single();
            if (up?.id) { try { await captureProductBaseline(store, up.id, nid); } catch (_) {} }
          }
          created++;
        }
      } catch (e) {
        failed++;
        errors.push({ product_id: link.product_id, error: e.message });
      }
    }
    res.json({ pushed, created, conflicts, failed, errors: errors.slice(0, 20) });
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
app.post('/api/sync-worker/start', requireAdmin, (req, res) => {
  syncWorker.start();
  res.json({ status: 'started' });
});

// Stop sync worker (admin only)
app.post('/api/sync-worker/stop', requireAdmin, (req, res) => {
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

// Import ONE Shopify product into the PIM (product + variants + images +
// metafields), linking it and capturing the sync baseline. Returns the created
// PIM product. Used by import-from-shopify and the auto-import of new products.
async function importOneShopifyProduct(store, shopifyId) {
  const client = shopifySync.getClient(store);
  const data = await client.request(`/products/${String(shopifyId).replace(/\D/g, '')}.json`);
  const sp = data.product;
  if (!sp) return null;

  const options = sp.options || [];
  const variants = (sp.variants || []).map(v => ({
    sku: v.sku || '',
    barcode: v.barcode || '',
    price: parseFloat(v.price) || null,
    compare_at_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    inventory_quantity: v.inventory_quantity ?? 0,
    weight: v.grams != null ? v.grams / 1000 : null,
    option1_name: options[0]?.name || null, option1_value: v.option1 || null,
    option2_name: options[1]?.name || null, option2_value: v.option2 || null,
    option3_name: options[2]?.name || null, option3_value: v.option3 || null,
    shopify_variant_id: v.id,
    shopify_inventory_item_id: v.inventory_item_id,
  }));
  const images = (sp.images || []).map((img, idx) => ({
    url: img.src, alt_text: img.alt || sp.title, position: idx + 1,
    source: 'shopify', shopify_image_id: String(img.id),
  }));
  let metafields = {};
  try { metafields = await shopifySync.getProductMetafields(store, sp.id); } catch (_) {}

  const pimProduct = {
    store_id: store.id,
    title: sp.title,
    vendor: sp.vendor || '',
    product_type: sp.product_type || '',
    description: sp.body_html || '',
    tags: sp.tags ? sp.tags.split(', ').filter(Boolean) : [],
    status: sp.status === 'active' ? 'active' : 'draft',
    metafields, variants, images,
  };
  const created_product = await db.createProduct(pimProduct);
  await supabase.from('store_products').upsert({
    product_id: created_product.id,
    store_id: store.id,
    shopify_product_id: sp.id,
    shopify_product_gid: `gid://shopify/Product/${sp.id}`,
    sync_status: 'synced',
    is_published: sp.status === 'active',
    last_synced_at: new Date().toISOString(),
    shopify_baseline: {
      title: sp.title || '', body_html: sp.body_html || '',
      product_type: sp.product_type || '', tags: pimProduct.tags, metafields,
    },
    baseline_synced_at: new Date().toISOString(),
  }, { onConflict: 'store_id,product_id' });
  return created_product;
}

// Find and import Shopify products that are GENUINELY new to the PIM (none of
// their variant SKUs exist in the PIM). Matches by SKU — not product id — so the
// PIM's grouped multi-variant products aren't re-imported as duplicates.
// deadlineMs: stop importing cleanly when Date.now() passes it (serverless
// time limits) — the next run continues where this one stopped, since matching
// is by SKU/link and already-imported products are skipped.
async function importNewProductsFromShopify(store, { deadlineMs = null } = {}) {
  const client = shopifySync.getClient(store);

  // PIM SKU set + already-linked Shopify ids.
  const pimVariants = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('products').select('variants(sku)').eq('store_id', store.id).range(from, from + 999);
    pimVariants.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const pimSkus = new Set();
  for (const p of pimVariants) for (const v of (p.variants || [])) if (v.sku) pimSkus.add(v.sku.trim());
  const { data: links } = await supabase.from('store_products').select('shopify_product_id').eq('store_id', store.id).not('shopify_product_id', 'is', null);
  const linked = new Set((links || []).map(l => String(l.shopify_product_id)));

  // Scan the catalog for products whose every SKU is missing from the PIM.
  const newIds = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let cursor = null;
  while (true) {
    let d;
    for (let a = 0; ; a++) {
      try { d = await client.graphql('query($c: String){ products(first: 100, after: $c){ nodes{ id variants(first: 20){ nodes{ sku } } } pageInfo{ hasNextPage endCursor } } }', { c: cursor }); break; }
      catch (e) { if (a < 5 && /THROTTLED|throttl/i.test(String(e.message))) { await sleep(2000); continue; } throw e; }
    }
    for (const p of d.products.nodes) {
      const numId = p.id.split('/').pop();
      if (linked.has(String(numId))) continue;
      const skus = p.variants.nodes.map(v => (v.sku || '').trim()).filter(Boolean);
      if (skus.length && skus.every(s => !pimSkus.has(s))) newIds.push(numId);
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }

  let imported = 0, failed = 0, stoppedEarly = false;
  const errors = [];
  for (const id of newIds) {
    if (deadlineMs && Date.now() > deadlineMs) { stoppedEarly = true; break; }
    try { await importOneShopifyProduct(store, id); imported++; }
    catch (e) { failed++; errors.push({ id, error: e.message }); }
    await sleep(50);
  }
  return { candidates: newIds.length, imported, failed, stoppedEarly, errors: errors.slice(0, 20) };
}

// POST /api/shopify/stores/:storeId/import-new — import all genuinely-new
// Shopify products into the PIM now (by SKU; no duplicates).
app.post('/api/shopify/stores/:storeId/import-new', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });
    const result = await importNewProductsFromShopify(store);
    res.json(result);
  } catch (error) {
    console.error('import-new error:', error);
    res.status(500).json({ error: error.message });
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
        await importOneShopifyProduct(store, shopifyId);
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

// POST /api/shopify/stores/:storeId/import-metafields
// Pull Shopify metafield VALUES into PIM for products already linked to the
// store, merging them into products.metafields (Shopify is source of truth on
// import). Runs in bounded batches to respect Shopify's REST rate limit and
// serverless timeouts — returns `remaining` so it can be called repeatedly.
// Body: { productIds?: [...], limit? }  (omit productIds to backfill all linked)
app.post('/api/shopify/stores/:storeId/import-metafields', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { productIds, limit } = req.body || {};
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const batchLimit = Math.min(Number(limit) || 50, 100);

    // Linked products to process (optionally a specific subset).
    let q = supabase
      .from('store_products')
      .select('product_id, shopify_product_id, products!inner(id, metafields)')
      .eq('store_id', storeId)
      .not('shopify_product_id', 'is', null);
    if (Array.isArray(productIds) && productIds.length) q = q.in('product_id', productIds);
    const { data: allLinks, error } = await q;
    if (error) throw error;

    const links = (allLinks || []).slice(0, batchLimit);
    const remaining = Math.max(0, (allLinks || []).length - links.length);

    let updated = 0, unchanged = 0, failed = 0, notInShopify = 0, totalFields = 0;
    const errors = [];

    for (const link of links) {
      try {
        const shopMeta = await shopifySync.getProductMetafields(store, link.shopify_product_id);
        const keys = Object.keys(shopMeta);
        if (!keys.length) { unchanged++; continue; }
        const current = link.products?.metafields || {};
        const merged = { ...current, ...shopMeta };
        if (JSON.stringify(merged) === JSON.stringify(current)) { unchanged++; continue; }
        const { error: upErr } = await supabase.from('products').update({ metafields: merged }).eq('id', link.product_id);
        if (upErr) throw upErr;
        updated++;
        totalFields += keys.length;
        // Pace REST calls (~2/s) to stay within Shopify's rate limit.
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        // A 404 means the linked product no longer exists in Shopify (stale link),
        // not a real failure — count it separately so the report stays clean.
        if (/\b404\b/.test(e.message)) { notInShopify++; continue; }
        failed++;
        errors.push({ productId: link.product_id, error: e.message });
      }
    }

    res.json({ processed: links.length, updated, unchanged, failed, notInShopify, totalFields, remaining, errors: errors.slice(0, 20) });
  } catch (error) {
    console.error('import-metafields error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NON-DESTRUCTIVE SYNC (baseline + conflict detection)
// ============================================

// Build the sync-engine content shape from a PIM product row.
const pimContentOf = (product) => ({
  title: product.title || '',
  body_html: product.description || '',
  product_type: product.product_type || '',
  tags: Array.isArray(product.tags) ? product.tags : (product.tags ? [product.tags] : []),
  metafields: product.metafields || {},
});

// Capture the current Shopify content as the sync baseline for a linked product.
const captureProductBaseline = async (store, storeProductRowId, shopifyProductId) => {
  const fresh = await shopifySync.fetchProductContent(store, shopifyProductId);
  await supabase.from('store_products').update({
    shopify_baseline: fresh,
    baseline_synced_at: new Date().toISOString(),
    sync_status: 'synced',
    conflict_fields: null,
  }).eq('id', storeProductRowId);
  return fresh;
};

// Safely push ONE product to Shopify — field-level and conflict-aware.
// It NEVER full-overwrites: only PIM-changed fields go up, Shopify-changed
// fields are pulled into the PIM, and true conflicts are left untouched unless
// an explicit resolution is given. Requires the product to already be linked to
// a Shopify product (`link` has shopify_product_id + shopify_baseline).
// This is the ONLY sanctioned path for updating existing Shopify products.
async function safePushProduct(store, product, link, { resolutions = {}, dryRun = false, pull = false } = {}) {
  const shop = await shopifySync.fetchProductContent(store, link.shopify_product_id);
  const diff = computeProductDiff({ pim: pimContentOf(product), shop, baseline: link.shopify_baseline });
  const plan = buildSyncPlan(diff, resolutions);

  if (dryRun) return { dryRun: true, counts: diff.counts, plan, unresolved: plan.unresolved };

  // 1) Push PIM-owned changes to Shopify (only the changed fields).
  // In pull mode we never write to Shopify — PIM drafts stay pending for a
  // later explicit safe push.
  if (!pull && plan.hasShopifyWrite) {
    await shopifySync.updateProductContent(store, link.shopify_product_id, {
      fields: plan.toShopify.fields,
      tags: plan.toShopify.tags,
      metafields: plan.toShopify.metafields,
    });
  }

  // 1b) Push the Shopify product category if the PIM has one set (not part of the
  // field-level content engine). Best-effort — a bad category doesn't fail the push.
  if (!pull && product.product_category) {
    try { await shopifySync.setProductCategory(store, link.shopify_product_id, product.product_category); }
    catch (e) { console.warn('category push:', e.message); }
  }

  // 2) Pull Shopify-owned changes into the PIM.
  const pimUpdate = {};
  if ('title' in plan.toPim.fields) pimUpdate.title = plan.toPim.fields.title;
  if ('body_html' in plan.toPim.fields) pimUpdate.description = plan.toPim.fields.body_html;
  if ('product_type' in plan.toPim.fields) pimUpdate.product_type = plan.toPim.fields.product_type;
  if (plan.toPim.tags != null) pimUpdate.tags = plan.toPim.tags;
  if (Object.keys(plan.toPim.metafields).length) {
    pimUpdate.metafields = { ...(product.metafields || {}), ...plan.toPim.metafields };
  }
  if (Object.keys(pimUpdate).length) {
    await supabase.from('products').update(pimUpdate).eq('id', product.id);
  }

  // 3) Re-capture baseline from live Shopify, preserving the old baseline for any
  // UNRESOLVED conflict so it keeps being flagged (never silently becomes a push).
  const fresh = await shopifySync.fetchProductContent(store, link.shopify_product_id);
  const newBaseline = { ...fresh, metafields: { ...fresh.metafields } };
  const oldBase = link.shopify_baseline || {};
  for (const u of plan.unresolved) {
    if (u.key.startsWith('metafield:')) {
      const mk = u.key.slice('metafield:'.length);
      if (oldBase.metafields && mk in oldBase.metafields) newBaseline.metafields[mk] = oldBase.metafields[mk];
      else delete newBaseline.metafields[mk];
    } else if (u.key === 'tags') {
      if ('tags' in oldBase) newBaseline.tags = oldBase.tags;
    } else {
      if (u.key in oldBase) newBaseline[u.key] = oldBase[u.key];
      else delete newBaseline[u.key];
    }
  }

  await supabase.from('store_products').update({
    shopify_baseline: newBaseline,
    baseline_synced_at: new Date().toISOString(),
    conflict_fields: plan.unresolved.length ? plan.unresolved : null,
    sync_status: plan.unresolved.length ? 'conflict' : 'synced',
    last_synced_at: new Date().toISOString(),
  }).eq('id', link.id);

  return {
    pushedFields: pull ? 0 : Object.keys(plan.toShopify.fields).length + (plan.toShopify.tags != null ? 1 : 0),
    pushedMetafields: pull ? 0 : Object.keys(plan.toShopify.metafields).length,
    pulled: Object.keys(pimUpdate).length,
    counts: diff.counts,
    unresolved: plan.unresolved,
    status: plan.unresolved.length ? 'conflict' : 'synced',
  };
}

// Pull ALL Shopify-side changes into the PIM in one efficient pass (bulk catalog
// fetch + local diffs). Non-destructive to Shopify: only pulls changes IN, never
// pushes. PIM drafts (pim_changed) stay pending; true conflicts are flagged.
async function pullAllFromShopify(store) {
  const catalog = await shopifySync.fetchAllProductsContent(store); // Map<numId, content>

  // Bulk-load PIM products + links (paginated; Supabase caps at 1000/select).
  const products = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('products')
      .select('id, title, description, product_type, tags, metafields')
      .eq('store_id', store.id).range(from, from + 999);
    products.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const productById = new Map(products.map(p => [p.id, p]));

  const links = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('store_products')
      .select('id, product_id, shopify_product_id, shopify_baseline')
      .eq('store_id', store.id).not('shopify_product_id', 'is', null)
      .range(from, from + 999);
    links.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  let pulled = 0, conflicts = 0, pimPending = 0, unchanged = 0, notInShopify = 0;
  for (const link of links) {
    const shop = catalog.get(String(link.shopify_product_id));
    if (!shop) { notInShopify++; continue; }
    const product = productById.get(link.product_id);
    if (!product) continue;

    const diff = computeProductDiff({ pim: pimContentOf(product), shop, baseline: link.shopify_baseline });
    if (!diff.hasChanges) { unchanged++; continue; }
    const plan = buildSyncPlan(diff, {});

    // Apply Shopify-owned changes into the PIM.
    const pimUpdate = {};
    if ('title' in plan.toPim.fields) pimUpdate.title = plan.toPim.fields.title;
    if ('body_html' in plan.toPim.fields) pimUpdate.description = plan.toPim.fields.body_html;
    if ('product_type' in plan.toPim.fields) pimUpdate.product_type = plan.toPim.fields.product_type;
    if (plan.toPim.tags != null) pimUpdate.tags = plan.toPim.tags;
    if (Object.keys(plan.toPim.metafields).length) {
      pimUpdate.metafields = { ...(product.metafields || {}), ...plan.toPim.metafields };
    }
    if (Object.keys(pimUpdate).length) {
      await supabase.from('products').update(pimUpdate).eq('id', product.id);
      pulled++;
    }

    // Baseline = current Shopify content, preserving old baseline for unresolved
    // conflicts so they keep being flagged (never silently become a push).
    const newBaseline = { ...shop, metafields: { ...shop.metafields } };
    const oldBase = link.shopify_baseline || {};
    for (const u of plan.unresolved) {
      if (u.key.startsWith('metafield:')) {
        const mk = u.key.slice('metafield:'.length);
        if (oldBase.metafields && mk in oldBase.metafields) newBaseline.metafields[mk] = oldBase.metafields[mk];
        else delete newBaseline.metafields[mk];
      } else if (u.key === 'tags') {
        if ('tags' in oldBase) newBaseline.tags = oldBase.tags;
      } else {
        if (u.key in oldBase) newBaseline[u.key] = oldBase[u.key];
        else delete newBaseline[u.key];
      }
    }
    await supabase.from('store_products').update({
      shopify_baseline: newBaseline,
      baseline_synced_at: new Date().toISOString(),
      conflict_fields: plan.unresolved.length ? plan.unresolved : null,
      sync_status: plan.unresolved.length ? 'conflict' : (diff.counts.pim_changed ? 'pending' : 'synced'),
    }).eq('id', link.id);

    if (plan.unresolved.length) conflicts++;
    if (diff.counts.pim_changed) pimPending++;
  }

  return { total: links.length, pulled, conflicts, pimPending, unchanged, notInShopify };
}

// POST /api/shopify/stores/:storeId/pull-all — run a full Shopify->PIM pull now.
app.post('/api/shopify/stores/:storeId/pull-all', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });
    const result = await pullAllFromShopify(store);
    res.json(result);
  } catch (error) {
    console.error('pull-all error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pull all Shopify collections (content + metafields) into the PIM. Upserts by
// handle so collections missing from the PIM are created and the rest refreshed.
async function pullCollectionsFromShopify(store) {
  const cols = await shopifySync.fetchAllCollectionsContent(store);

  const existing = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('collections').select('handle').eq('store_id', store.id).range(from, from + 999);
    existing.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const existingHandles = new Set(existing.map(c => c.handle));

  let created = 0, updated = 0, failed = 0;
  const errors = [];
  for (const col of cols) {
    try {
      const { error } = await supabase.from('collections').upsert({
        store_id: store.id,
        title: col.title,
        handle: col.handle,
        description: col.description,
        seo_title: col.seo_title,
        seo_description: col.seo_description,
        collection_type: col.collection_type,
        sort_order: col.sort_order,
        rules: col.rules,
        disjunctive: col.disjunctive,
        metafields: col.metafields,
        shopify_collection_id: col.shopify_collection_id,
        shopify_collection_gid: `gid://shopify/Collection/${col.shopify_collection_id}`,
        sync_status: 'synced',
      }, { onConflict: 'store_id,handle' });
      if (error) throw error;
      if (existingHandles.has(col.handle)) updated++; else created++;
    } catch (e) {
      failed++;
      errors.push({ handle: col.handle, error: e.message });
    }
  }
  return { shopifyCollections: cols.length, created, updated, failed, errors: errors.slice(0, 20) };
}

// POST /api/shopify/stores/:storeId/pull-collections
app.post('/api/shopify/stores/:storeId/pull-collections', async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });
    const result = await pullCollectionsFromShopify(store);
    res.json(result);
  } catch (error) {
    console.error('pull-collections error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync a single product's variants + images from Shopify into the PIM.
// Shopify-owned fields (price, inventory, options, barcode, image set) are
// refreshed; PIM-owned `cost` is preserved. Variants/images removed in Shopify
// are removed from the PIM (Shopify is the source of truth for existing products).
async function syncProductVariantsImages(store, productId, shopifyProductId) {
  const client = shopifySync.getClient(store);
  const numId = String(shopifyProductId).replace(/\D/g, '');
  const data = await client.request(`/products/${numId}.json`);
  const sp = data.product;
  if (!sp) return { variants: 0, images: 0 };
  const options = sp.options || [];

  // --- Variants (match by SKU, preserve cost) ---
  const { data: pimVariants } = await supabase
    .from('variants').select('id, sku, cost').eq('product_id', productId);
  const pimBySku = new Map((pimVariants || []).map(v => [(v.sku || '').trim(), v]));
  const shopSkus = new Set();
  let vCount = 0;
  for (const [i, v] of (sp.variants || []).entries()) {
    const sku = (v.sku || '').trim();
    shopSkus.add(sku);
    const row = {
      sku,
      barcode: v.barcode || '',
      price: v.price != null ? parseFloat(v.price) : null,
      compare_at_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
      inventory_quantity: v.inventory_quantity ?? 0,
      weight: v.grams != null ? v.grams / 1000 : null,
      option1_name: options[0]?.name || null, option1_value: v.option1 || null,
      option2_name: options[1]?.name || null, option2_value: v.option2 || null,
      option3_name: options[2]?.name || null, option3_value: v.option3 || null,
      shopify_variant_id: v.id,
      shopify_inventory_item_id: v.inventory_item_id,
      position: i + 1,
    };
    const existing = pimBySku.get(sku);
    if (existing) await supabase.from('variants').update(row).eq('id', existing.id);
    else await supabase.from('variants').insert({ product_id: productId, cost: null, ...row });
    vCount++;
  }
  for (const [sku, v] of pimBySku) {
    if (sku && !shopSkus.has(sku)) await supabase.from('variants').delete().eq('id', v.id);
  }

  // --- Images (match by shopify_image_id) ---
  const { data: pimImages } = await supabase
    .from('images').select('id, shopify_image_id').eq('product_id', productId);
  const pimByShopId = new Map((pimImages || []).map(im => [String(im.shopify_image_id), im]));
  const shopImgIds = new Set((sp.images || []).map(im => String(im.id)));
  let iCount = 0;
  for (const [i, im] of (sp.images || []).entries()) {
    const row = { url: im.src, alt_text: im.alt || sp.title, position: i + 1, source: 'shopify', shopify_image_id: String(im.id) };
    const existing = pimByShopId.get(String(im.id));
    if (existing) await supabase.from('images').update(row).eq('id', existing.id);
    else await supabase.from('images').insert({ product_id: productId, ...row });
    iCount++;
  }
  for (const im of (pimImages || [])) {
    if (im.shopify_image_id && !shopImgIds.has(String(im.shopify_image_id))) {
      await supabase.from('images').delete().eq('id', im.id);
    }
  }

  return { variants: vCount, images: iCount };
}

// POST /api/db/products/:id/refresh-from-shopify — pull the latest content +
// variants + images for ONE product from Shopify (on-demand, e.g. when opening
// the product). Non-destructive to Shopify.
app.post('/api/db/products/:id/refresh-from-shopify', async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await db.getProductById(productId);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const storeId = getStoreId(req) || product.store_id;
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const { data: link } = await supabase
      .from('store_products')
      .select('id, shopify_product_id, shopify_baseline')
      .eq('store_id', storeId).eq('product_id', productId).maybeSingle();
    if (!link?.shopify_product_id) return res.status(400).json({ error: 'Produkten är inte kopplad till Shopify' });

    // Content (safe pull — never writes to Shopify) + variants/images.
    const content = await safePushProduct(store, product, link, { pull: true });
    const struct = await syncProductVariantsImages(store, productId, link.shopify_product_id);
    const fresh = await db.getProductById(productId);

    res.json({
      variants: struct.variants,
      images: struct.images,
      contentPulled: content.pulled,
      conflicts: content.unresolved.length,
      product: fresh,
    });
  } catch (error) {
    console.error('refresh-from-shopify error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Continuous Shopify -> PIM pull (poll). Enable with SHOPIFY_PULL_MINUTES=<n>.
// Pull-only: never writes to Shopify. On serverless (Vercel), setInterval does
// not persist — use a Vercel Cron hitting /pull-all instead.
const PULL_MINUTES = Number(process.env.SHOPIFY_PULL_MINUTES) || 0;
if (PULL_MINUTES > 0 && isDbConfigured()) {
  let polling = false;
  const runPoll = async () => {
    if (polling) return; // avoid overlapping runs
    polling = true;
    try {
      const stores = await db.getStores();
      for (const store of (stores || [])) {
        if (!store.access_token) continue;
        try {
          const r = await pullAllFromShopify(store);
          console.log(`🔄 Pull ${store.name}: pulled ${r.pulled}, conflicts ${r.conflicts}, pending ${r.pimPending}, unchanged ${r.unchanged}`);
        } catch (e) { console.error(`Pull failed for ${store.name}:`, e.message); }
        try {
          const c = await pullCollectionsFromShopify(store);
          console.log(`🔄 Pull collections ${store.name}: created ${c.created}, updated ${c.updated}, failed ${c.failed}`);
        } catch (e) { console.error(`Collection pull failed for ${store.name}:`, e.message); }
        try {
          const n = await importNewProductsFromShopify(store);
          if (n.imported) console.log(`🔄 Auto-import ${store.name}: ${n.imported} new products imported`);
        } catch (e) { console.error(`Auto-import failed for ${store.name}:`, e.message); }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
    } finally {
      polling = false;
    }
  };
  console.log(`🔄 Shopify→PIM pull-poll enabled: every ${PULL_MINUTES} min`);
  setInterval(runPoll, PULL_MINUTES * 60 * 1000);
}

// Nightly price-watch fetch (Merchant Center benchmark → price_benchmarks).
// Runs once per day at PRICE_WATCH_HOUR (server local time, default 04) on a
// persistent host. PRICE_WATCH_HOUR=off disables. Never writes to Shopify.
// On Vercel (serverless) timers don't survive — the Vercel Cron in vercel.json
// calls /api/price-watch/cron instead.
if (PRICE_WATCH_HOUR != null && isDbConfigured() && !process.env.VERCEL) {
  let pwLastDay = null;
  let pwRunning = false;
  const priceWatchTick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (pwRunning || pwLastDay === day || now.getHours() !== PRICE_WATCH_HOUR) return;
    if (!googleSeo.isConfigured()) return;
    pwRunning = true; pwLastDay = day;
    try {
      for (const store of (await db.getStores()) || []) {
        if (!store.settings?.google?.merchant_id) continue;
        try { await priceWatch.runFetch({ store, trigger: 'scheduled' }); }
        catch (e) { console.error(`Prisbevakning misslyckades för ${store.name}:`, e.message); }
      }
    } finally { pwRunning = false; }
  };
  setInterval(priceWatchTick, 10 * 60 * 1000);
  console.log(`💰 Prisbevakning: nattlig hämtning kl ${String(PRICE_WATCH_HOUR).padStart(2, '0')}:00`);
}

// GET /api/shopify/stores/:storeId/products/:productId/sync-diff
// Per-field comparison of PIM vs Shopify vs baseline. Read-only.
app.get('/api/shopify/stores/:storeId/products/:productId/sync-diff', async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const product = await db.getProductById(productId);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });

    const { data: link } = await supabase
      .from('store_products')
      .select('shopify_product_id, shopify_baseline, baseline_synced_at, conflict_fields')
      .eq('store_id', storeId).eq('product_id', productId).maybeSingle();
    if (!link?.shopify_product_id) {
      return res.status(400).json({ error: 'Produkten är inte kopplad till en Shopify-produkt' });
    }

    const shop = await shopifySync.fetchProductContent(store, link.shopify_product_id);
    const diff = computeProductDiff({ pim: pimContentOf(product), shop, baseline: link.shopify_baseline });

    res.json({
      productId, storeId,
      shopifyProductId: String(link.shopify_product_id),
      baselineSyncedAt: link.baseline_synced_at,
      ...diff,
    });
  } catch (error) {
    console.error('sync-diff error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/shopify/stores/:storeId/products/:productId/push-safe
// Non-destructive sync. Body: { resolutions?: { field|"metafield:key": "pim"|"shopify" }, dryRun? }
//  - PIM-changed fields  -> pushed to Shopify (only those fields)
//  - Shopify-changed      -> pulled into the PIM
//  - conflicts/no-baseline -> require an explicit resolution, otherwise left untouched
app.post('/api/shopify/stores/:storeId/products/:productId/push-safe', async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { resolutions = {}, dryRun = false } = req.body || {};

    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });
    const product = await db.getProductById(productId);
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });

    const { data: link } = await supabase
      .from('store_products')
      .select('id, shopify_product_id, shopify_baseline')
      .eq('store_id', storeId).eq('product_id', productId).maybeSingle();
    if (!link?.shopify_product_id) return res.status(400).json({ error: 'Produkten är inte kopplad till Shopify' });

    const result = await safePushProduct(store, product, link, { resolutions, dryRun });
    res.json(result);
  } catch (error) {
    console.error('push-safe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/shopify/stores/:storeId/relink-by-sku
// Repair PIM<->Shopify links by matching on SKU against the live catalog. Fixes
// stale shopify_product_id (e.g. after a store rebuild) and creates links for
// unlinked products. Must run before baseline/sync when links are stale.
app.post('/api/shopify/stores/:storeId/relink-by-sku', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    const skuMap = await shopifySync.fetchSkuToProductId(store);

    // Paginate — Supabase caps a single select at 1000 rows.
    const products = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('products')
        .select('id, sku, variants(sku)')
        .eq('store_id', storeId)
        .range(from, from + 999);
      if (error) throw error;
      products.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const existingLinks = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from('store_products')
        .select('product_id, shopify_product_id')
        .eq('store_id', storeId)
        .range(from, from + 999);
      existingLinks.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const linkByProduct = new Map(existingLinks.map(l => [l.product_id, l]));

    let relinked = 0, created = 0, unchanged = 0, unmatched = 0, noSku = 0, failed = 0;
    const errors = [];

    for (const p of (products || [])) {
      const sku = (p.sku || (p.variants || []).map(v => v.sku).find(Boolean) || '').trim();
      if (!sku) { noSku++; continue; }
      const shId = skuMap.get(sku);
      if (!shId) { unmatched++; continue; }
      const existing = linkByProduct.get(p.id);
      if (existing && String(existing.shopify_product_id) === shId) { unchanged++; continue; }
      try {
        await supabase.from('store_products').upsert({
          product_id: p.id,
          store_id: storeId,
          shopify_product_id: Number(shId),
          shopify_product_gid: `gid://shopify/Product/${shId}`,
        }, { onConflict: 'store_id,product_id' });
        if (existing) relinked++; else created++;
      } catch (e) {
        failed++;
        errors.push({ productId: p.id, error: e.message });
      }
    }

    res.json({
      liveSkus: skuMap.size,
      pimProducts: (products || []).length,
      relinked, created, unchanged, unmatched, noSku, failed,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error('relink-by-sku error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/shopify/stores/:storeId/capture-baseline
// Establish sync baselines for products already in the PIM: bulk-fetch the
// catalog content from Shopify, mirror it into the PIM (so no Shopify content
// is lost), and set baseline = current Shopify state — a clean, conflict-free
// starting point. Body: { productIds?: [...], refreshPim?: true }
app.post('/api/shopify/stores/:storeId/capture-baseline', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { productIds, refreshPim = true } = req.body || {};
    const store = await db.getStoreById(storeId);
    if (!store?.access_token) return res.status(400).json({ error: 'Butiken har ingen access token' });

    // Fast bulk read of the whole catalog from Shopify.
    const contentById = await shopifySync.fetchAllProductsContent(store);

    const links = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase
        .from('store_products')
        .select('id, product_id, shopify_product_id, products!inner(id, metafields)')
        .eq('store_id', storeId)
        .not('shopify_product_id', 'is', null)
        .range(from, from + 999);
      if (Array.isArray(productIds) && productIds.length) q = q.in('product_id', productIds);
      const { data, error } = await q;
      if (error) throw error;
      links.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    let updated = 0, notInShopify = 0, failed = 0;
    const errors = [];

    for (const link of (links || [])) {
      const content = contentById.get(String(link.shopify_product_id));
      if (!content) { notInShopify++; continue; }
      try {
        if (refreshPim) {
          await supabase.from('products').update({
            title: content.title,
            description: content.body_html,
            product_type: content.product_type,
            tags: content.tags,
            metafields: { ...(link.products?.metafields || {}), ...content.metafields },
          }).eq('id', link.product_id);
        }
        await supabase.from('store_products').update({
          shopify_baseline: content,
          baseline_synced_at: new Date().toISOString(),
          sync_status: 'synced',
          conflict_fields: null,
        }).eq('id', link.id);
        updated++;
      } catch (e) {
        failed++;
        errors.push({ productId: link.product_id, error: e.message });
      }
    }

    res.json({
      catalogFetched: contentById.size,
      processed: (links || []).length,
      updated, notInShopify, failed,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error('capture-baseline error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a store (admin only)
app.delete('/api/db/stores/:id', requireAdmin, async (req, res) => {
  try {
    await shopifyApp.deleteStore(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual store connection (without OAuth - for custom apps) (admin only)
app.post('/api/db/stores/connect-manual', requireAdmin, async (req, res) => {
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