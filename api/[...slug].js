// Vercel serverless wrapper.
// Calls the Express app directly instead of via serverless-http,
// which is built for AWS Lambda (event/context) not Vercel (req/res).

let app = null;

export default async function (req, res) {
  if (!app) {
    try {
      console.log('[slug] loading server/index.js...');
      const mod = await import('../server/index.js');
      app = mod.default;
      console.log('[slug] server ready');
    } catch (e) {
      console.error('[slug] init error:', e.message);
      return res.status(500).json({ error: 'Server init failed', detail: e.message });
    }
  }

  // Call Express app directly — it accepts (req, res, next) like any middleware
  return new Promise((resolve, reject) => {
    app(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};
