// 部屋のシェーダーの先読み（S-29）。部屋は読み込みが終わってから、膜の15秒前に描き始めるまで画面に出ない（描き始めても視野の外の物は
// 描かれない）。その間に、画面の描画と同じ条件で、物ごとにシェーダーとパイプラインを作っておく。
// 作っておかないと、初めて描くフレームで見えている材質すべての組み立てが一度に走り、WebGL2（VR と同じ経路）で 0.5〜2 秒止まる。
//
// 「画面の描画と同じ条件」とは、three r186 が描く物の状態を引く鍵（ADR-0014）。描く文脈ごとに物の状態が別に作られる:
//  - 画面効果を使う間（画面）: 場面は画面効果の scene pass の描画先に、呼び出しの深さ 1 で描かれる。
//    compileAsync は深さ 0 の文脈で組むので、同じ形の描画先を使い、組む間だけ文脈の取り出しに深さ 1 を渡す。
//  - 画面効果を使わない間（低品質・スマートフォン・VR）: renderer.render を直接呼ぶので、compileAsync の既定が同じ文脈になる
//    （描画先が null のときだけ。VR は描いた後も描画先が VR の枠のままなので、組む間だけ null にする）。
//    VR は renderer.xr が提示中のとき、compileAsync が VR のカメラ配列で組む。
//  - 水面の映り込み（reflector）は、場面をもう一度、自分の描画先に（深さ +1 で）描く。部屋の材質から reflector を見つけ、
//    その描画先の形（多重標本の数）の文脈でも組む。映り込みが始まる瞬間（水面が視野に入るとき）に、場面の全部の物が作られるのを防ぐ。
// 隠れた物（見どころで現れる物）も、visible を一時的に立てて組む（現れた瞬間に作らない）。
// 部屋が読み込みの後に差し替える材質（乗り場の水面は、高品質では映り込みの材質から、遠くから見る間は安い材質へ、水門の手前でまた戻す）は、
// 差し替える前の材質も控えておき、両方を組む。
//
// 組むだけでは足りない: WebGL2 の経路（macOS の ANGLE/Metal など）は、プログラムのリンクが終わっても、最初に描くときに描画の状態
// （パイプライン）を GPU 側で作る。初めて訪れる人（シェーダーの保存がない）では、膜で部屋が見え始めるフレームが 0.5〜0.8 秒止まる。
// そこで、組んだ物を小さな描画先に1つずつ実際に描く（描画先と呼び出しの深さは場面の描画と同じ）。1 フレームに 1 つ、間隔を空けて
// GPU 側の作業を散らし、保存のある端末では瞬時に済む。同じ材質・同じ頂点の並びは、一度描けば足りる。WebGPU は組む段階でパイプラインまで作る
// ので描かない（ただし、compileAsync で正しく組めない「透明で両面の材質」の物は、描いて組む）。画面効果を使わない間は、renderer の内部の枠
// （トーンマップ用）と同じ形の小さな描画先に描く。
// VR は描かない（組むだけ）: 両眼のカメラ配列と VR の枠が要り、セッションが始まった直後の WebGL の状態の記録と合わないことがある（IWER で
// drawBuffers の警告）。実機で確かめられるまでは、組むだけにしている。
// 失敗しても体験は止めない（描くときに自分で作られる）。
import * as THREE from 'three/webgpu';

export interface PrewarmEnv {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** 画面効果の scene pass で描くか（画面効果が有効で、VR の提示中でない） */
  fxActive(): boolean;
  /** VR の提示中か */
  xrActive(): boolean;
}

export interface Prewarmer {
  /**
   * 描く文脈が変わった（画面 ↔ VR、画面効果の入り切り）ので、組み済みの記録を捨てて、動いている部屋をもう一度組む。
   * 組み終えたときに resolve
   */
  invalidate(): Promise<void>;
  /**
   * root の下のすべての描く物（いま隠れている物も）のシェーダーを組む。
   * alive が偽になったら打ち切る（部屋が解放された）。canRun が偽の間は新しい一歩を始めない（膜の前後を避ける）。
   * 組み終えたとき（または打ち切ったとき）に resolve。部屋が増えて文脈（水面の映り込み）が増えたときは、先に組んだ部屋の足りない分も組む
   */
  prepare(root: THREE.Object3D, alive: () => boolean, canRun?: () => boolean): Promise<void>;
}

