# Codex Rebuild Handoff

## 문서 목적
이 문서는 새 Codex가 이 프로젝트를 **기존 구현의 관성에 끌리지 않고** 재설계/재구현할 수 있도록 만드는 인수인계 패키지의 입구 문서다.

이 문서는 다음 원칙을 전제로 한다.

- 현재 코드베이스는 완성품이 아니다.
- 특히 **최종 export 아키텍처는 잘못 설계된 부분이 크다**.
- 기존 구현을 부분적으로 참고할 수는 있지만, export 쪽은 “고쳐 쓰기”보다 “다시 설계하기”가 더 안전하다.
- 새 Codex는 먼저 문서와 코드를 읽고 독립적으로 설계를 검토해야 한다.

## 프로젝트 목적 요약

### 이 프로그램이 원래 해결하려던 문제
- 틀린 그림 찾기 콘텐츠를 **실시간 게임이 아니라 영상 제작용 저작도구**로 만드는 것.
- 사용자가 미리 준비한 이미지, 영상, 오디오, 엑셀 프로젝트 데이터를 넣고,
- 사람이 정답 좌표를 찍어 저장한 뒤,
- 장면 순서대로 재생하여 최종 영상을 만드는 것.

### 핵심 사용자 흐름
1. 리소스를 `public/projects/<project>/resources/`에 넣는다.
2. 엑셀(`scene-flow.xlsx`)에서 씬 순서, 텍스트, 배경, 오디오를 관리한다.
3. 관리자 패널에서 step별 이미지 위에 정답 좌표를 찍는다.
4. 프리뷰에서 씬을 확인한다.
5. 최종 export로 MP4를 만든다.

### 반드시 유지해야 하는 기능
- 엑셀 기반 씬 관리
- 폴더 스캔 기반 step 자동 인식
- 관리자 패널에서 정답 좌표 저장
- Pixi 기반 프리뷰
- 책장 전환, HUD, 꿀벌 타이머, 정답 마커, 파티클 등 현재 시각 연출의 재현
- 최종 MP4 export

### 현재 구현에서 이미 동작하는 기능
- workbook 로딩/파싱: `src/runtime/load-project-workbook.ts`, `src/runtime/workbook-sheet-parsers.ts`
- 폴더 스캔 기반 `project-index.json` 생성: `scripts/build-project-index.mjs`
- `WorkbookData + ResourceIndex -> ProjectModel` 조립: `src/runtime/build-project-model.ts`, `src/runtime/project-model-resolution.ts`
- Pixi 프리뷰 재생, 씬 전환, 관리자 마커 authoring: `src/runtime/pixi-preview-app.ts`, `src/runtime/preview-session.ts`, `src/runtime/admin-authoring-panel.ts`
- workbook 저장/다운로드: `src/runtime/workbook-persistence.ts`
- `npm run build`, `npx tsc --noEmit`는 현재 통과한다. 근거: 이번 턴 실행 결과.

### 현재 구현에서 불안정하거나 재설계가 필요한 기능
- 최종 MP4 export 전체
- preview와 export 결과 일치성(parity)
- background video가 들어간 scene의 안정적인 결정론 렌더
- 오디오/마커/타이머/꿀벌/전환의 단일 시간축 관리
- sample 프로젝트에 과도하게 고정된 실행/빌드 흐름

## 한 줄 평가
- **저작도구/프리뷰 방향은 대체로 맞다.**
- **최종 export는 여러 번 방향이 바뀌며 복잡해졌고, 다시 설계하는 것이 맞다.**

## 유지할 것 / 버릴 것 / 다시 설계할 것

### 유지할 것
- workbook 파서/저장 흐름
- resource index 생성 규칙
- Pixi 장면의 시각 규칙 자체
- 관리자 마커 authoring UX의 기본 구조

### 버릴 것
- 현재 export 파이프라인 전체를 “정답”이라고 가정하는 태도
- `export-runner.ts` + `video-exporter.ts` + `headless-export-job.mjs` + `ffmpeg-export-server.mjs` 조합을 그대로 연장하는 전략
- sample 프로젝트 하드코딩을 계속 늘리는 방식

### 다시 설계할 것
- export 아키텍처
- 시간축 모델
- preview/export 공통 scene 규칙 표현 방식
- background video 처리 방식
- progress / cancel / partial 정책

## 기존 문서 신뢰도

### 신뢰 가능한 문서
- [docs/pixi-excel-pipeline.md](/D:/AI/codex/spot-new/docs/pixi-excel-pipeline.md)
  - 다만 `Hud` 시트 관련 설명은 일부 현재 구현과 어긋난다.

