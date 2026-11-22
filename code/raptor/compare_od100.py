"""Own RAPTOR vs the reference implementation (smartmob.teaching.raptor) on 100 O-D queries, and the same 100 queries before/after.

Queries are drawn from the requests in demand.csv, so busy stop pairs come up in proportion to their demand.
Departure times are stratified by time band: 08:20-11:30 (35), 11:30-13:00 (35), 13:00-17:30 (30).
Needs the textbook repo (smartmob); set SMARTMOB to its folder if it is not next to this project.

    python code/raptor/compare_od100.py
"""
import csv
import json
import os
import random
import sys
from datetime import date
from pathlib import Path
from statistics import median

HERE = Path(__file__).resolve().parent
OUT = next(p for p in [HERE.parent / 'submission', HERE.parents[1]] if (p / 'gtfs').is_dir())
BOOK = Path(os.environ.get('SMARTMOB') or next((p / 'mobility-simulation-book' for p in HERE.parents if (p / 'mobility-simulation-book').is_dir()), ''))
if not (BOOK / 'smartmob').is_dir():
    sys.exit('교재 저장소(smartmob)를 찾지 못했습니다. 환경변수 SMARTMOB에 mobility-simulation-book 경로를 넣어 주세요.')
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(BOOK))

from raptor import INF, hms, load_network, raptor, reconstruct  # noqa: E402
from smartmob.data import load_gtfs_feed  # noqa: E402
from smartmob.teaching import raptor as ref  # noqa: E402

DAY = date(2026, 11, 9)          # Monday; both feeds run one WEEKDAY service
SEED = 20261121
BANDS = [('08:20-11:30', 30000, 41400, 35), ('11:30-13:00', 41400, 46800, 35), ('13:00-17:30', 46800, 63000, 30)]


def reference_network(feed_dir):
    return ref.TransitData.from_gtfs(load_gtfs_feed(feed_dir))


def queries():
    with (OUT / 'demand.csv').open(encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    rng, out = random.Random(SEED), []
    for band, lo, hi, k in BANDS:
        pool = [r for r in rows if lo <= int(r['ready_seconds']) < hi]
        out += [(band, r['origin'], r['destination'], int(r['ready_seconds'])) for r in rng.sample(pool, k)]
    return [(i + 1, *q) for i, q in enumerate(sorted(out, key=lambda q: q[3]))]


def ref_path(data, res, target):
    legs = []
    for leg in ref.journey(data, res, target):
        if leg['kind'] == 'transit':
            legs.append(f"{data.stop_ids[leg['from']]}>{data.stop_ids[leg['to']]}@{hms(leg['board_time'])}")
        elif leg['kind'] == 'transfer':
            legs.append(f"{data.stop_ids[leg['from']]}>{data.stop_ids[leg['to']]}@WALK")
    return ' | '.join(legs)


def own_path(legs):
    return ' | '.join(f"{a}>{b}@{'WALK' if t == 'WALK' else hms(dep)}" for a, b, t, dep, _ in legs)


def compare(feed_dir, qs, strict=False):
    net, data = load_network(feed_dir, DAY), reference_network(feed_dir)
    rows = []
    for qid, band, o, d, t0 in qs:
        mine = raptor(net, o, d, t0, 5, strict=strict)
        r = ref.raptor(data, [(data.index_of[o], 0)], t0, 5)
        di = data.index_of[d]
        a, b = mine.arrival, r.arrival(di)
        diff = abs(a - b) if a < INF and b < INF else None
        tr, rtr = mine.transfers, r.transfers_to(di)
        rows.append(dict(query_id=qid, band=band, origin=o, destination=d, departure=hms(t0),
                         own_arrival=hms(a), ref_arrival=hms(b), diff_s=diff, own_transfers=tr, ref_transfers=rtr,
                         within_60s=diff is not None and diff <= 60, same_transfers=tr == rtr, unreachable_any=a == INF or b == INF,
                         pass_check=((a == INF) == (b == INF)) and (diff is None or (diff <= 60 and tr == rtr)),
                         own_path=own_path(reconstruct(net, mine)), ref_path=ref_path(data, r, di), _arr=a, _t0=t0))
    return rows


def write(name, rows):
    with (OUT / name).open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=[k for k in rows[0] if not k.startswith('_')], extrasaction='ignore')
        w.writeheader(); w.writerows(rows)


def main():
    qs = queries()
    before, after = compare(OUT / 'gtfs', qs), compare(OUT / 'gtfs_scenario', qs)
    write('raptor_comparison.csv', before)
    # deliberate mismatch (textbook step 6): boarding needs dep > arrival instead of dep >= arrival
    strict = compare(OUT / 'gtfs', qs, strict=True)
    write('raptor_comparison_strict.csv', strict)
    bad = [r for r in strict if not r['pass_check']]
    pairs = [dict(query_id=b['query_id'], band=b['band'], origin=b['origin'], destination=b['destination'], departure=b['departure'],
                  arrival_current=b['own_arrival'], arrival_lunch5=a['own_arrival'],
                  travel_min_current=round((b['_arr'] - b['_t0']) / 60, 2) if b['_arr'] < INF else None,
                  travel_min_lunch5=round((a['_arr'] - a['_t0']) / 60, 2) if a['_arr'] < INF else None,
                  lunch5_ref_pass=a['pass_check']) for b, a in zip(before, after)]
    write('raptor_before_after.csv', pairs)
    check = lambda rows: dict(n=len(rows), passed=sum(r['pass_check'] for r in rows), reached=sum(not r['unreachable_any'] for r in rows),
                              max_diff_s=max([r['diff_s'] for r in rows if r['diff_s'] is not None], default=0))
    bands = {}
    for band, *_ in BANDS:
        p = [r for r in pairs if r['band'] == band and r['travel_min_current'] is not None and r['travel_min_lunch5'] is not None]
        bands[band] = dict(n=len(p), median_current=median(r['travel_min_current'] for r in p), median_lunch5=median(r['travel_min_lunch5'] for r in p),
                           mean_current=round(sum(r['travel_min_current'] for r in p) / len(p), 2), mean_lunch5=round(sum(r['travel_min_lunch5'] for r in p) / len(p), 2),
                           faster=sum(r['travel_min_lunch5'] < r['travel_min_current'] for r in p), slower=sum(r['travel_min_lunch5'] > r['travel_min_current'] for r in p))
    summary = dict(selection=dict(seed=SEED, source='demand.csv', bands=[b[:1] + b[3:] for b in BANDS]),
                   pairs=len({(q[2], q[3]) for q in qs}), current=check(before), lunch5=check(after), before_after=bands,
                   strict=dict(**check(strict), example={k: bad[0][k] for k in ('query_id', 'origin', 'destination', 'departure', 'own_arrival', 'ref_arrival', 'diff_s', 'own_path', 'ref_path')} if bad else None))
    (OUT / 'raptor_summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
