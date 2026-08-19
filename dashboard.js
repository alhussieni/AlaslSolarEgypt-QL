const client = getAlaslSupabase();

// التنقل بين أقسام لوحة التحكم (سايدبار) — يعرض قسم واحد بس في كل مرة
function showDashSection(targetId, btn) {
  document.querySelectorAll('.dash-main > [id^="section-"]').forEach(el => {
    el.style.display = (el.id === targetId) ? '' : 'none';
  });
  document.querySelectorAll('.dash-nav-item').forEach(el => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function setText(selector, text) {
  const element = document.querySelector(selector);
  if (element) element.textContent = text || "";
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    // Only keep Latin letters/digits, Arabic base letters (U+0621–U+064A),
    // and Arabic-Indic digits (U+0660–U+0669). Everything else — including
    // Arabic punctuation like "؟" (U+061F), "،" (U+060C), "؛" (U+061B),
    // and diacritics — gets collapsed to a hyphen instead of leaking into
    // the URL. The previous \u0600-\u06ff range wrongly included that
    // punctuation block, which is how "؟" ended up literally inside a
    // generated slug/URL.
    .replace(/[^a-z0-9\u0621-\u064A\u0660-\u0669]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fileExtension(file) {
  return file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "jpg";
}

/* ═══════════════════════════════════════════
   AUTO TRANSLATION (MyMemory, free CORS-enabled API)
   ═══════════════════════════════════════════ */

const MYMEMORY_URL = "https://api.mymemory.translated.net/get";

// Protects formatting syntax from being mangled by the translator:
// - Legacy Markdown tokens (old articles written as plain Markdown text)
// - HTML tags (new articles written with the rich text editor)
// Placeholders use a rare symbol (§) so the translator treats them as a
// single opaque token instead of trying to "helpfully" translate brackets.
function protectMarkdown(text) {
  const tokens = [];
  let i = 0;

  const capture = (match) => {
    tokens.push(match);
    const placeholder = `§${i}§`;
    i += 1;
    return placeholder;
  };

  // First protect HTML tags (e.g. <h2>, </strong>, <img src="...">),
  // then protect legacy Markdown tokens in whatever plain text remains.
  let protected_ = String(text || "").replace(/<\/?[a-zA-Z][^>]*>/g, capture);
  protected_ = protected_.replace(
    /(^#{1,6}\s|\*\*[^*]+\*\*|^>\s|`[^`]+`|^-{3,}$)/gm,
    capture
  );

  return { protected_, tokens };
}

function restoreMarkdown(translatedText, tokens) {
  return tokens.reduce(
    (text, token, index) => text.replace(`§${index}§`, token).replace(`§ ${index}§`, token),
    translatedText
  );
}

// MyMemory enforces a tight ~500 byte limit per request, and Arabic
// characters take 2-3 bytes each in UTF-8, so we keep chunks conservatively
// short (measured in bytes, not characters) and cut on sentence/paragraph
// boundaries where possible.
function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function splitIntoChunks(text, maxBytes = 420) {
  if (byteLength(text) <= maxBytes) return [text];

  const chunks = [];
  let remaining = text;

  while (byteLength(remaining) > maxBytes) {
    // Binary-search-ish: start from a character estimate, then shrink
    // until the slice fits within maxBytes, preferring to cut on a
    // paragraph/sentence/space boundary near that point.
    let approxChars = Math.floor(maxBytes / 2); // worst case ~2 bytes/char for Arabic
    let cut = Math.min(approxChars, remaining.length);

    while (cut > 10 && byteLength(remaining.slice(0, cut)) > maxBytes) {
      cut -= 10;
    }

    let niceCut = remaining.lastIndexOf("\n", cut);
    if (niceCut < cut * 0.4) niceCut = remaining.lastIndexOf(". ", cut);
    if (niceCut < cut * 0.4) niceCut = remaining.lastIndexOf(" ", cut);
    if (niceCut < cut * 0.4) niceCut = cut;

    const finalCut = Math.max(niceCut, 1);
    chunks.push(remaining.slice(0, finalCut));
    remaining = remaining.slice(finalCut);
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateText(text, targetLang) {
  if (!text || !text.trim()) return "";

  const { protected_, tokens } = protectMarkdown(text);
  const chunks = splitIntoChunks(protected_);
  const translatedChunks = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk.trim()) {
      translatedChunks.push(chunk);
      continue;
    }

    const params = new URLSearchParams({
      q: chunk,
      langpair: `ar|${targetLang}`,
      de: "info@alaslsolar.com",
    });
    const response = await fetch(`${MYMEMORY_URL}?${params}`);

    if (!response.ok) {
      throw new Error(`Translation failed (${targetLang}): ${response.status}`);
    }

    const data = await response.json();
    if (data.responseStatus && Number(data.responseStatus) !== 200) {
      throw new Error(`Translation failed (${targetLang}): ${data.responseDetails || data.responseStatus}`);
    }

    translatedChunks.push(data?.responseData?.translatedText || chunk);

    // Small pacing delay between requests to stay well under MyMemory's
    // rate limits when a long article is split into many chunks.
    if (i < chunks.length - 1) await sleep(300);
  }

  return restoreMarkdown(translatedChunks.join(""), tokens);
}

async function translateArticleFields(article) {
  const targets = ["en", "es", "zh"];
  const result = {};

  for (const lang of targets) {
    result[`title_${lang}`] = await translateText(article.title_ar, lang);
    result[`summary_${lang}`] = await translateText(article.summary_ar, lang);
    result[`content_${lang}`] = await translateText(article.content_ar, lang);
  }

  return result;
}

async function uploadImage(file, folder) {
  if (!file || file.size === 0) return "";
  const safeName = `${folder}/${Date.now()}-${Math.random().toString(16).slice(2)}.${fileExtension(file)}`;
  const { error } = await client.storage.from("site-media").upload(safeName, file, {
    cacheControl: "3600",
    upsert: false
  });
  if (error) throw error;
  const { data } = client.storage.from("site-media").getPublicUrl(safeName);
  return data.publicUrl;
}

async function requireSession() {
  const { data } = await client.auth.getSession();
  updateAuthState(data.session);
}

/* ═══════════════════════════════════════════
   RICH TEXT EDITOR (Al Asl Editor / TipTap)
   ═══════════════════════════════════════════ */

const RTE_FONTS = [
  { label: "الخط الافتراضي", value: "" },
  { label: "Cairo", value: "Cairo, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
];

const RTE_SIZES = [
  { label: "صغير", value: "13px" },
  { label: "عادي", value: "16px" },
  { label: "متوسط", value: "20px" },
  { label: "كبير", value: "26px" },
  { label: "كبير جدًا", value: "34px" },
];

const alaslEditors = {}; // keyed by suffix, e.g. "new" or article id

function rteToolbarHtml(suffix) {
  const fontOptions = RTE_FONTS.map(f => `<option value="${f.value}">${f.label}</option>`).join("");
  const sizeOptions = RTE_SIZES.map(s => `<option value="${s.value}">${s.label}</option>`).join("");
  return `
    <div class="rte-group">
      <select class="rte-select" onchange="rteSetFont('${suffix}', this.value)">${fontOptions}</select>
      <select class="rte-select" onchange="rteSetSize('${suffix}', this.value)">${sizeOptions}</select>
    </div>
    <div class="rte-group">
      <button type="button" class="rte-btn" title="عريض" onclick="rteCmd('${suffix}','toggleBold')"><b>B</b></button>
      <button type="button" class="rte-btn" title="مائل" onclick="rteCmd('${suffix}','toggleItalic')"><i>I</i></button>
      <button type="button" class="rte-btn" title="عنوان كبير" onclick="rteHeading('${suffix}',1)">H1</button>
      <button type="button" class="rte-btn" title="عنوان متوسط" onclick="rteHeading('${suffix}',2)">H2</button>
      <button type="button" class="rte-btn" title="عنوان صغير" onclick="rteHeading('${suffix}',3)">H3</button>
    </div>
    <div class="rte-group">
      <button type="button" class="rte-btn" title="قائمة نقطية" onclick="rteCmd('${suffix}','toggleBulletList')">•≡</button>
      <button type="button" class="rte-btn" title="اقتباس" onclick="rteCmd('${suffix}','toggleBlockquote')">"</button>
      <button type="button" class="rte-btn" title="محاذاة لليمين" onclick="rteAlign('${suffix}','right')">⇥</button>
      <button type="button" class="rte-btn" title="محاذاة للوسط" onclick="rteAlign('${suffix}','center')">≡</button>
    </div>
    <div class="rte-group">
      <button type="button" class="rte-btn rte-img-btn" title="إدراج صورة هنا" onclick="rteInsertImagePrompt('${suffix}')">🖼 إدراج صورة</button>
    </div>
  `;
}

function initRichEditor(suffix, { initialHtml, hiddenFieldId, editorElId } = {}) {
  const toolbarEl = document.querySelector(`[data-rte-toolbar="${suffix}"]`);
  const editorEl = document.getElementById(editorElId || `articleContentEditor_${suffix}`);
  if (!toolbarEl || !editorEl || !window.AlaslEditor) return;

  toolbarEl.innerHTML = rteToolbarHtml(suffix);
  editorEl.innerHTML = "";

  const editor = window.AlaslEditor.create({
    element: editorEl,
    content: initialHtml || "<p></p>",
    onUpdate: (html) => {
      const hidden = document.getElementById(hiddenFieldId);
      if (hidden) hidden.value = html;
    },
  });

  alaslEditors[suffix] = editor;
  const hidden = document.getElementById(hiddenFieldId);
  if (hidden) hidden.value = editor.getHTML();
}

function rteCmd(suffix, command) {
  const editor = alaslEditors[suffix];
  if (editor && editor.commands[command]) editor.commands[command]();
}

function rteHeading(suffix, level) {
  const editor = alaslEditors[suffix];
  if (editor) editor.commands.toggleHeading({ level });
}

function rteAlign(suffix, align) {
  const editor = alaslEditors[suffix];
  if (editor) editor.commands.setTextAlign(align);
}

function rteSetFont(suffix, fontFamily) {
  const editor = alaslEditors[suffix];
  if (!editor) return;
  if (fontFamily) editor.commands.setFontFamily(fontFamily);
  else editor.commands.unsetFontFamily();
}

function rteSetSize(suffix, size) {
  const editor = alaslEditors[suffix];
  if (!editor) return;
  if (size) editor.commands.setFontSize(size);
  else editor.commands.unsetFontSize();
}

async function rteInsertImagePrompt(suffix) {
  const editor = alaslEditors[suffix];
  if (!editor) return;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, "articles-inline");
      editor.chain().focus().setImage({ src: url }).run();
    } catch (e) {
      alert("فشل رفع الصورة: " + e.message);
    }
  };
  input.click();
}

function openNewArticleEditor() {
  if (alaslEditors["new"]) return; // already initialized
  initRichEditor("new", { initialHtml: "<p></p>", hiddenFieldId: "articleContent_ar" });
}

function openNewProjectEditor() {
  if (alaslEditors["proj_new"]) return; // already initialized
  initRichEditor("proj_new", { initialHtml: "<p></p>", hiddenFieldId: "projectContent", editorElId: "projectContentEditor_proj_new" });
}

function updateAuthState(session) {
  const authPanel = document.querySelector("[data-auth-panel]");
  const dashboard = document.querySelector("[data-dashboard]");

  if (session) {
    authPanel.hidden = true;
    dashboard.hidden = false;
    setText("[data-user-email]", session.user.email);
    loadLists();
  } else {
    authPanel.hidden = false;
    dashboard.hidden = true;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  setText("[data-auth-message]", "Logging in...");

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    setText("[data-auth-message]", error.message);
    return;
  }

  setText("[data-auth-message]", "");
  updateAuthState(data.session);
}

async function handleLogout() {
  await client.auth.signOut();
  updateAuthState(null);
}

/* ═══════════════════════════════════════════
   SHARED HELPERS
   ═══════════════════════════════════════════ */

function toggleSection(wrapId, btnId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : 'block';
}

let imageRowCounter = 0;

function addImageRow(containerId, type, presetFile) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const idx = ++imageRowCounter;
  const row = document.createElement('div');
  row.id = `imgRow_${idx}`;
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:start;padding:10px;background:#fff;border-radius:var(--radius);border:1px solid var(--line)';
  row.innerHTML = `
    <div style="display:grid;gap:6px">
      <input type="file" accept="image/*" id="imgFile_${idx}" style="font-size:13px">
      <select id="imgPos_${idx}" style="min-height:36px;font-size:13px">
        <option value="hero">صورة رئيسية (Hero) — تظهر في أعلى الصفحة</option>
        <option value="logo">شعار العميل (Logo) — يظهر بجانب العنوان</option>
        <option value="inline">داخل المحتوى (Inline) — تظهر بين الفقرات</option>
        <option value="gallery">معرض صور (Gallery) — تظهر في نهاية الصفحة</option>
      </select>
      <input type="text" id="imgCaption_${idx}" placeholder="تعليق الصورة (اختياري)" style="min-height:34px;font-size:13px">
    </div>
    <div id="imgPreview_${idx}" style="width:60px;height:60px;border-radius:var(--radius);background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;overflow:hidden">
      <span style="color:var(--muted);font-size:11px">معاينة</span>
    </div>
    <button type="button" onclick="document.getElementById('imgRow_${idx}').remove()"
      style="width:28px;height:28px;border-radius:50%;border:none;background:#fef2f2;color:#b91c1c;font-size:16px;cursor:pointer;display:grid;place-items:center">×</button>
  `;
  wrap.appendChild(row);

  const fileInput = document.getElementById('imgFile_' + idx);
  const showPreview = (file) => {
    const reader = new FileReader();
    reader.onload = e => {
      const prev = document.getElementById('imgPreview_' + idx);
      if (prev) prev.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
  };

  // Preview on manual file select
  fileInput.addEventListener('change', function() {
    if (this.files[0]) showPreview(this.files[0]);
  });

  // لو الصف ده جزء من رفع مجموعة صور دفعة واحدة، نحط الملف جاهز في حقل
  // الرفع نفسه (عبر DataTransfer، لأن input.files للقراءة فقط أصلًا) ونعرض
  // معاينته على طول، ونخلي وضعها الافتراضي "معرض صور" (الأنسب لدفعة صور).
  if (presetFile) {
    const dt = new DataTransfer();
    dt.items.add(presetFile);
    fileInput.files = dt.files;
    showPreview(presetFile);
    const posSelect = document.getElementById('imgPos_' + idx);
    if (posSelect) posSelect.value = 'gallery';
  }
}

// رفع مجموعة صور دفعة واحدة: بيضيف صف مستقل تلقائيًا لكل صورة من الصور
// المختارة، بدل ما الأدمن يضغط "إضافة صورة" ويختار ملف واحد كل مرة يدويًا.
function handleBulkImageUpload(containerId, type, inputEl) {
  const files = Array.from(inputEl.files || []);
  files.forEach(file => addImageRow(containerId, type, file));
  inputEl.value = '';  // نفضّي الاختيار عشان لو الأدمن رفع نفس الدفعة تاني بالغلط ميتكررش
}

async function collectImages(containerId, folder) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return [];
  const rows = wrap.querySelectorAll('[id^="imgRow_"]');
  const images = [];
  for (const row of rows) {
    const idx = row.id.replace('imgRow_', '');
    const fileInput = document.getElementById('imgFile_' + idx);
    const pos = document.getElementById('imgPos_' + idx)?.value || 'hero';
    const caption = document.getElementById('imgCaption_' + idx)?.value.trim() || '';
    if (fileInput?.files[0]) {
      const file = fileInput.files[0];
      // صيغة HEIC/HEIF (شائعة جدًا في صور آيفون المرفوعة مباشرة) مش بتتعرض في
      // معظم المتصفحات (Chrome, Firefox, Edge) — نرفض الرفع ونطلب تحويلها الأول
      // بدل ما نرفع صورة هتظهر مكسورة للزوار.
      if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
        alert(`الصورة "${file.name}" بصيغة HEIC (صيغة آيفون) ومعظم المتصفحات مش بتعرضها. حوّلها لـJPG أو PNG الأول (من الآيفون: الإعدادات ← الكاميرا ← التنسيقات ← الأكثر توافقًا)، وبعدين ارفعها تاني.`);
        continue;
      }
      try {
        const url = await uploadImage(file, folder);
        if (url) images.push({ url, position: pos, caption });
      } catch(e) { console.error('Image upload error:', e); }
    }
  }
  return images;
}

/* ═══════════════════════════════════════════
   PROJECTS
   ═══════════════════════════════════════════ */

function autoSlugProject() {
  const slugField = document.getElementById('projectSlug');
  const titleField = document.getElementById('projectTitle');
  if (!slugField || !titleField) return;
  // Only auto-fill while the admin hasn't typed a custom slug themselves.
  if (slugField.dataset.userEdited === 'true') return;
  slugField.value = slugify(titleField.value);
}

async function handleProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const msgEl = document.querySelector('[data-project-message]');
  if (msgEl) msgEl.textContent = 'جاري رفع الصور والحفظ...';

  try {
    const images = await collectImages('projectImagesWrap', 'projects');
    const slugRaw = (formData.get('slug') || '').trim();
    const slug = `${slugify(slugRaw || formData.get('title'))}-${Date.now()}`;
    const payload = {
      title:      formData.get('title'),
      category:   formData.get('category'),
      location:   formData.get('location') || null,
      capacity:   formData.get('capacity') || null,
      year:       formData.get('year') ? Number(formData.get('year')) : null,
      summary:    formData.get('summary'),
      slug:       slug,
      content_ar: formData.get('content_ar') || null,
      sort_order: Number(formData.get('sort_order')) || 100,
      image_url:  images.find(i => i.position === 'hero')?.url || images[0]?.url || null,
      images:     images,
      published:  formData.get('published') === 'on',
    };
    const { error } = await client.from('projects').insert(payload);
    if (error) throw error;
    form.reset();
    document.getElementById('projectImagesWrap').innerHTML = '';
    delete document.getElementById('projectSlug').dataset.userEdited;
    if (alaslEditors["proj_new"]) alaslEditors["proj_new"].commands.setContent("<p></p>");
    if (msgEl) msgEl.textContent = '✅ تم حفظ المشروع!';
    setTimeout(() => { if (msgEl) msgEl.textContent = ''; toggleSection('projectAddWrap','addProjectBtn'); }, 2000);
    loadProjects();
  } catch(e) {
    if (msgEl) msgEl.textContent = 'خطأ: ' + e.message;
  }
}

