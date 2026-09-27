'use strict';

const express = require('express');
const { audit } = require('../audit');
const { num, str, oneOf, fmtNum } = require('../util');
const { requireUser, requirePerm } = require('../auth');
const { resolveOccurredAt } = require('../services/stock');

const TYPES = {
  preventiva: 'Manutenção preventiva',
  corretiva: 'Conserto / corretiva',
  limpeza: 'Limpeza',
  troca_peca: 'Troca de peça',
  outro: 'Outro',
};

module.exports = function maintenanceRoutes(db) {
  const r = express.Router();

  r.get('/maintenance', requireUser, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db
      .prepare(
        `SELECT m.*, u.name AS user_name FROM maintenance m JOIN users u ON u.id = m.user_id
          ORDER BY m.occurred_at DESC, m.id DESC LIMIT ? OFFSET ?`
      )
      .all(limit + 1, offset);
    res.json({
      types: TYPES,
      records: rows.slice(0, limit).map((x) => ({ ...x, type_label: TYPES[x.type] })),
      has_more: rows.length > limit,
    });
  });

  r.post('/maintenance', requirePerm('manutencao'), (req, res) => {
    const data = {
      machine: str(req.body.machine, 'a máquina', { max: 80 }) || 'Impressora',
      type: oneOf(req.body.type, 'tipo', Object.keys(TYPES)),
      description: str(req.body.description, 'o que foi feito', { required: true, max: 1000 }),
      downtime_minutes: num(req.body.downtime_minutes, 'tempo parada', { required: false, integer: true, min: 0, max: 100000 }),
      occurred_at: resolveOccurredAt(req.body.occurred_at, req.user),
    };
    const now = new Date().toISOString();
    const summary =
      `${TYPES[data.type]} — ${data.machine}: ${data.description}` +
      (data.downtime_minutes ? ` (máquina parada ${fmtNum(data.downtime_minutes)} min)` : '');
    const id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO maintenance (user_id, machine, type, description, downtime_minutes, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, data.machine, data.type, data.description, data.downtime_minutes, data.occurred_at, now);
      const newId = Number(info.lastInsertRowid);
      audit(db, { actor: req.user, action: 'manutencao', entity: 'maintenance', entityId: newId, summary, details: data, ip: req.ip });
      return newId;
    })();
    res.status(201).json({ id, summary });
  });

  return r;
};
