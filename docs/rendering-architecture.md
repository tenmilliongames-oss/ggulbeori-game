# Rendering Architecture

## Short Summary

이 프로젝트의 렌더러는 실시간 게임 엔진이 아니라, 저장된 프로젝트 데이터를 프레임 번호에 따라 평가해 화면을 합성하는 결정론적 타임라인 렌더러로 설계한다. 핵심은 입력 처리나 게임 상태 갱신이 아니라, 정적인 퍼즐 원본과 사전 정의된 오버레이 이벤트를 같은 규칙으로 반복 재생하고 그대로 영상으로 내보내는 것이다.

`preview renderer`와 `final offline renderer`는 별도 로직을 갖지 않고 동일한 `timeline evaluation core`를 공유한다. 차이는 출력 대상뿐이다. 미리보기는 현재 프레임을 캔버스에 표시하고, 최종 렌더는 모든 프레임을 순차 합성해 비디오로 인코딩한다.

## Design Goal

- 동일한 프로젝트 데이터에서 항상 동일한 프레임 결과를 만든다.
- 퍼즐 장면은 대부분 정적인 이미지 합성으로 처리한다.
- 텍스트, HUD, 카운트다운, 정답 원형 표시를 타임라인 이벤트로 다룬다.
- 미리보기와 최종 출력의 차이를 최소화한다.
- 게임 루프, ECS, 실시간 상태 머신 없이 단순한 순차 평가 구조를 유지한다.

## Core Model

렌더링은 아래 식으로 정의한다.

`frameIndex -> timeSeconds -> active scene -> active overlays -> composited frame`

입력은 사용자 상호작용이 아니라 사전 저장된 프로젝트 파일이다.

- 프로젝트 메타데이터: 해상도, FPS, 출력 길이
- 씬 정의: 인트로, 퍼즐, 정답 공개, 아웃트로
- 자산 참조: 좌우 이미지, 배경, 아이콘, 폰트, 오디오
- 오버레이 이벤트: 텍스트, HUD, 카운트다운, 강조 원
- 애니메이션 파라미터: 시작 시각, 종료 시각, easing, 위치/스케일/알파

## Preview Renderer and Final Offline Renderer

### Shared evaluation core

두 렌더러는 반드시 같은 함수 집합을 쓴다.

- `resolveScene(project, t)`
- `sampleTrack(track, t)`
- `evaluateAnimation(keyframes, t)`
- `buildOverlayList(scene, t)`
- `composeFrame(renderState)`

즉, 시간 `t`에서 어떤 텍스트가 보여야 하고, 카운트다운 숫자가 무엇이며, 정답 원의 반지름과 알파가 얼마인지 계산하는 규칙은 완전히 동일하다.

### Preview renderer

용도는 저작 검토와 빠른 피드백이다.

- 현재 타임라인 위치의 단일 프레임 또는 저속 재생을 보여준다.
- 스크럽, 정지, 프레임 이동이 가능하면 충분하다.
- 캐시된 비트맵과 텍스트 레이아웃을 재사용해 반응성을 높인다.
- 필요하면 해상도 축소 프리뷰를 지원한다.

### Final offline renderer

용도는 결과물 생성이다.

- `frameIndex = 0..N-1`를 누락 없이 순서대로 평가한다.
- 각 프레임을 고정 해상도로 합성한다.
- 결과를 이미지 시퀀스 또는 ffmpeg 파이프로 전달한다.
- 오디오가 있으면 별도 트랙으로 mux한다.

핵심은 preview가 "비슷하게 보이는 다른 렌더러"가 아니라, offline과 같은 계산을 수행하는 "다른 출력 모드"여야 한다는 점이다.

## Coordinate System

좌표계는 단순한 2D 픽셀 공간으로 고정한다.

- 원점: 최종 프레임 좌상단 `(0, 0)`
- 단위: 픽셀
- 방향: x는 오른쪽 증가, y는 아래 증가
- 기준 해상도 예시: `1920x1080` 또는 프로젝트별 고정 해상도

