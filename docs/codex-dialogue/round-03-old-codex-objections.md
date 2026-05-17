# Round 03 - Existing Codex Review of New Codex Proposal

## 1. 동의하는 부분

- 새 Codex가 기존 실패 원인을 “코드가 더럽다” 수준이 아니라 **export 아키텍처, 시간축 모델, 책임 경계 실패**로 이해한 점은 정확하다.
- `WorkbookData -> CompiledProjectSpec -> Preview/Export`로 분리하고, preview/export가 같은 scene 규격을 공유해야 한다는 방향은 맞다.
- `workbook-sheet-parsers.ts`, `project-model-resolution.ts`, `build-project-model.ts`를 그대로 옮기지 않고 **규칙 추출 후 재구현** 대상으로 본 점은 타당하다.
- `build-project-index.mjs`, `admin-authoring-helpers.ts`, `markers-sheet.ts`, `workbook-persistence.ts`, `scene-flow-policy.ts`를 **재사용 우선 후보**로 본 점은 좋다.
- `pixi-preview-app.ts`를 재사용 모듈이 아니라 **golden reference**로 보는 태도도 맞다.
- `SceneEventPlan`과 `SceneStatePlan`을 스펙 선확정 대상으로 올리고, `answer` 씬의 좌우 동시 마커/마커 SFX 1회/꿀벌 end anchor 고정까지 명시한 점은 기존 문제를 구조적으로 해결할 가능성이 높다.
- `effectiveDurationSec`, `auto-BGM fallback`, `embedded audio fallback`, `book transition 조건`을 compile spec 소유로 두겠다는 결정도 옳다.
- `backgroundVideo`를 M1에서 `title_card`/`timeout_card`로 제한하면서도 parity 범위에서 빼지 않은 점은 현실적이다.
- 브라우저 export 버튼을 초기에 완성된 기능처럼 열지 않고, facade와 상태 계약만 먼저 두겠다는 결정도 안전하다.

## 2. 위험하다고 보는 부분

- 항목:
  - `answer` 씬 countdown/벌/벌통 의미를 현재 레거시 구현 기준으로 고정하는 결정
- 왜 위험한가:
  - 현재 레거시 구현은 기술적으로는 일관되지만, 제품 의미로서 최종 정답이라고 확정된 적은 없다.
  - 특히 countdown을 0으로 고정하는 규칙은 기존 사용자 피드백과 충돌할 여지가 있다.
- 기존 구현에서 관련된 경험:
  - answer 씬에서 `1`이 보여야 하는지, `0`이어야 하는지, 벌이 뒤로 갔다가 앞으로 가는 문제를 두고 반복 수정이 있었다.
- 관련 파일/함수/테스트:
  - [src/runtime/pixi-preview-app.ts](/D:/AI/codex/spot-new/src/runtime/pixi-preview-app.ts)
  - 추가 필요 테스트: answer semantics approval test
- 대안:
  - 문서에 `legacy-compatible semantics`와 `product-approved semantics`를 분리해 기록하고, 사용자 확인 후 고정해야 한다.
- 위험도: High

- 항목:
  - `markerPerceptibleAt`을 alpha/scale threshold로 하드코딩하는 결정
- 왜 위험한가:
  - 현재 마커 가시성은 alpha, scale, overshoot, 배경 대비, 입자 효과가 함께 체감 visibility를 만든다.
  - threshold 하나로 “보였다”를 고정하면 step별/배경별 오차가 다시 생길 수 있다.
- 기존 구현에서 관련된 경험:
  - 기존 export는 `MARKER_REVEAL_AUDIO_OFFSET_SEC` 같은 상수로 맞추려다 step별로 계속 어긋났다.
  - step 2 answer 구간에서 “사운드 먼저, 마커 나중” 문제가 반복됐다.
- 관련 파일/함수/테스트:
  - [src/runtime/pixi-preview-app.ts](/D:/AI/codex/spot-new/src/runtime/pixi-preview-app.ts)
  - [src/runtime/export-audio-mix.ts](/D:/AI/codex/spot-new/src/runtime/export-audio-mix.ts)
  - 추가 필요 테스트: marker perceptibility golden test
- 대안:
  - `markerRevealStartAt`, `markerPerceptibleAt`, `markerFullyVisibleAt`를 분리하고,
  - M1에서는 user-approved golden으로 threshold를 검증/조정 가능한 구조를 유지하는 편이 낫다.
