// 기도수첩 — Firebase Auth(Google) + Firestore 기반 기도제목 관리
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const loadingEl = $("loading");
const loginView = $("login-view");
const appView = $("app-view");
const configWarning = $("config-warning");
const loginError = $("login-error");

// ---- Firebase 설정 확인 ----
const cfg = window.__FIREBASE_CONFIG__;
const isConfigured = cfg && cfg.apiKey && !String(cfg.apiKey).includes("YOUR_");

if (!isConfigured) {
  loadingEl.hidden = true;
  configWarning.hidden = false;
} else {
  start();
}

function start() {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  let unsubscribeSnapshot = null;
  let prayers = []; // 캐시
  let statusFilter = "all"; // all | active | answered
  let categoryFilter = null; // null = 전체

  // ---- 인증 ----
  $("google-signin").addEventListener("click", async () => {
    loginError.hidden = true;
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
      loginError.textContent = loginErrorMessage(err);
      loginError.hidden = false;
    }
  });

  $("signout").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, (user) => {
    loadingEl.hidden = true;
    if (user) {
      showApp(user);
      subscribe(user.uid);
    } else {
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      prayers = [];
      loginView.hidden = false;
      appView.hidden = true;
    }
  });

  function showApp(user) {
    loginView.hidden = true;
    appView.hidden = false;
    $("user-name").textContent = user.displayName || "";
    const photo = $("user-photo");
    if (user.photoURL) photo.src = user.photoURL; else photo.removeAttribute("src");
  }

  // ---- Firestore 구독 ----
  function userPrayers(uid) {
    return collection(db, "users", uid, "prayers");
  }

  function subscribe(uid) {
    const q = query(userPrayers(uid), orderBy("createdAt", "desc"));
    unsubscribeSnapshot = onSnapshot(
      q,
      (snap) => {
        prayers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      },
      (err) => console.error("구독 오류:", err)
    );
  }

  // ---- CRUD ----
  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleEl = $("title-input");
    const catEl = $("category-input");
    const title = titleEl.value.trim();
    if (!title) return;
    const category = catEl.value.trim();
    titleEl.value = "";
    catEl.value = "";
    const uid = auth.currentUser.uid;
    try {
      await addDoc(userPrayers(uid), {
        title,
        category,
        answered: false,
        answeredAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error(err);
      alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  });

  async function toggleAnswered(p) {
    const uid = auth.currentUser.uid;
    const next = !p.answered;
    await updateDoc(doc(db, "users", uid, "prayers", p.id), {
      answered: next,
      answeredAt: next ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    });
  }

  async function saveEdit(p, newTitle, newCategory) {
    const uid = auth.currentUser.uid;
    await updateDoc(doc(db, "users", uid, "prayers", p.id), {
      title: newTitle,
      category: newCategory,
      updatedAt: serverTimestamp(),
    });
  }

  async function removePrayer(p) {
    if (!confirm("이 기도제목을 삭제할까요?")) return;
    const uid = auth.currentUser.uid;
    await deleteDoc(doc(db, "users", uid, "prayers", p.id));
  }

  // ---- 필터 UI ----
  $("status-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    statusFilter = btn.dataset.status;
    document.querySelectorAll("#status-tabs .tab").forEach((t) =>
      t.classList.toggle("active", t === btn)
    );
    render();
  });

  // ---- 렌더링 ----
  function render() {
    updateCounts();
    renderCategoryChips();
    renderDatalist();
    renderList();
  }

  function updateCounts() {
    const all = prayers.length;
    const answered = prayers.filter((p) => p.answered).length;
    setCount("all", all);
    setCount("active", all - answered);
    setCount("answered", answered);
  }
  function setCount(key, n) {
    const el = document.querySelector(`.count[data-count="${key}"]`);
    if (el) el.textContent = n;
  }

  function categories() {
    const set = new Set();
    prayers.forEach((p) => { if (p.category) set.add(p.category); });
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }

  function renderCategoryChips() {
    const wrap = $("category-chips");
    const cats = categories();
    if (cats.length === 0) {
      wrap.innerHTML = "";
      categoryFilter = null;
      return;
    }
    if (categoryFilter && !cats.includes(categoryFilter)) categoryFilter = null;
    wrap.innerHTML = "";
    const allChip = chip("전체", categoryFilter === null);
    allChip.addEventListener("click", () => { categoryFilter = null; render(); });
    wrap.appendChild(allChip);
    cats.forEach((c) => {
      const el = chip(c, categoryFilter === c);
      el.addEventListener("click", () => {
        categoryFilter = categoryFilter === c ? null : c;
        render();
      });
      wrap.appendChild(el);
    });
  }
  function chip(label, active) {
    const b = document.createElement("button");
    b.className = "cat-chip" + (active ? " active" : "");
    b.textContent = label;
    return b;
  }

  function renderDatalist() {
    const list = $("category-list");
    list.innerHTML = "";
    categories().forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      list.appendChild(opt);
    });
  }

  function visiblePrayers() {
    return prayers.filter((p) => {
      if (statusFilter === "active" && p.answered) return false;
      if (statusFilter === "answered" && !p.answered) return false;
      if (categoryFilter && p.category !== categoryFilter) return false;
      return true;
    });
  }

  function renderList() {
    const listEl = $("prayer-list");
    const emptyEl = $("empty-state");
    const items = visiblePrayers();
    listEl.innerHTML = "";
    if (items.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    items.forEach((p) => listEl.appendChild(card(p)));
  }

  function card(p) {
    const el = document.createElement("div");
    el.className = "prayer-card" + (p.answered ? " is-answered" : "");

    // 체크
    const check = document.createElement("button");
    check.className = "check" + (p.answered ? " checked" : "");
    check.title = p.answered ? "응답 취소" : "응답됨으로 표시";
    check.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    check.addEventListener("click", () => toggleAnswered(p));

    // 본문
    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.title;
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "card-meta";
    if (p.category) {
      const cat = document.createElement("span");
      cat.className = "meta-cat";
      cat.textContent = p.category;
      meta.appendChild(cat);
    }
    const date = document.createElement("span");
    date.className = "meta-date";
    date.textContent = fmtDate(p.createdAt) + " 작성";
    meta.appendChild(date);
    if (p.answered && p.answeredAt) {
      const badge = document.createElement("span");
      badge.className = "meta-badge";
      badge.textContent = "응답됨 🙏 " + fmtDate(p.answeredAt);
      meta.appendChild(badge);
    }
    body.appendChild(meta);

    // 액션
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.title = "수정";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => enterEdit(el, p));
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn del";
    delBtn.title = "삭제";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", () => removePrayer(p));
    actions.append(editBtn, delBtn);

    el.append(check, body, actions);
    return el;
  }

  function enterEdit(cardEl, p) {
    cardEl.innerHTML = "";
    cardEl.classList.remove("is-answered");
    const area = document.createElement("div");
    area.className = "edit-area";

    const ta = document.createElement("textarea");
    ta.className = "edit-title";
    ta.value = p.title;

    const controls = document.createElement("div");
    controls.className = "edit-controls";
    const catInput = document.createElement("input");
    catInput.className = "edit-cat";
    catInput.type = "text";
    catInput.placeholder = "카테고리";
    catInput.value = p.category || "";
    catInput.setAttribute("list", "category-list");

    const save = document.createElement("button");
    save.className = "edit-save";
    save.textContent = "저장";
    save.addEventListener("click", async () => {
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      save.disabled = true;
      await saveEdit(p, t, catInput.value.trim());
      // onSnapshot 이 다시 렌더링함
    });

    const cancel = document.createElement("button");
    cancel.className = "edit-cancel";
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => render());

    controls.append(catInput, save, cancel);
    area.append(ta, controls);
    cardEl.appendChild(area);
    ta.focus();
  }

  // ---- 유틸 ----
  function fmtDate(ts) {
    if (!ts) return "방금";
    const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}.${m}.${day}`;
  }

  function loginErrorMessage(err) {
    const code = err && err.code ? err.code : "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request")
      return "로그인이 취소되었습니다.";
    if (code === "auth/unauthorized-domain")
      return "이 도메인은 Firebase 승인 도메인에 등록되어 있지 않습니다. (README 참고)";
    if (code === "auth/popup-blocked")
      return "팝업이 차단되었습니다. 팝업을 허용한 뒤 다시 시도해주세요.";
    return "로그인에 실패했습니다. 잠시 후 다시 시도해주세요.";
  }
}
