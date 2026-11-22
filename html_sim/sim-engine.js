(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShuttleSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ROUTES = { UP: ['U01', 'U02', 'U03', 'U04'], DOWN: ['D01', 'D02', 'D03', 'D04', 'D05'] };
  const SEGMENTS = { UP: [137, 63, 65], DOWN: [72, 40, 93, 31] };
  const DWELL = { UP: [0, 7, 0, 23], DOWN: [0, 8, 8, 7, 7] };
  const OPPOSITE = { UP: 'DOWN', DOWN: 'UP' };
  const DEFAULT_SERVICE = [
    { from: 30000, to: 32400, headway: 120 }, { from: 32400, to: 41400, headway: 300 },
    { from: 41400, to: 44100, headway: 0 }, { from: 44100, to: 46800, headway: 600 },
    { from: 46800, to: 63000, headway: 300, endInclusive: true }
  ];
  const HOSPITAL_TIMES = [40200, 42000, 42900, 43800, 44400, 45000, 45900];
  const STATUSES = ['completed', 'waiting', 'onboard', 'dependency_unserved', 'ready_after_horizon'];
  // S1A/S1B split S1 into its two main changes so their effects can be read separately:
  // S1A = lunch target 2 min over all of 11:30-13:00 (hospital keeps its fixed slots), S1B = morning hospital bus only.
  // S1 also pools the lunch hospital bus into Mudangi dispatch (hospitalReplacement), so S1A + S1B is not a decomposition of S1.
  // S2 (main proposal, 2026-11-20) = S1A with a 5-minute lunch target instead of 2 minutes.
  const SCENARIOS = ['S0', 'S2', 'S1', 'S1A', 'S1B', 'S5'];
  const S1_FAMILY = ['S1', 'S1A', 'S1B', 'S2'];
  function getScenarioDefaults(id) {
    check(SCENARIOS.includes(id), '시나리오는 S0, S2, S1, S1A, S1B, S5 중에서 선택해 주세요.');
    const lunch = id === 'S1' || id === 'S1A' || id === 'S2', morning = id === 'S1' || id === 'S1B';
    return { scenarioId: id, demandScale: 1, seed: 42, drivers: 4, m18Count: 2,
      m23Count: 2, peakHeadway: 120, midHeadway: 300, lunchHeadway: id === 'S2' ? 300 : lunch ? 120 : 600,
      pmHeadway: 300, hospitalEnabled: true, hospitalCapacity: 35,
      morningHospital: morning, hospitalReplacement: id === 'S1', lunchService: lunch, queueAdaptive: id === 'S5',
      maximumPolicyWait: 300, aiLunchScale: 1, dormitoryScale: 1 };
  }
  function check(ok, message) { if (!ok) throw new Error(message); }
  function number(value, fallback, lo, hi, name, integer) {
    const n = value == null ? fallback : Number(value);
    check(Number.isFinite(n) && n >= lo && n <= hi && (!integer || Number.isInteger(n)), `${name} 입력 범위를 확인해 주세요 (${lo}~${hi}).`);
    return n;
  }
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    // Avalanche the FNV prefix so adjacent person IDs do not all fall on the
    // same side of a fractional sampling threshold.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function clock(t) { return `${Math.floor(t / 3600).toString().padStart(2, '0')}:${Math.floor(t % 3600 / 60).toString().padStart(2, '0')}:${Math.floor(t % 60).toString().padStart(2, '0')}`; }
  function stats(values) {
    if (!values.length) return { n: 0, mean: null, median: null, p90: null };
    const a = values.slice().sort((x, y) => x - y);
    const q = p => { const at = (a.length - 1) * p, i = Math.floor(at); return a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * (at - i); };
    return { n: a.length, mean: a.reduce((a, b) => a + b, 0) / a.length, median: q(.5), p90: q(.9) };
  }
  class Heap {
    constructor() { this.a = []; }
    less(a, b) { return a.t < b.t || (a.t === b.t && (a.priority < b.priority || (a.priority === b.priority && a.serial < b.serial))); }
    push(x) { const a = this.a; let i = a.length; a.push(x); while (i) { const p = (i - 1) >> 1; if (!this.less(x, a[p])) break; a[i] = a[p]; i = p; } a[i] = x; }
    pop() {
      const a = this.a, first = a[0], last = a.pop();
      if (a.length) { let i = 0; while (true) { let c = i * 2 + 1; if (c >= a.length) break; if (c + 1 < a.length && this.less(a[c + 1], a[c])) c++; if (!this.less(a[c], last)) break; a[i] = a[c]; i = c; } a[i] = last; }
      return first;
    }
    peek() { return this.a[0]; }
    get length() { return this.a.length; }
  }
  function activityCategory(row) {
    if (row.activityCategory) return row.activityCategory;
    const reason = String(row.reason || '').toLowerCase();
    if (reason.includes('lunch_excursion_outbound') && row.origin === 'D01') return 'ai_lunch_outbound';
    if (reason.includes('lunch_excursion_return') && row.destination === 'U04') return 'ai_lunch_return';
    if (row.residence === 'dormitory') return reason.includes('first_class') ? 'dormitory_class' : 'dormitory_other';
    return 'other';
  }
  function scaledDemand(raw, scale, seed, aiLunchScale, dormitoryScale) {
    const people = new Map();
    for (const row of raw) {
      const person = String(row.person == null ? row.id : row.person);
      if (!people.has(person)) people.set(person, []);
      people.get(person).push(row);
    }
    const result = [];
    for (const [person, group] of people) {
      const aiLunch = group.some(r => ['ai_lunch_outbound', 'ai_lunch_return'].includes(activityCategory(r)));
      const dormitory = group.some(r => r.residence === 'dormitory');
      const effectiveScale = Math.min(9, scale * (aiLunch ? aiLunchScale : 1) * (dormitory ? dormitoryScale : 1));
      const copies = Math.floor(effectiveScale) + (hash(`${seed}|${person}`) < effectiveScale % 1 ? 1 : 0);
      for (let copy = 0; copy < copies; copy++) {
        const prefix = copy === 0 ? '' : `CLONE${copy}:`;
        for (const row of group) result.push({
          ...row, id: prefix + String(row.id), person: prefix + person,
          previousId: row.previousId == null || row.previousId === '' ? null : prefix + String(row.previousId),
          source: 'browser_experiment_scaled_synthetic', referenceSource: row.source || null,
          activityCategory: activityCategory(row), selectedPersonScale: effectiveScale,
          selectedCategoryScaleClippedAt9: scale * (aiLunch ? aiLunchScale : 1) * (dormitory ? dormitoryScale : 1) > 9
        });
      }
    }
    return result;
  }
  function simulate(data, options) {
    check(data && Array.isArray(data.demand), '시뮬레이션 수요 데이터가 없습니다.');
    const rawOptions = options || {}, scenarioId = rawOptions.scenarioId || 'S0';
    const defaults = getScenarioDefaults(scenarioId);
    options = { ...defaults, ...rawOptions }; const cfg = data.config || {};
    const start = number(cfg.start, 30000, 0, 86400, '운행 시작', true);
    const end = number(cfg.end, 63000, start, 86400, '마지막 출발', true);
    const opt = {
      scenarioId,
      m18Count: number(options.m18Count, defaults.m18Count, 0, 4, '18인승 운영 대수', true),
      m23Count: number(options.m23Count, defaults.m23Count, 0, 4, '23인승 운영 대수', true),
      demandScale: number(options.demandScale, 1, 0, 3, '수요 배율', false),
      seed: number(options.seed, 42, 0, 2147483647, '시드', true),
      peakHeadway: number(options.peakHeadway, 120, 60, 1800, '오전 배차 초', true),
      midHeadway: number(options.midHeadway, 300, 60, 1800, '오전 중간 배차 초', true),
      lunchHeadway: number(options.lunchHeadway, 600, 60, 1800, '점심 배차 초', true),
      pmHeadway: number(options.pmHeadway, 300, 60, 1800, '오후 배차 초', true),
      drivers: number(options.drivers, Array.isArray(cfg.drivers) ? cfg.drivers.length : (cfg.drivers || 4), 1, 5, '기사 수', true),
      hospitalEnabled: options.hospitalEnabled == null ? true : Boolean(options.hospitalEnabled),
      hospitalCapacity: number(options.hospitalCapacity, 35, 1, 60, '병원차 정원 가정', true),
      morningHospital: S1_FAMILY.includes(scenarioId) && Boolean(options.morningHospital),
      hospitalReplacement: scenarioId === 'S1' && options.hospitalReplacement !== false,
      lunchService: S1_FAMILY.includes(scenarioId) && Boolean(options.lunchService || scenarioId === 'S1' && options.hospitalReplacement !== false),
      queueAdaptive: scenarioId === 'S5',
      maximumPolicyWait: number(options.maximumPolicyWait, 300, 60, 900, '대기열 배차 대기상한 초', true),
      aiLunchScale: number(options.aiLunchScale, 1, 0, 3, 'AI 점심 인물사슬 배율', false),
      dormitoryScale: number(options.dormitoryScale, 1, 0, 3, '기숙사 인물사슬 배율', false)
    };
    const routes = cfg.routeStops || ROUTES, segments = cfg.segments || SEGMENTS, dwell = cfg.dwell || DWELL;
    const connector = cfg.connectors || { UP: 10, DOWN: 22 };
    const change = number(cfg.driverChangeSeconds, 30, 0, 300, '기사 인계 초', true);
    const maxLate = number(rawOptions.maxTargetLatenessSeconds ?? cfg.maxTargetLatenessSeconds, 600, 0, 86400, '배차 목표 허용 지연 초', true);
    const durations = {};
    for (const d of ['UP', 'DOWN']) {
      check(routes[d] && segments[d] && dwell[d] && segments[d].length === routes[d].length - 1 && dwell[d].length === routes[d].length, '노선의 정류장·주행시간 배열이 일치하지 않습니다.');
      durations[d] = segments[d].concat(dwell[d]).reduce((sum, v) => sum + number(v, 0, 0, 3600, '주행·정차 초', true), 0);
      check(durations[d] > 0, '노선 주행시간이 0입니다.');
      number(connector[d], d === 'UP' ? 10 : 22, 0, 3600, '회차 연결 초', true);
    }
    let roster;
    if (scenarioId !== 'S0' || rawOptions.m18Count != null || rawOptions.m23Count != null || !Array.isArray(cfg.vehicles)) {
      const n18 = number(options.m18Count, 2, 0, 4, '18인승 대수', true);
      const n23 = number(options.m23Count, 2, 0, 4, '23인승 대수', true); roster = [];
      for (const [count, capacity] of [[n18, 18], [n23, 23]]) for (let i = 0; i < count; i++) {
        roster.push({ id: `M${capacity}${String.fromCharCode(65 + i)}`, capacity, operator: 'mudangi', position: i % 2 ? 'DOWN' : 'UP' });
      }
      // S1: all Mudangi vehicles keep running; the hospital bus (own driver) is added on top (user-confirmed 2026-11-20).
      roster.push({ id: 'H35', capacity: opt.hospitalCapacity, operator: 'gil_hospital', position: 'UP' });
    } else roster = cfg.vehicles.map(v => ({ ...v, id: v.id || v.vehicle_id, operator: v.operator || v.kind }));
    roster = roster.filter(v => v.operator !== 'gil_hospital' || opt.hospitalEnabled).map(v => ({
      id: String(v.id), capacity: v.operator === 'gil_hospital' ? opt.hospitalCapacity : number(v.capacity, 18, 1, 100, '차량 정원', true),
      operator: v.operator || 'mudangi', position: v.position || 'UP', ready: start,
      busy: false, onboard: [], hasOperated: false, reserveReplacement: Boolean(v.reserveReplacement)
    }));
    check(new Set(roster.map(v => v.id)).size === roster.length, '차량 ID가 중복됩니다.');
    check(roster.every(v => routes[v.position]), '차량 초기 방향이 잘못되었습니다.');
    const initialVehicles = roster.map(v => ({ id: v.id, capacity: v.capacity, operator: v.operator, position: v.position,
      reserveReplacement: v.reserveReplacement && opt.hospitalEnabled,
      reserveRestoredBecauseNoHospital: v.reserveReplacement && !opt.hospitalEnabled }));
    const drivers = Array.from({ length: opt.drivers }, (_, i) => ({ id: `D${i + 1}`, position: i < 2 || i >= 4 ? 'UP' : 'DOWN', ready: start, busy: false, lastVehicle: null }));
    const hospitalDriver = { id: 'DH', position: 'UP', ready: start, busy: false, lastVehicle: null };
    const baseService = opt.lunchService ? (cfg.service || DEFAULT_SERVICE).filter(s => !(41400 <= s.from && s.from < 46800)).concat([{ from: 41400, to: 46800, headway: opt.lunchHeadway }]).sort((a, b) => a.from - b.from) : (cfg.service || DEFAULT_SERVICE);
    const service = baseService.map(s => {
      let headway = Number(s.headway);
      if (headway) headway = ({ 30000: opt.peakHeadway, 32400: opt.midHeadway, 41400: opt.lunchHeadway, 44100: opt.lunchHeadway, 46800: opt.pmHeadway })[s.from] || headway;
      check(Number.isInteger(s.from) && Number.isInteger(s.to) && s.to >= s.from && (headway === 0 || Number.isInteger(headway) && headway > 0), '운행 구간 입력이 잘못되었습니다.');
      return { from: s.from, to: s.to, headway, endInclusive: Boolean(s.endInclusive || s.to === end && s === baseService.at(-1)) };
    });
    function muAllowed(t) { return service.some(s => s.headway > 0 && s.from <= t && (t < s.to || s.endInclusive && t === s.to)); }
    const hospitalTimes = (Array.isArray(cfg.hospitalTimes) ? cfg.hospitalTimes : HOSPITAL_TIMES).map(t => number(t, 0, 0, 86400, '병원차 출발 초', true)).sort((a, b) => a - b);
    const hospitalStart = hospitalTimes.length ? hospitalTimes[0] : end + 1;
    const hospitalEnd = number(cfg.hospitalEnd, 46800, 0, 86400, '병원 지원 종료 초', true);
    function replacementPeak(t) { return opt.hospitalEnabled && (opt.morningHospital && start <= t && t < 32400 || opt.hospitalReplacement && 41400 <= t && t < 46800); }
    function hospitalActive(t) { return opt.hospitalEnabled && (hospitalStart <= t && t <= hospitalEnd || opt.morningHospital && start <= t && t < 32400); }
    const rawDemand = scaledDemand(data.demand, opt.demandScale, opt.seed, opt.aiLunchScale, opt.dormitoryScale), requests = new Map();
    const next = new Map();
    for (const r of rawDemand) {
      check(!requests.has(r.id), '수요 ID가 중복됩니다.');
      check(Object.values(routes).some(ids => ids.indexOf(r.origin) >= 0 && ids.indexOf(r.destination) > ids.indexOf(r.origin)), '모형 노선으로 갈 수 없는 수요가 있습니다.');
      const planned = number(r.planned, start, 0, 172800, '요청 시각', true), gap = number(r.gap, 0, 0, 172800, '활동 간격', true);
      requests.set(r.id, { ...r, planned, gap, ready: null, boarded: null, completed: null, trip: '', vehicle: '', status: 'held' });
      if (r.previousId != null) { check(!next.has(r.previousId), '한 승객의 다음 통행이 둘 이상입니다.'); next.set(r.previousId, r.id); }
    }
    for (const r of requests.values()) if (r.previousId != null) {
      check(requests.has(r.previousId) && requests.get(r.previousId).person === r.person && r.previousId !== r.id, '활동 사슬의 이전 통행이 잘못되었습니다.');
      let p = r, count = 0; while (p.previousId != null) { p = requests.get(p.previousId); check(p && ++count <= requests.size, '활동 사슬이 순환합니다.'); }
    }
    const heap = new Heap(); let serial = 0;
    function event(t, priority, kind, value) { heap.push({ t, priority, kind, value, serial: ++serial }); }
    const queues = new Map(Object.values(routes).flat().map(id => [id, []]));
    const activePeople = new Set(); const trips = [], events = [], targets = [], pending = []; const lastDeparture = { UP: null, DOWN: null };
    let lastTripEnd = start, maximumQueue = 0; const queueSamples = [];
    function release(r, t) { r.ready = t; r.status = 'scheduled_to_arrive'; event(t, 0, 'request', r.id); }
    for (const r of requests.values()) if (r.previousId == null) release(r, r.planned);
    function target(t, direction, operator, kind) {
      const x = { id: `TARGET_${targets.length + 1}`, t, direction, operator, kind: kind || 'fixed_target', status: 'scheduled', actual: null, delay: null, trip: null };
      targets.push(x); event(t, 40, 'target', x);
    }
    if (Array.isArray(cfg.targets)) for (const s of cfg.targets) {
      const t = Number(s.t == null ? s.time_s : s.t); if (start <= t && t <= end) target(t, s.direction, s.operator || 'mudangi');
    } else for (const s of service) if (s.headway) for (let t = s.from; t < s.to || s.endInclusive && t === s.to; t += s.headway) {
      if (start <= t && t <= end) for (const d of ['UP', 'DOWN']) target(t, d, opt.hospitalReplacement || opt.morningHospital && t < 32400 ? 'any' : 'mudangi');
    }
    if (opt.hospitalEnabled) for (const t of hospitalTimes) if (start <= t && t <= end) target(t, 'UP', 'gil_hospital', 'reported_hospital_slot');
    for (let t = start; t <= end; t += 15) event(t, 90, 'tick', null);
    function choose(t, direction, operator, vehicleId, queueSize, capacityRequired, excludedDriver) {
      let best = null, bestScore = null;
      for (const v of roster) {
        if (v.busy || v.ready > t || v.position !== direction || operator !== 'any' && v.operator !== operator || vehicleId && v.id !== vehicleId) continue;
        if (capacityRequired && v.capacity !== capacityRequired) continue;
        if (v.operator === 'mudangi' && !muAllowed(t)) continue;
        if (v.reserveReplacement && (hospitalActive(t) || roster.some(x => x.operator === 'gil_hospital' && x.busy))) continue;
        if (v.operator === 'gil_hospital' && operator === 'any' && !replacementPeak(t)) continue;
        // Gil hospital bus has its own dedicated driver (user-confirmed 2026-11-20); Mudangi drivers never drive it.
        for (const d of v.operator === 'gil_hospital' ? [hospitalDriver] : drivers) {
          if (d.busy || d.position !== direction || d.id === excludedDriver) continue;
          const transfer = d.lastVehicle && d.lastVehicle !== v.id ? change : 0;
          if (Math.max(v.ready, d.ready) + transfer > t) continue;
          const fit = queueSize == null ? [0, -v.capacity] : (v.capacity >= queueSize ? [0, v.capacity] : [1, -v.capacity]);
          const score = [...fit, transfer, d.ready, v.id, d.id];
          if (!best || score.some((value, i) => value < bestScore[i] && score.slice(0, i).every((before, j) => before === bestScore[j]))) {
            best = { v, d, transfer }; bestScore = score;
          }
        }
      }
      return best;
    }
    function dispatch(t, direction, match, reason, slot, revenue) {
      const { v, d, transfer } = match;
      const finish = t + durations[direction], ready = finish + Number(connector[direction]);
      const trip = { id: `BROWSER_${String(trips.length + 1).padStart(5, '0')}`, vehicle: v.id, driver: d.id,
        direction, operator: v.operator, start: t, end: finish, ready, cap: v.capacity, revenue: revenue !== false,
        reason, target: slot ? slot.t : null, delay: slot ? t - slot.t : null, driverBusyStart: t - transfer,
        source: 'browser_experiment_not_observed' };
      trips.push(trip); v.busy = d.busy = true; v.hasOperated = true; d.lastVehicle = v.id;
      lastTripEnd = Math.max(lastTripEnd, finish);
      if (slot) Object.assign(slot, { status: t === slot.t ? 'on_time' : 'delayed', actual: t, delay: t - slot.t, trip: trip.id });
      if (trip.revenue) {
        lastDeparture[direction] = t;
        let cursor = t;
        for (let i = 0; i < routes[direction].length; i++) {
          if (i) cursor += Number(segments[direction][i - 1]);
          event(cursor, 10, 'arrival', { trip, i });
          cursor += Number(dwell[direction][i]); event(cursor, 20, 'departure', { trip, i });
        }
      }
      event(ready, 30, 'available', { v, d, direction: OPPOSITE[direction] });
    }
    function serve(t) {
      // Dedicated hospital duties first; this is an explicit simplified policy.
      for (const v of roster) if (v.operator === 'gil_hospital' && v.hasOperated && !v.busy && v.position === 'DOWN') {
        const match = choose(t, 'DOWN', 'gil_hospital', v.id);
        if (match) dispatch(t, 'DOWN', match, 'hospital_return', null, hospitalActive(t));
      }
      const ordered = pending.filter(s => s.status === 'pending').sort((a, b) => (a.operator === 'gil_hospital' ? 0 : 1) - (b.operator === 'gil_hospital' ? 0 : 1) || a.t - b.t || a.id.localeCompare(b.id));
      for (const s of ordered) {
        // A slot more than maxLate seconds behind its time is dropped. Without this an infeasible
        // headway (2 min with 4 vehicles at lunch) carries its backlog up to 70 min into the
        // afternoon and inflates later service. Short catch-up delays (a few minutes) are kept.
        if (s.operator !== 'gil_hospital' && t - s.t > maxLate) { s.status = 'skipped_late'; continue; }
        if (s.operator === 'mudangi' && !muAllowed(t)) continue;
        if (s.operator === 'gil_hospital' && (t < hospitalStart || t > hospitalEnd)) continue;
        const match = choose(t, s.direction, s.operator);
        if (match) dispatch(t, s.direction, match, s.kind, s, true);
      }
      if (!opt.queueAdaptive) return;
      function queueInfo(direction) {
        const ids = routes[direction].slice(0, -1), idsWaiting = ids.flatMap(id => queues.get(id));
        return { count: idsWaiting.length, oldest: idsWaiting.length ? Math.min(...idsWaiting.map(id => requests.get(id).ready)) : null };
      }
      const priority = ['UP', 'DOWN'].sort((a, b) => {
        const x = queueInfo(a), y = queueInfo(b);
        return (y.oldest == null ? -1 : t - y.oldest) - (x.oldest == null ? -1 : t - x.oldest) || y.count - x.count;
      });
      for (const direction of priority) {
        const q = queueInfo(direction);
        if (!q.count || q.oldest == null || lastDeparture[direction] === t) continue;
        const band = service.find(s => s.from <= t && (t < s.to || s.endInclusive && t === s.to));
        const maxWait = Math.min(band && band.headway || opt.maximumPolicyWait, opt.maximumPolicyWait);
        if (q.count <= 18 && t - q.oldest < maxWait && lastDeparture[direction] != null) continue;
        const best = choose(t, direction, 'any', null, q.count);
        if (!best) continue;
        if (q.count >= 24 && best.v.capacity < q.count) {
          const small = choose(t, direction, 'any', null, null, 18);
          const large = small && choose(t, direction, 'any', null, null, 23, small.d.id);
          if (small && large) {
            dispatch(t, direction, small, 'queue_feedback_mixed_pair', null, true);
            dispatch(t, direction, large, 'queue_feedback_mixed_pair', null, true);
            continue;
          }
        }
        dispatch(t, direction, best, 'queue_feedback', null, true);
      }
      // Empty-direction repositioning consumes the real route and connector
      // time, vehicle and local driver. It never teleports a vehicle.
      for (const wanted of ['UP', 'DOWN']) {
        const q = queueInfo(wanted), other = OPPOSITE[wanted];
        if (!q.count || choose(t, wanted, 'any') || queueInfo(other).count) continue;
        const move = choose(t, other, 'mudangi');
        if (move) dispatch(t, other, move, 'nonrevenue_reposition_for_opposite_queue', null, false);
      }
    }
    const finishLimit = end + Math.max(...Object.values(durations)) + Math.max(...Object.values(connector).map(Number));
    while (heap.length && heap.peek().t <= finishLimit) {
      const t = heap.peek().t;
      while (heap.length && heap.peek().t === t) {
        const e = heap.pop();
        if (e.kind === 'request') {
          const r = requests.get(e.value); if (r.status === 'scheduled_to_arrive') { r.status = 'waiting'; queues.get(r.origin).push(r.id); queueSamples.push({ t, count: queues.get(r.origin).length }); }
        } else if (e.kind === 'target') {
          const s = e.value;
          if (s.operator !== 'gil_hospital' && opt.queueAdaptive || s.operator === 'gil_hospital' && opt.hospitalReplacement && replacementPeak(t)) {
            s.status = 'policy_reference_only';
          } else { s.status = 'pending'; pending.push(s); }
        }
        else if (e.kind === 'available') {
          const { v, d, direction } = e.value; check(!v.onboard.length, '차량 종점에 미하차 승객이 남았습니다.');
          Object.assign(v, { busy: false, position: direction, ready: t }); Object.assign(d, { busy: false, position: direction, ready: t });
        } else if (e.kind === 'arrival' || e.kind === 'departure') {
          const { trip, i } = e.value, v = roster.find(v => v.id === trip.vehicle), stop = routes[trip.direction][i];
          let board = 0, alight = 0; const boardingCategories = {}, alightingCategories = {};
          if (e.kind === 'arrival') {
            v.onboard = v.onboard.filter(id => {
              const r = requests.get(id); if (r.destination !== stop) return true;
              r.completed = t; r.status = 'completed'; alight++; activePeople.delete(r.person);
              const category = activityCategory(r); alightingCategories[category] = (alightingCategories[category] || 0) + 1;
              if (next.has(id)) { const following = requests.get(next.get(id)); release(following, Math.max(following.planned, t + following.gap)); }
              return false;
            });
          } else {
            const allowed = new Set(routes[trip.direction].slice(i + 1)), retained = [];
            for (const id of queues.get(stop)) {
              const r = requests.get(id);
              if (allowed.has(r.destination) && v.onboard.length < v.capacity && !activePeople.has(r.person)) {
                Object.assign(r, { boarded: t, trip: trip.id, vehicle: v.id, status: 'onboard' }); v.onboard.push(id); activePeople.add(r.person); board++;
                const category = activityCategory(r); boardingCategories[category] = (boardingCategories[category] || 0) + 1;
              } else retained.push(id);
            }
            queues.set(stop, retained);
          }
          check(v.onboard.length <= v.capacity, '차량 정원을 초과했습니다.');
          events.push({ t, trip: trip.id, vehicle: v.id, driver: trip.driver, direction: trip.direction, operator: v.operator,
            stop, event: e.kind, board, alight, onboard: v.onboard.length, queue: queues.get(stop).length,
            boardingCategories, alightingCategories });
        }
      }
      if (start <= t && t <= end) serve(t);
    }
    const horizon = Math.max(end, lastTripEnd), outcomes = [];
    maximumQueue = Math.max(0, ...queueSamples.filter(s => s.t <= horizon).map(s => s.count));
    for (const r of requests.values()) {
      if (r.status === 'held') r.status = 'dependency_unserved';
      else if (r.status === 'scheduled_to_arrive' || r.ready > horizon && r.status === 'waiting') r.status = 'ready_after_horizon';
      outcomes.push({ id: r.id, person: r.person, origin: r.origin, destination: r.destination, planned: r.planned,
        ready: r.ready, boarded: r.boarded, completed: r.completed, status: r.status, trip: r.trip, vehicle: r.vehicle,
        source: r.source, referenceSource: r.referenceSource || null,
        reason: r.reason || null, residence: r.residence || null,
        activityCategory: activityCategory(r), activitySubtype: r.activitySubtype || null,
        selectedPersonScale: r.selectedPersonScale,
        waiting: r.boarded == null ? null : r.boarded - r.ready,
        censoredWait: r.status === 'waiting' ? Math.max(0, horizon - r.ready) : null });
    }
    for (const s of targets) if (s.status === 'pending' || s.status === 'scheduled') s.status = 'unserved_by_horizon';
    const status = Object.fromEntries(STATUSES.map(s => [s, outcomes.filter(r => r.status === s).length]));
    check(Object.values(status).reduce((a, b) => a + b, 0) === outcomes.length, '승객 수지가 일치하지 않습니다.');
    check(events.reduce((a, e) => a + e.board, 0) === outcomes.filter(r => r.boarded != null).length, '승차 장부가 일치하지 않습니다.');
    check(events.reduce((a, e) => a + e.alight, 0) === status.completed && status.onboard === 0, '하차 장부가 일치하지 않습니다.');
    const summary = {
      case_id: `WHAT_IF_${scenarioId}`, policy: scenarioId, status: 'BROWSER_SIMPLIFIED_ASSUMPTION_SCENARIO_NOT_REFERENCE_ENGINE',
      input_requests: outcomes.length, persons_with_input_requests: new Set(outcomes.map(r => r.person)).size,
      completed_requests: status.completed, completed_request_service_rate: outcomes.length ? status.completed / outcomes.length : 0,
      request_status: status, wait_boarded_seconds: stats(outcomes.filter(r => r.boarded != null).map(r => r.waiting)),
      original_request_to_arrival_completed_seconds: stats(outcomes.filter(r => r.completed != null).map(r => r.completed - r.planned)),
      censored_unboarded_wait_seconds: stats(outcomes.filter(r => r.censoredWait != null).map(r => r.censoredWait)),
      horizon_s: horizon, horizon: clock(horizon), last_departure_limit_s: end,
      driver_budget: opt.drivers, drivers_created: drivers.length, used_vehicles: new Set(trips.map(t => t.vehicle)).size,
      physical_vehicles: Object.fromEntries(initialVehicles.map(v => [v.id, { capacity: v.capacity, operator: v.operator }])),
      revenue_trip_count: trips.filter(t => t.revenue).length, nonrevenue_trip_count: trips.filter(t => !t.revenue).length,
      driver_busy_seconds: trips.reduce((a, t) => a + t.ready - t.driverBusyStart, 0),
      vehicle_busy_seconds: trips.reduce((a, t) => a + t.ready - t.start, 0), maximum_queue: maximumQueue,
      target_departures_total: targets.length, target_departures_on_time: targets.filter(t => t.status === 'on_time').length,
      target_departures_unserved_or_delayed: targets.filter(t => ['delayed', 'unserved_by_horizon', 'skipped_late'].includes(t.status)).length,
      target_departures_skipped_late: targets.filter(t => t.status === 'skipped_late').length,
      reference_only_target_count: targets.filter(t => t.status === 'policy_reference_only').length,
      maximum_target_delay_s: Math.max(0, ...targets.filter(t => t.delay != null).map(t => t.delay)),
      capacity_violations: 0, driver_overlap_violations: 0, vehicle_overlap_violations: 0, request_conservation: 'PASS'
    };
    return { summary, trips, events, outcomes, targets,
      meta: { method: 'browser_simplified_simulation_not_reference_engine', referenceParityClaimed: false,
        options: opt, initialVehicles, vehicles: initialVehicles, service, start, end, driverChangeSeconds: change,
        demandScaleAppliesToWholePersonChains: true, originalObservationDataMutated: false,
        hospitalCapacityIsAssumption: false, hospitalCapacityConfirmedByUser: '2026-11-20', hospitalHasDedicatedDriverConfirmedByUser: '2026-11-20', nominalTargetsAreNotGuaranteedDepartures: true,
        scenarioId, hospitalBusAddedOnTopOfFullMudangiFleet: opt.hospitalReplacement && opt.hospitalEnabled,
        categoryScaleAppliesToWholePersonChain: true,
        simplifiedRules: ['fixed per-stop dwell, no conditional education dwell', 'hospital duties have dispatch priority',
          'no abandonment or walking choice', 'whole-chain stable sampling for demand-scale experiments',
          'S1 adds the hospital bus and its dedicated driver to the full Mudangi fleet at lunch and before 09:00',
          'S5 uses current queue feedback and real nonrevenue reposition travel; not Python policy parity'],
        activities: { existingActivitiesRetainedByDefault: true, additionalMeasuredPeopleCreated: false,
          aiLunchPeople: new Set(rawDemand.filter(r => ['ai_lunch_outbound', 'ai_lunch_return'].includes(activityCategory(r))).map(r => r.person)).size,
          dormitoryPeople: new Set(rawDemand.filter(r => r.residence === 'dormitory').map(r => r.person)).size,
          categoryScaleOverlapRule: 'multiply person-level factors once, preserve complete chain, cap combined factor9' } } };
  }
  return { simulate, getScenarioDefaults, activityCategory, distribution: stats, SCENARIOS, version: '2.1.0' };
});
