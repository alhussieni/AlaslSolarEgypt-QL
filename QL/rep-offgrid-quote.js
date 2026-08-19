/* ============================================================
   rep-offgrid-quote.js
   حاسبة أوف جريد كاملة للمندوب: نفس محرك الحساب الهندسي الحقيقي
   (offgrid-calc-engine.js) + تسعير كامل قابل للخصم لكل بند + حفظ
   عبر rep_create_offgrid_quote() اللي بتحسب التكلفة/الربح على السيرفر.
   ============================================================ */

const DEFAULT_LOADS = [
  { name: "لمبة - LED Light", watt: 10, runningFactor: 0.5, nightHours: 19, dayHours: 5, surgeFactor: 1 },
  { name: "DVR / NVR", watt: 25, runningFactor: 1, nightHours: 19, dayHours: 5, surgeFactor: 1 },
  { name: "راوتر / شاحن", watt: 15, runningFactor: 1, nightHours: 19, dayHours: 5, surgeFactor: 1 },
  { name: "كاميرا مراقبة", watt: 10, runningFactor: 1, nightHours: 19, dayHours: 5, surgeFactor: 1 },
  { name: "لابتوب", watt: 65, runningFactor: 1, nightHours: 0, dayHours: 8, surgeFactor: 1 },
  { name: "مروحة", watt: 70, runningFactor: 0.5, nightHours: 6, dayHours: 4, surgeFactor: 3 },
  { name: "شفاط مطبخ", watt: 75, runningFactor: 1, nightHours: 0, dayHours: 2, surgeFactor: 3 },
  { name: "تلفاز LCD / كاميرات CCTV", watt: 60, runningFactor: 1, nightHours: 19, dayHours: 5, surgeFactor: 1 },
  { name: "تلفاز LCD", watt: 80, runningFactor: 1, nightHours: 3, dayHours: 3, surgeFactor: 1 },
  { name: "ثلاجة", watt: 175, runningFactor: 0.8, nightHours: 18, dayHours: 6, surgeFactor: 7 },
  { name: "كشاف إنارة", watt: 200, runningFactor: 1, nightHours: 12, dayHours: 0, surgeFactor: 1 },
  { name: "فريزر", watt: 300, runningFactor: 0.8, nightHours: 18, dayHours: 6, surgeFactor: 7 },
  { name: "موتور 1 حصان", watt: 740, runningFactor: 1, nightHours: 2, dayHours: 0.25, surgeFactor: 7 },
  { name: "ميكروويف", watt: 1000, runningFactor: 1, nightHours: 1, dayHours: 1, surgeFactor: 1 },
  { name: "موتور 1.5 حصان / غاطس", watt: 1100, runningFactor: 1, nightHours: 0.5, dayHours: 2, surgeFactor: 7 },
  { name: "تكييف 1.5 حصان", watt: 1100, runningFactor: 0.75, nightHours: 8, dayHours: 8, surgeFactor: 7 },
  { name: "غسالة", watt: 1500, runningFactor: 1, nightHours: 0, dayHours: 2, surgeFactor: 7 },
  { name: "تكييف 2.5 حصان", watt: 1800, runningFactor: 0.5, nightHours: 8, dayHours: 8, surgeFactor: 7 },
  { name: "تكييف 3 حصان", watt: 2200, runningFactor: 0.5, nightHours: 8, dayHours: 8, surgeFactor: 7 },
  { name: "هيتر مياه", watt: 9000, runningFactor: 1, nightHours: 0, dayHours: 2, surgeFactor: 1 },
];

let client = null;
let catalog = { inverters: [], batteries: [], panels: [] };
let bomSettings = null;
let addedLoadIdx = [];
let quoteType = "supply_only";
let lastResult = null;
let quoteRows = []; // { key, label, type, product_id, watt, qty, unitPrice, discountPct }

function $(sel) { return document.querySelector(sel); }
function fmt(n) { return Number(n || 0).toLocaleString("ar-EG", { maximumFractionDigits: 0 }); }

async function initClient() {
  for (let i = 0; i < 50 && !window.getAlaslSupabase; i++) await new Promise((r) => setTimeout(r, 50));
  client = window.getAlaslSupabase ? window.getAlaslSupabase() : null;
  return client;
}

