'use strict';

const express = require('express');
const { audit, diff } = require('../audit');
const { HttpError, nowIso, num, str, oneOf, bool } = require('../util');
const { requireUser, requirePerm } = require('../auth');
const { isManager } = require('../permissions');
const { itemsWithForecast } = require('../services/forecast');
const { itemHistory } = require('../services/dashboard');
const stock = require('../services/stock');

const CATEGORIES = ['papel', 'tinta', 'embalagem', 'outro'];
const FIELD_LABELS = {
  name: 'nome',
  category: 'categoria',
  source: 'origem',
  unit: 'unidade',
  pack_unit: 'embalagem',
  pack_size: 'qtd. por embalagem',
  min_stock: 'estoque mínimo',
  lead_time_days: 'prazo de reposição',
  notes: 'observações',
  active: 'ativo',
  sort_order: 'ordem',
};
const FIELDS = Object.keys(FIELD_LABELS);

function readItem(body) {
  const packUnit = str(body.pack_unit, 'embalagem', { max: 20 });
  const packSize = num(body.pack_size, 'quantidade por embalagem', { required: !!packUnit, positive: true, max: 1e7 });
  return {
    name: str(body.name, 'o nome do item', { required: true, max: 80 }),
    category: oneOf(body.category, 'categoria', CATEGORIES),
    source: oneOf(body.source || 'compra', 'origem', ['compra', 'producao']),
    unit: str(body.unit, 'a unidade (ex.: folha, litro)', { required: true, max: 20 }),
    pack_unit: packUnit,
    pack_size: packUnit ? packSize : null,
    min_stock: num(body.min_stock ?? 0, 'estoque mínimo', { min: 0, max: 1e9 }),
    lead_time_days: num(body.lead_time_days ?? 0, 'prazo de reposição', { integer: true, min: 0, max: 365 }),
    notes: str(body.notes, 'observações', { max: 500 }),
    active: body.active === undefined ? 1 : bool(body.active) ? 1 : 0,
    sort_order: num(body.sort_order ?? 0, 'ordem', { integer: true, min: -1000, max: 1000 }),
  };
}

function uniqueGuard(fn) {
  try {
    return fn();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um item com esse nome.');
    throw err;
  }
}

module.exports = function itemRoutes(db) {
  const r = express.Router();

  r.get('/items', requireUser, (req, res) => {
    const includeInactive = req.query.all === '1' && isManager(req.user);
    res.json(itemsWithForecast(db, { includeInactive }));
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
    res.json({ ...item, last_count: last || null });
  });

  r.get('/items/:id/history', requireUser, (req, res) => {
    const h = itemHistory(db, Number(req.params.id), { days: req.query.days });
    if (!h) throw new HttpError(404, 'Item não encontrado.');
    res.json(h);
  });

  r.post('/items', requirePerm('cadastros'), (req, res) => {
    const data = readItem(req.body);
    const initial = num(req.body.initial_quantity, 'estoque inicial', { required: false, min: 0, max: 1e9 }) || 0;
    const now = nowIso();
    const id = uniqueGuard(() =>
      db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO items (name, category, source, unit, pack_unit, pack_size, min_stock, lead_time_days, notes, active, sort_order, created_at, updated_at)
             VALUES (@name, @category, @source, @unit, @pack_unit, @pack_size, @min_stock, @lead_time_days, @notes, @active, @sort_order, @created_at, @updated_at)`
          )
          .run({ ...data, created_at: now, updated_at: now });
        const newId = Number(info.lastInsertRowid);
        audit(db, {
          actor: req.user, action: 'item_criado', entity: 'item', entityId: newId, ip: req.ip,
          summary: `Cadastrou o item "${data.name}" (${data.category}, unidade: ${data.unit}).`, details: data,
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
    const data = readItem({ ...before, ...req.body });
    const changes = diff(before, data, FIELDS);
    if (Object.keys(changes).length) {
      uniqueGuard(() =>
        db.transaction(() => {
          db.prepare(
            `UPDATE items SET name=@name, category=@category, source=@source, unit=@unit, pack_unit=@pack_unit,
                    pack_size=@pack_size, min_stock=@min_stock, lead_time_days=@lead_time_days, notes=@notes,
                    active=@active, sort_order=@sort_order, updated_at=@updated_at
              WHERE id=@id`
          ).run({ ...data, id: before.id, updated_at: nowIso() });
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
