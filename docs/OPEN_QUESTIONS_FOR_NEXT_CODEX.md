# Open Questions For Next Codex

## 쟁점 1
- 쟁점:
  - export를 같은 Pixi renderer 기반 deterministic scene clip 방식으로 갈지, 완전히 다른 composition 방식으로 갈지
- 네 추천안:
  - 같은 Pixi renderer 기반 deterministic scene clip export
- 가능한 대안:
  - ffmpeg filter 기반 composition
  - 실시간 화면 캡처 유지
- 왜 아직 확정하면 안 되는지:
  - background video 처리 방식이 renderer 내부 정책에 깊게 묶여 있어, 같은 renderer 전략이라도 구현 난이도가 달라질 수 있다
- 새 Codex에게 검증 요청할 질문:
  - 현재 Pixi scene code를 renderer core와 product policy로 안전하게 분리할 수 있는가
  - background video를 deterministic하게 제공할 공통 interface를 정의할 수 있는가
- 관련 코드/문서:
  - `src/runtime/pixi-preview-app.ts`
  - `src/runtime/export-encoder.ts`
  - `docs/ARCHITECTURE_REVIEW.md`
- 결정이 전체 설계에 미치는 영향:
  - export 전체 구조와 재사용 가능한 코드 범위를 결정한다

## 쟁점 2
- 쟁점:
  - `Hud` 시트 legacy 지원을 언제까지 유지할지
- 네 추천안:
  - 새 source of truth는 `Scenes` 시트로 고정하고, legacy `Hud`는 한 버전만 마이그레이션 지원
- 가능한 대안:
  - `Hud` 시트를 계속 유지
  - `HudPreset` 개념을 별도 시트로 재도입
- 왜 아직 확정하면 안 되는지:
  - 사용자가 실제로 여러 프로젝트에서 HUD 재사용을 원할 가능성이 있다
- 새 Codex에게 검증 요청할 질문:
  - 현재 사용자의 workbook 작성 습관상 `Scenes` 단일 시트가 충분한가
  - HUD 재사용 니즈가 실제로 있는가
- 관련 코드/문서:
  - `src/runtime/workbook-sheet-parsers.ts::mergeLegacyHudRows`
  - `src/runtime/project-types.ts`
- 결정이 전체 설계에 미치는 영향:
  - workbook schema, migration, 문서화 범위를 바꾼다

## 쟁점 3
- 쟁점:
  - answer marker reveal과 오디오를 어떤 모델로 통일할지
- 네 추천안:
  - compile 단계에서 `SceneEventPlan`을 만들고, 시각/오디오 모두 같은 이벤트를 참조하게 한다
- 가능한 대안:
  - 시각은 renderer 로직, 오디오는 offset 상수로 보정
- 왜 아직 확정하면 안 되는지:
  - 현재 marker reveal “눈에 보이는 시점”을 어떻게 정의할지 합의가 필요하다
- 새 Codex에게 검증 요청할 질문:
  - reveal event의 기준을 `alpha > 0`, `scale intro 시작`, `완전 표시 완료` 중 무엇으로 할지
- 관련 코드/문서:
  - `src/runtime/pixi-preview-app.ts::renderAt`
  - `src/runtime/export-audio-mix.ts::MARKER_REVEAL_AUDIO_OFFSET_SEC`
- 결정이 전체 설계에 미치는 영향:
  - answer sync 관련 버그를 구조적으로 없앨 수 있는지 결정한다

## 쟁점 4
- 쟁점:
  - background video를 export에서 어떻게 처리할지
- 네 추천안:
  - renderer가 “sceneTimeSec에 해당하는 video frame”을 명시적으로 얻는 contract를 갖게 한다
- 가능한 대안:
  - export 전에 background video를 프레임 시퀀스로 분해
  - ffmpeg로 배경만 별도 pre-render
- 왜 아직 확정하면 안 되는지:
  - 정확도와 구현 비용의 tradeoff가 크다
- 새 Codex에게 검증 요청할 질문:
  - 현재 HTMLVideo seek 정책을 안정적으로 deterministic export에 쓸 수 있는가
  - 아니면 pre-process가 더 현실적인가
- 관련 코드/문서:
  - `src/runtime/pixi-preview-app.ts::createVideoSprite`, `syncSceneVideos`, `settleSceneVideos`
  - `docs/ARCHITECTURE_REVIEW.md`
- 결정이 전체 설계에 미치는 영향:
  - intro/timeout parity와 export 속도 모두에 영향을 준다

## 쟁점 5
- 쟁점:
  - export backend를 브라우저 내부 worker로 둘지, 별도 서비스로 둘지
- 네 추천안:
  - UI와 export job orchestration은 분리하되, 구현 초기에는 너무 많은 프로세스를 두지 말고 최소 구성으로 시작
- 가능한 대안:
  - 지금처럼 Vite + HTTP service + Playwright worker 구조 유지
  - 단일 프로세스 기반 로컬 exporter
- 왜 아직 확정하면 안 되는지:
  - 현재 사용자의 운영 환경과 배포 방식이 확정되지 않았다
- 새 Codex에게 검증 요청할 질문:
  - Windows 로컬 사용이 주 시나리오인지
  - 개발 편의보다 운영 안정이 우선인지
- 관련 코드/문서:
  - `scripts/ffmpeg-export-server.mjs`
  - `scripts/headless-export-job.mjs`
  - `scripts/run-dev-with-export.mjs`
- 결정이 전체 설계에 미치는 영향:
  - bootstrap, progress, cancel, 포트 충돌 처리 구조를 결정한다

## 쟁점 6
- 쟁점:
  - sample 프로젝트 고정 구조를 언제 일반화할지
- 네 추천안:
  - 재구현 초기에 project abstraction을 넣고, sample은 그중 하나의 fixture로만 취급
- 가능한 대안:
  - sample 하드코딩을 유지한 채 기능만 먼저 다시 구현
- 왜 아직 확정하면 안 되는지:
  - 기능 재현 우선과 제품화 우선의 순서를 사용자가 정해야 한다
- 새 Codex에게 검증 요청할 질문:
  - 지금 당장 multi-project 지원이 필수인지
  - sample 고정으로 parity를 먼저 맞춘 뒤 일반화해도 되는지
- 관련 코드/문서:
  - `src/main.ts::WORKBOOK_PATH`, `INDEX_PATH`
  - `package.json`
  - `scripts/create-sample-workbook.mjs`
- 결정이 전체 설계에 미치는 영향:
  - bootstrap/UI/export API 설계 범위가 달라진다