async function checkRepStatus(userId) {
  const { data, error } = await client.from("reps").select("id, display_name, active").eq("id", userId).maybeSingle();
  if (error || !data || !data.active) return null;
  return data;
}

function showMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "error" ? "#b23b23" : kind === "ok" ? "var(--forest)" : "var(--muted)";
}

async function updateAuthState(session) {
  const authPanel = $("[data-auth-panel]");
  const repPanel = $("[data-rep-panel]");
  const userName = $("[data-user-name]");
  if (!session) { authPanel.hidden = false; repPanel.hidden = true; return; }
  const rep = await checkRepStatus(session.user.id);
  if (!rep) { authPanel.hidden = false; repPanel.hidden = true; return; }
  authPanel.hidden = true;
  repPanel.hidden = false;
  userName.textContent = rep.display_name;
  await loadCatalog();
  buildLoadPicker();
}

/* ---------------- الكتالوج ---------------- */

async function loadCatalog() {
  const { data: settings } = await client.from("calc_settings").select("*").eq("id", 1).maybeSingle();
  const { data: bom } = await client.from("offgrid_bom_settings").select("*").eq("id", 1).maybeSingle();
  bomSettings = bom;

  const { data, error } = await client.from("products")
    .select("id,category,brand,model_available,price,voltage_v,power_kw,surge_capacity_pct,pv_voc_max,pv_mppt_min,pv_mppt_max,capacity_ah,dod,power_watt,vimp,voc,in_stock,published,name_ar")
    .in("category", ["offgrid", "batteries", "panels"]);
  if (error || !data) { $("[data-calc-message]").textContent = "تعذر تحميل الكتالوج."; return; }

  const hasPrice = (r) => r.price != null && Number(r.price) > 0;

  catalog.inverters = data.filter((r) => r.category === "offgrid" && r.in_stock !== false && r.published !== false && hasPrice(r))
    .map((r) => ({ id: r.id, brand: r.brand, type: r.model_available || "", voltage: Number(r.voltage_v), powerKW: Number(r.power_kw),
      surgeCapacityPct: r.surge_capacity_pct ? Number(r.surge_capacity_pct) : null,
      pvVocMax: r.pv_voc_max ? Number(r.pv_voc_max) : null, pvMpptMin: r.pv_mppt_min ? Number(r.pv_mppt_min) : null,
      pvMpptMax: r.pv_mppt_max ? Number(r.pv_mppt_max) : null, unitPrice: Number(r.price) }))
    .filter((r) => r.powerKW && r.voltage);

  catalog.batteries = data.filter((r) => r.category === "batteries" && r.in_stock !== false && r.published !== false && hasPrice(r))
    .map((r) => ({ id: r.id, brand: r.brand, voltage: Number(r.voltage_v), ah: Number(r.capacity_ah),
      dod: r.dod ? Number(r.dod) : null, unitPrice: Number(r.price) }))
    .filter((r) => r.voltage && r.ah && r.dod);

  catalog.panels = data.filter((r) => r.category === "panels" && r.in_stock !== false && r.published !== false && hasPrice(r))
    .map((r) => ({ id: r.id, brand: r.brand, power: r.power_watt ? Number(r.power_watt) : null,
      voc: r.voc ? Number(r.voc) : null, vimp: r.vimp ? Number(r.vimp) : null, pricePerWatt: Number(r.price) }));

  fillBrandSelect($("#ogInvBrand"), [...new Set(catalog.inverters.map((r) => r.brand))].sort(), settings?.preferred_offgrid_inverter_brand);
  fillBrandSelect($("#ogBattBrand"), [...new Set(catalog.batteries.map((r) => r.brand))].sort(), settings?.preferred_offgrid_battery_brand);
  fillBrandSelect($("#ogPanelBrand"), [...new Set(catalog.panels.map((r) => r.brand))].sort(), settings?.preferred_offgrid_panel_brand);
}

function fillBrandSelect(sel, brands, preferred) {
  sel.innerHTML = brands.length ? brands.map((b) => `<option value="${b}" ${b === preferred ? "selected" : ""}>${b}</option>`).join("") : `<option value="">لا يوجد</option>`;
}

/* ---------------- الأحمال ---------------- */

