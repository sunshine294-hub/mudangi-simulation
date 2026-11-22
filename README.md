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
| gtfs/ | 현재 배차 GTFS. 시뮬레이션이 실제로 낸 운행(시드 42) |
| gtfs_scenario/ | 개선안(점심 5분 운행) GTFS. 같은 방식으로 만듦 |
| scenario_settings.json | 네 시나리오의 엔진 설정. 개선안은 현재 배차와 `lunchService`, `lunchHeadway: 300`만 다름 |
| demand.csv | 수요. 앞 다섯 열이 교재 수요 형식(request_time 분, 출발·도착 좌표). 시뮬레이션 요청 전체(시드 42), 모두 추정값(source=estimated) |
| boarding_survey.csv | 현장 관측 요약 8건, 모두 관측값(source=observed) |
| raptor_comparison.csv | 직접 구현한 RAPTOR와 참조 구현의 O-D 100건 대조(현재 배차) |
| raptor_comparison_strict.csv | 탑승 조건을 바꾼 변형의 대조(어긋난 건 분석용) |
| raptor_before_after.csv | 같은 O-D 100건의 현재 배차·점심 5분 운행 통행시간 |
| raptor_summary.json | 위 세 표의 집계 |
| geojson/ | 정류장, 노선(도로망 경로) GeoJSON |
| input_validation.json | GTFS 두 개의 validate_feed·MobilityData 검증기 결과, demand.csv의 validate_demand 결과 |
| scenario_card.md | 개선 시나리오 카드 |
| figures/ | 보고서 그림 |
| code/, html_sim/, data/ | 재현 코드와 입력 |
| sensitivity_20261120.json/.csv, figure_data_20261120.json, report_context.json | 보고서 수치의 출처 |

## 재현 (이 폴더에서, 위에서부터 차례로)

필요한 것: Node 20 이상, Python 3.10 이상(matplotlib). 마지막 PDF 단계만 Chrome이 필요하며 다른 위치에 설치했다면 환경변수 `CHROME`에 경로를 넣습니다.

```
node code/run_sensitivity_20261120.cjs
node code/export_figure_data.cjs
node code/export_gtfs.cjs
python code/make_report_figures.py
python code/make_report.py
python code/report_to_pdf.py
```

첫 줄이 시나리오별 다섯 시드 실행(약 15초)이고 나머지가 그림·보고서·PDF를 다시 만듭니다. 절대 경로를 쓰지 않으며 손으로 고친 중간 파일이 없습니다. `report_context.json`은 이 폴더 밖에서 만든 값(도로망 경로와 탑승 기록 대조, 검사 결과 집계)을 옮겨 둔 것입니다.

RAPTOR 대조(`code/raptor/compare_od100.py`)와 입력 검사(`code/validate_inputs.py`)는 교재 저장소의 참조 구현(`smartmob`)과 MobilityData 검증기가 있어야 돌아갑니다. 교재 저장소 위치는 환경변수 `SMARTMOB`으로 지정할 수 있습니다. RAPTOR 코드는 AI 도움 구현입니다(보고서 부록 D).

압축 해제 도구에 따라 한글 파일 이름(대시보드 HTML)이 깨질 수 있습니다. Windows 탐색기나 7-Zip으로 풀면 정상입니다.
