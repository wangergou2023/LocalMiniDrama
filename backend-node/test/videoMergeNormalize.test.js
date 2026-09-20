const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const merge = require('../src/services/videoMergeService');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

/**
 * 合并（ffmpeg -f concat -c copy）要求所有输入同编码/同分辨率/同音频参数。
 * 之前只要有一段不一致（例如手动上传的 AV1 480x864 混在 H.264 720x1280 里），
 * 那一段就**只有声音没有画面**，成片里画面卡在上一帧。
 * 这里锁两件事：① 纯逻辑能识别出不一致；② 归一化后真的拼得出连续画面。
 */
const silentLog = { info() {}, warn() {}, error() {} };

describe('合并前的输入一致性判断（纯逻辑）', () => {
  it('normalizeFps 解析 "24/1" 与 "29.97"', () => {
    assert.equal(merge.normalizeFps('24/1'), 24);
    assert.equal(merge.normalizeFps('30000/1001'), 29.97);
    assert.equal(merge.normalizeFps('25'), 25);
    assert.equal(merge.normalizeFps(''), 0);
  });

  it('多数派规格 = 出现次数最多的 尺寸@帧率，编码统一 h264', () => {
    const p = (w, h, fps, codec = 'h264') => ({ codec, width: w, height: h, fps, pixFmt: 'yuv420p', audioCodec: 'aac', audioRate: 48000, audioChannels: 2 });
    const target = merge.pickMajorityProfile([
      p(720, 1280, 24),
      p(720, 1280, 24),
      p(480, 864, 24, 'av1'),
    ]);
    assert.deepEqual(target, { codec: 'h264', width: 720, height: 1280, fps: 24 });
  });

  it('探测失败（null）不参与统计；全失败时返回 null', () => {
    const target = merge.pickMajorityProfile([null, { codec: 'h264', width: 720, height: 1280, fps: 24 }]);
    assert.equal(target.width, 720);
    assert.equal(merge.pickMajorityProfile([null, null]), null);
    assert.equal(merge.pickMajorityProfile([]), null);
  });

  it('编码/分辨率/帧率/像素格式/音频参数任一不一致都要归一化', () => {
    const target = { codec: 'h264', width: 720, height: 1280, fps: 24 };
    const ok = { codec: 'h264', width: 720, height: 1280, fps: 24, pixFmt: 'yuv420p', audioCodec: 'aac', audioRate: 48000, audioChannels: 2 };
    assert.equal(merge.needsNormalization(ok, target), false);
    assert.equal(merge.needsNormalization({ ...ok, codec: 'av1' }, target), true);
    assert.equal(merge.needsNormalization({ ...ok, width: 480, height: 864 }, target), true);
    assert.equal(merge.needsNormalization({ ...ok, fps: 30 }, target), true);
    assert.equal(merge.needsNormalization({ ...ok, pixFmt: 'yuv444p' }, target), true);
    assert.equal(merge.needsNormalization({ ...ok, audioRate: 44100 }, target), true);
    assert.equal(merge.needsNormalization({ ...ok, audioChannels: 1 }, target), true);
    // 探测失败不动它
    assert.equal(merge.needsNormalization(null, target), false);
  });

  it('归一化命令：等比缩放+补边到目标尺寸、统一帧率与音频；无音轨时补静音', () => {
    const target = { codec: 'h264', width: 720, height: 1280, fps: 24 };
    const args = merge.buildNormalizeArgs('/a/in.mp4', '/a/out.mp4', target, true);
    const vf = args[args.indexOf('-vf') + 1];
    assert.match(vf, /scale=720:1280:force_original_aspect_ratio=decrease/);
    assert.match(vf, /pad=720:1280:\(ow-iw\)\/2:\(oh-ih\)\/2/);
    assert.match(vf, /setsar=1/);
    assert.match(vf, /fps=24/);
    assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 3), ['-c:v', 'libx264', '-preset']);
    assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=48000') === false, '有音轨时不该补静音');
    const noAudio = merge.buildNormalizeArgs('/a/in.mp4', '/a/out.mp4', target, false);
    assert.ok(noAudio.join(' ').includes('anullsrc=channel_layout=stereo:sample_rate=48000'), '无音轨要补静音，否则 concat 会因流布局不同失败');
  });
});

const ffmpegReady = hasLocalFfmpeg();
describe('归一化后拼接：分辨率不一致也能出连续画面（真实 ffmpeg）', { skip: !ffmpegReady }, () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd_merge_test_'));
  });
  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  it('640x480(无音轨) + 320x240(有音轨) → 成片 2 段都有画面且不冻结', () => {
    const ffmpeg = getFfmpegPath();
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    const ra = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', a], { encoding: 'utf8' });
    assert.equal(ra.status, 0, ra.stderr);
    const rb = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-t', '1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', b], { encoding: 'utf8' });
    assert.equal(rb.status, 0, rb.stderr);

    const prepared = merge.prepareUniformInputs([a, b], silentLog);
    assert.equal(prepared.normalized.length, 2, '两段规格不一致，都应被归一化');
    assert.deepEqual(prepared.profile, { codec: 'h264', width: 640, height: 480, fps: 24 });

    const out = path.join(dir, 'merged.mp4');
    assert.equal(merge.runFfmpegConcat(prepared.paths, out, silentLog), true);
    assert.ok(fs.existsSync(out));

    const ffprobe = getFfprobePath();
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    const dur = Number(String(probe.stdout).trim());
    assert.ok(dur > 1.8 && dur < 2.4, `成片时长应约 2s，实际 ${dur}`);

    // 关键：两段都有画面 —— 取两段中点抽帧，指纹必须不同（冻结时两帧完全相同）
    const f1 = path.join(dir, 'f1.png');
    const f2 = path.join(dir, 'f2.png');
    spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', '0.5', '-i', out, '-frames:v', '1', f1]);
    spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', '1.5', '-i', out, '-frames:v', '1', f2]);
    const h1 = crypto.createHash('sha256').update(fs.readFileSync(f1)).digest('hex');
    const h2 = crypto.createHash('sha256').update(fs.readFileSync(f2)).digest('hex');
    assert.notEqual(h1, h2, '第二段画面不该与第一段相同（说明没有丢画面/冻结）');

    // 成片仍需带音轨（第二段原本有声）
    const streams = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.match(String(streams.stdout), /audio/);
  });
});
