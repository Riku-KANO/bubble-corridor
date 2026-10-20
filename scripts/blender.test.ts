// S-17 Blender のパイプライン（親が作成。実装担当は変更しない）
// Blender をヘッドレスで起動するので遅い（scripts/check.sh --quick では SKIP_BLENDER=1 で省く）。
// 単体で回す: `pnpm exec vitest run scripts/blender.test.ts`
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Cue } from '../src/contracts/events';
import type { RideData } from '../src/contracts/ride';
import { findBlender, runBlender } from './blender';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(REPO, 'blender/scripts');
const BLENDER = process.env.SKIP_BLENDER ? null : findBlender();
const T = 180_000;

/** 合成のレール: 水平に大きく曲がり、上下にも動く。three.js の向き（Y が上）、1m 間隔 */
function fixtureRide(): RideData {
  const raw: [number, number, number][] = [];
  for (let u = 0; u <= 700; u += 0.05) raw.push([40 * Math.sin(u / 60), 3 * Math.sin(u / 45) + 2, -0.8 * u + 30 * Math.cos(u / 80)]);
  const points: [number, number, number][] = [raw[0]];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    acc += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (acc >= 1) {
      points.push(b);
      acc -= 1;
    }
  }
  const length = points.length - 1;
  const timeline: { t: number; s: number }[] = [];
  for (let t = 0; t <= 780; t += 0.5) {
    const x = t / 780;
    timeline.push({ t, s: length * (x * x * (3 - 2 * x)) });
  }
  const ids = ['platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn', 'departure'] as const;
  const cuts = [0, 0.08, 0.27, 0.46, 0.62, 0.85, 0.96, 1].map((f) => Math.round(f * length));
  return {
    version: 1,
    duration: 780,
    rail: { spacing: 1, points },
    timeline,
    gentleY: points.map((p) => 2 + (p[1] - 2) * 0.5),
    sections: ids.map((id, i) => ({ id, s0: cuts[i], s1: cuts[i + 1] })),
  };
}

const CUES: Cue[] = [
  { id: 'ride.start@0', name: 'ride.start', t: 0, bar: 0, section: 'platform' },
  { id: 'hint.touch@6', name: 'hint.touch', t: 20, bar: 6, section: 'platform' },
  { id: 'membrane@18', name: 'membrane', t: 60, bar: 18, section: 'greenhouse', data: { to: 'greenhouse' } },
  { id: 'lure@47.1', name: 'lure', t: 157, bar: 47.1, section: 'greenhouse', data: { target: 'greenhouse.bloom' } },
  { id: 'greenhouse.bloom@48', name: 'greenhouse.bloom', t: 160, bar: 48, section: 'greenhouse' },
  { id: 'photo.capture@48', name: 'photo.capture', t: 160, bar: 48, section: 'greenhouse', data: { shot: 'bloom' } },
  { id: 'greenhouse.dewfall@49', name: 'greenhouse.dewfall', t: 163 + 1 / 3, bar: 49, section: 'greenhouse' },
  { id: 'ride.end@234', name: 'ride.end', t: 780, bar: 234, section: 'departure' },
];

