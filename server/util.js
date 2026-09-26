'use strict';

const config = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DAY_MS = 86400000;
const offsetMs = () => config.utcOffsetHours * 3600000;

function nowIso() {
  return new Date().toISOString();
}

/** Data local (fuso da gráfica) no formato YYYY-MM-DD. */
function localDate(value = new Date()) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return new Date(t + offsetMs()).toISOString().slice(0, 10);
}

/** Início do dia local (YYYY-MM-DD) convertido para ISO UTC. */
function localDayStartIso(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetMs()).toISOString();
}

/** ISO UTC -> "dd/mm/aaaa hh:mm" no horário local. */
function fmtLocalDateTime(iso) {
  if (!iso) return '';
  const s = new Date(Date.parse(iso) + offsetMs()).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Modificador do SQLite para converter UTC -> horário local, ex.: '-3 hours'. */
function sqlOffset() {
  return `${config.utcOffsetHours >= 0 ? '+' : ''}${config.utcOffsetHours} hours`;
}

/**
 * Converte "YYYY-MM-DDTHH:MM" (horário local, vindo de <input type=datetime-local>)
 * para ISO UTC. Aceita também ISO completo com fuso.
 */
function parseLocalDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '00', s = '00'] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - offsetMs()).toISOString();
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
function fmtNum(n) {
  return nf.format(n);
}

function plural(unit, n) {
  if (!unit) return '';
  if (Math.abs(n) === 1) return unit;
  if (unit.length <= 2 || /[^a-zà-ú]$/i.test(unit)) return unit;
  if (/[aeiouáéíóú]$/i.test(unit)) return `${unit}s`;
  if (/m$/i.test(unit)) return `${unit.slice(0, -1)}ns`;
  if (/[rz]$/i.test(unit)) return `${unit}es`;
  if (/l$/i.test(unit)) return `${unit.slice(0, -1)}is`;
  return unit;
}

function fmtQty(n, unit) {
  return `${fmtNum(n)} ${plural(unit, n)}`.trim();
}

/** Quantidade de um item com a embalagem entre parênteses, ex.: "5.000 folhas (10 resmas)". */
function fmtItemQty(item, n) {
  let s = fmtQty(n, item.unit);
  if (item.pack_unit && item.pack_size > 0) {
    const packs = n / item.pack_size;
    s += ` (${fmtQty(Math.round(packs * 100) / 100, item.pack_unit)})`;
  }
  return s;
}

// ---- validação ----

function num(value, field, { min = -Infinity, max = 1e12, integer = false, required = true, positive = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `Informe ${field}.`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw new HttpError(400, `${field}: número inválido.`);
  if (integer && !Number.isInteger(n)) throw new HttpError(400, `${field}: use um número inteiro.`);
  if (positive && n <= 0) throw new HttpError(400, `${field}: deve ser maior que zero.`);
  if (n < min) throw new HttpError(400, `${field}: mínimo ${fmtNum(min)}.`);
  if (n > max) throw new HttpError(400, `${field}: máximo ${fmtNum(max)}.`);
  return n;
}

function str(value, field, { max = 500, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field}: texto inválido.`);
  const s = value.trim();
  if (required && !s) throw new HttpError(400, `Informe ${field}.`);
  if (s.length > max) throw new HttpError(400, `${field}: máximo de ${max} caracteres.`);
  return s || null;
}

function oneOf(value, field, options) {
  if (!options.includes(value)) throw new HttpError(400, `${field}: valor inválido.`);
  return value;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

module.exports = {
  HttpError,
  DAY_MS,
  nowIso,
  localDate,
  localDayStartIso,
  fmtLocalDateTime,
  addDays,
  sqlOffset,
  parseLocalDateTime,
  round3,
  fmtNum,
  fmtQty,
  fmtItemQty,
  plural,
  num,
  str,
  oneOf,
  bool,
};
