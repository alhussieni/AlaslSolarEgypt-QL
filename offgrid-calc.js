/* =========================================================================
   محرك حسابات الأوف جريد (نظام مستقل بالبطاريات)
   منقول بالكامل من معادلات ملف الإكسل "Off_Grid_Calculations" (شيتات:
   Data input / OFF GRID INVERTER / Battery list / modified offer)
   كل دالة هنا تقابل خلية أو مجموعة خلايا في الشيت الأصلي - انظر التعليقات

   الزائر بيختار الماركة بس للانفرتر والبطارية، والموديل/القدرة بيتحددوا
   تلقائيًا حسب إجمالي الأحمال المطلوب تشغيلها (بدل ما يختار موديل بعينه)
   ========================================================================= */

function roundUpTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.ceil(value * f) / f;
}

/** يختار أصغر انفرتر من نفس الماركة تكفي قدرته لتغطية القدرة اللحظية المطلوبة
 *  وكمان تيار البدء (Surge). لو مفيش موديل بيغطي الاتنين مع بعض، بيرجّع أكبر
 *  موديل متاح ويوضّح أي شرط فيهم (المستقر أو تيار البدء) لسه ناقص */
function pickInverterForBrand(data, brand, requiredKW, peakInstantaneousW, defaultSurgePct) {
  const options = data.offgrid.inverters.filter(m => m.brand === brand).sort((a, b) => a.powerKW - b.powerKW);
  if (!options.length) return { model: null, undersized: false, surgeUndersized: false };
  const surgeCapOf = m => m.powerKW * 1000 * (m.surgeCapacityPct || defaultSurgePct || 1);
  const fit = options.find(m => m.powerKW >= requiredKW && peakInstantaneousW <= surgeCapOf(m));
  if (fit) return { model: fit, undersized: false, surgeUndersized: false };
  const largest = options[options.length - 1]; // أكبر موديل متاح، بس لسه مش كافي في شرط واحد على الأقل
  return {
    model: largest,
    undersized: largest.powerKW < requiredKW,
    surgeUndersized: peakInstantaneousW > surgeCapOf(largest),
  };
}

/** يختار بطارية من نفس الماركة بنفس جهد الانفرتر (أو أقرب جهد أقل منه)،
 *  وبأكبر سعة AH متاحة (عشان أقل عدد بطاريات ممكن) */
/** يختار بطارية من نفس الماركة بجهد يقسم جهد الانفرتر بالظبط (بدون باقي)،
 *  لأن عدد بطاريات "كسور" على التوالي (Series) مستحيل فيزيائيًا - وبأكبر
 *  سعة AH متاحة عند أنسب جهد (عشان أقل عدد بطاريات ممكن) */
function pickBatteryForBrand(data, brand, inverterVoltage) {
  const brandOptions = data.offgrid.batteries.filter(b => b.brand === brand);
  if (!brandOptions.length) return null;
  // لازم جهد البطارية يقسم جهد الانفرتر بالظبط (باقي القسمة = صفر) عشان
  // عدد البطاريات على التوالي (inverterVoltage / batteryVoltage) يبقى عدد صحيح فعلي
  const compatible = brandOptions.filter(b => b.voltage <= inverterVoltage && inverterVoltage % b.voltage === 0);
  if (!compatible.length) return null;
  const bestVoltage = Math.max(...compatible.map(b => b.voltage));
  const atBestVoltage = compatible.filter(b => b.voltage === bestVoltage);
  return atBestVoltage.sort((a, b) => b.ah - a.ah)[0]; // أكبر سعة AH عند نفس الجهد
}

/**
 * inputs = {
 *   panelBrand, panelPower,            // نفس ألواح النظام الرئيسي
 *   invBrand, battBrand,               // الماركة بس - القدرة بتتحدد تلقائيًا
 *   phase: 'single' | 'three',
 *   psh, safetyFactor,
 *   morningEnabled, nightEnabled,      // Data input!E8 / E9
 *   extraPanelsOverride, extraBatteryStrings, manualPanelAdj, installQtyOverride,
 *   extraDiscountAmount,
 *   loads: [{ name, watt, runningFactor, nightHours, dayHours, count }, ...]
 *           (nightHours/dayHours قابلين للتعديل من الزائر؛ لو سابهم زي ما
 *           هما بييجوا بالقيم الافتراضية اللي حطها الأدمن)
 * }
 */
