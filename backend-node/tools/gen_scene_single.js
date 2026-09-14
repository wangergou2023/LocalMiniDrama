#!/usr/bin/env node
/**
 * 为某部剧的每个场景生成「单幅场景图」（非四宫格），并登记为视频参考图。
 * 全程走本地 ComfyUI（C01 z-image 工作流，1920×1080、8 步），不碰云端接口。
 *
 * 用法：node gen_scene_single.js <drama_id> [--apply]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('/home/wangergou/LocalMiniDrama/backend-node/node_modules/better-sqlite3');
const ROOT = '/home/wangergou/LocalMiniDrama/backend-node';
const sceneService = require(path.join(ROOT, 'src/services/sceneService'));
const { loadConfig } = require(path.join(ROOT, 'src/config'));
const { mergeCfgStyleWithDrama } = require(path.join(ROOT, 'src/utils/dramaStyleMerge'));

const DRAMA_ID = Number(process.argv[2] || 6);
const APPLY = process.argv.includes('--apply');
const WF = '/home/wangergou/LocalMiniDrama/workflows/C图像-Zimage/C01-文生图-Zimage-int8-dualgpu.json';
const HOST = 'http://127.0.0.1:8188';
const COMFY_OUT = '/home/wangergou/ComfyUI/output';
const STORAGE = path.join(ROOT, 'data/storage');
const log = { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a) };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function submit(wf) {
  return new Promise((resolve, reject) => {
    const req = http.request(HOST + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => { try { const j = JSON.parse(b); if (!j.prompt_id) reject(new Error(b)); else resolve(j.prompt_id); } catch (e) { reject(new Error(b)); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ prompt: wf, client_id: 'scene_single' }));
    req.end();
  });
}

(async () => {
  const db = new Database(path.join(ROOT, 'data/drama_generator.db'));
  const drama = db.prepare('SELECT id, title, style, metadata FROM dramas WHERE id = ?').get(DRAMA_ID);
  if (!drama) throw new Error('drama not found');
  const merged = mergeCfgStyleWithDrama(loadConfig(), drama);
  const styleEn = String(merged?.style?.default_style_en || merged?.style?.default_style || '').trim();
  const styleZh = String(merged?.style?.default_style_zh || '').trim();
  console.log('剧:', drama.title, '| styleEn:', styleEn.slice(0, 50), '| styleZh:', styleZh.slice(0, 24));

  const projDir = fs.readdirSync(path.join(STORAGE, 'projects'))
    .find((d) => d.startsWith(String(DRAMA_ID).padStart(4, '0') + '_'));
  if (!projDir) throw new Error('project dir not found for drama ' + DRAMA_ID);
  const relBase = `projects/${projDir}/scenes`;
  const scenes = db.prepare('SELECT * FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(DRAMA_ID);
  console.log('场景数:', scenes.length, '| 项目目录:', projDir, APPLY ? '| 模式: 实跑' : '| 模式: dry-run');

  for (const sc of scenes) {
    const desc = [
      sc.location ? `场景地点：${sc.location}` : '',
      sc.time ? `时间/时段：${sc.time}` : '',
      sc.prompt ? `场景描述：${sc.prompt}` : '',
    ].filter(Boolean).join('\n');
    const prompt = sceneService.buildSceneSingleImagePrompt(desc, styleEn, styleZh);
    if (!APPLY) { console.log(`(dry) scene ${sc.id} ${sc.location} → 单幅提示词 ${prompt.length} 字`); continue; }

    const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
    wf['57:27'].inputs.text = prompt;
    wf['57:3'].inputs.seed = Math.floor(Math.random() * 1e15);
    wf['57:13'].inputs.width = 1920;
    wf['57:13'].inputs.height = 1080;
    wf['9'].inputs.filename_prefix = `scene_single/scene_${sc.id}`;

    const pid = await submit(wf);
    process.stdout.write(`scene ${sc.id} ${sc.location} … `);
    let file = null;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const h = await getJson(`${HOST}/history/${pid}`);
      if (h[pid]) {
        for (const o of Object.values(h[pid].outputs || {})) for (const im of (o.images || [])) file = im;
        break;
      }
    }
    if (!file) { console.log('❌ 超时/无产出'); continue; }
    const src = path.join(COMFY_OUT, file.subfolder || '', file.filename);
    const dstName = `scene_single_${sc.id}.png`;
    fs.mkdirSync(path.join(STORAGE, relBase), { recursive: true });
    fs.copyFileSync(src, path.join(STORAGE, relBase, dstName));
    const rel = `${relBase}/${dstName}`;
    db.prepare('UPDATE scenes SET polished_prompt_single = ?, updated_at = ? WHERE id = ?')
      .run(prompt, new Date().toISOString(), sc.id);
    const r = sceneService.applySingleViewSceneImage(db, log, sc.id, rel);
    console.log('✅', rel, '| 旧图存入 extra_images:', (r.extra_images || []).length);
  }
})();
