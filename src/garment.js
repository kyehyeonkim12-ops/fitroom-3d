// 옷 실측과 몸 단면을 비교해 핏을 판정하고, 3D 옷 메시를 만든다.
// 쇼핑몰 실측의 "단면"은 옷을 펼쳐 놓고 잰 가로 길이이므로 둘레 = 단면 × 2.
import * as THREE from 'three';
import { RING_N, perimeter, torsoAt } from './bodyModel.js';
import { classify, effective, STRETCH, STATUS, f, nearestLandmark, easeColor, summarize } from './fit.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MIN_GAP = 0.35; // 옷이 몸을 뚫고 들어가지 않게 두는 최소 간격(cm)

export const GARMENT_FIELDS = {
  top: [
    { key: 'length',   label: '총장',     min: 30, max: 130, hint: '옆목점(어깨 솔기 시작)에서 밑단까지' },
    { key: 'shoulder', label: '어깨너비', min: 25, max: 75,  hint: '양쪽 어깨 솔기 사이' },
    { key: 'chest',    label: '가슴단면', min: 30, max: 90,  hint: '겨드랑이 아래 가로 길이' },
    { key: 'waist',    label: '허리단면', min: 25, max: 90,  hint: '없으면 비워 두세요', optional: true },
    { key: 'hem',      label: '밑단단면', min: 25, max: 95,  hint: '없으면 비워 두세요', optional: true },
    { key: 'sleeve',   label: '소매길이', min: 0,  max: 90,  hint: '어깨 솔기부터 소매 끝까지. 민소매는 0' },
    { key: 'bicep',    label: '소매통',   min: 8,  max: 40,  hint: '겨드랑이 아래 소매 단면. 없으면 비워 두세요', optional: true },
  ],
  bottom: [
    { key: 'length', label: '총장',       min: 20, max: 130, hint: '허리 밴드 위부터 밑단까지 바깥쪽 길이' },
    { key: 'waist',  label: '허리단면',   min: 25, max: 70,  hint: '허리 밴드 가로 길이' },
    { key: 'hip',    label: '엉덩이단면', min: 35, max: 85,  hint: '엉덩이 가장 넓은 곳 가로 길이' },
    { key: 'thigh',  label: '허벅지단면', min: 18, max: 55,  hint: '가랑이 바로 아래 가로 길이' },
    { key: 'rise',   label: '밑위',       min: 15, max: 45,  hint: '허리 밴드 위부터 가랑이 솔기까지 (앞 밑위)' },
    { key: 'hem',    label: '밑단단면',   min: 8,  max: 45,  hint: '바지 끝 가로 길이' },
  ],
};

// 예시 값: 오버핏 반팔 티셔츠, 와이드 슬랙스
export const SAMPLE_GARMENT = {
  top: { length: 70, shoulder: 52, chest: 58, waist: '', hem: 56, sleeve: 22, bicep: 21 },
  bottom: { length: 100, waist: 36, hip: 51, thigh: 32, rise: 30, hem: 24 },
};

export function checkGarment(category, values) {
  const errs = {};
  for (const fd of GARMENT_FIELDS[category]) {
    const raw = values[fd.key];
    if (raw === '' || raw == null) { if (!fd.optional) errs[fd.key] = '필수 항목입니다'; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) errs[fd.key] = '숫자를 입력해 주세요';
    else if (n < fd.min || n > fd.max) errs[fd.key] = `${fd.min}–${fd.max}cm 사이로 입력해 주세요`;
  }
  return errs;
}

// ── 몸 단면 샘플링 ──

