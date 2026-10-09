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
  where, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const TYPES = ["Ноутбук", "Стационарный ПК", "Монитор", "Проектор", "Принтер", "Другое"];
const KIT = ["Гарнитура", "Мышь", "Клавиатура", "Зарядка", "Сумка", "Полный заряд аккамулятора"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (ms) => new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
const tsMs = (t) => (t && t.toMillis ? t.toMillis() : Date.now());
const normPurpose = (p) => (p === "Учебный" || !p ? "Рабочий" : p);
const label = (i) => `${i.inv} ${i.type}${i.brand ? " " + i.brand : ""}`;

// ---------- Состояние ----------
let app, auth, db, itemsCol, historyCol;
let user = null;
let profile = null;          // { email, role, active }
let suppressAuth = false;    // true на время создания первого администратора
let pendingLoginError = "";
let unsubUsers = null;
let items = [];
let editingId = null;
let pendingPhoto;            // undefined = не менялось, null = убрать, строка = новое фото
let unsubItems = null, unsubDetail = null, unsubJournal = null;
let detailId = null, detailHistory = [];
let audit = null;            // { start: мс, ids: Set }
let deepLinkId = new URLSearchParams(location.search).get("item");
const photoCache = new Map();

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
  historyCol = collection(db, "history");

  onAuthStateChanged(auth, (u) => { if (!suppressAuth) handleUser(u); });
}

function listenItems() {
  if (unsubItems) unsubItems();
  unsubItems = onSnapshot(query(itemsCol, orderBy("createdAt", "desc")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    showBanner("");
    render();
    if (detailId) refreshDetail();
    handleDeepLink();
  }, (err) => {
    showBanner(err.code === "permission-denied"
      ? "Нет доступа к базе. Обновите правила Firestore (см. инструкцию) или попросите администратора включить вам доступ."
      : "Не удалось загрузить данные: " + err.message);
  });
}

function stopAll() {
  [unsubItems, unsubDetail, unsubJournal].forEach((u) => u && u());
  unsubItems = unsubDetail = unsubJournal = null;
  items = []; detailId = null;
  audit = null;
  if (unsubUsers) unsubUsers();
  unsubUsers = null;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
}

