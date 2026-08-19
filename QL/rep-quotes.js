/* ============================================================
   rep-quotes.js
   منطق صفحة عروض الأسعار الخاصة بالمناديب.
   يعتمد على supabase-config.js (نفس إعدادات باقي الموقع).
   ============================================================ */

const CATEGORY_LABELS = {
  pumps: "مضخات",
  well_motors: "موتورات آبار",
  inverters: "إنفرترات",
  garden_lights: "إنارة حدائق",
  pipes: "مواسير",
  panels: "ألواح شمسية",
  accessories: "إكسسوارات",
  street_lights: "إنارة شوارع",
  combiners: "صناديق تجميع",
  batteries: "بطاريات",
  offgrid: "أنظمة أوف جريد",
  flood_lights: "كشافات",
  solar_safety: "حماية وأمان",
  structures: "شاسيهات",
  cables: "كابلات",
  solar_kits: "باقات شمسية",
};

let client = null;
let currentSession = null;
let cart = []; // { productId, name, unitPrice, qty }
let quoteType = "supply_only";

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function fmt(n) {
  return Number(n || 0).toLocaleString("ar-EG", { maximumFractionDigits: 0 });
}

async function initClient() {
  // ننتظر تحميل مكتبة supabase و supabase-config.js (defer)
  for (let i = 0; i < 50 && !window.getAlaslSupabase; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  client = window.getAlaslSupabase ? window.getAlaslSupabase() : null;
  return client;
}

async function checkRepStatus(userId) {
  const { data, error } = await client
    .from("reps")
    .select("id, display_name, active")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data || !data.active) return null;
  return data;
}

async function updateAuthState(session) {
  currentSession = session;
  const authPanel = $("[data-auth-panel]");
  const repPanel = $("[data-rep-panel]");
  const logoutBtn = $("[data-logout]");
  const userName = $("[data-user-name]");
  const authMsg = $("[data-auth-message]");

  if (!session) {
    authPanel.hidden = false;
    repPanel.hidden = true;
    logoutBtn.hidden = true;
    userName.textContent = "";
    return;
  }

  const rep = await checkRepStatus(session.user.id);
  if (!rep) {
    authMsg.textContent = "هذا الحساب غير مفعّل كمندوب. تواصل مع الأدمن.";
    authMsg.className = "rq-msg error";
    await client.auth.signOut();
    authPanel.hidden = false;
    repPanel.hidden = true;
    logoutBtn.hidden = true;
    return;
  }

  authPanel.hidden = true;
  repPanel.hidden = false;
  logoutBtn.hidden = false;
  userName.textContent = rep.display_name;

  await loadCategories();
  await loadMyQuotes();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const authMsg = $("[data-auth-message]");
  authMsg.textContent = "جاري الدخول...";
  authMsg.className = "rq-msg";

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    authMsg.textContent = "بيانات الدخول غير صحيحة.";
    authMsg.className = "rq-msg error";
    return;
  }
  authMsg.textContent = "";
  await updateAuthState(data.session);
}

async function handleLogout() {
  await client.auth.signOut();
  await updateAuthState(null);
}

/* ---------------- المنتجات ---------------- */

async function loadCategories() {
  const sel = $("#categorySelect");
  sel.innerHTML = "";
  Object.entries(CATEGORY_LABELS).forEach(([key, label]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", loadProductsForCategory);
  await loadProductsForCategory();
}

async function loadProductsForCategory() {
  const category = $("#categorySelect").value;
  const productSel = $("#productSelect");
  productSel.innerHTML = "<option>...جاري التحميل</option>";

  const { data, error } = await client
    .from("products")
    .select("id, name_ar, name_en, price")
    .eq("category", category)
    .eq("published", true)
    .order("name_ar", { ascending: true });

  productSel.innerHTML = "";
  if (error || !data) {
    productSel.innerHTML = "<option>تعذر تحميل المنتجات</option>";
    return;
  }
  data.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.dataset.name = p.name_ar || p.name_en || "منتج";
    opt.dataset.price = p.price || 0;
    opt.textContent = `${p.name_ar || p.name_en || "منتج"} — ${fmt(p.price)} ج.م`;
    productSel.appendChild(opt);
  });
}

function addProductToCart() {
  const productSel = $("#productSelect");
  const opt = productSel.selectedOptions[0];
  if (!opt) return;
  const qty = Math.max(1, parseInt($("#qtyInput").value, 10) || 1);

  const existing = cart.find((c) => c.productId === opt.value);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      productId: opt.value,
      name: opt.dataset.name,
      unitPrice: parseFloat(opt.dataset.price) || 0,
      qty,
    });
  }
  renderCart();
}

