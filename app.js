import {
  initializeApp,
  deleteApp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, writeBatch, onSnapshot, query, orderBy, serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const TYPES = ["Ноутбук", "Стационарный ПК", "Монитор", "Проектор", "Принтер", "Другое"];
const KIT = ["Гарнитура", "Мышь", "Клавиатура", "Зарядка", "Сумка"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const normPurpose = (p) => (p === "Учебный" || !p ? "Рабочий" : p);

// ---------- Состояние ----------
let app, auth, db, itemsCol;
let user = null;
let profile = null;          // { email, role, active }
let suppressAuth = false;    // true на время создания первого администратора
let pendingLoginError = "";
let unsubUsers = null;
let items = [];
let editingId = null;
let unsubItems = null;

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = !text;
}

// ---------- Запуск ----------
const configured = !String(firebaseConfig.apiKey).includes("ВСТАВЬТЕ");
if (!configured) {
  showBanner("Firebase ещё не подключён. Откройте firebase-config.js и вставьте настройки проекта.");
} else {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  itemsCol = collection(db, "items");

  onAuthStateChanged(auth, (u) => { if (!suppressAuth) handleUser(u); });
}

function listenItems() {
  if (unsubItems) unsubItems();
  unsubItems = onSnapshot(query(itemsCol, orderBy("createdAt", "desc")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    showBanner("");
    render();
  }, (err) => {
    showBanner(err.code === "permission-denied"
      ? "Нет доступа к базе. Обновите правила Firestore (см. инструкцию) или попросите администратора включить вам доступ."
      : "Не удалось загрузить данные: " + err.message);
  });
}

function stopAll() {
  if (unsubItems) unsubItems();
  unsubItems = null;
  items = [];
  if (unsubUsers) unsubUsers();
  unsubUsers = null;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
}

// ---------- Вход / выход ----------
function authMsg(ex) {
  const map = {
    "auth/invalid-credential": "Неверная почта или пароль",
    "auth/wrong-password": "Неверная почта или пароль",
    "auth/user-not-found": "Неверная почта или пароль",
    "auth/invalid-email": "Некорректная почта",
    "auth/missing-password": "Введите пароль",
    "auth/weak-password": "Пароль слишком простой (минимум 6 символов)",
    "auth/email-already-in-use": "Эта почта уже зарегистрирована. Используйте другую или включите доступ существующему пользователю в списке.",
    "auth/too-many-requests": "Слишком много попыток, подождите несколько минут",
    "auth/operation-not-allowed": "Вход по паролю не включён в Firebase (Authentication → Sign-in method → Email/Password)",
    "auth/unauthorized-domain": "Адрес сайта не добавлен в Firebase (Authentication → Settings → Authorized domains)",
    "permission-denied": "Нет прав на запись. Опубликованы ли правила Firestore из инструкции?"
  };
  return map[ex.code] || "Ошибка: " + (ex.code || ex.message);
}

async function handleUser(u) {
  if (!u) {
    user = null; profile = null;
    stopAll();
    $("appView").hidden = true;
    await showLoginOrSetup();
    return;
  }
  let prof = null;
  try {
    const s = await getDoc(doc(db, "users", u.uid));
    prof = s.exists() ? s.data() : null;
  } catch (err) { prof = null; }

  if (!prof || prof.active !== true) {
    pendingLoginError = prof
      ? "Доступ для этой почты отключён. Обратитесь к администратору."
      : "У этой почты нет доступа. Попросите администратора добавить вас в «Пользователи».";
    await signOut(auth);   // после выхода сработает handleUser(null) и покажет сообщение
    return;
  }
  user = u; profile = prof;
  $("userEmail").textContent = `${u.email} · ${prof.role === "admin" ? "администратор" : "сотрудник"}`;
  $("usersBtn").hidden = prof.role !== "admin";
  $("loginView").hidden = true;
  $("appView").hidden = false;
  listenItems();
}

async function showLoginOrSetup() {
  let setupDone = true;
  try {
    setupDone = (await getDoc(doc(db, "config", "setup"))).exists();
  } catch (err) {
    showBanner("Не удалось обратиться к базе. Проверьте, что правила Firestore из инструкции опубликованы.");
  }
  $("loginError").hidden = true;
  $("setupError").hidden = true;
  $("loginForm").hidden = !setupDone;
  $("setupForm").hidden = setupDone;
  if (pendingLoginError) {
    const el = setupDone ? $("loginError") : $("setupError");
    el.textContent = pendingLoginError;
    el.hidden = false;
    pendingLoginError = "";
  }
  $("loginView").hidden = false;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("loginError");
  err.hidden = true;
  $("loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    $("password").value = "";
  } catch (ex) {
    err.textContent = authMsg(ex);
    err.hidden = false;
  } finally {
    $("loginBtn").disabled = false;
  }
});

