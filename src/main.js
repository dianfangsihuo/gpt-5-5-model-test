import './style.css';
import * as THREE from 'three';

const app = document.querySelector('#app');

app.innerHTML = `
  <canvas id="world"></canvas>
  <div class="hud">
    <div class="brand">
      <span class="live-dot"></span>
      <div>
        <h1>Ridge Runner 3D</h1>
        <p>Immersive mountain coaster</p>
      </div>
    </div>
    <div class="readouts" aria-label="Ride telemetry">
      <div><span id="speed">0</span><small>km/h</small></div>
      <div><span id="height">0</span><small>m</small></div>
      <div><span id="gforce">1.0</span><small>g</small></div>
    </div>
  </div>
  <div class="controls">
    <button id="start" type="button">Start ride</button>
    <button id="boost" type="button">Boost</button>
    <button id="brake" type="button">Brake</button>
    <button id="camera" type="button">Camera</button>
    <button id="mute" type="button" aria-pressed="false">Sound on</button>
  </div>
  <div class="overlay" id="overlay">
    <div class="panel">
      <h2>Ridge Runner 3D</h2>
      <p>Drop through a foggy alpine valley with procedural sound, moving train lights, and a steel track built for speed.</p>
      <button id="launch" type="button">Launch</button>
    </div>
  </div>
`;

const canvas = document.querySelector('#world');
const speedEl = document.querySelector('#speed');
const heightEl = document.querySelector('#height');
const gforceEl = document.querySelector('#gforce');
const startButton = document.querySelector('#start');
const launchButton = document.querySelector('#launch');
const boostButton = document.querySelector('#boost');
const brakeButton = document.querySelector('#brake');
const cameraButton = document.querySelector('#camera');
const muteButton = document.querySelector('#mute');
const overlay = document.querySelector('#overlay');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ab6c7);
scene.fog = new THREE.FogExp2(0xa9bdc8, 0.012);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 1500);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const forward = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3();

let running = false;
let rideProgress = 0.02;
let rideSpeed = 0.026;
let cameraMode = 0;
let lastHeight = 0;
let shake = 0;
let speedLines;
let lastFrameTime = performance.now();
let elapsedTime = 0;
let boostHeld = false;
let brakeHeld = false;

const trackPoints = [
  [-70, 46, -120],
  [-36, 62, -80],
  [8, 76, -45],
  [52, 42, 5],
  [70, 18, 46],
  [34, 32, 84],
  [-12, 68, 62],
  [-58, 28, 26],
  [-72, 12, -24],
  [-42, 56, -66],
  [12, 94, -20],
  [76, 36, 34],
  [58, 22, 94],
  [-18, 40, 104],
  [-82, 30, 44],
  [-96, 52, -54],
];

const curve = new THREE.CatmullRomCurve3(
  trackPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  'catmullrom',
  0.42,
);
const curveLength = curve.getLength();
const carSpacing = 5.4 / curveLength;

class CoasterAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.windGain = null;
    this.windFilter = null;
    this.railGain = null;
    this.railFilter = null;
    this.chainGain = null;
    this.chainOsc = null;
    this.lastClickTime = 0;
    this.lastJointTime = 0;
    this.lastSquealTime = 0;
    this.lastDropTime = 0;
    this.muted = false;
  }

  async unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.72;
    this.master.connect(this.ctx.destination);
    this.createWind();
    this.createRailBed();
    this.createChainLift();
  }

  createNoiseSource() {
    const size = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    return noise;
  }

  createWind() {
    const noise = this.createNoiseSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.72;
    gain.gain.value = 0;
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    noise.start();
    this.windGain = gain;
    this.windFilter = filter;
  }

  createRailBed() {
    const noise = this.createNoiseSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 1.35;
    gain.gain.value = 0;
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    noise.start();
    this.railGain = gain;
    this.railFilter = filter;
  }

  createChainLift() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const shaper = this.ctx.createWaveShaper();
    const curveData = new Float32Array(256);
    for (let i = 0; i < curveData.length; i += 1) {
      const x = (i / 255) * 2 - 1;
      curveData[i] = Math.sign(x) * Math.pow(Math.abs(x), 0.42);
    }
    shaper.curve = curveData;
    osc.type = 'sawtooth';
    osc.frequency.value = 11;
    gain.gain.value = 0;
    osc.connect(shaper);
    shaper.connect(gain);
    gain.connect(this.master);
    osc.start();
    this.chainOsc = osc;
    this.chainGain = gain;
  }

  setMuted(value) {
    this.muted = value;
    muteButton.textContent = value ? 'Muted' : 'Sound on';
    muteButton.setAttribute('aria-pressed', String(value));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(value ? 0 : 0.72, this.ctx.currentTime, 0.035);
    }
  }

  update({ speed, slope, descending, curvature }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const v = THREE.MathUtils.clamp(speed, 0, 1);
    const turn = THREE.MathUtils.clamp(curvature || 0, 0, 1);
    this.windGain.gain.setTargetAtTime(0.02 + v * v * 0.46, t, 0.08);
    this.windFilter.frequency.setTargetAtTime(280 + v * 2500, t, 0.11);

    this.railGain.gain.setTargetAtTime(0.035 + v * 0.2 + turn * 0.08, t, 0.06);
    this.railFilter.frequency.setTargetAtTime(120 + v * 680 + turn * 260, t, 0.08);

    const lifting = slope > 0.18 && v < 0.46;
    this.chainGain.gain.setTargetAtTime(lifting ? 0.13 : 0.0001, t, 0.04);
    this.chainOsc.frequency.setTargetAtTime(9 + v * 18, t, 0.08);

    const interval = 0.2 - v * 0.145;
    if (t - this.lastClickTime > interval) {
      this.playTrackClick(v);
      this.lastClickTime = t;
    }

    const jointInterval = 0.42 - v * 0.24;
    if (t - this.lastJointTime > jointInterval) {
      this.playRailJoint(v, turn);
      this.lastJointTime = t;
    }

    if (turn > 0.42 && v > 0.45 && t - this.lastSquealTime > 0.75 && Math.random() < 0.18) {
      this.playWheelSqueal(v, turn);
      this.lastSquealTime = t;
    }

    if (descending && slope < -0.28 && v > 0.58 && t - this.lastDropTime > 2.3) {
      this.playDropCue(v);
      this.lastDropTime = t;
    }
  }

  playTrackClick(speed) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 170 + Math.random() * 95 + speed * 140;
    filter.type = 'highpass';
    filter.frequency.value = 760;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.055 + speed * 0.1, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.055);
  }

  playRailJoint(speed, turn) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.value = 95 + speed * 180 + Math.random() * 35;
    filter.type = 'bandpass';
    filter.frequency.value = 520 + turn * 900;
    filter.Q.value = 3.2;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.045 + speed * 0.08, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.095);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.11);
  }

  playWheelSqueal(speed, turn) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(920 + turn * 780, t);
    osc.frequency.linearRampToValueAtTime(1050 + speed * 900, t + 0.12);
    filter.type = 'bandpass';
    filter.frequency.value = 1400 + turn * 1300;
    filter.Q.value = 7;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.018 + turn * 0.035, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  playDropCue(speed) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(430, t);
    osc.frequency.exponentialRampToValueAtTime(860 + speed * 380, t + 0.28);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.54);
  }
}

const audio = new CoasterAudio();

function createGradientSky() {
  const canvasTexture = document.createElement('canvas');
  canvasTexture.width = 16;
  canvasTexture.height = 512;
  const ctx = canvasTexture.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#6f91ad');
  gradient.addColorStop(0.55, '#b6c8d0');
  gradient.addColorStop(1, '#e1d1b0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 512);
  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(620, 48, 24),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide }),
  );
  scene.add(mesh);
}

function addLights() {
  const hemi = new THREE.HemisphereLight(0xe6f1ff, 0x47512d, 2.3);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d1, 4.2);
  sun.position.set(-80, 160, -70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 420;
  sun.shadow.camera.left = -180;
  sun.shadow.camera.right = 180;
  sun.shadow.camera.top = 180;
  sun.shadow.camera.bottom = -180;
  scene.add(sun);
}