function renderCart() {
  const body = $("#cartBody");
  body.innerHTML = "";
  cart.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${fmt(item.unitPrice)}</td>
      <td><input type="number" min="1" value="${item.qty}" data-idx="${idx}" class="cart-qty"></td>
      <td>${fmt(item.unitPrice * item.qty)}</td>
      <td><button type="button" class="rq-remove" data-idx="${idx}">حذف</button></td>
    `;
    body.appendChild(tr);
  });
  $$(".cart-qty").forEach((inp) => {
    inp.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      cart[idx].qty = Math.max(1, parseInt(e.target.value, 10) || 1);
      renderCart();
    });
  });
  $$(".rq-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      cart.splice(idx, 1);
      renderCart();
    });
  });
  updateTotals();
}

function updateTotals() {
  const subtotal = cart.reduce((s, c) => s + c.unitPrice * c.qty, 0);
  const installCost = quoteType === "supply_install" ? (parseFloat($("#installCost").value) || 0) : 0;
  const grand = subtotal + installCost;
  $("#subtotalDisplay").textContent = fmt(subtotal);
  $("#installTotalDisplay").textContent = fmt(installCost);
  $("#grandTotalDisplay").textContent = fmt(grand);
  $("[data-install-total-row]").hidden = quoteType !== "supply_install";
  return { subtotal, installCost, grand };
}

/* ---------------- نوع العرض ---------------- */

function setQuoteType(type) {
  quoteType = type;
  $$(".rq-type-btn").forEach((b) => b.classList.toggle("active", b.dataset.quoteType === type));
  $("[data-install-cost-wrap]").hidden = type !== "supply_install";
  updateTotals();
}

/* ---------------- حفظ العرض ---------------- */

async function saveQuote() {
  const msg = $("[data-quote-message]");
  const name = $("#custName").value.trim();
  const phone = $("#custPhone").value.trim();
  const city = $("#custCity").value.trim();

  if (!name || !phone) {
    msg.textContent = "اسم العميل ورقم التليفون مطلوبين.";
    msg.className = "rq-msg error";
    return;
  }
  if (cart.length === 0) {
    msg.textContent = "أضف منتج واحد على الأقل للعرض.";
    msg.className = "rq-msg error";
    return;
  }

  const { subtotal, installCost, grand } = updateTotals();

  msg.textContent = "جاري الحفظ...";
  msg.className = "rq-msg";

  const { data, error } = await client.rpc("rep_create_quote", {
    p_customer_name: name,
    p_customer_phone: phone,
    p_customer_city: city || null,
    p_quote_type: quoteType,
    p_items: cart.map((c) => ({ name: c.name, unit_price: c.unitPrice, qty: c.qty, line_total: c.unitPrice * c.qty })),
    p_subtotal: subtotal,
    p_installation_cost: installCost,
    p_total: grand,
    p_notes: null,
  });

  if (error) {
    msg.textContent = "حصل خطأ أثناء الحفظ: " + error.message;
    msg.className = "rq-msg error";
    return;
  }

  msg.textContent = "تم حفظ العرض بنجاح.";
  msg.className = "rq-msg ok";

  printQuote({
    id: data,
    customer: { name, phone, city },
    quoteType,
    items: cart,
    subtotal,
    installCost,
    grand,
    createdAt: new Date(),
  });

  await loadMyQuotes();
}

/* ---------------- الطباعة ---------------- */

function printQuote(q) {
  const area = document.getElementById("printArea");
  const dateStr = new Date(q.createdAt).toLocaleDateString("ar-EG");
  const typeLabel = q.quoteType === "supply_install" ? "توريد وتركيب" : "توريد فقط";

  const rows = q.items.map((it) => `
    <tr>
      <td>${it.name}</td>
      <td>${it.qty}</td>
      <td>${fmt(it.unit_price ?? it.unitPrice)}</td>
      <td>${fmt((it.unit_price ?? it.unitPrice) * it.qty)}</td>
    </tr>
  `).join("");

  area.innerHTML = `
    <div class="print-header">
      <img src="logo.png" alt="الأصل للطاقة الشمسية">
      <div style="text-align:left;">
        <div class="print-title">عرض سعر</div>
        <div>#${q.id} — ${dateStr}</div>
      </div>
    </div>
    <div class="print-meta">
      <div><strong>العميل:</strong> ${q.customer.name} — ${q.customer.phone}${q.customer.city ? " — " + q.customer.city : ""}</div>
      <div><strong>نوع العرض:</strong> ${typeLabel}</div>
    </div>
    <table class="print-table">
      <thead><tr><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="print-totals">
      <div class="row"><span>الإجمالي قبل التركيب</span><span>${fmt(q.subtotal)} ج.م</span></div>
      ${q.quoteType === "supply_install" ? `<div class="row"><span>تكلفة التركيب</span><span>${fmt(q.installCost)} ج.م</span></div>` : ""}
      <div class="row grand"><span>الإجمالي الكلي</span><span>${fmt(q.grand)} ج.م</span></div>
    </div>
    <div class="print-footer">الأصل للطاقة الشمسية — alaslsolar.com — هذا العرض قابل للتغيير حسب الأسعار وقت التعاقد.</div>
  `;

  setTimeout(() => window.print(), 100);
}

/* ---------------- عروضي السابقة ---------------- */

async function loadMyQuotes() {
  const list = $("#myQuotesList");
  list.innerHTML = "جاري التحميل...";

  const { data, error } = await client
    .from("quotes")
    .select("id, created_at, quote_type, total, items, customers(name, phone, city)")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    list.innerHTML = "تعذر تحميل العروض السابقة.";
    return;
  }
  if (!data || data.length === 0) {
    list.innerHTML = "<p style='color:var(--muted)'>لسه معملتش أي عرض سعر.</p>";
    return;
  }

  list.innerHTML = "";
  data.forEach((q) => {
    const row = document.createElement("div");
    row.className = "rq-quote-item";
    const dateStr = new Date(q.created_at).toLocaleDateString("ar-EG");
    row.innerHTML = `
      <div>#${q.id} — ${q.customers?.name || "بدون اسم"} (${q.customers?.phone || ""}) — ${dateStr} — ${fmt(q.total)} ج.م</div>
      <button type="button" class="btn" data-reprint="${q.id}">طباعة</button>
    `;
    list.appendChild(row);

    row.querySelector("[data-reprint]").addEventListener("click", () => {
      printQuote({
        id: q.id,
        customer: q.customers || {},
        quoteType: q.quote_type,
        items: q.items || [],
        subtotal: q.items ? q.items.reduce((s, it) => s + (it.unit_price ?? it.unitPrice) * it.qty, 0) : 0,
        installCost: q.total - (q.items ? q.items.reduce((s, it) => s + (it.unit_price ?? it.unitPrice) * it.qty, 0) : 0),
        grand: q.total,
        createdAt: q.created_at,
      });
    });
  });
}

/* ---------------- ربط الأحداث ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  await initClient();
  if (!client) {
    $("[data-auth-message]").textContent = "تعذر الاتصال بالخادم.";
    return;
  }

  $("[data-login-form]").addEventListener("submit", handleLogin);
  $("[data-logout]").addEventListener("click", handleLogout);
  $("#addProductBtn").addEventListener("click", addProductToCart);
  $("#saveQuoteBtn").addEventListener("click", saveQuote);
  $("#installCost").addEventListener("input", updateTotals);
  $$(".rq-type-btn").forEach((b) => b.addEventListener("click", () => setQuoteType(b.dataset.quoteType)));

  client.auth.onAuthStateChange((_event, session) => {
    updateAuthState(session);
  });

  const { data } = await client.auth.getSession();
  await updateAuthState(data.session);

  // استقبال سلة جاية من حاسبة المضخات أو الأوف جريد (لو المندوب جه من هناك)
  try {
    const incoming = sessionStorage.getItem("alasl_rep_cart");
    if (incoming) {
      const items = JSON.parse(incoming);
      if (Array.isArray(items) && items.length) {
        items.forEach((it) => {
          cart.push({
            productId: null,
            name: it.name,
            unitPrice: parseFloat(it.price) || 0,
            qty: parseInt(it.qty, 10) || 1,
          });
        });
        renderCart();
        $("[data-quote-message]").textContent = "تم استيراد نتيجة الحاسبة — راجع الأصناف والأسعار قبل الحفظ.";
        $("[data-quote-message]").className = "rq-msg ok";
      }
      sessionStorage.removeItem("alasl_rep_cart");
    }
  } catch (e) {
    // تجاهل أي خطأ في قراءة السلة القادمة، مش سبب لإيقاف الصفحة
  }
});
