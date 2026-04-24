import XLSX from 'xlsx';

export function parseExcelBuffer(buffer, options = {}) {
  const { sheetIndex = 0, headerRow = 1 } = options;

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[sheetIndex];
  if (!sheetName) {
    throw new Error(`Sheet index ${sheetIndex} finns inte. Tillgängliga: ${workbook.SheetNames.join(', ')}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (jsonData.length < headerRow) {
    throw new Error(`Filen har bara ${jsonData.length} rader, header-rad ${headerRow} finns inte`);
  }

  const headers = jsonData[headerRow - 1].map(h => String(h).trim());
  const rows = [];

  for (let i = headerRow; i < jsonData.length; i++) {
    const row = {};
    let hasData = false;
    headers.forEach((header, idx) => {
      const val = jsonData[i][idx];
      row[header] = val !== undefined && val !== null ? String(val).trim() : '';
      if (row[header]) hasData = true;
    });
    if (hasData) rows.push(row);
  }

  return {
    headers,
    rows,
    sheetName,
    sheetCount: workbook.SheetNames.length,
    sheetNames: workbook.SheetNames,
    totalRows: rows.length,
  };
}