// Первый запуск: создаём администратора и отмечаем, что настройка выполнена
$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("setupError");
  err.hidden = true;
  const email = $("setupEmail").value.trim();
  const p1 = $("setupPass").value;
  if (p1 !== $("setupPass2").value) { err.textContent = "Пароли не совпадают"; err.hidden = false; return; }
  $("setupBtn").disabled = true;
  suppressAuth = true;
  try {
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, p1);
    } catch (ex) {
      // аккаунт мог создаться при прошлой неудачной попытке
      if (ex.code === "auth/email-already-in-use") cred = await signInWithEmailAndPassword(auth, email, p1);
      else throw ex;
    }
    const batch = writeBatch(db);
    batch.set(doc(db, "users", cred.user.uid), { email, role: "admin", active: true, createdAt: serverTimestamp() });
    batch.set(doc(db, "config", "setup"), { by: cred.user.uid, at: serverTimestamp() });
    await batch.commit();
    suppressAuth = false;
    await handleUser(auth.currentUser);
  } catch (ex) {
    suppressAuth = false;
    err.textContent = authMsg(ex);
    err.hidden = false;
    if (auth.currentUser) await signOut(auth);
  } finally {
    $("setupBtn").disabled = false;
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => $(b.dataset.close).close()));

// ---------- Пользователи и пароль ----------
function userRowHtml(u) {
  const me = u.id === user.uid;
  const active = u.active === true;
  return `
  <div class="user-row">
    <div><b>${esc(u.email)}</b>${me ? " (вы)" : ""}${active ? "" : `<small>доступ отключён</small>`}</div>
    <select data-uact="role" data-id="${u.id}" ${me ? "disabled" : ""}>
      <option value="staff" ${u.role === "staff" ? "selected" : ""}>Сотрудник</option>
      <option value="admin" ${u.role === "admin" ? "selected" : ""}>Администратор</option>
    </select>
    <div class="user-btns">
      <button class="btn small" data-uact="reset" data-email="${esc(u.email)}">Письмо для сброса пароля</button>
      ${me ? "" : `<button class="btn small ${active ? "danger" : ""}" data-uact="toggle" data-id="${u.id}" data-active="${active}">${active ? "Отключить доступ" : "Включить доступ"}</button>`}
    </div>
  </div>`;
}

$("usersBtn").addEventListener("click", () => {
  $("usersList").innerHTML = `<p class="muted">Загрузка…</p>`;
  $("addError").hidden = true;
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((x, y) => (x.email || "").localeCompare(y.email || ""));
    $("usersList").innerHTML = rows.map(userRowHtml).join("");
  }, (err) => { $("usersList").textContent = "Ошибка: " + err.message; });
  $("usersDlg").showModal();
});
$("usersDlg").addEventListener("close", () => { if (unsubUsers) unsubUsers(); unsubUsers = null; });

$("usersList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-uact]");
  if (!b) return;
  try {
    if (b.dataset.uact === "toggle") {
      const on = b.dataset.active === "true";
      if (on && !confirm("Отключить доступ этому пользователю?")) return;
      await updateDoc(doc(db, "users", b.dataset.id), { active: !on });
    }
    if (b.dataset.uact === "reset") {
      await sendPasswordResetEmail(auth, b.dataset.email);
      alert("Письмо отправлено. Оно дойдёт, только если почта настоящая.");
    }
  } catch (ex) { alert(authMsg(ex)); }
});
$("usersList").addEventListener("change", async (e) => {
  const s = e.target.closest("[data-uact='role']");
  if (!s) return;
  try { await updateDoc(doc(db, "users", s.dataset.id), { role: s.value }); }
  catch (ex) { alert(authMsg(ex)); }
});

