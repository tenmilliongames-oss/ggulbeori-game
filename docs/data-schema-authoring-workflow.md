# 틀린 그림 찾기 영상 제작용 프로그램

## 짧은 요약 보고서

- 이 프로그램의 핵심은 "플레이 가능한 게임"이 아니라 "미리 정의된 장면을 결정론적으로 렌더링해 영상으로 뽑는 저작도구"다.
- 따라서 런타임 상태 머신보다 프로젝트 파일의 명확성, 수동 수정 가능성, 같은 입력에서 같은 출력이 나오는 재현성이 우선이다.
- 저장소 구조는 `프로젝트 폴더 + JSON 파일 + 이미지/폰트/오디오 파일`로 충분하다. 초기 단계에서는 DB나 서버가 필요 없다.
- 정답 위치는 사람이 직접 찍되, 픽셀 절대좌표가 아니라 원본 이미지 기준 정규화 좌표로 저장하는 것이 안전하다.
- 스키마는 `project -> assets -> scenes -> timeline -> answerMarkers -> overlays -> output` 순서로 단순하게 유지하고, 확장은 필요한 필드만 뒤에 추가한다.

## 설계 원칙

1. JSON 우선
- 사람이 열어보고 고칠 수 있어야 하므로 초기 저장 포맷은 JSON이 가장 적합하다.
- 바이너리 프로젝트 포맷이나 별도 DB는 초기에 이득보다 복잡성이 크다.

2. 프로젝트 폴더 단위 관리
- 하나의 프로젝트는 하나의 폴더로 관리한다.
- JSON에는 상대경로만 저장해 이동과 백업을 쉽게 한다.

3. 결정론적 재생
- 모든 시간값은 밀리초(ms) 단위 정수로 저장한다.
- 애니메이션과 오버레이는 "현재 시간 t"에서 계산 가능한 순수 데이터여야 한다.

4. 정답 좌표는 정규화 좌표
- 이미지 교체, 해상도 변경, 출력 해상도 변경에도 최대한 안정적으로 유지되도록 `0.0 ~ 1.0` 정규화 좌표를 기본으로 한다.

5. 확장 최소화
- 첫 버전은 "양쪽 이미지 배치 + 타이머/텍스트 오버레이 + 정답 표시 + 영상 출력"에 필요한 필드만 둔다.
- 템플릿 시스템, 플러그인 시스템, 원격 협업, 버전 히스토리는 넣지 않는다.

## 권장 저장 구조

```text
project-root/
  project.json
  assets/
    images/
    audio/
    fonts/
  cache/
  exports/
```

- `project.json`: 프로젝트 전체 정의
- `assets/`: 원본 파일 저장
- `cache/`: 썸네일, 프리뷰 프레임 등 재생성 가능한 산출물
- `exports/`: 렌더된 영상 출력물

## 데이터 구조

### 1) Project 레벨

