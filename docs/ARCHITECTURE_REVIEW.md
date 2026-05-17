# Architecture Review

## 1. 프로젝트 목적 요약

### 목적
이 프로그램은 틀린 그림 찾기 영상을 만들기 위한 **저작도구 + 프리뷰 + 최종 export 도구**다. 실시간 게임 엔진이 아니라, 사람이 미리 넣은 데이터와 리소스를 기준으로 장면을 구성하고 영상을 생성하는 것이 목표다.

### 핵심 사용자 흐름
- 리소스 폴더에 이미지/영상/BGM/SFX를 넣는다.
- 엑셀에서 scene 순서와 각 scene 메타데이터를 관리한다.
- 관리자 패널에서 정답 좌표를 저장한다.
- 프리뷰로 장면을 확인한다.
- MP4로 export 한다.

### 반드시 유지해야 하는 기능
- `Scenes`, `Audio`, `Markers` 등 workbook 기반 authoring
- 파일명 스캔으로 step 수를 판단하는 규칙
- 관리자 패널에서 step별 좌우 이미지 클릭으로 좌표 저장
- Pixi 프리뷰에서 HUD/꿀벌/정답 마커/파티클/전환 확인
- 최종 MP4 export

### 현재 동작 중인 기능
- workbook 파싱/저장
- sample 프로젝트 프리뷰
- 마커 authoring
- build/tsc

### 현재 불안정한 기능
- export 동기화
- export parity
- 긴 export의 신뢰성
- export 속도와 progress 신뢰도

## 2. 현재 코드베이스 구조

### 주요 디렉터리/파일 역할
- `src/main.ts`
  - 앱 bootstrap, DOM wiring, preview/admin/export orchestration
- `src/runtime/project-types.ts`
  - workbook source 타입과 runtime model 타입
- `src/runtime/load-project-workbook.ts`
  - `.xlsx` fetch 및 parse 진입점
- `src/runtime/workbook-sheet-parsers.ts`
  - `Project`, `Scenes`, `Effects`, `Audio`, `Markers`, `Resources`, legacy `Hud` 파서
- `src/runtime/project-model-resolution.ts`
  - workbook + resourceIndex -> resolved scene/model 조립
- `src/runtime/pixi-preview-app.ts`
  - Pixi 렌더러, HUD, 타이머, 마커, 파티클, scene video, 책장 전환
- `src/runtime/preview-session.ts`
  - scene apply / seek / play / tick state machine
- `src/runtime/admin-authoring-panel.ts`
  - 관리자 패널 UI와 marker 저장 흐름
- `src/runtime/workbook-persistence.ts`
  - File System Access 기반 원본 workbook 연결 저장 / copy export
- `src/runtime/export-timeline.ts`
  - export timeline(scene durations + transitions) 조립
- `src/runtime/export-audio-mix.ts`
  - 오프라인 오디오 믹스
- `src/runtime/export-encoder.ts`
  - WebCodecs video/audio encoding
- `src/runtime/video-exporter.ts`
  - WebM 렌더 + ffmpeg transcode orchestration
- `src/export-runner.ts`
  - export 전용 페이지에서 project를 로드해 export 실행
- `scripts/ffmpeg-export-server.mjs`
  - 로컬 ffmpeg HTTP 서비스, job API, transcode API
- `scripts/headless-export-job.mjs`
  - Playwright/Chromium 기반 export worker
- `scripts/run-dev-with-export.mjs`
  - Vite dev + export service 동시 실행 bootstrap
- `scripts/build-project-index.mjs`
  - 리소스 폴더 스캔 및 `project-index.json` 생성
- `scripts/create-sample-workbook.mjs`
  - sample `scene-flow.xlsx` 생성

### 핵심 모듈 간 의존 관계
`scene-flow.xlsx` + `project-index.json`
-> `load-project-workbook.ts` + `build-project-index.mjs`
-> `workbook-sheet-parsers.ts`
-> `project-model-resolution.ts`
-> `ProjectModel`
-> `PreviewSession`
-> `PixiPreviewApp`