모든 저작 데이터는 기준 해상도 좌표로 저장한다.

- 좌우 퍼즐 이미지의 배치 사각형
- 상단 HUD 바 영역
- 텍스트 앵커 위치
- 정답 표시 중심점과 반지름

프리뷰 축소 렌더는 저장 좌표를 바꾸지 않고 뷰포트 스케일만 적용한다. 이렇게 해야 저작 좌표와 최종 출력 좌표가 항상 일치한다.

## Time Axis and Determinism

시간축은 실수 누적 델타가 아니라 프레임 인덱스 기반으로 계산한다.

- `fps`는 프로젝트 고정값
- `t = frameIndex / fps`
- 총 프레임 수 `totalFrames = round(durationSeconds * fps)`

중요한 원칙:

- `deltaTime` 누적 방식 금지
- 실제 벽시계 시간 의존 금지
- 난수 사용 금지, 필요하면 고정 seed 사용
- 부동소수 오차가 반복 누적되지 않게 `t`는 항상 프레임 인덱스에서 직접 계산

이 구조면 어느 머신에서 다시 렌더해도 같은 프레임 경계에서 같은 이벤트가 발생한다.

## Animation and Easing Reproduction

애니메이션은 "속도 기반 시뮬레이션"이 아니라 "시간 샘플링 함수"로 처리한다.

예시 속성:

- `opacity`
- `x`, `y`
- `scale`
- `rotation`
- `strokeWidth`
- `countdownValue`

각 속성은 아래 구조로 평가한다.

1. 이벤트의 시작/종료 시각을 확인한다.
2. 정규화 시간 `u = clamp((t - start) / (end - start), 0, 1)`를 구한다.
3. easing 함수 `e = easing(u)`를 적용한다.
4. `lerp(from, to, e)` 또는 정수 규칙으로 값을 결정한다.

권장 easing:

- `linear`
- `easeInOutQuad`
- `easeOutCubic`
- `stepHold`

카운트다운 숫자처럼 프레임 경계가 중요한 요소는 연속 보간 대신 명시적 규칙으로 계산한다.

- 예: `remaining = ceil(endTime - t)`
- 또는 프레임 기준 큐시트로 숫자 전환 시점을 직접 저장

즉, "카운트가 대충 줄어드는" 방식이 아니라 "몇 프레임에 어떤 숫자가 보이는지"가 결정되어야 한다.

## Overlay Composition

오버레이는 퍼즐 베이스 이미지 위에 올리는 2D 레이어 집합으로 구성한다.

권장 레이어 순서:

1. 배경 또는 씬 백플레이트
2. 좌/우 퍼즐 이미지
3. 프레임 장식, 분할선
4. HUD 바, 스텝 표시, 진행 정보
5. 안내 자막
6. 카운트다운 숫자 또는 타이머
7. 정답 표시 원, 펄스, 하이라이트
8. 전환용 페이드 또는 전체 화면 오버레이

각 오버레이는 공통 필드를 가진다.

- `type`
- `start`, `end`
- `zIndex`
- `layout`
- `style`
- `animation`

### Subtitle / HUD / Countdown / Answer marker

#### Subtitle

- 문구, 폰트, 크기, 정렬, 외곽선/그림자 정의
- 화면 하단 또는 상단 고정 앵커 사용
- 장면 시작/종료에 페이드 인/아웃 적용 가능

#### HUD

- 스텝 번호, 남은 시간, 문제 수 같은 고정형 정보
- 대부분 위치 변화 없이 텍스트 값만 바뀐다
- 퍼즐 장면 전체 동안 유지되는 긴 수명의 레이어로 두는 편이 단순하다

#### Countdown

- HUD 일부로 두거나 독립 레이어로 분리 가능
- 숫자 점프, 색 변화, 깜빡임을 이벤트 기반으로 표현
- 프레임 기준 시점에서만 변경되도록 정수 규칙 사용

#### Answer marker