프로젝트 전체 설정과 씬 목록을 담는 루트 객체다.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "proj_train_trip_001",
    "title": "기차역 틀린 그림 찾기",
    "createdAt": "2026-04-19T18:30:00+09:00",
    "updatedAt": "2026-04-19T18:45:00+09:00",
    "baseWidth": 1920,
    "baseHeight": 1080,
    "safeArea": { "x": 96, "y": 54, "width": 1728, "height": 972 },
    "defaultFps": 30,
    "defaultSceneDurationMs": 90000
  },
  "assets": [],
  "scenes": [],
  "output": {}
}
```

필수 필드:
- `schemaVersion`: JSON 스키마 버전
- `project.id`: 내부 식별자
- `baseWidth`, `baseHeight`: 저작 기준 캔버스
- `defaultFps`: 프리뷰/출력 기본 fps

### 2) Asset 레벨

이미지, 오디오, 폰트처럼 씬이 참조하는 파일 정의다.

```json
{
  "id": "img_scene01_left",
  "type": "image",
  "path": "assets/images/scene01_left.png",
  "width": 1024,
  "height": 1024,
  "hash": "sha256-optional",
  "label": "scene01 left"
}
```

초기 버전 권장 타입:
- `image`
- `audio`
- `font`

메모:
- `hash`는 선택이다. 파일 교체 감지만 필요할 때 사용한다.
- DB 대신 파일 경로와 메타데이터만 저장한다.

### 3) Scene 레벨

영상의 한 문제 또는 한 컷을 뜻한다. 각 씬은 좌우 이미지, 지속시간, 마커, 오버레이를 가진다.

```json
{
  "id": "scene_001",
  "title": "STEP 1",
  "durationMs": 90000,
  "layout": {
    "type": "sideBySide",
    "leftImageAssetId": "img_scene01_left",
    "rightImageAssetId": "img_scene01_right",
    "leftRect": { "x": 20, "y": 120, "width": 930, "height": 760 },
    "rightRect": { "x": 970, "y": 120, "width": 930, "height": 760 }
  },
  "answerMarkers": [],
  "timeline": [],
  "overlays": []
}
```

필수 필드:
- `durationMs`
- `layout.leftImageAssetId`
- `layout.rightImageAssetId`
- `layout.leftRect`, `layout.rightRect`

의미:
- 이미지 배치 위치를 씬에 명시해두면 렌더 결과가 항상 동일하다.
- 자동 레이아웃 계산보다 저장된 값 재사용이 더 안전하다.

### 4) Timeline 레벨

씬 내부에서 시간에 따라 켜지고 꺼지는 요소를 정의한다. 첫 버전은 범용 키프레임 엔진 대신 "클립 배열" 정도로 제한한다.

```json
[
  {
    "id": "clip_intro_title",
    "type": "textOverlay",
    "startMs": 0,
    "endMs": 3000,
    "overlayId": "ov_scene_title"
  },
  {
    "id": "clip_countdown",
    "type": "countdownOverlay",
    "startMs": 0,
    "endMs": 90000,
    "overlayId": "ov_countdown_main"
  },
  {
    "id": "clip_reveal_answer1",
    "type": "answerReveal",
    "startMs": 70000,
    "endMs": 73000,
    "markerId": "marker_001"
  }
]
```

규칙:
- 모든 클립은 `startMs`, `endMs`를 갖는다.
- 타입별 참조는 `overlayId` 또는 `markerId` 정도만 허용한다.
- 복잡한 중첩 트랙 시스템은 첫 버전에서 제외한다.

### 5) Answer Marker 레벨

사람이 직접 찍는 정답 데이터다. 가장 중요하다.

초기 권장 포맷:

```json
{
  "id": "marker_001",
  "label": "가방 별 장식",
  "leftRegion": {
    "shape": "circle",
    "cx": 0.1832,
    "cy": 0.7741,
    "r": 0.035
  },
  "rightRegion": {
    "shape": "circle",
    "cx": 0.1810,
    "cy": 0.7738,
    "r": 0.035
  },
  "revealStyle": {
    "strokeColor": "#FFCC00",
    "strokeWidth": 6,
    "pulseMs": 900
  }
}
```

좌표 저장 원칙:
- `cx`, `cy`, `r`는 모두 `0.0 ~ 1.0` 기준 정규화 값이다.
- 기준 좌표계는 각 원본 이미지의 실제 픽셀 크기다.
- `r`은 이미지의 짧은 변을 기준으로 정규화한다.

왜 이 형식인가:
- 사람이 클릭해서 저장하기 쉽다.
- 원형 표시는 틀린 그림 찾기 영상에서 가장 흔하고 구현이 단순하다.
- 좌우 이미지에 미세한 위치 차이가 있을 수 있으므로 `leftRegion`, `rightRegion`을 분리 저장하는 것이 안전하다.

확장 방침:
- 정말 필요할 때만 `shape: "rect"` 또는 `shape: "polygon"`을 추가한다.
- 첫 버전은 `circle`만 지원하는 것이 낫다.

### 6) Overlay 레벨

텍스트, 배너, 스텝 번호, 카운트다운, 정답 강조 효과 같은 화면 요소다.

```json
{
  "id": "ov_countdown_main",
  "type": "countdown",
  "anchor": "topRight",
  "rect": { "x": 1760, "y": 20, "width": 120, "height": 120 },
  "style": {
    "fontSize": 64,
    "fontFamilyAssetId": "font_main",
    "fill": "#FFCC33",
    "stroke": "#2455D6",
    "strokeWidth": 6
  },
  "params": {
    "fromSeconds": 90,
    "displayMode": "integer"
  }
}
```

초기 권장 오버레이 타입:
- `text`
- `countdown`
- `image`
- `answerHighlight`

규칙:
- 실제 on/off 시점은 `timeline`에서 제어한다.
- 오버레이 정의와 시간 배치를 분리하면 수정이 쉽다.

### 7) Output 설정 레벨

출력 파일의 해상도, fps, 코덱, 오디오 포함 여부를 정의한다.

```json
{
  "output": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "videoCodec": "h264",
    "pixelFormat": "yuv420p",
    "audioAssetId": "bgm_main",
    "audioSampleRate": 48000,
    "outputPattern": "exports/{projectId}_{timestamp}.mp4"
  }
}
```

초기 원칙:
- 출력 프리셋은 1~2개만 둔다.
- 렌더 파라미터가 너무 많아지면 저작자가 혼란스러워진다.

## 저작 UI 흐름

### 1. 프로젝트 생성
- 새 프로젝트 생성
- 해상도, fps, 기본 출력 경로 선택
- 프로젝트 폴더와 `project.json` 생성

### 2. 이미지 배치
- 좌측 이미지와 우측 이미지 import
- 기본 `sideBySide` 레이아웃 자동 배치
- 사용자가 각 이미지 rect를 미세 조정 가능

### 3. 정답 위치 지정
- 씬 편집 화면에서 "정답 추가" 클릭
- 왼쪽 이미지 위 클릭 -> `leftRegion` 저장
- 오른쪽 이미지 위 대응 위치 클릭 -> `rightRegion` 저장
- 반지름 슬라이더 또는 드래그로 원 크기 조정
- 마커 라벨 입력

권장 UX:
- 첫 클릭 후 자동으로 오른쪽 이미지 입력 단계로 넘어간다.
- 두 번째 클릭 후 즉시 번호가 붙은 마커 목록에 추가된다.
- 원형만 지원하면 UI와 데이터가 단순해진다.

### 4. 미리보기
- 현재 씬 시간 scrub
- 카운트다운, 텍스트, 정답 표시 타이밍 확인
- 마커 좌표와 반지름 수정

### 5. 출력
- 전체 프로젝트 또는 선택 씬 렌더
- 프레임 드롭 없이 오프라인 렌더
- 출력 결과는 `exports/`에 저장

## JSON 우선 여부

초기 결론:
- JSON 우선이 맞다.

이유:
- 사람이 diff 보기 쉽다.
- Git 없이도 복사/백업/수정이 쉽다.
- 프로젝트 파일을 이메일이나 메신저로 주고받기도 쉽다.
- 로컬 단일 사용자 저작도구에 DB는 과하다.

예외:
- 수백~수천 씬 검색, 다중 사용자 동시 편집, 중앙 에셋 라이브러리가 필요해질 때만 DB를 검토한다.

## DB/서버 필요성 판단

초기 단계 결론:
- 필요 없다.

로컬 파일 기반으로 충분한 이유:
- 입력은 정적 이미지와 저작자가 찍은 좌표다.
- 렌더링은 결정론적 오프라인 처리다.
- 동시 접속자, 권한 관리, 실시간 동기화가 없다.

즉시 제외할 것:
- 서버 API
- 사용자 계정
- 실시간 협업
- 씬 상태 저장용 DB

## 최소 스키마 초안

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "proj_001",
    "title": "Sample",
    "baseWidth": 1920,
    "baseHeight": 1080,
    "defaultFps": 30
  },
  "assets": [
    {
      "id": "img_left_001",
      "type": "image",
      "path": "assets/images/left.png",
      "width": 1024,
      "height": 1024
    },
    {
      "id": "img_right_001",
      "type": "image",
      "path": "assets/images/right.png",
      "width": 1024,
      "height": 1024
    }
  ],
  "scenes": [
    {
      "id": "scene_001",
      "title": "STEP 1",
      "durationMs": 90000,
      "layout": {
        "type": "sideBySide",
        "leftImageAssetId": "img_left_001",
        "rightImageAssetId": "img_right_001",
        "leftRect": { "x": 20, "y": 120, "width": 930, "height": 760 },
        "rightRect": { "x": 970, "y": 120, "width": 930, "height": 760 }
      },
      "answerMarkers": [
        {
          "id": "marker_001",
          "label": "bag-star",
          "leftRegion": { "shape": "circle", "cx": 0.18, "cy": 0.77, "r": 0.035 },
          "rightRegion": { "shape": "circle", "cx": 0.18, "cy": 0.77, "r": 0.035 }
        }
      ],
      "overlays": [
        {
          "id": "ov_countdown",
          "type": "countdown",
          "rect": { "x": 1760, "y": 20, "width": 120, "height": 120 },
          "style": { "fontSize": 64, "fill": "#FFCC33" },
          "params": { "fromSeconds": 90 }
        }
      ],
      "timeline": [
        {
          "id": "clip_countdown",
          "type": "countdownOverlay",
          "startMs": 0,
          "endMs": 90000,
          "overlayId": "ov_countdown"
        },
        {
          "id": "clip_reveal_001",
          "type": "answerReveal",
          "startMs": 70000,
          "endMs": 73000,
          "markerId": "marker_001"
        }
      ]
    }
  ],
  "output": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "videoCodec": "h264",
    "outputPattern": "exports/{projectId}_{timestamp}.mp4"
  }
}
```

## 최종 제안

- 첫 구현은 "단일 로컬 프로젝트 파일 + side-by-side 씬 + 원형 정답 마커 + 단순 클립 타임라인 + mp4 출력"까지만 잡는 것이 맞다.
- 사람 손으로 찍은 마커 좌표를 정규화 값으로 저장하면 수정과 재현이 쉽다.
- 씬 내부 시간 제어는 복잡한 엔진 대신 `timeline[]` 배열만으로 충분하다.
- DB/서버/복잡한 플러그인 구조는 확실히 불필요하다.

