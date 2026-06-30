// Firebase 웹 설정 예시 파일.
// 이 파일을 복사해 같은 폴더에 `config.js`로 저장한 뒤, Firebase 콘솔에서
// 발급받은 값으로 채워 로컬 테스트에 사용하세요.
//
// (배포 시에는 GitHub Actions 워크플로우가 저장소 Variables 값으로 config.js를
//  자동 생성하므로, 아래 값들을 저장소에 커밋할 필요는 없습니다.)
//
// 이 값들은 비밀이 아니며 클라이언트에 노출돼도 안전합니다.
// 실제 보안은 Firestore 보안 규칙(firestore.rules)으로 강제됩니다.

window.__FIREBASE_CONFIG__ = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
