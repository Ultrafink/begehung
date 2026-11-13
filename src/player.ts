import * as THREE from 'three';

const EYE = 1.65;        // eye height above floor (m)
const RADIUS = 0.28;     // body radius (m)
const STEP = 0.42;       // max step-up (stairs, thresholds)
const WALK = 1.6;        // m/s
const RUN = 3.6;         // m/s
const GRAVITY = 9.81;

export class Player {
  feet = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  private vy = 0;
  private keys = new Set<string>();
  /** -1..1 from on-screen buttons: x = strafe, y = forward */
  touchMove = new THREE.Vector2();
  private ray = new THREE.Raycaster();
  private spawn = new THREE.Vector3();
  private spawnYaw = 0;

  constructor(private camera: THREE.PerspectiveCamera, private colliders: THREE.Mesh[]) {
    this.ray.firstHitOnly = true;
    addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  place(feet: THREE.Vector3, lookAt: THREE.Vector3) {
    this.feet.copy(feet);
    const d = lookAt.clone().sub(feet.clone().setY(feet.y + EYE));
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = 0;
    this.vy = 0;
    this.spawn.copy(feet);
    this.spawnYaw = this.yaw;
    this.syncCamera();
  }

  look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.45, 1.45);
  }

  update(dt: number) {
    // --- desired horizontal motion in view space
    let f = 0, s = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
    f += this.touchMove.y;
    s += this.touchMove.x;
    if (k.has('KeyQ')) this.yaw += 1.8 * dt;
    if (k.has('KeyE')) this.yaw -= 1.8 * dt;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = fwd.multiplyScalar(f * speed * dt).addScaledVector(right, s * speed * dt);

    // --- walls: try full move, then slide along each axis
    if (move.lengthSq() > 0) {
      if (!this.tryMove(move)) {
        this.tryMove(new THREE.Vector3(move.x, 0, 0));
        this.tryMove(new THREE.Vector3(0, 0, move.z));
      }
    }

    // --- floor, stairs, gravity
    const ground = this.groundBelow();
    if (ground !== null && ground >= this.feet.y - 0.05 && ground <= this.feet.y + STEP) {
      // smooth step-up on stairs
      this.feet.y = ground > this.feet.y ? THREE.MathUtils.damp(this.feet.y, ground, 18, dt) : ground;
      this.vy = 0;
    } else {
      this.vy -= GRAVITY * dt;
      this.feet.y += this.vy * dt;
      if (ground !== null && this.feet.y <= ground) { this.feet.y = ground; this.vy = 0; }
    }
    if (this.feet.y < this.spawn.y - 60) this.place(this.spawn, this.spawn.clone().add(new THREE.Vector3(-Math.sin(this.spawnYaw), EYE, -Math.cos(this.spawnYaw))));

    this.syncCamera();
  }

  private tryMove(delta: THREE.Vector3): boolean {
    const dist = delta.length();
    if (dist < 1e-6) return true;
    const dir = delta.clone().divideScalar(dist);
    // probe at knee, chest and head height (knee probe sits above the step height)
    for (const h of [STEP + 0.05, 1.0, 1.55]) {
      this.ray.set(new THREE.Vector3(this.feet.x, this.feet.y + h, this.feet.z), dir);
      this.ray.far = dist + RADIUS;
      if (this.ray.intersectObjects(this.colliders, false).length) return false;
    }
    this.feet.add(delta);
    return true;
  }

  private groundBelow(): number | null {
    this.ray.set(new THREE.Vector3(this.feet.x, this.feet.y + STEP, this.feet.z), new THREE.Vector3(0, -1, 0));
    this.ray.far = 200;
    const h = this.ray.intersectObjects(this.colliders, false)[0];
    return h ? h.point.y : null;
  }

  private syncCamera() {
    this.camera.position.set(this.feet.x, this.feet.y + EYE, this.feet.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
