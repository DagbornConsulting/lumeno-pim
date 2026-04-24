import { parse } from 'csv-parse/sync';
import chardet from 'chardet';
import iconv from 'iconv-lite';

function detectSeparator(line) {
  const counts = {
    '\t': (line.match(/\t/g) || []).length,
    ';': (line.match(/;/g) || []).length,
    ',': (line.match(/,/g) || []).length,
  };
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : ',';
}

export function parseCsvBuffer(buffer) {
  const detectedEncoding = chardet.detect(buffer) || 'utf-8';
  const decoded = iconv.decode(buffer, detectedEncoding);

  const firstLine = decoded.split('\n')[0];
  const separator = detectSeparator(firstLine);

  const records = parse(decoded, {
    columns: true,
    delimiter: separator,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  return {
    headers,
    rows: records,
    encoding: detectedEncoding,
    separator: separator === '\t' ? 'tab' : separator,
    totalRows: records.length,
  };
}
