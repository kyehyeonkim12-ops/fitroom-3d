// 치수로부터 3D 인체(마네킹) 메시를 만든다.
// 단위: cm. 바닥 y=0, 정면 +z, 몸 중심 x=0.
// 몸통은 측정 단면 링, 팔다리는 굵기가 변하는 마디로 정의하고, sdfBody.js가 이를 이음새 없는 한 덩어리 표면으로 만든다.
// 2단계에서 옷을 같은 링 구조 위에 여유분만큼 부풀려 입히기 위해 단면 정보(`profile`)도 함께 반환한다.
import * as THREE from 'three';
import { Cone, Ellipsoid, Group, TorsoField, bodyField, meshField, splineTube } from './sdfBody.js';

const TAU = Math.PI * 2;
export const RING_N = 64;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// 단면 모양. a=0 이 +x(옆), a=π/2 가 +z(정면).
// w: 전체 너비, df/db: 중심에서 앞/뒤까지 거리, n: 2=타원, 클수록 각진 모양, bust: 앞쪽 가슴 볼륨
function ringShape({ w, df, db, n = 2, bust = 0 }) {
  const pts = [];
  const e = 2 / n;
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * TAU;
    const c = Math.cos(a), s = Math.sin(a);
    const x = (w / 2) * Math.sign(c) * Math.pow(Math.abs(c), e);
    let z = (s >= 0 ? df : db) * Math.sign(s) * Math.pow(Math.abs(s), e);
    if (bust > 0 && s > 0) {
      const g = Math.exp(-(((Math.abs(x) - w * 0.18) / (w * 0.19)) ** 2));
      z += bust * g * s;
    }
    pts.push([x, z]);
  }
  return pts;
}

export function perimeter(pts) {
  let p = 0;
  for (let j = 0; j < pts.length; j++) {
    const [x0, z0] = pts[j], [x1, z1] = pts[(j + 1) % pts.length];
    p += Math.hypot(x1 - x0, z1 - z0);
  }
  return p;
}

const scalePts = (pts, kx, kz = kx) => pts.map(([x, z]) => [x * kx, z * kz]);
const toCirc = (pts, circ) => scalePts(pts, circ / perimeter(pts));
const widthOf = (pts) => Math.max(...pts.map((p) => p[0])) * 2;

// 몸통 로프트와 같은 보간으로 높이 y의 단면을 구한다 (옷이 몸을 뚫지 않도록)
export function torsoAt(rings, y) {
  const R = rings.length;
  const g = (k) => rings[clamp(k, 0, R - 1)];
  if (y <= rings[0].y) return { y, zc: rings[0].z, pts: rings[0].pts };
  if (y >= rings[R - 1].y) return { y, zc: rings[R - 1].z, pts: rings[R - 1].pts };
  let i = 0;
  while (i < R - 2 && rings[i + 1].y < y) i++;
  const r0 = g(i - 1), r1 = g(i), r2 = g(i + 1), r3 = g(i + 2);
  let lo = 0, hi = 1;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (catmull(r0.y, r1.y, r2.y, r3.y, mid) < y) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  const pts = r1.pts.map((_, j) => [
    catmull(r0.pts[j][0], r1.pts[j][0], r2.pts[j][0], r3.pts[j][0], t),
    catmull(r0.pts[j][1], r1.pts[j][1], r2.pts[j][1], r3.pts[j][1], t),
  ]);
  return { y, zc: catmull(r0.z, r1.z, r2.z, r3.z, t), pts };
}

function ringPoints3D(pts, y, zc, grow = 1.012) {
  return pts.map(([x, z]) => new THREE.Vector3(x * grow, y, z * grow + zc));
}

function circlePoints3D(center, r) {
  const out = [];
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * TAU;
    out.push(new THREE.Vector3(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r));
  }
  return out;
}