async function loadProjects() {
  const container = document.getElementById('projectsList');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--muted);font-size:14px">جاري التحميل…</p>';

  const { data, error } = await client.from('projects').select('*').order('sort_order').limit(50);
  if (error) { container.innerHTML = `<p style="color:red;font-size:14px">خطأ: ${error.message}</p>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:14px">لا توجد مشاريع بعد.</p>'; return; }

  container.innerHTML = data.map(p => {
    const imgs = Array.isArray(p.images) ? p.images : [];
    const heroImg = imgs.find(i => i.position === 'hero') || imgs[0];
    const rawContent = p.content_ar || '';
    const isHtmlContent = rawContent.trim().startsWith('<');
    const editorContent = isHtmlContent ? rawContent : (window.marked ? window.marked.parse(rawContent) : rawContent);
    return `
    <div style="border:1px solid var(--line);border-radius:var(--radius-lg);background:#fff;overflow:hidden">
      <div style="display:flex;align-items:center;gap:10px;padding:10px var(--space-3);background:#f9f6f2;border-bottom:1px solid var(--line);cursor:pointer"
           onclick="toggleProjectEdit('${p.id}')">
        ${heroImg ? `<img src="${heroImg.url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0">` : '<div style="width:44px;height:44px;border-radius:6px;background:var(--line);flex-shrink:0;display:grid;place-items:center"><span style="font-size:18px">📷</span></div>'}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escP(p.title)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${escP(p.category||'')} ${p.location ? '· ' + escP(p.location) : ''} ${p.year ? '· ' + p.year : ''} · ${imgs.length} صورة</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button type="button" onclick="event.stopPropagation();togglePublish('projects','${p.id}',${p.published},'projectsList',loadProjects)"
            style="padding:3px 8px;border-radius:var(--radius);border:1px solid var(--line);background:${p.published ? '#e8f5e9' : '#fff3e0'};color:${p.published ? '#2e7d32' : '#e65100'};font-size:11px;font-weight:700;cursor:pointer">
            ${p.published ? '✅ منشور' : '⏸ موقوف'}
          </button>
          <button type="button" onclick="event.stopPropagation();deleteRecord('projects','${p.id}',loadProjects)"
            style="padding:3px 8px;border-radius:var(--radius);border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;font-size:11px;cursor:pointer">🗑</button>
          <span style="font-size:18px;color:var(--muted)">›</span>
        </div>
      </div>

      <!-- Edit form -->
      <div id="projEdit_${p.id}" style="display:none;padding:var(--space-3)">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2)">
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">العنوان *</label>
            <input id="pf_title_${p.id}" value="${escP(p.title)}"></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">التصنيف</label>
            <select id="pf_cat_${p.id}" style="min-height:38px">
              ${['Agriculture','Commercial','Institutional','Heritage','Hybrid','Residential','Maintenance'].map(c=>`<option ${p.category===c?'selected':''}>${c}</option>`).join('')}
            </select></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الموقع</label>
            <input id="pf_loc_${p.id}" value="${escP(p.location||'')}"></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">القدرة</label>
            <input id="pf_cap_${p.id}" value="${escP(p.capacity||'')}"></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">السنة</label>
            <input id="pf_year_${p.id}" type="number" value="${p.year||''}"></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الترتيب</label>
            <input id="pf_sort_${p.id}" type="number" value="${p.sort_order||100}"></div>
        </div>
        <div style="margin-top:var(--space-2)"><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الملخص *</label>
          <textarea id="pf_sum_${p.id}" rows="3">${escP(p.summary)}</textarea></div>
        <div style="margin-top:var(--space-2)"><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الرابط الدائم (Slug)</label>
          <input id="pf_slug_${p.id}" value="${escP(p.slug||'')}"></div>
        <div style="margin-top:var(--space-2)">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">قصة المشروع الكاملة (لصفحة جوجل)</label>
          <div class="rte-toolbar" data-rte-toolbar="proj_${p.id}"></div>
          <div class="rte-editor" id="projectContentEditor_proj_${p.id}"></div>
          <textarea id="pf_content_${p.id}" style="display:none">${escP(editorContent)}</textarea>
          ${!isHtmlContent ? `<p class="form-note" style="margin-top:4px">⚠️ ده مشروع قديم كان نص عادي — اتحول تلقائيًا لتنسيق قابل للتعديل. راجعه قبل ما تحفظ.</p>` : ''}
        </div>
        ${p.slug ? `<p style="margin-top:6px;font-size:12px"><a href="../projects/${escP(p.slug)}.html" target="_blank" rel="noopener">🔗 معاينة صفحة المشروع (بعد آخر تحديث أسبوعي)</a></p>` : ''}

        <!-- Existing images -->
        ${imgs.length > 0 ? `
        <div style="margin-top:var(--space-2)">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">الصور الحالية (${imgs.length})</label>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px" id="existImgs_${p.id}">
            ${imgs.map((img,i) => `
              <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;position:relative">
                <img src="${img.url}" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block">
                <div style="padding:4px 6px;background:#f9f6f2">
                  <div style="font-size:10px;font-weight:700;color:var(--brand-dark)">${img.position==='hero'?'🖼 رئيسية':img.position==='inline'?'📄 داخل المحتوى':'🖼 معرض'}</div>
                  ${img.caption ? `<div style="font-size:10px;color:var(--muted)">${escP(img.caption)}</div>` : ''}
                </div>
                <button type="button"
                  onclick="removeExistingImage('projects','${p.id}',${i},loadProjects)"
                  style="position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(185,28,28,.85);color:#fff;font-size:12px;cursor:pointer;display:grid;place-items:center">×</button>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <!-- Add more images -->
        <div style="margin-top:var(--space-2)">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">إضافة صور جديدة</label>
          <div id="projNewImgs_${p.id}" style="display:grid;gap:var(--space-1)"></div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button type="button" onclick="addImageRow('projNewImgs_${p.id}','project')"
              style="flex:1;padding:5px 12px;border-radius:var(--radius);border:1.5px dashed var(--brand);background:var(--brand-soft);color:var(--brand-dark);font-size:12px;cursor:pointer">
              + إضافة صورة
            </button>
            <button type="button" onclick="document.getElementById('projBulkImages_${p.id}').click()"
              style="flex:1;padding:5px 12px;border-radius:var(--radius);border:1.5px solid var(--brand);background:var(--brand);color:#fff;font-size:12px;font-weight:700;cursor:pointer">
              📁 رفع مجموعة صور
            </button>
            <input type="file" id="projBulkImages_${p.id}" accept="image/*" multiple style="display:none"
              onchange="handleBulkImageUpload('projNewImgs_${p.id}','project', this)">
          </div>
        </div>

        <p class="form-note" id="projEditMsg_${p.id}" style="margin-top:6px"></p>
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
          <button class="btn btn-primary" type="button" onclick="saveProject('${p.id}')" style="min-height:38px;font-size:13px">💾 حفظ</button>
          <button type="button" onclick="toggleProjectEdit('${p.id}')"
            style="padding:7px 14px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:13px;cursor:pointer">إلغاء</button>
        </div>
      </div>
    </div>
  `}).join('');
}

function escP(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toggleProjectEdit(id) {
  const el = document.getElementById('projEdit_' + id);
  if (!el) return;
  const opening = el.style.display === 'none';
  el.style.display = opening ? 'block' : 'none';

  const suffix = 'proj_' + id;
  if (opening && !alaslEditors[suffix]) {
    const hidden = document.getElementById('pf_content_' + id);
    const editorEl = document.getElementById('projectContentEditor_' + suffix);
    if (hidden && editorEl) {
      initRichEditor(suffix, { initialHtml: hidden.value, hiddenFieldId: 'pf_content_' + id, editorElId: 'projectContentEditor_' + suffix });
    }
  }
}

async function saveProject(id) {
  const msg = document.getElementById('projEditMsg_' + id);
  if (msg) msg.textContent = 'جاري الحفظ...';

  try {
    // Collect new images
    const newImgs = await collectImages('projNewImgs_' + id, 'projects');
    // Get existing images from Supabase
    const { data: existing } = await client.from('projects').select('images').eq('id', id).single();
    const existImgs = Array.isArray(existing?.images) ? existing.images : [];
    const allImgs = [...existImgs, ...newImgs];

    const payload = {
      title:      document.getElementById('pf_title_' + id)?.value.trim(),
      category:   document.getElementById('pf_cat_' + id)?.value,
      location:   document.getElementById('pf_loc_' + id)?.value.trim() || null,
      capacity:   document.getElementById('pf_cap_' + id)?.value.trim() || null,
      year:       Number(document.getElementById('pf_year_' + id)?.value) || null,
      summary:    document.getElementById('pf_sum_' + id)?.value.trim(),
      slug:       document.getElementById('pf_slug_' + id)?.value.trim() || slugify(document.getElementById('pf_title_' + id)?.value.trim() || ''),
      content_ar: document.getElementById('pf_content_' + id)?.value.trim() || null,
      sort_order: Number(document.getElementById('pf_sort_' + id)?.value) || 100,
      image_url:  allImgs.find(i => i.position === 'hero')?.url || allImgs[0]?.url || null,
      images:     allImgs,
      updated_at: new Date().toISOString(),
    };
    const { error } = await client.from('projects').update(payload).eq('id', id);
    if (error) throw error;
    if (msg) { msg.textContent = '✅ تم الحفظ!'; setTimeout(() => { if(msg) msg.textContent=''; }, 2500); }
    loadProjects();
  } catch(e) {
    if (msg) msg.textContent = 'خطأ: ' + e.message;
  }
}

/* ═══════════════════════════════════════════
   ARTICLES
   ═══════════════════════════════════════════ */

async function handleArticle(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const msgEl = document.querySelector('[data-article-message]');
  if (msgEl) msgEl.textContent = 'جاري رفع الصور والحفظ...';

  try {
    const images = await collectImages('articleImagesWrap', 'articles');
    const titleAr = formData.get('title_ar');
    // Use the admin-entered slug (already restricted to a-z0-9- via the
    // input's pattern/oninput sanitizer in dashboard.html) instead of
    // silently regenerating one from the Arabic title. Falling back to
    // slugify(titleAr) only covers the case where the field was somehow
    // left empty.
    const slugCustom = (formData.get('slug_custom') || '').trim();
    const slug = slugCustom || slugify(titleAr);
    const payload = {
      category:     formData.get('category') || 'general',
      title:        titleAr,
      slug:         `${slug}-${Date.now()}`,
      summary:      formData.get('summary_ar'),
      content:      formData.get('content_ar'),
      title_ar:     titleAr,
      title_en:     formData.get('title_en') || null,
      title_es:     formData.get('title_es') || null,
      title_zh:     formData.get('title_zh') || null,
      summary_ar:   formData.get('summary_ar'),
      summary_en:   formData.get('summary_en') || null,
      summary_es:   formData.get('summary_es') || null,
      summary_zh:   formData.get('summary_zh') || null,
      content_ar:   formData.get('content_ar'),
      content_en:   formData.get('content_en') || null,
      content_es:   formData.get('content_es') || null,
      content_zh:   formData.get('content_zh') || null,
      image_url:    images.find(i => i.position === 'hero')?.url || images[0]?.url || null,
      images,
      published:    formData.get('published') === 'on',
    };
    const { data: inserted, error } = await client.from('articles').insert(payload).select().single();
    if (error) throw error;
    form.reset();
    document.getElementById('articleImagesWrap').innerHTML = '';
    if (alaslEditors["new"]) alaslEditors["new"].commands.setContent("<p></p>");
    if (msgEl) msgEl.textContent = '✅ تم حفظ المقال! جاري الترجمة للغات الأخرى (ممكن تاخد دقيقة)...';
    setTimeout(() => { toggleSection('articleAddWrap','addArticleBtn'); }, 1500);
    loadArticles();

    try {
      const translated = await translateArticleFields(payload);
      await client.from('articles').update(translated).eq('id', inserted.id);
      loadArticles();
    } catch (translateError) {
      console.warn('Auto-translation failed, can retry from the list:', translateError);
    }
  } catch(e) {
    if (msgEl) msgEl.textContent = 'خطأ: ' + e.message;
  }
}

async function runArticleTranslation(id) {
  const btn = document.getElementById(`translateBtn_${id}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ جاري الترجمة (ممكن تاخد دقيقة)...';
  }

  try {
    const { data: article, error: fetchError } = await client
      .from('articles').select('title_ar, summary_ar, content_ar').eq('id', id).single();
    if (fetchError) throw fetchError;
    if (!article.title_ar || !article.summary_ar || !article.content_ar) {
      throw new Error('المقال ناقص محتوى عربي (عنوان/ملخص/محتوى)');
    }

    const translated = await translateArticleFields(article);
    const { error: updateError } = await client.from('articles').update(translated).eq('id', id);
    if (updateError) throw updateError;

    if (btn) { btn.textContent = '✅ تمت الترجمة'; }
    loadArticles();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚠️ فشلت، حاول تاني';
    }
    alert('خطأ في الترجمة: ' + e.message + '\n\nخدمة الترجمة المجانية أحيانًا بتكون مشغولة، حاول تاني بعد دقيقة.');
  }
}

