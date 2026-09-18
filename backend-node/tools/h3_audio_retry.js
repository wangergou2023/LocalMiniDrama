#!/usr/bin/env node
/**
 * H3 片段人声质检 + 自动重生成。
 *
 * 背景：MiniMax H3 的原生语音是随机崩坏的（社区公认约五成，与单/双卡、turbo LoRA、
 * 提示词写法均无关），表现为台词中间插入一段听不懂的嘟囔。唯一可靠的办法是
 * 「生成 → 听写质检 → 不合格换 seed 重来」，本脚本就是这条回路。
 *
 * 质检走本地 whisper-small（ComfyUI venv 里已装），不联网、不调任何云厂商。
 * 重生成走本机后端的 POST /api/v1/videos，和界面点「生成视频」等价，结果照常入库。
 * 注意：ComfyUI 路径的 seed 由后端每次随机，所以重试天然就是换种子重来。
 *
 * 用法:
 *   node tools/h3_audio_retry.js --episode 23
 *   node tools/h3_audio_retry.js --episode 23 --shots 2,3 --max-tries 6
 *   node tools/h3_audio_retry.js --episode 23 --check-only     # 只质检，不重生成
 *   node tools/h3_audio_retry.js --episode 23 --dry-run        # 只打印将要提交的内容
 *
 * 环境变量:
 *   H3_QC_PYTHON  跑质检的 python（默认 ~/ComfyUI/.venv/bin/python）
 *   H3_API_BASE   后端地址（默认 http://127.0.0.1:5679/api/v1）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'drama_generator.db');
const STORAGE = path.join(ROOT, 'data', 'storage');
const QC_SCRIPT = path.join(__dirname, 'audio_qc.py');
const QC_PYTHON = process.env.H3_QC_PYTHON || path.join(process.env.HOME || '', 'ComfyUI', '.venv', 'bin', 'python');
const API_BASE = process.env.H3_API_BASE || 'http://127.0.0.1:5679/api/v1';
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const opts = { episode: null, shots: null, sbs: null, maxTries: 4, checkOnly: false, dryRun: false, firstGen: false, promptFrom: 'db' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--episode') opts.episode = Number(argv[++i]);
    else if (a === '--shots') opts.shots = String(argv[++i]).split(',').map(Number).filter(Boolean);
    else if (a === '--max-tries') opts.maxTries = Number(argv[++i]);
    else if (a === '--check-only') opts.checkOnly = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--first-gen') opts.firstGen = true;
    else if (a.startsWith('--sbs=')) opts.sbs = a.slice(6).split(',').map(Number).filter(Boolean);
    else if (a.startsWith('--prompt-from=')) opts.promptFrom = a.slice(14);
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '')); process.exit(0); }
  }
  if (!opts.episode) { console.error('缺少 --episode <集 id>'); process.exit(2); }
  return opts;
}

/**
 * 从未生成过的分镜：自己拼出首次生成参数。
 * 引用图顺序照应用：先场景（storyboards.scene_id → scenes），再道具（storyboard_props → props），
 * 标签用应用那套 wording（'scene background for "…"' / 'prop appearance for "…"'），
 * 这样 H3 的 <Picture i> 编号与 ust 里的对应关系不变。
 */
function buildFirstGenBody(db, sb, dramaId) {
  const refs = [];
  const labels = [];
  if (sb.scene_id) {
    const sc = db.prepare('SELECT location, time, local_path, image_url FROM scenes WHERE id = ?').get(sb.scene_id);
    if (sc && (sc.local_path || sc.image_url)) {
      refs.push(sc.local_path || sc.image_url);
      labels.push('scene background' + (sc.location ? ` for "${sc.location}"` : ''));
    }
  }
  const props = db.prepare(
    `SELECT p.name, p.local_path, p.image_url FROM storyboard_props sp JOIN props p ON p.id = sp.prop_id
      WHERE sp.storyboard_id = ? ORDER BY p.id`
  ).all(sb.id);
  for (const pr of props) {
    if (refs.length >= 9) break;
    if (!pr.local_path && !pr.image_url) continue;
    refs.push(pr.local_path || pr.image_url);
    labels.push('prop appearance for "' + (pr.name || '物品') + '"');
  }
  const latest = db.prepare('SELECT aspect_ratio, resolution, watermark FROM video_generations WHERE drama_id = ? ORDER BY id DESC LIMIT 1').get(dramaId);
  return {
    drama_id: dramaId,
    storyboard_id: sb.id,
    prompt: sb.universal_segment_text || sb.video_prompt || '',
    duration: sb.duration || 11,
    aspect_ratio: latest?.aspect_ratio || '16:9',
    resolution: latest?.resolution || '720p',
    watermark: latest?.watermark ? 1 : 0,
    reference_image_urls: refs,
    reference_labels: labels,
    reference_audio_urls: [],
  };
}

