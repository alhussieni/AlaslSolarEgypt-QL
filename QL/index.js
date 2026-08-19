/* ============================================================
   QL/index.js
   بوابة الدخول الموحّدة للمناديب — تسجيل دخول عبر Supabase Auth
   الحقيقي، والتحقق من جدول reps، ثم عرض كروت الأدوات المتاحة.
   ============================================================ */

let client = null;

function $(sel) { return document.querySelector(sel); }

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
  const authMsg = $("[data-auth-message]");
  const userName = $("[data-user-name]");

  if (!session) {
    authPanel.hidden = false;
    repPanel.hidden = true;
    return;
  }

  const rep = await checkRepStatus(session.user.id);
  if (!rep) {
    authMsg.textContent = "هذا الحساب غير مفعّل كمندوب. تواصل مع الأدمن.";
    await client.auth.signOut();
    authPanel.hidden = false;
    repPanel.hidden = true;
    return;
  }

  authPanel.hidden = true;
  repPanel.hidden = false;
  userName.textContent = rep.display_name;
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const authMsg = $("[data-auth-message]");
  authMsg.textContent = "جاري الدخول...";

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    authMsg.textContent = "بيانات الدخول غير صحيحة.";
    return;
  }
  authMsg.textContent = "";
  await updateAuthState(data.session);
}

async function handleLogout() {
  await client.auth.signOut();
  await updateAuthState(null);
}

document.addEventListener("DOMContentLoaded", async () => {
  await initClient();
  if (!client) {
    $("[data-auth-message]").textContent = "تعذر الاتصال بالخادم.";
    return;
  }

  $("[data-login-form]").addEventListener("submit", handleLogin);
  $("[data-logout]").addEventListener("click", handleLogout);

  client.auth.onAuthStateChange((_e, session) => updateAuthState(session));
  const { data } = await client.auth.getSession();
  await updateAuthState(data.session);
});