function buildLoadPicker() {
  const sel = $("#ogLoadPicker");
  const available = DEFAULT_LOADS.map((l, i) => i).filter((i) => !addedLoadIdx.includes(i));
  sel.innerHTML = available.length ? available.map((i) => `<option value="${i}">${DEFAULT_LOADS[i].name} (${DEFAULT_LOADS[i].watt} وات)</option>`).join("") : `<option value="">كل الأجهزة اتضافت</option>`;
}

function addLoadRow(idx) {
  if (addedLoadIdx.includes(idx)) return;
  addedLoadIdx.push(idx);
  const l = DEFAULT_LOADS[idx];
  const body = $("#ogLoadsBody");
  const tr = document.createElement("tr");
  tr.dataset.idx = idx;
  tr.innerHTML = `
    <td>${l.name}</td><td>${l.watt}</td>
    <td><input type="number" min="1" value="1" data-field="count"></td>
    <td><input type="number" min="0" step="0.5" value="${l.dayHours}" data-field="dayHours"></td>
    <td><input type="number" min="0" step="0.5" value="${l.nightHours}" data-field="nightHours"></td>
    <td><button type="button" class="rq-remove" data-remove="${idx}">حذف</button></td>`;
  tr.querySelector("[data-remove]").addEventListener("click", () => removeLoadRow(idx));
  body.appendChild(tr);
  buildLoadPicker();
}

function removeLoadRow(idx) {
  addedLoadIdx = addedLoadIdx.filter((i) => i !== idx);
  document.querySelector(`#ogLoadsBody tr[data-idx="${idx}"]`)?.remove();
  buildLoadPicker();
}

function readLoads() {
  return addedLoadIdx.map((idx) => {
    const row = document.querySelector(`#ogLoadsBody tr[data-idx="${idx}"]`);
    const l = DEFAULT_LOADS[idx];
    return {
      name: l.name, watt: l.watt, runningFactor: l.runningFactor, surgeFactor: l.surgeFactor,
      count: Number(row.querySelector('[data-field="count"]').value) || 0,
      dayHours: Number(row.querySelector('[data-field="dayHours"]').value) || 0,
      nightHours: Number(row.querySelector('[data-field="nightHours"]').value) || 0,
    };
  }).filter((l) => l.count > 0);
}

/* ---------------- الحساب ---------------- */

function runCalc() {
  const msgEl = $("[data-calc-message]");
  const loads = readLoads();
  if (!loads.length) { showMsg(msgEl, "أضف جهاز واحد على الأقل.", "error"); return; }

  const inputs = {
    loads,
    morningEnabled: $("#ogMorning").checked,
    nightEnabled: $("#ogNight").checked,
    psh: $("#ogPsh").value,
    safetyFactor: 1.1,
    autonomyDays: $("#ogAutonomy").value,
    phase: $("#ogPhase").value,
    invBrand: $("#ogInvBrand").value,
    battBrand: $("#ogBattBrand").value,
    panelBrand: $("#ogPanelBrand").value,
  };
  const gp = {
    steelPerUnit: bomSettings?.steel_customer_per_unit ?? 1500,
    cablesPerMeter: bomSettings?.cables_customer_per_meter ?? 65,
    cableMetersPerSteelUnit: bomSettings?.cable_meters_per_steel_unit ?? 20,
    accessoriesFixed: bomSettings?.accessories_customer_fixed ?? 2500,
    batteryChargeSunHours: bomSettings?.battery_charge_sun_hours ?? 5.5,
    systemEfficiency: bomSettings?.system_efficiency ?? 0.78,
    defaultSurgeCapacityPct: bomSettings?.default_surge_capacity_pct ?? 1.5,
  };

  const result = window.computeOffgridMaterials(catalog, gp, inputs);
  lastResult = result;

  updateBanner();

  if (result.errors && result.errors.length && !result.offer) {
    showMsg(msgEl, result.errors.join(" | "), "error");
    $("[data-quote-section]").hidden = true;
    $("[data-quote-empty]").hidden = false;
    return;
  }
  showMsg(msgEl, result.errors && result.errors.length ? "تنبيه: " + result.errors.join(" | ") : "", result.errors && result.errors.length ? "error" : "ok");

  buildQuoteRows(result);
}

