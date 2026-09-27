'use strict';

const express = require('express');
const { audit } = require('../audit');
const { HttpError, num, str, oneOf, bool, localDate } = require('../util');
const { requirePerm } = require('../auth');
const { sendCsv } = require('../csv');
const finance = require('../services/finance');

module.exports = function financeRoutes(db) {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip });
  const id = (req) => num(req.params.id, 'lançamento', { integer: true });
  const perm = requirePerm('financeiro'); // lançar e alterar
  const view = requirePerm('ver_financeiro'); // só ver

  r.get('/finance/summary', view, (req, res) => {
    res.json(finance.summary(db, { month: req.query.month }));
  });

  r.get('/finance/entries', view, (req, res) => {
    res.json(finance.listEntries(db, req.query));
  });

  r.post('/finance/entries', perm, (req, res) => {
    res.status(201).json(finance.createEntries(db, req.user, req.body, ctx(req)));
  });

  r.put('/finance/entries/:id', perm, (req, res) => {
    res.json(finance.updateEntry(db, req.user, id(req), req.body, ctx(req)));
  });

  r.post('/finance/entries/:id/pay', perm, (req, res) => {
    res.json(finance.payEntry(db, req.user, id(req), req.body, ctx(req)));
  });

  r.post('/finance/entries/:id/unpay', perm, (req, res) => {
    res.json(finance.unpayEntry(db, req.user, id(req), ctx(req)));
  });

  r.post('/finance/entries/:id/cancel', perm, (req, res) => {
    const reason = str(req.body.reason, 'o motivo', { required: true, max: 300 });
    res.json(db.transaction(() => finance.cancelEntry(db, req.user, id(req), reason, ctx(req)))());
  });

  r.get('/finance/categories', view, (_req, res) => {
    res.json({
      categories: db.prepare('SELECT * FROM finance_categories ORDER BY kind, active DESC, name').all(),
      payment_methods: finance.PAYMENT_METHODS,
    });
  });

  r.post('/finance/categories', perm, (req, res) => {
    const kind = oneOf(req.body.kind, 'tipo', ['despesa', 'receita']);
    const name = str(req.body.name, 'o nome da categoria', { required: true, max: 60 });
    try {
      const info = db.prepare('INSERT INTO finance_categories (kind, name) VALUES (?, ?)').run(kind, name);
      audit(db, { actor: req.user, action: 'financeiro_categoria', ip: req.ip, summary: `Criou a categoria de ${kind} "${name}".` });
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Essa categoria já existe.');
      throw err;
    }
  });

  r.put('/finance/categories/:id', perm, (req, res) => {
    const cat = db.prepare('SELECT * FROM finance_categories WHERE id = ?').get(Number(req.params.id));
    if (!cat) throw new HttpError(404, 'Categoria não encontrada.');
    const name = req.body.name === undefined ? cat.name : str(req.body.name, 'o nome', { required: true, max: 60 });
    const active = req.body.active === undefined ? cat.active : bool(req.body.active) ? 1 : 0;
    try {
      db.prepare('UPDATE finance_categories SET name = ?, active = ? WHERE id = ?').run(name, active, cat.id);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Essa categoria já existe.');
      throw err;
    }
    audit(db, {
      actor: req.user, action: 'financeiro_categoria', ip: req.ip,
      summary: `Alterou a categoria "${cat.name}"${name !== cat.name ? ` → "${name}"` : ''}${active !== cat.active ? (active ? ' (reativada)' : ' (desativada)') : ''}.`,
    });
    res.json({ ok: true });
  });

  r.get('/finance/entries.csv', view, (req, res) => {
    const { entries } = finance.listEntries(db, { ...req.query, limit: 100000 });
    const dmy = (d) => (d ? d.split('-').reverse().join('/') : '');
    sendCsv(
      res,
      `financeiro_${req.query.month || localDate()}.csv`,
      ['#', 'Tipo', 'Categoria', 'Descrição', 'Valor', 'Data', 'Vencimento', 'Pago em', 'Forma', 'Fornecedor/Cliente', 'Situação', 'Pedido', 'Observações'],
      entries.map((e) => [e.id, e.kind, e.category_name, e.description, e.amount, dmy(e.date), dmy(e.due_date), dmy(e.paid_at),
        e.payment_method, e.counterparty, e.status, e.order_id, e.notes])
    );
  });

  return r;
};