/** 組む作業を主スレッドで続けてよい時間（ms）。これを超えたら次のタスクへ回す */
const SLICE_MS = 3;
/** 先読みを始めてよくなるのを待つ間隔（ms） */
const GATE_POLL_MS = 100;
/** 試しに描いた次の物まで空ける時間（ms）。1 フレームぶん。GPU 側のパイプライン作りを散らす */
const DRAW_GAP_MS = 16;
/** 試しに描くカメラの層。描く物だけをこの層に一時的に入れる（光源も、材質の鍵を同じにするため入れる） */
const WARM_LAYER = 31;

/** 描画の対象になる物（three の _projectObject が列に入れる種類） */
interface Renderable {
  readonly isMesh?: boolean;
  readonly isLine?: boolean;
  readonly isPoints?: boolean;
  readonly isSprite?: boolean;
}

function isRenderable(o: THREE.Object3D): boolean {
  const r = o as unknown as Renderable;
  return r.isMesh === true || r.isLine === true || r.isPoints === true || r.isSprite === true;
}

/**
 * 裏面と表面を2回に分けて描く材質か（透明で両面。three は透明な両面の物を、裏面だけ・表面だけの2回に分けて描く）。
 * compileAsync はこの2回の描き分けのとき材質の side を一時的に変えるが、物の組み立ては非同期で後から走り、そのときには side が
 * 両面に戻っているので、両面用の（描くときと違う）シェーダーが作られ、そのまま使われてしまう（ゴンドラの殻に白いヴェールが載った）。
 * この材質の物は compileAsync で組まず、試しに描く（renderer.render は側面ごとに描き分けて正しく組む）だけにする。
 */
export function isDoublePass(obj: THREE.Object3D): boolean {
  return isDoublePassMaterial((obj as THREE.Mesh).material);
}

function isDoublePassMaterial(material: THREE.Material | THREE.Material[] | undefined): boolean {
  for (const m of Array.isArray(material) ? material : material ? [material] : []) {
    if (m.transparent === true && m.side === THREE.DoubleSide && (m as THREE.Material & { forceSinglePass?: boolean }).forceSinglePass !== true) return true;
  }
  return false;
}

/** three の内部の描画の文脈の入れ物（RenderContexts。get の第3引数が呼び出しの深さ） */
interface RenderContextsLike {
  get(renderTarget: unknown, mrt: unknown, callDepth?: number): unknown;
}

/** 画面効果の scene pass が描く深さ（RenderPipeline の板の描画の中で renderer.render が入れ子になる） */
const SCENE_PASS_CALL_DEPTH = 1;

/** 節点（TSL）の最小の形 */
interface NodeLike {
  readonly isNode?: boolean;
  readonly constructor: { readonly type?: string };
  readonly reflector?: { readonly samples?: number };
  traverse(callback: (node: NodeLike) => void): void;
}

/** 部屋の材質の中の reflector（水面の映り込み）の調べ結果 */
export interface ReflectorScan {
  /** 映り込みの描画先の多重標本の数。reflector は場面をもう一度、HalfFloat・深度つき・この多重標本の描画先に描くので、その形が文脈の鍵になる */
  readonly samples: number[];
  /** reflector を使っている材質（その物を試しに描くと映り込みの描画が走るので、描かない） */
  readonly materials: ReadonlySet<unknown>;
}

export function scanReflectors(root: THREE.Object3D): ReflectorScan {
  const materials: unknown[] = [];
  root.traverse((o) => {
    const material = (o as unknown as { material?: unknown }).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) materials.push(m);
  });
  return scanReflectorMaterials(materials);
}

