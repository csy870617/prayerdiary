// 기도수첩 — Firebase Auth(Google) + Firestore 기반 기도제목/카테고리 관리
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
  let catModalOpen = false;
  let defaultsRequested = false; // 기본 카테고리 중복 생성 방지

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
      subscribePrayers(user.uid);
      subscribeCategories(user.uid);
    } else {
      if (unsubscribePrayers) { unsubscribePrayers(); unsubscribePrayers = null; }
      if (unsubscribeCategories) { unsubscribeCategories(); unsubscribeCategories = null; }
      prayers = [];
      categories = [];
      defaultsRequested = false;
      closeCatModal();
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
        if (catModalOpen) renderCategoryManager();
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
    const catEl = $("category-input");
    const title = titleEl.value.trim();
    if (!title) return;
    const category = catEl.value.trim();
    titleEl.value = "";
    catEl.value = "";
    // 새 카테고리를 입력했다면 관리 목록에도 자동 추가
    if (category && !hasCategory(category)) {
      saveCategories([...categories, { id: newId(), name: category }]).catch(console.error);
    }
    try {
      await addDoc(prayersCol(uid()), {
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
    const next = !p.answered;
    await updateDoc(prayerDoc(p.id), {
      answered: next,
      answeredAt: next ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    });
  }

  async function saveEdit(p, newTitle, newCategory) {
    if (newCategory && !hasCategory(newCategory)) {
      saveCategories([...categories, { id: newId(), name: newCategory }]).catch(console.error);
    }
    await updateDoc(prayerDoc(p.id), {
      title: newTitle,
      category: newCategory,
      updatedAt: serverTimestamp(),
    });
  }

  async function removePrayer(p) {
    if (!confirm("이 기도제목을 삭제할까요?")) return;
    await deleteDoc(prayerDoc(p.id));
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
    await saveCategories([...categories, { id: newId(), name }]);
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
    await saveCategories(categories.filter((c) => c.id !== id));
  }

  async function reorderCategories(idOrder) {
    const map = new Map(categories.map((c) => [c.id, c]));
    const items = idOrder.map((id) => map.get(id)).filter(Boolean);
    if (items.length !== categories.length) return; // 안전장치
    // 순서가 그대로면 저장 생략
    if (items.every((c, i) => c.id === categories[i].id)) return;
    await saveCategories(items);
  }

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
    if (e.key === "Escape" && catModalOpen) closeCatModal();
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

  function renderDatalist() {
    const list = $("category-list");
    list.innerHTML = "";
    orderedCategoryNames().forEach((c) => {
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
    editBtn.addEventListener("click", () => enterEdit(el, p));
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
    save.type = "button";
    save.textContent = "저장";
    save.addEventListener("click", async () => {
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      save.disabled = true;
      await saveEdit(p, t, catInput.value.trim());
    });

    const cancel = document.createElement("button");
    cancel.className = "edit-cancel";
    cancel.type = "button";
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => render());

    controls.append(catInput, save, cancel);
    area.append(ta, controls);
    cardEl.appendChild(area);
    ta.focus();
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