function updateBanner() {
  const name = $("#custName").value.trim();
  const phone = $("#custPhone").value.trim();
  $("#bannerName").textContent = name || "—";
  $("#bannerPhone").textContent = phone || "—";
  $("#bannerDate").textContent = new Date().toLocaleDateString("ar-EG");
}

function buildQuoteRows(result) {
  const steelRow = result.rows.find((r) => r.name === "شاسيه");
  const cablesRow = result.rows.find((r) => r.name === "كابلات");
  const panelUnitTotal = result.rows.find((r) => r.name === "الألواح")?.unitPrice || 0;

  quoteRows = [];
  quoteRows.push({ key: "panel", label: `الألواح — ${result.panel.brand} ${result.panel.power}W`, type: "panel",
    product_id: result.panel.id, watt: result.panel.power, qty: result.panelCount,
    unitPrice: result.panel.pricePerWatt * result.panel.power, discountPct: 0 });
  quoteRows.push({ key: "inverter", label: `انفرتر — ${result.inv.brand} ${result.inv.type}`, type: "product",
    product_id: result.inv.id, qty: result.rows.find((r) => r.name === "انفرتر").qty,
    unitPrice: result.inv.unitPrice, discountPct: 0 });
  quoteRows.push({ key: "steel", label: "شاسيه حديد مجلفن", type: "bom_fixed", bomKey: "steel",
    qty: steelRow.qty, unitPrice: steelRow.unitPrice, discountPct: 0 });
  quoteRows.push({ key: "cables", label: "كابلات 6 مم", type: "bom_fixed", bomKey: "cables",
    qty: cablesRow.qty, unitPrice: cablesRow.unitPrice, discountPct: 0 });
  quoteRows.push({ key: "battery", label: `بطاريات — ${result.batt.brand} ${result.batt.ah}AH-${result.batt.voltage}V`, type: "product",
    product_id: result.batt.id, qty: result.batteryCount, unitPrice: result.batt.unitPrice, discountPct: 0 });
  quoteRows.push({ key: "accessories", label: "إكسسوارات (لوحة تجميع / MC4 / فيوز / قواطع)", type: "bom_fixed", bomKey: "accessories",
    qty: 1, unitPrice: bomSettings?.accessories_customer_fixed ?? 2500, discountPct: 0 });

  if (quoteType === "supply_install") {
    quoteRows.push({ key: "transport", label: "النقل", type: "bom_fixed", bomKey: "transport",
      qty: 1, unitPrice: bomSettings?.transport_customer_fixed ?? 0, discountPct: 0 });
    quoteRows.push({ key: "install", label: "التركيب", type: "bom_fixed", bomKey: "install",
      qty: steelRow.qty, unitPrice: bomSettings?.install_customer_per_unit ?? 0, discountPct: 0 });
  }

  renderQuoteTable();
  $("[data-quote-section]").hidden = false;
  $("[data-quote-empty]").hidden = true;
}