/** 材質の一覧から reflector を探す（まとめて。単体テストと小さな部屋用。部屋の組む作業は、時間で区切って scanReflectorMaterial を呼ぶ） */
export function scanReflectorMaterials(all: Iterable<unknown>): ReflectorScan {
  const samples = new Set<number>();
  const materials = new Set<unknown>();
  const seen = new Set<unknown>();
  for (const m of all) scanReflectorMaterial(m, samples, materials, seen);
  return { samples: [...samples], materials };
}

/** 材質 1 つの節点の木から reflector を探す。節点の木をたどるので、材質ごとに数百 µs〜1ms かかる */
export function scanReflectorMaterial(m: unknown, samples: Set<number>, materials: Set<unknown>, seen: Set<unknown>): void {
  if (seen.has(m)) return;
  seen.add(m);
  for (const value of Object.values(m as Record<string, unknown>)) {
    const node = value as NodeLike | null;
    if (!node || node.isNode !== true || typeof node.traverse !== 'function') continue;
    node.traverse((n) => {
      if (n.constructor.type !== 'ReflectorNode') return;
      samples.add(n.reflector?.samples ?? 0);
      materials.add(m);
    });
  }
}

/** 組む文脈: 場面の描画、または水面の映り込み（多重標本の数） */
type Context = { readonly key: string; readonly reflectSamples: number | null };
const MAIN: Context = { key: 'main', reflectSamples: null };

interface Job {
  readonly root: THREE.Object3D;
  readonly alive: () => boolean;
  readonly canRun: () => boolean;
  /** 材質を調べて水面の映り込みを見つけたか */
  scanned: boolean;
  reflectSamples: number[];
  mirrorMaterials: ReadonlySet<unknown>;
  /**
   * 読み込み直後の、物ごとの材質。部屋は最初の update や見どころで材質を差し替える（乗り場の水面は、高品質では映り込みの材質で作り、
   * 遠くから見る間は安い材質に替え、水門の手前で戻す）。差し替えたあとの材質だけ組むと、戻したときに初めて組むことになる。
   * 差し替える前に控えておき、そちらも組む（映り込みの調べにも使う）。
   */
  readonly initialMaterials: ReadonlyMap<THREE.Object3D, THREE.Material | THREE.Material[]>;
  /** 組み終えた文脈 */
  readonly done: Set<string>;
}

