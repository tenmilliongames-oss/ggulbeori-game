# Agent Guide

## 새 Codex가 처음 해야 할 작업 순서

### 1. 읽어야 할 문서/파일
1. `docs/CODEX_REBUILD_HANDOFF.md`
2. `docs/ARCHITECTURE_REVIEW.md`
3. `docs/REBUILD_SPEC.md`
4. `docs/TEST_PLAN.md`
5. `docs/OPEN_QUESTIONS_FOR_NEXT_CODEX.md`
6. `src/main.ts`
7. `src/runtime/project-types.ts`
8. `src/runtime/workbook-sheet-parsers.ts`
9. `src/runtime/project-model-resolution.ts`
10. `src/runtime/preview-session.ts`
11. `src/runtime/pixi-preview-app.ts`
12. export 관련 파일 전체

### 2. 먼저 확인해야 할 가정
- workbook이 여전히 제품의 source of truth인지
- sample 프로젝트가 실제 운영 환경을 대표하는지
- 최우선 목표가 “정확도 우선”인지
- background video 지원이 반드시 필요한지
- preview와 export의 시각 parity를 어디까지 맞춰야 하는지

### 3. 설계안 작성
구현 전에 반드시 아래를 먼저 문서화해야 한다.
- 유지할 코드 / 버릴 코드 / 참고할 코드
- 새 export 아키텍처
- compile layer와 event plan 정의
- preview/export 공통 renderer 계약
- migration 계획

### 4. 사용자에게 확인해야 할 최소 질문
질문은 3개 이하로 줄인다. 추천 질문:
1. background video를 현재 수준으로 반드시 유지해야 하는가
2. `Scenes` 단일 시트로 완전히 통합해도 되는가
3. export 속도보다 정확도가 우선이라는 판단이 여전히 유효한가

### 5. 구현 1단계
추천 순서:
1. `CompiledProjectSpec` 설계
2. workbook/resource -> compiled spec 변환
3. scene event plan 추가
4. renderer를 scene spec 입력 기반으로 정리
5. preview executor 재연결
6. deterministic export executor 추가

### 6. 테스트
1. parser/compile 테스트
2. keyframe golden test
3. audio/event timing 테스트
4. export clip 계약 테스트
5. sample full export 수동 검증

### 7. 마이그레이션 또는 기존 코드 제거
- 새 export가 안정화되기 전까지 기존 export 코드는 병행 보관 가능
- 단, source of truth는 새 문서와 새 pipeline으로 빨리 전환해야 한다
- 안정화 후 기존 export 관련 파일을 제거한다

## 구현 중 지켜야 할 규칙
- 기존 구현을 “이미 맞는 방향”이라고 전제하지 말 것
- export 버그를 오프셋 상수로 때우지 말 것
- renderer에 workbook 정책을 직접 넣지 말 것
- preview state와 export state를 공유하지 말 것
- sample 프로젝트 하드코딩을 늘리지 말 것

## 새 Codex가 빠지기 쉬운 함정
- `pixi-preview-app.ts`를 그대로 export 정답으로 믿는 것
- `export-audio-mix.ts`의 현재 규칙을 제품 규격으로 오해하는 것
- `run-dev-with-export.mjs`를 제품 핵심으로 간주하는 것
- 오래된 문서를 source of truth로 삼는 것

## 구현 전 체크리스트
- `npx tsc --noEmit` 통과 상태 확인
- `npm run build` 통과 상태 확인
- sample workbook과 sample export를 직접 열어 현재 증상을 재확인
- 새 설계가 어떤 파일을 폐기 대상으로 만드는지 명시