async function loadArticles() {
  const container = document.getElementById('articlesList');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--muted);font-size:14px">جاري التحميل…</p>';

  const { data, error } = await client.from('articles').select('*').order('created_at', {ascending:false}).limit(50);
  if (error) { container.innerHTML = `<p style="color:red;font-size:14px">خطأ: ${error.message}</p>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:14px">لا توجد مقالات بعد.</p>'; return; }

  container.innerHTML = data.map(a => {
    const imgs = Array.isArray(a.images) ? a.images : [];
    const heroImg = imgs.find(i => i.position === 'hero') || imgs[0];
    const rawContent = a.content_ar || a.content || '';
    const isHtmlContent = rawContent.trim().startsWith('<');
    const editorContent = isHtmlContent ? rawContent : (window.marked ? window.marked.parse(rawContent) : rawContent);
    return `
    <div style="border:1px solid var(--line);border-radius:var(--radius-lg);background:#fff;overflow:hidden">
      <div style="display:flex;align-items:center;gap:10px;padding:10px var(--space-3);background:#f9f6f2;border-bottom:1px solid var(--line);cursor:pointer"
           onclick="toggleArticleEdit('${a.id}')">
        ${heroImg ? `<img src="${heroImg.url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0">` : '<div style="width:44px;height:44px;border-radius:6px;background:var(--line);flex-shrink:0;display:grid;place-items:center"><span style="font-size:18px">📝</span></div>'}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escP(a.title)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${new Date(a.created_at).toLocaleDateString('ar-EG')} · ${imgs.length} صورة</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button type="button" onclick="event.stopPropagation();runArticleTranslation('${a.id}')"
            id="translateBtn_${a.id}"
            style="padding:3px 8px;border-radius:var(--radius);border:1px solid ${a.title_en ? '#c7d2fe' : '#fde68a'};background:${a.title_en ? '#eef2ff' : '#fffbeb'};color:${a.title_en ? '#4338ca' : '#92400e'};font-size:11px;font-weight:700;cursor:pointer">
            ${a.title_en ? '🌐 مترجَم' : '🌐 ترجم الآن'}
          </button>
          <button type="button" onclick="event.stopPropagation();togglePublish('articles','${a.id}',${a.published},'articlesList',loadArticles)"
            style="padding:3px 8px;border-radius:var(--radius);border:1px solid var(--line);background:${a.published ? '#e8f5e9' : '#fff3e0'};color:${a.published ? '#2e7d32' : '#e65100'};font-size:11px;font-weight:700;cursor:pointer">
            ${a.published ? '✅ منشور' : '⏸ موقوف'}
          </button>
          <button type="button" onclick="event.stopPropagation();deleteRecord('articles','${a.id}',loadArticles)"
            style="padding:3px 8px;border-radius:var(--radius);border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;font-size:11px;cursor:pointer">🗑</button>
          <span style="font-size:18px;color:var(--muted)">›</span>
        </div>
      </div>

      <!-- Edit form -->
      <div id="artEdit_${a.id}" style="display:none;padding:var(--space-3)">
        <div style="display:grid;gap:var(--space-2)">
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">التصنيف *</label>
            <select id="af_cat_${a.id}">
              <option value="intro" ${a.category==='intro'?'selected':''}>تعليمي (إيه هي الطاقة الشمسية)</option>
              <option value="compare" ${a.category==='compare'?'selected':''}>مقارنات بين الأنظمة</option>
              <option value="maintenance" ${a.category==='maintenance'?'selected':''}>الصيانة وطول العمر</option>
              <option value="applications" ${a.category==='applications'?'selected':''}>تطبيقات معينة</option>
              <option value="general" ${(!a.category||a.category==='general')?'selected':''}>عام / غير مصنف</option>
            </select></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">العنوان (عربي) *</label>
            <input id="af_title_${a.id}" value="${escP(a.title_ar || a.title)}"></div>
          <div><label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الملخص (عربي) *</label>
            <textarea id="af_sum_${a.id}" rows="3">${escP(a.summary_ar || a.summary)}</textarea></div>
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">المحتوى (عربي) *</label>
            <div class="rte-toolbar" data-rte-toolbar="${a.id}"></div>
            <div class="rte-editor" id="articleContentEditor_${a.id}"></div>
            <textarea id="af_con_${a.id}" style="display:none">${escP(editorContent)}</textarea>
            ${!isHtmlContent ? `<p class="form-note" style="margin-top:4px">⚠️ ده مقال قديم كان نص عادي — اتحول تلقائيًا لتنسيق قابل للتعديل. راجعه قبل ما تحفظ.</p>` : ''}
          </div>
        </div>

        ${a.title_en ? `
        <label class="check-row" style="margin-top:var(--space-2);font-size:12px">
          <input type="checkbox" id="af_retranslate_${a.id}" checked>
          <span>🌐 إعادة ترجمة المقال للغات الأخرى بعد الحفظ (لو عدّلت في النص العربي أو لاحظت غلطة بالترجمة)</span>
        </label>` : ''}

        <!-- Existing images -->
        ${imgs.length > 0 ? `
        <div style="margin-top:var(--space-2)">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">الصور الحالية (${imgs.length})</label>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px">
            ${imgs.map((img,i) => `
              <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;position:relative">
                <img src="${img.url}" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block">
                <div style="padding:4px 6px;background:#f9f6f2">
                  <div style="font-size:10px;font-weight:700;color:var(--brand-dark)">${img.position==='hero'?'🖼 رئيسية':img.position==='inline'?'📄 داخل المحتوى':'🖼 معرض'}</div>
                  ${img.caption ? `<div style="font-size:10px;color:var(--muted)">${escP(img.caption)}</div>` : ''}
                </div>
                <button type="button"
                  onclick="removeExistingImage('articles','${a.id}',${i},loadArticles)"
                  style="position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(185,28,28,.85);color:#fff;font-size:12px;cursor:pointer;display:grid;place-items:center">×</button>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <!-- Add more images -->
        <div style="margin-top:var(--space-2)">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">إضافة صور جديدة</label>
          <div id="artNewImgs_${a.id}" style="display:grid;gap:var(--space-1)"></div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button type="button" onclick="addImageRow('artNewImgs_${a.id}','article')"
              style="flex:1;padding:5px 12px;border-radius:var(--radius);border:1.5px dashed var(--brand);background:var(--brand-soft);color:var(--brand-dark);font-size:12px;cursor:pointer">
              + إضافة صورة
            </button>
            <button type="button" onclick="document.getElementById('artBulkImages_${a.id}').click()"
              style="flex:1;padding:5px 12px;border-radius:var(--radius);border:1.5px solid var(--brand);background:var(--brand);color:#fff;font-size:12px;font-weight:700;cursor:pointer">
              📁 رفع مجموعة صور
            </button>
            <input type="file" id="artBulkImages_${a.id}" accept="image/*" multiple style="display:none"
              onchange="handleBulkImageUpload('artNewImgs_${a.id}','article', this)">
          </div>
        </div>

        <p class="form-note" id="artEditMsg_${a.id}" style="margin-top:6px"></p>
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
          <button class="btn btn-primary" type="button" onclick="saveArticle('${a.id}')" style="min-height:38px;font-size:13px">💾 حفظ</button>
          <button type="button" onclick="toggleArticleEdit('${a.id}')"
            style="padding:7px 14px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:13px;cursor:pointer">إلغاء</button>
        </div>
      </div>
    </div>
  `}).join('');
}

function toggleArticleEdit(id) {
  const el = document.getElementById('artEdit_' + id);
  if (!el) return;
  const opening = el.style.display === 'none';
  el.style.display = opening ? 'block' : 'none';

  if (opening && !alaslEditors[id]) {
    const hidden = document.getElementById('af_con_' + id);
    const editorEl = document.getElementById('articleContentEditor_' + id);
    if (hidden && editorEl) {
      initRichEditor(id, { initialHtml: hidden.value, hiddenFieldId: 'af_con_' + id });
    }
  }
}

async function saveArticle(id) {
  const msg = document.getElementById('artEditMsg_' + id);
  if (msg) msg.textContent = 'جاري الحفظ...';
  try {
    const newImgs = await collectImages('artNewImgs_' + id, 'articles');
    const { data: existing } = await client.from('articles').select('images').eq('id', id).single();
    const existImgs = Array.isArray(existing?.images) ? existing.images : [];
    const allImgs = [...existImgs, ...newImgs];

    const titleAr = document.getElementById('af_title_' + id)?.value.trim();
    const summaryAr = document.getElementById('af_sum_' + id)?.value.trim();
    const contentAr = document.getElementById('af_con_' + id)?.value.trim();
    const category = document.getElementById('af_cat_' + id)?.value || 'general';
    const retranslateBox = document.getElementById('af_retranslate_' + id);
    const shouldRetranslate = retranslateBox ? retranslateBox.checked : false;

    const payload = {
      category,
      title:      titleAr,
      summary:    summaryAr,
      content:    contentAr,
      title_ar:   titleAr,
      summary_ar: summaryAr,
      content_ar: contentAr,
      image_url:  allImgs.find(i => i.position === 'hero')?.url || allImgs[0]?.url || null,
      images:     allImgs,
      updated_at: new Date().toISOString(),
    };
    const { error } = await client.from('articles').update(payload).eq('id', id);
    if (error) throw error;

    if (msg) { msg.textContent = '✅ تم الحفظ!'; }
    loadArticles();

    if (shouldRetranslate) {
      if (msg) msg.textContent = '✅ تم الحفظ! جاري إعادة الترجمة...';
      await runArticleTranslation(id);
    }
  } catch(e) {
    if (msg) msg.textContent = 'خطأ: ' + e.message;
  }
}

/* ── Shared: toggle publish / delete / remove image ── */
async function togglePublish(table, id, current, listId, reloadFn) {
  await client.from(table).update({ published: !current, updated_at: new Date().toISOString() }).eq('id', id);
  reloadFn();
}

async function deleteRecord(table, id, reloadFn) {
  if (!confirm('حذف هذا العنصر نهائياً؟')) return;
  await client.from(table).delete().eq('id', id);
  reloadFn();
}

async function removeExistingImage(table, id, index, reloadFn) {
  if (!confirm('حذف هذه الصورة؟')) return;
  const { data } = await client.from(table).select('images').eq('id', id).single();
  const imgs = Array.isArray(data?.images) ? [...data.images] : [];
  imgs.splice(index, 1);
  await client.from(table).update({ images: imgs, image_url: imgs[0]?.url || null, updated_at: new Date().toISOString() }).eq('id', id);
  reloadFn();
}

async function loadLists() {
  loadStats();
  loadFaqCounts();
  loadProjects();
  loadArticles();
  loadProducts();
  loadCategoryVisibility();
  loadBrandLogos();
  loadCalcSettings();
  loadOffgridSettings();
  loadOffgridPresets();
}

// ── Category visibility (show/hide an entire product category from the public site) ──
const CATEGORY_ICONS = { inverters:'⚡', panels:'☀️', accessories:'🔌', combiners:'📦', structures:'🏗️', cables:'🔶', batteries:'🔋', offgrid:'🔆', ongrid:'🔌', hybrid:'🔋', well_motors:'🛠️', pumps:'🌊', pipes:'🧵', street_lights:'💡', flood_lights:'🔦', garden_lights:'🪴', solar_kits:'🧰', solar_safety:'🚧' };
const CATEGORY_LABELS_AR = { inverters:'إنفرتر بامب/VFD', panels:'الألواح الشمسية', accessories:'إكسسوارات', combiners:'صناديق تجميع', structures:'هياكل', cables:'كابلات', batteries:'بطاريات وتخزين', offgrid:'إنفرتر أوف جريد', ongrid:'إنفرتر أون جريد', hybrid:'إنفرتر هايبرد', well_motors:'موتورات آبار', pumps:'طلمبات ومضخات', pipes:'مواسير', street_lights:'إنارة شوارع شمسية', flood_lights:'كشافات شمسية', garden_lights:'إضاءة حدائق شمسية', solar_kits:'كيت إضاءة منزلي', solar_safety:'سلامة الطرق الشمسية' };

async function loadCategoryVisibility() {
  const panel = document.getElementById('categoryVisibilityPanel');
  if (!panel) return;
  if (!client) { panel.innerHTML = '<p style="color:var(--muted);font-size:13px">تعذّر الاتصال بقاعدة البيانات.</p>'; return; }

  const { data, error } = await client
    .from('category_settings')
    .select('*')
    .order('main_section', { ascending: true })
    .order('sort_order', { ascending: true });

  if (error) { panel.innerHTML = '<p style="color:red;font-size:13px">خطأ: ' + error.message + '</p>'; return; }

  panel.innerHTML = (data || []).map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius);background:#fff;gap:8px">
      <span style="font-size:13px;display:flex;align-items:center;gap:6px">
        <span>${CATEGORY_ICONS[c.category_key] || '📦'}</span>
        <span>${CATEGORY_LABELS_AR[c.category_key] || c.category_key}</span>
        ${!c.visible ? '<span style="font-size:11px;color:#e44;font-weight:700">● مخفي من الموقع</span>' : ''}
      </span>
      <button type="button" onclick="toggleCategoryVisibility('${c.category_key}', ${c.visible})"
        style="padding:4px 12px;border-radius:var(--radius);border:1px solid ${c.visible ? 'var(--line)' : '#fcc'};background:${c.visible ? '#fff' : '#fff3f3'};font-size:12px;cursor:pointer;color:${c.visible ? 'inherit' : '#c33'}">
        ${c.visible ? '🙈 إخفاء' : '👁️ إظهار'}
      </button>
    </div>`).join('') || '<p style="color:var(--muted);font-size:13px">لا توجد تصنيفات معرّفة.</p>';
}

