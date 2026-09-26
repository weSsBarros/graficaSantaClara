'use strict';

const express = require('express');
const { num } = require('../util');
const { requireUser, requirePerm } = require('../auth');
const orders = require('../services/orders');
const stock = require('../services/stock');

module.exports = function orderRoutes(db) {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip });
  const id = (req) => num(req.params.id, 'pedido', { integer: true });

  r.get('/orders', requireUser, (req, res) => {
    res.json(orders.listOrders(db, req.user, req.query));
  });

  r.get('/orders/:id', requireUser, (req, res) => {
    const order = orders.getOrder(db, req.user, id(req));
    const ops = stock.listOperations(db, req.user, { order_id: order.id, limit: 200 }).operations;
    res.json({ ...order, operations: ops });
  });

  r.post('/orders', requirePerm('pedidos'), (req, res) => {
    res.status(201).json(orders.createOrder(db, req.user, req.body, ctx(req)));
  });

  r.put('/orders/:id', requirePerm('pedidos'), (req, res) => {
    res.json(orders.updateOrder(db, req.user, id(req), req.body, ctx(req)));
  });

  r.post('/orders/:id/ship', requirePerm('entrega'), (req, res) => {
    res.json(orders.shipOrder(db, req.user, id(req), req.body, ctx(req)));
  });

  r.post('/orders/:id/deliver', requirePerm('entrega'), (req, res) => {
    res.json(orders.deliverOrder(db, req.user, id(req), req.body, ctx(req)));
  });

  r.post('/orders/:id/cancel', requirePerm('pedidos'), (req, res) => {
    res.json(orders.cancelOrder(db, req.user, id(req), req.body, ctx(req)));
  });

  r.get('/clients', requireUser, (req, res) => {
    res.json(orders.listClients(db, { q: req.query.q, all: req.query.all === '1' }));
  });

  r.post('/clients', requirePerm('pedidos'), (req, res) => {
    const newId = orders.createClient(db, req.user, req.body, ctx(req));
    res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(newId));
  });

  r.put('/clients/:id', requirePerm('pedidos'), (req, res) => {
    const clientId = num(req.params.id, 'cliente', { integer: true });
    orders.updateClient(db, req.user, clientId, req.body, ctx(req));
    res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId));
  });

  return r;
};
