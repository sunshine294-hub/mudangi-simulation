# 무당이 점심 운행 개선 분석

## 온라인으로 보기

- 대시보드: https://sunshine294-hub.github.io/mudangi-simulation/
- 보고서 PDF: https://sunshine294-hub.github.io/mudangi-simulation/report.pdf
- 저장소: https://github.com/sunshine294-hub/mudangi-simulation

## 제출물

| 파일 | 내용 |
|---|---|
| report.pdf / report.md | 보고서 (PDF가 제출본) |
| index.html | 대시보드. 브라우저로 열면 오프라인에서 동작 |
| gtfs/ | 현재 배차 GTFS (월요일·화-금 두 서비스) |
| gtfs_scenario/ | 개선 시나리오 설명. 이 시나리오는 GTFS가 아니라 시뮬레이션 입력(점심 배차 목표)을 바꿈 |
| demand.csv | 수요 프로파일. 시뮬레이션 요청 전체(시드 42), 모두 추정값(source=estimated) |
| boarding_survey.csv | 현장 관측 요약 8건, 모두 관측값(source=observed) |
| raptor_comparison.csv | 직접 구현한 RAPTOR와 참조 구현의 O-D 100건 대조 |
| geojson/ | 정류장·노선 GeoJSON |
| gtfs_validation/ | MobilityData 검증기 결과 요약(검사 88회) |
| scenario_card.md | 개선 시나리오 카드 |
| figures/ | 보고서 그림 |
| code/, html_sim/, data/ | 재현 코드와 입력 |
| sensitivity_20261120.json/.csv, figure_data_20261120.json, report_context.json | 보고서 수치의 출처 |

## 재현 (이 폴더에서, 위에서부터 차례로)

필요한 것: Node 20 이상, Python 3.10 이상(matplotlib). 마지막 PDF 단계만 Chrome이 필요하며 다른 위치에 설치했다면 환경변수 `CHROME`에 경로를 넣습니다.

```
node code/run_sensitivity_20261120.cjs
node code/export_figure_data.cjs
python code/make_report_figures.py
python code/make_report.py
python code/report_to_pdf.py
```

첫 줄이 시나리오별 다섯 시드 실행(약 15초)이고 나머지가 그림·보고서·PDF를 다시 만듭니다. 절대 경로를 쓰지 않으며 손으로 고친 중간 파일이 없습니다. `report_context.json`은 이 폴더 밖의 검사 결과(GTFS 검증기, 이전 경로 검사, RAPTOR 대조 집계)를 옮겨 둔 값입니다.

RAPTOR 코드(`code/raptor/`)는 교재 저장소의 참조 구현(`smartmob`)이 설치되어 있어야 대조를 다시 돌릴 수 있으므로, 이 폴더에서는 결과(`raptor_comparison.csv`)만 확인할 수 있습니다. AI 도움 구현입니다(보고서 부록 D).

압축 해제 도구에 따라 한글 파일 이름(대시보드 HTML)이 깨질 수 있습니다. Windows 탐색기나 7-Zip으로 풀면 정상입니다.