function computeOffgridOffer(data, inputs) {
  const og = data.offgrid;
  const errors = [];

  const panel = findPanel(data, inputs.panelBrand, inputs.panelPower);
  if (!panel) { errors.push('اللوح المختار غير موجود في القائمة.'); return { errors }; }
  // فحص إلزامي: من غير السعر، Number(null) بترجع 0 في JS، فيتحسب سعر اللوح
  // = المارجن بس (panelMarkupPerWatt) من غير التكلفة الأصلية - ده كان بيسبب
  // تسعير شبه مجاني لأي لوح سعره مش مسجّل (نفس الفحص موجود في calc.js أصلًا)
  if (panel.price === null || panel.price === undefined || panel.price === '') {
    errors.push(`اللوح المختار (${panel.brand} ${panel.power}W) مالوش سعر مسجّل - يرجى اختيار لوح تاني أو استكمال السعر من لوحة الأدمن قبل إصدار العرض.`);
    return { errors };
  }
  if (!inputs.invBrand) { errors.push('اختار ماركة الانفرتر.'); return { errors }; }
  if (!inputs.battBrand) { errors.push('اختار ماركة البطارية.'); return { errors }; }

  const psh = Number(inputs.psh) || og.psh;
  const safetyFactor = Number(inputs.safetyFactor) || og.safetyFactor;

  /* ---- 1) حمل الأحمال: لكل بند "الاحمال" في الجدول ----
     فترة النهار معرّفة من 8 صباحًا لـ 4 عصرًا (8 ساعات)، وباقي الـ24
     ساعة (16 ساعة) تعتبر فترة ليلية - الزائر بيدخل عدد الساعات لكل
     جهاز في الفترتين، ولو مش عارف بيسيب القيم الافتراضية */
  let R2 = 0;   // اجمالي القدرة اللحظية Max Power (Data input!R2) - في وضع التشغيل المستقر
  let sumNight = 0, sumDay = 0;
  let peakSurgeAddOn = 0, worstSurgeLoad = null;
  const loadRows = (inputs.loads || []).map(l => {
    const count = Number(l.count) || 0;
    const H = (Number(l.watt) || 0) * count;                                   // القدرة الاجمالية للحمل
    // ملحوظة: مينفعش نستخدم (Number(l.runningFactor) || 1) لأن الصفر قيمة
    // falsy في JS، فلو حد سجّل runningFactor=0 فعلاً (يعني الجهاز ده منسبتش
    // فيه اصلا) هيتحول غلط لـ1 (100%). بنفرّق هنا بين "القيمة مش موجودة"
    // و"القيمة = صفر فعليًا"
    const runningFactor = (l.runningFactor === undefined || l.runningFactor === null || l.runningFactor === '')
      ? 1 : Number(l.runningFactor);
    const I = (Number(l.nightHours) || 0) * H * runningFactor; // المجموع الليلي Wh
    const J = (Number(l.dayHours) || 0) * H * runningFactor;   // المجموع النهاري Wh
    R2 += H;
    sumNight += I;
    sumDay += J;
    // تيار البدء (Inrush/Starting Current): بنفترض أسوأ سيناريو واقعي - جهاز
    // واحد بس من كل نوع بيبدأ تشغيله في نفس لحظة استقرار كل الأجهزة التانية
    // (مش كل الموتورات بتبدأ مع بعض فعليًا)، فبنحسب "الزيادة" الإضافية
    // اللي هيسببها بدء أكبر جهاز (بالفرق بين تيار البدء والتيار المستقر له)
    if (count > 0 && l.surgeFactor && l.surgeFactor > 1) {
      const surgeAddOn = (Number(l.watt) || 0) * (l.surgeFactor - 1);
      if (surgeAddOn > peakSurgeAddOn) { peakSurgeAddOn = surgeAddOn; worstSurgeLoad = l.name; }
    }
    return { ...l, count, H, I, J, K: I + J };
  });
  const peakInstantaneousW = R2 + peakSurgeAddOn; // القدرة اللحظية القصوى شاملة تيار بدء أكبر جهاز

  const morningEnabled = !!inputs.morningEnabled;
  const nightEnabled = !!inputs.nightEnabled;
  const J10 = sumDay * (morningEnabled ? 1 : 0);   // اجمالي القدرة النهار w
  const I10 = sumNight * (nightEnabled ? 1 : 0);   // اجمالي القدرة الليل w
  const R3 = J10, R4 = I10;
  const R5 = R3 + R4;                              // اجمالي قدرة المطلوبة لليوم WH
  const R6 = psh ? R5 / psh : 0;                    // NEED POWER TO BE INSTALLED W

  /* ---- 2) اختيار الانفرتر تلقائيًا حسب الماركة + القدرة اللحظية المطلوبة
     وتيار البدء مع بعض في نفس خطوة الترشيح (مش بعدها) ---- */
  const requiredKW = roundUpTo(R2 / 1000, 1);
  const surgePctDefault = og.defaultSurgeCapacityPct || 1;
  const { model: inv, undersized: invUndersized, surgeUndersized } =
    pickInverterForBrand(data, inputs.invBrand, requiredKW, peakInstantaneousW, surgePctDefault);
  if (!inv) { errors.push(`مفيش موديلات انفرتر مسجلة لماركة "${inputs.invBrand}".`); return { errors }; }
  if (invUndersized) errors.push(`أكبر انفرتر متاح من ماركة ${inv.brand} (${inv.powerKW} KW) لسه أصغر من القدرة اللحظية المطلوبة (${requiredKW} KW) - قلل الأحمال أو جرّب ماركة تانية.`);
  const inverterVoltage = inv.voltage;

  /* ---- تحقق من تيار البدء (Starting Current) مقابل قدرة التحمّل اللحظية
     للانفرتر المُختار - لو مسجلة نسبة تحمّل حقيقية للموديل بنستخدمها، غير
     كده بنستخدم افتراض عام متحفّظ (150%) وبننبّه إنه تقريبي. الترشيح فوق
     أصلًا حاول ياخد موديل أكبر يغطي الشرط ده، فالتحذير هنا بيظهر بس لو حتى
     أكبر موديل متاح من الماركة لسه مش كافي */
  const surgeCapacityPct = inv.surgeCapacityPct || surgePctDefault;
  const surgeCapacityW = inv.powerKW * 1000 * surgeCapacityPct;
  if (surgeUndersized && peakSurgeAddOn > 0) {
    const basis = inv.surgeCapacityPct ? 'من الداتا شيت' : 'افتراض عام تقريبي 150% - سجّل النسبة الحقيقية من الداتا شيت لدقة أعلى';
    errors.push(`⚠ أكبر انفرتر متاح من ماركة ${inv.brand} (${inv.powerKW} KW) لسه مش هيتحمّل تيار بدء "${worstSurgeLoad}" (القدرة اللحظية المطلوبة ${Math.round(peakInstantaneousW)}W مقابل قدرة تحمّل الانفرتر ${Math.round(surgeCapacityW)}W، ${basis}) - جرّب ماركة تانية أو شغّل الموتورات الكبيرة لوحدها منفصلة.`);
  }

  /* ---- 3) اختيار البطارية تلقائيًا حسب الماركة + جهد الانفرتر ---- */
  const batt = pickBatteryForBrand(data, inputs.battBrand, inverterVoltage);
  if (!batt) { errors.push(`مفيش بطاريات من ماركة "${inputs.battBrand}" بجهد متوافق مع الانفرتر (${inverterVoltage}V) - جرّب ماركة تانية.`); return { errors }; }
  const batteryVoltage = batt.voltage;
  const designOkay = inverterVoltage >= batteryVoltage;

  /* ---- 4) تصميم بنك البطاريات ---- */
  const R7 = (batt.dod && inverterVoltage) ? (R4 * safetyFactor) / (batt.dod * inverterVoltage) : 0; // BATTERY CAPACITY FOR DAY AH
  const O7 = designOkay ? inverterVoltage / batteryVoltage : 0;  // عدد البطاريات في الاسترينج
  const extraStrings = Number(inputs.extraBatteryStrings) || 0;
  const O8 = batt.ah ? Math.ceil(R7 / batt.ah) + extraStrings : extraStrings; // عدد الاسترينجات
  const O6 = Math.round(O7 * O8);                  // اجمالي عدد البطاريات
  const O9 = O7 * O8 * batt.ah * batteryVoltage;    // اجمالي القدرة المخزنة WH
  const O10 = I10 ? (O9 - I10) / I10 : null;        // هامش أمان التخزين (اختياري/عرض فقط)
  // تنبيه: حجم البطاريات هنا مبني على الحمل الليلي بس (R4). لو R4=0 هتطلع
  // السعة المطلوبة صفر، يعني نظام "أوف جريد" من غير أي مخزون طاقة إطلاقًا -
  // من غير هامش لتغطية يوم غيم أو تذبذب الشمس. ده قرار تصميم محتاج مراجعة/
  // تأكيد صاحب النظام، مش خطأ برمجي، فبنكتفي هنا بتنبيه صريح بدل ما نغيّر
  // المنطق من غير تفويض - لكن لازم نوضح السبب الحقيقي بدقة: تعطيل الليل
  // فعليًا حاجة، وعدم وجود أي حمل ليلي مسجل مع إن الليل مفعّل حاجة تانية
  if (R4 <= 0) {
    const reason = !nightEnabled
      ? 'لأنك عطّلت فترة الليل'
      : 'لأن مفيش أي جهاز متسجل بساعات تشغيل ليلية (رغم إن فترة الليل مفعّلة)';
    errors.push(`⚠ سعة البطاريات المحسوبة = صفر أو شبه معدومة ${reason} - النظام هيشتغل بدون أي مخزون طاقة حقيقي، وده يعني مفيش تغطية ليوم غيم أو انقطاع الشمس المؤقت. راجع الاحتياج الفعلي قبل التسليم.`);
  }

  /* ---- 5) تصميم مصفوفة الألواح ----
     ملحوظة هندسية: بنضيف "كفاءة النظام الفعلية" (حرارة/أتربة/كابلات/كفاءة
     تحويل الشاحن) - في الإكسل الأصلي معامل الأمان (10%) كان بيغطي جزء بسيط
     من الفاقد الحقيقي، لكن الفاقد الفعلي في المناخ الحار عادة أعلى من كده
     (نفس المنطق المستخدم في أدوات مشابهة زي حاسبة SuRa اللي بتستخدم ~78%) */
  const panelWatt = Number(panel.power);
  const chargeSunHours = Number(og.batteryChargeSunHours);
  const systemEfficiency = Number(og.systemEfficiency) || 1;
  const byBattery = panelWatt ? Math.ceil(O9 / (chargeSunHours * panelWatt * systemEfficiency)) : 0;
  const byDailyLoad = panelWatt ? Math.round((R6 / panelWatt) * safetyFactor / systemEfficiency) : 0;
  const manualPanelAdj = Number(inputs.manualPanelAdj) || 0;
  const extraPanels = inputs.extraPanelsOverride !== undefined && inputs.extraPanelsOverride !== ''
    ? Number(inputs.extraPanelsOverride) : og.extraPanels;
  const O2min = Math.max(byBattery, byDailyLoad) + manualPanelAdj + extraPanels; // الحد الأدنى المطلوب من الطاقة
  const installedKWmin = (O2min * panelWatt) / 1000;

  /* ---- 5-ب) تصميم السلسلة (Series String) حسب حدود الانفرتر الفعلية للـ PV -----
     مهم: مبنستخدمش أقصى عدد ألواح مسموح بيه في السلسلة دايمًا (ده كان بيسبب
     إنتاج زيادة عن الحاجة أحيانًا بسبب التقريب لأعلى مضاعف كامل) - بندوّر
     بدل من كده على أفضل تركيبة (عدد ألواح/سلسلة × عدد سلاسل) تحقق الحد
     الأدنى المطلوب (O2min) بأقل عدد ألواح زيادة ممكن، وتفضّل كمان التوافق
     مع نطاق MPPT لو ممكن */
  let panelsPerString = null, stringCount = null, stringVimp = null, pvLimitVerified = false;
  if (inv.pvVocMax && panel.voc) {
    const maxPanelsPerString = Math.max(Math.floor(inv.pvVocMax / panel.voc), 1);
    // حد أدنى عملي: فولت السلسلة لازم يكون أعلى من جهد البطارية/الباص الداخلي
    // بهامش معقول، وإلا شاحن الـMPPT مش هيقدر يشحن خالص (مش مجرد كفاءة أقل).
    // لو الموديل مسجّل نطاق MPPT حقيقي بنستخدمه، غير كده بنفترض هامش 20%
    // فوق جهد الانفرتر كحد أدنى تقريبي (مش رقم موثّق، مجرد احتياط هندسي)
    const impliedMpptMin = inv.pvMpptMin || (inverterVoltage * 1.2);
    const minPanelsPerString = Math.max(1, Math.ceil(impliedMpptMin / panel.vimp));
    let best = null;
    for (let pps = minPanelsPerString; pps <= maxPanelsPerString; pps++) {
      const strings = Math.max(Math.ceil(O2min / pps), 1);
      const total = pps * strings;
      const vimpTotal = pps * panel.vimp;
      const inMppt = !inv.pvMpptMax || vimpTotal <= inv.pvMpptMax;
      const candidate = { panelsPerString: pps, stringCount: strings, total, inMppt };
      if (!best
        || candidate.total < best.total
        || (candidate.total === best.total && candidate.inMppt && !best.inMppt)
        || (candidate.total === best.total && candidate.inMppt === best.inMppt && candidate.panelsPerString > best.panelsPerString)
      ) best = candidate;
    }
    if (!best) {
      // مفيش تركيبة ممكنة أصلًا (حتى أقصى عدد ألواح مسموح بيه من ناحية الأمان
      // لسه أقل من الحد الأدنى العملي للشحن) - الانفرتر/اللوح مش متوافقين
      errors.push(`مفيش تركيبة سلسلة ممكنة بالانفرتر ${inv.brand} ${inv.type} مع اللوح ده - حد الأمان (${inv.pvVocMax}V) بيسمح بعدد ألواح أقل من الحد الأدنى اللازم للشحن. جرّب لوح بـ Voc أقل أو انفرتر تاني.`);
      panelsPerString = maxPanelsPerString;
      stringCount = Math.max(Math.ceil(O2min / panelsPerString), 1);
      stringVimp = panelsPerString * panel.vimp;
    } else {
      panelsPerString = best.panelsPerString;
      stringCount = best.stringCount;
      stringVimp = panelsPerString * panel.vimp;
    }
    pvLimitVerified = true;
    if (inv.pvMpptMin && stringVimp < inv.pvMpptMin) {
      errors.push(`فولت التشغيل لسلسلة الألواح (${Math.round(stringVimp)}V) أقل من الحد الأدنى لنطاق MPPT لانفرتر ${inv.brand} ${inv.type} (${inv.pvMpptMin}V) - كفاءة الشحن هتقل.`);
    }
    if (inv.pvMpptMax && stringVimp > inv.pvMpptMax) {
      errors.push(`فولت التشغيل لسلسلة الألواح (${Math.round(stringVimp)}V) أعلى من الحد الأقصى لنطاق MPPT لانفرتر ${inv.brand} ${inv.type} (${inv.pvMpptMax}V) - قلل عدد الألواح بالسلسلة الواحدة أو جرّب موديل تاني.`);
    }
  } else {
    errors.push(`⚠ الانفرتر المختار (${inv.brand} ${inv.type}) مفيهوش بيانات Voc الأقصى للـ PV مسجلة - عدد الألواح محسوب من موازنة الطاقة بس، من غير التأكد إنه قابل للتوصيل الفعلي في سلاسل متوافقة مع مدخل الانفرتر.`);
  }
  const O2 = pvLimitVerified ? panelsPerString * stringCount : O2min; // العدد الفعلي القابل للتركيب
  const O3 = O2 * panelWatt * psh * systemEfficiency; // الإنتاجية اليومية الواقعية (بعد الفاقد) WH
  const installedKW = (O2 * panelWatt) / 1000;

  /* ---- 6) عرض السعر (تسعير كل بند: عميل مقابل تكلفة) ---- */
  const phaseQty = inputs.phase === 'three' ? 3 : 1;
  const steelQty = Math.ceil(O2 / 2);
  const cablesQty = steelQty * og.cableMetersPerSteelUnit;
  const installQty = (inputs.installQtyOverride !== undefined && inputs.installQtyOverride !== '')
    ? Number(inputs.installQtyOverride) : steelQty;

  const panelCustomerUnit = Number(panel.price) + og.panelMarkupPerWatt;
  const panelCostUnit = Number(panel.price);
  const invCustomerUnit = inv.listPrice;
  const invCostUnit = inv.listPrice * (1 - inv.discount);
  const steelCustomerUnit = og.steelCostPerUnit + og.steelMarginPerUnit;
  const steelCostUnit = og.steelCostPerUnit;
  const battCustomerUnit = batt.listPrice;
  const battCostUnit = batt.listPrice * (1 - batt.discount);

  const rows = [
    { n: 1, name: 'الالواح', type: `${panel.brand} ${panel.power}W`, qty: O2,
      customerUnit: panelCustomerUnit, costUnit: panelCostUnit,
      customerTotal: O2 * panelCustomerUnit * panelWatt, costTotal: O2 * panelCostUnit * panelWatt },
    { n: 2, name: 'انفرتر', type: `${inv.brand} ${inv.type}`, qty: phaseQty,
      customerUnit: invCustomerUnit, costUnit: invCostUnit,
      customerTotal: phaseQty * invCustomerUnit, costTotal: phaseQty * invCostUnit },
    { n: 3, name: 'شاسية', type: 'حديد مجلفن', qty: steelQty,
      customerUnit: steelCustomerUnit, costUnit: steelCostUnit,
      customerTotal: steelQty * steelCustomerUnit, costTotal: steelQty * steelCostUnit },
    { n: 4, name: 'كابلات', type: '6 مم', qty: cablesQty,
      customerUnit: og.cablesCustomerPerMeter, costUnit: og.cablesCostPerMeter,
      customerTotal: cablesQty * og.cablesCustomerPerMeter, costTotal: cablesQty * og.cablesCostPerMeter },
    { n: 5, name: 'بطاريات', type: `${batt.brand} ${batt.ah}AH-${batt.voltage}V`, qty: O6,
      customerUnit: battCustomerUnit, costUnit: battCostUnit,
      customerTotal: O6 * battCustomerUnit, costTotal: O6 * battCostUnit },
    { n: 6, name: 'اكسسوارات', type: 'لوحة تجميع / MC4 / FUSE / HOLDER / CB', qty: 1,
      customerUnit: og.accessoriesCustomerFixed, costUnit: og.accessoriesCostFixed,
      customerTotal: og.accessoriesCustomerFixed, costTotal: og.accessoriesCostFixed },
    { n: 7, name: 'النقل', type: '-', qty: 1,
      customerUnit: og.transportCustomerFixed, costUnit: og.transportCostFixed,
      customerTotal: og.transportCustomerFixed, costTotal: og.transportCostFixed },
    { n: 8, name: 'التركيب', type: '-', qty: installQty,
      customerUnit: og.installCustomerPerUnit, costUnit: og.installCostPerUnit,
      customerTotal: installQty * og.installCustomerPerUnit, costTotal: installQty * og.installCostPerUnit },
  ];

  const beforeDiscount = rows.reduce((s, r) => s + r.customerTotal, 0);
  const totalCost = rows.reduce((s, r) => s + r.costTotal, 0);
  const discount = Number(inputs.extraDiscountAmount) || 0;
  const finalPrice = beforeDiscount - discount;
  const profit = beforeDiscount - totalCost - discount;
  const pricePerKW = installedKW ? finalPrice / installedKW : 0;

  return {
    errors,
    panel, inv, batt,
    R2, R3, R4, R5, R6, R7, peakInstantaneousW, peakSurgeAddOn, worstSurgeLoad, surgeCapacityW,
    morningEnabled, nightEnabled,
    O2, O3, O6, O7, O8, O9, O10,
    installedKW, storedKWh: O9 / 1000, systemEfficiency,
    panelsPerString, stringCount, stringVimp, pvLimitVerified,
    designOkay, inverterSizeOkay: !invUndersized,
    steelQty, cablesQty, installQty, phaseQty,
    loadRows,
    offer: { rows },
    totals: { beforeDiscount, totalCost, discount, finalPrice, profit, pricePerKW },
    paymentTerms: [
      { label: 'مقدم عند التعاقد', pct: 0.7, amount: finalPrice * 0.7 },
      { label: 'عند التوريد', pct: 0.25, amount: finalPrice * 0.25 },
      { label: 'عند التشغيل', pct: 0.05, amount: finalPrice * 0.05 }
    ],
  };
}
