# Rebuild Spec

## 1. 목표
새 구현의 목표는 다음 두 가지를 동시에 만족하는 것이다.

- **저작과 프리뷰는 현재 웹 기반 UX를 유지**
- **최종 export는 preview와 최대한 같은 그림을 안정적으로 만든다**

이 문서는 새 Codex가 구현 전에 합의해야 할 재구현 요구사항과 추천 아키텍처를 정의한다.

## 2. 기능 요구사항

### 필수 기능
- workbook(`scene-flow.xlsx`) 로딩
- resource index(`project-index.json`) 로딩
- step 수를 puzzle 파일명 규칙으로 계산
- preview에서 scene 선택, 재생, seek, reset
- 관리자 패널에서 좌표 저장
- scene별 HUD, 꿀벌, 타이머, 정답 마커, 파티클, 책장 전환 재현
- 최종 MP4 export
- progress / eta / cancel / partial

### 유지해야 하는 연출
- title/intro scene
- puzzle scene
- answer reveal scene
- timeout scene
- 책장 전환
- 꿀벌 타이머
- 정답 마커 reveal
- 마커 파티클
- step/ending prompt 오버레이

### 사용자가 기대하는 운영 조건
- 다른 작업을 하더라도 export 결과가 흔들리지 않아야 한다
- export가 길더라도 진행도와 ETA가 의미 있어야 한다
- 실패 시 원인이 명확해야 한다

## 3. 비기능 요구사항

### 정확도
- preview와 export가 keyframe 기준으로 일치해야 한다
- 마커/사운드/타이머/꿀벌/전환이 같은 시간축을 공유해야 한다

### 성능
- 정확도 우선이지만, 긴 영상에서 구조적으로 무한 대기처럼 보이면 안 된다
- scene clip 기반 캐시 또는 단계적 결과물을 허용해야 한다

### 유지보수성
- workbook source, compile, render, export가 분리되어야 한다
- renderer에 제품 정책이 뭉치지 않아야 한다

### 확장성
- sample 프로젝트 이외의 프로젝트 폴더도 지원할 수 있어야 한다
- 추후 CLI export 또는 서비스 분리도 가능해야 한다

### 보안/안정성
- 로컬 파일 경로와 포트 충돌 처리를 단순화해야 한다
- raw OS/Playwright/ffmpeg 오류를 사용자 UI에 그대로 노출하지 않아야 한다

## 4. 추천 아키텍처

### A. Source Layer
- 입력:
  - workbook
  - resource index
- 출력:
  - `WorkbookData`
  - `ResourceIndex`

### B. Compile Layer
- 입력:
  - `WorkbookData`
  - `ResourceIndex`
- 출력:
  - `CompiledProjectSpec`
  - `Diagnostics[]`
- 책임:
  - path resolve
  - fallback 확정
  - implicit cue 확정
  - scene duration 확정
  - auto-BGM, intro embedded audio 같은 암묵 규칙을 명시적 이벤트로 바꿈

### C. Render Layer
- 입력:
  - `SceneRenderSpec`
  - `sceneTimeSec`
- 출력:
  - Pixi stage
- 책임:
  - 그리기만
  - 어떤 scene event가 언제 발생하는지는 입력으로만 받음

### D. Execution Layer

#### Preview Executor
- 실시간 시간 공급
- play/seek/reset 담당

#### Export Executor
- `frameIndex / fps` 기반 deterministic 시간 공급
- scene clip 렌더
- transition clip 렌더
- final mux orchestration

### E. Audio Layer
- 입력:
  - `AudioPlan`
- 출력:
  - mixed audio buffer 또는 wav
- 책임:
  - scene event와 동일한 timestamp 기준으로 오디오 렌더

### F. Export Backend
- 입력:
  - `ExportPlan`
- 출력:
  - final mp4
- 책임:
  - queue, cancel, partial, progress, ffmpeg

## 5. 모듈 경계 제안

### 유지 가능한 경계
- `workbook parser`
- `resource index builder`
- `marker authoring UI`

### 새로 만들어야 할 경계
- `CompiledProjectSpec`
- `SceneEventPlan`
- `AudioPlan`
- `ExportPlan`
- `SceneRenderer`
- `PreviewExecutor`
- `ExportExecutor`

