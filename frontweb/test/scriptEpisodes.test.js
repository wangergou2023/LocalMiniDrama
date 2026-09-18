/**
 * 分集标题解析回归。
 *
 * 实测缺陷：《重生后过上了大女主生活》把第十二集写成「十二集」（漏「第」字），
 * parseScriptIntoEpisodes 认不出来 → 十二集正文被并进第十一集，20 集变 19 集
 * （第十一集 945 字，正好是十一集 500 + 十二集 439 + 标题行）。
 *
 * 放宽成「裸标题」时必须仍然只认整行的 数字+集/章/节，
 * 否则剧本里的 `1.景：吴家`、`3.故事大纲`、`2.1女主-小兰` 会被当成集标题。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseScriptIntoEpisodes } from '../src/utils/scriptEpisodes.js'

test('漏写「第」的集标题也要认，并补成统一格式', () => {
  const text = ['第一集', '开场。', '', '十二集', '中段。', '', '第十三集', '结尾。'].join('\n')
  const r = parseScriptIntoEpisodes(text)
  assert.equal(r.split, true)
  assert.deepEqual(r.episodes.map((e) => e.title), ['第一集', '第十二集', '第十三集'])
  assert.match(r.episodes[1].script_content, /中段/)
})

test('剧本里的场景/大纲行不会被当成集标题', () => {
  const text = [
    '第一集',
    '1.景：吴家',
    '时：日 内',
    '人：小兰',
    '小兰醒来。',
    '',
    '第二集',
    '3.故事大纲',
    '2.1女主-小兰',
    '1.基本信息',
    '继续。',
  ].join('\n')
  const r = parseScriptIntoEpisodes(text)
  assert.deepEqual(r.episodes.map((e) => e.title), ['第一集', '第二集'])
  assert.match(r.episodes[1].script_content, /故事大纲/)
})

test('一句话里出现「三集」不会被当标题（必须整行）', () => {
  const text = ['第一集', '我给你三集的时间，够不够？', '', '第二集', '够了。'].join('\n')
  const r = parseScriptIntoEpisodes(text)
  assert.deepEqual(r.episodes.map((e) => e.title), ['第一集', '第二集'])
})

test('括号包住的裸标题同样有效（【十二集】）', () => {
  const text = ['第一集', '甲。', '', '【十二集】', '乙。'].join('\n')
  const r = parseScriptIntoEpisodes(text)
  assert.deepEqual(r.episodes.map((e) => e.title), ['第一集', '第十二集'])
})
