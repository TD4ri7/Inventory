import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const TYPES = ["Ноутбук", "Стационарный ПК", "Монитор", "Проектор", "Принтер", "Другое"];
const KIT = ["Гарнитура", "Мышь", "Клавиатура", "Зарядка", "Сумка"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let items = [];
let editingId = null;
let col = null;

// ---------- Firebase ----------
const configured = !String(firebaseConfig.apiKey).includes("ВСТАВЬТЕ");
if (!configured) {
  const b = $("banner");
  b.hidden = false;
  b.textContent = "Firebase ещё не подключён. Откройте firebase-config.js и вставьте настройки проекта (инструкция в README.md).";
} else {
  const db = getFirestore(initializeApp(firebaseConfig));
  col = collection(db, "items");
  onSnapshot(query(col, orderBy("createdAt", "desc")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => {
    const b = $("banner");
    b.hidden = false;
    b.textContent = "Не удалось загрузить данные: " + err.message;
  });
}

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
  $("stats").innerHTML = `
    <span><b>${items.length}</b>всего</span>
    <span><b>${items.filter((i) => i.status === "Свободен").length}</b>свободно</span>
    <span><b>${items.filter((i) => i.status === "Занят").length}</b>занято</span>
    <span class="warn"><b>${items.filter((i) => i.hasDefect).length}</b>с дефектами</span>`;

  const list = filtered();
  $("empty").hidden = items.length > 0;
  $("list").innerHTML = list.map(cardHtml).join("");
}

function cardHtml(i) {
  const busy = i.status === "Занят";
  const kit = (i.kit || []).map((k, idx) =>
    `<button class="chip ${k.ok ? "" : "missing"}" data-act="kit" data-id="${i.id}" data-idx="${idx}" title="Нажмите, чтобы отметить наличие">${esc(k.name)}</button>`
  ).join("");
  return `
  <article class="card ${i.hasDefect ? "has-defect" : ""}">
    <div class="card-head">
      <span class="inv">${esc(i.inv)}</span>
      <span class="badge ${busy ? "busy" : "free"}">${esc(i.status)}</span>
    </div>
    <div>
      <p class="title">${esc(i.type)} ${esc(i.brand)}</p>
      <p class="sub">${esc(i.purpose)}${busy && i.owner ? " · владелец: " + esc(i.owner) : ""}</p>
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
  if (!btn || !col) return;
  const item = items.find((i) => i.id === btn.dataset.id);
  if (!item) return;
  const ref = doc(col.firestore, "items", item.id);

  if (btn.dataset.act === "edit") openDialog(item);
  if (btn.dataset.act === "del" && confirm(`Удалить ${item.inv}?`)) await deleteDoc(ref);
  if (btn.dataset.act === "kit") {
    const kit = item.kit.map((k, idx) => idx === +btn.dataset.idx ? { ...k, ok: !k.ok } : k);
    await updateDoc(ref, { kit });
  }
});

// ---------- Форма ----------
const dlg = $("dlg");

function syncForm() {
  $("owner").disabled = $("status").value !== "Занят";
  if ($("owner").disabled) $("owner").value = "";
  $("defect").disabled = !$("hasDefect").checked;
  if ($("defect").disabled) $("defect").value = "";
}
$("status").addEventListener("change", syncForm);
$("hasDefect").addEventListener("change", syncForm);

function openDialog(item) {
  editingId = item?.id ?? null;
  $("dlgTitle").textContent = item ? "Изменить технику" : "Новая техника";
  $("type").value = item?.type ?? TYPES[0];
  $("inv").value = item?.inv ?? "";
  $("purpose").value = item?.purpose ?? "Учебный";
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
  if (!col) { alert("Сначала подключите Firebase (см. README.md)"); return; }

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
    kit: names.map((name) => ({ name, ok: oldOk[name] ?? true }))
  };

  if (editingId) await updateDoc(doc(col.firestore, "items", editingId), data);
  else await addDoc(col, { ...data, createdAt: serverTimestamp() });
  dlg.close();
});