### 금지할 결합
- renderer가 workbook row를 직접 읽는 구조
- audio mix가 renderer 내부 animation curve를 추정하는 구조
- export service가 preview DOM state를 직접 아는 구조

## 6. 데이터 모델 제안

### WorkbookData
- workbook source 그대로 유지
- legacy `Hud`는 migration 기간 동안만 허용

### CompiledProjectSpec
- `project`
- `scenes[]`
- `uiResources`
- `diagnostics`
- `audioPlan`
- `transitionPolicy`

### SceneRenderSpec
- `sceneId`
- `sceneType`
- `durationSec`
- `assets`
- `layout`
- `events`

### SceneEvent
예시:
- `show_prompt`
- `show_marker`
- `play_marker_sfx`
- `show_timeout`
- `start_transition`

즉, “마커가 보이기 시작하는 시점”과 “사운드를 재생하는 시점”을 따로 추정하지 말고, 컴파일 단계에서 같은 이벤트 소스로 정의해야 한다.

### ExportPlan
- `sceneClips[]`
- `transitionClips[]`
- `finalAudioPlan`
- `outputOptions`

## 7. 상태 관리 방식

### Preview state
- `activeSceneId`
- `sceneTimeSec`
- `isPlaying`
- `durationSec`

### Export state
- `jobId`
- `phase`
- `currentClipId`
- `clipProgress`
- `overallProgress`
- `elapsedSec`
- `etaSec`
- `cancelRequested`
- `outputPath`

## 8. 에러 처리 방식

### compile 단계
- workbook/resource 문제는 diagnostics로 표시
- 필수 리소스 누락은 export 불가 상태로 구분

### export 단계
- phase/clip 단위 오류로 보고
- 예:
  - `E_EXPORT_CLIP_RENDER`
  - `E_EXPORT_AUDIO_MIX`
  - `E_EXPORT_MUX`
  - `E_EXPORT_INPUT_INVALID`

### 사용자 메시지
- “Failed to fetch” 같은 브라우저 저수준 메시지를 그대로 보여주지 말 것

## 9. 기존 구현보다 나아지는 점
- export가 preview와 같은 renderer를 쓰더라도, 시간축은 deterministic하게 통제된다
- 오디오와 시각 연출이 같은 이벤트 플랜을 공유한다
- clip 단위로 재시도/partial/cancel 가능
- sample 전용 구조에서 벗어나 제품 구조로 갈 수 있다

## 10. 트레이드오프
- compile layer와 event plan을 새로 만들기 때문에 초기 구현량이 늘어난다
- 일부 기존 코드는 거의 재사용하지 못할 수 있다
- 그러나 현재 export 파이프라인을 계속 봉합하는 것보다 총비용이 낮다

## 11. 마이그레이션 요구사항

### 데이터 호환
- 기존 `scene-flow.xlsx`는 읽을 수 있어야 한다
- legacy `Hud` 시트는 최소 한 버전은 읽되, 새 source of truth는 `Scenes`로 정리하는 것을 추천

### 프로젝트 호환
- `public/projects/sample` 외 프로젝트 폴더도 열 수 있게 설계

### 코드 제거
- 새 export가 안정화되면 다음을 제거 후보로 본다
  - `src/export-runner.ts`
  - `src/runtime/video-exporter.ts`
  - `src/runtime/export-encoder.ts`
  - `src/runtime/export-audio-mix.ts`
  - `scripts/headless-export-job.mjs`
  - `scripts/ffmpeg-export-server.mjs`
  - `scripts/run-dev-with-export.mjs`

## 12. 대안 설계 비교

### 추천안: 같은 Pixi renderer + deterministic scene clip export
- 장점:
  - parity 유리
  - 현재 자산/레이아웃 활용 가능
- 단점:
  - renderer 정리가 선행돼야 함

### 대안 A: ffmpeg filter 기반 재구현
- 장점:
  - 빠를 수 있음
- 단점:
  - parity 위험 높음

### 대안 B: 화면 캡처 유지
- 장점:
  - 보이는 화면과 같은 그림
- 단점:
  - 컴퓨터 상태 의존
  - 정확도 우선 조건 위반
