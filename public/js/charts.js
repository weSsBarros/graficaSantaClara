// Gráficos (Chart.js). Cores vêm das variáveis CSS, então claro/escuro funcionam juntos.
// Regras seguidas: linhas de 2px, barras finas (≤ 24px) com ponta arredondada,
// grade discreta, um só eixo Y por gráfico, legenda para 2+ séries e dica ao passar o dedo/mouse.
import { fmtNum, fmtCompact, fmtDay, plural, brl, fmtMonth } from './lib.js';

const registry = new Set();

export function destroyChart(chart) {
  if (!chart) return;
  chart.destroy();
  registry.delete(chart);
}

export function destroyCharts() {
  for (const c of registry) c.destroy();
  registry.clear();
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function theme() {
  return {
    text: css('--text'),
    text2: css('--text-2'),
    muted: css('--muted'),
    grid: css('--grid'),
    axis: css('--axis'),
    surface: css('--chart-surface'),
    border: css('--border'),
    s1: css('--series-1'),
    s2: css('--series-2'),
    ok: css('--good'),
    repor: css('--warning'),
    baixo: css('--serious'),
    zerado: css('--critical'),
  };
}

function alpha(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Linha vertical que acompanha o ponteiro (acha a data sem precisar acertar a linha).
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart, _args, opts) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || !active.length || opts.disabled) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const c = chart.ctx;
    c.save();
    c.strokeStyle = opts.color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, top);
    c.lineTo(Math.round(x) + 0.5, bottom);
    c.stroke();
    c.restore();
  },
};

function tooltipStyle(t) {
  return {
    backgroundColor: t.surface,
    titleColor: t.text2,
    bodyColor: t.text,
    borderColor: t.axis,
    borderWidth: 1,
    padding: 10,
    cornerRadius: 10,
    boxWidth: 14,
    boxHeight: 2,
    boxPadding: 6,
    titleFont: { weight: '600', size: 12 },
    bodyFont: { size: 13 },
    displayColors: true,
  };
}

function base(t) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    layout: { padding: { top: 6, right: 8 } },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: tooltipStyle(t),
      crosshair: { color: t.axis },
    },
  };
}

function axisX(t, { maxTicks = 8 } = {}) {
  return {
    grid: { display: false },
    border: { color: t.axis },
    ticks: { color: t.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: maxTicks, font: { size: 11 } },
  };
}

function axisY(t, { title } = {}) {
  return {
    beginAtZero: true,
    grid: { color: t.grid, drawTicks: false },
    border: { display: false },
    ticks: { color: t.muted, padding: 8, maxTicksLimit: 6, font: { size: 11 }, callback: (v) => fmtCompact(v) },
    title: title ? { display: true, text: title, color: t.muted, font: { size: 11 } } : undefined,
  };
}

function make(canvas, config) {
  if (!window.Chart) return null;
  window.Chart.defaults.font.family = css('--font');
  const chart = new window.Chart(canvas, { ...config, plugins: [...(config.plugins || []), crosshair] });
  registry.add(chart);
  return chart;
}

const line = (color, extra = {}) => ({
  borderColor: color,
  backgroundColor: color,
  borderWidth: 2,
  pointRadius: 0,
  pointHoverRadius: 5,
  pointHoverBorderWidth: 2,
  pointHoverBorderColor: css('--chart-surface'),
  borderCapStyle: 'round',
  borderJoinStyle: 'round',
  tension: 0,
  spanGaps: false,
  ...extra,
});

/** Produção diária: produzido x empacotado. */
export function productionChart(canvas, daily) {
  const t = theme();
  return make(canvas, {
    type: 'line',
    data: {
      labels: daily.map((d) => fmtDay(d.day)),
      datasets: [
        { label: 'Produzido', data: daily.map((d) => d.printed), ...line(t.s1) },
        { label: 'Empacotado', data: daily.map((d) => d.packed), ...line(t.s2) },
      ],
    },
    options: {
      ...base(t),
      scales: { x: axisX(t), y: axisY(t) },
      plugins: {
        ...base(t).plugins,
        tooltip: {
          ...tooltipStyle(t),
          callbacks: { label: (c) => ` ${fmtNum(c.parsed.y)} ${plural('folha', c.parsed.y)}  ·  ${c.dataset.label}` },
        },
      },
    },
  });
}

// Marca o prazo de reposição em cada barra do gráfico de cobertura.
const leadTicks = {
  id: 'leadTicks',
  afterDatasetsDraw(chart, _args, opts) {
    const meta = chart.getDatasetMeta(0);
    const x = chart.scales.x;
    const c = chart.ctx;
    c.save();
    c.strokeStyle = opts.color;
    c.lineWidth = 2;
    c.lineCap = 'round';
    meta.data.forEach((bar, i) => {
      const lead = opts.leads[i];
      if (!lead) return;
      const px = x.getPixelForValue(Math.min(lead, opts.cap));
      const h = (bar.height || 16) / 2 + 4;
      c.beginPath();
      c.moveTo(px, bar.y - h);
      c.lineTo(px, bar.y + h);
      c.stroke();
    });
    c.restore();
  },
};