let dir = '';
const runOk = (script: string, args: string[], blend?: string) => {
  const r = runBlender(join(SCRIPTS, script), args, { blend, timeoutMs: T });
  expect(r.status, `${script} が失敗:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBe(0);
  return r;
};

/** 一時の Python を書いて走らせ、RESULT: の行の JSON を返す */
function query(body: string, blend?: string): Record<string, unknown> {
  const file = join(dir, `q-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, `import sys, json\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport bpy\n${body}\n`);
  const r = runBlender(file, [], { blend, timeoutMs: T });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  expect(line, `結果がない:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBeDefined();
  return JSON.parse(line!.slice('RESULT:'.length)) as Record<string, unknown>;
}

const ride = fixtureRide();

describe.skipIf(!BLENDER)('Blender のパイプライン', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'utakata-blender-'));
    writeFileSync(join(dir, 'rail.json'), JSON.stringify(ride));
    writeFileSync(join(dir, 'cues.json'), JSON.stringify(CUES));
    runOk('previz.py', ['--rail', join(dir, 'rail.json'), '--cues', join(dir, 'cues.json'), '--out', join(dir, 'previz.blend')]);
  }, T);

  describe('BLD-1 プレビズの組み立て', () => {
    it('30fps・13分のタイムライン、レールのカーブ、部屋ごとのコレクション、キューのマーカー', () => {
      const r = query(
        `sc = bpy.context.scene
print('RESULT:' + json.dumps({
  'fps': sc.render.fps / sc.render.fps_base, 'start': sc.frame_start, 'end': sc.frame_end,
  'rail': bpy.data.objects.get('Rail').type if bpy.data.objects.get('Rail') else None,
  'collections': [c.name for c in bpy.data.collections],
  'markers': sorted([[m.name, m.frame] for m in sc.timeline_markers], key=lambda x: (x[1], x[0])),
}))`,
        join(dir, 'previz.blend'),
      );
      expect(r.fps).toBe(30);
      expect(r.start).toBe(0);
      expect(r.end).toBe(780 * 30);
      expect(r.rail).toBe('CURVE');
      expect(r.collections).toEqual(expect.arrayContaining(['platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn']));
      const frames = (r.markers as [string, number][]).map((m) => m[1]).sort((a, b) => a - b);
      expect(frames).toEqual(CUES.map((c) => Math.round(c.t * 30)).sort((a, b) => a - b));
    });

    it('座席のカメラ（視野角 75°）はゴンドラに付いて、時刻表どおりにレールを進む', () => {
      const ts = [0, 100, 400, 779];
      const r = query(
        `import math
sc = bpy.context.scene
cam = bpy.data.objects['SeatCamera']; g = bpy.data.objects['Gondola']
chain = []; o = cam
while o: chain.append(o.name); o = o.parent
cd = cam.data
vfov = cd.angle_y if cd.sensor_fit == 'VERTICAL' else 2 * math.atan(math.tan(cd.angle_x / 2) * sc.render.resolution_y / sc.render.resolution_x)
locs = []
for t in ${JSON.stringify(ts)}:
  sc.frame_set(int(round(t * 30)))
  locs.append(list(g.matrix_world.translation))
print('RESULT:' + json.dumps({'chain': chain, 'vfov': math.degrees(vfov), 'locs': locs}))`,
        join(dir, 'previz.blend'),
      );
      expect(r.chain).toContain('Gondola');
      expect(r.vfov as number).toBeCloseTo(75, 0);
      const locs = r.locs as number[][];
      ts.forEach((t, i) => {
        // 時刻表の s(t) → レールの点（three.js の Y 上）→ Blender（Z 上: x, -z, y）
        const tl = ride.timeline;
        const k = tl.findIndex((e) => e.t >= t);
        const s = k <= 0 ? tl[0].s : tl[k - 1].s + ((tl[k].s - tl[k - 1].s) * (t - tl[k - 1].t)) / (tl[k].t - tl[k - 1].t);
        const j = Math.min(ride.rail.points.length - 2, Math.floor(s));
        const a = ride.rail.points[j];
        const b = ride.rail.points[j + 1];
        const f = s - j;
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        const expected = [p[0], -p[2], p[1]];
        const d = Math.hypot(locs[i][0] - expected[0], locs[i][1] - expected[1], locs[i][2] - expected[2]);
        expect(d, `t=${t} のゴンドラの位置`).toBeLessThan(0.1);
      });
    });
  });

  describe('BLD-2 書き出し（往復）', () => {
    let out: RideData;
    let cues: Cue[];
    beforeAll(() => {
      runOk('export_ride.py', ['--out-dir', join(dir, 'out')], join(dir, 'previz.blend'));
      out = JSON.parse(readFileSync(join(dir, 'out/rail.json'), 'utf8')) as RideData;
      cues = JSON.parse(readFileSync(join(dir, 'out/cues.json'), 'utf8')) as Cue[];
    }, T);

    it('形と長さ: 版、乗車時間、点の数（±2%）、1m 間隔', () => {
      expect(out.version).toBe(1);
      expect(out.duration).toBeCloseTo(780, 6);
      expect(out.rail.spacing).toBe(1);
      expect(Math.abs(out.rail.points.length - ride.rail.points.length) / ride.rail.points.length).toBeLessThan(0.02);
    });

    it('レールの点は元の点から 5cm 以内', () => {
      for (let i = 0; i < ride.rail.points.length; i += 7) {
        const p = ride.rail.points[i];
        let best = Infinity;
        const lo = Math.max(0, i - 20);
        const hi = Math.min(out.rail.points.length, i + 20);
        for (let j = lo; j < hi; j++) {
          const q = out.rail.points[j];
          best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
        expect(best, `点 ${i}`).toBeLessThan(0.05);
      }
    });

    it('時刻表は 10cm 以内、区間の範囲は 50cm 以内、穏やかの高さも残る', () => {
      const sAt = (d: RideData, t: number) => {
        const tl = d.timeline;
        const k = tl.findIndex((e) => e.t >= t);
        if (k <= 0) return tl[0].s;
        return tl[k - 1].s + ((tl[k].s - tl[k - 1].s) * (t - tl[k - 1].t)) / (tl[k].t - tl[k - 1].t);
      };
      for (let t = 0; t <= 780; t += 13) expect(Math.abs(sAt(out, t) - sAt(ride, t)), `t=${t}`).toBeLessThan(0.1);
      expect(out.sections.map((s) => s.id)).toEqual(ride.sections.map((s) => s.id));
      out.sections.forEach((s, i) => {
        expect(Math.abs(s.s0 - ride.sections[i].s0)).toBeLessThan(0.5);
        expect(Math.abs(s.s1 - ride.sections[i].s1)).toBeLessThan(0.5);
      });
      expect(out.gentleY?.length).toBe(out.rail.points.length);
      for (let i = 0; i < out.rail.points.length; i += 11) expect(Math.abs(out.gentleY![i] - ride.gentleY![Math.min(i, ride.gentleY!.length - 1)])).toBeLessThan(0.1);
    });

    it('マーカーから書き出したキューは元と同じ（名前・時刻・小節・区間・data）', () => {
      const key = (c: Cue) => c.id;
      const a = [...cues].sort((x, y) => key(x).localeCompare(key(y)));
      const b = [...CUES].sort((x, y) => key(x).localeCompare(key(y)));
      expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
      a.forEach((c, i) => {
        expect(c.name).toBe(b[i].name);
        expect(c.t).toBeCloseTo(b[i].t, 6);
        expect(c.bar).toBeCloseTo(b[i].bar, 6);
        expect(c.section).toBe(b[i].section);
        expect(c.data ?? null).toEqual(b[i].data ?? null);
      });
      for (let i = 1; i < cues.length; i++) expect(cues[i].t).toBeGreaterThanOrEqual(cues[i - 1].t);
    });
  });

  describe('BLD-3 通しの動画（静止画）', () => {
    it('指定の時刻の静止画を Eevee で書き出す', () => {
      runOk('render_previz.py', ['--out', join(dir, 'stills'), '--stills', '10,400', '--size', '320x180'], join(dir, 'previz.blend'));
      const pngs = readdirSync(join(dir, 'stills')).filter((f) => f.endsWith('.png'));
      expect(pngs).toHaveLength(2);
      for (const f of pngs) expect(statSync(join(dir, 'stills', f)).size).toBeGreaterThan(1000);
    });
  });

  describe('BLD-4 見えない面の削除', () => {
    it('レールから一度も見えない面を消し、見える面は残し、前後の三角形の数を返す', () => {
      const r = query(`from common.visibility import cull_hidden
bpy.ops.wm.read_factory_settings(use_empty=True)
def cube(name, loc, size):
    bpy.ops.mesh.primitive_cube_add(size=size, location=loc); o = bpy.context.object; o.name = name; return o
A = cube('a', (10, 5, 1.5), 1)          # レールの横に見える
W = cube('w', (10, 10, 2), 1); W.scale = (20, 0.2, 5)  # 壁
B = cube('b', (10, 15, 1.5), 1)         # 壁の向こう
C = cube('c', (-12, 0, 1.5), 1)         # 出発点の真後ろ（左右 ±120° の外）
bpy.context.view_layer.update()
rail = [(x * 0.5, 0, 1.5) for x in range(41)]  # Blender の向き（Z 上）、+X へ進む
rep = cull_hidden([A, W, B, C], rail, yaw_deg=120, pitch_deg=60, head_radius=0.5)
alive = {o.name: (len(o.data.polygons) if o.name in bpy.data.objects else 0) for o in [A, W, B, C] if o.name in bpy.data.objects}
print('RESULT:' + json.dumps({'report': rep, 'polys': {n: (len(bpy.data.objects[n].data.polygons) if n in bpy.data.objects else 0) for n in ['a', 'w', 'b', 'c']}}))`);
      const polys = r.polys as Record<string, number>;
      const report = r.report as { before_tris: number; after_tris: number };
      expect(polys.b).toBe(0);
      expect(polys.c).toBe(0);
      expect(polys.a).toBeGreaterThanOrEqual(1);
      expect(polys.a).toBeLessThan(6);
      expect(polys.w).toBeGreaterThanOrEqual(1);
      expect(polys.w).toBeLessThan(6);
      expect(report.after_tris).toBeLessThan(report.before_tris);
    });
  });

  describe('BLD-5 焼き込み', () => {
    it('2つ目の UV（Lightmap）に光と影を焼き、画像を書き出し、場所をカスタムプロパティに残す', () => {
      const out = join(dir, 'lm');
      const r = query(`from common.bake import bake_lightmaps
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=10); plane = bpy.context.object; plane.name = 'test.floor'
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1)); cube = bpy.context.object; cube.name = 'test.block'
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); bpy.context.scene.collection.objects.link(sun); sun.rotation_euler = (0.7, 0.3, 0)
res = bake_lightmaps([plane, cube], ${JSON.stringify(out)}, size=128, samples=8)
img = bpy.data.images.load(res[0]['image']); px = list(img.pixels[:])
lum = [px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1 for i in range(0, len(px), 4)]
mean = sum(lum) / len(lum); var = sum((x - mean) ** 2 for x in lum) / len(lum)
print('RESULT:' + json.dumps({'res': res, 'uv': [u.name for u in plane.data.uv_layers], 'prop': plane.get('lightmap'), 'var': var}))`);
      const res = r.res as { object: string; image: string }[];
      expect(res.length).toBeGreaterThanOrEqual(1);
      for (const x of res) expect(existsSync(x.image)).toBe(true);
      expect(r.uv).toEqual(expect.arrayContaining(['Lightmap']));
      expect((r.uv as string[]).length).toBeGreaterThanOrEqual(2);
      expect(typeof r.prop).toBe('string');
      expect(r.var as number).toBeGreaterThan(1e-4);
    });
  });

  describe('BLD-6 / BLD-7 命名とカスタムプロパティ、glb の書き出し', () => {
    it('命名の検査: 小文字の <部屋>.<部品>[.<番号>] 以外を一覧にする', () => {
      const r = query(`from common.naming import check_names
