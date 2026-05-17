# Spot Video Authoring 현재 아키텍처와 Export 재설계 문서

## 1. 문서 목적

이 문서는 현재 `spot-new` 프로그램의 실제 코드 기준 아키텍처를 정리하고, 왜 현재 export 설계가 느리고 불안정한지, 앞으로 어떤 방향으로 export를 다시 설계해야 하는지를 결정하기 위한 기준 문서다.

이 문서는 다음 두 가지를 동시에 다룬다.

1. 현재 프로그램 전체 구조
2. 최종 영상 생성(export) 파이프라인의 문제점과 재설계 방향

중요한 전제:

- 이 프로그램은 **실시간 게임 엔진**이 아니라 **영상 제작용 저작도구**다.
- 사용자는 엑셀과 폴더 리소스로 씬을 구성한다.
- 프로그램은 그 데이터를 바탕으로 프리뷰를 보여주고, 최종적으로 영상을 생성해야 한다.
- 따라서 **프리뷰가 편한 구조**와 **최종 export가 안정적이고 빠른 구조**는 반드시 같지 않다.

---

## 2. 현재 프로그램의 상위 구조

현재 프로그램은 크게 5개 레이어로 나뉜다.

1. **프로젝트 데이터 레이어**
   - `scene-flow.xlsx`
   - `project-index.json`
   - 이미지 / 영상 / 오디오 리소스 폴더

2. **데이터 해석 레이어**
   - workbook 로딩
   - resource index 로딩
   - workbook + resource index를 합쳐 `ProjectModel` 생성

3. **저작 / 프리뷰 레이어**
   - 브라우저 UI
   - PixiJS 기반 preview renderer
   - 관리자 마커 authoring

4. **export orchestration 레이어**
   - 프론트엔드에서 export job 시작 / 취소 / 상태 polling
   - export runner 페이지 구동

5. **export service 레이어**
   - 로컬 Node HTTP 서비스
   - headless Chromium 구동
   - ffmpeg 변환 서비스

현재 구조의 핵심 특징은:

- **저작과 프리뷰는 웹 앱**
- **export도 결국 브라우저 기반 렌더러를 다시 사용**
- 마지막에만 ffmpeg를 붙여 MP4로 변환

즉, 지금 구조는 “브라우저 중심 시스템”이다.

---

## 3. 현재 데이터 아키텍처

### 3.1 입력 소스

현재 프로젝트는 두 개의 주 입력 소스를 사용한다.

#### A. Workbook
- 파일: `public/projects/sample/scene-flow.xlsx`
- 로딩: `src/runtime/load-project-workbook.ts`
- 시트 해석: `src/runtime/workbook-sheet-parsers.ts`

이 workbook은 다음 종류의 정보를 담는다.

- 프로젝트 메타데이터
- 씬 목록
- 씬 타입
- duration
- step 번호
- 배경 이미지 / 배경 영상
- 텍스트
- countdown 시작값
- 오디오 정보
- 마커 좌표

#### B. Resource Index
- 파일: `public/projects/sample/project-index.json`
- 생성: `scripts/build-project-index.mjs`

이 index는 폴더 스캔 결과를 정리한다.

- step별 퍼즐 이미지 쌍
- 배경 이미지 목록
- UI 이미지 목록
- effect 이미지 목록
- 영상 목록
- bgm 목록
- sfx 목록

### 3.2 내부 모델

workbook과 resource index는 최종적으로 `ProjectModel`로 합쳐진다.

- 타입 정의: `src/runtime/project-types.ts`
- 조립 진입점: `src/runtime/build-project-model.ts`
- 세부 해석: `src/runtime/project-model-resolution.ts`

현재 `ProjectModel`은 프리뷰와 export가 공통으로 사용하는 실행 단위 모델이다.

중요한 특성:

- `Scenes`가 이미 resolve된 URL을 가진다.
- `Markers`, `Audio`, `Effects`도 scene 기준으로 붙는다.
- step 감지는 엑셀이 아니라 리소스 인덱스 기준이다.

즉 현재 구조는:

`XLSX + 파일 시스템 스캔 -> ProjectModel`