function addTerrain() {
  const geometry = new THREE.PlaneGeometry(520, 520, 170, 170);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const distance = Math.sqrt(x * x + z * z);
    const ridges = Math.sin(x * 0.035) * 6 + Math.cos(z * 0.047) * 8 + Math.sin((x + z) * 0.02) * 12;
    const bowl = Math.max(0, (distance - 120) * 0.18);
    position.setY(i, ridges + bowl - 18);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x3f5f35,
    roughness: 0.92,
    metalness: 0.02,
  });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  scene.add(terrain);

  const lake = new THREE.Mesh(
    new THREE.CircleGeometry(52, 80),
    new THREE.MeshStandardMaterial({
      color: 0x547e92,
      metalness: 0.1,
      roughness: 0.34,
      transparent: true,
      opacity: 0.72,
    }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(105, -10.8, 118);
  scene.add(lake);
}

function addClouds() {
  const cloudMaterial = new THREE.MeshStandardMaterial({
    color: 0xf5f0e5,
    roughness: 1,
    transparent: true,
    opacity: 0.72,
  });
  for (let i = 0; i < 18; i += 1) {
    const group = new THREE.Group();
    const baseX = -230 + Math.random() * 460;
    const baseZ = -230 + Math.random() * 460;
    const baseY = 130 + Math.random() * 70;
    for (let j = 0; j < 5; j += 1) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(8 + Math.random() * 10, 12, 8), cloudMaterial);
      puff.position.set(j * 9 + Math.random() * 6, Math.random() * 5, Math.random() * 8);
      puff.scale.y = 0.45;
      group.add(puff);
    }
    group.position.set(baseX, baseY, baseZ);
    scene.add(group);
  }
}

function addMountains() {
  const nearMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a7060,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const farMaterial = new THREE.MeshStandardMaterial({
    color: 0x7f989d,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });

  for (let i = 0; i < 38; i += 1) {
    const angle = (i / 38) * Math.PI * 2 + (Math.random() - 0.5) * 0.16;
    const radius = 185 + Math.random() * 90;
    const height = 36 + Math.random() * 92;
    const width = 22 + Math.random() * 36;
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(width, height, 5 + Math.floor(Math.random() * 3)),
      i % 3 === 0 ? farMaterial : nearMaterial,
    );
    mountain.position.set(Math.cos(angle) * radius, height * 0.45 - 14, Math.sin(angle) * radius);
    mountain.rotation.y = Math.random() * Math.PI;
    mountain.castShadow = true;
    mountain.receiveShadow = true;
    scene.add(mountain);
  }
}

function addSpeedLines() {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color: 0xf9fbff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  for (let i = 0; i < 72; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 4.5 + Math.random() * 8;
    const length = 3 + Math.random() * 7;
    const points = [
      new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, -3),
      new THREE.Vector3(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length), -18),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  group.visible = false;
  group.renderOrder = 10;
  scene.add(group);
  return group;
}

function addTrees() {
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x644530, roughness: 0.9 });
  const pineMaterial = new THREE.MeshStandardMaterial({ color: 0x174228, roughness: 0.78 });
  const trunkGeometry = new THREE.CylinderGeometry(0.45, 0.65, 6, 6);
  const pineGeometry = new THREE.ConeGeometry(3.2, 10, 8);

  for (let i = 0; i < 240; i += 1) {
    const radius = 55 + Math.random() * 185;
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * radius + (Math.random() - 0.5) * 50;
    const z = Math.sin(angle) * radius + (Math.random() - 0.5) * 50;
    if (Math.abs(x) < 25 && Math.abs(z) < 25) continue;
    const y = Math.sin(x * 0.035) * 6 + Math.cos(z * 0.047) * 8 + Math.sin((x + z) * 0.02) * 12 + Math.max(0, (Math.sqrt(x * x + z * z) - 120) * 0.18) - 14;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    const pine = new THREE.Mesh(pineGeometry, pineMaterial);
    trunk.castShadow = true;
    pine.castShadow = true;
    trunk.position.y = 3;
    pine.position.y = 10;
    tree.add(trunk, pine);
    tree.position.set(x, y, z);
    const scale = 0.75 + Math.random() * 0.9;
    tree.scale.setScalar(scale);
    tree.rotation.y = Math.random() * Math.PI;
    scene.add(tree);
  }
}

