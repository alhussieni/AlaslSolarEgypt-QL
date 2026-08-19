/* ============================================================
   rep-irrigation-solar-quote.js
   حاسبة تشغيل منظومة ري بالطاقة الشمسية: إنفرتر ضخ شمسي + ألواح +
   كابلات + مكونات المنظومة. منفصلة تمامًا عن عرض سعر البئر
   (موتور+طلمبة+مواسير في rep-irrigation-quote.html).
   بدون تحجيم على قدرة الألواح فوق الإنفرتر (1:1) بناءً على طلب العميل.
   الحفظ عبر rep_create_offgrid_quote() نفسها (بنفس منطق حساب
   التكلفة/الربح من السيرفر، مفيش فرق بنيوي بين النوعين).
   ============================================================ */

let client = null;
let bomSettings = null;
let quoteType = "supply_only";
let quoteRows = [];

function $(sel) { return document.querySelector(sel); }
function fmt(n) { return Number(n || 0).toLocaleString("ar-EG", { maximumFractionDigits: 0 }); }

function showMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "error" ? "#b23b23" : kind === "ok" ? "var(--forest)" : "var(--muted)";
}

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
  await loadPanelBrands();
}

async function loadPanelBrands() {
  const { data: bom } = await client.from("offgrid_bom_settings").select("*").eq("id", 1).maybeSingle();
  bomSettings = bom;

  const { data } = await client.from("products").select("brand").eq("category", "panels").eq("published", true);
  const brands = [...new Set((data || []).map((r) => r.brand).filter(Boolean))].sort();
  $("#panelBrandSelect").innerHTML = brands.length
    ? brands.map((b) => `<option value="${b}">${b}</option>`).join("")
    : `<option value="">لا يوجد</option>`;
}

/* ---------------- الحساب ---------------- */

async function runCalc() {
  const msgEl = $("[data-calc-message]");
  const hp = parseFloat($("#hpInput").value);
  const panelBrand = $("#panelBrandSelect").value;
  if (!hp || hp <= 0) { showMsg(msgEl, "اكتب قدرة صحيحة بالحصان.", "error"); return; }
  if (!panelBrand) { showMsg(msgEl, "مفيش ماركة ألواح متاحة.", "error"); return; }

  showMsg(msgEl, "جاري البحث في الكتالوج...", "");

  const { data: invs, error: invErr } = await client.from("products")
    .select("id,brand,name_ar,price,power_hp,power_kw,pv_voc_max,pv_mppt_min,pv_mppt_max")
    .eq("category", "inverters").eq("published", true).eq("in_stock", true)
    .not("price", "is", null).gt("price", 0);
  if (invErr || !invs || !invs.length) { showMsg(msgEl, "تعذر تحميل إنفرترات الضخ الشمسي.", "error"); return; }

  const withHp = invs.filter((r) => r.power_hp != null);
  const atOrAbove = withHp.filter((r) => Number(r.power_hp) >= hp).sort((a, b) => a.power_hp - b.power_hp);
  const inverter = atOrAbove[0] || withHp.sort((a, b) => b.power_hp - a.power_hp)[0];
  if (!inverter) { showMsg(msgEl, `مفيش إنفرتر ضخ شمسي بقدرة قريبة من ${hp} حصان في الكتالوج.`, "error"); return; }

  const { data: panels, error: panelErr } = await client.from("products")
    .select("id,brand,name_ar,price,power_watt,voc,vimp")
    .eq("category", "panels").eq("published", true).eq("brand", panelBrand)
    .not("price", "is", null).gt("price", 0).limit(1);
  if (panelErr || !panels || !panels.length) { showMsg(msgEl, `مفيش لوح متاح لماركة ${panelBrand}.`, "error"); return; }
  const panel = panels[0];

  const panelWatt = Number(panel.power_watt) || 0;
  if (!panelWatt) { showMsg(msgEl, "بيانات قدرة اللوح ناقصة.", "error"); return; }

  const requiredWatts = Number(inverter.power_kw) * 1000; // بدون تحجيم — 1:1
  const panelCount = Math.max(Math.ceil(requiredWatts / panelWatt), 1);
  const hasEngineeringData = !!(inverter.pv_voc_max && panel.voc && panel.vimp);

  const steelQty = Math.max(Math.ceil(panelCount / 2), 1);
  const cablesQty = steelQty * (bomSettings?.cable_meters_per_steel_unit ?? 20);

  quoteRows = [
    { label: `إنفرتر ضخ شمسي — ${inverter.brand} — ${inverter.name_ar}`, type: "product", productId: inverter.id, qty: 1, unitPrice: Number(inverter.price), discountPct: 0 },
    { label: `الألواح — ${panel.brand} ${panelWatt}W`, type: "panel", productId: panel.id, watt: panelWatt, qty: panelCount, unitPrice: panelWatt * (Number(panel.price) || 0), discountPct: 0 },
    { label: "شاسيه حديد مجلفن", type: "bom_fixed", bomKey: "steel", qty: steelQty, unitPrice: bomSettings?.steel_customer_per_unit ?? 1500, discountPct: 0 },
    { label: "كابلات DC", type: "bom_fixed", bomKey: "cables", qty: cablesQty, unitPrice: bomSettings?.cables_customer_per_meter ?? 65, discountPct: 0 },
    { label: "إكسسوارات (لوحة تجميع / MC4 / فيوز / قواطع)", type: "bom_fixed", bomKey: "accessories", qty: 1, unitPrice: bomSettings?.accessories_customer_fixed ?? 2500, discountPct: 0 },
  ];

  $("[data-eng-warning]").hidden = hasEngineeringData;
  showMsg(msgEl, `تم اختيار إنفرتر ${inverter.power_kw} كيلوواط و${panelCount} لوح.`, "ok");
  $("[data-quote-content]").hidden = false;
  renderQuoteTable();
  updateBanner();
  $("[data-quote-content]").scrollIntoView({ behavior: "smooth" });
}

