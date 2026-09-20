import test from 'node:test'
import assert from 'node:assert/strict'

import { buildClassicVideoRefs } from '../src/utils/videoRefs.js'

/**
 * 经典 / 首尾帧镜头提交视频时的参考图：场景在前、本镜主图在后，都带标签
 * （后端按标签逐张生成 <Picture N> 映射行：含 scene / keyframe 关键词）。
 */
test('场景图在前、本镜主图在后，标签齐全', () => {
  const r = buildClassicVideoRefs({
    sceneImageUrl: 'http://x/scene.png',
    sceneName: '河边',
    ownFrameUrl: 'http://x/frame.png',
  })
  assert.deepEqual(r.urls, ['http://x/scene.png', 'http://x/frame.png'])
  assert.deepEqual(r.labels.map((l) => l.split(' (')[0]), [
    'scene background for "河边"',
    'keyframe still for this shot',
  ])
})

test('没有场景图时只给本镜主图（回到原行为）', () => {
  const r = buildClassicVideoRefs({
    sceneImageUrl: '',
    sceneName: '河边',
    ownFrameUrl: 'http://x/frame.png',
  })
  assert.deepEqual(r.urls, ['http://x/frame.png'])
  assert.deepEqual(r.labels.map((l) => l.split(' (')[0]), ['keyframe still for this shot'])
})

test('场景图与本镜主图相同时不重复', () => {
  const r = buildClassicVideoRefs({
    sceneImageUrl: 'http://x/same.png',
    sceneName: '河边',
    ownFrameUrl: 'http://x/same.png',
  })
  assert.deepEqual(r.urls, ['http://x/same.png'])
  assert.equal(r.labels.length, 1)
  assert.match(r.labels[0], /scene background/)
})

test('两者都没有时返回空（调用方回落到 undefined，不报错）', () => {
  const r = buildClassicVideoRefs({})
  assert.deepEqual(r.urls, [])
  assert.deepEqual(r.labels, [])
})

test('场景没有名字时标签仍写完整（避免后端关键词匹配不到）', () => {
  const r = buildClassicVideoRefs({ sceneImageUrl: 'http://x/scene.png', ownFrameUrl: '' })
  assert.equal(r.labels[0], 'scene background for "场景"')
})
