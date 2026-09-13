/**
 * 半自动尾帧衔接：相邻镜连续性判定 + 提交前自动锚定，单测。
 *
 * 背景：本地 H3（协议 comfyui，A03 Ref2VA）单镜最长 362 帧 = 15.08s，一段连续动作必然被
 * 切成多镜。此前只能靠用户逐对点「尾帧衔接」按钮，65 镜就是 64 次点击；而误接（把剪辑点
 * 也接上）会让本镜起幅被上一镜锁死、剪辑节奏消失。所以本模块的两条硬要求都要钉住：
 *   ① 判定必须分两层：硬条件（编号紧邻/同地点/同段落）不满足**直接判 0 且不调模型**；
 *      语义判定只对通过硬条件的对做，且 unsure / 缺答一律按 0（保守，宁可少接）。
 *   ② 自动锚定必须只在「开关开 + 本镜=承接 + 本镜未绑首帧 + 上一镜有可用本地视频」时才发生，
 *      而且任何一步失败都只是静默跳过，不能让视频生成失败。
 *
 * 测试全部走纯函数 + 注入的假 aiClient / 内存库，不碰网络。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const svc = require('../src/services/adjacentContinuityService');

const silentLog = {
  lines: [],
  info(msg, meta) { this.lines.push(['info', msg, meta]); },
  warn(msg, meta) { this.lines.push(['warn', msg, meta]); },
  error(msg, meta) { this.lines.push(['error', msg, meta]); },
};
function freshLog() {
  return { lines: [], info(m, x) { this.lines.push(['info', m, x]); }, warn(m, x) { this.lines.push(['warn', m, x]); }, error(m, x) { this.lines.push(['error', m, x]); } };
}

function sb(number, extra = {}) {
  return {
    id: extra.id != null ? extra.id : number,
    storyboard_number: number,
    location: '荒山野岭',
    segment_index: 0,
    title: '镜头' + number,
    action: '悟空抡起金箍棒当头劈下。',
    result: '',
    movement: '固定镜头',
    shot_type: '中景',
    link_prev_tail: null,
    ...extra,
  };
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      metadata TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      storyboard_number INTEGER,
      location TEXT,
      segment_index INTEGER DEFAULT 0,
      title TEXT,
      action TEXT,
      result TEXT,
      movement TEXT,
      shot_type TEXT,
      video_url TEXT,
      local_path TEXT,
      image_url TEXT,
      first_frame_image_id INTEGER,
      link_prev_tail INTEGER,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER,
      status TEXT,
      local_path TEXT,
      video_url TEXT,
      created_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function insertStoryboard(db, row, episodeId = 1) {
  db.prepare(
    `INSERT INTO storyboards
       (id, episode_id, storyboard_number, location, segment_index, title, action, result, movement, shot_type,
        video_url, local_path, image_url, first_frame_image_id, link_prev_tail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id, episodeId, row.storyboard_number, row.location, row.segment_index ?? 0,
    row.title, row.action, row.result || '', row.movement || '', row.shot_type || '',
    row.video_url || null, row.local_path || null, row.image_url || null,
    row.first_frame_image_id ?? null, row.link_prev_tail ?? null
  );
}

describe('相邻镜连续性：硬条件（不满足直接判 0，不调模型）', () => {
  it('编号紧邻 + 同地点 + 同段落 → 通过', () => {
    assert.equal(svc.hardGate(sb(1), sb(2)).ok, true);
  });

  it('location 不同（trim 后不等）→ 不通过', () => {
    assert.equal(svc.hardGate(sb(1), sb(2, { location: '花果山' })).reason, 'location_changed');
  });

  it('location 只有首尾空格差异 → 仍算同一地点', () => {
    assert.equal(svc.hardGate(sb(1), sb(2, { location: ' 荒山野岭 ' })).ok, true);
  });

  it('编号不连续（中间被删/跳号）→ 不通过', () => {
    assert.equal(svc.hardGate(sb(1), sb(3)).reason, 'number_not_adjacent');
  });

  it('segment_index 不同（跨剧情段落）→ 不通过', () => {
    assert.equal(svc.hardGate(sb(1), sb(2, { segment_index: 1 })).reason, 'segment_changed');
  });
});

describe('相邻镜连续性：applyVerdicts（纯函数）', () => {
  const pairs = [
    { index: 1, prev: { id: 11 }, cur: { id: 12 } },
    { index: 2, prev: { id: 12 }, cur: { id: 13 } },
    { index: 3, prev: { id: 13 }, cur: { id: 14 } },
  ];

  it('continues → 1；cut / unsure → 0（unsure 保守按剪辑点）', () => {
    const out = svc.applyVerdicts(pairs, {
      pairs: [
        { i: 1, verdict: 'continues' },
        { i: 2, verdict: 'cut' },
        { i: 3, verdict: 'unsure' },
      ],
    });
    assert.deepEqual(out.map((o) => o.link_prev_tail), [1, 0, 0]);
    assert.deepEqual(out.map((o) => o.storyboard_id), [12, 13, 14]);
  });

  it('缺答 / 整份解析失败 → 全部 0，不抛错', () => {
    assert.deepEqual(svc.applyVerdicts(pairs, null).map((o) => o.link_prev_tail), [0, 0, 0]);
    assert.deepEqual(svc.applyVerdicts(pairs, {}).map((o) => o.link_prev_tail), [0, 0, 0]);
    const partial = svc.applyVerdicts(pairs, { pairs: [{ i: 2, verdict: 'continues' }] });
    assert.deepEqual(partial.map((o) => o.link_prev_tail), [0, 1, 0]);
  });

  it('按 i 对齐：漏答一条不会让后面的结论整体错位', () => {
    // 只答了第 3 对。若按位置对齐，会把「承接」错安到第 1 对上。
    const out = svc.applyVerdicts(pairs, { pairs: [{ i: 3, verdict: 'continues' }] });
    assert.deepEqual(out.map((o) => o.link_prev_tail), [0, 0, 1]);
  });
});

describe('相邻镜连续性：classifyEpisodeContinuity（注入假 aiClient）', () => {
  function fakeAi(reply, calls) {
    return {
      generateText: async (db, log, serviceType, userPrompt, systemPrompt, options) => {
        calls.push({ serviceType, userPrompt, systemPrompt, options });
        return reply;
      },
    };
  }

  it('硬条件全部不满足时：写 0 且**完全不调模型**', async () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1, { location: '荒山野岭' }));
    insertStoryboard(db, sb(2, { location: '花果山' }));   // 换地点
    insertStoryboard(db, sb(3, { segment_index: 1 }));    // 换段落
    const calls = [];
    const summary = await svc.classifyEpisodeContinuity(db, freshLog(), 1, { aiClient: fakeAi('{}', calls) });

    assert.equal(calls.length, 0, '硬条件不满足的对不允许调用模型');
    assert.equal(summary.judged, 0);
    assert.equal(summary.hard_failed, 2);
    const rows = db.prepare('SELECT storyboard_number, link_prev_tail FROM storyboards ORDER BY storyboard_number').all();
    assert.deepEqual(rows, [
      { storyboard_number: 1, link_prev_tail: null },  // 首镜没有上一镜，不判
      { storyboard_number: 2, link_prev_tail: 0 },
      { storyboard_number: 3, link_prev_tail: 0 },
    ]);
  });

  it('通过硬条件的对只调一次模型，结果写回 link_prev_tail', async () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1, { id: 101 }));
    insertStoryboard(db, sb(2, { id: 102 }));
    insertStoryboard(db, sb(3, { id: 103 }));
    const calls = [];
    const summary = await svc.classifyEpisodeContinuity(db, freshLog(), 1, {
      aiClient: fakeAi('{"pairs":[{"i":1,"verdict":"continues"},{"i":2,"verdict":"cut"}]}', calls),
    });

    assert.equal(calls.length, 1, '一次调用判定所有通过硬条件的对');
    assert.equal(summary.continues, 1);
    assert.equal(summary.cut, 1);
    const rows = db.prepare('SELECT id, link_prev_tail FROM storyboards ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: 101, link_prev_tail: null },
      { id: 102, link_prev_tail: 1 },
      { id: 103, link_prev_tail: 0 },
    ]);
  });

  it('模型返回垃圾 → 全部 0（保守），不抛错', async () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1));
    insertStoryboard(db, sb(2));
    const summary = await svc.classifyEpisodeContinuity(db, freshLog(), 1, {
      aiClient: fakeAi('抱歉，我无法判断。', []),
    });
    assert.equal(summary.llm_failed, true);
    assert.equal(db.prepare('SELECT link_prev_tail FROM storyboards WHERE storyboard_number = 2').get().link_prev_tail, 0);
  });

  it('模型调用抛异常 → 记 warn 且不抛错，全部 0', async () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1));
    insertStoryboard(db, sb(2));
    const log = freshLog();
    const summary = await svc.classifyEpisodeContinuity(db, log, 1, {
      aiClient: { generateText: async () => { throw new Error('未配置文本模型'); } },
    });
    assert.equal(summary.llm_failed, true);
    assert.ok(log.lines.some((l) => l[0] === 'warn'), '必须留下 warn 日志');
    assert.equal(db.prepare('SELECT link_prev_tail FROM storyboards WHERE storyboard_number = 2').get().link_prev_tail, 0);
  });

  it('已判定过的对不再重判（人工翻转的结论留得住），force 才全部重判', async () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1));
    insertStoryboard(db, sb(2, { link_prev_tail: 0 }));   // 人工翻成「剪辑点」
    const calls = [];
    await svc.classifyEpisodeContinuity(db, freshLog(), 1, {
      aiClient: fakeAi('{"pairs":[{"i":1,"verdict":"continues"}]}', calls),
    });
    assert.equal(calls.length, 0, '已判定的对不应再花一次模型调用');
    assert.equal(db.prepare('SELECT link_prev_tail FROM storyboards WHERE storyboard_number = 2').get().link_prev_tail, 0);

    await svc.classifyEpisodeContinuity(db, freshLog(), 1, {
      force: true,
      aiClient: fakeAi('{"pairs":[{"i":1,"verdict":"continues"}]}', calls),
    });
    assert.equal(calls.length, 1);
    assert.equal(db.prepare('SELECT link_prev_tail FROM storyboards WHERE storyboard_number = 2').get().link_prev_tail, 1);
  });
});

describe('项目开关 auto_tail_frame_link（默认开）', () => {
  it('读不到 / 无 metadata / null → 开', () => {
    assert.equal(svc.resolveAutoTailLinkSwitch(undefined), true);
    assert.equal(svc.resolveAutoTailLinkSwitch({}), true);
    assert.equal(svc.resolveAutoTailLinkSwitch('not json'), true);
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: null }), true);
    assert.equal(svc.resolveAutoTailLinkSwitch(JSON.stringify({ aspect_ratio: '16:9' })), true);
  });

  it('显式 false / "false" / 0 → 关', () => {
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: false }), false);
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: 'false' }), false);
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: 0 }), false);
  });

  it('显式 true → 开', () => {
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: true }), true);
    assert.equal(svc.resolveAutoTailLinkSwitch({ auto_tail_frame_link: 'true' }), true);
  });
});

describe('提交前自动锚定判定 shouldAutoAnchorPrevTail（纯函数）', () => {
  const cur = { storyboard_number: 5, link_prev_tail: 1, first_frame_image_id: null };
  const prev = { id: 4, storyboard_number: 4 };
  const prevVideo = { local_path: 'projects/p1/videos/vg_4.mp4', video_url: 'http://x/y.mp4' };

  it('开关开 + 承接 + 未绑首帧 + 上一镜有视频 → 产出可抽帧的视频路径', () => {
    const d = svc.shouldAutoAnchorPrevTail({ cur, prev, prevVideo, enabled: true });
    assert.equal(d.ok, true);
    assert.equal(d.source, 'projects/p1/videos/vg_4.mp4');
  });

  it('开关关 → 不锚', () => {
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur, prev, prevVideo, enabled: false }).reason, 'switch_off');
  });

  it('link_prev_tail 为 0 或 NULL（判为剪辑点/未判定）→ 不锚', () => {
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur: { ...cur, link_prev_tail: 0 }, prev, prevVideo, enabled: true }).reason, 'not_continues');
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur: { ...cur, link_prev_tail: null }, prev, prevVideo, enabled: true }).reason, 'not_continues');
  });

  it('本镜已绑定首帧（含显式提交的首帧 URL）→ 不锚，用户选择优先', () => {
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur: { ...cur, first_frame_image_id: 9 }, prev, prevVideo, enabled: true }).reason, 'first_frame_bound');
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur: { ...cur, first_frame_url: 'http://x/f.jpg' }, prev, prevVideo, enabled: true }).reason, 'first_frame_bound');
  });

  it('上一镜不存在 / 编号不相邻 / 没有可用本地视频 → 不锚', () => {
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur, prev: null, prevVideo, enabled: true }).reason, 'no_prev_storyboard');
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur, prev: { id: 2, storyboard_number: 2 }, prevVideo, enabled: true }).reason, 'prev_not_adjacent');
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur, prev, prevVideo: null, enabled: true }).reason, 'prev_video_missing');
    assert.equal(svc.shouldAutoAnchorPrevTail({ cur, prev, prevVideo: { video_url: 'http://x/y.mp4' }, enabled: true }).reason, 'prev_video_missing');
  });
});

describe('findPrevStoryboardVideo：上一镜视频取哪条记录', () => {
  it('优先用 storyboards 上已落库的视频（finalizeSuccessfulVideo 会同步写回）', () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1, { local_path: 'projects/p1/videos/sb1.mp4' }));
    insertStoryboard(db, sb(2));
    db.prepare(
      `INSERT INTO video_generations (storyboard_id, status, local_path, created_at)
       VALUES (1, 'completed', 'projects/p1/videos/old.mp4', '2024-01-01T00:00:00Z')`
    ).run();
    const { prev, prevVideo } = svc.findPrevStoryboardVideo(db, { episode_id: 1, storyboard_number: 2 });
    assert.equal(prev.id, 1);
    assert.equal(svc.pickTailFrameVideoPath(prevVideo), 'projects/p1/videos/sb1.mp4');
  });

  it('storyboards 上没有视频时退回 video_generations 最新的 completed 记录', () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1));
    insertStoryboard(db, sb(2));
    db.prepare(
      `INSERT INTO video_generations (storyboard_id, status, local_path, created_at)
       VALUES (1, 'processing', 'projects/p1/videos/running.mp4', '2024-01-03T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO video_generations (storyboard_id, status, local_path, created_at)
       VALUES (1, 'completed', 'projects/p1/videos/done.mp4', '2024-01-02T00:00:00Z')`
    ).run();
    const { prevVideo } = svc.findPrevStoryboardVideo(db, { episode_id: 1, storyboard_number: 2 });
    assert.equal(svc.pickTailFrameVideoPath(prevVideo), 'projects/p1/videos/done.mp4');
  });

  it('上一镜不存在（首镜 / 被删）→ prev 为 null', () => {
    const db = createTestDb();
    insertStoryboard(db, sb(5));
    const { prev, prevVideo } = svc.findPrevStoryboardVideo(db, { episode_id: 1, storyboard_number: 5 });
    assert.equal(prev, null);
    assert.equal(prevVideo, null);
  });
});

describe('真抽帧（需要 ffmpeg）：复用同一个抽帧函数 + 自动锚定端到端', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { hasLocalFfmpeg, getFfmpegPath } = require('../src/utils/ffmpegPath');
  const { extractVideoTailFrame } = require('../src/services/tailFrameLinkService');

  /** 生成一个 1 秒纯色测试视频（真文件，才能验抽帧） */
  function makeTinyVideo(dir, name = 'prev.mp4') {
    const out = path.join(dir, name);
    const r = spawnSync(getFfmpegPath(), [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-pix_fmt', 'yuv420p', out,
    ], { encoding: 'utf8' });
    return r.status === 0 && fs.existsSync(out) ? out : null;
  }

  it('extractVideoTailFrame 从视频抽出末帧（按 cfg.storage.local_path 落盘）', (t) => {
    if (!hasLocalFfmpeg()) return t.skip('环境无 ffmpeg');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-tailframe-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const video = makeTinyVideo(tmp);
    assert.ok(video, '测试视频生成失败');

    const r = extractVideoTailFrame({ storage: { local_path: tmp } }, freshLog(), {
      videoPath: video,
      outputFileName: 'tailframe_test.jpg',
    });
    assert.equal(r.ok, true, r.error || '');
    assert.equal(fs.existsSync(r.outputAbsPath), true);
    assert.equal(r.outputRelPath, 'media/images/tailframe_test.jpg');
    assert.equal(r.width, 64);
    assert.equal(r.height, 48);
  });

  it('视频文件不存在时只返回错误，不抛（自动锚定要靠它静默跳过）', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-tailframe-miss-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const r = extractVideoTailFrame({ storage: { local_path: tmp } }, freshLog(), {
      videoPath: 'videos/not-there.mp4',
      outputFileName: 'tailframe_test_miss.jpg',
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /视频文件不存在/);
  });

  it('承接镜 + 上一镜有视频 → 端到端返回可用的首帧文件；已绑首帧则跳过', (t) => {
    if (!hasLocalFfmpeg()) return t.skip('环境无 ffmpeg');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-autotail-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const video = makeTinyVideo(tmp, 'sb1.mp4');
    assert.ok(video);

    const db = createTestDb();
    db.prepare('INSERT INTO dramas (id, metadata) VALUES (1, ?)').run(JSON.stringify({}));
    db.prepare('INSERT INTO episodes (id, drama_id) VALUES (1, 1)').run();
    insertStoryboard(db, sb(1, { local_path: video }));                 // 绝对路径同样支持
    insertStoryboard(db, sb(2, { link_prev_tail: 1 }));
    insertStoryboard(db, sb(3, { link_prev_tail: 2, first_frame_image_id: 77 }));

    const anchored = svc.maybeAutoAnchorPrevTailFrame(db, freshLog(), { storyboardId: 2 });
    try {
      assert.ok(anchored, '承接镜且有上一镜视频时必须抽出首帧');
      assert.equal(fs.existsSync(anchored), true);
      assert.match(path.basename(anchored), /^tailframe_auto_1_to_2_\d+\.jpg$/);
    } finally {
      if (anchored) { try { fs.unlinkSync(anchored); } catch (_) {} }
    }

    // 已绑定首帧的镜（无论 link_prev_tail 写的是几，只要不是 1）不锚定
    assert.equal(svc.maybeAutoAnchorPrevTailFrame(db, freshLog(), { storyboardId: 3 }), null);
  });
});

