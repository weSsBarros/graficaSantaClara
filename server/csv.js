'use strict';

// CSV no padrão que o Excel em português abre direto: separador ";",
// decimal com vírgula e BOM UTF-8 para os acentos aparecerem certos.

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  let s = String(v);
  // Evita que um texto digitado (ex.: nome de cliente "=...") vire fórmula ao abrir no Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(';')];
  for (const r of rows) lines.push(r.map(cell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(headers, rows));
}

module.exports = { toCsv, sendCsv };