/** Quantos dias o estoque de cada item dura no ritmo atual (barras horizontais). */
export function coverageChart(canvas, items, { cap: maxCap = 90 } = {}) {
  const t = theme();
  const rows = items.filter((i) => i.forecast.days_left !== null);
  // Escala até um pouco além do maior valor (ou do maior prazo de reposição), limitada a `maxCap` dias.
  const biggest = Math.max(10, ...rows.map((i) => Math.max(i.forecast.days_left, i.source === 'compra' ? i.lead_time_days : 0)));
  const cap = Math.min(maxCap, Math.ceil((biggest * 1.15) / 5) * 5);
  canvas.parentElement.style.height = `${Math.max(140, rows.length * 44 + 50)}px`;
  return make(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((i) => i.name),
      datasets: [
        {
          label: 'Dias de estoque',
          data: rows.map((i) => Math.min(i.forecast.days_left, cap)),
          backgroundColor: rows.map((i) => t[i.forecast.status]),
          hoverBackgroundColor: rows.map((i) => alpha(t[i.forecast.status], 0.8)),
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 22,
          categoryPercentage: 0.7,
          barPercentage: 1,
        },
      ],
    },
    options: {
      ...base(t),
      indexAxis: 'y',
      interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: {
        x: {
          ...axisY(t),
          max: cap,
          ticks: { ...axisY(t).ticks, callback: (v) => (v >= maxCap ? `${maxCap}+` : fmtNum(v)) },
          title: { display: true, text: 'dias', color: t.muted, font: { size: 11 } },
        },
        y: {
          grid: { display: false },
          border: { color: t.axis },
          ticks: {
            color: t.text2,
            font: { size: 12 },
            // No celular, encurta nomes longos para não cortar o texto.
            callback: (_v, i) => {
              const max = canvas.clientWidth < 520 ? 14 : 32;
              const name = rows[i].name;
              return name.length > max ? `${name.slice(0, max - 1)}…` : name;
            },
          },
        },
      },
      plugins: {
        ...base(t).plugins,
        crosshair: { disabled: true },
        leadTicks: { color: t.text2, leads: rows.map((i) => (i.source === 'compra' ? i.lead_time_days : 0)), cap },
        tooltip: {
          ...tooltipStyle(t),
          displayColors: false,
          callbacks: {
            title: (c) => rows[c[0].dataIndex].name,
            label: (c) => {
              const it = rows[c.dataIndex];
              const d = it.forecast.days_left;
              if (d > maxCap) return ` Mais de ${maxCap} dias`;
              if (d < 1) return ' Menos de 1 dia';
              return ` ~${fmtNum(Math.floor(d), 0)} dias (até ${fmtDay(it.forecast.runout_date)})`;
            },
            afterLabel: (c) => {
              const it = rows[c.dataIndex];
              const out = [` ${it.forecast.status_label}`];
              if (it.source === 'compra' && it.lead_time_days) out.push(` Reposição leva ${it.lead_time_days} dias`);
              return out;
            },
          },
        },
      },
    },
    plugins: [leadTicks],
  });
}

/** Saldo do item ao longo do tempo + projeção até acabar + linha do estoque mínimo. */
export function stockChart(canvas, hist) {
  const t = theme();
  const { item, series, projection } = hist;
  const future = projection.slice(1);
  const labels = [...series.map((p) => p.day), ...future.map((p) => p.day)];
  const n = series.length;
  const balance = [...series.map((p) => p.balance), ...future.map(() => null)];
  const proj = labels.map((_, i) => (i === n - 1 && projection.length ? projection[0].balance : i >= n ? future[i - n].balance : null));
  const min = labels.map(() => item.min_stock || null);
  const unit = item.unit;
  return make(canvas, {
    type: 'line',
    data: {
      labels: labels.map(fmtDay),
      datasets: [
        { label: 'Saldo', data: balance, ...line(t.s1, { fill: 'origin', backgroundColor: alpha(t.s1, 0.1), tension: 0, stepped: false }) },
        { label: 'Previsão', data: proj, ...line(t.s1, { borderDash: [6, 5], borderWidth: 2, tension: 0 }) },
        { label: 'Estoque mínimo', data: min, ...line(t.baixo, { borderDash: [2, 4], borderWidth: 2, pointHoverRadius: 0, tension: 0 }) },
      ],
    },
    options: {
      ...base(t),
      scales: { x: axisX(t), y: axisY(t) },
      plugins: {
        ...base(t).plugins,
        tooltip: {
          ...tooltipStyle(t),
          filter: (c) => c.parsed.y !== null && !(c.datasetIndex === 1 && c.dataIndex === n - 1),
          callbacks: { label: (c) => ` ${fmtNum(c.parsed.y)} ${plural(unit, c.parsed.y)}  ·  ${c.dataset.label}` },
        },
      },
    },
  });
}