describe('质量报告里的尾帧衔接统计', () => {
  const { buildStoryboardQualityReport } = require('../src/utils/storyboardQualityReport');

  it('统计承接 / 剪辑点 / 未判定，并说明「承接的会自动接上一镜末帧」', () => {
    const rows = [
      { id: 1, storyboard_number: 1, duration: 5, link_prev_tail: null },
      { id: 2, storyboard_number: 2, duration: 5, link_prev_tail: 1 },
      { id: 3, storyboard_number: 3, duration: 5, link_prev_tail: 0 },
      { id: 4, storyboard_number: 4, duration: 5, link_prev_tail: 1 },
    ];
    const report = buildStoryboardQualityReport({ storyboards: rows });
    assert.equal(report.stats.tail_link_continues, 2);
    assert.equal(report.stats.tail_link_cut, 1);
    assert.equal(report.stats.tail_link_unjudged, 1);
    const tail = report.reasons.find((r) => r.includes('尾帧衔接判定'));
    assert.ok(tail, 'reason 里要说明判定结果');
    assert.match(tail, /自动把上一镜视频的末帧作为本镜首帧/);
    assert.match(tail, /剪辑点.*不会接尾帧/);
    // 说明性信息不能把「均通过」那句挤掉
    assert.ok(report.reasons.some((r) => r.includes('均通过')));
  });

  it('全未判定时不出这一条，结论也不受影响', () => {
    const rows = [{ id: 1, storyboard_number: 1, duration: 5 }, { id: 2, storyboard_number: 2, duration: 5 }];
    const report = buildStoryboardQualityReport({ storyboards: rows });
    assert.equal(report.stats.tail_link_unjudged, 2);
    assert.equal(report.reasons.some((r) => r.includes('尾帧衔接判定')), false);
    assert.equal(report.verdict, 'ok');
  });
});