의 단일 해석 경로를 가진다.

이 방향 자체는 맞다.

---

## 4. 현재 프론트엔드 / 저작 구조

### 4.1 메인 진입점

- 파일: `src/main.ts`

현재 `main.ts`는 다음 역할을 맡고 있다.

- workbook + resource index 로딩
- `ProjectModel` 생성
- Pixi preview 초기화
- `PreviewSession` 구성
- Audio preview controller 연결
- Scene select / time slider / play / reset 연결
- Admin panel 구성
- export 버튼 연결

즉 `main.ts`는 앱 bootstrap + orchestration 역할이다.

### 4.2 PreviewSession

- 파일: `src/runtime/preview-session.ts`

이 모듈은 preview 재생 상태를 담당한다.

- active scene
- current time
- playing 여부
- scene 전환
- reset / seek / tick

`requestAnimationFrame` 기반 tick으로 scene time을 전진시키고,
scene 종료 시 다음 scene으로 자동 전환한다.

### 4.3 Pixi renderer

- 파일: `src/runtime/pixi-preview-app.ts`

이 파일은 현재 시각적 렌더링의 중심이다.

담당 범위:

- title / puzzle / answer / timeout 화면 렌더
- 배경 이미지 / 배경 비디오 렌더
- HUD 구성
- 타이머
- 꿀벌 HUD
- 마커 표시
- 파티클 / 효과
- 책장 전환

중요한 점:

- 현재 사용자가 화면에서 “정상”이라고 판단하는 대부분의 결과는 이 Pixi preview renderer 기준이다.
- 즉 **시각적 기준 정답은 현재 preview**다.

### 4.4 Admin authoring

- 파일:
  - `src/runtime/admin-authoring-panel.ts`
  - `src/runtime/admin-authoring-helpers.ts`
  - `src/runtime/workbook-persistence.ts`
  - `src/runtime/markers-sheet.ts`

이 부분은 step 이미지 위에 마커를 찍고,
좌표를 workbook의 marker 데이터에 반영하는 authoring 기능이다.

현재 이 구조는 제품 목적에 맞다.

문제의 중심은 여기가 아니다.

---

## 5. 현재 export 아키텍처

현재 export는 다음 경로를 따른다.

### 5.1 UI에서 export 시작

- `src/main.ts`
- `src/runtime/offline-export-job-client.ts`

브라우저 UI는 로컬 export service에 job 생성 요청을 보낸다.

### 5.2 로컬 export service

- `scripts/ffmpeg-export-server.mjs`

이 서비스는 다음을 제공한다.

- `/health`
- `/jobs/offline-export`
- `/jobs/{id}`
- `/jobs/{id}/cancel`
- `/transcode`

즉 export orchestration과 ffmpeg transcode gateway를 동시에 맡는다.

### 5.3 Headless export job

- `scripts/headless-export-job.mjs`

이 모듈은 headless Chromium을 띄우고,
`export-runner.html`을 열어서 브라우저 안에서 export를 수행하게 만든다.

즉 이 레이어는:

- “렌더를 자체적으로 하지 않는다”
- “렌더를 다시 브라우저에게 맡긴다”

### 5.4 Export runner 페이지

- `export-runner.html`
- `src/export-runner.ts`

headless Chromium 안에서 이 페이지가 열리고,
여기서 다시 다음을 수행한다.

- workbook 로드
- project model 생성
- Pixi preview 앱 생성
- PreviewSession 구성
- `exportProjectOfflineMp4()` 호출

즉 export 전용 페이지지만,
실제로는 다시 브라우저 렌더러를 돌리고 있다.

### 5.5 현재 영상 생성 핵심

- 파일: `src/runtime/video-exporter.ts`

현재 핵심 함수는:

- `renderProjectOfflineWebm()`
- `exportProjectOfflineMp4()`

현재 방식:

1. 전체 project timeline을 한 번에 계산
2. 전체 오디오를 먼저 믹스
3. 모든 프레임을 WebCodecs + Pixi로 오프라인 렌더
4. WebM 생성
5. ffmpeg service에 업로드
6. MP4로 transcode

즉 현재 export는 이름은 “offline mp4 export”지만,
실질은:

**브라우저 기반 전체 타임라인 재렌더 -> WebM -> ffmpeg MP4 변환**

이다.

---

## 6. 현재 export 구조의 핵심 문제점

현재 export가 느리고 불안정한 이유는 ffmpeg 자체가 아니라,
**가장 무거운 일을 브라우저가 전부 떠안고 있기 때문**이다.

### 6.1 전체 타임라인 통렌더

현재는 scene 단위가 아니라 프로젝트 전체를 한 번에 렌더한다.

문제:

- 3~4분 영상이면 수천 프레임을 모두 순차 렌더해야 한다
- 중간 취소가 느리다
- partial 생성이 늦다
- 중간 한 scene만 실패해도 전체 비용이 커진다

### 6.2 프리뷰 렌더러를 export 엔진으로 그대로 사용

preview renderer는 “눈으로 확인하는 인터랙티브 화면”에는 적합하지만,
긴 최종 영상을 빠르게 만드는 렌더러로는 비싸다.

문제:

- requestAnimationFrame 전제를 많이 공유한다
- scene tick / preview state와 export state가 밀접하게 얽힌다
- 긴 타임라인일수록 브라우저/캔버스/WebCodecs 병목이 커진다

### 6.3 headless Chromium을 띄웠지만 병목은 그대로

headless로 돌렸다고 해서 렌더가 갑자기 가벼워지지 않는다.

현재 headless export는:

- 사용자가 보고 있는 탭에서 렌더하지 않는 장점은 있지만
- 여전히 Chromium + Pixi + WebCodecs로 전체 프레임을 재생성한다

즉 “브라우저 export를 눈앞에서 하지 않는다”로 바뀐 것이지,
“근본적으로 빠른 파이프라인”이 된 것은 아니다.

### 6.4 ffmpeg가 마지막 변환만 담당

현재 ffmpeg는 주로 WebM -> MP4 transcode에만 쓰인다.

즉 ffmpeg가 잘하는:

- segment concat
- stream copy
- 안정적 mux
- 전역 오디오 합성

이 장점을 핵심 경로에서 충분히 활용하지 못하고 있다.

### 6.5 진행도/ETA가 실제 처리량과 직접 연결되지 않음

현재 job 상태는 phase/message 중심이다.

문제:

- 사용자는 “멈춘 것 같다”고 느낀다
- 어느 scene에서 오래 걸리는지 명확하지 않다
- 남은 시간 예측이 어렵다

### 6.6 취소가 느리다

현재는 전체 렌더/전송 파이프라인 중간에서 취소 요청을 넣는다.

문제:

- 현재 작업 단위를 즉시 끊기 어렵다
- partial 생성이 늦다
- 사용자 체감은 “Stop을 눌러도 한참 기다린다”가 된다

### 6.7 parity 문제의 원인

과거에 ffmpeg 필터로 직접 화면을 재조립하던 경로는 preview와 export가 갈라지는 문제가 있었다.
지금은 그 방향을 버리고 headless Pixi로 다시 묶었지만,
속도 문제는 여전히 남아 있다.

즉 현재 상황은:

- **정확도는 preview 기준으로 묶는 방향이 맞다**
- **성능은 전체 타임라인 통렌더 때문에 여전히 나쁘다**

---

## 7. 결론: 무엇이 잘못 설계되었는가

프로그램 전체가 잘못 설계된 것은 아니다.

잘 설계된 부분:

- workbook 기반 저작
- resource index 기반 step 관리
- Pixi preview
- admin marker authoring
- scene 중심 데이터 모델

잘못 설계된 부분:

- **최종 export를 preview 렌더 구조 그대로 전체 통렌더로 처리한 것**

즉 문제는 전체 프로그램이 아니라,
**export 설계가 프리뷰 친화적으로만 커졌고, 생산 파이프라인 관점으로 재분리되지 않은 것**이다.

---

## 8. export 재설계의 목표

새 export 설계의 목표는 아래 네 가지다.

1. **프리뷰와 최대한 같은 그림을 만든다**
2. **긴 영상을 안정적으로 만든다**
3. **중간 취소와 partial을 빠르게 만든다**
4. **전체 타임라인 통렌더를 피해서 속도를 개선한다**

