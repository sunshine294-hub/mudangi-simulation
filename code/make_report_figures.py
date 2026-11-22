"""Report figures from the HTML engine outputs (seed 42 per-request data + 5-seed sensitivity JSON).

    node code/export_figure_data.cjs && python code/make_report_figures.py
"""
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / 'submission' if (PROJECT / 'submission').exists() else PROJECT  # repo layout, else zip root
FIG = OUT / 'figures'
plt.rcParams.update({'font.family': 'Malgun Gothic', 'axes.unicode_minus': False, 'font.size': 9})
NAME = {'S0': '현재 배차', 'S2': '점심 5분 운행', 'S1': '길병원버스 추가 투입', 'S5': '대기열 맞춤·회송'}
STOP = {'U01': '반도체대학', 'D01': 'AI공학관', 'D03': '교육대학', 'D04': '예술체육대학'}
COLOR = {'S0': '#5b6770', 'S2': '#c0392b', 'S1': '#1f7a8c', 'S5': '#b8860b'}
hm = lambda t: f'{int(t // 3600):02d}:{int(t % 3600 // 60):02d}'


def flow():
    steps = ['현장 관측\n(11월 중 나흘)', '정류장·GTFS\n수요 재구성', '시뮬레이션 엔진\n현황 재현·보정', '운영 시나리오\n비교', '운영전략\n선정']
    fig, ax = plt.subplots(figsize=(8, 1.4)); ax.set_axis_off(); ax.set_xlim(0, 10); ax.set_ylim(0, 1)
    for i, s in enumerate(steps):
        x = 0.1 + i * 2
        ax.add_patch(FancyBboxPatch((x, .15), 1.6, .7, boxstyle='round,pad=0.02', fc='#f4f1ec', ec='#5b6770'))
        ax.text(x + .8, .5, s, ha='center', va='center', fontsize=8.5)
        if i < len(steps) - 1:
            ax.annotate('', xy=(x + 2, .5), xytext=(x + 1.62, .5), arrowprops=dict(arrowstyle='->', color='#5b6770'))
    fig.savefig(FIG / 'fig1_flow.png', dpi=200, bbox_inches='tight'); plt.close(fig)


def demand(fd):
    b = fd['demandBins']; t = [x['t'] + 150 for x in b]
    fig, ax = plt.subplots(figsize=(7, 2.6), layout='constrained')
    ax.axvspan(41400, 44100, color='#c0392b', alpha=.08, label='무당이 운행 중단(현재)')
    ax.plot(t, [x['UP'] for x in b], color='#1f7a8c', label='상행(반도체대학 등)')
    ax.plot(t, [x['DOWN'] for x in b], color='#b8860b', label='하행(AI공학관 등)')
    ax.set_xticks(range(30600, 63001, 3600)); ax.set_xticklabels([hm(x) for x in range(30600, 63001, 3600)])
    ax.set(ylabel='5분당 요청(건)'); ax.legend(fontsize=7.5, loc='upper right'); ax.grid(alpha=.3)
    fig.savefig(FIG / 'fig3_demand.png', dpi=200); plt.close(fig)


def waits(fd):
    fig, ax = plt.subplots(figsize=(6, 2.8), layout='constrained')
    for s in ['S0', 'S2', 'S1', 'S5']:
        w = np.sort(fd['scenarios'][s]['waits'])
        ax.plot(w, np.arange(1, len(w) + 1) / len(w), color=COLOR[s], label=NAME[s], lw=1.6 if s in ('S0', 'S2') else 1)
    ax.axhline(.9, color='gray', ls=':', lw=.8); ax.text(29.5, .91, 'P90', ha='right', fontsize=7, color='gray')
    ax.set(xlim=(0, 30), ylim=(0, 1), xlabel='대기시간(분)', ylabel='누적 비율(탑승한 요청)'); ax.legend(fontsize=7.5); ax.grid(alpha=.3)
    fig.savefig(FIG / 'fig4_wait_cdf.png', dpi=200); plt.close(fig)


def spatial(fd):
    coords = PROJECT / 'data_collection/direction_stop_coordinates.csv'
    if not coords.exists(): coords = PROJECT / 'data/direction_stop_coordinates.csv'
    with coords.open(encoding='utf-8-sig') as f:
        pts = list(csv.DictReader(f))
    a, b = fd['scenarios']['S0']['byStop'], fd['scenarios']['S2']['byStop']
    fig, axes = plt.subplots(1, 2, figsize=(8, 3.2), layout='constrained', sharey=True)
    for ax, key, title in [(axes[0], 'S0', '현재 배차'), (axes[1], 'S2', '점심 5분 운행')]:
        d = fd['scenarios'][key]['byStop']
        for p in pts:
            s = p['stop_id']; v = d.get(s)
            if not v: continue
            x, y = float(p['stop_lon']), float(p['stop_lat'])
            share = 100 * v['over10'] / v['n']
            ax.scatter(x, y, s=30 + share * 25, color='#c0392b' if share >= 5 else '#1f7a8c', alpha=.75, ec='k', lw=.4)
            ax.annotate(f"{STOP.get(s, s)} {share:.0f}%", (x, y), xytext=(5, 3), textcoords='offset points', fontsize=7)
        ax.set_title(title, fontsize=9); ax.ticklabel_format(useOffset=False); ax.tick_params(labelsize=6.5); ax.margins(.2)
    axes[0].set_ylabel('위도'); fig.supxlabel('경도', fontsize=8)
    fig.suptitle('정류장별 10분 넘게 기다린 요청의 비율 (시드 42, 원 크기 = 비율)', fontsize=9)
    fig.savefig(FIG / 'fig5_spatial.png', dpi=200); plt.close(fig)