async function toggleCategoryVisibility(key, current) {
  if (!client) return;
  const { error } = await client
    .from('category_settings')
    .update({ visible: !current, updated_at: new Date().toISOString() })
    .eq('category_key', key);
  if (error) { alert('خطأ: ' + error.message); return; }
  loadCategoryVisibility();
}

document.addEventListener("DOMContentLoaded", () => {
  if (!client) {
    setText("[data-auth-message]", "Supabase client could not load.");
    return;
  }

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("projectForm").addEventListener("submit", handleProject);
  document.getElementById("articleForm").addEventListener("submit", handleArticle);
  document.getElementById("faqAddForm")?.addEventListener("submit", handleFaqAdd);
  document.querySelector("[data-logout]").addEventListener("click", handleLogout);

  client.auth.onAuthStateChange((_event, session) => {
    // Supabase silently checks/renews the session whenever the tab regains
    // focus (e.g. switching back from Word after copying an article), which
    // fires this callback as "TOKEN_REFRESHED" even though nothing about the
    // logged-in state actually changed. Reloading the lists on that event
    // wipes out any edit panel that's open with unsaved content. Only react
    // to events that mean the session genuinely changed.
    if (_event === "TOKEN_REFRESHED") return;
    updateAuthState(session);
  });
  requireSession();
});

/* ═══════════════════════════════════════════
   STATS MANAGEMENT
   ═══════════════════════════════════════════ */

async function loadStats() {
  const container = document.getElementById("statsList");
  if (!container) return;

  const { data, error } = await client
    .from("site_stats")
    .select("*")
    .order("sort_order");

  if (error || !data || data.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);font-size:14px">
      ${error ? "Could not load stats: " + error.message : "No stats found — run the SQL setup first."}
    </p>`;
    return;
  }

  container.innerHTML = data.map(stat => `
    <div class="admin-form" style="
      background:#fff;
      border:1px solid var(--line);
      border-radius:var(--radius-lg);
      padding:var(--space-3);
    " data-stat-row="${stat.id}">
      <div style="display:grid;grid-template-columns:120px 1fr 1fr 1fr 1fr;gap:var(--space-2);align-items:end">
        <div>
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Value</label>
          <input
            id="stat_value_${stat.id}"
            value="${stat.value}"
            placeholder="e.g. 120+"
            style="font-size:22px;font-weight:800;color:var(--brand);text-align:center"
          >
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">English label</label>
          <input id="stat_en_${stat.id}" value="${stat.label_en}" placeholder="Label in English">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Arabic label</label>
          <input id="stat_ar_${stat.id}" value="${stat.label_ar}" placeholder="التسمية بالعربية" dir="rtl">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Spanish label</label>
          <input id="stat_es_${stat.id}" value="${stat.label_es}" placeholder="Etiqueta en español">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Chinese label</label>
          <input id="stat_zh_${stat.id}" value="${stat.label_zh}" placeholder="中文标签">
        </div>
      </div>
      <button
        class="btn btn-primary"
        type="button"
        onclick="saveStat('${stat.id}')"
        style="margin-top:var(--space-2);min-height:40px;font-size:13px"
      >
        Save this stat
      </button>
    </div>
  `).join("");
}

async function saveStat(id) {
  const msg = document.getElementById("statsMessage");
  const value   = document.getElementById(`stat_value_${id}`)?.value.trim();
  const label_en = document.getElementById(`stat_en_${id}`)?.value.trim();
  const label_ar = document.getElementById(`stat_ar_${id}`)?.value.trim();
  const label_es = document.getElementById(`stat_es_${id}`)?.value.trim();
  const label_zh = document.getElementById(`stat_zh_${id}`)?.value.trim();

  if (!value || !label_en || !label_ar) {
    if (msg) msg.textContent = "Value, English label, and Arabic label are required.";
    return;
  }

  if (msg) msg.textContent = "Saving...";

  const { error } = await client
    .from("site_stats")
    .update({ value, label_en, label_ar, label_es, label_zh, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    if (msg) msg.textContent = "Error: " + error.message;
    return;
  }

  if (msg) {
    msg.textContent = "✅ Saved! Homepage will reflect the new values immediately.";
    setTimeout(() => { if (msg) msg.textContent = ""; }, 4000);
  }
}


/* ═══════════════════════════════════════════
   FAQ MANAGEMENT — Page-first navigation
   ═══════════════════════════════════════════ */

const FAQ_PAGES = {
  home:        { label: 'الصفحة الرئيسية', icon: '🏠' },
  services:    { label: 'الخدمات',          icon: '⚙️' },
  agriculture: { label: 'زراعة وري',        icon: '🌱' },
  industrial:  { label: 'صناعة وتجارة',     icon: '🏭' },
  residential: { label: 'سكني',             icon: '🏡' },
  about:       { label: 'من نحن',           icon: 'ℹ️' },
  contact:     { label: 'تواصل معنا',       icon: '📞' },
};

let activeFaqPage = null;
let allFaqData = [];

/* ── Load counts for all pages ── */
async function loadFaqCounts() {
  const { data } = await client.from('faqs').select('page');
  if (!data) return;
  Object.keys(FAQ_PAGES).forEach(p => {
    const el = document.getElementById('faqCount_' + p);
    if (el) {
      const count = data.filter(r => r.page === p).length;
      el.textContent = count + ' سؤال';
    }
  });
}

/* ── Open a page panel ── */
async function openFaqPage(page) {
  activeFaqPage = page;

  // Update selector active state
  document.querySelectorAll('.faq-page-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // Show panel, update title
  const panel = document.getElementById('faqPagePanel');
  if (panel) panel.style.display = 'block';
  const title = document.getElementById('faqPanelTitle');
  if (title) title.textContent = FAQ_PAGES[page]?.icon + '  ' + FAQ_PAGES[page]?.label;

  // Hide add form
  const addWrap = document.getElementById('faqAddFormWrap');
  if (addWrap) addWrap.style.display = 'none';

  await loadFaqs();
}

function closeFaqPanel() {
  activeFaqPage = null;
  const panel = document.getElementById('faqPagePanel');
  if (panel) panel.style.display = 'none';
  document.querySelectorAll('.faq-page-btn').forEach(b => b.classList.remove('active'));
}

function toggleFaqAddForm() {
  const wrap = document.getElementById('faqAddFormWrap');
  if (!wrap) return;
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    document.getElementById('faqAddForm')?.reset();
    const prev = document.getElementById('faqTranslationPreview');
    if (prev) prev.style.display = 'none';
    const msg = document.getElementById('faqAddMessage');
    if (msg) msg.textContent = '';
  }
}

/* ── Load questions for active page ── */
async function loadFaqs() {
  const container = document.getElementById('faqList');
  if (!container || !activeFaqPage) return;
  container.innerHTML = '<p style="color:var(--muted);font-size:14px">جاري التحميل…</p>';

  const { data, error } = await client
    .from('faqs').select('*')
    .eq('page', activeFaqPage)
    .order('sort_order');

  if (error) { container.innerHTML = `<p style="color:red;font-size:14px">خطأ: ${error.message}</p>`; return; }

  allFaqData = data || [];

  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);font-size:14px">لا توجد أسئلة في هذه الصفحة بعد. أضف سؤالاً أعلاه.</p>';
    return;
  }

  container.innerHTML = data.map(faq => `
    <div style="border:1px solid var(--line);border-radius:var(--radius-lg);background:#fff;overflow:hidden" data-faq-id="${faq.id}">

      <!-- Row header -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px var(--space-3);background:#f9f6f2;border-bottom:1px solid var(--line);cursor:pointer"
           onclick="toggleFaqEdit('${faq.id}')">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <span style="min-width:24px;height:24px;border-radius:50%;background:${faq.published ? 'var(--brand)' : '#ccc'};color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center;flex-shrink:0">${faq.sort_order}</span>
          <span style="font-weight:700;font-size:13px;direction:rtl;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1" title="${escHtml(faq.question_ar || faq.question_en)}">
            ${escHtml(faq.question_ar || faq.question_en)}
          </span>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button type="button" onclick="event.stopPropagation();toggleFaqPublish('${faq.id}',${faq.published})"
            style="padding:3px 9px;border-radius:var(--radius);border:1px solid var(--line);background:${faq.published ? '#e8f5e9' : '#fff3e0'};color:${faq.published ? '#2e7d32' : '#e65100'};font-size:11px;font-weight:700;cursor:pointer">
            ${faq.published ? '✅ منشور' : '⏸ موقوف'}
          </button>
          <button type="button" onclick="event.stopPropagation();deleteFaq('${faq.id}')"
            style="padding:3px 9px;border-radius:var(--radius);border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;font-size:11px;font-weight:700;cursor:pointer">
            🗑
          </button>
          <span style="font-size:18px;color:var(--muted);line-height:1">›</span>
        </div>
      </div>

      <!-- Edit form (collapsed) -->
      <div id="faqEdit_${faq.id}" style="display:none;padding:var(--space-3)">

        <!-- Arabic fields -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-bottom:var(--space-2)">
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">السؤال (عربي) *</label>
            <input id="feq_ar_${faq.id}" value="${escHtml(faq.question_ar)}" dir="rtl">
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الإجابة (عربي) *</label>
            <textarea id="fea_ar_${faq.id}" rows="3" dir="rtl">${escHtml(faq.answer_ar)}</textarea>
          </div>
        </div>

        <!-- Translate button -->
        <button type="button" onclick="translateExistingFaq('${faq.id}')"
          style="padding:6px 14px;border-radius:var(--radius);border:1px solid var(--brand);background:var(--brand-soft);color:var(--brand-dark);font-size:12px;font-weight:700;cursor:pointer;margin-bottom:var(--space-2)">
          ✨ ترجمة تلقائية من العربي
        </button>

        <!-- Other languages -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-1)">
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">Q — English</label><input id="feq_en_${faq.id}" value="${escHtml(faq.question_en)}"></div>
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">A — English</label><textarea id="fea_en_${faq.id}" rows="2">${escHtml(faq.answer_en)}</textarea></div>
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">Q — Español</label><input id="feq_es_${faq.id}" value="${escHtml(faq.question_es || '')}"></div>
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">A — Español</label><textarea id="fea_es_${faq.id}" rows="2">${escHtml(faq.answer_es || '')}</textarea></div>
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">Q — 中文</label><input id="feq_zh_${faq.id}" value="${escHtml(faq.question_zh || '')}"></div>
          <div><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px">A — 中文</label><textarea id="fea_zh_${faq.id}" rows="2">${escHtml(faq.answer_zh || '')}</textarea></div>
        </div>

        <!-- Sort + actions -->
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-top:var(--space-2);flex-wrap:wrap">
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:3px">الترتيب</label>
            <input id="fesort_${faq.id}" type="number" value="${faq.sort_order}" style="width:70px;min-height:36px">
          </div>
        </div>
        <p class="form-note" id="faqEditMsg_${faq.id}" style="margin-top:6px"></p>
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
          <button class="btn btn-primary" type="button" onclick="saveFaq('${faq.id}')" style="min-height:38px;font-size:13px">💾 حفظ</button>
          <button type="button" onclick="toggleFaqEdit('${faq.id}')"
            style="padding:7px 14px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:13px;cursor:pointer">إلغاء</button>
        </div>
      </div>
    </div>
  `).join('');
}

/* ── Helpers ── */
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleFaqEdit(id) {
  const el = document.getElementById('faqEdit_' + id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

/* ── Claude API translation ── */
async function callClaudeTranslate(q_ar, a_ar) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: `Translate this FAQ from Arabic to English, Spanish (ES), and Chinese (ZH).
Return ONLY valid JSON, no markdown:
{"q_en":"...","a_en":"...","q_es":"...","a_es":"...","q_zh":"...","a_zh":"..."}