이 네 가지를 동시에 만족하려면,
현재처럼 “한 번에 끝까지 렌더”하면 안 된다.

---

## 9. 권장 export 재설계 방향

### 9.1 핵심 원칙

권장 방향은 다음 한 줄로 요약된다.

**전체 타임라인 통렌더를 버리고, scene clip + transition clip + final audio mux 구조로 바꾼다.**

### 9.2 새 export 구조

#### 단계 1. Export Plan 생성

브라우저는 workbook과 resource index를 다시 읽지 않는다.
이미 만들어진 `ProjectModel`을 기준으로 export plan을 만든다.

이 plan에는 최소한 다음이 포함되어야 한다.

- export 대상 scene 순서
- 각 scene duration
- step 정보
- transition 사용 여부
- 각 scene이 사용할 resolved resource
- 전역 오디오 timeline 정보

즉 export는 “엑셀 파싱”이 아니라 “실행 계획”을 받아야 한다.

#### 단계 2. Scene clip 렌더

각 scene/group을 독립적인 **무음 MP4** 또는 **무음 WebM** clip으로 렌더한다.

예:

- `intro`
- `step-1`
- `answer-1`
- `step-2`
- `answer-2`
- `timeout`

중요:

- 여기서 각 clip은 자기 scene만 책임진다
- scene 단위로 실패/재시도 가능해야 한다
- 이미 만든 scene clip은 캐시 가능해야 한다

#### 단계 3. Transition clip 렌더

전환은 scene 내부에서 처리하지 않고,
필요한 경우 **별도 전환 clip**으로 만든다.

예:

- `intro -> step-1` 책장 전환 clip
- `answer-1 -> step-2` 책장 전환 clip
- `answer-2 -> timeout` 책장 전환 clip

이렇게 해야:

- scene clip이 독립적으로 유지된다
- 전환만 따로 고칠 수 있다
- concat 구조가 단순해진다

#### 단계 4. Raw video concat

scene clip + transition clip을 순서대로 이어붙여
**raw video**를 만든다.

여기에는 오디오를 굽지 않는다.

즉:

- `scene video only`
- `transition video only`
- `concat`

으로 끝낸다.

#### 단계 5. Final audio timeline mix

오디오는 scene clip에 bake하지 않고,
마지막에 project 전체 기준으로 한 번만 합성한다.

이 단계에서 처리할 것:

- BGM
- loop
- SFX
- answer ok
- book page effect
- intro video audio fallback 정책

즉 오디오는 **전역 timeline 하나**로 관리한다.

#### 단계 6. Final mux

마지막으로:

- raw video
- final mixed audio

를 ffmpeg로 mux해서 `final.mp4`를 생성한다.

---

## 10. 왜 이 방향으로 가야 하는가

### 10.1 속도

전체 타임라인 통렌더를 하면 매번 처음부터 끝까지 다시 계산해야 한다.

scene clip 구조로 바꾸면:

- 이미 끝난 scene은 다시 만들 필요가 없다
- 취소 시 현재 scene까지만 손실
- transition과 audio를 분리하면 concat 비용이 작다

즉 속도는 “무조건 빠름”을 보장할 수는 없지만,
현재 구조보다 훨씬 **관리 가능한 비용 구조**가 된다.

### 10.2 안정성

scene 단위면:

- 실패 지점이 좁아진다
- retry 범위가 작아진다
- partial 생성이 쉬워진다
- cancel 반응성이 좋아진다

### 10.3 parity 유지

scene clip 렌더러는 여전히 **현재 Pixi preview 렌더 규칙**을 사용할 수 있다.

즉 “그림을 무엇으로 그릴 것인가”는 유지하고,
“언제 어떤 단위로 그릴 것인가”만 바꾸는 것이다.

이 점이 중요하다.

권장 방향은 “렌더러를 새로 만드는 것”이 아니라,
**현재 렌더러를 scene 단위 production pipeline으로 재배치하는 것**이다.

### 10.4 오디오 품질

오디오를 scene마다 bake하고 concat하면:

- scene 경계 끊김
- fade 처리 어려움
- loop 제어 난해함

전역 오디오 한 번 합성이 더 맞다.

---

## 11. 새 export 설계의 구체적 제안

### 11.1 새 책임 분리

#### 브라우저 UI
- export plan 생성
- export 시작 / 취소 / 상태 표시
- 진행률 / ETA 표시

#### Scene Renderer
- scene 단위 무음 영상 생성
- transition clip 생성

#### Audio Renderer
- 전체 timeline 오디오 믹스

#### ffmpeg Orchestrator
- concat
- mux
- partial
- 최종 파일 쓰기

### 11.2 현재 코드 기준 유지할 것

유지해야 할 것:

- `ProjectModel`
- `PreviewSession`
- `PixiPreviewApp`의 시각 규칙
- workbook 기반 authoring 구조

바꿔야 할 것:

- `video-exporter.ts`의 “전체 타임라인 통렌더” 중심 설계
- export progress 모델
- cancel / partial 정책

### 11.3 새 export 상태 모델

상태는 다음처럼 분리하는 것이 좋다.

- `preparing`
- `rendering_scene`
- `rendering_transition`
- `concatenating_video`
- `mixing_audio`
- `muxing_final`
- `completed`
- `cancelled`
- `failed`

상태에 같이 보여줄 값:

- 현재 scene id
- 완료 scene 수 / 전체 scene 수
- 현재 단계
- 진행률 %
- elapsed
- ETA
- 현재 출력 파일 경로

### 11.4 cancel 정책

현재처럼 전체 파이프라인 한가운데서 멈추는 방식이 아니라:

- 현재 clip 단위까지만 마무리
- 이미 완성된 video segments는 유지
- 오디오는 현재 시점까지 partial mix
- 즉시 `partial.mp4` 생성

이렇게 가야 한다.

---

## 12. 예상되는 효과

### 좋아지는 점

- 긴 export에서 사용자 체감이 좋아짐
- progress/ETA를 실제 처리량 기준으로 보여줄 수 있음
- stop 후 partial 생성이 빨라짐
- scene 단위 재시도 가능
- 브라우저 전체 통렌더보다 구조적으로 더 안정적

### 여전히 남는 점

- scene 자체가 무거우면 그 scene 렌더는 여전히 시간이 든다
- preview와 export가 100% 같으려면 scene renderer가 같은 시각 규칙을 계속 써야 한다
- background video가 많은 scene은 여전히 비싸다

하지만 이건 “구조적 병목”이 아니라 “scene 내용의 무게” 문제다.
현재처럼 전체 구조 자체가 느린 것과는 다르다.

---

## 13. 권장 구현 순서

### 1단계
- `ExportPlan` 타입 정의
- `ProjectModel -> ExportPlan` 생성기 작성

### 2단계
- scene clip 렌더 API 작성
- transition clip 렌더 API 작성

### 3단계
- concat 단계 추가
- final audio mix 단계 추가

### 4단계
- progress / ETA / cancel / partial 재설계

### 5단계
- 기존 전체 통렌더 경로 제거 또는 fallback으로 격하

---

## 14. 최종 결론

현재 프로그램은 저작도구/프리뷰로서는 방향이 맞다.

문제는 export가:

- preview 렌더 구조에 너무 붙어 있고
- 전체 타임라인을 한 번에 렌더하고
- ffmpeg를 마지막 변환기로만 쓰고 있다는 점이다.

따라서 export는 다음 방향으로 다시 설계해야 한다.

**scene clip 렌더 + transition clip 렌더 + raw video concat + final audio mux**

이 방향이 최선인 이유는:

- 현재 프로그램 구조를 버리지 않아도 되고
- preview와 export의 시각 규칙을 계속 공유할 수 있고
- 느리고 불안정한 전체 통렌더를 없앨 수 있고
- 긴 영상에서도 cancel / partial / retry / progress를 더 제대로 만들 수 있기 때문이다.

즉, 앞으로의 핵심은:

**프로그램 전체를 다시 만드는 것**이 아니라,
**export를 production pipeline 관점으로 다시 분리하는 것**이다.
