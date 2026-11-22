// Seed repeat + sensitivity runs for the report, using the same engine/KPI files the HTML inlines.
// Usage: node code/run_sensitivity_20261120.cjs  -> submission/sensitivity_20261120.{csv,json}
'use strict';
const fs = require('fs'), path = require('path');
const H = path.join(__dirname, '..', 'html_sim'), OUT = fs.existsSync(path.join(__dirname, '..', 'submission')) ? path.join(__dirname, '..', 'submission') : path.join(__dirname, '..');  // ponytail: repo layout, else the submission zip root
const Sim = require(H + '/sim-engine.js'), Obs = require(H + '/observed-model.js'), KPI = require(H + '/kpi-metrics.js');
const data = JSON.parse(fs.readFileSync(H + '/data.json', 'utf8'));
const SEEDS = [42, 1, 2, 3, 7];
const MAIN = ['S0', 'S2', 'S1', 'S5'];
const SLOW_DWELL = { UP: [30, 15, 10, 30], DOWN: [30, 15, 15, 10, 10] };

function run(id, seed, extra = {}, cfg = null, profile = 'activity_reference') {
  const plan = Obs.createDemandPlan(data, { profile, seed });
  const d = cfg ? { ...data, config: { ...data.config, ...cfg } } : data;
  const r = Sim.simulate({ ...d, demand: plan.rows }, { ...Sim.getScenarioDefaults(id), seed, ...extra });
  const k = KPI.calculate(r);
  const lunch = k.departuresByBand.find(b => b.from === 41400);
  // share of requests ready 11:30-13:00 that boarded within 10 min (denominator includes unboarded)
  const lr = r.outcomes.filter(o => 41400 <= o.ready && o.ready < 46800);
  const within10Lunch = 100 * lr.filter(o => o.boarded != null && o.boarded - o.ready <= 600).length / lr.length;
  return { median: k.medianWaitSeconds / 60, p90: k.p90WaitSeconds / 60, max: k.maxWaitSeconds / 60, mean: k.meanWaitSeconds / 60,
    within10: k.boardedWithinRate * 100, boarding: k.boardingRate * 100, U01: k.maximumQueueByStop.U01.count,
    netMax: k.maximumQueue.count, netStop: k.maximumQueue.stop, travel: k.travelTimeMedianSeconds / 60,
    util: k.driverUtilization * 100, hosp: k.hospitalTripCount, nonrev: k.nonrevenueTripCount, km: k.vehicleKm,
    lunchUp: lunch.UP.meanIntervalSeconds && lunch.UP.meanIntervalSeconds / 60, skipped: r.summary.target_departures_skipped_late, unboarded: k.unboardedCount, within10Lunch, lunchRequests: lr.length, requests: r.outcomes.length };
}
const METRICS = ['median', 'mean', 'p90', 'max', 'within10', 'boarding', 'U01', 'netMax', 'travel', 'util', 'hosp', 'nonrev', 'km', 'lunchUp', 'skipped', 'unboarded', 'within10Lunch', 'lunchRequests'];
const rows = [];
function cell(group, condition, id, seeds, extra, cfg, profile) {
  const runs = seeds.map(s => run(id, s, extra, cfg, profile));
  const row = { group, condition, scenario: id, seeds: seeds.join('/'), requests: runs[0].requests };
  for (const m of METRICS) {
    const v = runs.map(x => x[m]).filter(Number.isFinite);
    row[m] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    row[m + '_min'] = v.length ? Math.min(...v) : null; row[m + '_max'] = v.length ? Math.max(...v) : null;
  }
  row.netStop = [...new Set(runs.map(x => x.netStop))].join('/');
  row.p90_seeds = runs.map(x => x.p90); row.requests_seeds = runs.map(x => x.requests);  // JSON only, for paired comparison
  rows.push(row); return row;
}
for (const id of Sim.SCENARIOS) cell('seed_repeat', 'base', id, SEEDS);
for (const id of MAIN) cell('stress', 'lunch_full', id, SEEDS, {}, null, 'lunch_full');
const S3 = SEEDS.slice(0, 3);
for (const s of [0.75, 1.25, 1.5]) for (const id of MAIN) cell('demand_scale', 'x' + s, id, SEEDS, { demandScale: s });
// S2 split: fill only the 11:30-12:15 break at 5 min, keep 12:15-13:00 at 10 min.
// S0 only (lunchService off). ponytail: break segment starts at 41401 so the engine's from-keyed headway override (41400 -> lunchHeadway) skips it.
const BREAK_ONLY = [{ from: 30000, to: 32400, headway: 120 }, { from: 32400, to: 41400, headway: 300 }, { from: 41401, to: 44100, headway: 300 }, { from: 44100, to: 46800, headway: 600 }, { from: 46800, to: 63000, headway: 300, endInclusive: true }];
cell('lunch_split', 'break_only', 'S0', SEEDS, {}, { service: BREAK_ONLY });
for (const c of [24, 44]) for (const id of MAIN) cell('hospital_capacity', c + 'seats', id, S3, { hospitalCapacity: c });
for (const id of MAIN) cell('hospital_off', 'no_hospital', id, S3, { hospitalEnabled: false });
for (const id of MAIN) cell('dwell', 'slow_30_15_10_30', id, S3, {}, { dwell: SLOW_DWELL });
for (const h of [120, 180, 300, 600]) cell('lunch_headway', h / 60 + 'min', 'S1A', SEEDS, { lunchHeadway: h });