Arabic question: ${q_ar}
Arabic answer: ${a_ar}` }]
    })
  });
  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function translateNewFaq() {
  const q_ar = document.getElementById('faq_new_q_ar')?.value.trim();
  const a_ar = document.getElementById('faq_new_a_ar')?.value.trim();
  const msg  = document.getElementById('faqAddMessage');
  const btn  = document.getElementById('faqTranslateBtn');
  const prev = document.getElementById('faqTranslationPreview');
  if (!q_ar || !a_ar) { if (msg) msg.textContent = 'اكتب السؤال والإجابة بالعربية أولاً.'; return; }
  if (btn) { btn.textContent = '⏳ جاري الترجمة (ممكن تاخد دقيقة)...'; btn.disabled = true; }
  if (msg) msg.textContent = '';
  try {
    const t = await callClaudeTranslate(q_ar, a_ar);
    ['en','es','zh'].forEach(l => {
      const qEl = document.getElementById('faq_new_q_' + l);
      const aEl = document.getElementById('faq_new_a_' + l);
      if (qEl) qEl.value = t['q_' + l] || '';
      if (aEl) aEl.value = t['a_' + l] || '';
    });
    if (prev) prev.style.display = 'block';
    if (msg) msg.textContent = '✅ تمت الترجمة — راجع وعدّل إن احتجت.';
  } catch(e) {
    if (prev) prev.style.display = 'block';
    if (msg) msg.textContent = 'تعذّرت الترجمة التلقائية — يمكنك الكتابة يدوياً.';
  } finally {
    if (btn) { btn.textContent = '✨ ترجمة تلقائية'; btn.disabled = false; }
  }
}

async function translateExistingFaq(id) {
  const q_ar = document.getElementById('feq_ar_' + id)?.value.trim();
  const a_ar = document.getElementById('fea_ar_' + id)?.value.trim();
  const msg  = document.getElementById('faqEditMsg_' + id);
  if (!q_ar || !a_ar) { if (msg) msg.textContent = 'اكتب النص العربي أولاً.'; return; }
  if (msg) msg.textContent = '⏳ جاري الترجمة (ممكن تاخد دقيقة)...';
  try {
    const t = await callClaudeTranslate(q_ar, a_ar);
    ['en','es','zh'].forEach(l => {
      const qEl = document.getElementById('feq_' + l + '_' + id);
      const aEl = document.getElementById('fea_' + l + '_' + id);
      if (qEl) qEl.value = t['q_' + l] || '';
      if (aEl) aEl.value = t['a_' + l] || '';
    });
    if (msg) msg.textContent = '✅ تمت الترجمة — راجع وعدّل إن احتجت.';
  } catch(e) {
    if (msg) msg.textContent = 'تعذّرت الترجمة التلقائية.';
  }
}

/* ── Save / publish / delete ── */
async function saveFaq(id) {
  const msg = document.getElementById('faqEditMsg_' + id);
  const payload = {
    question_ar: document.getElementById('feq_ar_' + id)?.value.trim(),
    answer_ar:   document.getElementById('fea_ar_' + id)?.value.trim(),
    question_en: document.getElementById('feq_en_' + id)?.value.trim() || '',
    answer_en:   document.getElementById('fea_en_' + id)?.value.trim() || '',
    question_es: document.getElementById('feq_es_' + id)?.value.trim() || '',
    answer_es:   document.getElementById('fea_es_' + id)?.value.trim() || '',
    question_zh: document.getElementById('feq_zh_' + id)?.value.trim() || '',
    answer_zh:   document.getElementById('fea_zh_' + id)?.value.trim() || '',
    sort_order:  Number(document.getElementById('fesort_' + id)?.value) || 100,
    updated_at:  new Date().toISOString(),
  };
  if (!payload.question_ar || !payload.answer_ar) { if (msg) msg.textContent = 'السؤال والإجابة بالعربية مطلوبان.'; return; }
  if (msg) msg.textContent = 'جاري الحفظ...';
  const { error } = await client.from('faqs').update(payload).eq('id', id);
  if (error) { if (msg) msg.textContent = 'خطأ: ' + error.message; return; }
  if (msg) { msg.textContent = '✅ تم الحفظ!'; setTimeout(() => { if (msg) msg.textContent = ''; }, 3000); }
  loadFaqs();
  loadFaqCounts();
}

async function toggleFaqPublish(id, current) {
  await client.from('faqs').update({ published: !current, updated_at: new Date().toISOString() }).eq('id', id);
  loadFaqs();
}

async function deleteFaq(id) {
  if (!confirm('حذف هذا السؤال نهائياً؟')) return;
  const { error } = await client.from('faqs').delete().eq('id', id);
  const msg = document.getElementById('faqMessage');
  if (error) { if (msg) msg.textContent = 'خطأ: ' + error.message; return; }
  if (msg) { msg.textContent = 'تم الحذف.'; setTimeout(() => { if (msg) msg.textContent = ''; }, 2000); }
  loadFaqs();
  loadFaqCounts();
}

async function handleFaqAdd(event) {
  event.preventDefault();
  const msg = document.getElementById('faqAddMessage');
  const payload = {
    question_ar: document.getElementById('faq_new_q_ar')?.value.trim(),
    answer_ar:   document.getElementById('faq_new_a_ar')?.value.trim(),
    question_en: document.getElementById('faq_new_q_en')?.value.trim() || '',
    answer_en:   document.getElementById('faq_new_a_en')?.value.trim() || '',
    question_es: document.getElementById('faq_new_q_es')?.value.trim() || '',
    answer_es:   document.getElementById('faq_new_a_es')?.value.trim() || '',
    question_zh: document.getElementById('faq_new_q_zh')?.value.trim() || '',
    answer_zh:   document.getElementById('faq_new_a_zh')?.value.trim() || '',
    page:        activeFaqPage || 'home',
    sort_order:  Number(document.getElementById('faq_new_sort')?.value) || 100,
    published:   true,
  };
  if (!payload.question_ar || !payload.answer_ar) { if (msg) msg.textContent = 'السؤال والإجابة بالعربية مطلوبان.'; return; }
  if (msg) msg.textContent = 'جاري الإضافة...';
  const { error } = await client.from('faqs').insert(payload);
  if (error) { if (msg) msg.textContent = 'خطأ: ' + error.message; return; }
  if (msg) { msg.textContent = '✅ تمت الإضافة!'; setTimeout(() => { if (msg) msg.textContent = ''; }, 3000); }
  event.target.reset();
  document.getElementById('faq_new_sort').value = '100';
  document.getElementById('faqTranslationPreview').style.display = 'none';
  toggleFaqAddForm();
  loadFaqs();
  loadFaqCounts();
}

/* ═══════════════════════════════════════════
   PRODUCTS MANAGEMENT
   ═══════════════════════════════════════════ */

let allDashProducts = [];
let currentProdCat = 'all';

async function loadProducts() {
  const list = document.getElementById('productsList');
  if (!list) return;
  if (!client) { list.innerHTML = '<p style="color:var(--muted);font-size:14px">تعذّر الاتصال بقاعدة البيانات.</p>'; return; }

  list.innerHTML = '<p style="color:var(--muted);font-size:14px">جاري التحميل…</p>';
  const { data, error } = await client.from('products').select('*').order('sort_order', { ascending: true });
  if (error) { list.innerHTML = '<p style="color:red;font-size:14px">خطأ: ' + error.message + '</p>'; return; }
  allDashProducts = data || [];
  updateProductCatCounts();
  renderDashProducts();
}

function filterDashProducts(cat, btn) {
  currentProdCat = cat;
  document.querySelectorAll('.prod-dash-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDashProducts();
}

// تحديث عداد كل تصنيف في السايدبار الفرعي بناءً على المنتجات المحمّلة فعليًا
function updateProductCatCounts() {
  const counts = { all: allDashProducts.length };
  allDashProducts.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
  document.querySelectorAll('[data-pcat-count]').forEach(el => {
    const cat = el.getAttribute('data-pcat-count');
    el.textContent = counts[cat] || 0;
  });
}

// Same fallback logic as products.html: use power_kw/power_hp if set,
// otherwise try to parse "X HP" / "Y KW" straight out of the specs text —
// this is how the live site has always detected inverter power, so the
// admin's warning must check the same way or it flags products that are
// actually fine.
function detectInvPower(p) {
  let kw = p.power_kw != null ? parseFloat(p.power_kw) : null;
  let hp = p.power_hp != null ? parseFloat(p.power_hp) : null;
  if (!kw || !hp) {
    const s = (p.specs_ar || '') + ' ' + (p.specs_en || '');
    const kwM = s.match(/([\d.]+)\s*KW/i);
    const hpM = s.match(/([\d.]+)\s*HP/i);
    if (!kw && kwM) kw = parseFloat(kwM[1]);
    if (!hp && hpM) hp = parseFloat(hpM[1]);
  }
  return { kw, hp };
}

function renderDashProducts() {
  const list = document.getElementById('productsList');
  if (!list) return;
  const rows = currentProdCat === 'all' ? allDashProducts : allDashProducts.filter(p => p.category === currentProdCat);
  if (rows.length === 0) { list.innerHTML = '<p style="color:var(--muted);font-size:14px">لا توجد منتجات في هذا التصنيف.</p>'; return; }

  const catLabels = { inverters:'⚡ إنفرتر', panels:'☀️ لوح', accessories:'🔌 إكسسوار', combiners:'📦 صندوق تجميع', structures:'🏗️ شاسيه', cables:'🔶 كابل', batteries:'🔋 بطارية', offgrid:'🔆 أوف جريد', well_motors:'🛠️ موتور آبار', pumps:'🌊 طلمبة', pipes:'🧵 ماسورة', street_lights:'💡 إنارة شوارع', flood_lights:'🔦 كشاف', garden_lights:'🪴 حديقة', solar_kits:'🧰 نظام منزلي', solar_safety:'🚧 سلامة طرق' };

  list.innerHTML = rows.map(p => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px var(--space-3);border:1px solid var(--line);border-radius:var(--radius);background:#fff;gap:var(--space-2);flex-wrap:wrap">
      <div style="display:flex;gap:var(--space-2);flex:1;min-width:0">
        <div style="width:48px;height:48px;border-radius:var(--radius);background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;overflow:hidden;flex-shrink:0">
          ${p.image_url ? `<img src="${p.image_url}" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-size:18px;opacity:.5">${({inverters:'⚡',panels:'☀️',accessories:'🔌',combiners:'📦',structures:'🏗️',cables:'🔶',batteries:'🔋',offgrid:'🔆',well_motors:'🛠️',pumps:'🌊',pipes:'🧵',street_lights:'💡',flood_lights:'🔦',garden_lights:'🪴',solar_kits:'🧰',solar_safety:'🚧'})[p.category] || '📦'}</span>`}
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--brand-soft);color:var(--brand-dark)">${catLabels[p.category] || p.category}</span>
            ${p.brand ? `<span style="font-size:11px;color:var(--muted)">${p.brand}</span>` : ''}
            ${p.published ? '' : '<span style="font-size:11px;color:#e44;font-weight:700">● مخفي</span>'}
            ${p.in_stock === false ? '<span style="font-size:11px;color:#c60;font-weight:700">● غير متاح</span>' : ''}
          </div>
          <p style="margin:4px 0 2px;font-weight:700;font-size:14px">${p.name_ar}</p>
          <p style="margin:0;font-size:12px;color:var(--muted)">${p.specs_ar || ''} ${p.notes ? '— ' + p.notes : ''}</p>
          ${(() => {
            if (p.category !== 'inverters') return '';
            const { kw, hp } = detectInvPower(p);
            if (kw || hp) return `<p style="margin:2px 0 0;font-size:11px;color:var(--brand-dark);font-weight:700">⚡ ${kw ? kw + ' KW' : ''}${kw && hp ? ' — ' : ''}${hp ? hp + ' HP' : ''}</p>`;
            return `<p style="margin:2px 0 0;font-size:11px;color:#e44">⚠️ القدرة غير مسجلة — اكتبها في المواصفات (مثال: 5.5 HP - 4 KW) أو في حقلي KW/HP</p>`;
          })()}
          ${p.model_available ? `<p style="margin:2px 0 0;font-size:11px;color:var(--brand-dark)">📋 موديل: ${p.model_available}</p>` : ''}
          ${p.datasheet_url ? `<a href="${p.datasheet_url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--brand);text-decoration:none">📄 داتا شيت</a>` : ''}
        </div>
      </div>
      <div style="text-align:left;flex-shrink:0">
        <p style="font-weight:800;font-size:16px;color:var(--brand-dark);margin:0">${Number(p.price).toLocaleString('ar-EG')} <span style="font-size:11px;font-weight:400">ج.م/${p.unit||'قطعة'}</span></p>
        <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
          <button type="button" onclick="editProduct('${p.id}')"
            style="padding:4px 12px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:12px;cursor:pointer">✏️ تعديل</button>
          <button type="button" onclick="toggleProductPublish('${p.id}',${p.published})"
            style="padding:4px 12px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:12px;cursor:pointer">${p.published ? '🙈 إخفاء' : '👁️ نشر'}</button>
          <button type="button" onclick="toggleProductStock('${p.id}',${p.in_stock !== false})"
            style="padding:4px 12px;border-radius:var(--radius);border:1px solid ${p.in_stock === false ? '#fcc' : 'var(--line)'};background:${p.in_stock === false ? '#fff3f3' : '#fff'};font-size:12px;cursor:pointer;color:${p.in_stock === false ? '#c33' : 'inherit'}">${p.in_stock === false ? '🔴 غير متاح' : '🟢 متاح'}</button>
          <button type="button" onclick="deleteProduct('${p.id}')"
            style="padding:4px 12px;border-radius:var(--radius);border:1px solid #fcc;background:#fff3f3;font-size:12px;cursor:pointer;color:#c33">🗑️ حذف</button>
        </div>
      </div>
    </div>`).join('');
}

function setProductImagePreview(url) {
  const prev = document.getElementById('productImagePreview');
  const removeBtn = document.getElementById('removeProductImageBtn');
  if (!prev) return;
  if (url) {
    prev.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
    if (removeBtn) removeBtn.style.display = 'inline-block';
  } else {
    prev.innerHTML = `<span style="color:var(--muted);font-size:10px">بدون صورة</span>`;
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function removeProductImage() {
  document.getElementById('productImageUrl').value = '';
  const fileInput = document.getElementById('productImageFile');
  if (fileInput) fileInput.value = '';
  setProductImagePreview('');
}

document.addEventListener('DOMContentLoaded', () => {
  const imgFile = document.getElementById('productImageFile');
  if (imgFile) {
    imgFile.addEventListener('change', function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => setProductImagePreview(e.target.result);
      reader.readAsDataURL(file);
    });
  }
});

// Show/hide the name, specs, and power fields based on the selected category.
// Inverters: no free-text specs, name is auto-derived from the brand, and
// KW/HP become the explicit required source of the power rating.
// Everything else: keep the classic name + specs fields, power fields hidden.
function toggleProductFieldsByCategory(cat) {
  const nameWrap = document.getElementById('nameFieldWrap');
  const nameInput = document.getElementById('productName');
  const specsWrap = document.getElementById('specsFieldWrap');
  const powerWrap = document.getElementById('powerFieldsWrap');
  const kwInput = document.getElementById('productPowerKw');
  const hpInput = document.getElementById('productPowerHp');
  const offgridWrap = document.getElementById('offgridFieldsWrap');
  const battWrap = document.getElementById('battFieldsWrap');
  const panelWrap = document.getElementById('panelFieldsWrap');
  if (!nameWrap || !specsWrap || !powerWrap) return;

  // reset all optional technical blocks first
  powerWrap.style.display = 'none'; if (kwInput) kwInput.required = false; if (hpInput) hpInput.required = false;
  if (offgridWrap) offgridWrap.style.display = 'none';
  if (battWrap) battWrap.style.display = 'none';
  if (panelWrap) panelWrap.style.display = 'none';
  document.getElementById('ogPowerKw') && (document.getElementById('ogPowerKw').required = false);
  document.getElementById('ogVoltage') && (document.getElementById('ogVoltage').required = false);
  document.getElementById('battVoltage') && (document.getElementById('battVoltage').required = false);
  document.getElementById('battAh') && (document.getElementById('battAh').required = false);
  document.getElementById('panelWatt') && (document.getElementById('panelWatt').required = false);

  if (cat === 'inverters') {
    nameInput.required = false;
    if (nameWrap) nameWrap.style.display = 'none';
    specsWrap.style.display = 'none';
    powerWrap.style.display = 'grid';
    if (kwInput) kwInput.required = true;
    if (hpInput) hpInput.required = true;
  } else {
    nameInput.required = true;
    if (nameWrap) nameWrap.style.display = 'block';
    specsWrap.style.display = 'block';
    if (cat === 'offgrid' && offgridWrap) {
      offgridWrap.style.display = 'grid';
      document.getElementById('ogPowerKw').required = true;
      document.getElementById('ogVoltage').required = true;
    } else if (cat === 'batteries' && battWrap) {
      battWrap.style.display = 'grid';
      document.getElementById('battVoltage').required = true;
      document.getElementById('battAh').required = true;
    } else if (cat === 'panels' && panelWrap) {
      panelWrap.style.display = 'grid';
      document.getElementById('panelWatt').required = true;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const catSelect = document.getElementById('productCategory');
  if (catSelect) {
    catSelect.addEventListener('change', () => toggleProductFieldsByCategory(catSelect.value));
    toggleProductFieldsByCategory(catSelect.value);
  }
});

function editProduct(id) {
  const p = allDashProducts.find(x => x.id === id);
  if (!p) return;
  document.getElementById('productEditId').value = p.id;
  document.getElementById('productCategory').value = p.category;
  toggleProductFieldsByCategory(p.category);
  document.getElementById('productBrand').value = p.brand || '';
  document.getElementById('productName').value = p.name_ar;
  document.getElementById('productSpecs').value = p.specs_ar || '';
  if (p.category === 'inverters') {
    // Legacy products stored power only inside the specs text — pull it out
    // so it lands in the new explicit fields the first time this is edited.
    const { kw, hp } = detectInvPower(p);
    document.getElementById('productPowerKw').value = kw != null ? kw : '';
    document.getElementById('productPowerHp').value = hp != null ? hp : '';
  } else {
    document.getElementById('productPowerKw').value = p.power_kw != null ? p.power_kw : '';
    document.getElementById('productPowerHp').value = p.power_hp != null ? p.power_hp : '';
  }
  document.getElementById('productModel').value = p.model_available || '';
  document.getElementById('invVoltageV').value = p.voltage_v != null ? p.voltage_v : '';
  document.getElementById('invPvVocMax').value = p.pv_voc_max != null ? p.pv_voc_max : '';
  document.getElementById('invMpptMin').value = p.pv_mppt_min != null ? p.pv_mppt_min : '';
  document.getElementById('invMpptMax').value = p.pv_mppt_max != null ? p.pv_mppt_max : '';
  document.getElementById('ogPowerKw').value = p.power_kw != null ? p.power_kw : '';
  document.getElementById('ogVoltage').value = p.voltage_v != null ? p.voltage_v : '';
  document.getElementById('ogPvVocMax').value = p.pv_voc_max != null ? p.pv_voc_max : '';
  document.getElementById('ogSurgePct').value = p.surge_capacity_pct != null ? p.surge_capacity_pct : '';
  document.getElementById('ogMpptMin').value = p.pv_mppt_min != null ? p.pv_mppt_min : '';
  document.getElementById('ogMpptMax').value = p.pv_mppt_max != null ? p.pv_mppt_max : '';
  document.getElementById('battVoltage').value = p.voltage_v != null ? p.voltage_v : '';
  document.getElementById('battAh').value = p.capacity_ah != null ? p.capacity_ah : '';
  document.getElementById('battDod').value = p.dod != null ? p.dod : '';
  document.getElementById('panelWatt').value = p.power_watt != null ? p.power_watt : '';
  document.getElementById('panelVoc').value = p.voc != null ? p.voc : '';
  document.getElementById('panelVimp').value = p.vimp != null ? p.vimp : '';
  document.getElementById('productDatasheet').value = p.datasheet_url || '';
  document.getElementById('productUnit').value = p.unit || 'قطعة';
  document.getElementById('productPrice').value = p.price;
  document.getElementById('productNotes').value = p.notes || '';
  document.getElementById('productSort').value = p.sort_order;
  document.getElementById('productPublished').checked = p.published;
  document.getElementById('productInStock').checked = p.in_stock !== false;
  document.getElementById('productImageUrl').value = p.image_url || '';
  document.getElementById('productImageFile').value = '';
  setProductImagePreview(p.image_url || '');
  document.getElementById('productAddWrap').style.display = 'block';
  document.getElementById('productAddWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelProductForm() {
  document.getElementById('productForm').reset();
  document.getElementById('productEditId').value = '';
  document.getElementById('productImageUrl').value = '';
  document.getElementById('productPowerKw').value = '';
  document.getElementById('productPowerHp').value = '';
  ['ogPowerKw','ogVoltage','ogPvVocMax','ogSurgePct','ogMpptMin','ogMpptMax','battVoltage','battAh','battDod','panelWatt','panelVoc','panelVimp','invVoltageV','invPvVocMax','invMpptMin','invMpptMax']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  setProductImagePreview('');
  document.getElementById('productAddWrap').style.display = 'none';
  toggleProductFieldsByCategory(document.getElementById('productCategory').value);
}

async function toggleProductPublish(id, current) {
  if (!client) return;
  await client.from('products').update({ published: !current }).eq('id', id);
  loadProducts();
}

async function toggleProductStock(id, current) {
  if (!client) return;
  await client.from('products').update({ in_stock: !current }).eq('id', id);
  loadProducts();
}

async function deleteProduct(id) {
  if (!confirm('هل أنت متأكد من حذف هذا المنتج؟')) return;
  if (!client) return;
  await client.from('products').delete().eq('id', id);
  loadProducts();
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('productForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('productMessage');
    if (msg) msg.textContent = 'جاري الحفظ...';
    const editId = document.getElementById('productEditId').value;

    // Keep existing image_url unless a new file was chosen
    let imageUrl = document.getElementById('productImageUrl').value || null;
    const imageFile = document.getElementById('productImageFile')?.files[0];
    if (imageFile) {
      try {
        if (msg) msg.textContent = 'جاري رفع الصورة...';
        imageUrl = await uploadImage(imageFile, 'products');
      } catch (err) {
        if (msg) msg.textContent = 'خطأ في رفع الصورة: ' + err.message;
        return;
      }
    }

    const category = document.getElementById('productCategory').value;
    const isInverter = category === 'inverters';
    const isOffgrid = category === 'offgrid';
    const isBattery = category === 'batteries';
    const isPanel = category === 'panels';
    const brandValue = document.getElementById('productBrand').value.trim();
    const powerKwValue = document.getElementById('productPowerKw').value;
    const powerHpValue = document.getElementById('productPowerHp').value;

    if (isInverter && (powerKwValue === '' || powerHpValue === '')) {
      if (msg) msg.textContent = 'من فضلك سجّل القدرة بالكيلووات وبالحصان — دي المصدر اللي الموقع بيعرض بيه القدرة على كل الكروت.';
      return;
    }
    if (isInverter && !brandValue) {
      if (msg) msg.textContent = 'من فضلك اكتب الماركة — بيتولد منها اسم المنتج تلقائيًا للإنفرترات.';
      return;
    }
    if (isOffgrid && (document.getElementById('ogPowerKw').value === '' || document.getElementById('ogVoltage').value === '')) {
      if (msg) msg.textContent = 'من فضلك سجّل القدرة بالكيلووات وجهد التيار المستمر — الحاسبة محتاجاهم لاختيار الموديل تلقائيًا.';
      return;
    }
    if (isBattery && (document.getElementById('battVoltage').value === '' || document.getElementById('battAh').value === '')) {
      if (msg) msg.textContent = 'من فضلك سجّل فولت وسعة (Ah) البطارية — الحاسبة محتاجاهم.';
      return;
    }
    if (isPanel && document.getElementById('panelWatt').value === '') {
      if (msg) msg.textContent = 'من فضلك سجّل قدرة اللوح بالوات — بدونها مش هيظهر اختيار قدرة للزائر في الحاسبة.';
      return;
    }

    // Inverters: name is auto-derived from the brand ("Inverter" is the
    // category, not part of the name), and specs text is replaced entirely
    // by the explicit KW/HP fields above.
    const nameValue = isInverter ? brandValue : document.getElementById('productName').value.trim();
    const specsValue = isInverter ? null : (document.getElementById('productSpecs').value.trim() || null);

    const payload = {
      category:   category,
      brand:      brandValue || null,
      name_ar:    nameValue,
      specs_ar:   specsValue,
      model_available: document.getElementById('productModel').value.trim() || null,
      datasheet_url:   document.getElementById('productDatasheet').value.trim() || null,
      unit:       document.getElementById('productUnit').value,
      price:      parseFloat(document.getElementById('productPrice').value) || 0,
      notes:      document.getElementById('productNotes').value.trim() || null,
      image_url:  imageUrl,
      sort_order: parseInt(document.getElementById('productSort').value) || 100,
      published:  document.getElementById('productPublished').checked,
      in_stock:   document.getElementById('productInStock').checked,
      updated_at: new Date().toISOString(),
    };

    // Technical fields: only ever included in the payload for the category
    // that actually manages them — this way saving, say, a panel's price
    // never silently wipes an unrelated inverter's power_kw, and vice versa.
    if (isInverter) {
      payload.power_kw = powerKwValue !== '' ? parseFloat(powerKwValue) : null;
      payload.power_hp = powerHpValue !== '' ? parseFloat(powerHpValue) : null;
      // Optional: some inverter models are AC/DC hybrid (accept direct PV
      // input with a single MPPT channel) — only saved if the admin actually
      // filled them in; left untouched (not nulled) for pure-AC models.
      const iv = id => document.getElementById(id).value;
      if (iv('invVoltageV') !== '') payload.voltage_v = parseFloat(iv('invVoltageV'));
      if (iv('invPvVocMax') !== '') payload.pv_voc_max = parseFloat(iv('invPvVocMax'));
      if (iv('invMpptMin') !== '') payload.pv_mppt_min = parseFloat(iv('invMpptMin'));
      if (iv('invMpptMax') !== '') payload.pv_mppt_max = parseFloat(iv('invMpptMax'));
    } else if (isOffgrid) {
      const v = id => document.getElementById(id).value;
      payload.power_kw           = v('ogPowerKw') !== '' ? parseFloat(v('ogPowerKw')) : null;
      payload.voltage_v          = v('ogVoltage') !== '' ? parseFloat(v('ogVoltage')) : null;
      payload.pv_voc_max         = v('ogPvVocMax') !== '' ? parseFloat(v('ogPvVocMax')) : null;
      payload.surge_capacity_pct = v('ogSurgePct') !== '' ? parseFloat(v('ogSurgePct')) : null;
      payload.pv_mppt_min        = v('ogMpptMin') !== '' ? parseFloat(v('ogMpptMin')) : null;
      payload.pv_mppt_max        = v('ogMpptMax') !== '' ? parseFloat(v('ogMpptMax')) : null;
    } else if (isBattery) {
      const v = id => document.getElementById(id).value;
      payload.voltage_v  = v('battVoltage') !== '' ? parseFloat(v('battVoltage')) : null;
      payload.capacity_ah = v('battAh') !== '' ? parseFloat(v('battAh')) : null;
      payload.dod         = v('battDod') !== '' ? parseFloat(v('battDod')) : null;
    } else if (isPanel) {
      const v = id => document.getElementById(id).value;
      payload.power_watt = v('panelWatt') !== '' ? parseFloat(v('panelWatt')) : null;
      payload.voc         = v('panelVoc') !== '' ? parseFloat(v('panelVoc')) : null;
      payload.vimp         = v('panelVimp') !== '' ? parseFloat(v('panelVimp')) : null;
    }
    // NOTE: categories above never touch each other's technical columns —
    // e.g. saving a 'panels' product leaves power_kw/voltage_v/dod (owned by
    // 'offgrid'/'batteries') completely untouched in the database.

    if (!payload.name_ar) { if (msg) msg.textContent = 'اسم المنتج مطلوب.'; return; }
    if (msg) msg.textContent = 'جاري الحفظ...';
    let error;
    if (editId) {
      ({ error } = await client.from('products').update(payload).eq('id', editId));
    } else {
      ({ error } = await client.from('products').insert(payload));
    }
    if (error) { if (msg) msg.textContent = 'خطأ: ' + error.message; return; }
    if (msg) { msg.textContent = '✅ تم الحفظ!'; setTimeout(() => { if (msg) msg.textContent = ''; }, 3000); }
    cancelProductForm();
    loadProducts();
  });
});

// ══════════════════════════════════════════════════════════════
// Brand Logos — one shared logo per brand, used as a fallback image
// for every product of that brand that doesn't have its own photo.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// Calculator Suggestions Settings — تفعيل/إلغاء قسم المنتجات الموصى بها
// في حاسبة الضخ، واختيار الماركة الافتراضية (رقم 1) لكل فئة.
// ══════════════════════════════════════════════════════════════

const CALC_SETTINGS_CATS = [
  { cat: 'well_motors', selectId: 'calcBrandWellMotors', col: 'preferred_well_motor_brand' },
  { cat: 'pumps',       selectId: 'calcBrandPumps',       col: 'preferred_pump_brand' },
  { cat: 'inverters',   selectId: 'calcBrandInverters',   col: 'preferred_inverter_brand' },
  { cat: 'pipes',       selectId: 'calcBrandPipes',       col: 'preferred_pipe_brand' },
];

async function loadCalcSettings() {
  if (!client) return;
  const { data: settings, error: sErr } = await client.from('calc_settings').select('*').eq('id', 1).single();
  if (sErr) { console.error('calc_settings load error', sErr); return; }

  document.getElementById('calcSuggestionsEnabled').checked = !!settings.suggestions_enabled;

  for (const c of CALC_SETTINGS_CATS) {
    const sel = document.getElementById(c.selectId);
    if (!sel) continue;
    const { data: rows } = await client.from('products').select('brand').eq('category', c.cat).eq('published', true);
    const brands = [...new Set((rows || []).map(r => r.brand).filter(Boolean))].sort();
    const current = settings[c.col] || '';
    sel.innerHTML = '<option value="">— بدون تفضيل (أي ماركة) —</option>' +
      brands.map(b => `<option value="${escapeHtmlAttr(b)}" ${b === current ? 'selected' : ''}>${escapeHtmlAttr(b)}</option>`).join('');
  }
}

async function saveCalcSettings(event) {
  event.preventDefault();
  const msg = document.getElementById('calcSettingsMessage');
  const payload = { suggestions_enabled: document.getElementById('calcSuggestionsEnabled').checked, updated_at: new Date().toISOString() };
  CALC_SETTINGS_CATS.forEach(c => {
    const v = document.getElementById(c.selectId).value;
    payload[c.col] = v || null;
  });
  const { error } = await client.from('calc_settings').update(payload).eq('id', 1);
  msg.style.color = error ? '#c33' : '#2a7a2a';
  msg.textContent = error ? ('خطأ: ' + error.message) : '✅ تم حفظ إعدادات الحاسبة';
  setTimeout(() => { msg.textContent = ''; }, 3500);
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('calcSettingsForm');
  if (form) form.addEventListener('submit', saveCalcSettings);
});

// ══════════════════════════════════════════════════════════════
// Off-Grid Calculator Settings — تفعيل/إيقاف الحاسبة، الماركات
// المفضلة، وإدارة عروض المنظومات الجاهزة (offgrid_presets)
// ══════════════════════════════════════════════════════════════

// لازم الأسماء دي تتطابق حرفيًا مع DEFAULT_LOADS في offgrid-calculator.html
const OFFGRID_LOAD_NAMES = [
  'لمبة - LED Light', 'DVR / NVR', 'راوتر / شاحن', 'كاميرا مراقبة', 'لابتوب', 'مروحة',
  'شفاط مطبخ', 'تلفاز LCD / كاميرات CCTV', 'تلفاز LCD', 'ثلاجة', 'كشاف إنارة', 'فريزر',
  'موتور 1 حصان', 'ميكروويف', 'موتور 1.5 حصان / غاطس', 'تكييف 1.5 حصان', 'غسالة',
  'تكييف 2.5 حصان', 'تكييف 3 حصان', 'هيتر مياه',
];

const OFFGRID_BRAND_SELECTS = [
  { cat: 'offgrid',   selectId: 'offgridBrandInverter' },
  { cat: 'batteries', selectId: 'offgridBrandBattery' },
  { cat: 'panels',    selectId: 'offgridBrandPanel' },
];

async function loadOffgridSettings() {
  if (!client) return;
  const { data: settings, error } = await client.from('calc_settings').select('*').eq('id', 1).single();
  if (error) { console.error('offgrid settings load error', error); return; }

  document.getElementById('offgridEnabled').checked = !!settings.offgrid_enabled;

  const colMap = { offgridBrandInverter: 'preferred_offgrid_inverter_brand', offgridBrandBattery: 'preferred_offgrid_battery_brand', offgridBrandPanel: 'preferred_offgrid_panel_brand' };
  for (const c of OFFGRID_BRAND_SELECTS) {
    const sel = document.getElementById(c.selectId);
    if (!sel) continue;
    const { data: rows } = await client.from('products').select('brand,price').eq('category', c.cat).eq('published', true);
    const brands = [...new Set((rows || []).filter(r => r.price != null && Number(r.price) > 0).map(r => r.brand).filter(Boolean))].sort();
    const current = settings[colMap[c.selectId]] || '';
    sel.innerHTML = '<option value="">— بدون تفضيل (أي ماركة) —</option>' +
      brands.map(b => `<option value="${escapeHtmlAttr(b)}" ${b === current ? 'selected' : ''}>${escapeHtmlAttr(b)}</option>`).join('');
  }
}

async function saveOffgridSettings(event) {
  event.preventDefault();
  const msg = document.getElementById('offgridSettingsMessage');
  const payload = {
    offgrid_enabled: document.getElementById('offgridEnabled').checked,
    preferred_offgrid_inverter_brand: document.getElementById('offgridBrandInverter').value || null,
    preferred_offgrid_battery_brand: document.getElementById('offgridBrandBattery').value || null,
    preferred_offgrid_panel_brand: document.getElementById('offgridBrandPanel').value || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await client.from('calc_settings').update(payload).eq('id', 1);
  msg.style.color = error ? '#c33' : '#2a7a2a';
  msg.textContent = error ? ('خطأ: ' + error.message) : '✅ تم حفظ إعدادات الأوف جريد';
  setTimeout(() => { msg.textContent = ''; }, 3500);
}

async function loadOffgridPresets() {
  const list = document.getElementById('offgridPresetsList');
  if (!list || !client) return;
  const { data, error } = await client.from('offgrid_presets').select('*').order('sort_order');
  if (error) { list.innerHTML = `<p style="color:#c33;font-size:13px">خطأ في تحميل المنظومات: ${error.message}</p>`; return; }
  renderOffgridPresetsList(data || []);
}

function renderOffgridPresetsList(rows) {
  const list = document.getElementById('offgridPresetsList');
  if (!list) return;
  if (!rows.length) { list.innerHTML = `<p style="color:var(--muted);font-size:14px">مفيش منظومات مضافة لسه.</p>`; return; }
  list.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--line);border-radius:var(--radius);background:#fff;margin-bottom:8px">
      <div style="flex:1;min-width:0">
        <p style="margin:0;font-weight:700;font-size:14px">${escapeHtmlAttr(r.name)} ${r.is_active ? '' : '<span style="color:#c33;font-size:11px">(متوقفة)</span>'}</p>
        <p style="margin:2px 0 0;font-size:12px;color:var(--muted)">${escapeHtmlAttr(r.description || '')} — ${(r.items || []).length} جهاز</p>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" onclick='editOffgridPreset(${JSON.stringify(r).replace(/'/g, "&#39;")})'
          style="padding:4px 12px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:12px;cursor:pointer">✏️ تعديل</button>
        <button type="button" onclick="deleteOffgridPreset('${r.id}')"
          style="padding:4px 12px;border-radius:var(--radius);border:1px solid #fcc;background:#fff3f3;font-size:12px;cursor:pointer;color:#c33">🗑️ حذف</button>
      </div>
    </div>`).join('');
}