def pareto(sens):
    rows = {(r['group'], r['condition'], r['scenario']): r for r in sens['rows']}
    pts = [(NAME[s], rows[('seed_repeat', 'base', s)], COLOR[s]) for s in ['S0', 'S2', 'S1', 'S5']]
    pts += [(f'점심 {c[:-3]}분 목표', rows[('lunch_headway', c, 'S1A')], '#999999') for c in ['2min', '3min', '10min']]
    pts += [('운행 중단 시간만 5분', rows[('lunch_split', 'break_only', 'S0')], '#999999')]
    fig, ax = plt.subplots(figsize=(6, 3), layout='constrained')
    off = {'운행 중단 시간만 5분': (-20, 8), NAME['S2']: (-10, -13), '점심 2분 목표': (-10, -15), NAME['S1']: (-75, 10)}
    for n, r, c in pts:
        ax.scatter(r['km'], r['p90'], color=c, s=40, zorder=3)
        ax.annotate(n, (r['km'], r['p90']), xytext=off.get(n, (5, 3)), textcoords='offset points', fontsize=7)
    ax.margins(x=.08, y=.12)
    ax.set(xlabel='하루 차량-km', ylabel='대기시간 P90(분)'); ax.grid(alpha=.3)
    fig.savefig(FIG / 'fig6_pareto.png', dpi=200); plt.close(fig)


def stop_map():
    src = PROJECT / 'data_collection'
    if not (src / 'osm_roads.geojson').exists():  # ponytail: the zip ships fig2; OSM extracts stay in the repo
        return
    from matplotlib.collections import LineCollection, PolyCollection
    roads = [r['geometry']['coordinates'] for r in json.loads((src / 'osm_roads.geojson').read_text(encoding='utf-8'))['features']]
    blds = [b['geometry']['coordinates'][0] for b in json.loads((src / 'osm_buildings.geojson').read_text(encoding='utf-8'))['features']]
    with (src / 'direction_stop_coordinates.csv').open(encoding='utf-8-sig') as f:
        pts = list(csv.DictReader(f))
    fig, ax = plt.subplots(figsize=(7, 5.2), layout='constrained')
    ax.add_collection(PolyCollection(blds, fc='#e3e7ec', ec='#c3cbd4', lw=.4))
    ax.add_collection(LineCollection(roads, colors='#a3adb8', lw=.6))
    for d, c, lab, off in [('U', '#1f7a8c', '상행 정류장', (-6, 6)), ('D', '#b8860b', '하행 정류장', (6, -11))]:
        p = [q for q in pts if q['stop_id'].startswith(d)]
        x, y = [float(q['stop_lon']) for q in p], [float(q['stop_lat']) for q in p]
        ax.plot(x, y, color=c, ls='--', lw=1.2, alpha=.8)
        ax.scatter(x, y, s=45, color=c, ec='white', lw=1, zorder=3, label=lab)
        for q, xi, yi in zip(p, x, y):
            ax.annotate(f"{q['stop_id']} {'하행 종점' if q['stop_id'] == 'D05' else q['stop_name'].rsplit(' ', 1)[0]}", (xi, yi), xytext=off, textcoords='offset points',
                        fontsize=7.5, color=c, ha='right' if d == 'U' else 'left', bbox=dict(fc='white', ec='none', alpha=.8, pad=.6), zorder=4)
    xs = [float(q['stop_lon']) for q in pts]; ys = [float(q['stop_lat']) for q in pts]
    ax.set_xlim(min(xs) - .0009, max(xs) + .0014); ax.set_ylim(min(ys) - .0005, max(ys) + .0005)
    ax.set_aspect(1 / np.cos(np.radians(np.mean(ys)))); ax.set_xticks([]); ax.set_yticks([])
    ax.legend(loc='upper left', fontsize=7.5)
    ax.text(.99, .01, '점선: 정차 순서를 이은 직선(실제 도로 경로 아님) · 지도 © OpenStreetMap contributors', transform=ax.transAxes,
            ha='right', va='bottom', fontsize=6.5, color='#5b6770', bbox=dict(fc='white', ec='none', alpha=.9, pad=1))
    fig.savefig(FIG / 'fig2_stop_map.png', dpi=200); plt.close(fig)


def main():
    FIG.mkdir(exist_ok=True)
    fd = json.loads((OUT / 'figure_data_20261120.json').read_text(encoding='utf-8'))
    sens = json.loads((OUT / 'sensitivity_20261120.json').read_text(encoding='utf-8'))
    flow(); stop_map(); demand(fd); waits(fd); spatial(fd); pareto(sens)
    print('figures ok')


if __name__ == '__main__':
    main()