export는 현재 다음 의존 관계를 가진다.

`main.ts`
-> `offline-export-job-client.ts`
-> `scripts/ffmpeg-export-server.mjs`
-> `scripts/headless-export-job.mjs`
-> `src/export-runner.ts`
-> `src/runtime/video-exporter.ts`
-> `src/runtime/export-timeline.ts` + `export-audio-mix.ts` + `export-encoder.ts`
-> `ffmpeg-export-client.ts`
-> `scripts/ffmpeg-export-server.mjs /transcode`

즉 export는 **브라우저 안의 deterministic render + 외부 ffmpeg transcode**의 혼합 구조다.

### 데이터 흐름
1. workbook fetch
2. workbook parse
3. resource index fetch
4. workbook + resource index resolve
5. `ProjectModel` 생성
6. preview는 `ProjectModel`로 바로 동작
7. export도 `ProjectModel`과 `PreviewSceneRenderer`를 다시 사용

### 외부 API / 파일 시스템 / 환경변수
- 브라우저 API
  - `fetch`
  - File System Access API (`showOpenFilePicker`)
  - `OfflineAudioContext`
  - `AudioContext`
  - `VideoEncoder`, `AudioEncoder`, `VideoFrame`
- 로컬 서비스
  - `http://127.0.0.1:43123`
  - `/health`
  - `/jobs/offline-export`
  - `/jobs/{id}`
  - `/jobs/{id}/cancel`
  - `/transcode`
  - `/uploads/audio-temp`
- 파일 시스템
  - `public/projects/sample/scene-flow.xlsx`
  - `public/projects/sample/project-index.json`
  - `public/projects/sample/resources/**`
  - `output/exports/**`
  - `output/.tmp/**` 또는 `output/exports/.tmp/**`
- 환경변수
  - `FFMPEG_EXPORT_HOST`
  - `FFMPEG_EXPORT_PORT`
  - `FFMPEG_EXPORT_MAX_BODY_BYTES`
  - `FFMPEG_BIN`
  - `SPOT_EXPORT_APP_BASE_URL`
  - `VITE_FFMPEG_EXPORT_BASE_URL`
  - `VITE_FFMPEG_EXPORT_HEALTH_PATH`
  - `VITE_FFMPEG_EXPORT_TRANSCODE_PATH`

### 빌드/실행/테스트 명령어
- `npm run dev`
- `npm run dev:mp4`
- `npm run build`
- `npm run build:index`
- `npm run build:sample-workbook`
- `npx tsc --noEmit`

## 3. 현재 설계의 문제점

### 문제 1
- 문제명: Export 책임이 여러 계층에 흩어져 있다
- 증상:
  - export가 `main.ts`, `offline-export-job-client.ts`, `headless-export-job.mjs`, `export-runner.ts`, `video-exporter.ts`, `ffmpeg-export-server.mjs`로 나뉘어 있어 디버깅과 원인 파악이 어렵다.
  - 실패 시 브라우저, Playwright, WebCodecs, ffmpeg 중 어디가 문제인지 즉시 판단하기 어렵다.
- 근본 원인:
  - export를 독립된 제품 파이프라인으로 설계하지 않고, preview 렌더를 여러 계층에서 감싼 결과다.
- 관련 파일/함수:
  - `src/main.ts::exportProjectVideo`
  - `src/export-runner.ts::beginExport`
  - `src/runtime/video-exporter.ts::renderProjectOfflineWebm`
  - `scripts/headless-export-job.mjs::startHeadlessExportJob`
  - `scripts/ffmpeg-export-server.mjs::handleOfflineExportCreate`, `handleTranscode`
