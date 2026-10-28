// "옷 입히기" 탭: 사진, 실측 입력, 판정 결과, 3D 옷 갱신.
import { GARMENT_FIELDS, SAMPLE_GARMENT, checkGarment, buildGarment } from './garment.js';
import { STATUS, LEGEND, f } from './fit.js';
import { fileToDataURL, loadImage, analyze, patternTexture, cropPreview, defaultTileCm, rgbHex } from './photo.js';

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'fitroom.garment.v1';
const DEFAULT_COLOR = { top: [61, 74, 99], bottom: [92, 86, 78] };

function defaultState() {
  return {
    category: 'top',
    values: { top: { ...SAMPLE_GARMENT.top }, bottom: { ...SAMPLE_GARMENT.bottom } },
    stretch: 'some',
    photo: { top: null, bottom: null }, // { src, color, bbox, crop, mode, tileCm }
    isSample: true,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const d = defaultState();
    return {
      category: s.category === 'bottom' ? 'bottom' : 'top',
      values: { top: { ...d.values.top, ...s.values?.top }, bottom: { ...d.values.bottom, ...s.values?.bottom } },
      stretch: ['none', 'some', 'high'].includes(s.stretch) ? s.stretch : 'some',
      photo: { top: s.photo?.top || null, bottom: s.photo?.bottom || null },
      isSample: false,
    };
  } catch {
    return null;
  }
}

function save(state) {
  try {
    const { isSample, ...rest } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify(rest));
    return true;
  } catch {
    // 사진 때문에 용량이 넘치면 사진 없이라도 저장
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, photo: { top: null, bottom: null } }));
      return 'nophoto';
    } catch {
      return false;
    }
  }
}

