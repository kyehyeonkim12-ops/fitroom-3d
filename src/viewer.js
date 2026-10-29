// Three.js 장면: 카메라, 조명, 바닥, 줄자, 치수선 라벨, 터치/마우스 조작.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildBody, disposeGroup } from './bodyModel.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewer {
  constructor(container, labelLayer) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.showGuides = true;
    this.labels = [];

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);

    // 스튜디오처럼 은은한 반사를 주는 환경광
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.add(new THREE.HemisphereLight(0xf4f1ff, 0x5a5048, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(120, 260, 200);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -120, right: 120, top: 240, bottom: -20, near: 10, far: 700 });
    key.shadow.radius = 4;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.9);
    rim.position.set(-180, 160, -220);
    scene.add(rim);

    // 바닥: 그림자만 받는 평면 + 발판 원
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.ShadowMaterial({ opacity: 0.18 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.floorDisc = new THREE.Mesh(new THREE.CircleGeometry(45, 64), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
    this.floorDisc.rotation.x = -Math.PI / 2;
    this.floorDisc.position.y = -0.05;
    scene.add(this.floorDisc);

    // 유광 화이트 마네킹
    this.bodyMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.18, envMapIntensity: 0.9 });
    this.clothMaterial = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide, color: 0x3d4a63, envMapIntensity: 0.45 });
    this.fitMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide, vertexColors: true, envMapIntensity: 0.45 });
    this.fitMap = false;
    this.garment = null;
    this.guideMaterial = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 });
    this.rulerMaterial = new THREE.LineBasicMaterial();

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 60;
    controls.maxDistance = 900;
    controls.maxPolarAngle = Math.PI * 0.92;
    controls.screenSpacePanning = true;
    this.controls = controls;

    this.applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => this.applyTheme());
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    this.tween = null;
    const loop = (t) => {
      requestAnimationFrame(loop);
      this.step(t);
    };
    requestAnimationFrame(loop);
  }

  applyTheme() {
    this.bodyMaterial.color.set(css('--mannequin') || '#ecebe8');
    this.guideMaterial.color.set(css('--chalk') || '#2f6fb3');
    this.rulerMaterial.color.set(css('--accent') || '#d9a21b');
    this.floorDisc.material.color.set(css('--floor') || '#dfe3e8');
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.height && !this.framed) this.frame();
  }

  setBody(values, gender, quality = 'final') {
    if (this.body) {
      this.scene.remove(this.body.group);
      disposeGroup(this.body.group);
    }
    this.body = buildBody(values, gender, this.bodyMaterial, { quality });
    this.scene.add(this.body.group);
    const firstTime = !this.height;
    const heightChanged = this.height && Math.abs(this.height - values.height) > 0.01;
    this.height = values.height;
    this.values = values;
    this.buildGuides();
    this.buildRuler();
    if (firstTime) this.frame();
    else if (heightChanged) this.controls.target.y = this.height * 0.47;
  }

  frame() {
    const H = this.height || 170;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = (H * 1.3) / 2 / Math.tan(fov / 2);
    const fitW = (H * 0.7) / 2 / Math.tan(fov / 2) / Math.max(0.3, this.camera.aspect);
    const dist = Math.max(fitH, fitW);
    this.controls.target.set(0, H * 0.47, 0);
    this.camera.position.set(dist * 0.42, H * 0.62, dist * 0.91);
    this.controls.update();
    this.framed = this.container.clientWidth > 0;
  }

  // 정면 0°, 측면 90°, 후면 180°
  view(deg) {
    const H = this.height || 170;
    const target = new THREE.Vector3(0, H * 0.47, 0);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const r = Math.hypot(offset.x, offset.z);
    const a = THREE.MathUtils.degToRad(deg);
    const to = new THREE.Vector3(Math.sin(a) * r, offset.y * 0.25, Math.cos(a) * r).add(target);
    this.tween = { fromPos: this.camera.position.clone(), toPos: to, fromT: this.controls.target.clone(), toT: target, t0: performance.now(), dur: 650 };
  }

  // 옷 메시 교체. group 안 메시에 재질을 입힌다.
  setGarment(group) {
    if (this.garment) {
      this.scene.remove(this.garment);
      disposeGroup(this.garment);
    }
    this.garment = group;
    if (!group) return;
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = this.fitMap ? this.fitMaterial : this.clothMaterial;
      o.castShadow = true;
    });
    group.visible = !this.garmentHidden;
    this.scene.add(group);
  }

  setCloth({ color, texture }) {
    const m = this.clothMaterial;
    if (m.map && m.map !== texture) m.map.dispose();
    m.map = texture || null;
    m.color.set(texture ? '#ffffff' : color);
    m.needsUpdate = true;
  }

  setFitMap(on) {
    this.fitMap = on;
    this.garment?.traverse((o) => { if (o.isMesh) o.material = on ? this.fitMaterial : this.clothMaterial; });
  }

  setGuides(on) {
    this.showGuides = on;
    if (this.guideGroup) this.guideGroup.visible = on;
    for (const l of this.labels) l.el.hidden = !on;
  }

  buildGuides() {
    if (this.guideGroup) {
      this.scene.remove(this.guideGroup);
      disposeGroup(this.guideGroup);
    }
    this.guideGroup = new THREE.Group();
    this.guideGroup.visible = this.showGuides;
    this.guideGroup.renderOrder = 10;
    this.labelLayer.querySelectorAll('.g-label').forEach((n) => n.remove());
    this.labels = [];
    for (const g of this.body.guides) {
      const geo = new THREE.BufferGeometry().setFromPoints(g.points);
      const line = g.loop ? new THREE.LineLoop(geo, this.guideMaterial) : new THREE.Line(geo, this.guideMaterial);
      line.renderOrder = 10;
      this.guideGroup.add(line);
      // 라벨은 고리의 가장 오른쪽(+x) 점, 직선은 가운데
      let anchor;
      if (g.loop) anchor = g.points.reduce((a, p) => (p.x > a.x ? p : a), g.points[0]).clone();
      else anchor = g.points[0].clone().lerp(g.points[1], 0.5);
      const el = document.createElement('div');
      el.className = 'g-label';
      el.dataset.key = g.key;
      el.innerHTML = `<span>${g.label}</span><b>${fmt(this.values[g.key])}</b>`;
      el.hidden = !this.showGuides;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, anchor, loop: g.loop });
    }
    this.scene.add(this.guideGroup);
  }

  // 모델 옆에 세운 줄자: 1cm 단위 눈금은 너무 촘촘하므로 10cm/50cm 눈금
  buildRuler() {
    if (this.ruler) {
      this.scene.remove(this.ruler);
      disposeGroup(this.ruler);
    }
    const H = this.height;
    const x = -(this.values.shoulder / 2 + 26), z = -6;
    const pts = [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, H, z)];
    for (let y = 0; y <= H; y += 5) {
      const len = y % 50 === 0 ? 6 : y % 10 === 0 ? 3.5 : 1.8;
      pts.push(new THREE.Vector3(x, y, z), new THREE.Vector3(x + len, y, z));
    }
    pts.push(new THREE.Vector3(x, H, z), new THREE.Vector3(x + 18, H, z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.ruler = new THREE.LineSegments(geo, this.rulerMaterial);
    this.scene.add(this.ruler);

    this.labelLayer.querySelectorAll('.r-label').forEach((n) => n.remove());
    this.rulerLabels = [];
    const marks = [];
    for (let y = 50; y < H - 12; y += 50) marks.push({ y, text: String(y), cls: '' });
    marks.push({ y: H, text: `${fmt(H)}cm`, cls: ' top' });
    for (const m of marks) {
      const el = document.createElement('div');
      el.className = 'r-label' + m.cls;
      el.textContent = m.text;
      this.labelLayer.appendChild(el);
      this.rulerLabels.push({ el, anchor: new THREE.Vector3(x - 2, m.y, z), left: true });
    }
  }

  step(now) {
    if (this.tween) {
      const tw = this.tween;
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  placeLabels() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    const place = (item, gap) => {
      v.copy(item.anchor).project(this.camera);
      const behind = v.z > 1;
      const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
      item.el.style.transform = `translate(${px + (item.left ? -gap : gap)}px, ${py}px) translate(${item.left ? '-100%' : '0'}, -50%)`;
      item.el.style.visibility = behind ? 'hidden' : '';
    };
    if (this.showGuides) for (const l of this.labels) place(l, 6);
    if (this.rulerLabels) for (const l of this.rulerLabels) place(l, 2);
  }
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