- 왜 단순 리팩터링으로 부족한지:
  - 파일 분리만 해도 책임이 명확해지지 않는다. 먼저 “export의 단일 진입점, 단일 시간축, 단일 결과물 단계”를 설계해야 한다.
- 새 구현에서 피해야 할 점:
  - preview 상태 머신을 export orchestration에 그대로 재사용하지 말 것
  - export를 브라우저 UI, worker, ffmpeg service가 동시에 알고 있는 구조를 만들지 말 것
- 위험도: High
- 확신도: High

### 문제 2
- 문제명: Preview와 export가 같은 renderer를 쓰지만 같은 시간 모델을 공유하지 않는다
- 증상:
  - 같은 장면이라도 preview와 export 결과가 다르게 보이는 이슈가 반복됐다.
  - 정답 마커와 사운드 동기화를 맞추기 위해 `export-audio-mix.ts`에서 수동 오프셋 상수를 추가했다.
- 근본 원인:
  - 시각 연출은 `pixi-preview-app.ts` 내부 animation curve로 계산되고, 오디오는 `export-audio-mix.ts`에서 별도 시간으로 스케줄링된다.
  - 두 시스템을 묶는 공통 “scene event timeline”이 없다.
- 관련 파일/함수:
  - `src/runtime/pixi-preview-app.ts::updateAnimatedPrompt`
  - `src/runtime/pixi-preview-app.ts::renderAt`
  - `src/runtime/export-audio-mix.ts::MARKER_REVEAL_AUDIO_OFFSET_SEC`
- 왜 단순 리팩터링으로 부족한지:
  - 현재 구조에서는 “보이는 순간”이 코드의 부수효과로 계산된다. 오디오와 공유 가능한 이벤트 모델을 먼저 정의해야 한다.
- 새 구현에서 피해야 할 점:
  - export에서 눈에 보이는 타이밍을 오디오 오프셋 상수로 때우지 말 것
  - 시각/오디오가 서로 다른 규칙을 갖지 않게 할 것
- 위험도: High
- 확신도: High

### 문제 3
- 문제명: Renderer가 너무 많은 제품 정책을 갖고 있다
- 증상:
  - HUD 크기, 폰트, 꿀벌 경로, 마커 파티클, title/timeout prompt, background video audio fallback, 책장 전환까지 한 파일에 있다.
  - 레이아웃 수정과 제품 정책 변경이 renderer 코드 수정과 직접 결합된다.
- 근본 원인:
  - `PixiPreviewApp`이 “scene spec 해석기”와 “저수준 그림 엔진” 역할을 동시에 하고 있다.
- 관련 파일/함수:
  - `src/runtime/pixi-preview-app.ts::drawHudText`
  - `src/runtime/pixi-preview-app.ts::drawBeeTimer`
  - `src/runtime/pixi-preview-app.ts::drawMarkers`
  - `src/runtime/pixi-preview-app.ts::createVideoSprite`
  - `src/runtime/pixi-preview-app.ts::playBookPageTransition`
- 왜 단순 리팩터링으로 부족한지:
  - 클래스 분리만으로는 해결되지 않는다. “scene rendering input”을 명시적인 데이터 구조로 먼저 빼야 한다.
- 새 구현에서 피해야 할 점:
  - renderer 내부에서 workbook 정책이나 sample 자산 기본값을 직접 고르지 말 것
  - layout constant와 제품 규칙을 한 함수에 섞지 말 것
- 위험도: High
- 확신도: High

### 문제 4
- 문제명: ProjectModel 조립 단계에 정책과 fallback이 과도하게 섞여 있다
- 증상:
  - `ProjectModel`을 만들 때 diagnostics, auto-BGM, legacy Hud merge, resource fallback이 동시에 일어난다.
  - workbook source와 runtime resolved data의 경계가 흐리다.
- 근본 원인:
  - source parse와 runtime compile을 명확히 분리하지 않았다.