// 오른쪽(+x) 다리의 높이 y 단면 (중심, 반지름)
function legAt(P, y) {
  const n = P.legs[0].nodes;
  if (y >= n[0].p.y) return { c: n[0].p.clone(), rx: n[0].rx, rz: n[0].rz };
  for (let i = 0; i < n.length - 1; i++) {
    const a = n[i], b = n[i + 1];
    if (y >= b.p.y) {
      const t = (a.p.y - y) / (a.p.y - b.p.y);
      return { c: a.p.clone().lerp(b.p, t), rx: lerp(a.rx, b.rx, t), rz: lerp(a.rz, b.rz, t) };
    }
  }
  const last = n[n.length - 1];
  return { c: last.p.clone(), rx: last.rx, rz: last.rz };
}

// 엉덩이 아래: 두 다리를 함께 감싸는 단면
function legsHullShape(P, y) {
  const l = legAt(P, y);
  const r = (l.rx + l.rz) / 2;
  const half = Math.abs(l.c.x) + r;
  const pts = [];
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * TAU, c = Math.cos(a), s = Math.sin(a);
    pts.push([half * Math.sign(c) * Math.pow(Math.abs(c), 0.75), r * 1.05 * Math.sign(s) * Math.pow(Math.abs(s), 0.75)]);
  }
  return { pts, zc: l.c.z };
}

function bodyShapeAt(P, y) {
  if (y >= P.yHip) return torsoAt(P.torsoRings, y);
  const hull = legsHullShape(P, y);
  if (y < P.torsoRings[1].y) return hull;
  const t = torsoAt(P.torsoRings, y);
  const dz = hull.zc - t.zc;
  const pts = t.pts.map((p, j) => {
    const q = [hull.pts[j][0], hull.pts[j][1] + dz];
    return Math.hypot(q[0], q[1]) > Math.hypot(p[0], p[1]) ? q : p;
  });
  return { pts, zc: t.zc };
}

const bodyGirth = (P, y) => perimeter(bodyShapeAt(P, y).pts);

// ── 단면 부풀리기 ──

function offsetPts(pts, gap) {
  const n = pts.length;
  return pts.map(([x, z], j) => {
    const [px, pz] = pts[(j - 1 + n) % n], [nx, nz] = pts[(j + 1) % n];
    const tx = nx - px, tz = nz - pz, len = Math.hypot(tx, tz) || 1;
    return [x + (tz / len) * gap, z - (tx / len) * gap];
  });
}

// 천은 오목한 곳(가슴 사이 등)에 붙지 않고 건너간다
function convexify(pts, iters = 14) {
  const n = pts.length;
  let cur = pts.map((p) => p.slice());
  for (let k = 0; k < iters; k++) {
    const next = cur.map((p) => p.slice());
    for (let j = 0; j < n; j++) {
      const a = cur[(j - 1 + n) % n], b = cur[(j + 1) % n];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.hypot(m[0], m[1]) > Math.hypot(cur[j][0], cur[j][1])) next[j] = m;
    }
    cur = next;
  }
  return cur;
}

function fitGirth(bodyPts, target) {
  let cur = convexify(offsetPts(bodyPts, MIN_GAP));
  for (let k = 0; k < 3; k++) {
    const p = perimeter(cur);
    if (target <= p + 0.05) break;
    cur = convexify(offsetPts(cur, (target - p) / TAU), 4);
  }
  return cur;
}

// 팔 안쪽 면의 x 좌표 (옷 몸판이 팔을 뚫지 않도록)
function armInnerX(P, y) {
  const n = P.arms[0].nodes;
  if (y > n[1].p.y || y < n[6].p.y) return Infinity;
  for (let i = 1; i < 6; i++) {
    const a = n[i], b = n[i + 1];
    if (y <= a.p.y && y >= b.p.y) {
      const t = (a.p.y - y) / (a.p.y - b.p.y || 1);
      return lerp(a.p.x, b.p.x, t) - lerp(a.rx, b.rx, t) - 0.4;
    }
  }
  return Infinity;
}

