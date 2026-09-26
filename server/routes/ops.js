'use strict';

const express = require('express');
const { num, localDate, localDayStartIso, addDays, fmtLocalDateTime } = require('../util');
const { requireUser, requirePerm } = require('../auth');
const { sendCsv } = require('../csv');
const stock = require('../services/stock');
const { dashboard } = require('../services/dashboard');

module.exports = function opsRoutes(db) {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip });

  r.get('/ops', requireUser, (req, res) => {
    res.json(stock.listOperations(db, req.user, req.query));
  });

  r.get('/ops/:id', requireUser, (req, res) => {
    res.json(stock.getOperation(db, num(req.params.id, 'lançamento', { integer: true }), req.user));
  });

  r.post('/ops/entrada', requirePerm('entrada'), (req, res) => {
    res.status(201).json(stock.entrada(db, req.user, req.body, ctx(req)));
  });

  r.post('/ops/retirada', requirePerm('retirada'), (req, res) => {
    res.status(201).json(stock.retirada(db, req.user, req.body, ctx(req)));
  });

  r.post('/ops/ajuste', requirePerm('ajuste'), (req, res) => {
    res.status(201).json(stock.ajuste(db, req.user, req.body, ctx(req)));
  });

  r.post('/ops/producao', requireUser, (req, res) => {
    res.status(201).json(stock.producao(db, req.user, req.body, ctx(req)));
  });

  r.post('/ops/:id/estorno', requireUser, (req, res) => {
    const id = num(req.params.id, 'lançamento', { integer: true });
    res.status(201).json(stock.estorno(db, req.user, id, req.body, ctx(req)));
  });

  // Exporta os movimentos de estoque (uma linha por item movimentado) para planilha.
  r.get('/export/movimentos.csv', requirePerm('ver_logs'), (req, res) => {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : localDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(to, -89);
    const rows = db
      .prepare(
        `SELECT o.id, o.occurred_at, o.created_at, o.type, u.name AS user_name, i.name AS item_name, i.unit,
                m.delta, m.balance_after, o.client, o.supplier, o.reason, o.note, o.summary,
                o.reversed_by_id, o.reverses_id
           FROM movements m
           JOIN operations o ON o.id = m.operation_id
           JOIN users u ON u.id = o.user_id
           JOIN items i ON i.id = m.item_id
          WHERE o.occurred_at >= ? AND o.occurred_at < ?
          ORDER BY o.occurred_at, o.id, m.id`
      )
      .all(localDayStartIso(from), localDayStartIso(addDays(to, 1)));
    const fmt = fmtLocalDateTime;
    sendCsv(
      res,
      `movimentos_${from}_a_${to}.csv`,
      ['Lançamento', 'Data do ocorrido', 'Registrado em', 'Tipo', 'Pessoa', 'Item', 'Unidade', 'Quantidade', 'Saldo após',
        'Cliente', 'Fornecedor', 'Motivo', 'Observação', 'Resumo', 'Estornado por', 'Estorna o lançamento'],
      rows.map((x) => [x.id, fmt(x.occurred_at), fmt(x.created_at), stock.TYPE_LABELS[x.type], x.user_name, x.item_name,
        x.unit, x.delta, x.balance_after, x.client, x.supplier, x.reason, x.note, x.summary, x.reversed_by_id, x.reverses_id])
    );
  });

  // Sugestões para os campos de texto (autocompletar).
  r.get('/suggestions', requireUser, (_req, res) => {
    const col = (c) =>
      db
        .prepare(
          `SELECT ${c} AS v, MAX(occurred_at) AS last FROM operations WHERE ${c} IS NOT NULL
            GROUP BY ${c} COLLATE NOCASE ORDER BY last DESC LIMIT 50`
        )
        .all()
        .map((x) => x.v);
    const machines = db
      .prepare('SELECT machine AS v, MAX(occurred_at) AS last FROM maintenance GROUP BY machine ORDER BY last DESC LIMIT 20')
      .all()
      .map((x) => x.v);
    res.json({ clients: col('client'), suppliers: col('supplier'), reasons: col('reason'), machines });
  });

  // Tela inicial: produção de hoje, meus últimos lançamentos e alertas.
  r.get('/home', requireUser, (req, res) => {
    const d = dashboard(db, { days: 1 });
    const mine = stock.listOperations(db, req.user, { user_id: req.user.id, limit: 8 });
    res.json({
      today: d.current,
      alerts: d.items.filter((i) => i.forecast.status !== 'ok'),
      my_operations: mine.operations,
    });
  });

  r.get('/dashboard', requireUser, (req, res) => {
    res.json(dashboard(db, { days: req.query.days }));
  });

  return r;
};