function buildOffgridPresetItemsPicker(selectedItems) {
  const picker = document.getElementById('offgridPresetItemsPicker');
  const selMap = {};
  (selectedItems || []).forEach(it => { selMap[it.load] = it.count; });
  picker.innerHTML = OFFGRID_LOAD_NAMES.map((name, i) => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
      <input type="number" min="0" value="${selMap[name] || 0}" data-load="${escapeHtmlAttr(name)}" style="width:52px;height:28px;padding:0 4px;border:1px solid var(--line);border-radius:6px;font-size:12px">
      <span>${name}</span>
    </label>`).join('');
}

function readOffgridPresetItems() {
  const inputs = document.querySelectorAll('#offgridPresetItemsPicker input[data-load]');
  const items = [];
  inputs.forEach(inp => {
    const count = Number(inp.value) || 0;
    if (count > 0) items.push({ load: inp.dataset.load, count });
  });
  return items;
}

function showOffgridPresetForm() {
  document.getElementById('offgridPresetFormWrap').style.display = 'block';
  document.getElementById('offgridPresetForm').reset();
  document.getElementById('offgridPresetId').value = '';
  document.getElementById('offgridPresetActive').checked = true;
  buildOffgridPresetItemsPicker([]);
  document.getElementById('offgridPresetFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelOffgridPresetForm() {
  document.getElementById('offgridPresetFormWrap').style.display = 'none';
  document.getElementById('offgridPresetForm').reset();
}

function editOffgridPreset(preset) {
  document.getElementById('offgridPresetFormWrap').style.display = 'block';
  document.getElementById('offgridPresetId').value = preset.id;
  document.getElementById('offgridPresetName').value = preset.name || '';
  document.getElementById('offgridPresetDesc').value = preset.description || '';
  document.getElementById('offgridPresetActive').checked = !!preset.is_active;
  buildOffgridPresetItemsPicker(preset.items || []);
  document.getElementById('offgridPresetFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteOffgridPreset(id) {
  if (!confirm('هل أنت متأكد من حذف المنظومة دي؟')) return;
  if (!client) return;
  await client.from('offgrid_presets').delete().eq('id', id);
  loadOffgridPresets();
}

document.addEventListener('DOMContentLoaded', () => {
  const settingsForm = document.getElementById('offgridSettingsForm');
  if (settingsForm) settingsForm.addEventListener('submit', saveOffgridSettings);

  const presetForm = document.getElementById('offgridPresetForm');
  if (presetForm) {
    presetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('offgridPresetMessage');
      const items = readOffgridPresetItems();
      if (!items.length) { msg.textContent = 'اختار جهاز واحد على الأقل بعدد أكبر من صفر.'; msg.style.color = '#c33'; return; }
      const id = document.getElementById('offgridPresetId').value;
      const payload = {
        name: document.getElementById('offgridPresetName').value.trim(),
        description: document.getElementById('offgridPresetDesc').value.trim() || null,
        items,
        is_active: document.getElementById('offgridPresetActive').checked,
        updated_at: new Date().toISOString(),
      };
      if (!payload.name) { msg.textContent = 'اسم المنظومة مطلوب.'; msg.style.color = '#c33'; return; }

      msg.textContent = 'جاري الحفظ...'; msg.style.color = 'var(--muted)';
      const { error } = id
        ? await client.from('offgrid_presets').update(payload).eq('id', id)
        : await client.from('offgrid_presets').insert(payload);
      if (error) { msg.textContent = 'خطأ: ' + error.message; msg.style.color = '#c33'; return; }
      msg.style.color = '#2a7a2a';
      msg.textContent = '✅ تم الحفظ!';
      setTimeout(() => { msg.textContent = ''; }, 2500);
      cancelOffgridPresetForm();
      loadOffgridPresets();
    });
  }
});


async function loadBrandLogos() {
  const list = document.getElementById('brandLogosList');
  if (!list || !client) return;
  const { data, error } = await client.from('brand_logos').select('*').order('brand');
  if (error) { list.innerHTML = `<p style="color:#c33;font-size:13px">خطأ في تحميل الشعارات: ${error.message}</p>`; return; }
  renderBrandLogosList(data || []);
}

function renderBrandLogosList(rows) {
  const list = document.getElementById('brandLogosList');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<p style="color:var(--muted);font-size:14px">مفيش شعارات مضافة لسه.</p>`;
    return;
  }
  list.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--line);border-radius:var(--radius);background:#fff">
      <div style="width:44px;height:44px;border-radius:var(--radius);background:#f9f6f2;border:1px solid var(--line);display:grid;place-items:center;overflow:hidden;flex-shrink:0">
        <img src="${escapeHtmlAttr(r.logo_url)}" style="width:100%;height:100%;object-fit:cover" alt="">
      </div>
      <div style="flex:1;min-width:0">
        <p style="margin:0;font-weight:700;font-size:14px">${escapeHtmlAttr(r.brand)}</p>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" onclick="editBrandLogo('${escapeHtmlAttr(r.brand)}','${escapeHtmlAttr(r.logo_url)}')"
          style="padding:4px 12px;border-radius:var(--radius);border:1px solid var(--line);background:#fff;font-size:12px;cursor:pointer">✏️ تعديل</button>
        <button type="button" onclick="deleteBrandLogo('${escapeHtmlAttr(r.brand)}')"
          style="padding:4px 12px;border-radius:var(--radius);border:1px solid #fcc;background:#fff3f3;font-size:12px;cursor:pointer;color:#c33">🗑️ حذف</button>
      </div>
    </div>`).join('');
}

function escapeHtmlAttr(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function setBrandLogoPreview(url) {
  const prev = document.getElementById('brandLogoPreview');
  if (!prev) return;
  prev.innerHTML = url
    ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`
    : `<span style="color:var(--muted);font-size:10px">بدون شعار</span>`;
}

