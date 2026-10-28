import { FIELDS, GROUPS, estimate, defaultProfile, loadProfile, saveProfile, clearProfile, checkValue, clampValues, crossChecks } from './measurements.js';
import { Viewer } from './viewer.js';
import { initGarmentPanel } from './garmentPanel.js';

const $ = (sel) => document.querySelector(sel);

let profile = loadProfile() || defaultProfile();
// 예전 버전에서 저장된 값에 새 항목이 없으면 추정값으로 채운다
{
  const est = estimate(profile.gender, Number(profile.values.height) || 165, Number(profile.values.weight) || 60);
  for (const f of FIELDS) if (!Number.isFinite(Number(profile.values[f.key]))) profile.values[f.key] = est[f.key];
}

const viewer = new Viewer($('#stage'), $('#labels'));

// ── 입력 폼 생성 ──
const form = $('#measure-form');
for (const g of GROUPS) {
  const fs = document.createElement('fieldset');
  fs.className = 'group';
  fs.innerHTML = `<legend>${g.title}</legend>`;
  for (const f of FIELDS.filter((x) => x.group === g.id)) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `
      <label for="f-${f.key}">${f.label}</label>
      <div class="input-wrap">
        <input id="f-${f.key}" name="${f.key}" type="number" inputmode="decimal" step="${f.step}" min="${f.min}" max="${f.max}">
        <span class="unit">${f.unit}</span>
      </div>
      <input id="r-${f.key}" class="slider" type="range" step="${f.step}" min="${f.min}" max="${f.max}" aria-label="${f.label} 조절" tabindex="-1">
      ${f.hint ? `<p class="hint">${f.hint}</p>` : ''}
      <p class="err" id="e-${f.key}" hidden></p>`;
    fs.appendChild(row);
  }
  form.appendChild(fs);
}

function writeForm() {
  for (const f of FIELDS) {
    $(`#f-${f.key}`).value = profile.values[f.key];
    $(`#r-${f.key}`).value = profile.values[f.key];
  }
  for (const b of document.querySelectorAll('[data-gender]')) b.setAttribute('aria-pressed', String(b.dataset.gender === profile.gender));
}

function validate() {
  let ok = true;
  for (const f of FIELDS) {
    const msg = checkValue(f, Number(profile.values[f.key]));
    const el = $(`#e-${f.key}`);
    el.textContent = msg || '';
    el.hidden = !msg;
    $(`#f-${f.key}`).toggleAttribute('aria-invalid', !!msg);
    if (msg) ok = false;
  }
  const notes = crossChecks(clampValues(profile.values));
  const box = $('#cross');
  box.innerHTML = notes.map((n) => `<li>${n}</li>`).join('');
  box.hidden = notes.length === 0;
  return ok;
}

function stats() {
  const v = clampValues(profile.values);
  const bmi = v.weight / (v.height / 100) ** 2;
  $('#stat-bmi').textContent = bmi.toFixed(1);
  $('#stat-whr').textContent = (v.waist / v.hip).toFixed(2);
  $('#stat-leg').textContent = `${Math.round((v.leg / v.height) * 100)}%`;
}

let frameReq = 0;
function rebuild() {
  cancelAnimationFrame(frameReq);
  frameReq = requestAnimationFrame(() => {
    viewer.setBody(clampValues(profile.values), profile.gender);
    garmentPanel.refresh();
    stats();
  });
}

function timeLabel(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `오늘 ${t}` : `${d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} ${t}`;
}

function renderSaveState(failed) {
  const el = $('#save-state');
  if (failed) {
    el.dataset.state = 'error';
    el.textContent = '이 브라우저에서는 저장할 수 없습니다. 사생활 보호 모드인지 확인해 주세요.';
  } else if (profile.isSample) {
    el.dataset.state = 'sample';
    el.textContent = '지금은 예시 치수입니다. 값을 바꾸면 이 기기에 자동 저장됩니다.';
  } else {
    el.dataset.state = 'saved';
    el.textContent = `이 기기에 저장됨 · ${timeLabel(profile.savedAt)}`;
  }
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!validate()) return;
    const at = saveProfile(profile);
    if (at) { profile.savedAt = at; profile.isSample = false; }
    renderSaveState(!at);
  }, 350);
}

