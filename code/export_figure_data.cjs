// Seed-42 per-request data for the report figures, from the same engine the HTML inlines.
// Usage: node code/export_figure_data.cjs  -> submission/figure_data_20261120.json
'use strict';
const fs = require('fs'), path = require('path');
const H = path.join(__dirname, '..', 'html_sim'), OUT = fs.existsSync(path.join(__dirname, '..', 'submission')) ? path.join(__dirname, '..', 'submission') : path.join(__dirname, '..');  // ponytail: repo layout, else the submission zip root
const Sim = require(H + '/sim-engine.js'), Obs = require(H + '/observed-model.js'), KPI = require(H + '/kpi-metrics.js');
const data = JSON.parse(fs.readFileSync(H + '/data.json', 'utf8'));
const START = 30000, END = 63000, SEED = 42;

const plan = Obs.createDemandPlan(data, { profile: 'activity_reference', seed: SEED });
const inWindow = plan.rows.filter(r => START <= r.ready && r.ready < END);
const bins = [];
for (let t = START; t < END; t += 300) bins.push({ t,
  UP: inWindow.filter(r => r.origin.startsWith('U') && t <= r.ready && r.ready < t + 300).length,
  DOWN: inWindow.filter(r => r.origin.startsWith('D') && t <= r.ready && r.ready < t + 300).length });

const scenarios = {};
for (const id of ['S0', 'S2', 'S1', 'S5']) {
  const r = Sim.simulate({ ...data, demand: plan.rows }, { ...Sim.getScenarioDefaults(id), seed: SEED });
  const k = KPI.calculate(r);
  const out = r.outcomes.filter(o => START <= o.ready && o.ready < END);
  const waits = out.filter(o => o.boarded != null).map(o => (o.boarded - o.ready) / 60);
  const byStop = {};
  for (const o of out) {
    const s = byStop[o.origin] || (byStop[o.origin] = { n: 0, boarded: 0, sum: 0, over10: 0 });
    s.n++; if (o.boarded != null) { s.boarded++; s.sum += (o.boarded - o.ready) / 60; if (o.boarded - o.ready > 600) s.over10++; }
  }
  for (const s of Object.values(byStop)) s.meanWait = s.boarded ? s.sum / s.boarded : null;
  // waiting count just before each U01 departure in 11:30-13:00 (boarded + left behind), for the lunch observation check
  const lunchPre = r.events.filter(e => e.stop === 'U01' && e.event === 'departure' && 41400 <= e.t && e.t < 46800).map(e => (e.board || 0) + (e.queue || 0));
  scenarios[id] = { waits, byStop, lunchPreDepartureU01: lunchPre, maxQueueByStop: Object.fromEntries(Object.entries(k.maximumQueueByStop).map(([s, v]) => [s, v.count])) };
}
// demand.csv: the seed-42 requests every scenario receives; all rows are estimated (built to match aggregate observations).
const hms = s => [s / 3600, s % 3600 / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':');
const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
fs.writeFileSync(path.join(OUT, 'demand.csv'), '﻿request_id,origin,destination,ready_time,ready_seconds,source,reason\n' +
  plan.rows.slice().sort((a, b) => a.ready - b.ready).map(r => [r.id, r.origin, r.destination, hms(Math.round(r.ready)), Math.round(r.ready), 'estimated', r.reason || r.activityCategory || ''].map(csvCell).join(',')).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'figure_data_20261120.json'), JSON.stringify({ seed: SEED, window: [START, END], demandBins: bins, scenarios }));
console.log('ok', bins.length, Object.keys(scenarios));
