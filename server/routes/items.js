'use strict';

const express = require('express');
const { audit, diff } = require('../audit');
const { HttpError, nowIso, num, str, oneOf, bool } = require('../util');
const { requireUser, requirePerm } = require('../auth');
const { isManager, can } = require('../permissions');
const { itemsWithForecast } = require('../services/forecast');
const { itemHistory } = require('../services/dashboard');
const stock = require('../services/stock');

const FIELD_LABELS = {
  name: 'nome',
  category: 'categoria',
  source: 'origem',
  unit: 'unidade',
  pack_unit: 'embalagem',
  pack_size: 'qtd. por embalagem',
  min_stock: 'avisar abaixo de',
  alert_days: 'avisar com dias de estoque',
  lead_time_days: 'prazo do fornecedor',
  notify: 'enviar aviso',
  model: 'modelo',
  size: 'formato',
  grammage: 'gramatura',
  color_name: 'cor',
  color_hex: 'código da cor',
  brand: 'marca',
  code: 'referência',
  barcode: 'código de barras',
  made_from_item_id: 'papel usado',
  yield_per_sheet: 'rende por folha',
  package_sizes: 'pacotes usuais',
  notes: 'observações',
  active: 'ativo',
  sort_order: 'ordem',
};
const FIELDS = Object.keys(FIELD_LABELS);