function onValue(key, raw, from) {
  const v = parseFloat(raw);
  profile.values[key] = Number.isFinite(v) ? v : raw;
  if (from !== 'input') $(`#f-${key}`).value = raw;
  if (from !== 'range' && Number.isFinite(v)) $(`#r-${key}`).value = v;
  validate();
  rebuild();
  persist();
}

form.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id.startsWith('f-')) onValue(t.name, t.value, 'input');
  else if (t.id.startsWith('r-')) onValue(t.id.slice(2), t.value, 'range');
});
form.addEventListener('submit', (e) => e.preventDefault());

for (const b of document.querySelectorAll('[data-gender]')) {
  b.addEventListener('click', () => {
    if (profile.gender === b.dataset.gender) return;
    profile.gender = b.dataset.gender;
    writeForm();
    rebuild();
    persist();
  });
}

$('#btn-estimate').addEventListener('click', () => {
  const h = Number(profile.values.height), w = Number(profile.values.weight);
  if (!Number.isFinite(h) || !Number.isFinite(w)) return;
  profile.values = estimate(profile.gender, h, w);
  writeForm();
  validate();
  rebuild();
  persist();
  flash('키·몸무게 기준 평균 체형으로 나머지 치수를 채웠습니다.');
});

// 초기화는 2단계 확인 (confirm() 대화상자를 쓰지 않음)
const resetBtn = $('#btn-reset');
let resetArmed = 0;
resetBtn.addEventListener('click', () => {
  if (!resetArmed) {
    resetBtn.textContent = '한 번 더 누르면 삭제';
    resetBtn.classList.add('armed');
    resetArmed = setTimeout(() => { resetArmed = 0; resetBtn.textContent = '저장된 치수 삭제'; resetBtn.classList.remove('armed'); }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  resetBtn.textContent = '저장된 치수 삭제';
  resetBtn.classList.remove('armed');
  clearProfile();
  profile = defaultProfile();
  writeForm();
  validate();
  rebuild();
  renderSaveState();
  flash('저장된 치수를 지우고 예시 치수로 돌아갔습니다.');
});

let flashTimer = 0;
function flash(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => viewer.view(Number(b.dataset.view)));
$('#btn-guides').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  viewer.setGuides(on);
});

// 좁은 화면에서는 라벨이 겹치므로 치수선을 꺼 둔 채로 시작
if (window.matchMedia('(max-width: 520px)').matches) {
  $('#btn-guides').setAttribute('aria-pressed', 'false');
  viewer.setGuides(false);
}

writeForm();
validate();
renderSaveState();
viewer.setBody(clampValues(profile.values), profile.gender);
stats();

// ── 2단계: 옷 입히기 ──
const garmentPanel = initGarmentPanel(viewer);

function selectTab(id) {
  for (const t of document.querySelectorAll('[role="tab"]')) {
    const on = t.id === `tab-btn-${id}`;
    t.setAttribute('aria-selected', String(on));
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  try { localStorage.setItem('fitroom.tab', id); } catch { /* 무시 */ }
}
for (const t of document.querySelectorAll('[role="tab"]')) t.addEventListener('click', () => selectTab(t.id.replace('tab-btn-', '')));
{
  let saved = null;
  try { saved = localStorage.getItem('fitroom.tab'); } catch { /* 무시 */ }
  selectTab(saved === 'body' ? 'body' : 'garment');
}

function setPressed(btn, on) { btn.setAttribute('aria-pressed', String(on)); }
$('#btn-cloth').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  setPressed(e.currentTarget, on);
  if (viewer.garment) viewer.garment.visible = on;
  viewer.garmentHidden = !on;
});
$('#btn-fitmap').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  setPressed(e.currentTarget, on);
  viewer.setFitMap(on);
  $('#legend').hidden = !on;
  if (on && viewer.garmentHidden) $('#btn-cloth').click();
});
// 옷을 입힌 상태에서는 치수선이 옷에 가려 헷갈리므로 처음엔 끈다
setPressed($('#btn-guides'), false);
viewer.setGuides(false);