- 관련 파일/함수:
  - `src/runtime/workbook-sheet-parsers.ts::mergeLegacyHudRows`
  - `src/runtime/project-model-resolution.ts::resolveSceneAudio`
  - `src/runtime/project-model-resolution.ts::resolveUiResources`
- 왜 단순 리팩터링으로 부족한지:
  - 새 구현은 `WorkbookData -> CompiledProjectSpec -> PreviewModel/ExportPlan`처럼 단계 분리를 가져야 한다.
- 새 구현에서 피해야 할 점:
  - runtime 편의를 위해 source 타입을 직접 변형하지 말 것
  - legacy 호환과 새 모델을 같은 함수 안에서 처리하지 말 것
- 위험도: Medium
- 확신도: High

### 문제 5
- 문제명: Background video 처리 방식이 결정론 export에 적합하지 않다
- 증상:
  - 인트로 MP4가 끊기거나 잘리는 문제가 반복적으로 보고되었다.
  - preview와 export에서 background video의 체감 결과가 달라졌다.
- 근본 원인:
  - `HTMLVideoElement` seek/settle을 Pixi renderer 내부에서 직접 관리한다.
  - export도 결국 그 HTML video 동작에 의존한다.
- 관련 파일/함수:
  - `src/runtime/pixi-preview-app.ts::createVideoSprite`
  - `src/runtime/pixi-preview-app.ts::syncSceneVideos`
  - `src/runtime/pixi-preview-app.ts::settleSceneVideos`
  - `src/runtime/export-encoder.ts::encodeVideoTrack`
- 왜 단순 리팩터링으로 부족한지:
  - renderer가 background video를 어떤 방식으로 “시간 t의 프레임”으로 얻는지 인터페이스 차원에서 재설계해야 한다.
- 새 구현에서 피해야 할 점:
  - export가 background video의 재생 상태에 의존하게 만들지 말 것
  - preview와 export가 다른 비디오 정책을 갖지 않게 할 것
- 위험도: High
- 확신도: Medium

### 문제 6
- 문제명: 앱이 sample 프로젝트에 과도하게 하드코딩되어 있다
- 증상:
  - `main.ts`는 `WORKBOOK_PATH`와 `INDEX_PATH`를 `/projects/sample/...`로 고정한다.
  - build/dev scripts도 sample workbook/index 생성 흐름을 전제로 한다.
- 근본 원인:
  - 초기 프로토타입용 상수가 제품 설계로 굳어졌다.
- 관련 파일/함수:
  - `src/main.ts::WORKBOOK_PATH`, `INDEX_PATH`
  - `package.json::dev`, `build`
  - `scripts/create-sample-workbook.mjs`
  - `scripts/build-project-index.mjs`
- 왜 단순 리팩터링으로 부족한지:
  - 단순 상수 제거만이 아니라 “project 선택/열기” 흐름을 설계해야 한다.
- 새 구현에서 피해야 할 점:
  - sample 프로젝트를 제품 기본 규격으로 오해하지 말 것
- 위험도: Medium
- 확신도: High

### 문제 7
- 문제명: 개발 bootstrap이 프로세스 정리까지 떠안아 플랫폼 의존 버그를 만든다
- 증상:
  - `npm run dev:mp4`가 Windows 포트 점유 검사 때문에 자주 깨졌다.
  - stale Vite/ffmpeg 서버를 자동 종료하는 로직이 복잡하고 OS 의존적이다.
- 근본 원인:
  - 제품 기능보다 개발 편의 스크립트가 과도한 책임을 떠안았다.
- 관련 파일/함수:
  - `scripts/run-dev-with-export.mjs::getListeningPids`
  - `scripts/run-dev-with-export.mjs::ensureExportPortAvailable`
  - `scripts/run-dev-with-export.mjs::ensureProjectVitePortsAvailable`
