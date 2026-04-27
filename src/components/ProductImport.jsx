import React, { useState, useRef, useCallback, useEffect } from 'react';
import './ProductImport.css';
import * as XLSX from 'xlsx';
import {
  FileSpreadsheet, ChevronRight, Check, X,
  AlertCircle, Loader2, RotateCcw, Plus, Info,
  Layers, GitBranch, Tag
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const PIM_FIELDS = [
  { key: '', label: '— Ignorera kolumn —', group: '' },
  { key: 'title', label: 'Titel / Produktnamn', group: 'Grunduppgifter', required: true },
  { key: 'sku', label: 'SKU / Artikelnummer', group: 'Grunduppgifter' },
  { key: 'barcode', label: 'Streckkod / EAN', group: 'Grunduppgifter' },
  { key: 'vendor', label: 'Varumärke / Leverantör', group: 'Grunduppgifter' },
  { key: 'type', label: 'Produkttyp', group: 'Grunduppgifter' },
  { key: 'tags', label: 'Taggar', group: 'Grunduppgifter' },
  { key: 'description', label: 'Beskrivning', group: 'Grunduppgifter' },
  { key: 'status', label: 'Status', group: 'Grunduppgifter' },
  { key: 'price', label: 'Pris (försäljningspris)', group: 'Priser' },
  { key: 'compareAtPrice', label: 'Jämförpris', group: 'Priser' },
  { key: 'cost', label: 'Inköpspris', group: 'Priser' },
  { key: 'inventoryQuantity', label: 'Lagersaldo', group: 'Lager & frakt' },
  { key: 'weight', label: 'Vikt (gram)', group: 'Lager & frakt' },
  { key: 'seoTitle', label: 'SEO-titel', group: 'SEO' },
  { key: 'seoDescription', label: 'SEO-beskrivning', group: 'SEO' },
  { key: 'imageUrl', label: 'Bild-URL', group: 'Bilder' },
  { key: 'imageAlt', label: 'Bild alt-text', group: 'Bilder' },
  { key: 'country_of_origin', label: 'Ursprungsland (ISO-kod)', group: 'Tull & export' },
  { key: 'hs_code', label: 'HS-kod / Tullkod', group: 'Tull & export' },
];

function autoDetectField(colName) {
  const col = colName.toLowerCase().trim();
  if (/^(titel|title|produktnamn|name|namn|product.?name)$/.test(col)) return 'title';
  if (/^(sku|artikel|artikelnr|artikelnummer|item.?no|item.?number|artnr)$/.test(col)) return 'sku';
  if (/^(ean|barcode|streckkod|gtin|upc|ean.?kod)$/.test(col)) return 'barcode';
  if (/^(varumärke|brand|vendor|leverantör|manufacturer|tillverkare)$/.test(col)) return 'vendor';
  if (/^(produkttyp|type|typ|category|kategori|benämning)$/.test(col)) return 'type';
  if (/^(taggar|tags)$/.test(col)) return 'tags';
  if (/^(beskrivning|description|desc|produktbeskrivning|information)$/.test(col)) return 'description';
  if (/^(pris|price|försäljningspris|sell.?price|sales.?price|pris \(sek\))$/.test(col)) return 'price';
  if (/^(inköpspris|cost|kostnad|purchase.?price|buy.?price|inpris|ditt pris.*)$/.test(col)) return 'cost';
  if (/^(jämförpris|compare.?at|rea.?pris|original.?pris)$/.test(col)) return 'compareAtPrice';
  if (/^(lager|stock|qty|quantity|lagersaldo)$/.test(col)) return 'inventoryQuantity';
  if (/^(vikt|weight)$/.test(col)) return 'weight';
  if (/^(bild|image|img|photo|bild.?url|image.?url)$/.test(col)) return 'imageUrl';
  if (/^(ursprungsland|country.?of.?origin|ursprung)$/.test(col)) return 'country_of_origin';
  if (/^(hs.?kod|hs.?code|tullkod|harmonized)$/.test(col)) return 'hs_code';
  return '';
}

// Analyze which columns vary within product groups (→ suggest as variant)
// vs stay constant (→ suggest as metafield/product field)
function analyzeColumns(rows, headers, groupCol) {
  if (!groupCol || !rows.length) return {};

  const groups = {};
  rows.forEach(row => {
    const key = String(row[groupCol] ?? '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  });

  const result = {};
  headers.forEach(col => {
    if (col === groupCol) { result[col] = { role: 'group' }; return; }

    const allVals = [...new Set(rows.map(r => String(r[col] ?? '')).filter(v => v !== ''))];
    let varying = false;
    for (const group of Object.values(groups)) {
      if (group.length < 2) continue;
      const groupVals = new Set(group.map(r => String(r[col] ?? '')));
      if (groupVals.size > 1) { varying = true; break; }
    }

    result[col] = {
      role: varying ? 'variant' : 'meta',
      distinctValues: allVals.slice(0, 8),
    };
  });
  return result;
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function buildProducts(rows, mapping, groupCol, variantOptions) {
  const products = [];
  const seen = new Map();

  rows.forEach(row => {
    const get = (key) => {
      const col = Object.entries(mapping).find(([, fields]) =>
        Array.isArray(fields) && fields.includes(key)
      )?.[0];
      return col !== undefined ? row[col] : undefined;
    };

    const metafields = {};
    Object.entries(mapping).forEach(([col, fields]) => {
      (Array.isArray(fields) ? fields : [fields]).forEach(field => {
        if (field && field.startsWith('metafield:')) {
          const mfKey = field.replace('metafield:', '');
          const val = row[col];
          if (val !== undefined && val !== '') metafields[mfKey] = String(val);
        }
      });
    });

    const title = get('title') || '';
    const sku = get('sku') || '';
    const vendor = get('vendor') || '';

    // Grouping: explicit groupCol first, then title mapping, then SKU
    const groupKey = (groupCol ? String(row[groupCol] ?? '') : '') || title || sku;
    if (!groupKey) return;

    const variant = {
      sku,
      barcode: get('barcode') || '',
      price: parseNumber(get('price')),
      compareAtPrice: parseNumber(get('compareAtPrice')),
      cost: parseNumber(get('cost')),
      inventoryQuantity: parseNumber(get('inventoryQuantity')) ?? 0,
      weight: parseNumber(get('weight')),
      option1Name: variantOptions[0]?.name || null,
      option1Value: variantOptions[0]?.col ? String(row[variantOptions[0].col] ?? '') || null : null,
      option2Name: variantOptions[1]?.name || null,
      option2Value: variantOptions[1]?.col ? String(row[variantOptions[1].col] ?? '') || null : null,
      option3Name: variantOptions[2]?.name || null,
      option3Value: variantOptions[2]?.col ? String(row[variantOptions[2].col] ?? '') || null : null,
    };

    if (seen.has(groupKey)) {
      seen.get(groupKey).variants.push(variant);
    } else {
      const product = {
        title: title || groupKey,
        vendor,
        type: get('type') || '',
        description: get('description') || '',
        tags: get('tags') ? String(get('tags')).split(/[,;]/).map(t => t.trim()).filter(Boolean) : [],
        status: get('status') || 'draft',
        seoTitle: get('seoTitle') || '',
        seoDescription: get('seoDescription') || '',
        images: get('imageUrl') ? [{ url: get('imageUrl'), alt: get('imageAlt') || title }] : [],
        country_of_origin: get('country_of_origin') ? String(get('country_of_origin')).toUpperCase().slice(0, 2) : '',
        hs_code: get('hs_code') ? String(get('hs_code')) : '',
        metafields,
        variants: [variant],
      };
      seen.set(groupKey, product);
      products.push(product);
    }
  });

  return products;
}

const STEPS = ['Ladda upp fil', 'Mappa kolumner', 'Förhandsgranska', 'Importera'];
const NEW_METAFIELD_SENTINEL = '__new_metafield__';
const FIELD_TYPES = [
  { value: 'single_line_text', label: 'Text (en rad)' },
  { value: 'multi_line_text', label: 'Text (flerrad)' },
  { value: 'number', label: 'Nummer' },
  { value: 'boolean', label: 'Ja/Nej' },
  { value: 'date', label: 'Datum' },
  { value: 'url', label: 'URL' },
  { value: 'color', label: 'Färg' },
  { value: 'rich_text', label: 'Rich text' },
  { value: 'json', label: 'JSON' },
];

export default function ProductImport({ onImportComplete, onClose }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState({});

  // Grouping column (which column identifies the product across rows)
  const [groupCol, setGroupCol] = useState('');

  // Up to 3 variant options: { col: string, name: string }
  const [variantOptions, setVariantOptions] = useState([
    { col: '', name: '' },
    { col: '', name: '' },
    { col: '', name: '' },
  ]);

  // Column analysis: which columns vary per product
  const [colAnalysis, setColAnalysis] = useState({});

  const [supplierName, setSupplierName] = useState('');
  const [saveMapping, setSaveMapping] = useState(false);
  const [matchedProfile, setMatchedProfile] = useState(null);
  const [overrideVendor, setOverrideVendor] = useState('');
  const [preview, setPreview] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const [metaDefs, setMetaDefs] = useState([]);
  const [creatingMeta, setCreatingMeta] = useState(null);
  const [newMeta, setNewMeta] = useState({ name: '', key: '', namespace: 'custom', field_type: 'single_line_text' });
  const [savingMeta, setSavingMeta] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/db/metafields`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setMetaDefs(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Re-run analysis when groupCol changes
  useEffect(() => {
    if (rows.length && headers.length) {
      setColAnalysis(analyzeColumns(rows, headers, groupCol));
    }
  }, [groupCol, rows, headers]);

  // After file is parsed, check for a saved supplier mapping matching these headers
  useEffect(() => {
    if (!headers.length || step !== 1) return;
    let cancelled = false;
    fetch(`${API_URL}/db/import-mappings/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headers }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(profile => {
        if (cancelled || !profile) return;
        setMatchedProfile(profile);
        setSupplierName(profile.supplier_name);
        setSaveMapping(true);
        if (profile.mapping) setMapping(profile.mapping);
        if (profile.group_col) setGroupCol(profile.group_col);
        if (profile.variant_options) setVariantOptions(profile.variant_options);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [headers, step]);

  const handleCreateMetafield = async (col) => {
    if (!newMeta.name || !newMeta.key) return;
    setSavingMeta(true);
    try {
      const res = await fetch(`${API_URL}/db/metafields`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('pim_token')}`,
        },
        body: JSON.stringify(newMeta),
      });
      if (res.ok) {
        const created = await res.json();
        setMetaDefs(prev => [...prev, created]);
        const newKey = `metafield:${created.namespace}.${created.key}`;
        setMapping(prev => ({ ...prev, [col]: [...(prev[col] || []), newKey] }));
        setCreatingMeta(null);
        setNewMeta({ name: '', key: '', namespace: 'custom', field_type: 'single_line_text' });
      }
    } catch (err) {
      console.error('Failed to create metafield:', err);
    } finally {
      setSavingMeta(false);
    }
  };

  const parseFile = useCallback((f) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!jsonRows.length) { setError('Filen verkar tom.'); return; }
        const hdrs = Object.keys(jsonRows[0]);
        setHeaders(hdrs);
        setRows(jsonRows);

        // Auto-detect mapping
        const autoMap = {};
        let detectedGroup = '';
        let detectedVariants = [];
        hdrs.forEach(h => {
          const f = autoDetectField(h);
          if (f) {
            autoMap[h] = [f];
            if (f === 'title') detectedGroup = h;
          }
          // Suggest variant columns by name heuristics
          const lh = h.toLowerCase();
          if (/^(diameter|längd|storlek|size|mått)$/.test(lh)) detectedVariants.push(h);
          if (/^(färg|color|colour|färgnyans)$/.test(lh)) detectedVariants.push(h);
          if (/^(material)$/.test(lh) && detectedVariants.length < 3) detectedVariants.push(h);
        });

        // Auto-detect grouping column: prefer 'Namn', 'Produktnamn', 'Title'
        const groupCandidate = hdrs.find(h => /^(namn|name|produktnamn|titel|title)$/i.test(h)) || detectedGroup;
        setGroupCol(groupCandidate || '');

        // Pre-fill variant slots
        const slots = [{ col: '', name: '' }, { col: '', name: '' }, { col: '', name: '' }];
        detectedVariants.slice(0, 3).forEach((col, i) => {
          slots[i] = { col, name: col };
        });
        setVariantOptions(slots);

        setMapping(autoMap);
        setFile(f);
        setStep(1);
      } catch (err) {
        setError('Kunde inte läsa filen. Kontrollera att det är en giltig CSV eller Excel-fil.');
      }
    };
    reader.readAsArrayBuffer(f);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) parseFile(f);
  }, [parseFile]);

  const handleFileChange = (e) => {
    if (e.target.files[0]) parseFile(e.target.files[0]);
  };

  const setVariantSlot = (index, col) => {
    setVariantOptions(prev => {
      const next = [...prev];
      next[index] = { col, name: col || '' };
      return next;
    });
  };

  const setVariantName = (index, name) => {
    setVariantOptions(prev => {
      const next = [...prev];
      next[index] = { ...next[index], name };
      return next;
    });
  };

  const clearVariantSlot = (index) => {
    setVariantOptions(prev => {
      const next = [...prev];
      next[index] = { col: '', name: '' };
      return next;
    });
  };

  const addMapping = (col, field) => {
    if (!field) return;
    if (field === NEW_METAFIELD_SENTINEL) {
      setCreatingMeta(col);
      setNewMeta({ name: '', key: '', namespace: 'custom', field_type: 'single_line_text' });
      return;
    }
    setMapping(prev => {
      const existing = prev[col] || [];
      if (existing.includes(field)) return prev;
      return { ...prev, [col]: [...existing, field] };
    });
  };

  const removeMapping = (col, field) => {
    setMapping(prev => {
      const updated = (prev[col] || []).filter(f => f !== field);
      return { ...prev, [col]: updated };
    });
  };

  const goToPreview = () => {
    const built = buildProducts(rows, mapping, groupCol, variantOptions);
    setPreview(built);
    setStep(2);
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const products = overrideVendor.trim()
        ? preview.map(p => ({ ...p, vendor: overrideVendor.trim() }))
        : preview;

      const res = await fetch(`${API_URL}/db/products/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products,
          supplierName: saveMapping ? supplierName : null,
          mapping: saveMapping ? mapping : null,
          groupCol: saveMapping ? groupCol : null,
          variantOptions: saveMapping ? variantOptions : null,
          headers: saveMapping ? headers : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import misslyckades');
      setResult(data);
      setStep(3);
      if (onImportComplete) onImportComplete(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const variantColsSet = new Set(variantOptions.map(v => v.col).filter(Boolean));
  const allMappedFields = Object.values(mapping).flat();
  const hasTitleMapping = allMappedFields.includes('title') || !!groupCol;

  const allFields = [
    ...PIM_FIELDS,
    ...metaDefs.map(d => ({
      key: `metafield:${d.namespace}.${d.key}`,
      label: d.name,
      group: 'Metafält',
    })),
    { key: NEW_METAFIELD_SENTINEL, label: '➕ Skapa nytt metafält...', group: 'Metafält' },
  ];
  const fieldGroups = allFields.reduce((acc, f) => {
    if (!acc[f.group]) acc[f.group] = [];
    acc[f.group].push(f);
    return acc;
  }, {});

  // Columns available for variant selection (not already used as group or another variant)
  const availableForVariant = (slotIndex) =>
    headers.filter(h =>
      h !== groupCol &&
      !variantOptions.some((v, i) => i !== slotIndex && v.col === h)
    );

  return (
    <div className="product-import">
      <div className="import-header">
        <div>
          <h2>Importera produkter</h2>
          <p>CSV eller Excel-fil från leverantör</p>
        </div>
        {onClose && (
          <button className="btn btn-ghost" onClick={onClose}><X size={18} /></button>
        )}
      </div>

      <div className="import-steps">
        {STEPS.map((s, i) => (
          <div key={i} className={`import-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
            <div className="step-circle">
              {i < step ? <Check size={14} /> : i + 1}
            </div>
            <span>{s}</span>
            {i < STEPS.length - 1 && <ChevronRight size={14} className="step-sep" />}
          </div>
        ))}
      </div>

      <div className="import-body">

        {/* STEP 0: Upload */}
        {step === 0 && (
          <div
            className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.tsv" hidden onChange={handleFileChange} />
            <FileSpreadsheet size={48} style={{ marginBottom: '16px', opacity: 0.5 }} />
            <h3>Dra och släpp din fil här</h3>
            <p>eller klicka för att välja fil</p>
            <p className="drop-formats">CSV, Excel (.xlsx, .xls), TSV</p>
            {error && (
              <div className="import-error">
                <AlertCircle size={16} /> {error}
              </div>
            )}
          </div>
        )}

        {/* STEP 1: Map columns */}
        {step === 1 && (
          <div className="mapping-step">
            {matchedProfile && (
              <div className="mapping-info" style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.3)', color: 'var(--success, #16a34a)' }}>
                <Check size={14} />
                <span>
                  Leverantörsprofil <strong>"{matchedProfile.supplier_name}"</strong> kändes igen och tillämpades automatiskt.
                </span>
              </div>
            )}
            <div className="mapping-info">
              <Info size={14} />
              <span>
                Filen har <strong>{headers.length} kolumner</strong> och <strong>{rows.length} rader</strong>.
                Välj grupperingskolumn och variantkolumner nedan, mappa sedan övriga kolumner.
              </span>
            </div>

            {/* Grouping + Variant structure */}
            <div className="variant-structure-section">
              <div className="variant-structure-header">
                <Layers size={15} />
                <span>Produktstruktur</span>
              </div>

              {/* Grouping column */}
              <div className="group-col-row">
                <div className="group-col-label">
                  <GitBranch size={13} />
                  <span>Gruppera rader till produkter efter</span>
                </div>
                <select
                  className="form-input group-col-select"
                  value={groupCol}
                  onChange={e => setGroupCol(e.target.value)}
                >
                  <option value="">— Ingen gruppering (en rad = en produkt) —</option>
                  {headers.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                {groupCol && rows.length > 0 && (
                  <span className="group-col-preview">
                    {[...new Set(rows.map(r => String(r[groupCol] ?? '')).filter(Boolean))].length} unika produkter
                  </span>
                )}
              </div>

              {/* Variant option slots */}
              <div className="variant-slots-label">
                <Tag size={13} />
                <span>Variantalternativ (max 3) — välj kolumner vars värden skapar varianter</span>
              </div>
              <div className="variant-slots">
                {[0, 1, 2].map(i => {
                  const slot = variantOptions[i];
                  const analysis = slot.col ? colAnalysis[slot.col] : null;
                  const distinctVals = analysis?.distinctValues || [];
                  return (
                    <div key={i} className={`variant-slot ${slot.col ? 'filled' : 'empty'}`}>
                      <div className="variant-slot-header">
                        <span className="variant-slot-num">Alt {i + 1}</span>
                        {slot.col && (
                          <button className="variant-slot-clear" onClick={() => clearVariantSlot(i)}>
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      <select
                        className="form-input variant-slot-col"
                        value={slot.col}
                        onChange={e => setVariantSlot(i, e.target.value)}
                      >
                        <option value="">+ Välj kolumn...</option>
                        {availableForVariant(i).map(h => {
                          const a = colAnalysis[h];
                          const hint = a?.role === 'variant' ? ' ↕ varierar' : a?.role === 'meta' ? ' = konstant' : '';
                          return <option key={h} value={h}>{h}{hint}</option>;
                        })}
                      </select>
                      {slot.col && (
                        <>
                          <input
                            className="form-input variant-slot-name"
                            placeholder="Namn (visas i Shopify)"
                            value={slot.name}
                            onChange={e => setVariantName(i, e.target.value)}
                          />
                          {distinctVals.length > 0 && (
                            <div className="variant-slot-values">
                              {distinctVals.slice(0, 6).map(v => (
                                <span key={v} className="variant-slot-value-chip">{v}</span>
                              ))}
                              {distinctVals.length > 6 && <span className="variant-slot-more">+{distinctVals.length - 6}</span>}
                            </div>
                          )}
                          {analysis?.role === 'meta' && (
                            <div className="variant-slot-warning">
                              <AlertCircle size={11} /> Konstant per produkt — kanske passar bättre som metafält
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {variantColsSet.size > 0 && groupCol && (
                <div className="variant-preview-stat">
                  {(() => {
                    const built = buildProducts(rows, mapping, groupCol, variantOptions);
                    const totalVariants = built.reduce((s, p) => s + p.variants.length, 0);
                    const maxPerProduct = Math.max(...built.map(p => p.variants.length));
                    return `${built.length} produkter · ${totalVariants} varianter totalt · max ${maxPerProduct} per produkt`;
                  })()}
                </div>
              )}
            </div>

            {/* Mapping table */}
            <div className="mapping-table-wrap">
              <table className="mapping-table">
                <thead>
                  <tr>
                    <th>Kolumn i filen</th>
                    <th>Exempel</th>
                    <th>Analys</th>
                    <th>Mappar till PIM-fält</th>
                  </tr>
                </thead>
                <tbody>
                  {headers.map(col => {
                    const isGroupCol = col === groupCol;
                    const variantSlotIdx = variantOptions.findIndex(v => v.col === col);
                    const isVariantCol = variantSlotIdx >= 0;
                    const analysis = colAnalysis[col];
                    const isMapped = (mapping[col]?.length > 0) || isGroupCol || isVariantCol;

                    return (
                      <React.Fragment key={col}>
                        <tr className={isMapped ? 'mapped' : ''}>
                          <td className="col-name">{col}</td>
                          <td className="col-example">
                            {String(rows[0]?.[col] ?? '').slice(0, 60)}
                          </td>
                          <td className="col-analysis">
                            {isGroupCol && (
                              <span className="analysis-badge badge-group"><GitBranch size={10} /> Gruppering</span>
                            )}
                            {isVariantCol && (
                              <span className="analysis-badge badge-variant"><Tag size={10} /> Alt {variantSlotIdx + 1}</span>
                            )}
                            {!isGroupCol && !isVariantCol && analysis?.role === 'variant' && (
                              <span className="analysis-badge badge-suggest-variant">↕ varierar</span>
                            )}
                            {!isGroupCol && !isVariantCol && analysis?.role === 'meta' && (
                              <span className="analysis-badge badge-suggest-meta">= konstant</span>
                            )}
                          </td>
                          <td>
                            {isGroupCol || isVariantCol ? (
                              <span className="col-reserved">
                                {isGroupCol ? 'Används för gruppering' : `Variantalternativ ${variantSlotIdx + 1}`}
                              </span>
                            ) : (
                              <div className="mapping-cell">
                                <div className="mapping-chips">
                                  {(mapping[col] || []).map(field => {
                                    const def = allFields.find(f => f.key === field);
                                    return (
                                      <span key={field} className="mapping-chip">
                                        {def?.label || field}
                                        <button onClick={() => removeMapping(col, field)} title="Ta bort">
                                          <X size={11} />
                                        </button>
                                      </span>
                                    );
                                  })}
                                </div>
                                <select
                                  className="form-input mapping-select-add"
                                  value=""
                                  onChange={e => addMapping(col, e.target.value)}
                                >
                                  <option value="">+ Lägg till mappning...</option>
                                  {Object.entries(fieldGroups).map(([group, fields]) => (
                                    group === '' ? (
                                      fields.filter(f => f.key).map(f =>
                                        <option key={f.key} value={f.key}>{f.label}</option>
                                      )
                                    ) : (
                                      <optgroup key={group} label={group}>
                                        {fields.map(f =>
                                          <option key={f.key} value={f.key}>{f.label}</option>
                                        )}
                                      </optgroup>
                                    )
                                  ))}
                                </select>
                              </div>
                            )}
                          </td>
                        </tr>
                        {creatingMeta === col && (
                          <tr className="new-metafield-row">
                            <td colSpan={4}>
                              <div className="new-metafield-form">
                                <div className="new-metafield-title">
                                  <Plus size={14} /> Skapa nytt metafält för <strong>{col}</strong>
                                </div>
                                <div className="new-metafield-fields">
                                  <div className="form-group">
                                    <label className="form-label">Namn</label>
                                    <input
                                      className="form-input"
                                      placeholder="t.ex. Material"
                                      value={newMeta.name}
                                      onChange={e => setNewMeta(p => ({
                                        ...p,
                                        name: e.target.value,
                                        key: p.key || e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
                                      }))}
                                    />
                                  </div>
                                  <div className="form-group">
                                    <label className="form-label">Nyckel</label>
                                    <input
                                      className="form-input"
                                      value={newMeta.key}
                                      onChange={e => setNewMeta(p => ({ ...p, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))}
                                    />
                                  </div>
                                  <div className="form-group">
                                    <label className="form-label">Namespace</label>
                                    <input
                                      className="form-input"
                                      value={newMeta.namespace}
                                      onChange={e => setNewMeta(p => ({ ...p, namespace: e.target.value }))}
                                    />
                                  </div>
                                  <div className="form-group">
                                    <label className="form-label">Typ</label>
                                    <select
                                      className="form-input"
                                      value={newMeta.field_type}
                                      onChange={e => setNewMeta(p => ({ ...p, field_type: e.target.value }))}
                                    >
                                      {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                  </div>
                                </div>
                                <div className="new-metafield-actions">
                                  <button className="btn btn-ghost btn-sm" onClick={() => setCreatingMeta(null)}>Avbryt</button>
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={!newMeta.name || !newMeta.key || savingMeta}
                                    onClick={() => handleCreateMetafield(col)}
                                  >
                                    {savingMeta ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                                    Skapa & mappa
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mapping-footer">
              <div className="save-mapping-row">
                <label className="checkbox-label">
                  <input type="checkbox" checked={saveMapping} onChange={e => setSaveMapping(e.target.checked)} />
                  Spara mappning som leverantörsprofil
                </label>
                {saveMapping && (
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Leverantörsnamn"
                    value={supplierName}
                    onChange={e => setSupplierName(e.target.value)}
                    style={{ maxWidth: '220px' }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {!hasTitleMapping && (
                  <span className="mapping-warning"><AlertCircle size={14} /> Välj grupperingskolumn eller mappa Titel</span>
                )}
                <button className="btn btn-secondary" onClick={() => setStep(0)}>Tillbaka</button>
                <button
                  className="btn btn-primary"
                  onClick={goToPreview}
                  disabled={!hasTitleMapping}
                >
                  Förhandsgranska <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: Preview */}
        {step === 2 && (
          <div className="preview-step">
            <div className="preview-summary">
              <div className="summary-stat">
                <span className="stat-value">{preview.length}</span>
                <span className="stat-label">produkter</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value">{preview.reduce((s, p) => s + p.variants.length, 0)}</span>
                <span className="stat-label">varianter</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value">{variantOptions.filter(v => v.col).length}</span>
                <span className="stat-label">variantalternativ</span>
              </div>
              {preview.filter(p => !p.title).length > 0 && (
                <div className="summary-stat error">
                  <span className="stat-value">{preview.filter(p => !p.title).length}</span>
                  <span className="stat-label">saknar titel</span>
                </div>
              )}
            </div>

            <div className="preview-table-wrap">
              <table className="margin-table">
                <thead>
                  <tr>
                    <th>Titel</th>
                    <th>Varumärke</th>
                    <th>SKU</th>
                    {variantOptions.filter(v => v.col).map((v, i) => (
                      <th key={i}>{v.name || `Alt ${i + 1}`}</th>
                    ))}
                    <th className="num">Pris</th>
                    <th className="num">Inköpspris</th>
                    <th className="num">Varianter</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 50).map((p, i) => (
                    <tr key={i}>
                      <td>{p.title || <span style={{ color: 'var(--error)' }}>Saknas</span>}</td>
                      <td>{p.vendor}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{p.variants[0]?.sku}</td>
                      {variantOptions.filter(v => v.col).map((v, vi) => {
                        const vals = [...new Set(p.variants.map(vr => [vr.option1Value, vr.option2Value, vr.option3Value][vi]).filter(Boolean))];
                        return <td key={vi} style={{ fontSize: '12px' }}>{vals.join(', ') || '—'}</td>;
                      })}
                      <td className="num">{p.variants[0]?.price != null ? `${p.variants[0].price} kr` : '—'}</td>
                      <td className="num">{p.variants[0]?.cost != null ? `${p.variants[0].cost} kr` : '—'}</td>
                      <td className="num">{p.variants.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.length > 50 && (
                <p style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Visar 50 av {preview.length} produkter.
                </p>
              )}
            </div>

            <div style={{ padding: '16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap' }}>
                Sätt Vendor på alla produkter:
              </label>
              <input
                type="text"
                value={overrideVendor}
                onChange={e => setOverrideVendor(e.target.value)}
                placeholder="t.ex. Lumeno Home (lämna tomt för att behålla från fil)"
                style={{ flex: 1, minWidth: '240px', padding: '7px 12px', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px' }}
              />
            </div>

            {error && <div className="import-error"><AlertCircle size={16} /> {error}</div>}

            <div className="preview-footer">
              <button className="btn btn-secondary" onClick={() => setStep(1)}>Tillbaka</button>
              <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                {importing
                  ? <><Loader2 size={16} className="spin" /> Importerar...</>
                  : `Importera ${preview.length} produkter`}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Done */}
        {step === 3 && result && (
          <div className="import-done">
            <div className="done-icon"><Check size={32} /></div>
            <h3>Import klar!</h3>
            <div className="done-stats">
              <div className="summary-stat">
                <span className="stat-value">{result.created ?? 0}</span>
                <span className="stat-label">skapade</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value">{result.updated ?? 0}</span>
                <span className="stat-label">uppdaterade</span>
              </div>
              {result.errors > 0 && (
                <div className="summary-stat error">
                  <span className="stat-value">{result.errors}</span>
                  <span className="stat-label">fel</span>
                </div>
              )}
            </div>
            {result.errorDetails?.length > 0 && (
              <div className="error-details">
                {result.errorDetails.map((e, i) => <p key={i}><AlertCircle size={12} /> {e}</p>)}
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
              <button className="btn btn-secondary" onClick={() => { setStep(0); setFile(null); setResult(null); }}>
                <RotateCcw size={16} /> Importera fler
              </button>
              {onClose && <button className="btn btn-primary" onClick={onClose}>Klar</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