export function createPrewarmer(env: PrewarmEnv): Prewarmer {
  const { renderer, scene, camera } = env;
  /** scene pass の描画先と同じ形（形式・型・多重標本・深度）の小さな描画先。文脈の鍵が同じになればよいので大きさは要らない */
  let passTarget: THREE.RenderTarget | null = null;
  /** 画面効果を使わない間の、場面の描画先（renderer の内部の枠。トーンマップ用）と同じ形の小さな描画先 */
  let frameTarget: THREE.RenderTarget | null = null;
  /** 水面の映り込みの描画先と同じ形の小さな描画先（多重標本の数ごと） */
  const reflectTargets = new Map<number, THREE.RenderTarget>();

  function scenePassTarget(): THREE.RenderTarget {
    // 形は PassNode と同じ: HalfFloat、深度の画像つき、多重標本は renderer と同じ
    if (passTarget && passTarget.samples === renderer.samples && passTarget.texture.type === renderer.getOutputBufferType()) return passTarget;
    passTarget?.dispose();
    const target = new THREE.RenderTarget(4, 4, { type: renderer.getOutputBufferType() });
    target.depthTexture = new THREE.DepthTexture(4, 4);
    target.samples = renderer.samples;
    passTarget = target;
    return target;
  }

  function directFrameTarget(): THREE.RenderTarget {
    // 形は renderer の内部の枠と同じ: 出力の型、RGBA、深度・ステンシルは renderer、多重標本は renderer
    if (frameTarget && frameTarget.samples === renderer.samples && frameTarget.texture.type === renderer.getOutputBufferType()) return frameTarget;
    frameTarget?.dispose();
    frameTarget = new THREE.RenderTarget(4, 4, {
      type: renderer.getOutputBufferType(),
      depthBuffer: renderer.depth,
      stencilBuffer: renderer.stencil,
      samples: renderer.samples,
    });
    return frameTarget;
  }

  function reflectTarget(samples: number): THREE.RenderTarget {
    let target = reflectTargets.get(samples);
    if (!target) {
      // 形は three の ReflectorNode と同じ: HalfFloat、多重標本の数は reflector の設定
      target = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
      reflectTargets.set(samples, target);
    }
    return target;
  }

  /**
   * draw の同期の部分だけを、指定した文脈の状態にして呼ぶ（続きは元の状態で走る。ADR-0014）。
   * forRender: renderer.render（試しに描く）か、compileAsync（組む）か。画面効果を使わない間の場面の描画は、組むときは描画先 null の
   * 既定がそのまま同じ文脈になるが、描くときは内部の枠と同じ形の描画先を自分で置く
   */
  function inContext<T>(ctx: Context, draw: () => T, forRender = false): T {
    const fx = env.fxActive();
    const main = ctx.reflectSamples === null;
    const prevTarget = renderer.getRenderTarget();
    if (!fx && main && !forRender) {
      // compileAsync は描画先が null のときだけ、内部の枠（トーンマップ用の描画先）を使う。VR は描いた後も描画先が VR の枠に
      // 設定されたままなので、組む間だけ null にして、描くときと同じ内部の枠で組む
      if (prevTarget === null) return draw();
      try {
        renderer.setRenderTarget(null);
        return draw();
      } finally {
        renderer.setRenderTarget(prevTarget);
      }
    }
    const contexts = (renderer as unknown as { _renderContexts?: RenderContextsLike })._renderContexts;
    const original = contexts?.get;
    if (!contexts || typeof original !== 'function') return draw(); // three の内部が変わった: 文脈が合わなくても、組む作業そのものは進める
    // 場面の描画の深さ（scene pass の中は 1、直接は 0）。水面の映り込みはその中でもう一度描くので +1
    const mainDepth = fx ? SCENE_PASS_CALL_DEPTH : 0;
    const depth = main ? mainDepth : mainDepth + 1;
    const prevMRT = renderer.getMRT();
    let patched = false;
    try {
      renderer.setRenderTarget(main ? (fx ? scenePassTarget() : directFrameTarget()) : reflectTarget(ctx.reflectSamples ?? 0));
      renderer.setMRT(null);
      // 深さを渡すのは、画面効果の中と水面の映り込みだけ（直接の場面の描画は、render が自分で深さ 0 を渡す）
      patched = fx || !main;
      if (patched) contexts.get = (renderTarget, mrt) => original.call(contexts, renderTarget, mrt, depth);
      return draw();
    } finally {
      if (patched) contexts.get = original;
      renderer.setMRT(prevMRT);
      renderer.setRenderTarget(prevTarget);
    }
  }

  /** 物 1 つのシェーダーとパイプラインを組む。隠れた物も組むので visible を立て、視錐台の判定を外し、必ず戻す */
  function compileOne(obj: THREE.Object3D, ctx: Context): Promise<void> {
    const visible = obj.visible;
    const culled = obj.frustumCulled;
    obj.visible = true;
    obj.frustumCulled = false;
    try {
      return inContext(ctx, () => renderer.compileAsync(obj, camera, scene));
    } finally {
      obj.visible = visible;
      obj.frustumCulled = culled;
    }
  }

  const afterFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const jobs: Job[] = [];

  /** 動いている部屋の文脈の一覧: 場面の描画と、動いている部屋にある水面の映り込みの描画先の形ごと */
  function contexts(): Context[] {
    const samples = new Set<number>();
    for (const job of jobs) if (job.alive()) for (const s of job.reflectSamples) samples.add(s);
    return [MAIN, ...[...samples].map((s): Context => ({ key: `reflect${s}`, reflectSamples: s }))];
  }

  // ── 試しに描く ──
  const warmCamera = new THREE.PerspectiveCamera();
  warmCamera.layers.set(WARM_LAYER);
  const warmedKeys = new Set<string>();
  const camPos = new THREE.Vector3();

  /**
   * 試しに描くか: VR でない間（上の説明）。WebGL2 は全部の物。WebGPU は、compileAsync で組めない「2回に分けて描く材質」の物だけ
   * （描いて組む。パイプラインの作りは非同期なので、描いた絵は捨ててよい）
   */
  function warmDrawEnabled(obj: THREE.Object3D): boolean {
    if (env.xrActive()) return false;
    return (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true || isDoublePass(obj);
  }

  /** 描画の状態を決める材質と頂点の並びの印。同じ印の物は、一度描けばパイプラインが作られる */
  function drawKey(obj: THREE.Object3D, ctx: Context): string | null {
    const mesh = obj as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return null;
    const material = (Array.isArray(mesh.material) ? mesh.material.map((m) => m.uuid).join('+') : mesh.material?.uuid) ?? '';
    const attributes = Object.keys(geometry.attributes)
      .sort()
      .map((name) => {
        const a = geometry.attributes[name];
        return `${name}${a.itemSize}${a.array.constructor.name}${a.normalized ? 'n' : ''}`;
      })
      .join(',');
    const index = geometry.index ? (geometry.index.array instanceof Uint32Array ? 'x32' : 'x16') : '';
    const flags = `${mesh.type}${(mesh as THREE.InstancedMesh).isInstancedMesh ? 'i' : ''}${(mesh as THREE.SkinnedMesh).isSkinnedMesh ? 's' : ''}`;
    return `${ctx.key}|${material}|${flags}|${attributes}|${index}`;
  }

  /**
   * 物 1 つを、小さな描画先に1回描く（場面の描画と同じ文脈で）。描く物以外は層で除く。親が隠れていても描くよう、
   * 根から物までの visible を立て、根が場面に入っていなければ入れる。終わったら必ず戻す。描いたら true
   */
  function warmDraw(job: Job, obj: THREE.Object3D, ctx: Context): boolean {
    const key = drawKey(obj, ctx);
    if (key === null || warmedKeys.has(key)) return false;
    warmedKeys.add(key);
    const saved: [THREE.Object3D, boolean][] = [];
    for (let p: THREE.Object3D | null = obj; p; p = p.parent) {
      saved.push([p, p.visible]);
      p.visible = true;
      if (p === job.root) break;
    }
    const culled = obj.frustumCulled;
    const layerMask = obj.layers.mask;
    obj.frustumCulled = false;
    obj.layers.enable(WARM_LAYER);
    // 光源は描く物ではないが、カメラの層に入れておく（入れないと、光源のない場面として別の材質ができる）
    const lights: [THREE.Object3D, number][] = [];
    for (const child of scene.children) {
      if ((child as THREE.Light).isLight) {
        lights.push([child, child.layers.mask]);
        child.layers.enable(WARM_LAYER);
      }
    }
    const added = job.root.parent === null;
    if (added) scene.add(job.root);
    try {
      camera.getWorldPosition(camPos);
      warmCamera.position.copy(camPos);
      warmCamera.updateMatrixWorld();
      inContext(ctx, () => renderer.render(scene, warmCamera), true);
      return true;
    } catch {
      return false; // 試しに描くだけなので、失敗は見せない
    } finally {
      if (added) scene.remove(job.root);
      for (const [light, mask] of lights) light.layers.mask = mask;
      obj.layers.mask = layerMask;
      obj.frustumCulled = culled;
      for (const [p, v] of saved) p.visible = v;
    }
  }

  /** 1 つの部屋の1つの文脈を、物ごとに組み、描く。続けられなくなったら（解放された）false */
  async function compileJob(job: Job, ctx: Context): Promise<boolean> {
    const objects: THREE.Object3D[] = [];
    job.root.traverse((o) => {
      if (isRenderable(o)) objects.push(o);
    });
    let sliceStart = performance.now();
    for (const obj of objects) {
      // 膜の前後は、新しい一歩を始めない（始めてよくなるまで待つ）
      while (job.alive() && !job.canRun()) await wait(GATE_POLL_MS);
      if (!job.alive()) return false;
      // 作り済みの物は await で主スレッドを返さないまま終わるので、続けて動かしすぎないよう時間で区切る
      if (performance.now() - sliceStart >= SLICE_MS) {
        await afterFrame();
        sliceStart = performance.now();
        if (!job.alive()) return false;
      }
      try {
        if (!isDoublePass(obj)) await compileOne(obj, ctx);
        // 読み込み直後の材質から差し替えられていれば、そちらも組む（差し替えは同期の部分の間だけ。続きは一覧に沿って進む）
        const first = job.initialMaterials.get(obj);
        const now = (obj as THREE.Mesh).material;
        if (first && first !== now && !isDoublePassMaterial(first)) {
          (obj as THREE.Mesh).material = first;
          let pending: Promise<void>;
          try {
            pending = compileOne(obj, ctx);
          } finally {
            (obj as THREE.Mesh).material = now;
          }
          await pending;
        }
        const material = (obj as THREE.Mesh).material;
        const mirrored = Array.isArray(material) ? material.some((m) => job.mirrorMaterials.has(m)) : job.mirrorMaterials.has(material);
        if (!mirrored && job.alive() && warmDrawEnabled(obj) && warmDraw(job, obj, ctx)) {
          await wait(DRAW_GAP_MS);
          sliceStart = performance.now();
        }
      } catch {
        // 物1つの失敗で残りを止めない（描くときにその物だけ作られる）
      }
    }
    return true;
  }

  async function drain(): Promise<void> {
    await afterFrame(); // 物の一覧を作るのも、フレームの外で
    for (let progressed = true; progressed; ) {
      progressed = false;
      // 組む前に、動いている部屋すべてを調べて文脈を揃える（後から読み込まれた部屋の水面の映り込みも、先の部屋で組む）
      for (const job of jobs) {
        if (job.alive() && !job.scanned) {
          const all: unknown[] = [];
          for (const material of job.initialMaterials.values()) all.push(...(Array.isArray(material) ? material : [material]));
          job.root.traverse((o) => {
            const material = (o as THREE.Mesh).material;
            if (isRenderable(o) && material) all.push(...(Array.isArray(material) ? material : [material]));
          });
          // 節点の木をたどるので、時間で区切る（乗り場で全部まとめると 16ms ほど主スレッドを占める）
          const samples = new Set<number>();
          const mirrors = new Set<unknown>();
          const seen = new Set<unknown>();
          let sliceStart = performance.now();
          for (const m of all) {
            scanReflectorMaterial(m, samples, mirrors, seen);
            if (performance.now() - sliceStart >= SLICE_MS) {
              await afterFrame();
              sliceStart = performance.now();
            }
          }
          job.reflectSamples = [...samples];
          job.mirrorMaterials = mirrors;
          job.scanned = true;
        }
      }
      for (const job of [...jobs]) {
        if (!job.alive()) continue;
        for (const ctx of contexts()) {
          if (job.done.has(ctx.key)) continue;
          if (!(await compileJob(job, ctx))) break;
          job.done.add(ctx.key);
          progressed = true;
        }
      }
    }
    // 解放された部屋の記録を捨てる
    for (let i = jobs.length - 1; i >= 0; i--) if (!jobs[i].alive()) jobs.splice(i, 1);
  }

  /** 同時に1つずつ（組む作業が重なると、同じ文脈の描画先の取り合いになる） */
  let queue: Promise<unknown> = Promise.resolve();

  return {
    invalidate() {
      for (const job of jobs) job.done.clear();
      warmedKeys.clear();
      const run = queue.then(drain).catch(() => undefined);
      queue = run;
      return run;
    },
    prepare(root, alive, canRun = () => true) {
      // 読み込み直後の材質を、ここで同期に控える（部屋が最初の update で差し替える前）。調べるのは組む作業の中
      const initialMaterials = new Map<THREE.Object3D, THREE.Material | THREE.Material[]>();
      root.traverse((o) => {
        const material = (o as THREE.Mesh).material;
        if (isRenderable(o) && material) initialMaterials.set(o, material);
      });
      jobs.push({ root, alive, canRun, scanned: false, reflectSamples: [], mirrorMaterials: new Set(), initialMaterials, done: new Set() });
      const run = queue.then(drain).catch(() => undefined);
      queue = run;
      return run;
    },
  };
}
