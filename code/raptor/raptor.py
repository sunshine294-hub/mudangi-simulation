"""무당이 RAPTOR.

표준 라이브러리만 씁니다. 실행하면 작은 예제 검사가 돕니다.

    python final_project/my_raptor/raptor.py
"""
from __future__ import annotations

import csv
import io
import math
import zipfile
from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

INF = math.inf
# 도보 환승 규칙은 참조 구현(smartmob.teaching.raptor)과 같은 값입니다.
WALK_SPEED_MPS = 1.2
MAX_TRANSFER_M = 500.0
DETOUR_FACTOR = 1.35


# --------------------------------------------------------------------------- #
# 1단계: GTFS 읽기와 패턴
# --------------------------------------------------------------------------- #

def to_seconds(text: str) -> int:
    """'HH:MM:SS' -> 서비스일 시작(정오 - 12시간) 기준 초. 25:10:00 = 90600, 24시간으로 나누지 않음."""
    h, m, s = (int(x) for x in text.strip().split(":"))
    return h * 3600 + m * 60 + s


def _reader(source: Path):
    """폴더와 zip 모두에서 'name.txt'를 dict 행 목록으로 읽습니다."""
    if source.suffix == ".zip":
        zf = zipfile.ZipFile(source)
        return lambda name: list(csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="utf-8-sig")))
    return lambda name: list(csv.DictReader((source / name).open(encoding="utf-8-sig", newline="")))


def active_services(read, day: date) -> set[str]:
    """calendar.txt의 요일·기간 조건과 calendar_dates.txt의 추가(1)/제외(2)를 적용합니다."""
    ymd = day.strftime("%Y%m%d")
    weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][day.weekday()]
    services = set()
    try:
        for row in read("calendar.txt"):
            if row["start_date"] <= ymd <= row["end_date"] and row[weekday] == "1":
                services.add(row["service_id"])
    except (KeyError, FileNotFoundError):  # calendar.txt 없음 (zip은 KeyError, 폴더는 FileNotFoundError)
        pass
    try:
        for row in read("calendar_dates.txt"):
            if row["date"] == ymd:
                (services.add if row["exception_type"] == "1" else services.discard)(row["service_id"])
    except (KeyError, FileNotFoundError):  # calendar_dates.txt 없음 (zip은 KeyError, 폴더는 FileNotFoundError)
        pass
    return services


@dataclass
class Pattern:
    route_id: str
    stops: list[str]
    trip_ids: list[str] = field(default_factory=list)
    arr: list[list[int]] = field(default_factory=list)   # arr[운행][위치]
    dep: list[list[int]] = field(default_factory=list)   # dep[운행][위치]
    dep_by_pos: list[list[int]] = field(default_factory=list)  # 이분 탐색용 열


def overtakes(later_arr, later_dep, earlier_arr, earlier_dep) -> bool:
    """먼저 출발한 운행보다 어느 정류장에서든 일찍 도착/출발하면 추월입니다."""
    return any(a < b for a, b in zip(later_arr, earlier_arr)) or any(a < b for a, b in zip(later_dep, earlier_dep))


def build_patterns(trips) -> list[Pattern]:
    """trips: (trip_id, route_id, stops, arr, dep) 목록.

    (노선, 정류장 순서)가 같은 운행을 묶고 첫 정류장 출발 순으로 정렬합니다.
    앞 운행을 추월하는 운행은 추월이 없는 하위 패턴으로 나눕니다.
    """
    groups: dict[tuple, list] = {}
    for trip in trips:
        groups.setdefault((trip[1], tuple(trip[2])), []).append(trip)
    patterns = []
    for (route_id, seq), members in groups.items():
        members.sort(key=lambda t: (t[4][0], t[3][-1]))
        subs: list[Pattern] = []
        for trip_id, _, _, arr, dep in members:
            # 마지막 운행만 보면 됩니다. 하위 패턴 안은 이미 정렬되어 있어 추월 관계가 이어집니다.
            home = next((p for p in subs if not overtakes(arr, dep, p.arr[-1], p.dep[-1])), None)
            if home is None:
                home = Pattern(route_id, list(seq))
                subs.append(home)
            home.trip_ids.append(trip_id)
            home.arr.append(arr)
            home.dep.append(dep)
        patterns.extend(subs)
    for p in patterns:
        p.dep_by_pos = [[d[i] for d in p.dep] for i in range(len(p.stops))]
    return patterns