function addTrack() {
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0x5f6871,
    roughness: 0.3,
    metalness: 0.72,
  });
  const crossMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d3135,
    roughness: 0.55,
    metalness: 0.46,
  });

  const leftRail = new THREE.Mesh(new THREE.TubeGeometry(curve, 460, 0.38, 9, true), railMaterial);
  const rightRail = new THREE.Mesh(new THREE.TubeGeometry(curve, 460, 0.38, 9, true), railMaterial);
  leftRail.castShadow = true;
  rightRail.castShadow = true;
  scene.add(leftRail, rightRail);

  const railPositions = [];
  for (let i = 0; i < 170; i += 1) {
    const t = i / 170;
    const p = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    right.crossVectors(tangent, up).normalize();
    const left = p.clone().addScaledVector(right, -2.1);
    const railRight = p.clone().addScaledVector(right, 2.1);
    railPositions.push([left, railRight]);

    if (i % 2 === 0) {
      const sleeper = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.32, 0.7), crossMaterial);
      sleeper.position.copy(p);
      sleeper.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), right);
      sleeper.castShadow = true;
      scene.add(sleeper);
    }

    if (i % 7 === 0) {
      const supportHeight = Math.max(8, p.y + 18);
      const support = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.38, supportHeight, 8), crossMaterial);
      support.position.set(p.x, p.y - supportHeight / 2, p.z);
      support.castShadow = true;
      scene.add(support);
    }
  }

  const leftCurve = new THREE.CatmullRomCurve3(railPositions.map(([left]) => left), true);
  const rightCurve = new THREE.CatmullRomCurve3(railPositions.map(([, railRight]) => railRight), true);
  leftRail.geometry.dispose();
  rightRail.geometry.dispose();
  leftRail.geometry = new THREE.TubeGeometry(leftCurve, 460, 0.28, 8, true);
  rightRail.geometry = new THREE.TubeGeometry(rightCurve, 460, 0.28, 8, true);
}

function createTrain() {
  const train = new THREE.Group();
  train.userData.cars = [];
  train.userData.wheels = [];
  train.userData.leadPosition = new THREE.Vector3();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xb71f2c,
    roughness: 0.28,
    metalness: 0.34,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0xf1c34e, roughness: 0.38, metalness: 0.22 });
  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x14191d, roughness: 0.42, metalness: 0.58 });
  const seatMaterial = new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.62 });
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xffe4a8, emissive: 0xffb645, emissiveIntensity: 1.8 });
  const tailMaterial = new THREE.MeshStandardMaterial({ color: 0xff283c, emissive: 0xff1020, emissiveIntensity: 1.3 });
  const carGeometry = new THREE.BoxGeometry(4.2, 1.15, 4.7);
  const sideGeometry = new THREE.BoxGeometry(0.26, 0.85, 4.15);
  const seatGeometry = new THREE.BoxGeometry(3.1, 0.62, 0.95);
  const axleGeometry = new THREE.CylinderGeometry(0.1, 0.1, 4.7, 10);
  const wheelGeometry = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 18);
  const barGeometry = new THREE.TorusGeometry(0.72, 0.055, 8, 18, Math.PI);
  const couplerGeometry = new THREE.BoxGeometry(0.42, 0.28, 1.2);

  for (let carIndex = 0; carIndex < 3; carIndex += 1) {
    const car = new THREE.Group();
    car.userData.progressOffset = carIndex * carSpacing;

    const body = new THREE.Mesh(carGeometry, bodyMaterial);
    body.position.y = 0.28;
    body.scale.set(1, 1, carIndex === 0 ? 1.05 : 0.98);
    body.castShadow = true;
    car.add(body);

    const leftPanel = new THREE.Mesh(sideGeometry, accentMaterial);
    const rightPanel = new THREE.Mesh(sideGeometry, accentMaterial);
    leftPanel.position.set(-2.23, 0.72, 0.05);
    rightPanel.position.set(2.23, 0.72, 0.05);
    leftPanel.castShadow = true;
    rightPanel.castShadow = true;
    car.add(leftPanel, rightPanel);

    for (let row = 0; row < 2; row += 1) {
      const rowZ = -1.1 + row * 1.85;
      const seat = new THREE.Mesh(seatGeometry, seatMaterial);
      seat.position.set(0, 1.08, rowZ);
      seat.castShadow = true;
      car.add(seat);

      const back = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.05, 0.2), seatMaterial);
      back.position.set(0, 1.58, rowZ + 0.5);
      back.rotation.x = -0.16;
      back.castShadow = true;
      car.add(back);

      const lapBar = new THREE.Mesh(barGeometry, frameMaterial);
      lapBar.position.set(0, 1.55, rowZ - 0.18);
      lapBar.rotation.set(Math.PI, 0, 0);
      lapBar.scale.x = 1.65;
      lapBar.castShadow = true;
      car.add(lapBar);
    }

    for (const wheelZ of [-1.75, 1.75]) {
      const axle = new THREE.Mesh(axleGeometry, frameMaterial);
      axle.position.set(0, -0.52, wheelZ);
      axle.rotation.z = Math.PI / 2;
      axle.castShadow = true;
      car.add(axle);

      for (const wheelX of [-2.22, 2.22]) {
        const wheel = new THREE.Mesh(wheelGeometry, frameMaterial);
        wheel.position.set(wheelX, -0.52, wheelZ);
        wheel.rotation.z = Math.PI / 2;
        wheel.castShadow = true;
        car.add(wheel);
        train.userData.wheels.push(wheel);
      }
    }

    if (carIndex < 2) {
      const coupler = new THREE.Mesh(couplerGeometry, frameMaterial);
      coupler.position.set(0, -0.08, 2.62);
      coupler.castShadow = true;
      car.add(coupler);
    }

    if (carIndex === 2) {
      for (const x of [-1.3, 1.3]) {
        const tail = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), tailMaterial);
        tail.position.set(x, 0.4, 2.45);
        car.add(tail);
      }
    }

    train.add(car);
    train.userData.cars.push(car);
  }

  const nose = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.45, 4), bodyMaterial);
  nose.rotation.y = Math.PI / 4;
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.33, -3.28);
  nose.castShadow = true;
  train.userData.cars[0].add(nose);

  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.34, 0.2), frameMaterial);
  frontBumper.position.set(0, -0.03, -4.15);
  frontBumper.castShadow = true;
  train.userData.cars[0].add(frontBumper);

  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 8), lampMaterial);
  lamp.position.set(0, 0.58, -4.08);
  train.userData.cars[0].add(lamp);

  const headlight = new THREE.SpotLight(0xffe6b4, 18, 85, 0.42, 0.65, 1.2);
  headlight.position.set(0, 1.1, -4.15);
  headlight.target.position.set(0, 0.5, -12);
  train.userData.cars[0].add(headlight, headlight.target);
  scene.add(train);
  return train;
}

