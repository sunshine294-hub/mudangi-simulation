"""Check the submitted GTFS and demand: MobilityData validator, textbook validate_feed / validate_demand.

Needs the local validator (tools/gtfs_validator) and the textbook repo (smartmob); run from the repo, not the zip:

    .venv/Scripts/python.exe -X utf8 final_project/code/validate_inputs.py
"""
import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / 'submission'
TOOLS = PROJECT / 'tools/gtfs_validator'
REPORTS = PROJECT / 'gtfs_validation_20261122'
sys.path.insert(0, str(PROJECT.parent / 'mobility-simulation-book'))
from smartmob.data import load_gtfs_feed  # noqa: E402
from smartmob.data.demand import validate_demand  # noqa: E402
from smartmob.data.gtfs import describe_feed, validate_feed  # noqa: E402


def mobilitydata(feed):
    out = REPORTS / feed
    java = TOOLS / 'java/jdk-17.0.21+9-jre/bin/java.exe'
    subprocess.run([str(java), '-Dfile.encoding=UTF-8', '-jar', str(TOOLS / 'gtfs-validator-8.0.1-cli.jar'), '-i', str(OUT / feed),
                    '-o', str(out), '-c', 'KR', '-d', '2026-11-09', '-svu'], check=True, capture_output=True)
    notices = json.loads((out / 'report.json').read_text(encoding='utf-8'))['notices']
    count = lambda sev: sum(n['totalNotices'] for n in notices if n['severity'] == sev)
    return {'errors': count('ERROR'), 'warnings': count('WARNING'), 'infos': count('INFO'),
            'notice_codes': sorted({f"{n['severity']}:{n['code']}" for n in notices})}


def main():
    result = {'validator': 'MobilityData gtfs-validator 8.0.1', 'service_date': '2026-11-09'}
    for feed in ['gtfs', 'gtfs_scenario']:
        f = load_gtfs_feed(OUT / feed)
        validate_feed(f)  # raises on a missing table or column
        result[feed] = {'validate_feed': 'pass', **describe_feed(f), 'mobilitydata': mobilitydata(feed)}
    demand = pd.read_csv(OUT / 'demand.csv', encoding='utf-8-sig')
    validate_demand(demand)  # raises on contract violations
    result['demand'] = {'validate_demand': 'pass', 'rows': len(demand)}
    (OUT / 'input_validation.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