describe('maybeAutoAnchorPrevTailFrame：不满足条件时静默跳过', () => {
  it('本项目开关关掉 → 返回 null，不抽帧', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO dramas (id, metadata) VALUES (1, ?)').run(JSON.stringify({ auto_tail_frame_link: false }));
    db.prepare('INSERT INTO episodes (id, drama_id) VALUES (1, 1)').run();
    insertStoryboard(db, sb(1, { local_path: 'videos/vg1.mp4' }));
    insertStoryboard(db, sb(2, { link_prev_tail: 1 }));
    assert.equal(svc.maybeAutoAnchorPrevTailFrame(db, freshLog(), { storyboardId: 2 }), null);
  });

  it('上一镜没有可用本地视频 → 返回 null（不挡出片）', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO dramas (id, metadata) VALUES (1, ?)').run(JSON.stringify({}));
    db.prepare('INSERT INTO episodes (id, drama_id) VALUES (1, 1)').run();
    insertStoryboard(db, sb(1));                 // 上一镜还没有视频
    insertStoryboard(db, sb(2, { link_prev_tail: 1 }));
    assert.equal(svc.maybeAutoAnchorPrevTailFrame(db, freshLog(), { storyboardId: 2 }), null);
  });

  it('link_prev_tail = 0（剪辑点）→ 直接跳过，连开关都不读', () => {
    const db = createTestDb();
    insertStoryboard(db, sb(1, { local_path: 'videos/vg1.mp4' }));
    insertStoryboard(db, sb(2, { link_prev_tail: 0 }));
    assert.equal(svc.maybeAutoAnchorPrevTailFrame(db, freshLog(), { storyboardId: 2 }), null);
  });

  it('storyboards 上没有本地视频，但 video_generations 有 completed 记录 → 用它的 local_path', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO dramas (id, metadata) VALUES (1, ?)').run(JSON.stringify({}));
    db.prepare('INSERT INTO episodes (id, drama_id) VALUES (1, 1)').run();
    insertStoryboard(db, sb(1));   // storyboards 未同步视频
    insertStoryboard(db, sb(2, { link_prev_tail: 1 }));
    db.prepare(
      `INSERT INTO video_generations (storyboard_id, status, local_path, video_url, created_at)
       VALUES (1, 'completed', 'projects/p1/videos/vg_1.mp4', 'http://x/1.mp4', '2024-01-01T00:00:00Z')`
    ).run();

    // 视频文件在测试环境不存在 → 抽帧必然失败，但**必须只是返回 null**
    const log = freshLog();
    assert.equal(svc.maybeAutoAnchorPrevTailFrame(db, log, { storyboardId: 2 }), null);
    assert.ok(log.lines.some((l) => l[0] === 'warn' && /自动抽上一镜末帧失败/.test(l[1])), '抽帧失败要记 warn 且静默跳过');
  });
});