/** Consumo diário do item (barras). */
export function consumptionChart(canvas, hist) {
  const t = theme();
  const unit = hist.item.unit;
  return make(canvas, {
    type: 'bar',
    data: {
      labels: hist.series.map((p) => fmtDay(p.day)),
      datasets: [
        {
          label: 'Consumo',
          data: hist.series.map((p) => p.consumed),
          backgroundColor: t.s1,
          hoverBackgroundColor: alpha(t.s1, 0.75),
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 24,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        },
      ],
    },
    options: {
      ...base(t),
      scales: { x: axisX(t), y: axisY(t) },
      plugins: {
        ...base(t).plugins,
        crosshair: { disabled: true },
        tooltip: {
          ...tooltipStyle(t),
          displayColors: false,
          callbacks: { label: (c) => ` Consumo: ${fmtNum(c.parsed.y)} ${plural(unit, c.parsed.y)}` },
        },
      },
    },
  });
}

const moneyTick = (v) => (Math.abs(v) >= 1000 ? `R$ ${fmtCompact(v)}` : `R$ ${fmtNum(v, 0)}`);

/** Receitas x despesas por mês (barras lado a lado, mesmo eixo em R$). */
export function financeChart(canvas, monthly) {
  const t = theme();
  const bar = (color) => ({
    backgroundColor: color, hoverBackgroundColor: alpha(color, 0.8), borderRadius: 4, borderSkipped: 'start',
    maxBarThickness: 22, categoryPercentage: 0.7, barPercentage: 0.9,
  });
  return make(canvas, {
    type: 'bar',
    data: {
      labels: monthly.map((m) => fmtMonth(m.month, true)),
      datasets: [
        { label: 'Receitas', data: monthly.map((m) => m.receitas), ...bar(t.s1) },
        { label: 'Despesas', data: monthly.map((m) => m.despesas), ...bar(t.s2) },
      ],
    },
    options: {
      ...base(t),
      scales: { x: axisX(t, { maxTicks: 12 }), y: { ...axisY(t), ticks: { ...axisY(t).ticks, callback: moneyTick } } },
      plugins: {
        ...base(t).plugins,
        crosshair: { disabled: true },
        tooltip: {
          ...tooltipStyle(t),
          boxHeight: 10,
          callbacks: {
            title: (c) => fmtMonth(monthly[c[0].dataIndex].month),
            label: (c) => ` ${brl(c.parsed.y)}  ·  ${c.dataset.label}`,
            footer: (c) => {
              const m = monthly[c[0].dataIndex];
              return `Resultado: ${brl(m.receitas - m.despesas)}`;
            },
          },
        },
      },
    },
  });
}

/** Despesas do mês por categoria (barras horizontais, uma série). */
export function categoryChart(canvas, rows) {
  const t = theme();
  canvas.parentElement.style.height = `${Math.max(120, rows.length * 38 + 40)}px`;
  return make(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        label: 'Despesas', data: rows.map((r) => r.total), backgroundColor: t.s2, hoverBackgroundColor: alpha(t.s2, 0.8),
        borderRadius: 4, borderSkipped: 'start', maxBarThickness: 20, categoryPercentage: 0.75, barPercentage: 1,
      }],
    },
    options: {
      ...base(t),
      indexAxis: 'y',
      interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: {
        x: { ...axisY(t), ticks: { ...axisY(t).ticks, callback: moneyTick } },
        y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2, font: { size: 12 } } },
      },
      plugins: {
        ...base(t).plugins,
        crosshair: { disabled: true },
        tooltip: { ...tooltipStyle(t), displayColors: false, callbacks: { label: (c) => ` ${brl(c.parsed.x)}` } },
      },
    },
  });
}

/** Produção por produto no período: produzido x empacotado (barras horizontais lado a lado). */
export function productChart(canvas, rows) {
  const t = theme();
  canvas.parentElement.style.height = `${Math.max(140, rows.length * 52 + 40)}px`;
  const bar = (color) => ({
    backgroundColor: color, hoverBackgroundColor: alpha(color, 0.8), borderRadius: 4, borderSkipped: 'start',
    maxBarThickness: 16, categoryPercentage: 0.8, barPercentage: 0.9,
  });
  return make(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.name),
      datasets: [
        { label: 'Produzido', data: rows.map((r) => r.printed), ...bar(t.s1) },
        { label: 'Empacotado', data: rows.map((r) => r.packed), ...bar(t.s2) },
      ],
    },
    options: {
      ...base(t),
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      scales: {
        x: axisY(t),
        y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2, font: { size: 12 } } },
      },
      plugins: {
        ...base(t).plugins,
        crosshair: { disabled: true },
        tooltip: { ...tooltipStyle(t), boxHeight: 10, callbacks: { label: (c) => ` ${fmtNum(c.parsed.x)}  ·  ${c.dataset.label}` } },
      },
    },
  });
}