function limitX(pts, xLim) {
  const maxX = Math.max(...pts.map((p) => Math.abs(p[0])));
  if (maxX <= xLim) return pts;
  const P0 = perimeter(pts);
  const k = xLim * 0.7, span = xLim - k;
  const sq = pts.map(([x, z]) => {
    const ax = Math.abs(x);
    return ax <= k ? [x, z] : [Math.sign(x) * (k + span * Math.tanh((ax - k) / span)), z];
  });
  let lo = 1, hi = 3;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (perimeter(sq.map(([x, z]) => [x, z * mid])) < P0) lo = mid; else hi = mid;
  }
  return sq.map(([x, z]) => [x, z * lo]);
}

// ── 메시 ──

// rows: [{ pts: Vector3[RING_N], ease }] 순서대로 이어 붙인다. 이음선(j=0)은 옆선.
function buildSurface(rows, { tile = 20, capStart = false } = {}) {
  const N = RING_N, W = N + 1;
  const pos = [], uv = [], col = [], idx = [];
  const c = new THREE.Color();
  let v = 0, prev = null;
  for (const row of rows) {
    const center = new THREE.Vector3();
    for (const p of row.pts) center.add(p);
    center.divideScalar(N);
    if (prev) v += center.distanceTo(prev);
    prev = center;
    row.center = center;
    easeColor(row.ease, c);
    let u = 0;
    for (let j = 0; j <= N; j++) {
      const p = row.pts[j % N];
      if (j > 0) u += p.distanceTo(row.pts[j - 1]);
      pos.push(p.x, p.y, p.z);
      uv.push(u / tile, v / tile);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * W + j, b = (i + 1) * W + j, cc = i * W + j + 1, d = (i + 1) * W + j + 1;
      idx.push(a, b, cc, cc, b, d);
    }
  }
  if (capStart) {
    // 바닥 막음은 꼭짓점을 따로 둬서 옆면 음영에 섞이지 않게 한다
    const base = pos.length / 3, cen = rows[0].center;
    easeColor(rows[0].ease, c);
    for (let j = 0; j <= N; j++) {
      const p = rows[0].pts[j % N];
      pos.push(p.x, p.y, p.z);
      uv.push(0, 0);
      col.push(c.r, c.g, c.b);
    }
    const ci = base + N + 1;
    pos.push(cen.x, cen.y, cen.z);
    uv.push(0, 0);
    col.push(c.r, c.g, c.b);
    for (let j = 0; j < N; j++) idx.push(ci, base + j, base + j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 이음선 양쪽 법선을 평균해 옆선 음영 끊김을 없앤다
  const nrm = g.attributes.normal;
  for (let i = 0; i < rows.length; i++) {
    const a = i * W, b = i * W + N;
    const x = (nrm.getX(a) + nrm.getX(b)) / 2, y = (nrm.getY(a) + nrm.getY(b)) / 2, z = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    const l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l);
    nrm.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

function torsoRow(P, y, target, displayEase, avoidArms = true) {
  const shape = bodyShapeAt(P, y);
  const bg = perimeter(shape.pts);
  let pts = fitGirth(shape.pts, Math.max(target, bg + MIN_GAP * TAU));
  const xl = avoidArms ? armInnerX(P, y) : Infinity;
  if (Number.isFinite(xl)) {
    const bodyHalf = Math.max(...shape.pts.map((p) => Math.abs(p[0])));
    pts = limitX(pts, Math.max(xl, bodyHalf + 0.6));
  }
  return { pts: pts.map(([x, z]) => new THREE.Vector3(x, y, z + shape.zc)), ease: displayEase };
}

// 높이에 따라 직선 보간: levels [{y, c}]
function interpLevels(levels, y) {
  const L = [...levels].sort((a, b) => b.y - a.y);
  if (y >= L[0].y) return L[0].c;
  for (let i = 0; i < L.length - 1; i++) {
    if (y >= L[i + 1].y) return lerp(L[i].c, L[i + 1].c, (L[i].y - y) / (L[i].y - L[i + 1].y || 1));
  }
  return L[L.length - 1].c;
}

// 팔을 따라가는 위치 샘플 (s: 어깨끝점에서 손 쪽으로 cm)
function armSampler(arm) {
  const n = arm.nodes;
  const d = [0];
  for (let i = 1; i < n.length; i++) d.push(d[i - 1] + n[i].p.distanceTo(n[i - 1].p));
  const s0 = n[0].p.distanceTo(arm.start);
  return (s) => {
    const t = clamp(s + s0, 0, d[d.length - 1]);
    let i = 0;
    while (i < n.length - 2 && d[i + 1] < t) i++;
    const k = (t - d[i]) / (d[i + 1] - d[i] || 1);
    return { c: n[i].p.clone().lerp(n[i + 1].p, k), rx: lerp(n[i].rx, n[i + 1].rx, k), rz: lerp(n[i].rz, n[i + 1].rz, k) };
  };
}

function sleeveGeometry(arm, sStart, sEnd, targetAt, st, tile) {
  const at = armSampler(arm);
  const rows = [];
  const steps = Math.max(3, Math.ceil((sEnd - sStart) / 1.2));
  const ref = new THREE.Vector3(0, 0, 1), tan = new THREE.Vector3(), xA = new THREE.Vector3(), zA = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const s = lerp(sStart, sEnd, i / steps);
    const b = at(s);
    tan.subVectors(at(s + 0.6).c, at(s - 0.6).c).normalize();
    xA.crossVectors(tan, ref).normalize();
    zA.crossVectors(xA, tan).normalize();
    const avg = (b.rx + b.rz) / 2;
    const target = targetAt(s);
    const off = Math.max(target / TAU - avg, MIN_GAP);
    const ease = effective(target - TAU * avg, target, st);
    const pts = [];
    for (let j = 0; j < RING_N; j++) {
      const a = (j / RING_N) * TAU;
      const cx = Math.cos(a) * (b.rx + off), cz = Math.sin(a) * (b.rz + off);
      pts.push(new THREE.Vector3(
        b.c.x + xA.x * cx + zA.x * cz,
        b.c.y + xA.y * cx + zA.y * cz,
        b.c.z + xA.z * cx + zA.z * cz,
      ));
    }
    rows.push({ pts, ease });
  }
  return buildSurface(rows, { tile });
}

// ── 상의 ──

function buildTop(P, g, st, tile) {
  const v = P.values, H = P.H;
  const Gc = 2 * g.chest;
  const Gw = g.waist ? 2 * g.waist : null;
  const yTop = P.yShoulder + 0.016 * H;           // 옆목점 높이
  const yHem = Math.max(H * 0.15, yTop - g.length);
  const chestEase = Gc - v.chest;
  const waistC = Gw ?? Gc;                          // 허리단면이 없으면 일자로 떨어진다고 본다
  const hemC = g.hem ? 2 * g.hem : (yHem < P.yWaist ? waistC : interpLevels([{ y: P.yChest, c: Gc }, { y: P.yWaist, c: waistC }], yHem));
  const levels = [{ y: P.yChest, c: Gc }, { y: yHem, c: hemC }];
  if (yHem < P.yWaist - 1) levels.push({ y: P.yWaist, c: waistC });
  const shoulderDiff = g.shoulder - v.shoulder;
  const topEase = chestEase > 3 ? 3 : chestEase * 0.5;

  const rows = [];
  const ys = [];
  for (let y = yHem; y < yTop - 0.4; y += 1.5) ys.push(y);
  ys.push(yTop);
  for (const y of ys) {
    let target, disp;
    if (y >= P.yChest) {
      const t = (y - P.yChest) / (yTop - P.yChest);
      target = bodyGirth(P, y) + lerp(chestEase, topEase, Math.pow(t, 0.7));
      const chestEff = effective(chestEase, Gc, st);
      const sm = t * t * (3 - 2 * t);
      disp = lerp(chestEff, shoulderDiff * 3, sm);
    } else {
      target = interpLevels(levels, y);
      disp = effective(target - bodyGirth(P, y), target, st);
    }
    rows.push(torsoRow(P, y, target, disp));
  }

  const group = new THREE.Group();
  const meshes = [{ geo: buildSurface(rows, { tile }), name: 'body' }];

  // 소매
  const L = v.arm;
  const sleeveLen = Number(g.sleeve) || 0;
  const seamShift = shoulderDiff / 2;               // 어깨 솔기가 어깨끝점에서 벗어난 거리
  const sEnd = clamp(seamShift + sleeveLen, 0, L + 16);
  const Gb = g.bicep ? 2 * g.bicep : v.upperArm + clamp(chestEase * 0.3, 3, 14);
  const wristC = TAU * P.uaR * 0.51;
  const longSleeve = sEnd > L * 0.8;
  const cuffC = longSleeve ? Math.max(wristC + 8, Gb * 0.55) : Gb * 0.92;
  const sB = Math.min(L * 0.15, sEnd);
  const sleeveTarget = (s) => (s <= sB ? lerp(Gb * 1.08, Gb, clamp(s / (sB || 1), 0, 1)) : lerp(Gb, cuffC, (s - sB) / (sEnd - sB || 1)));
  if (sleeveLen > 0 && sEnd > 2) {
    for (const arm of P.arms) meshes.push({ geo: sleeveGeometry(arm, -P.uaR * 0.3, sEnd, sleeveTarget, st, tile), name: 'sleeve' });
  }
  for (const m of meshes) group.add(Object.assign(new THREE.Mesh(m.geo), { name: m.name }));

  // ── 판정 ──
  const out = [];
  {
    const d = shoulderDiff;
    const status = classify('shoulder', d);
    let detail;
    if (d > 6) detail = `어깨선이 양쪽 ${f(d / 2)}cm씩 팔 쪽으로 내려오는 드롭숄더 핏이에요.`;
    else if (d > 2.5) detail = `어깨선이 양쪽 ${f(d / 2)}cm씩 어깨끝 바깥에 걸려요.`;
    else if (d < -2) detail = '어깨선이 안쪽으로 들어와 팔을 들 때 당길 수 있어요.';
    else detail = '어깨선이 어깨끝점 근처에 맞아요.';
    out.push({ part: '어깨', status, value: d, short: d >= 0.5 ? `어깨 여유 ${f(d)}cm` : d <= -0.5 ? `어깨 ${f(d)}cm 좁음` : '어깨 딱 맞음', detail: `옷 ${f(g.shoulder)} − 내 몸 ${f(v.shoulder)} = ${sign(d)}cm. ${detail}` });
  }
  out.push(girthRow('가슴', 'chest', Gc, v.chest, st));
  if (Gw && yHem < P.yWaist) out.push(girthRow('허리', 'topWaist', Gw, v.waist, st));
  if (yHem < P.yHip + 3) out.push(girthRow('밑단', 'topHem', hemC, bodyGirth(P, yHem), st, '밑단 높이의 몸 둘레'));
  if (g.bicep && sleeveLen > 0) out.push(girthRow('소매통', 'bicep', Gb, v.upperArm, st));
  if (sleeveLen > 0) {
    const d = sEnd - L;
    let status = 'regular', label = '위치';
    if (longSleeve && d < -2) { status = 'snug'; label = '짧음'; }
    if (longSleeve && d > 4) { status = 'loose'; label = '김'; }
    const where = longSleeve
      ? (Math.abs(d) < 1 ? '손목에 딱 맞음' : d > 0 ? `손목보다 ${f(d)}cm 길어요` : `손목보다 ${f(d)}cm 짧아요`)
      : nearestLandmark(-sEnd, [{ name: '위팔 중간', y: -L * 0.3 }, { name: '팔꿈치', y: -L * 0.56 }, { name: '손목', y: -L }]);
    out.push({ part: '소매', status, label, always: true, value: d, short: `소매는 ${where}`, detail: `소매 ${f(sleeveLen)}cm${Math.abs(seamShift) >= 0.5 ? `, 어깨 솔기가 ${f(seamShift)}cm ${seamShift > 0 ? '바깥' : '안쪽'}에서 시작` : ''}. 내 팔길이 ${f(L)}cm 기준이에요.` });
  } else {
    out.push({ part: '소매', status: 'regular', label: '없음', value: 0, short: '민소매', detail: '소매가 없는 옷이에요.' });
  }
  const where = nearestLandmark(yHem, [
    { name: '허리선', y: P.yWaist }, { name: '엉덩이선', y: P.yHip }, { name: '가랑이선', y: P.yCrotch },
    { name: '허벅지 중간', y: (P.yCrotch + P.yKnee) / 2 }, { name: '무릎', y: P.yKnee },
  ]);
  out.push({ part: '기장', status: 'regular', label: '위치', always: true, value: yHem, short: `기장은 ${where}`, detail: `총장 ${f(g.length)}cm, 옆목점에서 재면 밑단이 바닥에서 ${f(yHem)}cm 높이에 와요.` });

  return { group, rows: out };
}

// ── 하의 ──

function buildBottom(P, g, st, tile) {
  const v = P.values, H = P.H;
  const Gw = 2 * g.waist, Gh = 2 * g.hip, Gt = 2 * g.thigh, Ghem = 2 * g.hem;
  const riseV = g.rise * 0.88; // 앞 밑위는 몸 곡면을 따라 재므로 수직 높이로는 조금 짧다

  // 허리 밴드는 몸 둘레가 밴드 둘레보다 작아지는 가장 높은 곳에 걸린다
  let yFit = null;
  for (let y = P.yWaist; y >= P.yHip; y -= 0.25) {
    if (bodyGirth(P, y) <= Gw * (1 + st)) { yFit = y; break; }
  }
  const noFit = yFit === null;
  if (noFit) yFit = P.yWaist;
  const riseCap = P.yCrotch + riseV;
  const limitedByRise = riseCap < yFit && riseCap < P.yWaist - 1.5;
  const yWb = Math.min(yFit, riseCap);
  const drop = P.yCrotch - (yWb - riseV);
  const hemY = yWb - g.length;
  const waistEase = Gw - bodyGirth(P, yWb);

  const Gknee = lerp(Gt, Ghem, 0.55);
  const legLevels = hemY < P.yKnee
    ? [{ y: P.yCrotch - 2, c: Gt }, { y: P.yKnee, c: Gknee }, { y: hemY, c: Ghem }]
    : [{ y: P.yCrotch - 2, c: Gt }, { y: hemY, c: Ghem }];
  const group = new THREE.Group();
  const levels = yWb > P.yHip ? [{ y: yWb, c: Gw }, { y: P.yHip, c: Gh }] : [{ y: yWb, c: Math.max(Gw, Gh) }];
  const upper = [];
  // 가랑이 아래는 두 다리 통을 감싸는 둘레로 이어 붙인다
  const legX = Math.abs(legAt(P, P.yCrotch).c.x);
  const crotchC = Math.max(Gt + 4 * legX, bodyGirth(P, P.yCrotch) + MIN_GAP * TAU);
  const upperLevels = [...levels, { y: P.yCrotch, c: crotchC }];
  const yBottom = P.yCrotch - 2.5;
  for (let y = yBottom; y < yWb - 0.3; y += 1.5) {
    if (y < P.yCrotch) {
      // 가랑이 바로 아래: 양쪽 바짓가랑이 원을 감싸는 모양으로 다리 통과 이어지게
      const l = legAt(P, y);
      const target = interpLevels(legLevels, y);
      upper.push({ pts: stadium(P, y, legLevels), ease: effective(target - TAU * (l.rx + l.rz) / 2, target, st) });
      continue;
    }
    const target = interpLevels(upperLevels, y);
    const row = torsoRow(P, y, target, effective(target - bodyGirth(P, y), target, st), false);
    const blendH = 8;
    if (y < P.yCrotch + blendH) {
      // 엉덩이 단면에서 다리 단면으로 서서히 바뀌게 (몸 안으로 파고들지는 않게)
      let t = 1 - (y - P.yCrotch) / blendH;
      t = t * t * (3 - 2 * t);
      const S = stadium(P, y, legLevels);
      const shape = bodyShapeAt(P, y);
      const minPts = convexify(offsetPts(shape.pts, MIN_GAP));
      row.pts = row.pts.map((p, j) => {
        const q = p.clone().lerp(S[j], t);
        const m = minPts[j];
        return Math.hypot(q.x, q.z - shape.zc) >= Math.hypot(m[0], m[1]) ? q : new THREE.Vector3(m[0], y, m[1] + shape.zc);
      });
    }
    upper.push(row);
  }
  upper.push(torsoRow(P, yWb, Gw, effective(waistEase, Gw, st), false));
  group.add(Object.assign(new THREE.Mesh(buildSurface(upper, { tile, capStart: true })), { name: 'pants-top' }));

  const yLegTop = P.yCrotch - 2;
  const yLegBottom = Math.max(0.6, hemY);
  for (const side of [1, -1]) {
    const rows = [];
    const steps = Math.max(4, Math.ceil((yLegTop - yLegBottom) / 1.5));
    for (let i = 0; i <= steps; i++) {
      const y = lerp(yLegBottom, yLegTop, i / steps);
      const l = legAt(P, y);
      const bodyR = Math.max(l.rx, l.rz);
      const target = interpLevels(legLevels, y);
      const r = Math.max(target / TAU, bodyR + MIN_GAP);
      const ease = effective(target - TAU * (l.rx + l.rz) / 2, target, st);
      const pts = [];
      for (let j = 0; j < RING_N; j++) {
        const a = (j / RING_N) * TAU;
        pts.push(new THREE.Vector3(side * l.c.x + Math.cos(a) * r, y, l.c.z + Math.sin(a) * r));
      }
      rows.push({ pts, ease });
    }
    group.add(Object.assign(new THREE.Mesh(buildSurface(rows, { tile })), { name: 'pants-leg' }));
  }

  // ── 판정 ──
  const out = [];
  {
    const eff = effective(waistEase, Gw, st);
    const status = noFit ? 'tight' : classify('pantsWaist', eff);
    const dy = yWb - P.yWaist;
    let where = Math.abs(dy) < 1.5 ? '허리선에 걸려요' : dy < 0 ? `허리선보다 ${f(dy)}cm 아래(골반 쪽)에 걸려요` : `허리선보다 ${f(dy)}cm 위까지 올라와요`;
    if (limitedByRise) where += '. 밑위가 짧아 더 올라가지 않아요';
    if (status === 'veryLoose') where += '. 벨트가 필요해요';
    out.push({ part: '허리', status, value: waistEase, short: `허리 ${STATUS[status].label}${status === 'tight' ? '' : ` (+${f(Math.max(0, waistEase))}cm)`}`, detail: `밴드 둘레 ${f(Gw)}cm, 걸리는 높이의 몸 둘레 ${f(bodyGirth(P, yWb))}cm. ${where}.` });
  }
  out.push(girthRow('엉덩이', 'hip', Gh, v.hip, st));
  out.push(girthRow('허벅지', 'thigh', Gt, v.thigh, st));
  {
    const status = limitedByRise ? 'snug' : classify('rise', drop);
    out.push({ part: '밑위', status, value: drop, short: limitedByRise ? '밑위 짧음' : drop < 1 ? '밑위 딱 맞음' : `밑위 여유 ${f(drop)}cm`, detail: limitedByRise ? `밑위 ${f(g.rise)}cm가 내 몸보다 짧아 허리 밴드가 아래로 내려가요.` : `가랑이 솔기가 몸에서 ${f(drop)}cm 아래로 떨어져요.` });
  }
  {
    const legHem = legAt(P, Math.max(hemY, 1));
    const bodyC = TAU * (legHem.rx + legHem.rz) / 2;
    const ratio = Ghem / Gt;
    const shape = ratio < 0.6 ? '아래로 좁아지는 테이퍼드' : ratio < 0.8 ? '일자' : '와이드';
    const row = girthRow('밑단', 'pantsHem', Ghem, bodyC, st, '밑단 높이의 다리 둘레');
    row.detail += ` ${shape} 핏이에요.`;
    out.push(row);
  }
  {
    let short, status = 'regular', label = '위치';
    if (hemY <= 0) { short = `기장은 바닥에 ${f(-hemY)}cm 끌림`; status = 'loose'; label = '김'; }
    else short = `기장은 ${nearestLandmark(hemY, [
      { name: '바닥', y: 0 }, { name: '복숭아뼈', y: P.yAnkle }, { name: '종아리 중간', y: lerp(P.yAnkle, P.yKnee, 0.5) },
      { name: '무릎', y: P.yKnee }, { name: '허벅지 중간', y: (P.yCrotch + P.yKnee) / 2 },
    ])}`;
    out.push({ part: '기장', status, label, always: true, value: hemY, short, detail: `총장 ${f(g.length)}cm, 밑단이 바닥에서 ${f(Math.max(0, hemY))}cm 높이에 와요.` });
  }
  return { group, rows: out };
}

// 두 바짓가랑이 원을 함께 감싸는 단면 (경기장 모양)
function stadium(P, y, legLevels) {
  const l = legAt(P, Math.min(y, P.yCrotch));
  const r = Math.max(interpLevels(legLevels, Math.min(y, P.yCrotch - 2)) / TAU, Math.max(l.rx, l.rz) + MIN_GAP);
  const cx = Math.abs(l.c.x);
  const pts = [];
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * TAU, c = Math.cos(a);
    pts.push(new THREE.Vector3((c >= 0 ? 1 : -1) * cx + c * r, y, l.c.z + Math.sin(a) * r));
  }
  return pts;
}

function sign(n) {
  return `${n >= 0 ? '+' : '−'}${f(n)}`;
}

function girthRow(part, kind, garmentC, bodyC, st, bodyLabel) {
  const ease = garmentC - bodyC;
  const eff = effective(ease, garmentC, st);
  const status = classify(kind, eff);
  let short = `${part} ${STATUS[status].label}`;
  if (status !== 'tight') short += ` (+${f(Math.max(0, ease))}cm)`;
  let detail = `옷 둘레 ${f(garmentC)} − ${bodyLabel || `내 ${part} 둘레`} ${f(bodyC)} = ${sign(ease)}cm.`;
  if (ease < 0 && st > 0) detail += eff >= 0 ? ' 늘어나는 소재라 입을 수는 있지만 몸에 붙어요.' : ' 소재가 늘어나도 모자라요.';
  return { part, status, value: ease, short, detail };
}

export function buildGarment(profile, garment) {
  const st = STRETCH[garment.stretch] ?? 0;
  const g = {};
  for (const fd of GARMENT_FIELDS[garment.category]) {
    const n = Number(garment.values[fd.key]);
    g[fd.key] = garment.values[fd.key] === '' || !Number.isFinite(n) ? null : clamp(n, fd.min, fd.max);
  }
  const tile = Math.max(2, Number(garment.tileCm) || 20);
  const res = garment.category === 'top' ? buildTop(profile, g, st, tile) : buildBottom(profile, g, st, tile);
  res.summary = summarize(res.rows);
  res.group.name = 'garment';
  return res;
}