// Создание аккаунта сотрудника. Отдельное подключение нужно, чтобы вы не вышли из своего аккаунта.
$("usersForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("addError");
  err.hidden = true;
  const email = $("addEmail").value.trim();
  const pass = $("addPass").value;
  const role = $("addRole").value;
  $("addUserBtn").disabled = true;
  let sec;
  try {
    sec = initializeApp(firebaseConfig, "secondary");
    const sAuth = getAuth(sec);
    const cred = await createUserWithEmailAndPassword(sAuth, email, pass);
    await signOut(sAuth);
    const batch = writeBatch(db);
    batch.set(doc(db, "users", cred.user.uid), {
      email, role, active: true, createdAt: serverTimestamp(), createdBy: user.email
    });
    await batch.commit();
    $("usersForm").reset();
  } catch (ex) {
    err.textContent = authMsg(ex);
    err.hidden = false;
  } finally {
    if (sec) await deleteApp(sec);
    $("addUserBtn").disabled = false;
  }
});

// Смена своего пароля
$("pwdBtn").addEventListener("click", () => {
  $("pwdForm").reset();
  $("pwdError").hidden = true;
  $("pwdDlg").showModal();
});
$("pwdForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("pwdError");
  err.hidden = true;
  if ($("newPass").value !== $("newPass2").value) { err.textContent = "Новые пароли не совпадают"; err.hidden = false; return; }
  $("pwdSave").disabled = true;
  try {
    const cur = auth.currentUser;
    await reauthenticateWithCredential(cur, EmailAuthProvider.credential(cur.email, $("curPass").value));
    await updatePassword(cur, $("newPass").value);
    $("pwdDlg").close();
    alert("Пароль изменён");
  } catch (ex) {
    err.textContent = authMsg(ex);
    err.hidden = false;
  } finally {
    $("pwdSave").disabled = false;
  }
});

// ---------- Фильтры и список ----------
$("fType").innerHTML += TYPES.map((t) => `<option>${t}</option>`).join("");
$("type").innerHTML = TYPES.map((t) => `<option>${t}</option>`).join("");
$("kitOptions").innerHTML = KIT.map((k) => `<label class="check"><input type="checkbox" value="${k}"> ${k}</label>`).join("");

["search", "fStatus", "fType", "fDefect"].forEach((id) => $(id).addEventListener("input", render));


