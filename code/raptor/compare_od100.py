"""5단계·6단계: 자기 RAPTOR와 참조 구현(smartmob.teaching.raptor) O-D 100건 대조.

    .venv/Scripts/python.exe -X utf8 final_project/my_raptor/compare_od100.py           # 5-2
    .venv/Scripts/python.exe -X utf8 final_project/my_raptor/compare_od100.py --strict  # 6-1 (탑승 조건 <)
"""
import csv
import random
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "mobility-simulation-book"))

from raptor import INF, hms, load_network, raptor, reconstruct  # noqa: E402
from smartmob.data import load_gtfs_feed  # noqa: E402
from smartmob.teaching import raptor as ref  # noqa: E402

GTFS = ROOT / "final_project/sim_bundle_single_hospital/gtfs_standard.zip"
DAY = date(2026, 11, 9)          # 월요일, service_id OBS_MON
SERVICE = "OBS_MON"
SEED = 20261121


def reference_network():
    feed = load_gtfs_feed(GTFS)
    keep = feed["trips"]["service_id"] == SERVICE      # 참조 구현은 달력을 보지 않으므로 같은 날 운행만 넘깁니다
    feed["trips"] = feed["trips"][keep]
    feed["stop_times"] = feed["stop_times"][feed["stop_times"]["trip_id"].isin(feed["trips"]["trip_id"])]
    return ref.TransitData.from_gtfs(feed)


def queries(stops, first, last):
    rng = random.Random(SEED)
    out = []
    for qid in range(1, 101):
        o, d = rng.sample(stops, 2)
        out.append((qid, o, d, rng.randint(first, last)))
    return out


def ref_path(data, res, target):
    legs = []
    for leg in ref.journey(data, res, target):
        if leg["kind"] == "transit":
            legs.append(f"{data.stop_ids[leg['from']]}>{data.stop_ids[leg['to']]}@{hms(leg['board_time'])}")
        elif leg["kind"] == "transfer":
            legs.append(f"{data.stop_ids[leg['from']]}>{data.stop_ids[leg['to']]}@WALK")
    return " | ".join(legs)


def own_path(legs):
    return " | ".join(f"{a}>{b}@{'WALK' if t == 'WALK' else hms(dep)}" for a, b, t, dep, _ in legs)


def main(strict=False):
    net = load_network(GTFS, DAY)
    data = reference_network()
    first = min(p.dep[0][0] for p in net.patterns)
    last = max(p.dep[-1][0] for p in net.patterns)
    rows = []
    for qid, o, d, t0 in queries(sorted(net.stops), first, last):
        mine = raptor(net, o, d, t0, 5, strict=strict)
        r = ref.raptor(data, [(data.index_of[o], 0)], t0, 5)
        di = data.index_of[d]
        a, b = mine.arrival, r.arrival(di)
        ok_reach = (a == INF) == (b == INF)
        diff = abs(a - b) if a < INF and b < INF else None
        tr, rtr = mine.transfers, r.transfers_to(di)
        rows.append(dict(
            query_id=qid, origin=o, destination=d, departure=hms(t0),
            own_arrival=hms(a), ref_arrival=hms(b), diff_s=diff,
            own_transfers=tr, ref_transfers=rtr,
            within_60s=diff is not None and diff <= 60,
            same_transfers=tr == rtr,
            unreachable_any=a == INF or b == INF,
            pass_check=ok_reach and (diff is None or (diff <= 60 and tr == rtr)),
            own_path=own_path(reconstruct(net, mine)), ref_path=ref_path(data, r, di),
        ))
    name = "raptor_comparison_strict.csv" if strict else "raptor_comparison.csv"
    with (HERE / name).open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    count = lambda key: sum(bool(r[key]) for r in rows)
    print(f"{name}: within_60s={count('within_60s')} same_transfers={count('same_transfers')} "
          f"unreachable_any={count('unreachable_any')} "
          f"both_unreachable={sum(r['own_arrival'] == r['ref_arrival'] == 'unreachable' for r in rows)} "
          f"pass={count('pass_check')}/100")
    return rows


if __name__ == "__main__":
    main(strict="--strict" in sys.argv)