- 사람이 찍은 정답 좌표를 프로젝트에 저장
- 공개 구간에서 원형 stroke 오버레이를 좌표에 배치
- 필요하면 `scale 0.8 -> 1.0`, `opacity 0 -> 1` 같은 짧은 easing만 적용
- 복수 정답은 배열 순회로 같은 규칙 반복

정답 표시는 별도 판정 시스템이 아니라, "미리 저장된 위치를 특정 시간대에 보여주는 렌더 이벤트"일 뿐이다.

## Video Output

권장안은 두 단계 중 하나다.

### Option A: PNG frame sequence + ffmpeg

가장 단순하고 디버깅이 쉽다.

- 렌더러가 `frame_000001.png` 형태로 프레임 저장
- 이후 ffmpeg로 영상 인코딩
- 중간 산출물을 눈으로 검수 가능
- 실패 시 특정 프레임부터 재렌더하기 쉽다

예시:

```bash
ffmpeg -framerate 30 -i frame_%06d.png -i audio.wav -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4
```

### Option B: ffmpeg stdin pipe

디스크 사용량을 줄이고 배치 렌더를 단순화할 수 있다.

- 렌더러가 raw frame 또는 png stream을 ffmpeg stdin으로 전달
- 중간 프레임 파일이 남지 않는다
- 대신 디버깅과 재시작은 조금 불편하다

예시:

```bash
ffmpeg -y -f rawvideo -pixel_format rgba -video_size 1920x1080 -framerate 30 -i - -i audio.wav -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4
```

### Recommended default

초기 버전은 `PNG frame sequence + ffmpeg`를 권장한다.

- 구현이 가장 단순하다
- 프레임 단위 검수가 쉽다
- preview와 offline 결과 비교가 쉽다
- 렌더 오류를 눈으로 추적하기 쉽다

프로젝트가 안정화된 뒤 필요할 때만 ffmpeg 파이프 출력으로 최적화하면 된다.

## Why This Is Simpler Than a Game Loop

게임 루프 중심 설계는 이 프로젝트에 필요 없는 복잡성을 만든다.

- 사용자 입력 폴링이 필요 없다.
- 충돌, 판정, 점수, 실시간 상태 전이가 필요 없다.
- 물리 업데이트나 variable delta time 보정이 필요 없다.
- "정답을 맞췄는가"를 계산하지 않는다. 정답 위치는 이미 저장되어 있다.

이 프로젝트의 본질은 아래에 가깝다.

- 비선형 편집기의 축소판
- 씬 기반 모션 그래픽 합성기
- 이미지와 오버레이를 시간표대로 재생하는 배치 렌더러

따라서 가장 단순한 구조는:

`project file -> timeline evaluator -> frame compositor -> video encoder`

이지,

`input system -> gameplay state -> update loop -> rendering loop`

가 아니다.

## Minimal Recommended Modules

불필요한 프레임워크 없이 아래 정도면 충분하다.

- `project-loader`: 프로젝트 JSON/YAML 읽기
- `timeline-evaluator`: 현재 프레임에서 활성 요소 계산
- `layout-resolver`: 좌표와 앵커를 픽셀 사각형으로 변환
- `overlay-renderer`: 텍스트, 원, HUD, 이미지 합성
- `export-runner`: 프레임 시퀀스 저장 또는 ffmpeg 호출
- `preview-app`: 동일 코어를 이용한 스크럽/프리뷰 UI

## Recommendation

초기 구현은 다음 순서가 가장 안전하다.

1. 단일 퍼즐 씬을 정지 이미지 + HUD + 카운트다운 + 정답 원으로 렌더한다.
2. 같은 프로젝트 파일로 preview 단일 프레임 렌더와 offline 300프레임 렌더를 비교한다.
3. 인트로/아웃트로 씬을 추가한다.
4. 마지막에 ffmpeg 인코딩을 연결한다.

이 순서를 따르면 "렌더 코어의 결정성"을 먼저 검증하고, UI나 내보내기 편의 기능은 그 뒤에 붙일 수 있다.
