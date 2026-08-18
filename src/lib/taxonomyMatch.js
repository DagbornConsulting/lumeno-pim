// Match an AI-suggested category (free text or a "A > B > C" path) to the exact
// Shopify taxonomy node id. Shared by ProductDetail and the SEO opportunity list
// so both resolve categories the same way.
export function matchCategoryId(text, categories) {
  if (!text || !categories?.length) return '';
  const t = String(text).toLowerCase().trim();
  const leaf = t.split('>').pop().trim();
  // 1) exact full-path match
  let m = categories.find(c => c.p.toLowerCase() === t);
  if (m) return m.id;
  // 2) exact leaf-name match, deepest wins
  const nameHits = categories.filter(c => c.n.toLowerCase() === leaf).sort((a, b) => (b.l || 0) - (a.l || 0));
  if (nameHits.length) return nameHits[0].id;
  // 3) path ends with the suggested path
  m = categories.find(c => c.p.toLowerCase().endsWith(t));
  if (m) return m.id;
  // 4) fuzzy: name/path contains the leaf, deepest wins
  const cands = categories
    .filter(c => c.n.toLowerCase().includes(leaf) || c.p.toLowerCase().includes(leaf))
    .sort((a, b) => (b.l || 0) - (a.l || 0));
  return cands[0]?.id || '';
}
