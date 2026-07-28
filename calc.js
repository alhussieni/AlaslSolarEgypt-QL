/* =========================================================================
   محرك حسابات محطة الطاقة الشمسية
   منقول بالكامل من معادلات ملف الإكسل الأصلي (Main / Calc / Detail offer)
   كل دالة هنا تقابل خلية أو مجموعة خلايا في الشيت الأصلي - انظر التعليقات
   ========================================================================= */

function bucketPick(value, buckets, labelFn) {
  // يقابل سلسلة IF المتداخلة في الإكسل: أول حد أعلى من أو يساوي القيمة
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]) return labelFn ? labelFn(buckets[i], i) : buckets[i];
  }
  return labelFn ? labelFn(buckets[buckets.length - 1], buckets.length - 1) : buckets[buckets.length - 1];
}

function findPanel(data, brand, power) {
  return data.panels.find(p => p.brand === brand && Number(p.power) === Number(power));
}

function sameBrand(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function findInverterModel(data, brand, hp, kw) {
  return data.inverter.models.find(m => sameBrand(m.brand, brand) && Number(m.hp) === Number(hp) && Number(m.kw) === Number(kw));
}

function getInverterDiscount(data, brand) {
  // مطابقة بدون حساسية لحالة الأحرف (Capital/Small) - أي فرق كتابة في
  // نفس الماركة (زي Delixi / delixi) متسببش فقدان الخصم أو الموديل
  if (data.inverter.discounts[brand] !== undefined) return data.inverter.discounts[brand];
  const key = Object.keys(data.inverter.discounts).find(k => sameBrand(k, brand));
  return key ? data.inverter.discounts[key] : 0;
}

function findCombinerRow(data, arrayCount) {
  // EVEN(H6+2) في الإكسل: أقرب عدد زوجي أكبر من أو يساوي H6+2
  let target = Math.ceil(arrayCount + 2);
  if (target % 2 !== 0) target += 1;
  let row = data.combinerBox.table.find(r => r.arrays === target);
  if (!row) {
    // خذ أقرب صف أكبر متاح
    row = data.combinerBox.table.filter(r => r.arrays >= target).sort((a, b) => a.arrays - b.arrays)[0];
  }
  if (!row) row = data.combinerBox.table[data.combinerBox.table.length - 1];
  return row;
}

function findMcb(data, amp) {
  const sorted = [...data.mcb].sort((a, b) => a.amp - b.amp);
  for (const row of sorted) if (amp <= row.amp) return row;
  return sorted[sorted.length - 1];
}

function findReactorPrice(data, amp) {
  const bucket = bucketPick(amp, data.reactor.ampBuckets);
  const row = data.reactor.table.find(r => r.amp === bucket);
  return row ? row.price : 0;
}

/**
 * الدالة الرئيسية - تاخد المدخلات وترجع كل نتائج الحسبة
 * inputs: {
 *   requestedW, panelBrand, panelPower, structureType, steelBrand,
 *   inverterBrand, solarEnabled, structureEnabled, inverterEnabled,
 *   cablesEnabled, combinerBoxQty, earthingEnabled, reactorEnabled,
 *   supplyInstallEnabled, decreasePanelsPerString, decreaseStrings,
 *   increaseInverterHP, extraDiscountPercent
 * }
 */
function computeOffer(data, inputs) {
  const errors = [];
  const panel = findPanel(data, inputs.panelBrand, inputs.panelPower);
  if (!panel) {
    errors.push('لم يتم العثور على بيانات اللوح الشمسي المختار.');
    return { errors };
  }
  if (!panel.vimp || !panel.price) {
    errors.push('اللوح المختار غير مكتمل البيانات (الفولت أو السعر) - يرجى اختيار لوح آخر أو استكماله من لوحة الأدمن.');
  }

  const C4 = Number(inputs.requestedW) || 0; // Main!C4 Requested W

  // ---- Main!H13,H14 : inverter sizing (لازم قبل تحديد H5 عشان نعرف حدود
  //      الفولت الخاصة بالموديل بالظبط، لو متسجلة) ----
  const H13 = Math.round(C4 / 1000) + (Number(inputs.increaseInverterHP) || 0);
  const hpBucket = bucketPick(H13, data.inverter.hpBuckets);
  const hpIdx = data.inverter.hpBuckets.indexOf(hpBucket);
  const kwBucket = data.inverter.kwBuckets[hpIdx];
  const H14 = { hp: hpBucket, kw: kwBucket, text: `${hpBucket} HP - ${kwBucket} KW` };
  const invModel = findInverterModel(data, inputs.inverterBrand, H14.hp, H14.kw);

  // ---- Main!H5 : panels per string ----
  // لو الموديل المختار له بيانات فعلية من الداتا شيت (Voc الأقصى)، بنستخدمها
  // بالظبط (وده الصح هندسيًا: الحد الأقصى بيتحسب على Voc مش Vimp، لأن Voc
  // بيرتفع في الجو البارد وقت الصباح لما الألواح من غير حمل). لو الموديل
  // لسه من غير بيانات مسجلة، بنرجع للحد العام الافتراضي (Vimp) زي الأول.
  let stringVoltageLimit = data.voltageLimitCap;
  let stringLimitBasis = 'vimp'; // للتوضيح في نتيجة الحساب
  let panelDivisor = panel.vimp;
  if (invModel && invModel.vocMax) {
    stringVoltageLimit = invModel.vocMax;
    stringLimitBasis = 'voc';
    panelDivisor = panel.voc;
  }
  const H5raw = Math.floor(stringVoltageLimit / panelDivisor) - (Number(inputs.decreasePanelsPerString) || 0);
  const H5 = Math.max(H5raw, 1);

  // ---- Main!H6 : array count ----
  const H6raw = Math.round(C4 / (H5 * panel.power)) - (Number(inputs.decreaseStrings) || 0);
  const H6 = Math.max(H6raw, 1);

  // ---- Main!H7 : total panels ----
  const H7 = inputs.solarEnabled ? H5 * H6 : 0;

  // ---- Main!C5 : designed W ----
  const C5 = panel.power * H5 * H6;
  const H8 = C5 / 1000; // Power KW

  // ---- Main!H9,H10,H11 : electrical totals ----
  const H9 = H6 * (panel.iimp || 0);   // total Iimp
  const H10 = H5 * (panel.vimp || 0);  // total Vimp (string voltage)
  const H11 = H5 * (panel.voc || 0);   // total Voc (أهم رقم للتأكد من الأمان)
  const H12 = H10 * data.expectedVACFactor; // expected V-AC

  // ---- تحذير نطاق الـ MPPT: لو الموديل مسجل له نطاق MPPT وفولت التشغيل
  //      الفعلي للسلسلة (H10) طلع بره النطاق ده، الانفرتر مش هيتابع أعلى
  //      نقطة قدرة بكفاءة (حتى لو الفولت آمن من ناحية الأمان) ----
  if (invModel && invModel.mpptMin && H10 < invModel.mpptMin) {
    errors.push(`فولت التشغيل للسلسلة (${Math.round(H10)}V) أقل من الحد الأدنى لنطاق MPPT للانفرتر (${invModel.mpptMin}V) - كفاءة التتبع هتقل، فكّر تزود عدد الألواح بالسلسلة.`);
  }
  if (invModel && invModel.mpptMax && H10 > invModel.mpptMax) {
    errors.push(`فولت التشغيل للسلسلة (${Math.round(H10)}V) أعلى من الحد الأقصى لنطاق MPPT للانفرتر (${invModel.mpptMax}V) - قلل عدد الألواح بالسلسلة.`);
  }
  if (!invModel || !invModel.vocMax) {
    errors.push(`⚠ الموديل المختار مفيهوش بيانات Voc الأقصى مسجلة - اتحسب حد الفولت بمعادلة افتراضية عامة (${Math.round(stringVoltageLimit)}V÷Vimp)، مش من مواصفات الموديل الفعلية. سجّل بيانات الموديل من لوحة الأدمن للحصول على نتيجة أدق وأأمن.`);
  }

  // ---- Main!H15 : reactor rating ----
  const H15 = bucketPick(H9, data.reactor.ampBuckets);

  // ---- Main!H16,H17,H18 : Isc / breaker ----
  const H16 = H6 * (panel.isc || 0);
  const H17 = H16 * 1.25;
  const cbBucket = bucketPick(H17, data.cb.ampBuckets);

  // ============================ Calc sheet ============================
  const Calc = {};
  // 1) الواح الطاقة الشمسية
  Calc.panelPricePerW = panel.price || 0;
  Calc.panelCost = Calc.panelPricePerW * C5; // Calc!G4

  // 2) الشاسية / الحديد
  const steelBrand = (inputs.steelBrand || data.steel.defaultBrand);
  const steelTable = data.steel.rotational[steelBrand] || data.steel.rotational[data.steel.defaultBrand];
  let steelUnitPrice = 0, steelQty = 0;
  if (inputs.structureEnabled) {
    if (inputs.structureType === 'FIXED') {
      steelQty = H8;
      steelUnitPrice = data.steel.fixedPricePerKW;
    } else {
      steelQty = H6;
      steelUnitPrice = H5 <= 15 ? steelTable.le15Panels : steelTable.gt15Panels;
    }
  }
  Calc.steelCost = steelUnitPrice * steelQty; // Calc!G6

  // 3) الانفرتر
  const invDiscount = getInverterDiscount(data, inputs.inverterBrand);
  let invListPrice = 0, invCostPrice = 0;
  if (invModel) {
    invListPrice = invModel.listPrice;
    invCostPrice = invListPrice * (1 - invDiscount);
  } else {
    errors.push('لا يوجد موديل إنفرتر مطابق لهذه القدرة من الماركة المختارة - جرب ماركة أخرى.');
  }
  const invEnabledQty = inputs.inverterEnabled ? 1 : 0;
  Calc.inverterCostPrice = invCostPrice * invEnabledQty; // Calc!G7
  Calc.inverterListPrice = invListPrice * invEnabledQty; // Calc!I8

  // 4) استيل بانل (تركيب اللوح على الحديد) - وحدات = ROUNDUP(C5/1000,0) بالكيلوواط (Calc!E16)
  const installationUnitsKW = Math.ceil(C5 / 1000);
  Calc.steelPanelExtra = installationUnitsKW * data.installation.steelPanelExtraPerUnit; // Calc!F9*E9

  // 5) الكابلات
  const cableMeters = data.cables.meterPerArray * H6;
  Calc.cablesCost = inputs.cablesEnabled ? cableMeters * data.cables.pricePerMeter : 0;

  // 6) MC4
  const mc4Qty = data.cables.mc4PerArray * H6;
  Calc.mc4Cost = inputs.cablesEnabled ? mc4Qty * data.cables.mc4Price : 0;

  // 7) صندوق التجميع - يُحسب تلقائيًا: كل صندوق يستوعب stringsPerBox مصفوفة (Array)
  const combinerRow = findCombinerRow(data, H6);
  const combinerDiscounted = combinerRow.listPrice * (1 - data.combinerBox.discount);
  const stringsPerBox = data.combinerBox.stringsPerBox || 6;
  const combinerQty = inputs.combinerEnabled && inputs.solarEnabled && H6 > 0 ? Math.ceil(H6 / stringsPerBox) : 0;
  Calc.combinerCost = combinerDiscounted * combinerQty;
  Calc.combinerUnitPrice = combinerDiscounted;
  Calc.combinerQty = combinerQty;
  Calc.combinerRow = combinerRow;

  // 8) الخرطوم المرن
  const flexQty = Math.round(cableMeters / data.cables.flexTubeDivisor);
  Calc.flexTubeCost = inputs.cablesEnabled ? flexQty * data.cables.flexTubePrice : 0;

  // 9) التأريض
  const earthQty = Math.round(C5 / data.earthing.divisor);
  Calc.earthingCost = inputs.earthingEnabled ? earthQty * data.earthing.pricePerUnit : 0;

  // 10) الريأكتور
  const reactorUnitPrice = findReactorPrice(data, H15);
  Calc.reactorCost = inputs.reactorEnabled ? reactorUnitPrice * 1 : 0;
  Calc.reactorUnitPrice = reactorUnitPrice;

  // 11) التركيب
  Calc.installCost = installationUnitsKW * data.installation.installPricePerUnit;

  // 12) النقل
  const transportUnits = Math.ceil(C5 / data.installation.transportDivisor);
  Calc.transportCost = transportUnits * data.installation.transportPricePerUnit;

  Calc.totalMaterialCost = Math.round(
    (Calc.panelCost + Calc.steelCost + Calc.inverterCostPrice + Calc.steelPanelExtra +
     Calc.cablesCost + Calc.mc4Cost + Calc.combinerCost + Calc.flexTubeCost +
     Calc.earthingCost + Calc.reactorCost + Calc.installCost + Calc.transportCost) / 100
  ) * 100;
  Calc.costPerKW = H8 ? Calc.totalMaterialCost / H8 : 0;

  // ============================ Detail offer sheet ============================
  const offer = { rows: [] };

  // صف 1: الألواح الشمسية
  const panelsRowPrice = inputs.solarEnabled ? (Calc.panelCost + C5 * data.panelMarkupPerWatt) : 0;
  offer.rows.push({
    n: 1, name: 'الواح الطاقة الشمسية', type: `${panel.brand} ${panel.power}W`,
    qty: inputs.solarEnabled ? `${H7} لوح (${H6} × ${H5})` : 'لا يوجد',
    origin: 'الصين', warranty: '30 سنة ضد انخفاض الإنتاجية عن 87.40% / 12 سنة ضد عيوب الصناعة',
    price: panelsRowPrice
  });

  // صف 2: الشاسية
  const structPrice = inputs.structureEnabled ? Calc.steelCost : 0;
  offer.rows.push({
    n: 2, name: 'الشاسية', type: inputs.structureType === 'FIXED' ? 'ثابت مجلفن تثبيت مسامير' : 'متحرك صينية - كمر سيجال - دهان ايبوكسي',
    qty: inputs.structureEnabled ? (inputs.structureType === 'FIXED' ? `${H8.toFixed(1)} KW` : `${H6} صينية`) : 'لا يوجد',
    origin: 'مصر', warranty: 'خمس سنوات',
    price: structPrice
  });

  // صف 3: الانفرتر
  const invCustomerPrice = inputs.inverterEnabled ? Calc.inverterListPrice : 0;
  const invCostBasis = Calc.inverterCostPrice;
  const invCommission = (invCustomerPrice - invCostBasis) * 0.1;
  offer.rows.push({
    n: 3, name: 'الانفرتر', type: `${inputs.inverterBrand} ${H14.text}`,
    qty: inputs.inverterEnabled ? '1' : 'لا يوجد',
    origin: 'الصين', warranty: 'سنتان',
    price: invCustomerPrice
  });

  // صف 4: الكابلات
  const cablesRowPrice = inputs.cablesEnabled ? Calc.cablesCost * data.cables.markup : 0;
  offer.rows.push({
    n: 4, name: 'الكابلات', type: 'HIS / LEADER / KBE',
    qty: inputs.cablesEnabled ? `يحدد في الموقع - بحد أقصى ${cableMeters} متر` : 'لا يوجد',
    origin: 'ألمانيا / الصين', warranty: 'سنة واحدة',
    price: cablesRowPrice
  });

  // صف 5: بئر أرضي / التأريض
  const wellRowPrice = Calc.earthingCost * data.earthing.markup;
  offer.rows.push({
    n: 5, name: 'التأريض / بئر أرضي', type: '-',
    qty: inputs.earthingEnabled ? 'يحدد في الموقع' : 'لا يوجد',
    origin: 'مصر', warranty: '----',
    price: wellRowPrice
  });

  // صف 6: الريأكتور
  const reactorRowPrice = Calc.reactorCost * data.reactorPricing.markup;
  offer.rows.push({
    n: 6, name: 'الريأكتور (VFD Reactor)', type: `${H15} A`,
    qty: inputs.reactorEnabled ? '1' : 'لا يوجد',
    origin: 'مصر', warranty: 'سنة واحدة',
    price: reactorRowPrice
  });

  // صف 7: التوريد والتركيب
  const kwRounded = Math.round(H8);
  const perKW = inputs.structureType === 'FIXED' ? data.installation.supplyInstallFixedPerKW : data.installation.supplyInstallRotationalPerKW;
  const perKWCommission = inputs.structureType === 'FIXED' ? data.installation.supplyInstallFixedCommissionPerKW : data.installation.supplyInstallRotationalCommissionPerKW;
  const supplyPrice = inputs.supplyInstallEnabled ? perKW * kwRounded : 0;
  const supplyCommission = inputs.supplyInstallEnabled ? perKWCommission * kwRounded : 0;
  offer.rows.push({
    n: 7, name: 'التوريد والنقل والتركيب وعمالة ولوحة الحماية IP65 والاكسسوارات والمواسير',
    type: '-', qty: inputs.supplyInstallEnabled ? `${kwRounded} KW` : 'لا يوجد',
    origin: 'مصر / الصين', warranty: '----',
    price: supplyPrice
  });

  const totalBeforeDiscount = offer.rows.reduce((s, r) => s + r.price, 0); // Detail offer!G14
  // ملاحظة: هذا الخصم يقابل SUM(K5:K13) في الإكسل الأصلي (K8+K10+K12)
  const K10 = (wellRowPrice - Calc.earthingCost) * 0.5;
  const structuralDiscount = invCommission + (Calc.earthingCost ? K10 : 0) + supplyCommission;

  const extraDiscountPct = (Number(inputs.extraDiscountPercent) || 0) / 100;
  const extraDiscountAmount = totalBeforeDiscount * extraDiscountPct;

  const totalDiscount = structuralDiscount + extraDiscountAmount;
  const finalPrice = totalBeforeDiscount - totalDiscount;
  const pricePerKW = H8 ? finalPrice / H8 : 0;

  return {
    errors,
    panel, H5, H6, H7, C5, H8, H9, H10, H11, H12, H13, H14, H15, H16, H17, cbBucket,
    stringVoltageLimit, stringLimitBasis,
    invModel, invDiscount, combinerRow, combinerQty: Calc.combinerQty,
    Calc,
    offer,
    totals: {
      beforeDiscount: totalBeforeDiscount,
      discount: totalDiscount,
      finalPrice,
      pricePerKW
    },
    paymentTerms: [
      { label: 'مقدم عند التعاقد', pct: 0.7, amount: finalPrice * 0.7 },
      { label: 'عند التوريد', pct: 0.25, amount: finalPrice * 0.25 },
      { label: 'عند التشغيل', pct: 0.05, amount: finalPrice * 0.05 }
    ]
  };
}