function renderQuoteTable() {
  const body = $("#quoteItemsBody");
  body.innerHTML = "";
  quoteRows.forEach((r, idx) => {
    const lineTotal = r.qty * r.unitPrice * (1 - r.discountPct / 100);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:right;">${r.label}</td>
      <td>${fmt(r.qty)}</td>
      <td>${fmt(r.unitPrice)}</td>
      <td><input type="number" min="0" max="100" value="${r.discountPct}" data-discount-idx="${idx}"></td>
      <td>${fmt(lineTotal)}</td>`;
    body.appendChild(tr);
  });
  document.querySelectorAll("[data-discount-idx]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.discountIdx, 10);
      quoteRows[idx].discountPct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
      renderQuoteTable();
    });
  });
  const grand = quoteRows.reduce((s, r) => s + r.qty * r.unitPrice * (1 - r.discountPct / 100), 0);
  $("#grandTotalDisplay").textContent = fmt(grand);
  const stickyBar = $("[data-sticky-bar]");
  if (stickyBar) {
    $("#stickyTotalDisplay").textContent = fmt(grand);
    stickyBar.hidden = false;
  }
}

/* ---------------- الحفظ ---------------- */

async function saveQuote() {
  const msgEl = $("[data-quote-message]");
  const name = $("#custName").value.trim();
  const phone = $("#custPhone").value.trim();
  const city = $("#custCity").value.trim();
  if (!name || !phone) { showMsg(msgEl, "اسم العميل ورقم التليفون مطلوبين.", "error"); return; }
  if (!quoteRows.length) { showMsg(msgEl, "احسب النظام الأول.", "error"); return; }

  const items = quoteRows.map((r) => {
    if (r.type === "panel") return { type: "panel", product_id: r.product_id, watt: r.watt, qty: r.qty, discount_pct: r.discountPct, label: r.label };
    if (r.type === "product") return { type: "product", product_id: r.product_id, qty: r.qty, discount_pct: r.discountPct, label: r.label };
    return { type: "bom_fixed", key: r.bomKey, qty: r.qty, discount_pct: r.discountPct, label: r.label };
  });

  showMsg(msgEl, "جاري الحفظ...", "");

  const { data: quoteId, error } = await client.rpc("rep_create_offgrid_quote", {
    p_customer_name: name, p_customer_phone: phone, p_customer_city: city || null,
    p_quote_type: quoteType, p_items: items, p_notes: null,
  });

  if (error) { showMsg(msgEl, "خطأ أثناء الحفظ: " + error.message, "error"); return; }

  const { data: saved } = await client.from("quotes").select("id, items, total, created_at").eq("id", quoteId).maybeSingle();
  showMsg(msgEl, "تم حفظ العرض بنجاح.", "ok");

  printQuote({ id: quoteId, customer: { name, phone, city }, quoteType, items: saved?.items || items, total: saved?.total || 0, createdAt: saved?.created_at || new Date() });
}

function printQuote(q) {
  const area = document.getElementById("printArea");
  const dateStr = new Date(q.createdAt).toLocaleDateString("ar-EG");
  const typeLabel = q.quoteType === "supply_install" ? "توريد وتركيب" : "توريد فقط";
  const rows = (q.items || []).map((it) => `
    <tr><td>${it.label}</td><td>${fmt(it.qty)}</td><td>${fmt(it.unit_price)}</td><td>${it.discount_pct || 0}%</td><td>${fmt(it.line_total)}</td></tr>
  `).join("");
  area.innerHTML = `
    <div class="print-header">
      <img src="logo.png" alt="الأصل للطاقة الشمسية">
      <div style="text-align:left;"><div class="print-title">عرض سعر — نظام أوف جريد</div><div>#${q.id} — ${dateStr}</div></div>
    </div>
    <div style="margin-bottom:16px; font-size:13px;">
      <div><strong>العميل:</strong> ${q.customer.name} — ${q.customer.phone}${q.customer.city ? " — " + q.customer.city : ""}</div>
      <div><strong>نوع العرض:</strong> ${typeLabel}</div>
    </div>
    <table class="print-table">
      <thead><tr><th>البند</th><th>الكمية</th><th>سعر الوحدة</th><th>خصم</th><th>الإجمالي</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="print-totals"><div class="row grand"><span>الإجمالي الكلي</span><span>${fmt(q.total)} ج.م</span></div></div>
    <div class="print-footer">الأصل للطاقة الشمسية — alaslsolar.com — هذا العرض قابل للتغيير حسب الأسعار وقت التعاقد.</div>
  `;
  setTimeout(() => window.print(), 100);
}

/* ---------------- ربط الأحداث ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  await initClient();
  if (!client) return;

  $("#ogAddLoadBtn").addEventListener("click", () => {
    const v = $("#ogLoadPicker").value;
    if (v !== "") addLoadRow(Number(v));
  });
  $("#ogCalcBtn").addEventListener("click", runCalc);
  $("#saveQuoteBtn").addEventListener("click", saveQuote);
  $("#custName").addEventListener("input", updateBanner);
  $("#custPhone").addEventListener("input", updateBanner);
  document.querySelectorAll(".rq-type-btn").forEach((b) => b.addEventListener("click", () => {
    quoteType = b.dataset.quoteType;
    document.querySelectorAll(".rq-type-btn").forEach((x) => x.classList.toggle("active", x === b));
    if (lastResult) buildQuoteRows(lastResult);
  }));

  client.auth.onAuthStateChange((_e, session) => updateAuthState(session));
  const { data } = await client.auth.getSession();
  await updateAuthState(data.session);
});
