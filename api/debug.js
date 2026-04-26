// Diagnostic: imports each server module with a timeout to find which one hangs.
const timeout = (label, ms = 8000) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${label}`)), ms));

export default async function (req, res) {
  const log = [];

  const load = async (label, mod) => {
    log.push(`loading ${label}...`);
    await Promise.race([import(mod), timeout(label)]);
    log.push(`ok: ${label}`);
  };

  try {
    await load('express', 'express');
    await load('cors', 'cors');
    await load('bcryptjs', 'bcryptjs');
    await load('@anthropic-ai/sdk', '@anthropic-ai/sdk');
    await load('multer', 'multer');
    await load('xlsx', 'xlsx');
    await load('pg', 'pg');
    await load('db.js', '../server/db.js');
    await load('shopify.js', '../server/shopify.js');
    await load('shopify-app.js', '../server/shopify-app.js');
    await load('csv-parser.js', '../server/services/csv-parser.js');
    await load('excel-parser.js', '../server/services/excel-parser.js');
    await load('column-mapper.js', '../server/services/column-mapper.js');
    await load('image-processor.js', '../server/services/image-processor.js');
    await load('feed-generator.js', '../server/feed-generator.js');
    await load('server/index.js', '../server/index.js');
    res.json({ ok: true, log });
  } catch (e) {
    res.json({ ok: false, error: e.message, log });
  }
}

export const config = { runtime: 'nodejs' };