- 왜 단순 리팩터링으로 부족한지:
  - 개발 bootstrap 자체를 단순화해야 한다. export 서버와 Vite를 같은 스크립트가 정리/제어할 필요가 있는지부터 다시 판단해야 한다.
- 새 구현에서 피해야 할 점:
  - 개발 스크립트가 OS별 프로세스 킬러가 되지 않게 할 것
- 위험도: Medium
- 확신도: High

### 문제 8
- 문제명: 문서가 오래된 상태거나 인코딩이 깨져 있다
- 증상:
  - 일부 문서가 현재 코드와 어긋난다.
  - 일부 문서는 저장 인코딩 문제로 읽기 어렵다.
- 근본 원인:
  - 구현 변경 속도에 비해 문서 갱신이 따라오지 못했다.
- 관련 파일/함수:
  - `docs/current-architecture-and-export-redesign.md`
  - `docs/module-boundaries.md`
  - `docs/pixi-excel-pipeline.md`
- 왜 단순 리팩터링으로 부족한지:
  - 새 설계의 source of truth 문서를 따로 세워야 한다.
- 새 구현에서 피해야 할 점:
  - 오래된 문서를 기준으로 구현하지 말 것
- 위험도: Medium
- 확신도: High

## 4. 버릴 코드 / 유지할 코드 / 참고만 할 코드

| 구분 | 파일/모듈 | 판단 | 이유 | 새 구현에서의 처리 |
|---|---|---|---|---|
| 유지 | `src/runtime/load-project-workbook.ts` | 유지 | 단순한 workbook fetch + parse 진입점이며 책임이 명확하다 | parse 계층 유지 |
| 유지 | `src/runtime/workbook-sheet-parsers.ts` | 유지(단, 정리 필요) | workbook 시트 파싱의 중심이며 재사용 가치가 높다 | legacy `Hud` fallback만 점진 제거 |
| 유지 | `src/runtime/workbook-persistence.ts` | 유지 | File System Access/Save Copy 흐름이 실사용 가치가 있다 | autosave UX만 보강 |
| 유지 | `src/runtime/markers-sheet.ts` | 유지 | marker sheet 쓰기 로직이 비교적 단순하고 명확하다 | 저장 어댑터로 유지 |
| 유지 | `src/runtime/admin-authoring-helpers.ts` | 유지 | 좌표 계산 helper는 테스트하기 쉽고 재사용 가치가 있다 | 단위 테스트 추가 |
| 유지 | `src/runtime/resource-path.ts` | 유지 | 단순하고 명확한 path helper | 그대로 사용 가능 |
| 유지 | `scripts/build-project-index.mjs` | 유지 | step 스캔과 resource index 생성 규칙의 소스 오브 트루스 | multi-project 지원만 추가 |
| 참고 | `src/runtime/admin-authoring-panel.ts` | 참고 | UX/DOM 구조는 유용하지만 UI와 저장 흐름이 강하게 결합돼 있다 | 필요 시 재구성 |
| 참고 | `src/runtime/preview-session.ts` | 참고 | preview state machine의 기본 방향은 맞다 | interface를 더 좁게 재설계 |
| 참고 | `src/runtime/pixi-preview-app.ts` | 참고 | 시각 결과의 기준이 되는 코드지만 너무 많은 책임을 가진다 | 시각 parity용 참조본으로만 사용 |
| 참고 | `src/runtime/project-model-resolution.ts` | 참고 | 현재 fallback/auto-BGM 규칙을 파악하기 좋다 | 정책 목록 추출 후 재구현 |
| 참고 | `src/main.ts` | 참고 | 현재 DOM wiring과 상태 흐름을 파악하는 데 유용하다 | 새 bootstrap은 다시 쓸 가능성 큼 |
| 참고 | `scripts/create-sample-workbook.mjs` | 참고 | sample workbook 구조 예시로는 유용하다 | 제품 설계의 기준으로 삼지 말 것 |
| 폐기 | `src/export-runner.ts` | 폐기 | 현재 export 방식의 시행착오가 누적된 엔트리이며 구조적 부채가 크다 | 새 export entry 새로 설계 |
| 폐기 | `src/runtime/video-exporter.ts` | 폐기 | WebM 렌더 + ffmpeg transcode 경로를 전제로 한 현재 export 핵심이며 재설계 필요 | 새 export pipeline로 교체 |
| 폐기 | `src/runtime/export-encoder.ts` | 폐기 | 현재 encoder는 기존 export 경로에 종속된다 | 새 pipeline 맞춰 재작성 |
| 폐기 | `src/runtime/export-audio-mix.ts` | 폐기 | 하드코딩된 오프셋과 암묵 규칙이 들어 있어 신뢰할 수 없다 | event-driven audio plan으로 재작성 |
| 폐기 | `src/runtime/ffmpeg-export-client.ts` | 폐기 | 현재 transcode API와 1:1 결합돼 있다 | 새 backend 계약 기준 재작성 |
| 폐기 | `src/runtime/offline-export-job-client.ts` | 폐기 | 현재 job API에 종속된 클라이언트다 | 새 backend 계약 기준 재작성 |
| 폐기 | `scripts/headless-export-job.mjs` | 폐기 | Playwright worker와 현재 export lifecycle이 강하게 결합돼 있다 | 새 orchestration로 재작성 |
| 폐기 | `scripts/ffmpeg-export-server.mjs` | 폐기 | 현재 transcode/job/orchestration이 한 파일에 섞여 있다 | 새 service로 분리 재작성 |
| 폐기 | `scripts/run-dev-with-export.mjs` | 폐기 | 개발 편의 스크립트가 과도한 책임을 갖고 있다 | 단순 bootstrap으로 교체 |
| 참고 | `docs/current-architecture-and-export-redesign.md` | 참고 낮음 | 내용 일부는 유효하지만 인코딩이 깨져 있고 최신 상태가 아니다 | source of truth로 사용 금지 |
| 참고 | `docs/module-boundaries.md` | 참고 낮음 | 책임 경계 의도는 있으나 문서 상태가 깨져 있다 | 필요 시 새 문서로 대체 |

