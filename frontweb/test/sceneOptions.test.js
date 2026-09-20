import test from 'node:test'
import assert from 'node:assert/strict'

import { pickSceneById, buildSceneSelectOptions } from '../src/utils/sceneOptions.js'

/**
 * 分镜场景解析：本集优先，跨集绑定要能兜底显示（并标注属于第几集）。
 * 背景：下拉默认只列本集场景，但老数据里分镜可能绑着别的剧集同地点的场景行，
 * 不回退就显示为空、全能模式也收不到场景参考图。
 */
const episodeScenes = [
  { id: 94, location: '河边', episode_id: 28 },
  { id: 95, location: '吴家', episode_id: 28 },
  { id: 96, location: '主卫', episode_id: 28 },
]
const allScenes = [
  { id: 75, location: '吴家', episode_id: 24 },
  { id: 86, location: '河边', episode_id: 27 },
  ...episodeScenes,
]
const episodeNumberOf = (id) => ({ 24: 1, 27: 4, 28: 5 })[Number(id)] ?? null

test('pickSceneById：本集场景直接命中', () => {
  assert.equal(pickSceneById(94, episodeScenes, allScenes).location, '河边')
})

test('pickSceneById：本集查不到时回退全剧（跨集绑定）', () => {
  const s = pickSceneById(86, episodeScenes, allScenes)
  assert.equal(s.location, '河边')
  assert.equal(s.episode_id, 27)
})

test('pickSceneById：都没有则为 null（不抛错）', () => {
  assert.equal(pickSceneById(999, episodeScenes, allScenes), null)
  assert.equal(pickSceneById(null, episodeScenes, allScenes), null)
  assert.equal(pickSceneById(86, episodeScenes, []), null)
})

test('buildSceneSelectOptions：默认只列本集场景', () => {
  const opts = buildSceneSelectOptions({ episodeScenes, allScenes, boundSceneIds: [] })
  assert.deepEqual(opts.map((o) => o.id), [94, 95, 96])
  assert.equal(opts.every((o) => o.crossEpisode === false), true)
  assert.equal(opts[0].label, '河边')
})

test('buildSceneSelectOptions：已绑定的跨集场景补进选项并标注集号', () => {
  const opts = buildSceneSelectOptions({
    episodeScenes,
    allScenes,
    boundSceneIds: [86, 94, null, undefined],
    episodeNumberOf,
  })
  assert.deepEqual(opts.map((o) => o.id), [94, 95, 96, 86])
  const cross = opts.find((o) => o.id === 86)
  assert.equal(cross.crossEpisode, true)
  assert.equal(cross.label, '河边（第4集）')
})

test('buildSceneSelectOptions：未绑定的跨集场景不会出现在下拉里', () => {
  const opts = buildSceneSelectOptions({
    episodeScenes,
    allScenes,
    boundSceneIds: [86],
    episodeNumberOf,
  })
  assert.equal(opts.some((o) => o.id === 75), false)
})

test('buildSceneSelectOptions：拿不到集号时标注「其它集」，且不重复同一 id', () => {
  const opts = buildSceneSelectOptions({
    episodeScenes,
    allScenes,
    boundSceneIds: [86, 86],
    episodeNumberOf: () => null,
  })
  const cross = opts.filter((o) => o.id === 86)
  assert.equal(cross.length, 1)
  assert.equal(cross[0].label, '河边（其它集）')
})

test('buildSceneSelectOptions：全剧场景还没加载时只给本集，不报错', () => {
  const opts = buildSceneSelectOptions({ episodeScenes, allScenes: [], boundSceneIds: [86] })
  assert.deepEqual(opts.map((o) => o.id), [94, 95, 96])
})