function readItem(db, body, selfId = null) {
  const packUnit = str(body.pack_unit, 'embalagem', { max: 20 });
  const packSize = num(body.pack_size, 'quantidade por embalagem', { required: !!packUnit, positive: true, max: 1e7 });
  const source = oneOf(body.source || 'compra', 'origem', ['compra', 'producao']);
  const colorHex = str(body.color_hex, 'código da cor', { max: 7 });
  if (colorHex && !/^#[0-9a-f]{6}$/i.test(colorHex)) throw new HttpError(400, 'Código da cor inválido (use o seletor de cor).');
  const madeFrom = source === 'producao' ? num(body.made_from_item_id, 'o papel usado', { integer: true, required: false }) : null;
  if (madeFrom) {
    const base = db.prepare('SELECT id FROM items WHERE id = ?').get(madeFrom);
    if (!base || madeFrom === selfId) throw new HttpError(400, 'Escolha um papel válido em "Feito com".');
  }
  const barcode = str(body.barcode, 'código de barras', { max: 64 });
  // Pacotes usuais no empacotamento, ex.: "150, 200".
  const packs = str(body.package_sizes, 'pacotes usuais', { max: 60 });
  const packageSizes = packs
    ? packs.split(/[,;\s]+/).filter(Boolean).map((n) => num(n.replace(',', '.'), 'pacotes usuais', { positive: true, max: 1e6 }))
    : [];
  if (packageSizes.length > 6) throw new HttpError(400, 'Informe no máximo 6 tamanhos de pacote.');
  return {
    name: str(body.name, 'o nome do item', { required: true, max: 80 }),
    category: oneOf(body.category, 'categoria', Object.keys(stock.CATEGORIES)),
    source,
    unit: str(body.unit, 'a unidade (ex.: folha, litro)', { required: true, max: 20 }),
    pack_unit: packUnit,
    pack_size: packUnit ? packSize : null,
    min_stock: num(body.min_stock ?? 0, 'avisar abaixo de', { min: 0, max: 1e9 }),
    alert_days: num(body.alert_days ?? 0, 'dias de estoque para avisar', { integer: true, min: 0, max: 365 }),
    lead_time_days: num(body.lead_time_days ?? 0, 'prazo do fornecedor', { integer: true, min: 0, max: 365 }),
    notify: body.notify === undefined ? 1 : bool(body.notify) ? 1 : 0,
    model: str(body.model, 'modelo', { max: 60 }),
    size: str(body.size, 'formato', { max: 30 }),
    grammage: num(body.grammage, 'gramatura', { required: false, positive: true, max: 2000 }),
    color_name: str(body.color_name, 'cor', { max: 40 }),
    color_hex: colorHex ? colorHex.toLowerCase() : null,
    brand: str(body.brand, 'marca', { max: 60 }),
    code: str(body.code, 'referência', { max: 60 }),
    barcode: barcode ? barcode.replace(/\s+/g, '') : null,
    made_from_item_id: madeFrom || null,
    yield_per_sheet: source === 'producao'
      ? num(body.yield_per_sheet ?? 1, 'quanto rende cada folha', { positive: true, max: 1000 })
      : 1,
    package_sizes: packageSizes.length ? [...new Set(packageSizes)].join(',') : null,
    notes: str(body.notes, 'observações', { max: 500 }),
    active: body.active === undefined ? 1 : bool(body.active) ? 1 : 0,
    sort_order: num(body.sort_order ?? 0, 'ordem', { integer: true, min: -1000, max: 1000 }),
  };
}

function uniqueGuard(fn) {
  try {
    return fn();
  } catch (err) {
    const m = String(err.message);
    if (m.includes('items.barcode')) throw new HttpError(409, 'Esse código de barras já está em outro item.');
    if (m.includes('UNIQUE')) throw new HttpError(409, 'Já existe um item com esse nome.');
    throw err;
  }
}

const COLS = FIELDS.join(', ');
const PARAMS = FIELDS.map((f) => `@${f}`).join(', ');
const SETS = FIELDS.map((f) => `${f}=@${f}`).join(', ');

function withCost(user, item) {
  if (can(user, 'ver_financeiro')) return item;
  const { last_unit_cost: _omit, ...rest } = item;
  return rest;
}

module.exports = function itemRoutes(db) {
  const r = express.Router();

  r.get('/items', requireUser, (req, res) => {
    const includeInactive = req.query.all === '1' && isManager(req.user);
    res.json(itemsWithForecast(db, { includeInactive }).map((i) => withCost(req.user, i)));
  });

  // Leitor de código de barras: acha o item pelo código.
  r.get('/items/barcode/:code', requireUser, (req, res) => {
    const row = db.prepare('SELECT id FROM items WHERE barcode = ?').get(String(req.params.code).replace(/\s+/g, ''));
    if (!row) throw new HttpError(404, 'Nenhum item com esse código de barras.');
    const [item] = itemsWithForecast(db, { ids: [row.id], includeInactive: true });
    res.json(withCost(req.user, item));
  });

  r.get('/items/:id', requireUser, (req, res) => {
    const [item] = itemsWithForecast(db, { ids: [Number(req.params.id)], includeInactive: true });
    if (!item) throw new HttpError(404, 'Item não encontrado.');
    const last = db
      .prepare(
        `SELECT o.occurred_at, u.name AS user_name FROM operations o JOIN movements m ON m.operation_id = o.id
           JOIN users u ON u.id = o.user_id
          WHERE m.item_id = ? AND o.type = 'ajuste' AND o.reversed_by_id IS NULL
          ORDER BY o.occurred_at DESC LIMIT 1`
      )
      .get(item.id);
    const madeFrom = item.made_from_item_id ? db.prepare('SELECT id, name FROM items WHERE id = ?').get(item.made_from_item_id) : null;
    res.json({ ...withCost(req.user, item), last_count: last || null, made_from: madeFrom || null });
  });

  r.get('/items/:id/history', requireUser, (req, res) => {
    const h = itemHistory(db, Number(req.params.id), { days: req.query.days });
    if (!h) throw new HttpError(404, 'Item não encontrado.');
    h.item = withCost(req.user, h.item);
    res.json(h);
  });

  r.post('/items', requirePerm('cadastros'), (req, res) => {
    const data = readItem(db, req.body);
    const initial = num(req.body.initial_quantity, 'estoque inicial', { required: false, min: 0, max: 1e9 }) || 0;
    const now = nowIso();
    const id = uniqueGuard(() =>
      db.transaction(() => {
        const info = db
          .prepare(`INSERT INTO items (${COLS}, created_at, updated_at) VALUES (${PARAMS}, @created_at, @updated_at)`)
          .run({ ...data, created_at: now, updated_at: now });
        const newId = Number(info.lastInsertRowid);
        audit(db, {
          actor: req.user, action: 'item_criado', entity: 'item', entityId: newId, ip: req.ip,
          summary: `Cadastrou o item "${data.name}" (${stock.CATEGORIES[data.category]}, unidade: ${data.unit}).`, details: data,
        });
        return newId;
      })()
    );
    if (initial > 0) {
      stock.ajuste(db, req.user, { item_id: id, counted: initial, note: 'Estoque inicial no cadastro' }, { ip: req.ip });
    }
    const [item] = itemsWithForecast(db, { ids: [id], includeInactive: true });
    res.status(201).json(item);
  });

  r.put('/items/:id', requirePerm('cadastros'), (req, res) => {
    const before = stock.getItem(db, Number(req.params.id));
    const data = readItem(db, { ...before, ...req.body }, before.id);
    const changes = diff(before, data, FIELDS);
    if (Object.keys(changes).length) {
      uniqueGuard(() =>
        db.transaction(() => {
          db.prepare(`UPDATE items SET ${SETS}, updated_at=@updated_at WHERE id=@id`).run({ ...data, id: before.id, updated_at: nowIso() });
          const desc = Object.entries(changes)
            .map(([k, [a, b]]) => `${FIELD_LABELS[k]}: ${a ?? '—'} → ${b ?? '—'}`)
            .join('; ');
          audit(db, {
            actor: req.user, action: 'item_alterado', entity: 'item', entityId: before.id, ip: req.ip,
            summary: `Alterou o item "${data.name}": ${desc}.`, details: changes,
          });
        })()
      );
      stock.refreshAlerts(db, [before.id]);
    }
    const [item] = itemsWithForecast(db, { ids: [before.id], includeInactive: true });
    res.json(item);
  });

  return r;
};
