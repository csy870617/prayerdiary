// 기도수첩 — Firebase Auth(Google) + Firestore 기반 기도제목/카테고리 관리
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
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
  setDoc,
  doc,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const loadingEl = $("loading");
const loginView = $("login-view");
const appView = $("app-view");
const configWarning = $("config-warning");
const loginError = $("login-error");

// 새 사용자에게 만들어줄 기본 카테고리
const DEFAULT_CATEGORIES = ["가족", "교회", "개인", "감사"];

// ---- 테마(다크/라이트) ----
// 초기 테마는 <head> 인라인 스크립트가 이미 적용(저장값 → 시스템 설정 순).
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#15161c" : "#6b73c4");
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    const label = theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  });
}
function setupTheme() {
  applyTheme(currentTheme());
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      try { localStorage.setItem("prayerdiary-theme", next); } catch (_) {}
      applyTheme(next);
    });
  });
}
setupTheme();

// ---- Firebase 설정 확인 ----
const cfg = window.__FIREBASE_CONFIG__;
const isConfigured = cfg && cfg.apiKey && !String(cfg.apiKey).includes("YOUR_");

if (!isConfigured) {
  loadingEl.hidden = true;
  configWarning.hidden = false;
} else {
  start();
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function start() {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  let unsubscribePrayers = null;
  let unsubscribeCategories = null;
  let prayers = []; // 기도제목 캐시
  let categories = []; // [{ id, name }] 순서대로
  let statusFilter = "all"; // all | active | answered
  let categoryFilter = null; // null = 전체
  let searchQuery = ""; // 소문자·trim 된 검색어
  let catModalOpen = false;
  let trashModalOpen = false;
  let defaultsRequested = false; // 기본 카테고리 중복 생성 방지
  let editingId = null; // 편집 중인 기도제목 id
  let editDraft = null; // 편집 중 입력 보존 { title, content, category }

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

  // ---- FAITHS 통합 로그인(수신) ----
  // FAITHS(https://csy870617.github.io/faiths/) 앱 내부 브라우저(iframe)로 열린 경우,
  // 부모 창이 보내주는 Google ID 토큰으로 자동 로그인해 자체 로그인 화면을 건너뛴다.
  (function setupFaithsSso() {
    const FAITHS_ORIGIN = "https://csy870617.github.io";
    if (window.parent === window) return; // iframe이 아니면 아무것도 하지 않음
    onAuthStateChanged(auth, (user) => {
      if (user) return; // 이미 로그인돼 있으면 건너뜀
      function onMsg(e) {
        if (e.origin !== FAITHS_ORIGIN) return;
        if (!e.data || e.data.type !== "faiths-google-idtoken" || !e.data.idToken) return;
        window.removeEventListener("message", onMsg);
        const cred = GoogleAuthProvider.credential(e.data.idToken);
        signInWithCredential(auth, cred).catch((err) => {
          console.log("FAITHS SSO 실패:", err && err.code);
        });
      }
      window.addEventListener("message", onMsg);
      window.parent.postMessage({ type: "faiths-request-idtoken" }, FAITHS_ORIGIN);
    });
  })();

  function stopSubscriptions() {
    if (unsubscribePrayers) { unsubscribePrayers(); unsubscribePrayers = null; }
    if (unsubscribeCategories) { unsubscribeCategories(); unsubscribeCategories = null; }
  }

  onAuthStateChanged(auth, (user) => {
    loadingEl.hidden = true;
    stopSubscriptions(); // 재구독 전 기존 구독 해제(중복/누수 방지)
    editingId = null;
    editDraft = null;
    if (user) {
      showApp(user);
      subscribePrayers(user.uid);
      subscribeCategories(user.uid);
    } else {
      prayers = [];
      categories = [];
      defaultsRequested = false;
      searchQuery = "";
      $("search-input").value = "";
      $("search-clear").hidden = true;
      closeCatModal();
      closeTrashModal();
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

  // ---- Firestore 참조 ----
  const uid = () => auth.currentUser.uid;
  const prayersCol = (id) => collection(db, "users", id, "prayers");
  const prayerDoc = (id) => doc(db, "users", uid(), "prayers", id);
  const categoriesDoc = (id) => doc(db, "users", id, "meta", "categories");

  // ---- 구독 ----
  function subscribePrayers(id) {
    const q = query(prayersCol(id), orderBy("createdAt", "desc"));
    unsubscribePrayers = onSnapshot(
      q,
      (snap) => {
        prayers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      },
      (err) => console.error("기도제목 구독 오류:", err)
    );
  }

  function subscribeCategories(id) {
    unsubscribeCategories = onSnapshot(
      categoriesDoc(id),
      async (snap) => {
        if (!snap.exists()) {
          // 최초 로그인: 기본 카테고리 생성
          if (!defaultsRequested) {
            defaultsRequested = true;
            try {
              await setDoc(categoriesDoc(id), {
                items: DEFAULT_CATEGORIES.map((name) => ({ id: newId(), name })),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            } catch (e) { console.error("기본 카테고리 생성 실패:", e); }
          }
          return;
        }
        categories = Array.isArray(snap.data().items) ? snap.data().items : [];
        render();
        // 카테고리 이름을 입력하는 중이면 재렌더를 보류해 입력 텍스트/포커스 보존
        const editingCatName =
          document.activeElement &&
          document.activeElement.classList.contains("cat-name-input");
        if (catModalOpen && !editingCatName) renderCategoryManager();
      },
      (err) => console.error("카테고리 구독 오류:", err)
    );
  }

  async function saveCategories(items) {
    await setDoc(categoriesDoc(uid()), { items, updatedAt: serverTimestamp() }, { merge: true });
  }

  // ---- 기도제목 CRUD ----
  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleEl = $("title-input");
    const contentEl = $("content-input");
    const title = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; }
    const content = contentEl.value.trim();
    const category = $("category-select").value; // 관리 카테고리 중에서 선택
    try {
      await addDoc(prayersCol(uid()), {
        title,
        content,
        category,
        answered: false,
        answeredAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      // 저장 성공 후에만 입력칸을 비움(실패 시 입력 내용 보존)
      titleEl.value = "";
      contentEl.value = "";
    } catch (err) {
      console.error(err);
      alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  });

  // 내용은 여러 줄 입력: Enter 는 줄바꿈, Ctrl/⌘+Enter 로 추가
  $("content-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      $("add-form").requestSubmit();
    }
  });

  async function toggleAnswered(p) {
    const next = !p.answered;
    try {
      await updateDoc(prayerDoc(p.id), {
        answered: next,
        answeredAt: next ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("응답 상태 변경 실패:", e);
      alert("변경에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function saveEdit(p, newTitle, newContent, newCategory) {
    await updateDoc(prayerDoc(p.id), {
      title: newTitle,
      content: newContent,
      category: newCategory,
      updatedAt: serverTimestamp(),
    });
  }

  // 삭제 = 휴지통으로 이동(소프트 삭제). 되돌릴 수 있으므로 확인창 없이 처리.
  async function removePrayer(p) {
    try {
      await updateDoc(prayerDoc(p.id), {
        deleted: true,
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("휴지통 이동 실패:", e);
      alert("삭제에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function restorePrayer(p) {
    try {
      await updateDoc(prayerDoc(p.id), {
        deleted: false,
        deletedAt: null,
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("복원 실패:", e);
      alert("복원에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function permanentDeletePrayer(p) {
    if (!confirm("완전히 삭제할까요?\n삭제하면 복구할 수 없습니다.")) return;
    try {
      await deleteDoc(prayerDoc(p.id));
    } catch (e) {
      console.error("완전 삭제 실패:", e);
      alert("삭제에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function emptyTrash() {
    const items = trashedPrayers();
    if (items.length === 0) return;
    if (!confirm(`휴지통의 ${items.length}개를 완전히 삭제할까요?\n삭제하면 복구할 수 없습니다.`)) return;
    try {
      const batch = writeBatch(db);
      items.forEach((p) => batch.delete(prayerDoc(p.id)));
      await batch.commit();
    } catch (e) {
      console.error("휴지통 비우기 실패:", e);
      alert("휴지통 비우기에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  // ---- 카테고리 CRUD ----
  function hasCategory(name) {
    const n = name.trim().toLowerCase();
    return categories.some((c) => c.name.toLowerCase() === n);
  }

  async function addCategory(name) {
    name = name.trim();
    if (!name) return;
    if (hasCategory(name)) { alert("이미 있는 카테고리예요."); return; }
    try {
      await saveCategories([...categories, { id: newId(), name }]);
    } catch (e) {
      console.error("카테고리 추가 실패:", e);
      alert("카테고리 추가에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function renameCategory(id, newName) {
    newName = newName.trim();
    const cat = categories.find((c) => c.id === id);
    if (!cat) return false;
    if (!newName) return false;
    if (newName === cat.name) return true;
    if (categories.some((c) => c.id !== id && c.name.toLowerCase() === newName.toLowerCase())) {
      alert("이미 있는 카테고리예요.");
      return false;
    }
    const oldName = cat.name;
    const items = categories.map((c) => (c.id === id ? { ...c, name: newName } : c));
    try {
      const batch = writeBatch(db);
      batch.set(categoriesDoc(uid()), { items, updatedAt: serverTimestamp() }, { merge: true });
      // 기존 기도제목의 카테고리 이름도 함께 갱신
      prayers
        .filter((p) => p.category === oldName)
        .forEach((p) => batch.update(prayerDoc(p.id), { category: newName, updatedAt: serverTimestamp() }));
      await batch.commit();
      return true;
    } catch (e) {
      console.error("카테고리 이름 변경 실패:", e);
      return false;
    }
  }

  async function deleteCategory(id) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    if (!confirm(`'${cat.name}' 카테고리를 삭제할까요?\n(이 카테고리로 적은 기도제목은 그대로 남습니다)`)) return;
    try {
      await saveCategories(categories.filter((c) => c.id !== id));
    } catch (e) {
      console.error("카테고리 삭제 실패:", e);
      alert("카테고리 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  async function reorderCategories(idOrder) {
    const map = new Map(categories.map((c) => [c.id, c]));
    const items = idOrder.map((id) => map.get(id)).filter(Boolean);
    if (items.length !== categories.length) { renderCategoryManager(); return; } // 안전장치
    // 순서가 그대로면 저장 생략
    if (items.every((c, i) => c.id === categories[i].id)) return;
    try {
      await saveCategories(items);
    } catch (e) {
      console.error("카테고리 순서 저장 실패:", e);
      alert("순서 변경 저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
      renderCategoryManager(); // 저장된 순서로 되돌림
    }
  }

  // ---- 검색 ----
  $("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    $("search-clear").hidden = e.target.value.length === 0;
    renderList(); // 목록만 갱신(검색 입력 포커스 유지)
  });
  $("search-clear").addEventListener("click", () => {
    const inp = $("search-input");
    inp.value = "";
    searchQuery = "";
    $("search-clear").hidden = true;
    inp.focus();
    renderList();
  });

  // ---- 필터 ----
  $("status-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    statusFilter = btn.dataset.status;
    document.querySelectorAll("#status-tabs .tab").forEach((t) =>
      t.classList.toggle("active", t === btn)
    );
    render();
  });

  // ---- 카테고리 관리 모달 ----
  $("manage-cats").addEventListener("click", openCatModal);
  $("cat-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeCatModal();
  });
  $("cat-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("cat-add-input");
    addCategory(input.value);
    input.value = "";
    input.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (catModalOpen) closeCatModal();
    if (trashModalOpen) closeTrashModal();
  });

  function openCatModal() {
    catModalOpen = true;
    $("cat-modal").hidden = false;
    renderCategoryManager();
  }
  function closeCatModal() {
    catModalOpen = false;
    const m = $("cat-modal");
    if (m) m.hidden = true;
  }

  // ---- 휴지통 모달 ----
  $("open-trash").addEventListener("click", openTrashModal);
  $("trash-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeTrashModal();
  });
  $("empty-trash").addEventListener("click", emptyTrash);

  function openTrashModal() {
    trashModalOpen = true;
    $("trash-modal").hidden = false;
    renderTrash();
  }
  function closeTrashModal() {
    trashModalOpen = false;
    const m = $("trash-modal");
    if (m) m.hidden = true;
  }

  // ---- 렌더링 ----
  function render() {
    captureEditDraft(); // 다시 그리기 전에 편집 중 입력 보존
    updateCounts();
    renderCategoryChips();
    renderCategorySelect();
    renderList();
    renderTrashButton();
    if (trashModalOpen) renderTrash();
  }

  // 편집 중인 카드의 현재 입력값을 editDraft 에 저장(외부 변경으로 재렌더돼도 유지)
  function captureEditDraft() {
    if (!editingId) return;
    const area = $("prayer-list").querySelector(".edit-area");
    if (!area) return;
    const t = area.querySelector(".edit-title-input");
    const c = area.querySelector(".edit-content");
    const cat = area.querySelector(".edit-cat");
    if (t && c && cat) editDraft = { title: t.value, content: c.value, category: cat.value };
  }

  function updateCounts() {
    const active = prayers.filter((p) => !p.deleted); // 휴지통 제외
    const all = active.length;
    const answered = active.filter((p) => p.answered).length;
    setCount("all", all);
    setCount("active", all - answered);
    setCount("answered", answered);
  }
  function setCount(key, n) {
    const el = document.querySelector(`.count[data-count="${key}"]`);
    if (el) el.textContent = n;
  }

  // 관리 카테고리 순서 + (목록에 없지만 기도제목에 쓰인) 추가 카테고리
  function orderedCategoryNames() {
    const names = categories.map((c) => c.name);
    const seen = new Set(names.map((n) => n));
    prayers.forEach((p) => {
      if (p.category && !seen.has(p.category)) { seen.add(p.category); names.push(p.category); }
    });
    return names;
  }

  function renderCategoryChips() {
    const wrap = $("category-chips");
    const names = orderedCategoryNames();
    if (categoryFilter && !names.includes(categoryFilter)) categoryFilter = null;
    wrap.innerHTML = "";
    if (names.length === 0) return;
    const allChip = chip("전체", categoryFilter === null);
    allChip.addEventListener("click", () => { categoryFilter = null; render(); });
    wrap.appendChild(allChip);
    names.forEach((c) => {
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
    b.type = "button";
    return b;
  }

  // 입력 폼의 카테고리 선택 드롭다운 채우기 (관리 카테고리만 선택 가능)
  function renderCategorySelect() {
    const sel = $("category-select");
    const prev = sel.value;
    fillCategoryOptions(sel, prev);
  }

  // <select> 를 "카테고리 없음" + 관리 카테고리로 채움.
  // current 값이 관리 목록에 없으면(삭제된 카테고리 등) 보존용 옵션을 추가.
  function fillCategoryOptions(sel, current) {
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "카테고리";
    sel.appendChild(none);
    categories.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.name;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    if (current && !categories.some((c) => c.name === current)) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current + " (삭제됨)";
      sel.appendChild(o);
    }
    sel.value = current || "";
  }

  function visiblePrayers() {
    return prayers.filter((p) => {
      if (p.deleted) return false; // 휴지통 항목은 메인 목록에서 제외
      if (p.id === editingId) return true; // 편집 중인 카드는 필터/검색과 무관하게 표시
      if (statusFilter === "active" && p.answered) return false;
      if (statusFilter === "answered" && !p.answered) return false;
      if (categoryFilter && p.category !== categoryFilter) return false;
      if (searchQuery) {
        const hay = `${p.title || ""} ${p.content || ""} ${p.category || ""}`.toLowerCase();
        if (!hay.includes(searchQuery)) return false;
      }
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
      const hasAny = prayers.some((p) => !p.deleted);
      const et = emptyEl.querySelector(".empty-text");
      if (et) {
        if (hasAny) {
          // 기도제목은 있으나 검색/필터에 맞는 게 없음
          et.textContent = "조건에 맞는 기도제목이 없어요.";
        } else {
          et.innerHTML = "아직 기도제목이 없어요.<br />첫 기도제목을 적어보세요.";
        }
      }
      return;
    }
    emptyEl.hidden = true;
    items.forEach((p) =>
      listEl.appendChild(p.id === editingId ? buildEditCard(p) : card(p))
    );
  }

  // ---- 휴지통 ----
  function trashedPrayers() {
    return prayers
      .filter((p) => p.deleted)
      .sort((a, b) => (b.deletedAt?.seconds || 0) - (a.deletedAt?.seconds || 0));
  }

  function renderTrashButton() {
    const badge = $("trash-count");
    if (!badge) return;
    const n = trashedPrayers().length;
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  function renderTrash() {
    const listEl = $("trash-list");
    const emptyEl = $("trash-empty");
    const foot = $("trash-foot");
    const items = trashedPrayers();
    listEl.innerHTML = "";
    if (items.length === 0) {
      emptyEl.hidden = false;
      foot.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    foot.hidden = false;
    items.forEach((p) => listEl.appendChild(trashRow(p)));
  }

  function trashRow(p) {
    const row = document.createElement("div");
    row.className = "trash-row";

    const body = document.createElement("div");
    body.className = "trash-body";
    const title = document.createElement("div");
    title.className = "trash-title";
    title.textContent = p.title || "(제목 없음)";
    const date = document.createElement("div");
    date.className = "trash-date";
    date.textContent = fmtDate(p.deletedAt) + " 삭제" + (p.category ? " · " + p.category : "");
    body.append(title, date);

    const actions = document.createElement("div");
    actions.className = "trash-actions";
    const restore = document.createElement("button");
    restore.className = "trash-restore";
    restore.type = "button";
    restore.textContent = "복원";
    restore.addEventListener("click", () => restorePrayer(p));
    const del = document.createElement("button");
    del.className = "icon-btn del";
    del.type = "button";
    del.title = "완전 삭제";
    del.textContent = "🗑";
    del.addEventListener("click", () => permanentDeletePrayer(p));
    actions.append(restore, del);

    row.append(body, actions);
    return row;
  }

  function card(p) {
    const el = document.createElement("div");
    el.className = "prayer-card" + (p.answered ? " is-answered" : "");

    const check = document.createElement("button");
    check.className = "check" + (p.answered ? " checked" : "");
    check.type = "button";
    check.title = p.answered ? "응답 취소" : "응답됨으로 표시";
    check.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    check.addEventListener("click", () => toggleAnswered(p));

    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.title;
    body.appendChild(title);

    if (p.content) {
      const content = document.createElement("div");
      content.className = "card-content";
      content.textContent = p.content;
      body.appendChild(content);
    }

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

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.type = "button";
    editBtn.title = "수정";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => enterEdit(p));
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn del";
    delBtn.type = "button";
    delBtn.title = "삭제";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", () => removePrayer(p));
    actions.append(editBtn, delBtn);

    el.append(check, body, actions);
    return el;
  }

  // 편집 모드 진입: 상태만 바꾸고 render() 가 해당 카드를 편집 카드로 그림
  function enterEdit(p) {
    editingId = p.id;
    editDraft = null;
    render();
    const input = $("prayer-list").querySelector(".edit-title-input");
    if (input) {
      input.focus();
      const v = input.value;
      input.value = "";
      input.value = v; // 커서를 끝으로 이동
    }
  }

  function exitEdit() {
    editingId = null;
    editDraft = null;
    render();
  }

  // 편집 카드 DOM 생성(편집 중 입력은 editDraft 로 보존)
  function buildEditCard(p) {
    const cardEl = document.createElement("div");
    cardEl.className = "prayer-card";
    const area = document.createElement("div");
    area.className = "edit-area";

    const seed =
      editingId === p.id && editDraft
        ? editDraft
        : { title: p.title || "", content: p.content || "", category: p.category || "" };

    const titleInput = document.createElement("input");
    titleInput.className = "edit-title-input";
    titleInput.type = "text";
    titleInput.maxLength = 100;
    titleInput.placeholder = "제목";
    titleInput.value = seed.title;

    const ta = document.createElement("textarea");
    ta.className = "edit-content";
    ta.placeholder = "기도 내용을 입력하세요";
    ta.value = seed.content;

    const controls = document.createElement("div");
    controls.className = "edit-controls";
    const catSelect = document.createElement("select");
    catSelect.className = "edit-cat";
    fillCategoryOptions(catSelect, seed.category);

    const save = document.createElement("button");
    save.className = "edit-save";
    save.type = "button";
    save.textContent = "저장";
    save.addEventListener("click", async () => {
      const t = titleInput.value.trim();
      if (!t) { titleInput.focus(); return; }
      save.disabled = true;
      try {
        await saveEdit(p, t, ta.value.trim(), catSelect.value);
        exitEdit();
      } catch (e) {
        console.error("수정 저장 실패:", e);
        alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
        save.disabled = false;
      }
    });

    const cancel = document.createElement("button");
    cancel.className = "edit-cancel";
    cancel.type = "button";
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => exitEdit());

    controls.append(catSelect, save, cancel);
    area.append(titleInput, ta, controls);
    cardEl.appendChild(area);
    return cardEl;
  }

  // ---- 카테고리 관리 목록 렌더 + 드래그 정렬 ----
  function renderCategoryManager() {
    const ul = $("cat-list");
    ul.innerHTML = "";
    if (categories.length === 0) {
      const li = document.createElement("li");
      li.className = "cat-empty";
      li.textContent = "카테고리가 없습니다. 아래에서 추가해보세요.";
      ul.appendChild(li);
      return;
    }
    categories.forEach((c) => ul.appendChild(catManageRow(c)));
    attachSortable(ul, reorderCategories);
  }

  function catManageRow(c) {
    const li = document.createElement("li");
    li.className = "cat-row";
    li.dataset.id = c.id;

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.title = "드래그하여 순서 변경";
    handle.textContent = "≡";

    const input = document.createElement("input");
    input.className = "cat-name-input";
    input.type = "text";
    input.value = c.name;
    input.maxLength = 20;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });
    input.addEventListener("change", async () => {
      const ok = await renameCategory(c.id, input.value);
      if (!ok) input.value = c.name;
    });

    const del = document.createElement("button");
    del.className = "icon-btn del cat-del";
    del.type = "button";
    del.title = "삭제";
    del.textContent = "🗑";
    del.addEventListener("click", () => deleteCategory(c.id));

    li.append(handle, input, del);
    return li;
  }

  // 포인터 기반 드래그 정렬 (마우스/터치 공통)
  function attachSortable(listEl, onDrop) {
    listEl.querySelectorAll(".cat-row").forEach((row) => {
      const handle = row.querySelector(".drag-handle");
      if (!handle) return;
      handle.style.touchAction = "none";
      handle.addEventListener("pointerdown", (e) => startDrag(e, row, handle));
    });

    function startDrag(e, row, handle) {
      e.preventDefault();
      const pointerId = e.pointerId;
      row.classList.add("dragging");
      try { handle.setPointerCapture(pointerId); } catch (_) {}

      const onMove = (ev) => {
        const y = ev.clientY;
        const siblings = [...listEl.querySelectorAll(".cat-row:not(.dragging)")];
        let inserted = false;
        for (const r of siblings) {
          const rect = r.getBoundingClientRect();
          if (y < rect.top + rect.height / 2) {
            listEl.insertBefore(row, r);
            inserted = true;
            break;
          }
        }
        if (!inserted) listEl.appendChild(row);
      };

      const onUp = () => {
        row.classList.remove("dragging");
        try { handle.releasePointerCapture(pointerId); } catch (_) {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        const order = [...listEl.querySelectorAll(".cat-row")].map((r) => r.dataset.id);
        onDrop(order);
      };

      // 이동/종료 이벤트는 window 에 붙여, 커서가 핸들을 벗어나도 추적되게 함
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    }
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
