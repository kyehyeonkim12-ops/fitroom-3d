// 치수로부터 3D 인체(마네킹) 메시를 만든다.
// 단위: cm. 바닥 y=0, 정면 +z, 몸 중심 x=0.
// 몸통은 단면 링을 쌓아 이은 로프트, 팔다리는 단면이 변하는 튜브로 만든다.
// 2단계에서 옷을 같은 링 구조 위에 여유분만큼 부풀려 입히기 위해 단면 정보(`profile`)도 함께 반환한다.
import * as THREE from 'three';

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

// rings: [{ y, z: 중심 z 오프셋, pts }] 아래에서 위 순서
function loftGeometry(rings, steps = 5) {
  const R = rings.length;
  const pos = [];
  const get = (i) => rings[clamp(i, 0, R - 1)];
  let rows = 0;
  for (let i = 0; i < R - 1; i++) {
    const last = i === R - 2;
    for (let k = 0; k < steps + (last ? 1 : 0); k++) {
      const t = k / steps;
      const r0 = get(i - 1), r1 = get(i), r2 = get(i + 1), r3 = get(i + 2);
      const y = catmull(r0.y, r1.y, r2.y, r3.y, t);
      const zc = catmull(r0.z, r1.z, r2.z, r3.z, t);
      for (let j = 0; j < RING_N; j++) {
        const x = catmull(r0.pts[j][0], r1.pts[j][0], r2.pts[j][0], r3.pts[j][0], t);
        const z = catmull(r0.pts[j][1], r1.pts[j][1], r2.pts[j][1], r3.pts[j][1], t);
        pos.push(x, y, z + zc);
      }
      rows++;
    }
  }
  return gridToGeometry(pos, rows, true, true);
}