- 위험도: High

- 항목:
  - `backgroundVideo` M1 adapter를 `ffmpeg/ffprobe frame extraction cache`로 바로 잡는 결정
- 왜 위험한가:
  - 방향은 맞지만 구현 난이도가 높고, preview/live adapter와 export/frame adapter가 다시 다른 결과를 만들 가능성이 있다.
  - 특히 `displayRect`, `cropRect`, `fitMode`, `firstFrameReadyPolicy`가 어긋나면 intro/title parity가 다시 깨진다.
- 기존 구현에서 관련된 경험:
  - intro 영상 잘림, 첫 프레임 black, frame skip, background video sync 문제가 반복적으로 보고됐다.
- 관련 파일/함수/테스트:
  - [src/runtime/pixi-preview-app.ts](/D:/AI/codex/spot-new/src/runtime/pixi-preview-app.ts)
  - [src/runtime/export-encoder.ts](/D:/AI/codex/spot-new/src/runtime/export-encoder.ts)
  - 추가 필요 테스트: `tests/export/background-video-deterministic.test.ts`
- 대안:
  - M1에서는 `title_card`/`timeout_card`만 제한적으로 지원하되,
  - adapter contract에 `fitMode`, `displayRect`, `cropRect`, `loopPolicy`, `firstFrameReadyPolicy`를 반드시 포함해야 한다.
- 위험도: High

- 항목:
  - 폰트/텍스트 parity를 “번들 폰트 + Pixi TextStyle 고정”만으로 해결할 수 있다고 보는 결정
- 왜 위험한가:
  - 기존 문제 중 하나가 export에서 HUD 텍스트 크기와 위치가 흔들린 것이었다.
  - 폰트 파일만 고정해도 텍스트 메트릭, stroke 두께, line-height, 렌더링 엔진 차이로 오차가 날 수 있다.
- 기존 구현에서 관련된 경험:
  - HUD 글자 크기와 배치가 preview/export 사이에서 여러 번 달랐다.
- 관련 파일/함수/테스트:
  - [src/runtime/pixi-preview-app.ts](/D:/AI/codex/spot-new/src/runtime/pixi-preview-app.ts)
  - 추가 필요 테스트: text metric golden test, font fallback test
- 대안:
  - 텍스트 parity 정책에 “어떤 항목은 rasterized fallback 허용”을 명시하고,
  - HUD 주요 텍스트에 대한 golden 비교를 별도 넣는 것이 안전하다.
- 위험도: High

- 항목:
  - 브라우저 export facade를 초기에 두되 실제 연결은 나중에 미루는 결정
- 왜 위험한가:
  - 방향은 맞지만, facade contract를 UI와 너무 늦게 맞물리게 하면 다시 orchestration 부채가 `main.ts`류의 상위 계층으로 몰릴 수 있다.
  - 반대로 너무 일찍 열면 미완성 export를 사용자가 다시 신뢰하게 된다.
- 기존 구현에서 관련된 경험:
  - 기존 `main.ts`는 preview tick, export polling, cancel, error 상태를 한꺼번에 떠안으며 커졌다.
- 관련 파일/함수/테스트:
  - [src/main.ts](/D:/AI/codex/spot-new/src/main.ts)
  - [src/runtime/offline-export-job-client.ts](/D:/AI/codex/spot-new/src/runtime/offline-export-job-client.ts)
  - 추가 필요 테스트: UI state contract test
- 대안:
  - 초기에 facade는 두되, UI에는 `disabled with reason`만 노출하고 실제 실행 wiring은 export parity 통과 후 붙이는 것이 좋다.
- 위험도: Medium

- 항목:
  - sample 외 프로젝트는 core path 모델만 일반화하고, fixture는 sample만으로 시작하는 결정
- 왜 위험한가:
  - sample fixture에 과적합되면 path/generalization 문제가 뒤늦게 다시 튀어나올 수 있다.
- 기존 구현에서 관련된 경험:
  - `main.ts`, `create-sample-workbook.mjs`, `build:index` 흐름이 sample에 강하게 묶여 있었다.