export function buildBody(values, gender, material, { quality = 'final' } = {}) {
  const v = values;
  const H = v.height;
  const fem = gender === 'female';
  const s = H / 170; // 치수가 없는 작은 부위(손, 발, 머리)용 배율

  // ── 세로 기준점 ──
  const yShoulder = H * 0.818;           // 어깨끝점(견봉) 높이
  const yNeckBase = H * 0.838;
  const yChin = H * 0.868;
  const yCrotch = clamp(v.leg, H * 0.36, H * 0.56);
  const yAnkle = H * 0.045;
  const yKnee = clamp(yAnkle + v.calfLen, yAnkle + H * 0.15, yCrotch - H * 0.12);
  const span = yShoulder - yCrotch;
  const yHip = yCrotch + span * 0.11;
  const yWaist = yCrotch + span * 0.43;
  const yChest = yCrotch + span * 0.72;

  // ── 몸통 단면 ──
  const hipPts = toCirc(ringShape({ w: 1, df: 0.31, db: 0.4, n: 2.3 }), v.hip);
  const hipW = widthOf(hipPts);
  const lowHipPts = toCirc(ringShape({ w: 1, df: 0.3, db: 0.36, n: 2.4 }), v.hip * 0.93);
  const crotchPts = scalePts(ringShape({ w: 1, df: 0.3, db: 0.33, n: 2.6 }), hipW * 0.82, hipW * 0.82);
  const bottomPts = scalePts(ringShape({ w: 1, df: 0.3, db: 0.3, n: 2 }), hipW * 0.3, hipW * 0.3);
  const abdomenPts = toCirc(ringShape({ w: 1, df: 0.36, db: 0.36, n: 2.1 }), lerp(v.hip, v.waist, fem ? 0.55 : 0.4));
  const waistPts = toCirc(ringShape({ w: 1, df: 0.36, db: 0.34, n: 2.1 }), v.waist);
  const underbust = fem ? Math.max(v.waist * 1.02, v.chest * 0.85) : lerp(v.waist, v.chest, 0.75);
  const bust = fem ? clamp((v.chest - underbust) / 45, 0.02, 0.17) : 0.03;
  const underPts = toCirc(ringShape({ w: 1, df: 0.34, db: 0.34, n: 2.2, bust: bust * 0.3 }), underbust);
  const chestPts = toCirc(ringShape({ w: 1, df: 0.3, db: 0.34, n: 2.3, bust }), v.chest);
  const chestW = widthOf(chestPts);
  const chestD = Math.max(...chestPts.map((p) => p[1])) - Math.min(...chestPts.map((p) => p[1]));
  const armpitPts = toCirc(ringShape({ w: 1, df: 0.3, db: 0.33, n: 2.6, bust: bust * 0.5 }), v.chest * 0.97);
  // 어깨 단면은 너비를 직접 맞춘다 (팔 연결부가 나머지를 채움)
  const shW = v.shoulder;
  const shoulderPts = ringShape({ w: shW * 0.8, df: chestD * 0.36, db: chestD * 0.4, n: 2.6 });
  const neckR = v.neck / TAU;
  const trapPts = ringShape({ w: Math.max(shW * 0.55, neckR * 3), df: neckR * 1.25, db: neckR * 1.45, n: 2.6 });
  const neckBasePts = toCirc(ringShape({ w: 1, df: 0.42, db: 0.42, n: 2 }), v.neck * 1.12);

  const torsoRings = [
    { y: yCrotch + H * 0.004, z: -1.0 * s, pts: bottomPts },
    // 가랑이~엉덩이 간격이 좁은 체형에서도 단면끼리 겹치지 않게 비율로 둔다
    { y: yCrotch + Math.min(H * 0.02, (yHip - yCrotch) * 0.3), z: -0.8 * s, pts: crotchPts },
    { y: lerp(yCrotch, yHip, 0.62), z: -0.6 * s, pts: lowHipPts },
    { y: yHip, z: -0.5 * s, pts: hipPts },
    { y: lerp(yHip, yWaist, 0.5), z: 0, pts: abdomenPts },
    { y: yWaist, z: 0, pts: waistPts },
    { y: lerp(yWaist, yChest, 0.6), z: 0.2 * s, pts: underPts },
    { y: yChest, z: 0.4 * s, pts: chestPts },
    { y: lerp(yChest, yShoulder, 0.55), z: 0.1 * s, pts: armpitPts },
    { y: yShoulder - H * 0.006, z: -0.6 * s, pts: shoulderPts },
    { y: yShoulder + H * 0.012, z: -0.9 * s, pts: trapPts },
    { y: yNeckBase, z: -0.6 * s, pts: neckBasePts },
  ];

  const headH = H - yChin;

  // ── 다리 ──
  const thighR = v.thigh / TAU;
  const calfR = v.calf / TAU;
  const kneeR = Math.max(thighR * 0.62, calfR * 0.95);
  const ankleR = calfR * 0.56;
  const legX = Math.max(thighR * 0.92, hipW / 2 - thighR * 0.98);
  const ankleX = Math.max(ankleR * 1.4, legX * 0.6);
  const yCalfMax = yKnee - (yKnee - yAnkle) * 0.3;
  const legs = [];
  for (const side of [1, -1]) {
    const x = (t) => side * lerp(legX, ankleX, t);
    const tOf = (y) => (yCrotch - y) / (yCrotch - yAnkle);
    const nodes = [
      { p: new THREE.Vector3(side * legX * 0.85, yCrotch + H * 0.06, -0.8 * s), rx: thighR * 1.0, rz: thighR * 1.05 },
      { p: new THREE.Vector3(x(0), yCrotch - 1.5 * s, -0.4 * s), rx: thighR, rz: thighR },
      { p: new THREE.Vector3(x(tOf(lerp(yCrotch, yKnee, 0.5))), lerp(yCrotch, yKnee, 0.5), 0.1 * s), rx: thighR * 0.84, rz: thighR * 0.86 },
      { p: new THREE.Vector3(x(tOf(yKnee + H * 0.03)), yKnee + H * 0.03, 0.4 * s), rx: kneeR * 1.05, rz: kneeR * 1.02 },
      { p: new THREE.Vector3(x(tOf(yKnee)), yKnee, 0.3 * s), rx: kneeR, rz: kneeR },
      { p: new THREE.Vector3(x(tOf(yCalfMax)), yCalfMax, -0.7 * s), rx: calfR * 0.97, rz: calfR * 1.03 },
      { p: new THREE.Vector3(x(tOf(lerp(yAnkle, yKnee, 0.28))), lerp(yAnkle, yKnee, 0.28), -0.6 * s), rx: calfR * 0.7, rz: calfR * 0.72 },
      { p: new THREE.Vector3(x(1), yAnkle + 1.5 * s, -0.8 * s), rx: ankleR, rz: ankleR * 1.05 },
      { p: new THREE.Vector3(x(1), yAnkle - 2.5 * s, -0.8 * s), rx: ankleR * 0.95, rz: ankleR * 1.15 },
    ];
    legs.push({ side, nodes });

  }

  // ── 팔 (살짝 벌린 A자 자세) ──
  const uaR = v.upperArm / TAU;
  const L = v.arm;
  const handLen = 18.5 * s, handW = 8.4 * s, handT = 2.8 * s;
  const arms = [];
  for (const side of [1, -1]) {
    const start = new THREE.Vector3(side * (shW / 2 - uaR * 0.55), yShoulder - uaR * 0.7, -0.6 * s);
    const tilt = THREE.MathUtils.degToRad(9);
    const dir = new THREE.Vector3(side * Math.sin(tilt), -Math.cos(tilt), 0);
    const fdir = new THREE.Vector3(side * Math.sin(tilt * 0.8), -Math.cos(tilt * 0.8), 0.12).normalize(); // 아래팔은 살짝 앞으로
    const elbowS = L * 0.56;
    const at = (d) => (d <= elbowS
      ? start.clone().addScaledVector(dir, d)
      : start.clone().addScaledVector(dir, elbowS).addScaledVector(fdir, d - elbowS));
    const wrist = at(L);
    const nodes = [
      { p: start.clone().addScaledVector(dir, -uaR * 0.4), rx: uaR * 1.02, rz: uaR * 1.1 },
      { p: at(L * 0.1), rx: uaR * 1.1, rz: uaR * 1.12 },
      { p: at(L * 0.33), rx: uaR, rz: uaR },
      { p: at(elbowS), rx: uaR * 0.76, rz: uaR * 0.8 },
      { p: at(L * 0.7), rx: uaR * 0.8, rz: uaR * 0.88 },
      { p: at(L * 0.96), rx: uaR * 0.42, rz: uaR * 0.6 },
      { p: wrist, rx: uaR * 0.42, rz: uaR * 0.6 },
      { p: wrist.clone().addScaledVector(fdir, handLen * 0.25), rx: handT / 2, rz: handW / 2 },
      { p: wrist.clone().addScaledVector(fdir, handLen * 0.55), rx: handT / 2 * 0.9, rz: handW / 2 * 0.95 },
      { p: wrist.clone().addScaledVector(fdir, handLen * 0.88), rx: handT / 2 * 0.7, rz: handW / 2 * 0.7 },
      { p: wrist.clone().addScaledVector(fdir, handLen), rx: handT / 2 * 0.3, rz: handW / 2 * 0.3 },
    ];
    arms.push({ side, start, wrist, nodes, dir, fdir });
  }

  // ── 치수선(가이드) ──
  const legL = legs[0];
  const thighCenter = legL.nodes[1].p, calfCenter = legL.nodes[5].p;
  const armL = arms[0];
  const shoulderPtL = new THREE.Vector3(shW / 2, yShoulder, -0.6 * s);
  const outward = new THREE.Vector3(1, 0, 0);
  const guides = [
    { key: 'chest', label: '가슴', loop: true, points: ringPoints3D(chestPts, yChest, 0.4 * s) },
    { key: 'waist', label: '허리', loop: true, points: ringPoints3D(waistPts, yWaist, 0) },
    { key: 'hip', label: '엉덩이', loop: true, points: ringPoints3D(hipPts, yHip, -0.5 * s) },
    { key: 'neck', label: '목', loop: true, points: circlePoints3D(new THREE.Vector3(0, yNeckBase + 1 * s, -0.4 * s), neckR * 1.08) },
    { key: 'thigh', label: '허벅지', loop: true, points: circlePoints3D(thighCenter, thighR * 1.03) },
    { key: 'calf', label: '종아리', loop: true, points: circlePoints3D(calfCenter, calfR * 1.04) },
    { key: 'upperArm', label: '위팔', loop: true, points: circlePoints3D(armL.nodes[2].p, uaR * 1.08) },
    { key: 'shoulder', label: '어깨', loop: false, points: [new THREE.Vector3(-shW / 2, yShoulder + 0.5 * s, -0.6 * s), new THREE.Vector3(shW / 2, yShoulder + 0.5 * s, -0.6 * s)].map((p) => p.add(new THREE.Vector3(0, 0, -chestD * 0.45))) },
    { key: 'arm', label: '팔길이', loop: false, points: [shoulderPtL, armL.wrist].map((p) => p.clone().addScaledVector(outward, uaR * 1.3)) },
    { key: 'leg', label: '다리', loop: false, points: [new THREE.Vector3(0, yCrotch, 0), new THREE.Vector3(0, 0, 0)] },
    { key: 'calfLen', label: '종아리길이', loop: false, points: [legL.nodes[4].p, legL.nodes[7].p].map((p) => p.clone().addScaledVector(outward, kneeR * 1.5)) },
  ];

  // 2단계(옷 입히기)에서 쓸 단면 정보
  const profile = {
    H, yShoulder, yNeckBase, yChin, yCrotch, yHip, yWaist, yChest, yKnee, yAnkle,
    torsoRings, legs, arms, hipW, chestW, shoulderW: shW, values: v, uaR,
  };

  // ── 이음새 없는 표면 ──
  const group = new THREE.Group();
  group.name = 'body';
  const field = buildField({ v, fem, s, H, torsoRings, chestPts, underbust, yChest, yCrotch, yChin, yNeckBase, yAnkle, yKnee, neckR, headH, legs, arms, uaR, calfR, kneeR, handLen, handW, handT });
  const mesh = new THREE.Mesh(meshField(field.f, field.box, quality === 'draft' ? 1.5 : 0.75), material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  group.add(mesh);

  return { group, guides, profile };
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const avgR = (n) => (n.rx + n.rz) / 2;

function buildField(o) {
  const { v, fem, s, torsoRings, yChest, yCrotch, yChin, yNeckBase, neckR, headH, legs, arms, uaR, calfR, kneeR, handLen, handW, handT } = o;

  // 몸통: 여성은 가슴을 둥근 볼륨으로 따로 얹기 위해 단면의 가슴 돌출을 줄인다
  let rings = torsoRings;
  const extras = [];
  if (fem) {
    const h = clamp((v.chest - o.underbust) * 0.32, 1.2, 6.5);   // 가슴이 앞으로 나온 정도
    const rb = clamp(v.chest * 0.07, 4.5, 8.5);
    const ci = torsoRings.findIndex((r) => r.y === yChest);
    const base = toCirc(ringShape({ w: 1, df: 0.3, db: 0.34, n: 2.3, bust: 0.02 }), v.chest - h * 2.1);
    rings = torsoRings.map((r, i) => (i === ci ? { ...r, pts: base } : r));
    const w = widthOf(base);
    const xb = w * 0.2;
    const front = base.filter((p) => p[1] > 0).reduce((a, p) => (Math.abs(p[0] - xb) < Math.abs(a[0] - xb) ? p : a));
    const zc = torsoRings[ci].z;
    const prims = [1, -1].map((sd) => new Ellipsoid(V(sd * xb * 1.05, yChest + 0.6 * s, zc + front[1] + h - rb * 0.92), [rb * 1.02, rb * 0.95, rb * 0.92]));
    extras.push({ group: new Group(prims, 0), k: 3.2 });
  }
  // 맨 아래 작은 링은 거의 수평면이라 거리 근사가 깨지므로 빼고, 둥근 바닥 처리와 다리 녹임으로 닫는다
  // 몸통 아랫단을 허벅지 속까지 내려 이음선이 다리 안에 숨게 한다
  const r1 = rings[1];
  const sdfRings = [{ y: yCrotch - 0.02 * v.height, z: r1.z, pts: scalePts(r1.pts, 0.95, 0.72) }, ...rings.slice(1)];
  const torso = new TorsoField((y) => torsoAt(sdfRings, y), sdfRings[0].y, sdfRings[sdfRings.length - 1].y);

  // 목과 머리: 뒤통수가 둥근 달걀형 머리
  const neckHead = new Group([
    new Cone(V(0, yNeckBase - 4 * s, -1.2 * s), V(0, yChin + headH * 0.28, -0.6 * s), neckR * 1.06, neckR * 0.9),
    new Ellipsoid(V(0, yChin + headH * 0.58, -0.4 * s), [headH * 0.34, headH * 0.41, headH * 0.43]),
    new Ellipsoid(V(0, yChin + headH * 0.34, headH * 0.08), [headH * 0.25, headH * 0.34, headH * 0.3]),
  ], 2.6);

  // 팔: 어깨 삼각근 + 마디 캡슐 + 손가락을 모은 손
  const armGroups = arms.map(({ side, nodes, wrist, fdir, dir }) => {
    const prims = [splineTube(nodes.slice(0, 7).map((n) => ({ p: n.p, r: avgR(n) })))];
    prims.push(new Ellipsoid(nodes[1].p.clone().addScaledVector(dir, -uaR * 0.1).add(V(side * uaR * 0.05, 0, 0)), [uaR * 1.05, uaR * 1.4, uaR * 1.1]));
    const flat = [handT / handW * 1.3, 1, 1];
    const at = (t) => wrist.clone().addScaledVector(fdir, handLen * t);
    prims.push(new Cone(at(0.06), at(0.5), handW * 0.4, handW * 0.46, flat));
    prims.push(new Cone(at(0.5), at(0.94), handW * 0.44, handW * 0.18, [flat[0] * 0.9, 1, 1]));
    prims.push(new Cone(at(0.12).add(V(-side * 0.3 * s, 0, 2.0 * s)), at(0.42).add(V(-side * 0.2 * s, 0, 3.4 * s)), 1.15 * s, 0.85 * s));
    return new Group(prims, 1.6);
  });

  // 다리: 마디 캡슐 + 종아리 근육 + 무릎뼈 + 발
  const legGroups = legs.map(({ side, nodes }) => {
    const prims = [splineTube(nodes.map((n, i) => ({ p: n.p, r: avgR(n) * (i === 5 ? 0.9 : 1) })))];
    const calfLen = nodes[4].p.y - nodes[7].p.y;
    prims.push(new Ellipsoid(nodes[5].p.clone().add(V(-side * calfR * 0.08, calfLen * 0.05, -calfR * 0.28)), [calfR * 0.78, calfLen * 0.26, calfR * 0.66]));
    prims.push(new Ellipsoid(nodes[4].p.clone().add(V(0, kneeR * 0.1, kneeR * 0.5)), [kneeR * 0.45, kneeR * 0.5, kneeR * 0.34]));
    const fl = 0.152 * v.height;
    const a = nodes[8].p;
    const fx = a.x, az = a.z;
    prims.push(new Ellipsoid(V(fx, 3.3 * s, az - 0.12 * fl), [2.9 * s, 3.3 * s, 3.6 * s]));
    prims.push(new Cone(V(fx, 4.4 * s, az - 0.06 * fl), V(fx + side * 0.4 * s, 2.9 * s, az + 0.47 * fl), 3.4 * s, 3.0 * s, [1.4, 0.82, 1]));
    prims.push(new Cone(V(fx + side * 0.4 * s, 2.9 * s, az + 0.47 * fl), V(fx + side * 0.7 * s, 1.5 * s, az + 0.78 * fl), 3.0 * s, 1.1 * s, [1.4, 0.8, 1]));
    return new Group(prims, 2.0);
  });

  const all = [torso, neckHead, ...armGroups, ...legGroups, ...extras.map((e) => e.group)];
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of all) for (let i = 0; i < 3; i++) { box[i] = Math.min(box[i], p.box[i] - 2); box[i + 3] = Math.max(box[i + 3], p.box[i + 3] + 2); }
  box[1] = Math.max(box[1], -1);
  return { f: bodyField({ torso, neckHead, arms: armGroups, legs: legGroups, extras, yChest, yCrotch }), box };
}

export function disposeGroup(group) {
  group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