function filtered() {
  const q = $("search").value.trim().toLowerCase();
  return items.filter((i) => {
    if ($("fStatus").value && i.status !== $("fStatus").value) return false;
    if ($("fType").value && i.type !== $("fType").value) return false;
    if ($("fDefect").checked && !i.hasDefect) return false;
    if (q && ![i.inv, i.brand, i.owner, i.type].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
}

function render() {
  const cnt = (s) => items.filter((i) => i.status === s).length;
  $("stats").innerHTML = `
    <span><b>${items.length}</b>всего</span>
    <span><b>${cnt("Свободен")}</b>свободно</span>
    <span><b>${cnt("Занят")}</b>занято</span>
    <span class="warn"><b>${cnt("Сломан")}</b>сломано</span>
    <span class="warn"><b>${items.filter((i) => i.hasDefect).length}</b>с дефектами</span>`;


  $("empty").hidden = items.length > 0;
  $("list").innerHTML = filtered().map(cardHtml).join("");
}

function cardHtml(i) {
  const busy = i.status === "Занят";
  const broken = i.status === "Сломан";
  const badgeClass = broken ? "broken" : busy ? "busy" : "free";
  const kit = (i.kit || []).map((k, idx) =>
    `<button class="chip ${k.ok ? "" : "missing"}" data-act="kit" data-id="${i.id}" data-idx="${idx}" title="Нажмите, чтобы отметить наличие">${esc(k.name)}</button>`
  ).join("");

  return `
  <article class="card ${i.hasDefect || broken ? "has-defect" : ""}">
    <div class="card-head">
      <span class="inv">${esc(i.inv)}</span>
      <span class="badge ${badgeClass}">${esc(i.status)}</span>
    </div>
    <div>
      <p class="title">${esc(i.type)} ${esc(i.brand)}</p>
      <p class="sub">${esc(normPurpose(i.purpose))}${busy && i.owner ? " · владелец: " + esc(i.owner) : ""}</p>
    </div>
    ${i.hasDefect ? `<div class="defect">Дефект: ${esc(i.defect || "не описан")}</div>` : ""}
    ${kit ? `<div><p class="kit-title">Комплект (нажмите, если чего-то нет)</p><div class="chips">${kit}</div></div>` : ""}
    <div class="card-actions">
      <button class="btn small" data-act="edit" data-id="${i.id}">Изменить</button>
      <button class="btn small danger" data-act="del" data-id="${i.id}">Удалить</button>
    </div>
  </article>`;
}

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const item = items.find((i) => i.id === btn.dataset.id);
  if (!item) return;
  const act = btn.dataset.act;
  try {
    if (act === "edit") openDialog(item);
    if (act === "del") await deleteItem(item);
    if (act === "kit") await toggleKit(item, +btn.dataset.idx);
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
});

async function deleteItem(item) {
  if (!confirm(`Удалить ${item.inv}?`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, "items", item.id));
  await batch.commit();
}

async function toggleKit(item, idx) {
  const kit = item.kit.map((k, n) => (n === idx ? { ...k, ok: !k.ok } : k));
  const k = kit[idx];
  const batch = writeBatch(db);
  batch.update(doc(db, "items", item.id), { kit });
  await batch.commit();
}

// ---------- Форма ----------
const dlg = $("dlg");

function syncForm() {
  $("owner").disabled = $("status").value !== "Занят";
  if ($("owner").disabled) $("owner").value = "";
  const d = $("hasDefect").checked;
  $("defect").disabled = !d;
  if (!d) $("defect").value = "";
}
$("status").addEventListener("change", syncForm);
$("hasDefect").addEventListener("change", () => {
  syncForm();
});

function openDialog(item) {
  editingId = item?.id ?? null;
  $("dlgTitle").textContent = item ? "Изменить технику" : "Новая техника";
  $("type").value = item?.type ?? TYPES[0];
  $("inv").value = item?.inv ?? "";
  $("purpose").value = normPurpose(item?.purpose);
  $("brand").value = item?.brand ?? "";
  $("status").value = item?.status ?? "Свободен";
  $("owner").value = item?.owner ?? "";
  $("hasDefect").checked = !!item?.hasDefect;
  $("defect").value = item?.defect ?? "";

  const names = (item?.kit || []).map((k) => k.name);
  document.querySelectorAll("#kitOptions input").forEach((c) => (c.checked = names.includes(c.value)));
  $("kitCustom").value = names.filter((n) => !KIT.includes(n)).join(", ");
  syncForm();
  dlg.showModal();
}

$("addBtn").addEventListener("click", () => openDialog(null));
$("cancelBtn").addEventListener("click", () => dlg.close());

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("saveBtn").disabled = true;
  try {
    const old = items.find((i) => i.id === editingId);
    const oldOk = Object.fromEntries((old?.kit || []).map((k) => [k.name, k.ok]));
    const names = [
      ...[...document.querySelectorAll("#kitOptions input:checked")].map((c) => c.value),
      ...$("kitCustom").value.split(",").map((s) => s.trim()).filter(Boolean)
    ];
    const data = {
      type: $("type").value,
      inv: $("inv").value.trim(),
      purpose: $("purpose").value,
      brand: $("brand").value.trim(),
      status: $("status").value,
      owner: $("owner").value.trim(),
      hasDefect: $("hasDefect").checked,
      defect: $("defect").value.trim(),
      kit: [...new Set(names)].map((name) => ({ name, ok: oldOk[name] ?? true }))
    };

    const batch = writeBatch(db);
    const ref = old ? doc(db, "items", old.id) : doc(itemsCol);

    if (old) {
      batch.update(ref, data);
    } else {
      batch.set(ref, { ...data, createdAt: serverTimestamp() });
    }
    await batch.commit();
    dlg.close();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  } finally {
    $("saveBtn").disabled = false;
  }
});