bpy.ops.wm.read_factory_settings(use_empty=True)
for n in ['greenhouse.leaf.012', 'rain.pillar', 'Cube.001', 'Greenhouse Leaf']:
    o = bpy.data.objects.new(n, None); bpy.context.scene.collection.objects.link(o)
print('RESULT:' + json.dumps({'bad': sorted(check_names(bpy.context.scene.objects))}))`);
      expect(r.bad).toEqual(['Cube.001', 'Greenhouse Leaf']);
    });

    it('カスタムプロパティは extras に入り、Y が上に変わり、画像は埋め込まず、2つ目の UV も書き出す', () => {
      const glb = join(dir, 'room.glb');
      const r = query(`from common.export import export_glb
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(1, 2, 3)); o = bpy.context.object; o.name = 'greenhouse.leaf.012'
o['touch_kind'] = 'leaf'; o['touch_id'] = 'greenhouse/leaf-12'; o['glass'] = 'tinted'; o['role'] = 'leaf'
o.data.uv_layers.new(name='Lightmap')
m = bpy.data.materials.new('greenhouse.glass'); m.use_nodes = True
tex = m.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = bpy.data.images.new('dummy', 8, 8)
m.node_tree.links.new(tex.outputs['Color'], m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
o.data.materials.append(m)
size = export_glb([o], ${JSON.stringify(glb)})
print('RESULT:' + json.dumps({'size': size}))`);
      expect(r.size as number).toBeGreaterThan(0);
      expect(r.size as number).toBeLessThan(15 * 1024 * 1024);
      // glb の JSON の塊を読む（依存を足さない）
      const buf = readFileSync(glb);
      expect(buf.readUInt32LE(0)).toBe(0x46546c67);
      const jsonLen = buf.readUInt32LE(12);
      const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
        nodes: { name: string; translation?: number[]; extras?: Record<string, unknown>; mesh?: number }[];
        meshes: { primitives: { attributes: Record<string, number> }[] }[];
        images?: unknown[];
      };
      const node = gltf.nodes.find((n) => n.name === 'greenhouse.leaf.012')!;
      expect(node.extras).toMatchObject({ touch_kind: 'leaf', touch_id: 'greenhouse/leaf-12', glass: 'tinted', role: 'leaf' });
      expect(node.translation![0]).toBeCloseTo(1, 4);
      expect(node.translation![1]).toBeCloseTo(3, 4);
      expect(node.translation![2]).toBeCloseTo(-2, 4);
      expect(gltf.images ?? []).toEqual([]);
      expect(Object.keys(gltf.meshes[node.mesh!].primitives[0].attributes)).toContain('TEXCOORD_1');
    });
  });

  describe('案1との共有', () => {
    it('blender/scripts/common は版と変更記録を持ち、common の外を import しない', () => {
      const common = join(SCRIPTS, 'common');
      expect(existsSync(join(common, 'VERSION'))).toBe(true);
      expect(readFileSync(join(common, 'CHANGELOG.md'), 'utf8')).toContain(readFileSync(join(common, 'VERSION'), 'utf8').trim());
      for (const f of readdirSync(common).filter((x) => x.endsWith('.py'))) {
        const src = readFileSync(join(common, f), 'utf8');
        expect(src, f).not.toMatch(/^\s*(from|import)\s+(previz|export_ride|render_previz|rooms)\b/m);
      }
    });
  });
});