## 5. 새 설계 제안

### 추천 아키텍처
추천안은 다음 4계층 구조다.

1. **Source Layer**
   - workbook source
   - resource index

2. **Compile Layer**
   - `WorkbookData + ResourceIndex -> CompiledProjectSpec`
   - fallback, diagnostics, auto-BGM, implicit cues를 여기서 명시적 데이터로 변환

3. **Render Layer**
   - 같은 Pixi scene renderer를 preview/export가 공유
   - 입력은 `CompiledScene + sceneTimeSec`
   - renderer는 “그리기”만 담당

4. **Execution Layer**
   - preview executor: 실시간 시간 공급
   - export executor: frame index 기반 시간 공급
   - 오디오는 별도 `AudioPlan` 기반으로 렌더

### 모듈 경계
- Workbook module
  - parse, validate, save
- Resource module
  - folder scan, index, path resolve
- Compile module
  - source -> compiled spec
  - implicit cues를 명시적 events로 변환
- Scene renderer
  - Pixi container를 `sceneTimeSec`으로 그림
- Preview runtime
  - 실시간 play/seek/reset
- Export runtime
  - deterministic frame stepping
  - scene clip / transition clip / final mux
- Export backend/service
  - queue, progress, cancel, partial, ffmpeg

### 데이터 모델
추천 핵심 타입:

- `WorkbookData`
  - source 그대로
- `CompiledProjectSpec`
  - validated scenes, resolved assets, diagnostics
- `SceneRenderSpec`
  - renderer가 즉시 사용할 수 있는 시각 스펙
- `AudioPlan`
  - BGM/SFX/bookpage/ok/intro embedded audio 포함한 전역 이벤트 리스트