function editBrandLogo(brand, logoUrl) {
  document.getElementById('brandLogoAddWrap').style.display = 'block';
  document.getElementById('addBrandLogoBtn').textContent = '+ إضافة / تعديل شعار';
  const nameInput = document.getElementById('brandLogoName');
  nameInput.value = brand;
  nameInput.dataset.originalBrand = brand; // needed so renaming a brand doesn't create a duplicate row
  document.getElementById('brandLogoFile').value = '';
  setBrandLogoPreview(logoUrl);
  document.getElementById('brandLogoForm').dataset.currentLogoUrl = logoUrl;
  document.getElementById('brandLogoAddWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelBrandLogoForm() {
  document.getElementById('brandLogoAddWrap').style.display = 'none';
  const form = document.getElementById('brandLogoForm');
  form.reset();
  delete form.dataset.currentLogoUrl;
  document.getElementById('brandLogoName').dataset.originalBrand = '';
  setBrandLogoPreview('');
}

async function deleteBrandLogo(brand) {
  if (!confirm(`هل أنت متأكد من حذف شعار "${brand}"؟ منتجات البراند ده هترجع تعرض بدون صورة لحد ما تتحدد صورة تانية.`)) return;
  if (!client) return;
  await client.from('brand_logos').delete().eq('brand', brand);
  loadBrandLogos();
}

document.addEventListener('DOMContentLoaded', () => {
  const logoFile = document.getElementById('brandLogoFile');
  if (logoFile) {
    logoFile.addEventListener('change', function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => setBrandLogoPreview(e.target.result);
      reader.readAsDataURL(file);
    });
  }

  const form = document.getElementById('brandLogoForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('brandLogoMessage');
    const brandInput = document.getElementById('brandLogoName');
    const brand = brandInput.value.trim();
    if (!brand) { if (msg) msg.textContent = 'اسم البراند مطلوب.'; return; }

    let logoUrl = form.dataset.currentLogoUrl || null;
    const file = document.getElementById('brandLogoFile')?.files[0];
    if (file) {
      try {
        if (msg) msg.textContent = 'جاري رفع الشعار...';
        logoUrl = await uploadImage(file, 'brand-logos');
      } catch (err) {
        if (msg) msg.textContent = 'خطأ في رفع الشعار: ' + err.message;
        return;
      }
    }
    if (!logoUrl) { if (msg) msg.textContent = 'من فضلك ارفع صورة الشعار.'; return; }

    if (msg) msg.textContent = 'جاري الحفظ...';
    const originalBrand = brandInput.dataset.originalBrand || '';
    let error;
    if (originalBrand && originalBrand !== brand) {
      // Brand name was edited: move the row instead of leaving a duplicate.
      ({ error } = await client.from('brand_logos').delete().eq('brand', originalBrand));
      if (!error) ({ error } = await client.from('brand_logos').insert({ brand, logo_url: logoUrl }));
    } else {
      ({ error } = await client.from('brand_logos').upsert({ brand, logo_url: logoUrl, updated_at: new Date().toISOString() }));
    }
    if (error) { if (msg) msg.textContent = 'خطأ: ' + error.message; return; }
    if (msg) { msg.textContent = '✅ تم الحفظ!'; setTimeout(() => { if (msg) msg.textContent = ''; }, 3000); }
    cancelBrandLogoForm();
    loadBrandLogos();
  });
});

