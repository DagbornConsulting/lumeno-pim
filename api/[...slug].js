// Vercel serverless wrapper.
// Uses dynamic imports so esbuild does NOT inline server/index.js
// (which is ~4000 lines + dependencies) into one giant bundle.

let handler = null;

export default async function (req, res) {
  if (!handler) {
    try {
      const [{ default: serverless }, { default: app }] = await Promise.all([
        import('serverless-http'),
        import('../server/index.js'),
      ]);
      handler = serverless(app);
    } catch (e) {
      console.error('[slug] init error:', e.message);
      return res.status(500).json({ error: 'Server init failed', detail: e.message });
    }
  }
  return handler(req, res);
}

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};
