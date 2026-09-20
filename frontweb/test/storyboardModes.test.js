import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveStoryboardModes,
  storyboardModeDropMessage,
  SB_MODE_UNIVERSAL,
  SB_MODE_FIRST_LAST,
} from '../src/utils/storyboardModes.js'

/**
 * 「全能分镜模式」与「首尾帧参考图」互斥：
 * 同时开启时首尾帧实际不生效（全能分镜下每镜都是全能镜头），
 * 所以 UI 必须二选一，并在关掉一方时给出明确提示。
 */
test('只开一个时不改动', () => {
  assert.deepEqual(resolveStoryboardModes({ universalOmni: true, useFirstLastFrame: false }), {
    universalOmni: true,
    useFirstLastFrame: false,
    dropped: null,
  })
  assert.deepEqual(resolveStoryboardModes({ universalOmni: false, useFirstLastFrame: true }), {
    universalOmni: false,
    useFirstLastFrame: true,
    dropped: null,
  })
  assert.deepEqual(resolveStoryboardModes({}), {
    universalOmni: false,
    useFirstLastFrame: false,
    dropped: null,
  })
})

test('用户刚勾选全能分镜 → 关掉首尾帧', () => {
  const r = resolveStoryboardModes({
    universalOmni: true,
    useFirstLastFrame: true,
    preferred: SB_MODE_UNIVERSAL,
  })
  assert.equal(r.universalOmni, true)
  assert.equal(r.useFirstLastFrame, false)
  assert.equal(r.dropped, SB_MODE_FIRST_LAST)
})

test('用户刚勾选首尾帧 → 关掉全能分镜', () => {
  const r = resolveStoryboardModes({
    universalOmni: true,
    useFirstLastFrame: true,
    preferred: SB_MODE_FIRST_LAST,
  })
  assert.equal(r.universalOmni, false)
  assert.equal(r.useFirstLastFrame, true)
  assert.equal(r.dropped, SB_MODE_UNIVERSAL)
})

test('载入历史项目（没指定优先方）→ 保留全能分镜', () => {
  const r = resolveStoryboardModes({ universalOmni: true, useFirstLastFrame: true })
  assert.equal(r.universalOmni, true)
  assert.equal(r.useFirstLastFrame, false)
  assert.equal(r.dropped, SB_MODE_FIRST_LAST)
})

test('取消勾选不产生冲突（preferred 传 null）', () => {
  const r = resolveStoryboardModes({
    universalOmni: true,
    useFirstLastFrame: false,
    preferred: null,
  })
  assert.equal(r.dropped, null)
  assert.equal(r.universalOmni, true)
})

test('提示文案：明确说明为什么被关掉', () => {
  assert.match(storyboardModeDropMessage(SB_MODE_FIRST_LAST), /首尾帧/)
  assert.match(storyboardModeDropMessage(SB_MODE_FIRST_LAST), /全能分镜/)
  assert.match(storyboardModeDropMessage(SB_MODE_UNIVERSAL), /经典镜头/)
  assert.equal(storyboardModeDropMessage(null), '')
})
