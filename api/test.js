// Minimal test - no imports from server/ at all
export default function(req, res) {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV });
}

export const config = { runtime: 'nodejs' };