- `ExportPlan`
  - scene clip 목록, transition clip 목록, final mux 계획

### 상태 관리 방식
- preview와 export는 같은 `SceneRenderer`를 호출하지만 서로 다른 executor를 가진다.
- preview state는 `activeSceneId`, `sceneTimeSec`, `isPlaying` 정도만 가진다.
- export state는 `phase`, `progress`, `currentClip`, `elapsed`, `eta`, `cancelRequested` 정도만 가진다.
- export는 preview state와 직접 공유하지 않는다.

### 에러 처리 방식
- compile 단계 오류는 사용자에게 workbook/resource 진단으로 보여준다.
- export 단계 오류는 `jobId`, `phase`, `clipId`, `errorCode`, `message`를 포함해야 한다.
- raw Playwright/ffmpeg 오류를 그대로 UI에 노출하지 말 것.

### 테스트 가능한 구조
- workbook parser: pure function 테스트 가능
- compile layer: pure function 테스트 가능
- renderer: keyframe golden test 가능
- audio plan: event timestamp test 가능
- export executor: clip count / duration / mux contract test 가능

### 기존 구현보다 나아지는 점
- preview와 export의 공통 규칙이 `CompiledScene/EventPlan`으로 명시화된다.
- 오디오 오프셋 상수로 눈속임하지 않아도 된다.
- background video 문제를 renderer policy 수준에서 통제할 수 있다.
- scene clip 단위로 재시도/partial/cancel 설계가 쉬워진다.

### 트레이드오프
- compile layer를 새로 만들기 때문에 초기 설계 비용이 든다.
- 기존 export 코드를 고쳐 쓰는 것보다 처음엔 느리게 느껴질 수 있다.
- 하지만 계속 땜질하는 것보다 유지보수 비용이 낮다.

### 대안 설계 비교

#### 대안 A: 같은 Pixi renderer + deterministic export executor
- 추천안
- 장점:
  - parity를 가장 잘 유지할 수 있다
  - preview 자산/레이아웃을 재사용할 수 있다
- 단점:
  - 배경 video 처리 정책을 잘 설계해야 한다

#### 대안 B: ffmpeg filter 기반 장면 합성
- 장점:
  - 빠를 수 있다
- 단점:
  - 현재 연출 규모에서는 parity 위험이 매우 높다
  - UI 위치, 파티클, 텍스트, 전환 재현이 어려워진다

#### 대안 C: 실시간 화면 캡처 유지
- 장점:
  - 겉보기 구현은 쉬워 보인다
- 단점:
  - 컴퓨터 상태에 따라 싱크가 흔들린다
  - 사용자 요구인 “정확도 우선”과 맞지 않는다

## 6. 새 Codex와 협의해야 할 쟁점
이 섹션은 별도 문서 [OPEN_QUESTIONS_FOR_NEXT_CODEX.md](/D:/AI/codex/spot-new/docs/OPEN_QUESTIONS_FOR_NEXT_CODEX.md)에 정리했다.

## 7. 재구현 요구사항
이 섹션은 별도 문서 [REBUILD_SPEC.md](/D:/AI/codex/spot-new/docs/REBUILD_SPEC.md)에 정리했다.

## 8. 테스트 계획
이 섹션은 별도 문서 [TEST_PLAN.md](/D:/AI/codex/spot-new/docs/TEST_PLAN.md)에 정리했다.

## 9. 새 Codex가 처음 해야 할 작업 순서
이 섹션은 별도 문서 [AGENT_GUIDE.md](/D:/AI/codex/spot-new/docs/AGENT_GUIDE.md)에 정리했다.

## 10. 새 Codex에게 전달할 최종 프롬프트 초안
최종 프롬프트 초안은 [docs/CODEX_REBUILD_HANDOFF.md](/D:/AI/codex/spot-new/docs/CODEX_REBUILD_HANDOFF.md)에 포함되어 있다.