@dataclass
class Network:
    stops: list[str]
    patterns: list[Pattern]
    transfers: dict[str, list[tuple[str, int]]]          # 정류장 -> [(정류장, 도보 초)]
    routes_by_stop: dict[str, list[tuple[int, int]]] = field(default_factory=dict)

    def __post_init__(self):
        self.routes_by_stop = {s: [] for s in self.stops}
        for pi, p in enumerate(self.patterns):
            for pos, s in enumerate(p.stops):
                self.routes_by_stop[s].append((pi, pos))


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(min(1.0, math.sqrt(a)))


def walk_transfers(coords: dict[str, tuple[float, float]]) -> dict[str, list[tuple[str, int]]]:
    """직선거리 x 1.35 <= 500m 인 정류장 쌍을 도보로 잇습니다. ponytail: O(n^2), 정류장 9개라 충분."""
    out = {s: [] for s in coords}
    for a, (la, oa) in coords.items():
        for b, (lb, ob) in coords.items():
            if a != b:
                m = haversine_m(la, oa, lb, ob) * DETOUR_FACTOR
                if m <= MAX_TRANSFER_M:
                    out[a].append((b, math.ceil(m / WALK_SPEED_MPS)))
    return out


def load_network(source, day: date) -> Network:
    """GTFS 폴더/zip을 읽어 day에 다니는 운행만으로 Network를 만듭니다."""
    read = _reader(Path(source))
    services = active_services(read, day)
    route_of = {r["trip_id"]: r["route_id"] for r in read("trips.txt") if r["service_id"] in services}
    rows: dict[str, list] = {}
    for r in read("stop_times.txt"):
        if r["trip_id"] in route_of:
            rows.setdefault(r["trip_id"], []).append(r)
    trips = []
    for trip_id, rs in rows.items():
        rs.sort(key=lambda r: int(r["stop_sequence"]))   # 파일 순서가 아니라 stop_sequence 순
        if len(rs) < 2:
            continue
        trips.append((trip_id, route_of[trip_id], [r["stop_id"] for r in rs],
                      [to_seconds(r["arrival_time"]) for r in rs],
                      [to_seconds(r["departure_time"]) for r in rs]))
    stops = read("stops.txt")
    coords = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"])) for s in stops}
    return Network(list(coords), build_patterns(trips), walk_transfers(coords))


# --------------------------------------------------------------------------- #
# 2단계: 탈 수 있는 가장 이른 운행
# --------------------------------------------------------------------------- #

def earliest_trip(pattern: Pattern, i: int, tau: float, strict: bool = False) -> int | None:
    """dep[t][i] >= tau 인 가장 작은 t. 없으면 None.

    추월이 없어 i번째 열이 정렬되어 있으므로 이분 탐색합니다.
    strict=True 는 6단계 실험용(dep > tau).
    """
    if tau == INF:
        return None
    col = pattern.dep_by_pos[i]
    t = bisect_left(col, tau)
    if strict:
        while t < len(col) and col[t] == tau:
            t += 1
    return t if t < len(col) else None


# --------------------------------------------------------------------------- #
# 3단계: 라운드별 갱신
# --------------------------------------------------------------------------- #