// Seed-42 breakdown by time band and origin stop, for the report tables.
const breakdown = {};
{ const plan = Obs.createDemandPlan(data, { profile: 'activity_reference', seed: 42 });
  for (const id of Sim.SCENARIOS) {
    const k = KPI.calculate(Sim.simulate({ ...data, demand: plan.rows }, { ...Sim.getScenarioDefaults(id), seed: 42 }));
    breakdown[id] = { bands: k.waitByBand.map(b => ({ label: b.label, median: b.median / 60, p90: b.p90 / 60 })),
      stops: Object.fromEntries(Object.entries(k.maximumQueueByStop).map(([s, q]) => [s, { queue: q.count, maxWait: k.waitByStop[s].max / 60 }])),
      driverBusyHours: (k.driverBusySeconds - k.hospitalDriverBusySeconds) / 3600, hospitalDriverBusyHours: k.hospitalDriverBusySeconds / 3600, shiftHours: k.driverCount * 33000 / 3600 };
  } }
const cols = ['group', 'condition', 'scenario', 'seeds', 'requests', 'netStop', ...METRICS.flatMap(m => [m, m + '_min', m + '_max'])];
const fmt = v => v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
fs.writeFileSync(path.join(OUT, 'sensitivity_20261120.csv'), '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => fmt(r[c])).join(','))].join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'sensitivity_20261120.json'), JSON.stringify({ generated: '2026-11-20', engine: Sim.version, kpi: KPI.version, seeds: SEEDS, window: '08:20-17:30', scenarios: Sim.SCENARIOS, defaults: Object.fromEntries(Sim.SCENARIOS.map(id => [id, Sim.getScenarioDefaults(id)])), breakdown, rows }, null, 1));
const r1 = x => x == null ? '—' : x.toFixed(1);
for (const r of rows) console.log([r.group, r.condition, r.scenario, 'med', r1(r.median), 'p90', r1(r.p90) + '(' + r1(r.p90_min) + '~' + r1(r.p90_max) + ')', 'max', r1(r.max), 'in10', r1(r.within10), 'board', r1(r.boarding), 'U01', r1(r.U01) + '(' + r.U01_min + '~' + r.U01_max + ')', 'net', r1(r.netMax), r.netStop, 'tt', r1(r.travel), 'util', r1(r.util), 'hosp', r1(r.hosp), 'nonrev', r1(r.nonrev), 'km', r1(r.km), 'lunchUp', r1(r.lunchUp)].join(' '));
