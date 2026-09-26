'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { HttpError } = require('./util');
const { loadUser } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHART_JS = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
// Leitor de código de barras pela câmera (usado quando o navegador não tem BarcodeDetector).
const ZXING_JS = path.join(path.dirname(require.resolve('@zxing/library/package.json')), 'umd', 'index.min.js');

function securityHeaders(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

// Proteção CSRF: requisições que alteram dados precisam de um cabeçalho que só o
// próprio app envia (navegadores não deixam outro site mandar cabeçalhos customizados).
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'gsc') return next(new HttpError(403, 'Requisição recusada.'));
  next();
}

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(loadUser(db));
  api.use(csrfGuard);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(require('./routes/auth')(db));
  api.use(require('./routes/items')(db));
  api.use(require('./routes/ops')(db));
  api.use(require('./routes/maintenance')(db));
  api.use(require('./routes/orders')(db));
  api.use(require('./routes/finance')(db));
  api.use(require('./routes/admin')(db));
  api.use((_req, _res, next) => next(new HttpError(404, 'Rota não encontrada.')));
  app.use('/api', api);

  app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(CHART_JS, { maxAge: '7d' }));
  app.get('/vendor/zxing.min.js', (_req, res) => res.sendFile(ZXING_JS, { maxAge: '7d' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Dados inválidos.');
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`[erro] ${req.method} ${req.originalUrl}`, err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente de novo.' : err.message });
  });

  return app;
}

module.exports = { createApp };
