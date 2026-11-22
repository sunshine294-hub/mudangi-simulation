"""Render report.md from the saved results (no other project folders needed).

    node code/run_sensitivity_20261120.cjs
    node code/export_figure_data.cjs
    python code/make_report_figures.py
    python code/make_report.py
    python code/report_to_pdf.py
"""
import json
from pathlib import Path

import report_section4

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'submission' if (ROOT / 'submission').exists() else ROOT  # repo layout, else zip root


def main():
    ctx = json.loads((OUT / 'report_context.json').read_text(encoding='utf-8'))
    ctx['figdata'] = json.loads((OUT / 'figure_data_20261120.json').read_text(encoding='utf-8'))
    sens = json.loads((OUT / 'sensitivity_20261120.json').read_text(encoding='utf-8'))
    (OUT / 'report.md').write_text(report_section4.render(sens, ctx), encoding='utf-8')
    print(OUT / 'report.md')


if __name__ == '__main__':
    main()
