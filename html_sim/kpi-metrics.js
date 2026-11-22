(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShuttleKPI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const present = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const direction = stop => String(stop).startsWith('U') ? 'UP' : String(stop).startsWith('D') ? 'DOWN' : null;
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p, lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (index - lo);
  }
  // Route length per one-way trip, measured from the embedded route geometry (data.paths).
  const ROUTE_METERS = { UP: 1101, DOWN: 963 };
  const WAIT_BANDS = [[30000, 32400, '08:20~09:00'], [32400, 41400, '09:00~11:30'], [41400, 46800, '11:30~13:00'], [46800, 63000, '13:00~17:30']];
  const HEADWAY_BANDS = [[30000, 32400, '08:20~09:00'], [41400, 46800, '11:30~13:00']];
  const summarize = values => { const a = values.slice().sort((x, y) => x - y); return { n: a.length, median: quantile(a, .5), p90: quantile(a, .9), max: a.length ? a[a.length - 1] : null }; };
  function calculate(result, options = {}) {
    assert(result && Array.isArray(result.outcomes) && Array.isArray(result.trips), 'KPI 요청·운행 원장이 없습니다.');
    const start = options.start == null ? 30000 : Number(options.start);
    const end = options.end == null ? 63000 : Number(options.end);
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'KPI 비교 구간이 올바르지 않습니다.');
    const sourceHorizon = present(result.summary?.horizon_s) ? Number(result.summary.horizon_s) : null;
    assert(sourceHorizon == null || sourceHorizon >= end, '계산 결과가 공통 KPI 종료 시각까지 제공되지 않았습니다.');
    let eligibleReady = 0, boardedCount = 0, onboardCount = 0, completedCount = 0, initialBacklog = 0;
    const waits = [], travel = [], initialQueues = new Map(), deltas = new Map();
    const withinSeconds = options.withinSeconds == null ? 600 : Number(options.withinSeconds);
    let boardedWithin = 0; const waitsByBand = WAIT_BANDS.map(() => []), waitsByStop = {};
    function stopMap(stop) {
      if (!deltas.has(stop)) { deltas.set(stop, new Map()); initialQueues.set(stop, 0); }
      return deltas.get(stop);
    }
    function delta(stop, t, value) {
      const times = stopMap(stop);
      times.set(t, (times.get(t) || 0) + value);
    }
    for (const row of result.outcomes) {
      if (!present(row.ready)) continue;
      const ready = Number(row.ready), boarded = present(row.boarded) ? Number(row.boarded) : null;
      const completed = present(row.completed) ? Number(row.completed) : null;
      assert(boarded == null || boarded >= ready, 'KPI 원장의 승차 시각이 준비 시각보다 이릅니다.');
      assert(completed == null || boarded != null && completed >= boarded, 'KPI 원장의 하차 시각이 올바르지 않습니다.');
      if (boarded != null && boarded <= end && (completed == null || completed > end)) onboardCount++;
      if (ready > end || boarded != null && boarded < start) continue;
      assert(row.origin != null, 'KPI 요청의 출발 정류장이 없습니다.');
      const stop = String(row.origin); stopMap(stop);
      eligibleReady++;
      if (ready < start) {
        initialBacklog++;
        initialQueues.set(stop, initialQueues.get(stop) + 1);
      } else delta(stop, ready, 1);
      if (boarded != null && boarded <= end) {
        const wait = boarded - ready;
        boardedCount++; waits.push(wait); delta(stop, boarded, -1);
        if (wait <= withinSeconds) boardedWithin++;
        const band = WAIT_BANDS.findIndex(([from, to]) => from <= Math.max(ready, start) && Math.max(ready, start) < to);
        if (band >= 0) waitsByBand[band].push(wait);
        (waitsByStop[stop] ||= []).push(wait);
        if (completed != null && completed <= end) { completedCount++; travel.push(completed - ready); }
      }
    }
    const maximumQueueByStop = {};
    let maximumQueue = { count: 0, stop: null, time: start, direction: null };
    for (const [stop, times] of [...deltas].sort(([a], [b]) => a.localeCompare(b))) {
      let queue = initialQueues.get(stop) || 0;
      // Queue snapshots are after all same-second ready/boarding events. Merge
      // simultaneous changes before taking a maximum to avoid phantom peaks.
      if (times.has(start)) queue += times.get(start);
      assert(queue >= 0, 'KPI 대기 원장의 초기 수지가 음수입니다.');
      let peak = { count: queue, stop, time: start, direction: direction(stop) };
      for (const [t, change] of [...times].filter(([t]) => t > start).sort((a, b) => a[0] - b[0])) {
        queue += change; assert(queue >= 0, 'KPI 대기 원장의 수지가 음수입니다.');
        if (queue > peak.count) peak = { count: queue, stop, time: t, direction: direction(stop) };
      }
      maximumQueueByStop[stop] = peak;
      if (peak.count > maximumQueue.count || maximumQueue.stop == null) maximumQueue = { ...peak };
    }
    const driverIntervals = new Map(); let unknownDriverTripCount = 0;
    for (let i = 0; i < result.trips.length; i++) {
      const trip = result.trips[i];
      const from = present(trip.driverBusyStart) ? Number(trip.driverBusyStart) : Number(trip.start);
      const to = present(trip.ready) ? Number(trip.ready) : Number(trip.end);
      assert(Number.isFinite(from) && Number.isFinite(to) && to >= from, 'KPI 기사 투입 구간이 올바르지 않습니다.');
      const clippedFrom = Math.max(start, from), clippedTo = Math.min(end, to);
      if (clippedTo <= clippedFrom) continue;
      const knownDriver = trip.driver !== null && trip.driver !== undefined && trip.driver !== '';
      const id = knownDriver ? String(trip.driver) : '__unknown_trip_' + i;
      if (!knownDriver) unknownDriverTripCount++;
      if (!driverIntervals.has(id)) driverIntervals.set(id, []);
      driverIntervals.get(id).push([clippedFrom, clippedTo]);
    }
    let driverBusySeconds = 0; const driverBusySecondsByDriver = {};
    for (const [id, intervals] of driverIntervals) {
      intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let active = null, seconds = 0;
      for (const interval of intervals) {
        if (!active) active = interval.slice();
        else if (interval[0] <= active[1]) active[1] = Math.max(active[1], interval[1]);
        else { seconds += active[1] - active[0]; active = interval.slice(); }
      }
      if (active) seconds += active[1] - active[0];
      driverBusySecondsByDriver[id] = seconds; driverBusySeconds += seconds;
    }
    waits.sort((a, b) => a - b);
    const driverCount = Number(result.meta?.options?.drivers ?? result.summary?.driver_budget) || driverIntervals.size || 1;
    const inWindow = result.trips.filter(t => Number(t.start) >= start && Number(t.start) <= end);
    const vehicleMeters = inWindow.reduce((sum, t) => sum + (ROUTE_METERS[t.direction] || 0), 0);
    const departuresByBand = HEADWAY_BANDS.map(([from, to, label]) => {
      const row = { label, from, to };
      for (const d of ['UP', 'DOWN']) {
        const count = result.trips.filter(t => t.revenue !== false && t.direction === d && Number(t.start) >= from && Number(t.start) < to).length;
        row[d] = { departures: count, meanIntervalSeconds: count ? (to - from) / count : null };
      }
      return row;
    });
    return {
      window: { start, end }, sourceHorizon, units: 'synthetic_requests_not_unique_students',
      eligibleReady, boardedCount, unboardedCount: eligibleReady - boardedCount,
      onboardCount, completedCount, initialBacklog,
      meanWaitSeconds: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
      medianWaitSeconds: quantile(waits, .5),
      p90WaitSeconds: quantile(waits, .9),
      maxWaitSeconds: waits.length ? waits[waits.length - 1] : null,
      travelTimeMedianSeconds: summarize(travel).median,
      withinSeconds, boardedWithinRate: eligibleReady ? boardedWithin / eligibleReady : null,
      waitByBand: WAIT_BANDS.map(([from, to, label], i) => ({ label, from, to, ...summarize(waitsByBand[i]) })),
      waitByStop: Object.fromEntries(Object.entries(waitsByStop).sort(([a], [b]) => a.localeCompare(b)).map(([stop, w]) => [stop, summarize(w)])),
      // Utilization covers the Mudangi driver pool only; the hospital's dedicated driver DH is reported separately.
      driverCount, driverUtilization: (driverBusySeconds - (driverBusySecondsByDriver.DH || 0)) / (driverCount * (end - start)),
      hospitalDriverBusySeconds: driverBusySecondsByDriver.DH || 0,
      hospitalTripCount: inWindow.filter(t => t.operator === 'gil_hospital').length,
      nonrevenueTripCount: inWindow.filter(t => t.revenue === false).length,
      vehicleKm: vehicleMeters / 1000, departuresByBand,
      boardingRate: eligibleReady ? boardedCount / eligibleReady : null,
      maximumQueue, maximumQueueByStop, driverBusySeconds, driverBusySecondsByDriver, unknownDriverTripCount,
      definition: {
        cohort: 'ready in [start,end], plus initial waiting backlog; exclude boarded before start',
        wait: 'boarded by end only; full ready-to-board duration, including pre-start waiting',
        unboarded: 'eligible ready requests with no boarding by common end; onboard is not unboarded',
        queue: 'ready minus boarded after all same-second events; no display cap',
        drivers: 'union of clipped driverBusyStart-to-ready intervals per driver, including revenue, reposition and turnaround; parked idle excluded',
        percentile: 'linear interpolation at (n-1)*p',
        within: 'boarded within withinSeconds (default 600) of ready, divided by all eligible requests incl. unboarded',
        travelTime: 'ready to alighting, requests completed by end',
        utilization: 'driverBusySeconds / (drivers x window length); the paid shift is the same for every policy',
        vehicleKm: 'trips starting in window x one-way route length (UP 1.101 km, DOWN 0.963 km), revenue and nonrevenue, all operators',
        departuresByBand: 'revenue departures from the first stop; mean interval = band length / departures',
        unknownDrivers: 'unidentified trip intervals summed separately and reported; driver union cannot be verified'
      }
    };
  }
  return Object.freeze({ version: '1.1.0', calculate });
});
