export const SHOPIFY_FIELDS = {
  sku: { label: 'Artikelnummer (SKU)', required: true },
  title: { label: 'Produktnamn', required: true },
  price: { label: 'Pris', required: true },
  vendor: { label: 'Varumärke', required: false },
  description: { label: 'Beskrivning', required: false },
  productType: { label: 'Produkttyp / Kategori', required: false },
  imageUrl: { label: 'Bild-URL (huvudbild)', required: false },
  imageUrl2: { label: 'Bild-URL 2', required: false },
  imageUrl3: { label: 'Bild-URL 3', required: false },
  option1Name: { label: 'Variant 1 namn (t.ex. Storlek)', required: false },
  option1Value: { label: 'Variant 1 värde', required: false },
  option2Name: { label: 'Variant 2 namn (t.ex. Färg)', required: false },
  option2Value: { label: 'Variant 2 värde', required: false },
  option3Name: { label: 'Variant 3 namn', required: false },
  option3Value: { label: 'Variant 3 värde', required: false },
  color: { label: 'Färg', required: false },
  material: { label: 'Material', required: false },
  weight: { label: 'Vikt', required: false },
  barcode: { label: 'EAN / Streckkod', required: false },
  compareAtPrice: { label: 'Ordinarie pris (jämförpris)', required: false },
  costPerItem: { label: 'Inköpspris', required: false },
  tags: { label: 'Taggar (kommaseparerade)', required: false },
  collection: { label: 'Collection / Kollektion', required: false },
  inventoryQuantity: { label: 'Lagersaldo', required: false },
};

const PATTERNS = {
  sku: /^(sku|art\.?nr|artikelnr|artikelnummer|item.?number|product.?id|varunr|artnr|article.?no)/i,
  title: /^(title|namn|produktnamn|product.?name|benämning|rubrik|name)/i,
  price: /^(price|pris|försäljningspris|price.?incl|pris.?inkl|utpris|sell.?price|retail)/i,
  vendor: /^(brand|vendor|varumärke|märke|tillverkare|manufacturer|leverantör)/i,
  description: /^(description|beskrivning|product.?description|text|produkttext|body)/i,
  productType: /^(product.?type|produkttyp|typ|type|kategori|category|varugrupp|commodity)/i,
  imageUrl: /^(image|bild|image.?url|bild.?url|foto|picture|main.?image|img|bild.?1|image.?1)/i,
  imageUrl2: /^(bild.?2|image.?2|extra.?image|additional.?image)/i,
  imageUrl3: /^(bild.?3|image.?3)/i,
  option1Name: /^(option.?1.?name|variant.?1.?name|storlek.?namn|size.?name)/i,
  option1Value: /^(option.?1.?value|storlek|size|variant.?1)/i,
  option2Name: /^(option.?2.?name|variant.?2.?name|farg.?namn|color.?name)/i,
  option2Value: /^(option.?2.?value|farg|färg|color|colour|variant.?2)/i,
  color: /^(color|colour|färg|farg)$/i,
  material: /^(material|materials|tyg|fabric)$/i,
  weight: /^(weight|vikt|gross.?weight|nettovikt|net.?weight)/i,
  barcode: /^(ean|barcode|gtin|streckkod|upc|ean.?13|ean13)/i,
  compareAtPrice: /^(compare|ordinarie|rek\.?pris|msrp|rrp|jämförpris|jamforpris|list.?price|original.?price)/i,
  costPerItem: /^(cost|inköp|inköpspris|inkopspris|purchase.?price|supplier.?price|kostnad)/i,
  tags: /^(tags|taggar|etiketter|labels)/i,
  collection: /^(collection|kollektion|samling)/i,
  inventoryQuantity: /^(qty|quantity|antal|lager|lagersaldo|stock|inventory|saldo)/i,
};

export function autoMapColumns(headers) {
  const mapping = {};
  const usedFields = new Set();

  for (const header of headers) {
    const trimmed = header.trim();
    let matched = false;

    for (const [field, pattern] of Object.entries(PATTERNS)) {
      if (usedFields.has(field)) continue;
      if (pattern.test(trimmed)) {
        mapping[header] = field;
        usedFields.add(field);
        matched = true;
        break;
      }
    }

    if (!matched) {
      mapping[header] = null;
    }
  }

  return mapping;
}

export function applyMapping(rows, mapping) {
  return rows.map(row => {
    const mapped = {};
    for (const [sourceCol, targetField] of Object.entries(mapping)) {
      if (targetField && row[sourceCol] !== undefined) {
        mapped[targetField] = row[sourceCol];
      }
    }
    return mapped;
  });
}

export function getMappingStats(mapping) {
  const fields = Object.values(mapping).filter(Boolean);
  const requiredFields = Object.entries(SHOPIFY_FIELDS)
    .filter(([, def]) => def.required)
    .map(([key]) => key);
  const missingRequired = requiredFields.filter(f => !fields.includes(f));
  return {
    totalColumns: Object.keys(mapping).length,
    mappedColumns: fields.length,
    unmappedColumns: Object.values(mapping).filter(v => v === null).length,
    missingRequired,
    isComplete: missingRequired.length === 0,
  };
}
