# 🙏 기도수첩 (Prayer Diary)

기도제목을 적고, 응답되면 체크하고, 모아서 확인하는 심플한 웹앱입니다.

- **클라우드 동기화** — Firebase(Firestore)로 여러 기기에서 같은 데이터 사용
- **Google 로그인** — 비밀번호 없이 간편하게
- **자동 배포** — `main` 브랜치에 push하면 GitHub Actions가 GitHub Pages로 자동 배포
- 응답됨 표시 · 카테고리/태그 · 날짜 기록 · 실시간 동기화
- **카테고리 관리** — 기본 카테고리 제공, 추가/이름변경/삭제, 드래그(마우스·터치)로 순서 변경
- **다크 모드** — 헤더 토글로 전환, 기기에 선택 저장(미선택 시 시스템 설정 따름)
- **휴지통** — 삭제 시 휴지통으로 이동(소프트 삭제), 복원·완전삭제·비우기 가능

---

## 화면 구성

- **로그인 화면**: "Google로 시작하기" 버튼
- **메인 화면**: 기도제목 입력 → 목록 카드 → 동그라미 체크로 "응답됨" 표시
- **필터**: `전체 / 기도중 / 응답됨` 탭 + 카테고리 칩

---

## 처음 한 번만: Firebase 설정

### 1. Firebase 프로젝트 만들기
1. [Firebase 콘솔](https://console.firebase.google.com/)에서 **프로젝트 추가**.
2. 프로젝트 안에서 **웹 앱(`</>`)** 등록 → 표시되는 `firebaseConfig` 값(apiKey 등)을 복사해 둡니다.

### 2. Google 로그인 켜기
- **Authentication → Sign-in method → Google** 사용 설정.

### 3. 승인된 도메인 추가 (중요)
- **Authentication → Settings → 승인된 도메인(Authorized domains)** 에
  배포 도메인 **`csy870617.github.io`** 를 추가합니다.
  (이게 없으면 배포된 사이트에서 Google 로그인 팝업이 차단됩니다. 로컬은 `localhost`가 기본 포함.)

### 4. Firestore 만들기 + 보안 규칙 적용
1. **Firestore Database → 데이터베이스 만들기** (프로덕션 모드로 시작).
2. **규칙(Rules)** 탭에 이 저장소의 [`firestore.rules`](./firestore.rules) 내용을 붙여넣고 **게시**.

---

## 자동 배포 설정 (GitHub Pages)

### 1. Pages 소스 지정
- 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 설정.

### 2. Firebase 설정값
- 이 저장소에는 [`config.js`](./config.js)에 Firebase 웹 설정이 **이미 포함**되어 있어
  추가 설정 없이 바로 배포됩니다.
- 설정을 바꾸고 싶으면 `config.js`를 수정하거나, 아래 **선택 사항**처럼 저장소 Variables로 덮어쓸 수 있습니다.

  <details><summary>선택: 저장소 Variables로 관리하기</summary>

  **Settings → Secrets and variables → Actions → Variables** 탭에서 아래 6개를
  **New repository variable** 로 추가하면, 배포 시 워크플로우가 `config.js`를 이 값으로 덮어씁니다.

  | 변수 이름 | 예시 값 |
  |---|---|
  | `FIREBASE_API_KEY` | `AIza...` |
  | `FIREBASE_AUTH_DOMAIN` | `myapp.firebaseapp.com` |
  | `FIREBASE_PROJECT_ID` | `myapp` |
  | `FIREBASE_STORAGE_BUCKET` | `myapp.appspot.com` |
  | `FIREBASE_MESSAGING_SENDER_ID` | `1234567890` |
  | `FIREBASE_APP_ID` | `1:1234567890:web:abcdef` |

  > 이 값들은 비밀이 아니라 공개돼도 안전한 식별자입니다. 보안은 `firestore.rules`와 승인된 도메인이 담당합니다.
  </details>

### 3. 배포
- `main` 브랜치에 push 하면 워크플로우([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml))가
  `config.js`를 생성하고 사이트를 배포합니다.
- 배포 후 주소: **https://csy870617.github.io/prayerdiary/**
- Actions 탭의 **Deploy to GitHub Pages** 워크플로우를 수동 실행(`Run workflow`)할 수도 있습니다.

---

## 로컬에서 실행해보기

```bash
# config.js 가 이미 포함되어 있으므로 바로 실행하면 됩니다.
python3 -m http.server 8000

# 브라우저에서 http://localhost:8000 접속
```

> 로컬에서 Google 로그인을 쓰려면 Firebase의 승인된 도메인에 `localhost`가 포함돼 있어야 합니다(기본 포함).
> 다른 Firebase 프로젝트로 바꾸려면 `config.js` 값을 교체하세요. (`config.example.js`는 형식 참고용)

---

## 데이터 구조 (Firestore)

```
users/{uid}/prayers/{prayerId}
  title:       string   기도제목
  category:    string   카테고리/태그
  answered:    boolean  응답 여부
  answeredAt:  timestamp|null  응답 체크한 날짜
  createdAt:   timestamp  작성일
  updatedAt:   timestamp
```

각 사용자는 자신의 데이터(`users/{본인 uid}`)에만 접근할 수 있습니다.

---

## 기술 스택

- 프론트엔드: 순수 HTML / CSS / JavaScript (빌드 도구 없음)
- Firebase JS SDK v10 (CDN ESM import)
- Firebase Authentication (Google) + Cloud Firestore
- GitHub Actions + GitHub Pages