createGradientSky();
addLights();
addTerrain();
addClouds();
addMountains();
addTrees();
addTrack();
const train = createTrain();
speedLines = addSpeedLines();

function startRide() {
  running = true;
  overlay.classList.add('hidden');
  startButton.textContent = 'Pause';
  audio.unlock();
}

function toggleRide() {
  if (running) {
    running = false;
    startButton.textContent = 'Resume';
  } else {
    startRide();
  }
}

startButton.addEventListener('click', toggleRide);
launchButton.addEventListener('click', startRide);
cameraButton.addEventListener('click', () => {
  cameraMode = (cameraMode + 1) % 3;
  cameraButton.textContent = cameraMode === 0 ? 'Camera' : cameraMode === 1 ? 'Chase' : 'Scenic';
});
muteButton.addEventListener('click', () => audio.setMuted(!audio.muted));
boostButton.addEventListener('pointerdown', () => { boostHeld = true; });
boostButton.addEventListener('pointerup', () => { boostHeld = false; });
boostButton.addEventListener('pointerleave', () => { boostHeld = false; });
brakeButton.addEventListener('pointerdown', () => { brakeHeld = true; });
brakeButton.addEventListener('pointerup', () => { brakeHeld = false; });
brakeButton.addEventListener('pointerleave', () => { brakeHeld = false; });
window.addEventListener('keydown', (event) => {
  if (event.code === 'ArrowUp' || event.code === 'KeyW') boostHeld = true;
  if (event.code === 'ArrowDown' || event.code === 'KeyS') brakeHeld = true;
  if (event.code === 'Space') toggleRide();
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'ArrowUp' || event.code === 'KeyW') boostHeld = false;
  if (event.code === 'ArrowDown' || event.code === 'KeyS') brakeHeld = false;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.setMuted(true);
});

