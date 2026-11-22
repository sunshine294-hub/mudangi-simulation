# 개선 시나리오 입력

주 개선안 "점심 운행 중단 없이 5분 운행"은 GTFS를 고치지 않고 시뮬레이션 입력을 바꿉니다.
`scenario_settings.json`은 엔진(`html_sim/sim-engine.js`의 `getScenarioDefaults`)이 쓰는 네 시나리오의 설정입니다.
현재 배차와 다른 값은 `lunchService: true`, `lunchHeadway: 300`(11:30-13:00 배차 목표 5분)뿐입니다.