@dataclass
class Result:
    rounds: list[dict[str, float]]                # rounds[k][stop]: 탑승 k번 이하 최선
    best: dict[str, float]
    parent: dict[tuple[int, str], tuple]          # (k, stop) -> ('ride', pi, trip, board_pos, alight_pos) | ('walk', from, sec)
    origin: str
    destination: str
    depart: int

    @property
    def arrival(self) -> float:
        return self.best[self.destination]

    @property
    def transfers(self) -> int | None:
        """최선 도착을 처음 얻은 라운드 k에서 환승 = 탑승 - 1."""
        if self.arrival == INF:
            return None
        k = next(k for k, row in enumerate(self.rounds) if row[self.destination] == self.arrival)
        return max(k - 1, 0)


def raptor(net: Network, origin: str, destination: str, depart_time: int,
           max_rounds: int = 5, strict: bool = False) -> Result:
    best = {s: INF for s in net.stops}
    rounds = [dict(best)]
    rounds[0][origin] = best[origin] = depart_time
    parent: dict[tuple[int, str], tuple] = {}
    marked = {origin}

    for k in range(1, max_rounds + 1):
        prev = rounds[k - 1]
        cur = dict(prev)
        rounds.append(cur)

        # 지난 라운드에 좋아진 정류장을 지나는 패턴만, 그 정류장 중 가장 앞 위치부터
        queue: dict[int, int] = {}
        for s in marked:
            for pi, pos in net.routes_by_stop[s]:
                queue[pi] = min(pos, queue.get(pi, pos))

        ridden: set[str] = set()
        for pi, start in queue.items():
            p = net.patterns[pi]
            trip, board = None, 0
            for pos in range(start, len(p.stops)):
                s = p.stops[pos]
                if trip is not None and p.arr[trip][pos] < best[s]:
                    cur[s] = best[s] = p.arr[trip][pos]
                    parent[(k, s)] = ("ride", pi, trip, board, pos)
                    ridden.add(s)
                # 지난 라운드 값으로 여기서 더 이른 운행을 탈 수 있으면 갈아탑니다.
                t = earliest_trip(p, pos, prev[s], strict)
                if t is not None and (trip is None or t < trip):
                    trip, board = t, pos

        # 차에서 내린 정류장에서만 한 번 걷습니다. 걸어서 좋아진 곳은 다음 라운드에 탑니다.
        walked: set[str] = set()
        for s in ridden:
            for other, sec in net.transfers.get(s, []):
                if cur[s] + sec < best[other]:
                    cur[other] = best[other] = cur[s] + sec
                    parent[(k, other)] = ("walk", s, sec)
                    walked.add(other)

        marked = ridden | walked
        if not marked:
            break
    return Result(rounds, best, parent, origin, destination, depart_time)


# --------------------------------------------------------------------------- #
# 4단계: 경로 복원
# --------------------------------------------------------------------------- #

def reconstruct(net: Network, res: Result) -> list[tuple]:
    """[(탑승 정류장, 하차 정류장, trip_id 또는 'WALK', 출발 초, 도착 초)]."""
    if res.arrival == INF:
        return []
    s = res.destination
    k = next(k for k, row in enumerate(res.rounds) if row[s] == res.arrival)
    legs = []
    while s != res.origin or k > 0:
        entry = res.parent.get((k, s))
        if entry is None:          # 이 라운드에서 바뀌지 않은 값 -> 앞 라운드에서 온 것
            k -= 1
            if k < 0:
                raise RuntimeError("복원 실패")
            continue
        if entry[0] == "walk":
            _, frm, sec = entry
            legs.append((frm, s, "WALK", res.rounds[k][s] - sec, res.rounds[k][s]))
            s = frm
        else:
            _, pi, trip, board, alight = entry
            p = net.patterns[pi]
            legs.append((p.stops[board], p.stops[alight], p.trip_ids[trip],
                         p.dep[trip][board], p.arr[trip][alight]))
            s, k = p.stops[board], k - 1
        if s == res.origin and k == 0:
            break
    return legs[::-1]


def hms(sec: float) -> str:
    return "unreachable" if sec == INF else f"{int(sec)//3600:02d}:{int(sec)%3600//60:02d}:{int(sec)%60:02d}"


