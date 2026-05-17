# 모듈 책임 경계

이 문서는 현재 코드베이스를 기준으로, 앞으로 리팩터링이나 기능 개발을 진행할 때 각 모듈이 어디까지 책임져야 하는지 고정하기 위한 기준 문서입니다.

## 핵심 규칙

- 각 모듈은 자신이 소유한 파일과 로직만 수정합니다.
- 공통 타입, 앱 레벨 상태, 모듈 간 오케스트레이션은 메인만 변경합니다.
- 프리뷰 모듈이 export나 workbook 정책까지 흡수하면 안 됩니다.
- export 모듈이 UI/세션 상태를 직접 변경하면 안 됩니다.
- 데이터/저작 모듈이 렌더링 정책을 소유하면 안 됩니다.

## 모듈 구분

### 1. 데이터 + 저작

소유 책임:

- workbook 스키마와 row 타입 정의
- XLSX 파싱 및 기본값 보정
- 레거시 workbook 호환 처리
- resource index와 workbook 사이의 정합성 검증
- 마커 저작 UI 동작
- workbook 저장/내보내기 연결 흐름

현재 소유 파일:

- `src/runtime/project-types.ts`
- `src/runtime/load-project-workbook.ts`
- `src/runtime/build-project-model.ts`
- `src/runtime/admin-authoring-panel.ts`
- `src/runtime/workbook-persistence.ts`

소유하면 안 되는 것:

- Pixi 렌더링 규칙
- HUD 시각 fallback 정책
- export 인코딩/먹싱
- preview 재생 상태

메모:

- `build-project-model.ts`는 현재 데이터 검증 외에 runtime resource 정책과 자동 BGM 정책까지 같이 들고 있습니다. 장기적으로는 workbook/resource 해석과 diagnostics까지만 남기는 편이 맞습니다.
- `admin-authoring-panel.ts`는 마커 저작과 workbook 변경에만 집중하고, runtime asset 정책은 알지 않는 구조가 좋습니다.

### 2. 프리뷰 런타임

소유 책임:

- Pixi 씬 그래프 생명주기
- 씬 렌더링
- HUD, 프롬프트, 타이머, 마커, 전환 효과 렌더링
- 씬 시간에 따른 프레임 단위 시각 업데이트
- background video와 preview audio의 동기화

현재 소유 파일:

- `src/runtime/pixi-preview-app.ts`
- `src/runtime/audio-preview-controller.ts`

소유하면 안 되는 것:

- workbook 파싱
- 씬 순서 정책
- export 타임라인 생성
- export 오디오 믹스 및 파일 인코딩
- DOM 버튼/슬라이더 상태

메모:

- `pixi-preview-app.ts`는 앱 컨트롤러가 아니라 렌더러로 취급해야 합니다.
- `audio-preview-controller.ts`는 preview 오디오 책임을 일관되게 가져야 하며, preview SFX가 여러 파일에 흩어지지 않는 편이 좋습니다.

### 3. Export 파이프라인

소유 책임:

- 오프라인 export용 타임라인 전개
- 오프라인 오디오 믹스 실행
- 프레임 인코딩 및 먹싱
- 최종 영상 파일 생성

현재 소유 파일:

- `src/runtime/video-exporter.ts`

장기적으로 분리 목표:

- `src/runtime/export-timeline.ts`
- `src/runtime/export-audio-mix.ts`
- `src/runtime/export-encoder.ts`

소유하면 안 되는 것:

- DOM/UI lock 상태
- workbook 변경
- 렌더러 내부 구현 상세
- 앱/도메인 규칙에 해당하는 씬 의미 정책

메모:

- export는 Pixi 내부 구현에 깊게 접근하지 말고, 안정된 render surface 계약만 소비하는 쪽이 맞습니다.
- marker SFX 주입, title video embedded audio fallback, transition SFX 같은 내용 정책은 장기적으로 encoder 내부에 묻어두지 않는 편이 좋습니다.

### 4. 메인 앱 오케스트레이션

소유 책임:

- 앱 bootstrap
- DOM 이벤트 연결
- 공용 앱/세션 상태
- 모듈 간 lifecycle 조정
- scene apply/reset/play/export 조정
- workbook 수정 후 rebuild 흐름

현재 소유 파일:

- `src/main.ts`

장기적으로 소유하지 않는 것이 좋은 것:

- preview 재생 상태기계 상세 구현
- export 구현 세부사항
- workbook 파싱 세부사항

메모:

- 현재는 공용 세션 상태를 가장 안전하게 들고 있을 수 있는 곳이 `main.ts`뿐이므로, 공통 상태는 우선 메인에 둡니다.
- 첫 번째 분리 후보는 `preview-session.ts`입니다. 이 파일로 재생 상태기계를 옮기되, DOM 소유권은 `main.ts`에 남기는 방향이 좋습니다.

## 메인 전용 소유 범위

아래 항목은 당분간 메인만 변경합니다.

- 여러 모듈에 영향을 주는 공통 타입
- `ProjectModel` shape 변경
- `ResolvedScene` shape 변경
- 공용 resource resolution 계약
- scene apply/rebuild/export orchestration
- 앱 레벨 상태:
  - `activeScene`
  - `currentTimeSec`
  - `isPlaying`
  - `sceneTransitioning`
  - `exportInProgress`
  - `exportStopRequested`

## 현재 누수 지점

### 데이터 누수

- `src/runtime/build-project-model.ts`가 현재 data resolution 외에 resource URL normalization, UI fallback 선택, auto-BGM 정책까지 소유하고 있습니다.
- `src/runtime/project-types.ts`에 workbook source 타입과 runtime resolved 타입이 함께 들어 있습니다.

### 프리뷰 누수

- `src/main.ts`가 사실상 preview session state machine 역할까지 하고 있습니다.
- `src/runtime/pixi-preview-app.ts`가 export용 API를 직접 노출하고 있어 preview와 export가 너무 강하게 묶여 있습니다.
- preview audio 책임이 `pixi-preview-app.ts`와 `audio-preview-controller.ts`에 나뉘어 있습니다.

### Export 누수

- `src/runtime/video-exporter.ts`가 좁은 frame-provider 계약이 아니라 `PixiPreviewApp` 동작 자체에 직접 의존하고 있습니다.
- export 내부에 marker OK SFX, title video embedded audio fallback, book-page SFX 같은 내용 정책이 들어 있습니다.

### 공통 정책 누수

- resource path normalization이 여러 파일에 중복되어 있습니다.
- book transition 타이밍과 정책이 `main.ts`, `pixi-preview-app.ts`, `video-exporter.ts`에 흩어져 있습니다.

## 병렬 작업 규칙

### 데이터 + 저작 워커

- 허용 범위: workbook schema/load/save, marker authoring UI, workbook/resource validation
- 금지 범위: preview 렌더링 변경, export 파이프라인 변경, 메인 통합 없이 공통 타입 shape 변경

### 프리뷰 워커

- 허용 범위: Pixi drawing, HUD 렌더링, 시간 기반 preview animation, preview audio sync
- 금지 범위: workbook schema 변경, export muxing/encoding 변경, 공용 앱 상태 변경

### Export 워커

- 허용 범위: 오프라인 타임라인 렌더링, 오디오 믹스, 인코딩, 먹싱, export adapter
- 금지 범위: DOM control 변경, workbook mutation 흐름 변경, 메인 통합 없이 공통 타입 직접 변경

### 메인 통합

- 모든 워커 결과가 나온 뒤에만 공통 계약을 통합합니다.
- 공통 타입, 공유 정책, 세션 상태 wiring의 최종 변경은 메인이 소유합니다.

## 추천 분리 순서

1. 여러 파일에 흩어진 shared resource-path resolver와 transition policy를 먼저 뽑아냅니다.
2. `preview-session.ts`를 도입해서 `main.ts`가 preview state machine을 직접 들고 있지 않게 만듭니다.
3. `video-exporter.ts`를 timeline, mix, encoder 레이어로 나눕니다.
4. workbook source 타입과 runtime resolved 타입을 분리합니다.