/** 从 ust 里取出该镜应该被念出来的那行台词（<d>…</d> 内容）；没有则返回空串 */
function extractDialogue(promptText) {
  const m = String(promptText || '').match(/<d>\s*(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function extractAllDialogue(promptText) {
  const out = [];
  const re = /<d>\s*(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(String(promptText || '')))) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}

function absMediaPath(localPath) {
  if (!localPath) return null;
  const p = path.isAbsolute(localPath) ? localPath : path.join(STORAGE, localPath);
  return fs.existsSync(p) ? p : null;
}

function runQc(file, expected) {
  const r = spawnSync(QC_PYTHON, [QC_SCRIPT, file, '--expect', expected, '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '8' },
  });
  if (r.error) return { error: `质检进程启动失败: ${r.error.message}（H3_QC_PYTHON=${QC_PYTHON}）` };
  const out = String(r.stdout || '');
  const line = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
  if (!line) return { error: `质检无输出: ${String(r.stderr || '').slice(-400)}` };
  try {
    const [first] = JSON.parse(line);
    return { transcript: first.transcript, coverage: first.coverage, extra: first.extra, pass: first.pass };
  } catch (e) {
    return { error: `质检输出解析失败: ${e.message}` };
  }
}

async function api(method, url, body) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${url} 失败: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data !== undefined ? json.data : json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用上一次生成的同款参数重新提交一次（seed 由后端随机，等于换种子重来） */
function buildReplayBody(gen, prompt) {
  let refs = [];
  try { refs = gen.reference_image_urls ? JSON.parse(gen.reference_image_urls) : []; } catch (_) {}
  let audios = [];
  try { audios = gen.reference_audio_urls ? JSON.parse(gen.reference_audio_urls) : []; } catch (_) {}
  return {
    drama_id: gen.drama_id,
    storyboard_id: gen.storyboard_id,
    prompt,
    duration: gen.duration,
    aspect_ratio: gen.aspect_ratio,
    resolution: gen.resolution,
    image_url: gen.image_url || undefined,
    first_frame_url: gen.first_frame_url || undefined,
    last_frame_url: gen.last_frame_url || undefined,
    reference_image_urls: refs.map((r) => (typeof r === 'string' ? r : r.url)).filter(Boolean),
    reference_labels: refs.map((r) => (typeof r === 'string' ? '' : r.type || '')),
    reference_audio_urls: Array.isArray(audios) ? audios.filter(Boolean) : [],
    watermark: gen.watermark ? 1 : 0,
  };
}

async function submitAndWait(db, body, label) {
  const created = await api('POST', '/videos', body);
  const id = created.id;
  process.stdout.write(`  → 已提交 vg${id}（${label}）`);
  const t0 = Date.now();
  while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const row = db.prepare('SELECT id, status, local_path, error_msg FROM video_generations WHERE id = ?').get(id);
    const secs = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r  → vg${id} ${row.status} ${secs}s          `);
    if (row.status === 'completed') { process.stdout.write('\n'); return row; }
    if (row.status === 'failed') { process.stdout.write('\n'); throw new Error(row.error_msg || '生成失败'); }
  }
  process.stdout.write('\n');
  throw new Error('等待生成超时');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DB_PATH)) { console.error('找不到数据库: ' + DB_PATH); process.exit(2); }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  const ep = db.prepare('SELECT id, drama_id, title FROM episodes WHERE id = ? AND deleted_at IS NULL').get(opts.episode);
  if (!ep) { console.error('找不到剧集 id=' + opts.episode); process.exit(2); }
  let boards = db.prepare(
    `SELECT id, storyboard_number, duration, video_url, video_prompt, universal_segment_text, scene_id
       FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id`
  ).all(opts.episode);
  if (opts.shots) boards = boards.filter((b) => opts.shots.includes(b.storyboard_number));
  if (opts.sbs) boards = db.prepare(`SELECT id, storyboard_number, duration, video_url, video_prompt, universal_segment_text, scene_id FROM storyboards WHERE id IN (${opts.sbs.map(() => '?').join(',')}) AND deleted_at IS NULL`).all(...opts.sbs);
  if (!boards.length) { console.error('没有匹配的分镜'); process.exit(2); }

  console.log(`剧集 ${ep.id}「${ep.title || ''}」 分镜 ${boards.length} 个 | 最多重试 ${opts.maxTries} 次 | ${opts.checkOnly ? '只质检' : '质检+重生成'}`);
  const summary = [];

  for (const sb of boards) {
    const tag = `#${sb.storyboard_number}`;
    let gen = db.prepare('SELECT * FROM video_generations WHERE storyboard_id = ? ORDER BY id DESC LIMIT 1').get(sb.id);
    if (!gen && !opts.firstGen) {
      console.log(`\n${tag} 跳过：还没有生成记录（加 --first-gen 可由本脚本自己发起首次生成）`);
      summary.push({ tag, result: 'no-source' });
      continue;
    }
    if (!gen) {
      const body = buildFirstGenBody(db, sb, ep.drama_id);
      console.log(`\n${tag} 首次生成：引用图 ${body.reference_image_urls.length} 张（${body.reference_labels.join(' | ')}）`);
      if (opts.dryRun) { console.log('  [dry-run] ' + JSON.stringify(body).slice(0, 300)); continue; }
      try {
        gen = await submitAndWait(db, body, '首次生成');
      } catch (e) {
        console.log(`  首次生成失败: ${e.message}`);
        summary.push({ tag, result: 'first-gen-failed' });
        continue;
      }
    }
    // ★ 用分镜**当前**的 ust，而不是历史那次生成的 prompt —— ust 改过之后（例如清掉悬空音频引用），
    // 重放旧 prompt 等于把改动丢掉。历史 prompt 只在分镜 ust 为空时兜底。
    // --prompt-from=last：用上一次真正提交给 ComfyUI 的文本（同一文本换 seed 重掷，变量只剩种子）
    const prompt = opts.promptFrom === 'last'
      ? (gen.prompt || sb.universal_segment_text || sb.video_prompt || '')
      : (sb.universal_segment_text || sb.video_prompt || gen.prompt || '');
    const lines = extractAllDialogue(prompt);
    const expected = lines.join(' ');
    if (!expected) {
      console.log(`\n${tag} 跳过：该镜没有 <d> 台词，无需人声质检`);
      summary.push({ tag, result: 'no-dialogue' });
      continue;
    }
    console.log(`\n${tag} 应念: ${expected}`);

    let current = gen;
    for (let attempt = 1; attempt <= opts.maxTries; attempt++) {
      if (current.status !== 'completed') {
        if (opts.checkOnly) { console.log(`  上次状态 ${current.status}，跳过`); break; }
        try {
          current = await submitAndWait(db, buildReplayBody(gen, prompt), `第${attempt}次`);
        } catch (e) {
          console.log(`  第${attempt}次生成失败: ${e.message}`);
          current = { status: 'failed' };
          continue;
        }
      }
      const file = absMediaPath(current.local_path);
      if (!file) {
        console.log(`  第${attempt}次没有本地文件（local_path=${current.local_path || '空'}）`);
        if (opts.checkOnly) break;
        current = { status: 'failed' };
        continue;
      }
      if (opts.dryRun) { console.log(`  [dry-run] 将质检 ${file}`); break; }
      const qc = runQc(file, expected);
      if (qc.error) { console.log('  质检出错: ' + qc.error); summary.push({ tag, result: 'qc-error' }); break; }
      const verdict = qc.pass ? 'PASS ✅' : 'FAIL ❌';
      console.log(`  第${attempt}次 ${path.basename(file)} ${verdict} coverage=${qc.coverage} extra=${qc.extra}`);
      console.log(`    转写: ${qc.transcript}`);
      if (qc.pass) { summary.push({ tag, result: 'pass', tries: attempt }); break; }
      if (opts.checkOnly) { summary.push({ tag, result: 'fail' }); break; }
      if (attempt === opts.maxTries) { summary.push({ tag, result: 'gave-up', tries: attempt }); break; }
      try {
        current = await submitAndWait(db, buildReplayBody(gen, prompt), `重试${attempt + 1}`);
      } catch (e) {
        console.log(`  重试提交失败: ${e.message}`);
        current = { status: 'failed' };
      }
    }
  }

  console.log('\n===== 汇总 =====');
  for (const s of summary) console.log(`${s.tag.padEnd(6)} ${s.result}${s.tries ? '（' + s.tries + ' 次）' : ''}`);
  const bad = summary.filter((s) => ['fail', 'gave-up', 'qc-error', 'no-source'].includes(s.result));
  console.log(`合格 ${summary.filter((s) => s.result === 'pass').length} / ${summary.length}`);
  db.close();
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