# --------------------------------------------------------------------------- #
# 작은 예제 검사
# --------------------------------------------------------------------------- #

def _demo():
    T = to_seconds
    assert T("25:10:00") == 90600

    # 1-2 / 1-6: A차가 B차에 추월당함 -> 두 패턴으로 나뉘어야 함
    ab = [("A", "R", ["U01", "U04"], [T("08:20:00"), T("08:35:00")], [T("08:20:00"), T("08:35:00")]),
          ("B", "R", ["U01", "U04"], [T("08:25:00"), T("08:31:00")], [T("08:25:00"), T("08:31:00")])]
    ps = build_patterns(ab)
    assert len(ps) == 2, ps
    net = Network(["U01", "U04"], ps, {})
    assert raptor(net, "U01", "U04", T("08:15:00")).arrival == T("08:31:00")
    assert raptor(net, "U01", "U04", T("08:22:00")).arrival == T("08:31:00")

    # 0단계 손 예제 재구성 (시각은 기록에서 역산한 값. 원래 표와 다르면 고쳐 주세요)
    #   상행 1번 차 U01 08:20, 2번 차 U01 08:23 -> U04 08:29
    #   U04 -> D01 도보 60초, 하행 3번 차 D01 08:26 -> D05 08:30
    up = [("1", "UP", ["U01", "U04"], [T("08:20:00"), T("08:26:00")], [T("08:20:00"), T("08:26:00")]),
          ("2", "UP", ["U01", "U04"], [T("08:23:00"), T("08:29:00")], [T("08:23:00"), T("08:29:00")])]
    down = [("3", "DN", ["D01", "D05"], [T("08:26:00"), T("08:30:00")], [T("08:26:00"), T("08:30:00")])]
    net = Network(["U01", "U04", "D01", "D05"], build_patterns(up + down),
                  {"U04": [("D01", 60)], "D01": [("U04", 60)]})
    p_up = next(p for p in net.patterns if p.route_id == "UP")
    # 2-4: 08:21에 U01 -> 2번 차(인덱스 1), 08:20 정각 -> 1번 차(같으면 탐), 08:24 -> 없음
    assert earliest_trip(p_up, 0, T("08:21:00")) == 1
    assert earliest_trip(p_up, 0, T("08:20:00")) == 0
    assert earliest_trip(p_up, 0, T("08:20:00"), strict=True) == 1
    assert earliest_trip(p_up, 0, T("08:24:00")) is None
    r = raptor(net, "U01", "D05", T("08:21:00"))
    assert [hms(r.rounds[k]["U04"]) for k in range(3)] == ["unreachable", "08:29:00", "08:29:00"]
    assert [hms(r.rounds[k]["D01"]) for k in range(3)] == ["unreachable", "08:30:00", "08:30:00"]
    assert r.arrival == INF and r.transfers is None and reconstruct(net, r) == []
    r = raptor(net, "U01", "D01", T("08:21:00"))
    assert reconstruct(net, r) == [("U01", "U04", "2", T("08:23:00"), T("08:29:00")),
                                   ("U04", "D01", "WALK", T("08:29:00"), T("08:30:00"))]
    assert r.transfers == 0  # 도보는 환승 횟수에 넣지 않음

    # 환승 1회: 위 예제에 하행 4번 차 D01 08:31 -> D05 08:35 추가
    down.append(("4", "DN", ["D01", "D05"], [T("08:31:00"), T("08:35:00")], [T("08:31:00"), T("08:35:00")]))
    net = Network(net.stops, build_patterns(up + down), net.transfers)
    r = raptor(net, "U01", "D05", T("08:21:00"))
    assert r.arrival == T("08:35:00") and r.transfers == 1
    assert [leg[2] for leg in reconstruct(net, r)] == ["2", "WALK", "4"]
    print("demo ok")


if __name__ == "__main__":
    _demo()