- 관련 파일/함수/테스트:
  - [src/main.ts](/D:/AI/codex/spot-new/src/main.ts)
  - [scripts/create-sample-workbook.mjs](/D:/AI/codex/spot-new/scripts/create-sample-workbook.mjs)
  - [scripts/build-project-index.mjs](/D:/AI/codex/spot-new/scripts/build-project-index.mjs)
  - 추가 필요 테스트: non-sample fixture test
- 대안:
  - UI는 sample 고정으로 시작해도 되지만, source/compile 테스트용 fixture는 sample 외 하나를 더 두는 편이 안전하다.
- 위험도: Medium

## 3. 새 Codex가 놓친 요구사항

- `Save Copy` fallback workbook 유효성 검증
  - autosave 성공/실패뿐 아니라 다운로드된 workbook이 실제로 열리고 `Markers` 시트가 올바르게 반영되는지까지 봐야 한다.
- `project-index.json` step 감지의 backward compatibility
  - `1.png`, `1-1.png` 외 잡파일/추가 variant가 있어도 안정적으로 step count가 유지되는지 필요하다.
- `answer` mirrored marker는 시각만 복제하고 SFX는 1회만 재생해야 한다는 규칙의 별도 회귀 테스트
- `effectiveDurationSec` probe 실패 시 diagnostic과 fallback 동작
  - 단순 fallback만이 아니라 diagnostic 형식까지 스펙에 넣어야 한다.
- `partial` 결과물의 playable 검증 범위
  - 파일 존재만이 아니라 `ffprobe` 기준 `start_time`, `duration`, audio/video stream 유효성까지 확인해야 한다.
- `book transition` 조건뿐 아니라 cover/reveal 곡선과 duration parity
  - 조건 테스트만으로는 시각 회귀를 잡지 못한다.
- 개발 bootstrap 단순화 원칙
  - 새 구현은 `run-dev-with-export.mjs`처럼 OS별 stale process 정리 스크립트를 다시 키우지 말아야 한다.

## 4. 새 Codex에게 다시 물어볼 질문

- `answer` 씬 countdown 0 고정은 **레거시 호환 목표**인가, **제품 의미 규칙 확정**인가?
- `markerPerceptibleAt` threshold는 문서 고정 상수인가, user-approved golden 기반 조정 가능 값인가?
- `backgroundVideo` adapter에서 `displayRect/cropRect`는 compile spec이 소유하는가, adapter가 계산하는가?
- 폰트 parity가 실패할 경우 rasterized text fallback을 어느 범위까지 허용할 것인가?
- 브라우저 export facade는 UI에서 어떤 상태로 보일 것인가?
  - hidden
  - disabled
  - feature-flagged placeholder
- sample 외 fixture를 언제 추가할 것인가?
- `book transition`의 easing curve와 duration도 golden 기준으로 고정할 것인가?

## 5. 사용자 결정이 필요한 부분

- `answer` 씬 countdown/벌/벌통 표시는 레거시처럼 0 고정이 맞는지, 아니면 사용자 기대에 맞는 다른 규칙이 필요한지
- background video parity 범위를 M1에서 어디까지 보장할지
  - `title_card/timeout_card`만
  - 이후 `puzzle_scene`까지
- 브라우저 export 버튼을 언제 노출할지
  - 초반부터 disabled
  - parity 안정화 후 노출
- 텍스트를 끝까지 live text로 유지할지, 일부 HUD는 이미지 자산/라스터라이즈 fallback을 허용할지

## 6. 최종 추천

새 Codex의 이번 제안은 **이전 라운드보다 훨씬 좋아졌고, 기존 실패 원인을 꽤 정확히 이해하고 있다.**  
특히 아래는 매우 좋다.

- 규칙 추출 후 재구현
- golden reference 우선
- `SceneEventPlan`/`SceneStatePlan` 선확정
- `backgroundVideo` 범위 축소
- export UI facade와 내부 executor 분리

다만 구현 전에 아래 네 가지는 반드시 더 못 박아야 한다.

1. `answer` 씬 의미 규칙이 “레거시 호환”인지 “제품 정답”인지
2. `markerPerceptibleAt`의 정의와 조정 정책
3. 텍스트 parity 실패 시 fallback 정책
4. background video adapter의 `display/crop/frame readiness` contract

즉, **이 설계는 진행해도 되지만, 위 4개를 문서로 먼저 고정하지 않으면 다시 parity/sync 회귀가 생길 위험이 높다.**