export function initGarmentPanel(viewer) {
  let state = load() || defaultState();
  let img = null;        // 현재 종류의 사진 Image
  let lastResult = null;

  // ── 범례 ──
  $('#legend-list').innerHTML = LEGEND.map((l) => `<li><i style="background:${l.color}"></i>${l.label}</li>`).join('');

  // ── 폼 ──
  const form = $('#garment-form');
  function renderForm() {
    const cat = state.category;
    const fs = document.createElement('fieldset');
    fs.className = 'group';
    fs.innerHTML = `<legend>${cat === 'top' ? '상의' : '하의'} 실측</legend>`;
    for (const fd of GARMENT_FIELDS[cat]) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `
        <label for="g-${fd.key}">${fd.label}${fd.optional ? ' <small class="opt">선택</small>' : ''}</label>
        <div class="input-wrap">
          <input id="g-${fd.key}" name="${fd.key}" type="number" inputmode="decimal" step="0.5" min="${fd.min}" max="${fd.max}">
          <span class="unit">cm</span>
        </div>
        <p class="hint">${fd.hint}</p>
        <p class="err" id="ge-${fd.key}" hidden></p>`;
      fs.appendChild(row);
    }
    form.replaceChildren(fs);
    for (const fd of GARMENT_FIELDS[cat]) $(`#g-${fd.key}`).value = state.values[cat][fd.key] ?? '';
    for (const b of document.querySelectorAll('[data-category]')) b.setAttribute('aria-pressed', String(b.dataset.category === cat));
    for (const b of document.querySelectorAll('[data-stretch]')) b.setAttribute('aria-pressed', String(b.dataset.stretch === state.stretch));
  }

  function validate() {
    const errs = checkGarment(state.category, state.values[state.category]);
    for (const fd of GARMENT_FIELDS[state.category]) {
      const el = $(`#ge-${fd.key}`);
      el.textContent = errs[fd.key] || '';
      el.hidden = !errs[fd.key];
      $(`#g-${fd.key}`).toggleAttribute('aria-invalid', !!errs[fd.key]);
    }
    return Object.keys(errs).length === 0;
  }

  // ── 사진 ──
  const canvas = $('#photo-canvas');
  let view = null;

  async function loadPhoto() {
    const p = state.photo[state.category];
    img = null;
    if (p) {
      try { img = await loadImage(p.src); } catch { state.photo[state.category] = null; }
    }
    renderPhoto();
    applyCloth();
  }

  function renderPhoto() {
    const p = state.photo[state.category];
    const has = !!(p && img);
    canvas.hidden = !has;
    $('#drop-empty').hidden = has;
    $('#photo-tools').hidden = !has;
    if (!has) return;
    const ratio = img.height / img.width;
    canvas.height = Math.round(Math.min(360, 320 * ratio));
    canvas.width = Math.round(canvas.height / ratio);
    view = cropPreview(canvas, img, p.crop, p.bbox);
    $('#swatch').style.background = rgbHex(p.color);
    $('#swatch-label').textContent = `대표색 ${rgbHex(p.color)}`;
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode));
    $('#pattern-fields').hidden = p.mode !== 'pattern';
    $('#pattern-hint').hidden = p.mode !== 'pattern';
    $('#crop-size').value = p.crop.size;
    $('#tile-cm').value = p.tileCm;
  }

  let currentTex = null;
  function applyCloth() {
    const p = state.photo[state.category];
    if (p && img && p.mode === 'pattern') {
      currentTex = patternTexture(img, p.crop, p.bbox);
      viewer.setCloth({ texture: currentTex });
    } else {
      currentTex = null;
      viewer.setCloth({ color: rgbHex(p ? p.color : DEFAULT_COLOR[state.category]) });
    }
  }

  async function takeFile(file) {
    if (!file || !file.type.startsWith('image/')) { setState('사진 파일(JPG, PNG 등)을 골라 주세요.', 'error'); return; }
    try {
      const src = await fileToDataURL(file);
      const im = await loadImage(src);
      const a = analyze(im, state.category);
      state.photo[state.category] = {
        src, color: a.color, bbox: a.bbox, crop: a.crop,
        mode: a.patterned ? 'pattern' : 'solid',
        tileCm: defaultTileCm(state.category, state.values[state.category], a.crop),
      };
      img = im;
      renderPhoto();
      applyCloth();
      changed();
    } catch (e) {
      setState(e.message, 'error');
    }
  }

  $('#photo-input').addEventListener('change', (e) => { takeFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });

  // 사진을 누르면 무늬 영역 이동 (파일 선택 창은 열지 않음)
  canvas.addEventListener('click', (e) => {
    const p = state.photo[state.category];
    if (!p || !view || p.mode !== 'pattern') return; // 단색일 때는 눌러서 사진 바꾸기
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const x = ((e.clientX - r.left) * sx - view.ox) / view.k / img.width;
    const y = ((e.clientY - r.top) * sx - view.oy) / view.k / img.height;
    p.crop.cx = Math.min(1, Math.max(0, x));
    p.crop.cy = Math.min(1, Math.max(0, y));
    renderPhoto();
    applyCloth();
    changed(false);
  });
  $('#crop-size').addEventListener('input', (e) => {
    const p = state.photo[state.category];
    if (!p) return;
    const before = p.crop.size;
    p.crop.size = Number(e.target.value);
    p.tileCm = Math.round(Math.max(2, (p.tileCm * p.crop.size) / before));
    renderPhoto();
    applyCloth();
    changed();
  });
  $('#tile-cm').addEventListener('input', (e) => {
    const p = state.photo[state.category];
    const n = Number(e.target.value);
    if (!p || !Number.isFinite(n) || n < 2) return;
    p.tileCm = Math.min(80, n);
    changed();
  });
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      const p = state.photo[state.category];
      if (!p) return;
      p.mode = b.dataset.mode;
      renderPhoto();
      applyCloth();
      changed(false);
    });
  }
  $('#btn-photo-remove').addEventListener('click', () => {
    state.photo[state.category] = null;
    img = null;
    renderPhoto();
    applyCloth();
    changed(false);
  });

  // ── 입력 이벤트 ──
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.name) return;
    state.values[state.category][t.name] = t.value === '' ? '' : Number(t.value);
    changed();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  for (const b of document.querySelectorAll('[data-category]')) {
    b.addEventListener('click', () => {
      if (state.category === b.dataset.category) return;
      state.category = b.dataset.category;
      renderForm();
      loadPhoto();
      changed();
    });
  }
  for (const b of document.querySelectorAll('[data-stretch]')) {
    b.addEventListener('click', () => {
      state.stretch = b.dataset.stretch;
      renderForm();
      changed();
    });
  }
  $('#btn-garment-sample').addEventListener('click', () => {
    state.values[state.category] = { ...SAMPLE_GARMENT[state.category] };
    renderForm();
    changed();
  });

  // ── 판정 결과 ──
  function renderResult(res) {
    if (!res) {
      $('#verdict-line').textContent = '필수 실측을 모두 넣으면 판정이 나와요.';
      $('#verdict-sub').textContent = '';
      $('#fit-rows').innerHTML = '';
      return;
    }
    $('#verdict-line').textContent = res.summary.line;
    $('#verdict-sub').textContent = res.summary.verdict;
    $('#fit-rows').innerHTML = res.rows.map((r) => {
      const label = r.label || STATUS[r.status].label;
      // 길이 항목은 숫자 대신 위치 설명을 보여 준다
      const right = r.label ? r.short.replace(/^(소매는|기장은) /, '') : `${r.value >= 0 ? '+' : '−'}${f(r.value)}cm`;
      return `<li${r.label ? ' class="pos"' : ''}>
        <span class="part">${r.part}</span>
        ${r.label === '위치' ? '<span></span>' : `<span class="chip" data-s="${r.status}">${label}</span>`}
        <span class="num">${right}</span>
        <p class="detail">${r.detail}</p>
      </li>`;
    }).join('');
  }

  function setState(msg, kind) {
    const el = $('#garment-state');
    el.dataset.state = kind;
    el.textContent = msg;
  }

  function renderSaved(result) {
    if (result === false) setState('이 브라우저에서는 저장할 수 없습니다.', 'error');
    else if (result === 'nophoto') setState('저장 공간이 부족해 사진은 빼고 저장했습니다.', 'error');
    else if (state.isSample) setState('지금은 예시 옷(오버핏 반팔 티셔츠 / 와이드 슬랙스)입니다. 값을 바꾸면 자동 저장됩니다.', 'sample');
    else setState('이 기기에 저장됨', 'saved');
  }

  let saveTimer = 0;
  function changed(rebuild = true) {
    if (rebuild) refresh();
    state.isSample = false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => renderSaved(save(state)), 400);
  }

  // 몸이나 옷이 바뀌면 다시 계산
  function refresh() {
    const profile = viewer.body?.profile;
    if (!profile) return;
    if (!validate()) {
      viewer.setGarment(null);
      lastResult = null;
      renderResult(null);
      return;
    }
    const p = state.photo[state.category];
    const res = buildGarment(profile, {
      category: state.category,
      values: state.values[state.category],
      stretch: state.stretch,
      tileCm: p && p.mode === 'pattern' ? p.tileCm : 20,
    });
    lastResult = res;
    viewer.setGarment(res.group);
    renderResult(res);
  }

  renderForm();
  renderSaved(true);
  loadPhoto().then(refresh);

  return { refresh, get result() { return lastResult; } };
}
