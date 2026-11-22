// GTFS of the trips the engine actually runs (seed 42, base demand): gtfs/ = current timetable, gtfs_scenario/ = lunch 5-minute service.
// Targets the engine cannot meet (late or cancelled departures) are already reflected, so RAPTOR sees the same service as the simulation.
// Usage: node code/export_gtfs.cjs
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const H = path.join(ROOT, 'html_sim');
const OUT = fs.existsSync(path.join(ROOT, 'submission')) ? path.join(ROOT, 'submission') : ROOT;  // repo layout, else zip root
const COORDS = [path.join(ROOT, 'data_collection/direction_stop_coordinates.csv'), path.join(ROOT, 'data/direction_stop_coordinates.csv')].find(fs.existsSync);
const Sim = require(H + '/sim-engine.js'), Obs = require(H + '/observed-model.js');
const data = JSON.parse(fs.readFileSync(H + '/data.json', 'utf8'));
const SEED = 42;

const hms = s => [s / 3600, s % 3600 / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':');
const csv = rows => rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)).join(',')).join('\n') + '\n';
const stops = fs.readFileSync(COORDS, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map(l => l.split(','));

function write(dir, scenario) {
  const plan = Obs.createDemandPlan(data, { profile: 'activity_reference', seed: SEED });
  const r = Sim.simulate({ ...data, demand: plan.rows }, { ...Sim.getScenarioDefaults(scenario), seed: SEED });
  const byTrip = new Map();
  for (const e of r.events) if (e.trip && (e.event === 'arrival' || e.event === 'departure')) {
    const k = `${e.stop}`, list = byTrip.get(e.trip) || byTrip.set(e.trip, new Map()).get(e.trip);
    const s = list.get(k) || list.set(k, { stop: e.stop, arr: e.t, dep: e.t }).get(k);
    if (e.event === 'arrival') s.arr = e.t; else s.dep = e.t;
  }
  const trips = [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id']];
  const times = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type']];
  const runs = r.trips.filter(t => t.revenue).sort((a, b) => a.start - b.start || a.direction.localeCompare(b.direction));
  runs.forEach((t, i) => {
    const op = t.operator === 'gil_hospital' ? 'GIL' : 'MUDANGI', id = `${op}_${t.direction}_${String(i + 1).padStart(3, '0')}`;
    trips.push([op, 'WEEKDAY', id, t.direction === 'UP' ? 'AI공학관 방면' : '하행 종점 방면', t.direction === 'UP' ? 0 : 1, `ROAD_${t.direction}`]);
    const seq = [...byTrip.get(t.id).values()].sort((a, b) => a.arr - b.arr);
    seq.forEach((s, j) => times.push([id, hms(s.arr), hms(s.dep), s.stop, j + 1, j === seq.length - 1 ? 1 : 0, j === 0 ? 1 : 0]));
  });
  const shapes = [['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']];
  for (const d of ['UP', 'DOWN']) data.paths[d].forEach(([lon, lat], j) => shapes.push([`ROAD_${d}`, lat, lon, j + 1]));
  const files = {
    'agency.txt': [['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
      ['MUDANGI', '가천대학교 무당이', 'https://www.gachon.ac.kr/', 'Asia/Seoul', 'ko'], ['GIL', '길병원버스', 'https://www.gilhospital.com/', 'Asia/Seoul', 'ko']],
    'routes.txt': [['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
      ['MUDANGI', 'MUDANGI', '무당이', '교내셔틀', 3], ['GIL', 'GIL', '길병원버스', '교내 구간', 3]],
    'stops.txt': [['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], ...stops.map(s => [s[0], s[1], s[2], s[3]])],
    'calendar.txt': [['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['WEEKDAY', 1, 1, 1, 1, 1, 0, 0, '20261109', '20261231']],
    'feed_info.txt': [['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_url'],
      ['무당이 운행 시뮬레이션(과제용)', 'https://www.gachon.ac.kr/', 'ko', '20261109', '20261231', `seed${SEED}_${scenario}`, 'https://sunshine294-hub.github.io/mudangi-simulation/']],
    'trips.txt': trips, 'stop_times.txt': times, 'shapes.txt': shapes,
  };
  fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, dir));
  for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(OUT, dir, name), csv(rows));
  return { trips: trips.length - 1, stop_times: times.length - 1, mudangi: runs.filter(t => t.operator !== 'gil_hospital').length, gil: runs.filter(t => t.operator === 'gil_hospital').length };
}

const summary = { seed: SEED, current: write('gtfs', 'S0'), lunch5: write('gtfs_scenario', 'S2') };
fs.writeFileSync(path.join(OUT, 'gtfs_summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
