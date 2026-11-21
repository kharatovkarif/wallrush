/* WallRush 3D board (Premium) — a real 3D scene drawn with three.js.

   Served only to players who may use it (/api/premium/board3d.js?t=…, see
   server/index.js), so the file is not lying in /public for anyone to load.

   It does not know the rules and does not keep any game state. Every frame it
   mirrors the ordinary DOM board, which stays laid out (invisible) underneath:
   the grid lines, the coloured end zones, every wall (including the one being
   dragged), every pawn at its animated position, the legal-move dots. So
   moves, walls and animations keep working exactly as on the flat board, and
   this file only has to draw them well and turn touches back into board
   coordinates. Pixels of the DOM board are the scene's units.

   Camera: a pivot at the board's centre, turned by `spin` round the vertical
   and tipped by `tilt` (0 = straight down from above, 74 = nearly side-on);
   the camera sits on the pivot at a distance set by `zoom`. Everything is
   re-rendered at the screen's real resolution, so zooming in stays sharp. */

import * as THREE from '/vendor/three.module.min.js?v=1';

const COLORS = {
  blue: 0x2f6df6, red: 0xe33d52, yellow: 0xf0b429, green: 0x21a35a, neutral: 0x2b3355,
};
const colorOf = (el) => {
  for (const k of ['blue', 'red', 'yellow', 'green']) if (el.classList.contains(k)) return k;
  return 'neutral';
};