### 신뢰 낮음 또는 참고만 할 문서
- [docs/current-architecture-and-export-redesign.md](/D:/AI/codex/spot-new/docs/current-architecture-and-export-redesign.md)
- [docs/module-boundaries.md](/D:/AI/codex/spot-new/docs/module-boundaries.md)

위 두 문서는 현재 저장 인코딩이 깨져 있어 일부 환경에서 한글이 mojibake로 보인다. 새 Codex는 이 문서를 “소스 오브 트루스”로 사용하면 안 된다.

## 문서 읽기 순서
1. [docs/ARCHITECTURE_REVIEW.md](/D:/AI/codex/spot-new/docs/ARCHITECTURE_REVIEW.md)
2. [docs/REBUILD_SPEC.md](/D:/AI/codex/spot-new/docs/REBUILD_SPEC.md)
3. [docs/TEST_PLAN.md](/D:/AI/codex/spot-new/docs/TEST_PLAN.md)
4. [docs/OPEN_QUESTIONS_FOR_NEXT_CODEX.md](/D:/AI/codex/spot-new/docs/OPEN_QUESTIONS_FOR_NEXT_CODEX.md)
5. [docs/AGENT_GUIDE.md](/D:/AI/codex/spot-new/docs/AGENT_GUIDE.md)

## 새 Codex가 처음 봐야 할 코드
1. [src/main.ts](/D:/AI/codex/spot-new/src/main.ts)
2. [src/runtime/project-types.ts](/D:/AI/codex/spot-new/src/runtime/project-types.ts)
3. [src/runtime/workbook-sheet-parsers.ts](/D:/AI/codex/spot-new/src/runtime/workbook-sheet-parsers.ts)
4. [src/runtime/project-model-resolution.ts](/D:/AI/codex/spot-new/src/runtime/project-model-resolution.ts)
5. [src/runtime/preview-session.ts](/D:/AI/codex/spot-new/src/runtime/preview-session.ts)
6. [src/runtime/pixi-preview-app.ts](/D:/AI/codex/spot-new/src/runtime/pixi-preview-app.ts)
7. [src/runtime/export-audio-mix.ts](/D:/AI/codex/spot-new/src/runtime/export-audio-mix.ts)
8. [src/runtime/video-exporter.ts](/D:/AI/codex/spot-new/src/runtime/video-exporter.ts)
9. [src/export-runner.ts](/D:/AI/codex/spot-new/src/export-runner.ts)
10. [scripts/ffmpeg-export-server.mjs](/D:/AI/codex/spot-new/scripts/ffmpeg-export-server.mjs)
11. [scripts/headless-export-job.mjs](/D:/AI/codex/spot-new/scripts/headless-export-job.mjs)
12. [scripts/run-dev-with-export.mjs](/D:/AI/codex/spot-new/scripts/run-dev-with-export.mjs)

## 새 Codex에게 전달할 최종 프롬프트 초안
아래 프롬프트를 새 Codex에게 그대로 붙여 넣을 수 있다.

```text
이 프로젝트를 바로 구현부터 하지 말고, 먼저 아래 문서와 코드를 읽고 독립적으로 설계를 검토해줘.

필수 문서:
- docs/CODEX_REBUILD_HANDOFF.md
- docs/ARCHITECTURE_REVIEW.md
- docs/REBUILD_SPEC.md
- docs/TEST_PLAN.md
- docs/OPEN_QUESTIONS_FOR_NEXT_CODEX.md
- docs/AGENT_GUIDE.md

필수 코드:
- src/main.ts
- src/runtime/project-types.ts
- src/runtime/workbook-sheet-parsers.ts
- src/runtime/project-model-resolution.ts
- src/runtime/preview-session.ts
- src/runtime/pixi-preview-app.ts
- src/runtime/export-audio-mix.ts
- src/runtime/video-exporter.ts
- src/export-runner.ts
- scripts/ffmpeg-export-server.mjs
- scripts/headless-export-job.mjs
- scripts/run-dev-with-export.mjs

중요 원칙:
- 기존 구현을 방어하지 말 것
- export는 특히 기존 구현의 관성을 따르지 말 것
- 먼저 “무엇을 유지하고 무엇을 버릴지”를 다시 판정할 것
- 구현 전에 재설계안을 작성하고, 사용자에게 필요한 최소 질문만 할 것
- preview와 export의 시간축/렌더 규칙을 어떻게 통일할지 먼저 검토할 것

먼저 해야 할 일:
1. 현재 구조를 1페이지 요약
2. 유지 / 폐기 / 참고 모듈 재판정
3. export 재설계안 제시
4. 사용자에게 확인이 필요한 쟁점만 3개 이하로 정리
5. 그 다음에만 구현 계획 제시
```