function updateBanner() {
  $("#bannerName").textContent = $("#custName").value.trim() || "—";
  $("#bannerPhone").textContent = $("#custPhone").value.trim() || "—";
  $("#bannerDate").textContent = new Date().toLocaleDateString("ar-EG");
}

/* ---------------- جدول العرض ---------------- */

function renderQuoteTable() {
  const rows = [...quoteRows];
  if (quoteType === "supply_install" && !rows.some((r) => r.bomKey === "transport")) {
    rows.push({ label: "النقل", type: "bom_fixed", bomKey: "transport", qty: 1, unitPrice: bomSettings?.transport_customer_fixed ?? 0, discountPct: 0 });
    rows.push({ label: "التركيب", type: "bom_fixed", bomKey: "install", qty: quoteRows.find((r) => r.bomKey === "steel")?.qty || 1, unitPrice: bomSettings?.install_customer_per_unit ?? 0, discountPct: 0 });
  }
  quoteRows = rows;

  const body = $("#quoteItemsBody");
  body.innerHTML = "";
  rows.forEach((r, idx) => {
    const lineTotal = r.qty * r.unitPrice * (1 - r.discountPct / 100);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="bom-label">${r.label}</td>
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
  const grand = rows.reduce((s, r) => s + r.qty * r.unitPrice * (1 - r.discountPct / 100), 0);
  $("#grandTotalDisplay").textContent = fmt(grand);
}

/* ---------------- الحفظ ---------------- */

async function saveQuote() {
  const msgEl = $("[data-quote-message]");
  const name = $("#custName").value.trim();
  const phone = $("#custPhone").value.trim();
  const city = $("#custCity").value.trim();
  if (!name || !phone) { showMsg(msgEl, "اسم العميل ورقم التليفون مطلوبين.", "error"); return; }
  if (!quoteRows.length) { showMsg(msgEl, "احسب المنظومة الأول.", "error"); return; }

  const items = quoteRows.map((r) => {
    if (r.type === "panel") return { type: "panel", product_id: r.productId, watt: r.watt, qty: r.qty, discount_pct: r.discountPct, label: r.label };
    if (r.type === "product") return { type: "product", product_id: r.productId, qty: r.qty, discount_pct: r.discountPct, label: r.label };
    return { type: "bom_fixed", key: r.bomKey, qty: r.qty, discount_pct: r.discountPct, label: r.label };
  });

  showMsg(msgEl, "جاري الحفظ...", "");

  const { data: quoteId, error } = await client.rpc("rep_create_offgrid_quote", {
    p_customer_name: name, p_customer_phone: phone, p_customer_city: city || null,
    p_quote_type: quoteType, p_items: items, p_notes: "تشغيل منظومة ري بالطاقة الشمسية",
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
      <img src="../logo.png" alt="الأصل للطاقة الشمسية">
      <div style="text-align:left;"><div class="print-title">عرض سعر — تشغيل منظومة ري بالطاقة الشمسية</div><div>#${q.id} — ${dateStr}</div></div>
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
    <div class="print-footer">الأصل للطاقة الشمسية — alaslsolar.com — هذا العرض قابل للتغيير حسب الأسعار وقت التعاقد. عرض سعر منفصل عن تكاليف البئر (الموتور والطلمبة والمواسير).</div>
  `;
  setTimeout(() => window.print(), 100);
}

/* ---------------- ربط الأحداث ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  await initClient();
  if (!client) return;

  $("#calcBtn")?.addEventListener("click", runCalc);
  $("#saveQuoteBtn")?.addEventListener("click", saveQuote);
  $("#custName")?.addEventListener("input", updateBanner);
  $("#custPhone")?.addEventListener("input", updateBanner);
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    quoteType = b.dataset.quoteType;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x === b));
    renderQuoteTable();
  }));

  client.auth.onAuthStateChange((_e, session) => updateAuthState(session));
  const { data } = await client.auth.getSession();
  await updateAuthState(data.session);
});