function handleDeepLink() {
  if (!deepLinkId) return;
  const id = deepLinkId;
  deepLinkId = null;
  history.replaceState(null, "", location.pathname);
  if (items.some((i) => i.id === id)) openDetail(id);
  else showBanner("Устройство из QR-кода не найдено (возможно, оно удалено).");
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

// ---------- История ----------
function logTo(batch, itemId, inv, text) {
  batch.set(doc(historyCol), { itemId, inv, text, by: user.email, at: serverTimestamp() });
}

function historyHtml(list) {
  if (!list.length) return `<p class="muted">Записей пока нет</p>`;
  return list.map((h) => `
    <div class="h-row">${h.inv && !h.hideInv ? "<b>" + esc(h.inv) + "</b> · " : ""}${esc(h.text)}
      <small>${fmt(tsMs(h.at))} · ${esc(h.by)}</small>
    </div>`).join("");
}

function diffs(o, n) {
  const out = [];
  if (o.status !== n.status) out.push(`Статус: ${o.status} → ${n.status}`);
  const oo = o.owner || "";
  if (oo !== n.owner) out.push(n.owner ? `Владелец: ${oo || "—"} → ${n.owner}` : `Владелец снят (был: ${oo})`);
  if (!!o.hasDefect !== n.hasDefect || (o.defect || "") !== n.defect) {
    out.push(n.hasDefect ? `Дефект: ${n.defect || "без описания"}` : "Дефект устранён");
  }
  if (normPurpose(o.purpose) !== n.purpose) out.push(`Назначение: ${normPurpose(o.purpose)} → ${n.purpose}`);
  const oldKit = Object.fromEntries((o.kit || []).map((k) => [k.name, k.ok]));
  const newNames = n.kit.map((k) => k.name);
  newNames.filter((x) => !(x in oldKit)).forEach((x) => out.push(`В комплект добавлено: ${x}`));
  Object.keys(oldKit).filter((x) => !newNames.includes(x)).forEach((x) => out.push(`Из комплекта убрано: ${x}`));
  const meta = [];
  if (o.type !== n.type) meta.push(`тип ${o.type} → ${n.type}`);
  if (o.inv !== n.inv) meta.push(`номер ${o.inv} → ${n.inv}`);
  if ((o.brand || "") !== n.brand) meta.push(`бренд ${o.brand || "—"} → ${n.brand || "—"}`);
  if (meta.length) out.push("Изменено: " + meta.join(", "));
  return out;
}

// ---------- QR и печать ----------
const itemUrl = (id) => `${location.origin}${location.pathname}?item=${id}`;

function qrSvg(text) {
  if (typeof qrcode === "undefined") return `<p class="muted">QR недоступен (не загрузилась библиотека)</p>`;
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function printLabels(list) {
  if (!list.length) return alert("Нет техники для печати");
  $("printArea").innerHTML = list.map((i) => `
    <div class="label">
      <div class="label-qr">${qrSvg(itemUrl(i.id))}</div>
      <div class="label-text"><b>${esc(i.inv)}</b><span>${esc(i.type)} ${esc(i.brand)}</span></div>
    </div>`).join("");
  window.print();
}
$("labelsBtn").addEventListener("click", () => {
  const list = filtered();
  if (list.length > 0 && confirm(`Напечатать наклейки с QR-кодом для ${list.length} шт. из текущего списка?`)) printLabels(list);
  else if (list.length === 0) alert("Нет техники для печати");
});

// ---------- Фильтры и список ----------
$("fType").innerHTML += TYPES.map((t) => `<option>${t}</option>`).join("");
$("type").innerHTML = TYPES.map((t) => `<option>${t}</option>`).join("");
$("kitOptions").innerHTML = KIT.map((k) => `<label class="check"><input type="checkbox" value="${k}"> ${k}</label>`).join("");

["search", "fStatus", "fType", "fDefect", "onlyUnchecked"].forEach((id) => $(id).addEventListener("input", render));

const isChecked = (i) => audit && i.lastCheck && i.lastCheck.at >= audit.start;

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  return items.filter((i) => {
    if ($("fStatus").value && i.status !== $("fStatus").value) return false;
    if ($("fType").value && i.type !== $("fType").value) return false;
    if ($("fDefect").checked && !i.hasDefect) return false;
    if (q && ![i.inv, i.brand, i.owner, i.type].join(" ").toLowerCase().includes(q)) return false;
    if (audit && $("onlyUnchecked").checked && audit.ids.has(i.id) && isChecked(i)) return false;
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

  $("auditBtn").hidden = !!audit;
  $("auditBar").hidden = !audit;
  if (audit) {
    const scope = items.filter((i) => audit.ids.has(i.id));
    $("auditProgress").textContent = `проверено ${scope.filter(isChecked).length} из ${scope.length}`;
  }

  $("empty").hidden = items.length > 0;
  $("list").innerHTML = filtered().map(cardHtml).join("");
}

function lastCheckText(i) {
  if (!i.lastCheck) return "";
  const ok = i.lastCheck.result === "ok";
  return `<p class="sub ${ok ? "ok" : "bad"}">${ok ? "✓ На месте" : "✗ Не найдено"} · ${fmt(i.lastCheck.at)}</p>`;
}

function cardHtml(i) {
  const busy = i.status === "Занят";
  const broken = i.status === "Сломан";
  const badgeClass = broken ? "broken" : busy ? "busy" : "free";
  const kit = (i.kit || []).map((k, idx) =>
    `<button class="chip ${k.ok ? "" : "missing"}" data-act="kit" data-id="${i.id}" data-idx="${idx}" title="Нажмите, чтобы отметить наличие">${esc(k.name)}</button>`
  ).join("");
  const inAudit = audit && audit.ids.has(i.id);
  const res = isChecked(i) ? i.lastCheck.result : null;

  return `
  <article class="card ${i.hasDefect || broken ? "has-defect" : ""}">
    <div class="card-head">
      <span class="inv" data-act="open" data-id="${i.id}">${esc(i.inv)}</span>
      <span class="badge ${badgeClass}">${esc(i.status)}</span>
    </div>
    <div data-act="open" data-id="${i.id}">
      <p class="title">${esc(i.type)} ${esc(i.brand)}</p>
      <p class="sub">${esc(normPurpose(i.purpose))}${busy && i.owner ? " · владелец: " + esc(i.owner) : ""}</p>
      ${lastCheckText(i)}
    </div>
    ${i.hasDefect ? `<div class="defect">Дефект: ${esc(i.defect || "не описан")}${i.hasPhoto ? " · есть фото" : ""}</div>` : ""}
    ${kit ? `<div><p class="kit-title">Комплект (нажмите, если чего-то нет)</p><div class="chips">${kit}</div></div>` : ""}
    ${inAudit ? `
      <div class="check-actions">
        <button class="btn small ${res === "ok" ? "on-ok" : ""}" data-act="ok" data-id="${i.id}">На месте</button>
        <button class="btn small ${res === "missing" ? "on-bad" : ""}" data-act="missing" data-id="${i.id}">Нет на месте</button>
      </div>` : ""}
    <div class="card-actions">
      <button class="btn small" data-act="open" data-id="${i.id}">Подробнее</button>
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
    if (act === "open") openDetail(item.id);
    if (act === "edit") openDialog(item);
    if (act === "del") await deleteItem(item);
    if (act === "kit") await toggleKit(item, +btn.dataset.idx);
    if (act === "ok" || act === "missing") await markCheck(item, act);
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
});

async function deleteItem(item) {
  if (!confirm(`Удалить ${item.inv}? Запись в журнале останется.`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, "items", item.id));
  batch.delete(doc(db, "photos", item.id));
  logTo(batch, item.id, item.inv, "Удалено из базы");
  await batch.commit();
}

async function toggleKit(item, idx) {
  const kit = item.kit.map((k, n) => (n === idx ? { ...k, ok: !k.ok } : k));
  const k = kit[idx];
  const batch = writeBatch(db);
  batch.update(doc(db, "items", item.id), { kit });
  logTo(batch, item.id, item.inv, k.ok ? `Комплект: «${k.name}» на месте` : `Комплект: «${k.name}» отсутствует`);
  await batch.commit();
}

// ---------- Режим проверки ----------
$("auditBtn").addEventListener("click", () => {
  const list = filtered();
  if (!list.length) return alert("В текущем списке нет техники. Сбросьте фильтры или выберите нужные.");
  if (!confirm(`Начать проверку для ${list.length} шт. из текущего списка?\n\nЧтобы проверить только часть (например, ноутбуки или одного владельца), сначала выставьте фильтры или поиск.`)) return;
  audit = { start: Date.now(), ids: new Set(list.map((i) => i.id)) };
  $("onlyUnchecked").checked = false;
  render();
});

async function markCheck(item, result) {
  const batch = writeBatch(db);
  batch.update(doc(db, "items", item.id), { lastCheck: { at: Date.now(), by: user.email, result } });
  logTo(batch, item.id, item.inv, result === "ok" ? "Проверка: на месте" : "Проверка: НЕ НАЙДЕНО");
  await batch.commit();
}

$("auditCancel").addEventListener("click", () => {
  if (confirm("Выйти из режима проверки? Уже поставленные отметки сохранятся.")) { audit = null; render(); }
});

$("auditFinish").addEventListener("click", () => {
  const scope = items.filter((i) => audit.ids.has(i.id));
  const ok = scope.filter((i) => isChecked(i) && i.lastCheck.result === "ok");
  const missing = scope.filter((i) => isChecked(i) && i.lastCheck.result === "missing");
  const left = scope.filter((i) => !isChecked(i));
  const lines = (arr) => (arr.length ? arr.map((i) => "  • " + label(i)).join("\n") : "  —");
  $("reportText").textContent =
`Инвентаризация от ${fmt(audit.start)}
Проверял: ${user.email}

Всего: ${scope.length} · На месте: ${ok.length} · Не найдено: ${missing.length} · Не проверено: ${left.length}

Не найдено:
${lines(missing)}

Не проверено:
${lines(left)}`;
  $("reportDlg").showModal();
  audit = null;
  render();
});

$("reportCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("reportText").textContent); $("reportCopy").textContent = "Скопировано"; }
  catch { alert("Не удалось скопировать, выделите текст вручную"); }
});

// ---------- Карточка устройства ----------
async function getPhoto(item) {
  if (!item?.hasPhoto) return null;
  const key = `${item.id}:${item.photoAt}`;
  if (!photoCache.has(key)) {
    const s = await getDoc(doc(db, "photos", item.id));
    photoCache.set(key, s.exists() ? s.data().data : null);
  }
  return photoCache.get(key);
}

function detailHtml(i) {
  const busy = i.status === "Занят";
  const badgeClass = i.status === "Сломан" ? "broken" : busy ? "busy" : "free";
  const kit = (i.kit || []).map((k) => `<span class="chip ${k.ok ? "" : "missing"}">${esc(k.name)}</span>`).join("");
  return `
    <div class="detail-top">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="card-head" style="justify-content:flex-start;gap:12px">
          <span class="inv">${esc(i.inv)}</span>
          <span class="badge ${badgeClass}">${esc(i.status)}</span>
        </div>
        <div>
          <p class="title">${esc(i.type)} ${esc(i.brand)}</p>
          <p class="sub">${esc(normPurpose(i.purpose))}${busy && i.owner ? " · владелец: " + esc(i.owner) : ""}</p>
          ${lastCheckText(i)}
        </div>
      </div>
      <div>
        <div class="qr">${qrSvg(itemUrl(i.id))}</div>
        <p class="qr-cap">QR-код устройства</p>
      </div>
    </div>
    ${i.hasDefect ? `<div class="defect">Дефект: ${esc(i.defect || "не описан")}</div>` : ""}
    ${i.hasPhoto ? `<img id="detailPhoto" class="photo" alt="Фото дефекта" hidden>` : ""}
    ${kit ? `<div><p class="kit-title">Комплект</p><div class="chips">${kit}</div></div>` : ""}
    <div>
      <h3>История</h3>
      <div id="detailHistory" class="history">${historyHtml(detailHistory)}</div>
    </div>
    <div class="actions">
      <button class="btn" data-dact="print">Печать наклейки</button>
      <button class="btn" data-dact="edit">Изменить</button>
      <button class="btn primary" data-dact="close">Закрыть</button>
    </div>`;
}

function refreshDetail() {
  const item = items.find((i) => i.id === detailId);
  if (!item) { $("detailDlg").close(); return; }
  $("detailBody").innerHTML = detailHtml(item);
  if (item.hasPhoto) {
    getPhoto(item).then((src) => {
      const img = $("detailPhoto");
      if (src && img && detailId === item.id) { img.src = src; img.hidden = false; }
    }).catch(() => {});
  }
}

function openDetail(id) {
  detailId = id;
  detailHistory = [];
  if (unsubDetail) unsubDetail();
  unsubDetail = onSnapshot(query(historyCol, where("itemId", "==", id)), (snap) => {
    detailHistory = snap.docs.map((d) => ({ ...d.data(), hideInv: true })).sort((a, b) => tsMs(b.at) - tsMs(a.at));
    const el = $("detailHistory");
    if (el) el.innerHTML = historyHtml(detailHistory);
  });
  refreshDetail();
  if (!$("detailDlg").open) $("detailDlg").showModal();
}

$("detailDlg").addEventListener("close", () => {
  if (unsubDetail) unsubDetail();
  unsubDetail = null; detailId = null;
});

$("detailBody").addEventListener("click", (e) => {
  const act = e.target.closest("[data-dact]")?.dataset.dact;
  const item = items.find((i) => i.id === detailId);
  if (!act || !item) return;
  if (act === "close") $("detailDlg").close();
  if (act === "print") printLabels([item]);
  if (act === "edit") { $("detailDlg").close(); openDialog(item); }
});

// ---------- Журнал ----------
$("journalBtn").addEventListener("click", () => {
  $("journalList").innerHTML = `<p class="muted">Загрузка…</p>`;
  if (unsubJournal) unsubJournal();
  unsubJournal = onSnapshot(query(historyCol, orderBy("at", "desc"), limit(100)), (snap) => {
    $("journalList").innerHTML = historyHtml(snap.docs.map((d) => d.data()));
  }, (err) => { $("journalList").textContent = "Ошибка: " + err.message; });
  $("journalDlg").showModal();
});
$("journalDlg").addEventListener("close", () => { if (unsubJournal) unsubJournal(); unsubJournal = null; });


// ---------- Форма ----------
const dlg = $("dlg");

function syncForm() {
  $("owner").disabled = $("status").value !== "Занят";
  if ($("owner").disabled) $("owner").value = "";
  const d = $("hasDefect").checked;
  $("defect").disabled = !d;
  if (!d) $("defect").value = "";
  $("photoInput").disabled = !d;
  $("photoLabel").classList.toggle("disabled", !d);
  if (!d) setPreview(null);
}
$("status").addEventListener("change", syncForm);
$("hasDefect").addEventListener("change", () => {
  if (!$("hasDefect").checked) pendingPhoto = null;
  syncForm();
});

function setPreview(src) {
  $("photoPreview").hidden = !src;
  if (src) $("photoPreview").src = src;
  $("photoRemove").hidden = !src;
}

function compressImage(file, max = 800, quality = 0.68) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Не удалось прочитать фото"));
    img.src = url;
  });
}

$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingPhoto = await compressImage(file);
    setPreview(pendingPhoto);
  } catch (err) { alert(err.message); }
  e.target.value = "";
});
$("photoRemove").addEventListener("click", () => { pendingPhoto = null; setPreview(null); });

function openDialog(item) {
  editingId = item?.id ?? null;
  pendingPhoto = undefined;
  $("dlgTitle").textContent = item ? "Изменить технику" : "Новая техника";
  $("type").value = item?.type ?? TYPES[0];
  $("inv").value = item?.inv ?? "";
  $("purpose").value = normPurpose(item?.purpose);
  $("brand").value = item?.brand ?? "";
  $("status").value = item?.status ?? "Свободен";
  $("owner").value = item?.owner ?? "";
  $("hasDefect").checked = !!item?.hasDefect;
  $("defect").value = item?.defect ?? "";
  setPreview(null);

  const names = (item?.kit || []).map((k) => k.name);
  document.querySelectorAll("#kitOptions input").forEach((c) => (c.checked = names.includes(c.value)));
  $("kitCustom").value = names.filter((n) => !KIT.includes(n)).join(", ");
  syncForm();
  dlg.showModal();
  if (item?.hasPhoto) getPhoto(item).then((src) => { if (pendingPhoto === undefined) setPreview(src); }).catch(() => {});
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
    const id = ref.id;
    const extra = [];
    // Фото дефекта
    let hasPhoto = !!old?.hasPhoto, photoAt = old?.photoAt ?? null;
    if (!data.hasDefect || pendingPhoto === null) {
      if (hasPhoto) { batch.delete(doc(db, "photos", id)); hasPhoto = false; photoAt = null; extra.push("Фото дефекта удалено"); }
    } else if (typeof pendingPhoto === "string") {
      if (pendingPhoto.length > 900000) throw new Error("Фото слишком большое");
      batch.set(doc(db, "photos", id), { data: pendingPhoto });
      hasPhoto = true; photoAt = Date.now(); extra.push("Добавлено фото дефекта");
    }
    data.hasPhoto = hasPhoto;
    data.photoAt = photoAt;

    if (old) {
      [...diffs(old, data), ...extra].forEach((t) => logTo(batch, id, data.inv, t));
      batch.update(ref, data);
    } else {
      batch.set(ref, { ...data, createdAt: serverTimestamp() });
      logTo(batch, id, data.inv, "Добавлено в базу");
      extra.forEach((t) => logTo(batch, id, data.inv, t));
    }
    await batch.commit();
    dlg.close();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  } finally {
    $("saveBtn").disabled = false;
  }
});