function updateTrain(dt) {
  const currentPoint = curve.getPointAt(rideProgress);
  const nextPoint = curve.getPointAt((rideProgress + 0.002) % 1);
  const tangent = curve.getTangentAt(rideProgress).normalize();
  const farTangent = curve.getTangentAt((rideProgress + 0.018) % 1).normalize();
  const slope = (nextPoint.y - currentPoint.y) / nextPoint.distanceTo(currentPoint);
  const curvature = tangent.angleTo(farTangent) * 5.6;
  const descending = currentPoint.y < lastHeight - 0.02;
  const gravityBoost = THREE.MathUtils.clamp(-slope, -0.2, 0.7);
  const manualBoost = boostHeld ? 0.0065 : 0;
  const manualBrake = brakeHeld ? 0.012 : 0;
  rideSpeed += (gravityBoost * 0.014 + manualBoost - manualBrake - 0.0018) * dt;
  rideSpeed = THREE.MathUtils.clamp(rideSpeed, 0.018, 0.082);
  rideProgress = (rideProgress + (rideSpeed * dt) / (curveLength / 100)) % 1;

  const point = curve.getPointAt(rideProgress);
  for (const car of train.userData.cars) {
    const carProgress = (rideProgress - car.userData.progressOffset + 1) % 1;
    const carPoint = curve.getPointAt(carProgress);
    const carForward = curve.getTangentAt(carProgress).normalize();
    right.crossVectors(carForward, up).normalize();
    tmpVec.crossVectors(right, carForward).normalize();
    const matrix = new THREE.Matrix4().makeBasis(right, tmpVec, carForward.clone().negate());
    tmpQuat.setFromRotationMatrix(matrix);
    car.position.copy(carPoint).addScaledVector(tmpVec, 1.12);
    car.quaternion.slerp(tmpQuat, 0.48);
  }
  train.userData.leadPosition.copy(train.userData.cars[0].position);
  for (const wheel of train.userData.wheels) {
    wheel.rotation.x += rideSpeed * dt * 2.8;
  }

  const normalizedSpeed = THREE.MathUtils.mapLinear(rideSpeed, 0.018, 0.082, 0, 1);
  shake = THREE.MathUtils.lerp(shake, normalizedSpeed * 0.42, 0.08);
  scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, 0.011 + normalizedSpeed * 0.007, 0.035);
  camera.fov = THREE.MathUtils.lerp(camera.fov, 68 + normalizedSpeed * 12, 0.04);
  camera.updateProjectionMatrix();
  speedLines.visible = normalizedSpeed > 0.2 && cameraMode === 0;
  speedLines.children[0].material.opacity = normalizedSpeed * 0.28;
  speedLines.position.copy(train.userData.leadPosition);
  speedLines.quaternion.copy(camera.quaternion);
  speedLines.rotation.z += dt * (0.02 + normalizedSpeed * 0.08);
  audio.update({ speed: normalizedSpeed, slope, descending, curvature });

  speedEl.textContent = Math.round(42 + normalizedSpeed * 116);
  heightEl.textContent = Math.max(0, Math.round(point.y));
  gforceEl.textContent = (1 + normalizedSpeed * 1.8 + Math.max(0, -slope) * 0.9).toFixed(1);
  lastHeight = point.y;
}

function updateCamera(elapsed) {
  const point = curve.getPointAt(rideProgress);
  const tangent = curve.getTangentAt(rideProgress).normalize();
  const bob = Math.sin(elapsed * 42) * shake;

  if (cameraMode === 0) {
    const camPos = point.clone().addScaledVector(up, 4.5).addScaledVector(tangent, 4.6);
    camera.position.lerp(camPos.add(new THREE.Vector3(bob, bob * 0.35, 0)), 0.22);
    tmpVec.copy(point).addScaledVector(tangent, 34).addScaledVector(up, 2.4);
    camera.lookAt(tmpVec);
  } else if (cameraMode === 1) {
    right.crossVectors(up, tangent).normalize();
    const chase = point.clone().addScaledVector(tangent, -18).addScaledVector(up, 10).addScaledVector(right, 5);
    camera.position.lerp(chase, 0.12);
    camera.lookAt(point.clone().addScaledVector(up, 2));
  } else {
    tmpVec2.set(Math.sin(elapsed * 0.08) * 150, 82, Math.cos(elapsed * 0.08) * 150);
    camera.position.lerp(tmpVec2, 0.025);
    camera.lookAt(train.userData.leadPosition);
  }
}

function animate() {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.04);
  lastFrameTime = now;
  elapsedTime += dt;
  if (running) updateTrain(dt * 60);
  updateCamera(elapsedTime);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

lastHeight = curve.getPointAt(rideProgress).y;
updateTrain(0.1);
animate();