export function mount3d({ board, wrap, getView, setView, saveView, onTap, isDraggingWall }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'b3gl';
  wrap.appendChild(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    canvas.remove();
    return null;   // no WebGL: the caller falls back to the CSS view
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 10, 6000);
  const pivot = new THREE.Object3D();
  pivot.rotation.order = 'YXZ';
  pivot.add(camera);
  scene.add(pivot);

  const dark = () => document.documentElement.dataset.theme === 'dark';
  // the board theme's colours, set as custom properties on #board (style.css)
  const tv = (name) => getComputedStyle(board).getPropertyValue(name).trim();
  const boardTheme = () => document.documentElement.dataset.bt || '';
  const pieceTheme = () => document.documentElement.dataset.pt || '';

  // light: soft sky light plus one sun that casts the shadows that make it 3D
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a96b8, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);

  // the board: a slab with a bezel, and a top drawn from the DOM board
  const slabMat = new THREE.MeshStandardMaterial({ color: 0xc9d2e2, roughness: 0.55, metalness: 0.05 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), slabMat);
  slab.receiveShadow = true;
  scene.add(slab);
  const topCanvas = document.createElement('canvas');
  const topTex = new THREE.CanvasTexture(topCanvas);
  topTex.colorSpace = THREE.SRGBColorSpace;
  topTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.8 });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), topMat);
  top.rotation.x = -Math.PI / 2;
  top.receiveShadow = true;
  scene.add(top);

  const wallGroup = new THREE.Group();
  const pawnGroup = new THREE.Group();
  const dotGroup = new THREE.Group();
  scene.add(wallGroup, pawnGroup, dotGroup);
  const mats = {};
  const mat = (key, opts) => mats[key] || (mats[key] = new THREE.MeshStandardMaterial(opts));
  const box = new THREE.BoxGeometry(1, 1, 1);
  const ball = new THREE.SphereGeometry(1, 48, 32);
  const gemGeo = new THREE.OctahedronGeometry(1.1, 0);   // the crystal pieces
  const ring = new THREE.TorusGeometry(1, 0.08, 12, 48);

  let W = 0, H = 0, topSig = '';
  const local = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  const toWorld = (x, y) => [x - W / 2, y - H / 2];   // DOM px → scene (x, z)

  function drawTop() {
    const lines = [...board.querySelectorAll('.grid-line')].map(local);
    const bands = [...board.querySelectorAll('.zone-band')].map(b => ({ ...local(b), c: colorOf(b),
      side: ['top', 'bottom', 'left', 'right'].find(s => b.classList.contains(s) || b.classList.contains('side-' + s)) || 'top',
      finish: b.classList.contains('finish') }));
    const goals = [...board.querySelectorAll('.goal-cell')].map(local);
    const sig = [W, H, dark(), boardTheme(), JSON.stringify(lines), JSON.stringify(bands), goals.length].join('|');
    if (sig === topSig) return;
    topSig = sig;
    const k = Math.min(4, 2048 / Math.max(W, H));   // texture pixels per board pixel
    topCanvas.width = Math.round(W * k); topCanvas.height = Math.round(H * k);
    const g = topCanvas.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    const grad = g.createLinearGradient(0, 0, W * 0.3, H);
    if (boardTheme() && tv('--bt-a')) { grad.addColorStop(0, tv('--bt-a')); grad.addColorStop(0.7, tv('--bt-b')); grad.addColorStop(1, tv('--bt-c')); }
    else if (dark()) { grad.addColorStop(0, '#272e4a'); grad.addColorStop(0.7, '#1d2340'); grad.addColorStop(1, '#171c33'); }
    else { grad.addColorStop(0, '#fdfdff'); grad.addColorStop(0.7, '#f0f1f8'); grad.addColorStop(1, '#e9ebf4'); }
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    const hex = { blue: '47,109,246', red: '227,61,82', yellow: '240,180,41', green: '33,163,90', neutral: '33,192,122' };
    for (const b of bands) {
      const rgb = b.finish ? '33,192,122' : hex[b.c];
      const [x0, y0, x1, y1] = b.side === 'top' ? [0, b.y, 0, b.y + b.h] : b.side === 'bottom' ? [0, b.y + b.h, 0, b.y]
        : b.side === 'left' ? [b.x, 0, b.x + b.w, 0] : [b.x + b.w, 0, b.x, 0];
      const lg = g.createLinearGradient(x0, y0, x1, y1);
      lg.addColorStop(0, `rgba(${rgb},.32)`); lg.addColorStop(0.65, `rgba(${rgb},.10)`); lg.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = lg; g.fillRect(b.x, b.y, b.w, b.h);
      g.fillStyle = `rgba(${rgb},.9)`;   // the bright bar on the board edge
      if (b.side === 'top') g.fillRect(b.x, b.y, b.w, 3);
      else if (b.side === 'bottom') g.fillRect(b.x, b.y + b.h - 3, b.w, 3);
      else if (b.side === 'left') g.fillRect(b.x, b.y, 3, b.h);
      else g.fillRect(b.x + b.w - 3, b.y, 3, b.h);
    }
    g.fillStyle = (boardTheme() && tv('--bt-line')) || (dark() ? 'rgba(185,200,235,.17)' : 'rgba(95,115,165,.30)');
    for (const l of lines) g.fillRect(l.x, l.y, l.w, l.h);
    g.strokeStyle = 'rgba(255,201,60,.85)'; g.lineWidth = 2;
    for (const c of goals) g.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
    topTex.needsUpdate = true;
  }

  function sync() {
    const w = board.offsetWidth, h = board.offsetHeight;
    if (!w || !h) return false;
    if (w !== W || h !== H) {
      W = w; H = h;
      slab.scale.set(W + 22, 14, H + 22); slab.position.set(0, -7.05, 0);
      top.scale.set(W, H, 1); top.position.y = 0.02;
      const s = Math.max(W, H);
      sun.position.set(-s * 0.55, s * 1.25, s * 0.35);
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: s * 4 });
      sun.shadow.camera.updateProjectionMatrix();
    }
    slabMat.color.set((boardTheme() && tv('--bt-bezel')) || (dark() ? 0x2c3349 : 0xc9d2e2));
    drawTop();

    // walls: blocks standing on the board, as tall as a pawn is wide
    const walls = [...board.querySelectorAll('.wall')];
    const wallH = Math.max(10, Math.round(W / 26));
    while (wallGroup.children.length < walls.length) {
      const m = new THREE.Mesh(box, mats.neutral); m.castShadow = true; m.receiveShadow = true; wallGroup.add(m);
    }
    wallGroup.children.forEach((m, i) => {
      const el = walls[i];
      m.visible = Boolean(el);
      if (!el) return;
      const r = local(el);
      const [x, z] = toWorld(r.x + r.w / 2, r.y + r.h / 2);
      m.scale.set(Math.max(2, r.w), wallH, Math.max(2, r.h));
      m.position.set(x, wallH / 2, z);
      const preview = el.classList.contains('preview');
      const key = preview ? (el.classList.contains('preview-bad') ? 'bad' : 'ok:' + colorOf(el)) : colorOf(el);
      m.material = key === 'bad' ? mat('bad', { color: 0xc3c8d6, transparent: true, opacity: 0.55, roughness: 0.6 })
        : key.startsWith('ok:') ? mat(key, { color: COLORS[key.slice(3)], transparent: true, opacity: 0.6, roughness: 0.35 })
        : mat(key, { color: COLORS[key], roughness: 0.35, metalness: 0.08 });
    });

    // pawns: balls resting on the board, at the DOM pawn's animated place
    const pawns = [...board.querySelectorAll('.pawn')];
    while (pawnGroup.children.length < pawns.length) {
      const g = new THREE.Group();
      const s = new THREE.Mesh(ball, mats.neutral); s.castShadow = true;
      const rg = new THREE.Mesh(ring, mat('ring', { color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
      rg.rotation.x = Math.PI / 2;
      g.add(s, rg); pawnGroup.add(g);
    }
    pawnGroup.children.forEach((g, i) => {
      const el = pawns[i];
      g.visible = Boolean(el) && getComputedStyle(el).display !== 'none';
      if (!g.visible) return;
      const r = local(el);
      const rad = r.w / 2;
      const [x, z] = toWorld(r.x + rad, r.y + r.h / 2);
      g.position.set(x, 0, z);
      const [s, rg] = g.children;
      s.scale.setScalar(rad); s.position.y = rad;
      // the piece theme: how the ball's surface takes the light
      const pt = pieceTheme();
      const look = { matte: { roughness: 0.85, metalness: 0 }, glass: { roughness: 0.05, metalness: 0, transparent: true, opacity: 0.72 },
        metal: { roughness: 0.18, metalness: 0.85 }, gem: { roughness: 0.04, metalness: 0.35, flatShading: true } }[pt] || { roughness: 0.22, metalness: 0.1 };
      s.material = mat('pawn:' + colorOf(el) + ':' + pt, { color: COLORS[colorOf(el)], ...look });
      s.geometry = pt === 'gem' ? gemGeo : ball;
      rg.visible = el.classList.contains('glow');      // whose move it is
      rg.scale.setScalar(rad * 1.25); rg.position.y = 1.5;
    });

    // legal moves: small balls of your colour on the squares you can step to
    const legal = [...board.querySelectorAll('.cell.legal')];
    const myColor = ['blue', 'red', 'yellow', 'green'].find(c => board.classList.contains('my-' + c)) || 'blue';
    while (dotGroup.children.length < legal.length) dotGroup.add(new THREE.Mesh(ball, mats.neutral));
    dotGroup.children.forEach((d, i) => {
      const el = legal[i];
      d.visible = Boolean(el);
      if (!el) return;
      const r = local(el);
      const rad = r.w * 0.17;
      const [x, z] = toWorld(r.x + r.w / 2, r.y + r.h / 2);
      d.position.set(x, rad, z); d.scale.setScalar(rad);
      d.material = mat('dot:' + myColor, { color: COLORS[myColor], roughness: 0.3, transparent: true, opacity: 0.85 });
    });
    return true;
  }

  function placeCamera() {
    const v = getView();
    const rect = wrap.getBoundingClientRect();
    const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
    const px = Math.min(window.devicePixelRatio || 1, 2.5);
    if (canvas.width !== Math.round(cw * px) || canvas.height !== Math.round(ch * px)) {
      renderer.setSize(cw, ch, false);
    }
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    pivot.rotation.y = -v.spin * Math.PI / 180;
    pivot.rotation.x = -(90 - v.tilt) * Math.PI / 180;
    // far enough to fit the board (its diagonal) across the narrower side
    const span = Math.hypot(W + 22, H + 22) * 1.02;
    const fovH = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
    const fit = Math.min(camera.fov * Math.PI / 180, fovH);
    const dist = (span / 2) / Math.tan(fit / 2) / (v.zoom || 1);
    camera.position.set(0, 0, dist);
    camera.lookAt(pivot.position);
  }

  /* ---- touch and mouse: turn, tilt, zoom, tap ---- */
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function boardPoint(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    pivot.updateMatrixWorld(true);
    ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return { x: -1e6, y: -1e6 };
    return { x: hit.x + W / 2, y: hit.z + H / 2 };
  }

  const pts = new Map();
  let gesture = null;
  const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener('pointerdown', (e) => {
    if (isDraggingWall()) return;
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = getView();
    gesture = pts.size === 2 ? { kind: 'pinch', gap: gap(), zoom: v.zoom || 1 }
      : { kind: 'tap', x: e.clientX, y: e.clientY, spin: v.spin, tilt: v.tilt };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.kind === 'pinch' && pts.size === 2) {
      setView({ zoom: Math.max(0.6, Math.min(2.6, gesture.zoom * gap() / gesture.gap)) });
      return;
    }
    if (gesture.kind === 'pinch') return;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (gesture.kind === 'tap' && Math.hypot(dx, dy) < 12) return;
    gesture.kind = 'turn';
    setView({ spin: gesture.spin - dx * 0.4, tilt: Math.max(0, Math.min(74, gesture.tilt - dy * 0.3)) });
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (gesture?.kind === 'tap' && pts.size === 0) {
      const p = boardPoint(e.clientX, e.clientY);
      onTap(p.x, p.y);
    }
    if (pts.size === 0) { if (gesture && gesture.kind !== 'tap') saveView(); gesture = null; }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); if (!pts.size) gesture = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = getView();
    setView({ zoom: Math.max(0.6, Math.min(2.6, (v.zoom || 1) * Math.exp(-e.deltaY * 0.0015))) });
    saveView();
  }, { passive: false });

  let raf = 0, alive = true;
  const frame = () => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (!canvas.isConnected || !wrap.offsetWidth) return;
    if (!sync()) return;
    placeCamera();
    renderer.render(scene, camera);
  };
  frame();

  return {
    boardPoint,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      renderer.dispose();
      canvas.remove();
    },
  };
}
