#!/usr/bin/env node
/**
 * 还原应用真正提交给 ComfyUI 的 H3 prompt（走 applyH3RefsToApi 本体，不复制逻辑）。
 * 用法: node tools/h3_render_prompt.js <video_generation_id> [--raw]
 *   --raw  只打印数据库里存的那份（未注入）
 */
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const db = new Database(path.join(ROOT, 'data', 'drama_generator.db'), { readonly: true, fileMustExist: true });
const { applyH3RefsToApi } = require(path.join(ROOT, 'src', 'services', 'comfyuiClient.js'));

const id = Number(process.argv[2]);
const raw = process.argv.includes('--raw');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : null;
if (!id) { console.error('用法: node tools/h3_render_prompt.js <video_generation_id> [--raw]'); process.exit(2); }

const gen = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
if (!gen) { console.error('没有这条记录: ' + id); process.exit(2); }
const sb = db.prepare('SELECT id, storyboard_number, dialogue, narration FROM storyboards WHERE id = ?').get(gen.storyboard_id);

let refs = [];
try { refs = gen.reference_image_urls ? JSON.parse(gen.reference_image_urls) : []; } catch (_) {}
let audios = [];
try { audios = gen.reference_audio_urls ? JSON.parse(gen.reference_audio_urls) : []; } catch (_) {}

console.log(`vg${id} storyboard #${sb ? sb.storyboard_number : '?'} duration=${gen.duration} refs=${refs.length} audios=${audios.length}`);
if (raw) { console.log('===== 库里存的（未注入）=====\n' + gen.prompt); process.exit(0); }

const apiPrompt = { '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } };
const refImages = refs.map((r, i) => `ref_${i}_${(r.url || '').split('/').pop()}`);
const labels = refs.map((r) => r.type || '');
const log = { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) };

const header = applyH3RefsToApi(
  apiPrompt, refImages, labels, gen.prompt || '', [], [], ['旁白'], Number(gen.duration) || 11, log, null
);
console.log('===== 返回的说明头 =====');
console.log(header === '' ? '(空：六段结构跳过自动说明头)' : header);
if (OUT) { require('fs').writeFileSync(OUT, apiPrompt['136'].inputs.prompt); console.log('已写出: ' + OUT); }
console.log('===== 实际提交给模型的 prompt =====');
console.log(OUT ? '(见文件)' : apiPrompt['136'].inputs.prompt);
console.log('===== 统计 =====');
const p = String(apiPrompt['136'].inputs.prompt || '');
const cnt = (re) => (p.match(re) || []).length;
console.log(`长度 ${p.length} | <Picture N> ${cnt(/<Picture \d+>/g)} | @图片N ${cnt(/@图片\d+/g)} | <Audio N> ${cnt(/<Audio \d+>/g)} | <d> ${cnt(/<d>/g)} </d> ${cnt(/<\/d>/g)} | 中文占比 ${(cnt(/[\u4e00-\u9fa5]/g) / p.length).toFixed(2)}`);
