// Vercel serverless wrapper.
// Re-exports the Express app as a single function that handles all /api/* requests.
// app.listen() is skipped automatically when process.env.VERCEL is set.

import serverless from 'serverless-http';
import app from '../server/index.js';

const handler = serverless(app);

export default async function (req, res) {
  return handler(req, res);
}

export const config = {
  // Use Node.js runtime (not Edge) for full Express compatibility.
  runtime: 'nodejs20.x',
  // Bump from 4.5MB default to allow larger product imports/uploads (Pro: up to 50MB).
  api: {
    bodyParser: false,
  },
};
