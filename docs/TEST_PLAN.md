# Test Plan

## 1. 현재 실행 가능한 테스트 명령

### 현재 통과 확인된 명령
- `npx tsc --noEmit`
- `npm run build`

이번 턴 기준 위 두 명령은 실제로 실행해서 통과했다.

### 현재 부족한 점
- 자동화된 단위 테스트가 없다
- golden image 비교 테스트가 없다
- export 결과를 자동으로 검증하는 ffprobe 계약 테스트가 없다

## 2. 현재 실패 중인 테스트
- 별도 테스트 스위트는 존재하지 않는다
- 즉 “실패 중인 테스트”보다 “테스트가 없는 영역”이 문제다

## 3. 새 구현에서 반드시 추가해야 할 테스트

### A. Workbook parser 테스트
- `Scenes` 파싱
- `Audio` 파싱
- `Markers` 파싱
- legacy `Hud` 병합
- 잘못된 수치/빈 문자열 fallback

### B. Compile layer 테스트
- step 리소스 resolve
- diagnostics 생성
- auto-BGM fallback
- intro embedded audio fallback
- transition policy

### C. Scene event plan 테스트
- answer marker reveal 시점
- ok 사운드 시점
- timeout prompt 시점
- step prompt 시점
- book transition 시점

### D. Renderer golden test
- intro keyframe
- puzzle keyframe
- answer keyframe
- timeout keyframe
- book transition 중간 프레임

### E. Export contract 테스트
- scene clip 수와 duration
- transition clip 수와 duration
- final mux 후 video/audio stream 존재
- ffprobe 기준 start_time/duration/fps 검증

### F. Regression 테스트
- step1/step2 marker reveal 속도 일치
- answer scene에서 꿀벌 위치 고정
- answer scene에서 timer/marker/sfx 동기
- background video가 포함된 intro sync

## 4. 회귀 테스트 시나리오

### 시나리오 1: sample 전체 export
- sample workbook 그대로 export
- 모든 scene가 완료되는지 확인
- final MP4 생성 확인

### 시나리오 2: step 1 answer sync
- answer-1에서 마커/사운드/타이머가 맞는지 확인

### 시나리오 3: step 2 answer sync
- answer-2에서 step1과 동일한 reveal cadence인지 확인

### 시나리오 4: intro background video
- intro mp4가 끊기거나 잘리지 않는지 확인

### 시나리오 5: cancel / partial
- export 중 중단
- partial mp4 생성 확인

### 시나리오 6: workbook autosave
- workbook 연결
- 마커 클릭
- `Markers` 시트가 저장되는지 확인

## 5. 수동 검증 절차

### 프리뷰 검증
1. `npm run dev`
2. 브라우저에서 앱 열기
3. scene select로 intro / step / answer / timeout 확인
4. play/reset/seek 확인
5. 관리자 패널에서 마커 추가/undo/clear 확인

### export 검증
1. export 서비스 실행
2. MP4 export 시작
3. 진행도/ETA 갱신 확인
4. cancel 동작 확인
5. final MP4 또는 partial MP4 확인
6. ffprobe로 다음 확인
   - `start_time`
   - `duration`
   - `fps`
   - audio/video stream 존재

## 6. ffprobe 검증 항목
새 구현에서는 아래 값을 자동 검증하는 스크립트를 반드시 추가하는 것을 추천한다.

- video `start_time == 0`
- audio `start_time == 0`
- `video.duration`과 `audio.duration` 차이 허용치 내
- 출력 해상도 일치
- `fps == workbook.project.fps`

## 7. 완료 기준

### 기능 완료 기준
- workbook authoring과 preview가 동작한다
- export가 MP4를 만든다
- cancel/partial이 동작한다

### 품질 완료 기준
- sample 프로젝트 전체 export에서
  - intro video 끊김 없음
  - HUD 크기/위치 parity 확보
  - answer marker / sfx / timer / bee sync 확보

### 테스트 완료 기준
- `npx tsc --noEmit`
- `npm run build`
- parser/compile 핵심 단위 테스트
- 최소 4개 golden keyframe 비교
- sample full export 수동 검증 통과

## 8. 새 구현에서 우선 만들어야 할 테스트 실행 순서
1. parser/compile 순수 함수 테스트
2. scene event timing 테스트
3. renderer keyframe golden test
4. export contract test
5. sample full manual export
