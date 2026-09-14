'use strict';
/**
 * 成片编码器选择：默认 AV1 10-bit（可硬解、色带少），可覆盖为 h264；参数不合法时回落 AV1。
 */
const test = require('node:test');
const assert = require('node:assert');
const { finalEncoderArgs } = require('../src/services/mergedEpisodePostProcess');

test('默认输出 AV1 10-bit crf 26', () => {
  const e = finalEncoderArgs({});
  assert.equal(e.key, 'av1');
  assert.equal(e.crf, 26);
  assert.deepEqual(e.args, ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '26', '-pix_fmt', 'yuv420p10le']);
});

test('merge_options 可切回 h264（8-bit，兼容老播放器）', () => {
  const e = finalEncoderArgs({ output_codec: 'h264' });
  assert.equal(e.key, 'h264');
  assert.equal(e.crf, 23);
  assert.deepEqual(e.args, ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p']);
});

test('未知 codec 与显式 crf 的处理', () => {
  assert.equal(finalEncoderArgs({ output_codec: 'vp9' }).key, 'av1');
  assert.equal(finalEncoderArgs({ output_codec: 'AV1' }).key, 'av1');
  const e = finalEncoderArgs({ output_codec: 'av1', output_crf: 20 });
  assert.equal(e.crf, 20);
  assert.ok(e.args.includes('20'));
});

test('AV1 走 10-bit 像素格式，避免墨色渐变色带', () => {
  const args = finalEncoderArgs({}).args.join(' ');
  assert.match(args, /yuv420p10le/);
  assert.doesNotMatch(args, /yuv420p\b(?!10le)/);
});