/* ============================================================
   قسم خصومات الموردين — إضافة مستقلة، بتقرأ/تكتب في supplier_discounts
   بس (محمي بـ RLS للأدمن فقط)، من غير ما تلمس أي دالة تانية موجودة.
   الخصم على مستوى (فئة + ماركة) مش لكل منتج لوحده.
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  const categorySelect = document.getElementById("sdCategory");
  const brandSelect = document.getElementById("sdBrand");
  const pctInput = document.getElementById("sdPct");
  const saveBtn = document.getElementById("sdSaveBtn");
  const listBody = document.getElementById("sdListBody");
  const msg = document.querySelector("[data-sd-message]");
  if (!categorySelect || !saveBtn) return;

  async function loadBrandsForCategory() {
    brandSelect.innerHTML = `<option value="">جاري التحميل...</option>`;
    const { data, error } = await client.from("products")
      .select("brand")
      .eq("category", categorySelect.value)
      .eq("published", true);
    if (error || !data) { brandSelect.innerHTML = `<option value="">تعذر التحميل</option>`; return; }
    const brands = [...new Set(data.map((r) => r.brand).filter(Boolean))].sort();
    brandSelect.innerHTML = brands.length
      ? brands.map((b) => `<option value="${b}">${b}</option>`).join("")
      : `<option value="">لا توجد ماركات</option>`;
    if (brands.length) loadExistingDiscountForSelection();
  }

  async function loadExistingDiscountForSelection() {
    const { data } = await client.from("supplier_discounts")
      .select("supplier_discount_pct")
      .eq("category", categorySelect.value)
      .eq("brand", brandSelect.value)
      .maybeSingle();
    pctInput.value = data?.supplier_discount_pct ?? 0;
  }

  async function loadDiscountsList() {
    listBody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:var(--muted)">جاري التحميل...</td></tr>`;
    const { data, error } = await client.from("supplier_discounts")
      .select("category,brand,supplier_discount_pct")
      .order("category", { ascending: true });
    if (error) { listBody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:#b23">تعذر التحميل: ${error.message}</td></tr>`; return; }
    if (!data || !data.length) { listBody.innerHTML = `<tr><td colspan="4" style="padding:12px;color:var(--muted)">مفيش خصومات مسجّلة لسه.</td></tr>`; return; }
    listBody.innerHTML = data.map((r) => `
      <tr data-cat="${r.category}" data-brand="${r.brand}" style="border-bottom:1px solid var(--line)">
        <td style="padding:8px">${r.category}</td>
        <td style="padding:8px">${r.brand}</td>
        <td style="padding:8px">${r.supplier_discount_pct}%</td>
        <td style="padding:8px"><button type="button" class="sd-delete-btn" style="padding:5px 12px;border-radius:8px;border:1px solid #b23;background:#fff;color:#b23;font-size:12px;cursor:pointer">حذف</button></td>
      </tr>`).join("");
    listBody.querySelectorAll(".sd-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const row = e.target.closest("tr");
        await client.from("supplier_discounts").delete().eq("category", row.dataset.cat).eq("brand", row.dataset.brand);
        loadDiscountsList();
      });
    });
  }

  saveBtn.addEventListener("click", async () => {
    const category = categorySelect.value;
    const brand = brandSelect.value;
    const pct = Math.max(0, Math.min(100, parseFloat(pctInput.value) || 0));
    if (!category || !brand) { if (msg) { msg.style.color = "#b23"; msg.textContent = "اختار الفئة والماركة الأول."; } return; }
    saveBtn.disabled = true;
    const { error } = await client.from("supplier_discounts")
      .upsert({ category, brand, supplier_discount_pct: pct, updated_at: new Date().toISOString() }, { onConflict: "category,brand" });
    saveBtn.disabled = false;
    if (error) { if (msg) { msg.style.color = "#b23"; msg.textContent = "تعذر الحفظ: " + error.message; } return; }
    if (msg) { msg.style.color = "var(--forest)"; msg.textContent = "تم الحفظ."; setTimeout(() => { if (msg) msg.textContent = ""; }, 2500); }
    loadDiscountsList();
  });

  categorySelect.addEventListener("change", loadBrandsForCategory);
  brandSelect.addEventListener("change", loadExistingDiscountForSelection);

  loadBrandsForCategory();
  loadDiscountsList();
});