// pos: rows×RING_N 꼭짓점. 행 순서대로 링을 잇고 양 끝을 막는다.
function gridToGeometry(pos, rows, capStart, capEnd) {
  const idx = [];
  const N = RING_N;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * N + j, b = (i + 1) * N + j;
      const c = i * N + ((j + 1) % N), d = (i + 1) * N + ((j + 1) % N);
      idx.push(a, b, c, c, b, d);
    }
  }
  const cap = (row, start) => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < N; j++) { const o = (row * N + j) * 3; cx += pos[o]; cy += pos[o + 1]; cz += pos[o + 2]; }
    const ci = pos.length / 3;
    pos.push(cx / N, cy / N, cz / N);
    for (let j = 0; j < N; j++) {
      const v0 = row * N + j, v1 = row * N + ((j + 1) % N);
      if (start) idx.push(ci, v0, v1); else idx.push(ci, v1, v0);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(rows - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// nodes: [{ p: Vector3, rx, rz }] 시작→끝. 단면은 타원.
function tubeGeometry(nodes, spacing = 1.2) {
  const n = nodes.length;
  const get = (i) => nodes[clamp(i, 0, n - 1)];
  const centers = [], radii = [];
  for (let i = 0; i < n - 1; i++) {
    const segLen = nodes[i].p.distanceTo(nodes[i + 1].p);
    const steps = Math.max(2, Math.ceil(segLen / spacing));
    const last = i === n - 2;
    for (let k = 0; k < steps + (last ? 1 : 0); k++) {
      const t = k / steps;
      const a = get(i - 1), b = get(i), c = get(i + 1), d = get(i + 2);
      centers.push(new THREE.Vector3(
        catmull(a.p.x, b.p.x, c.p.x, d.p.x, t),
        catmull(a.p.y, b.p.y, c.p.y, d.p.y, t),
        catmull(a.p.z, b.p.z, c.p.z, d.p.z, t),
      ));
      radii.push([Math.max(0.05, catmull(a.rx, b.rx, c.rx, d.rx, t)), Math.max(0.05, catmull(a.rz, b.rz, c.rz, d.rz, t))]);
    }
  }
  const pos = [];
  const up = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3(0, 0, 1);
  const tan = new THREE.Vector3(), xA = new THREE.Vector3(), zA = new THREE.Vector3();
  for (let i = 0; i < centers.length; i++) {
    const p0 = centers[Math.max(0, i - 1)], p1 = centers[Math.min(centers.length - 1, i + 1)];
    tan.subVectors(p1, p0).normalize();
    const ref = Math.abs(tan.dot(fwd)) > 0.9 ? up : fwd;
    xA.crossVectors(tan, ref).normalize();
    zA.crossVectors(xA, tan).normalize();
    const [rx, rz] = radii[i];
    for (let j = 0; j < RING_N; j++) {
      const a = (j / RING_N) * TAU;
      const cx = Math.cos(a) * rx, cz = Math.sin(a) * rz;
      pos.push(
        centers[i].x + xA.x * cx + zA.x * cz,
        centers[i].y + xA.y * cx + zA.y * cz,
        centers[i].z + xA.z * cx + zA.z * cz,
      );
    }
  }
  return { geometry: gridToGeometry(pos, centers.length, true, true), centers, radii };
}

function headGeometry(headH, headW, headD) {
  // 턱(0)에서 정수리(1)까지 반지름 윤곽
  const prof = [[0, 0], [0.42, 0.02], [0.66, 0.12], [0.86, 0.3], [0.97, 0.5], [1, 0.62], [0.95, 0.76], [0.8, 0.88], [0.52, 0.97], [0, 1]];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r * headW / 2, y * headH));
  const g = new THREE.LatheGeometry(pts, RING_N);
  g.scale(1, 1, headD / headW);
  g.computeVertexNormals();
  return g;
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

export function buildBody(values, gender, material) {
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
  const shoulderPts = ringShape({ w: shW * 0.86, df: chestD * 0.36, db: chestD * 0.38, n: 3.2 });
  const neckR = v.neck / TAU;
  const trapPts = ringShape({ w: Math.max(shW * 0.55, neckR * 3), df: neckR * 1.25, db: neckR * 1.45, n: 2.6 });
  const neckBasePts = toCirc(ringShape({ w: 1, df: 0.42, db: 0.42, n: 2 }), v.neck * 1.12);

  const torsoRings = [
    { y: yCrotch + H * 0.004, z: -1.0 * s, pts: bottomPts },
    { y: yCrotch + H * 0.02, z: -0.8 * s, pts: crotchPts },
    { y: lerp(yCrotch, yHip, 0.55), z: -0.6 * s, pts: lowHipPts },
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

  const group = new THREE.Group();
  group.name = 'body';
  const add = (geo, name) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  add(loftGeometry(torsoRings, 6), 'torso');

  // ── 목, 머리 ──
  const neck = tubeGeometry([
    { p: new THREE.Vector3(0, yNeckBase - H * 0.03, -0.8 * s), rx: neckR * 1.1, rz: neckR * 1.05 },
    { p: new THREE.Vector3(0, yNeckBase, -0.6 * s), rx: neckR, rz: neckR },
    { p: new THREE.Vector3(0, yChin + 1.5 * s, 0.2 * s), rx: neckR * 0.96, rz: neckR * 0.98 },
  ]);
  add(neck.geometry, 'neck');
  const headH = H - yChin + 0.6 * s;
  const head = add(headGeometry(headH, 15.4 * s, 19.2 * s), 'head');
  head.position.set(0, yChin - 0.6 * s, 0.9 * s);

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
    const leg = tubeGeometry(nodes);
    add(leg.geometry, side > 0 ? 'legL' : 'legR');
    legs.push({ side, nodes });

    // 발: 뒤꿈치→발끝 방향 튜브
    const fl = 25.5 * s, fw = 9.8 * s;
    const fx = x(1);
    const foot = tubeGeometry([
      { p: new THREE.Vector3(fx, 4.2 * s, -0.22 * fl), rx: fw * 0.26, rz: 3.0 * s },
      { p: new THREE.Vector3(fx, 4.6 * s, -0.12 * fl), rx: fw * 0.34, rz: 4.1 * s },
      { p: new THREE.Vector3(fx + side * 0.3 * s, 3.8 * s, 0.22 * fl), rx: fw * 0.42, rz: 3.3 * s },
      { p: new THREE.Vector3(fx + side * 0.6 * s, 2.5 * s, 0.52 * fl), rx: fw * 0.5, rz: 2.2 * s },
      { p: new THREE.Vector3(fx + side * 0.6 * s, 1.6 * s, 0.72 * fl), rx: fw * 0.44, rz: 1.4 * s },
      { p: new THREE.Vector3(fx + side * 0.5 * s, 1.5 * s, 0.77 * fl), rx: fw * 0.2, rz: 0.8 * s },
    ], 1.0);
    add(foot.geometry, side > 0 ? 'footL' : 'footR');
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
    add(tubeGeometry(nodes).geometry, side > 0 ? 'armL' : 'armR');
    arms.push({ side, start, wrist, nodes });
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

  return { group, guides, profile };
}

export function disposeGroup(group) {
  group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
