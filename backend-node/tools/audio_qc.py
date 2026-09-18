#!/usr/bin/env python
"""H3 语音质检：转写片段音频，与剧本里应有的 <d> 台词比对，判断人声是否崩坏。

用法:
    audio_qc.py <视频或音频文件> [--expect "应有台词"] [--json]

判定两个指标：
  coverage = 应有台词的字符二元组在转写里出现的比例（读音对得上多少）
  extra    = 转写比应有台词多出来的比例（H3 崩坏时典型表现为"多念一堆听不懂的"）
通过条件：coverage >= 0.72 且 extra <= 0.55
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

try:
    from zhconv import convert as _t2s
except ImportError:  # 繁简转换只是加分项，缺了也能跑
    def _t2s(t, _locale=None):
        return t

MODEL = "openai/whisper-small"
_PIPE = None


def _asr():
    global _PIPE
    if _PIPE is None:
        processor = AutoProcessor.from_pretrained(MODEL)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(MODEL, dtype=torch.float32)
        model.eval()
        _PIPE = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            device=-1,
        )
    return _PIPE


def extract_audio(path):
    if path.lower().endswith(".wav"):
        return path
    out = os.path.join(tempfile.mkdtemp(prefix="h3qc_"), "a.wav")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", out],
        check=True,
    )
    return out


_PUNCT = re.compile(r"[\s，。、！？：；,.!?:;“”\"'（）()《》〈〉—\-…~·]+")
_DIGITS = {"0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
           "5": "五", "6": "六", "7": "七", "8": "八", "9": "九"}


def normalize(text):
    t = str(text or '')
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"\[[^\]]*\]", "", t)
    t = "".join(_DIGITS.get(c, c) for c in t)
    return _PUNCT.sub("", _t2s(t, "zh-cn")).lower()


def bigrams(s):
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def score(expected, transcript):
    exp, hyp = normalize(expected), normalize(transcript)
    if not exp:
        return {"coverage": None, "extra": None, "pass": None,
                "expected": exp, "transcript": hyp}
    eb = bigrams(exp)
    cov = len(eb & bigrams(hyp)) / max(1, len(eb))
    extra = (len(hyp) - len(exp)) / max(1, len(exp))
    return {
        "coverage": round(cov, 3),
        "extra": round(extra, 3),
        "pass": bool(cov >= 0.72 and extra <= 0.55),
        "expected": exp,
        "transcript": hyp,
    }


def transcribe(path):
    out = _asr()(
        extract_audio(path),
        generate_kwargs={
            "language": "zh",
            "task": "transcribe",
            "condition_on_prev_tokens": False,
            "no_repeat_ngram_size": 4,
        },
    )
    return out["text"].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--expect", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    results = []
    for f in args.files:
        hyp = transcribe(f)
        r = {"file": f, "transcript": hyp}
        if args.expect:
            r.update(score(args.expect, hyp))
        results.append(r)
        if not args.json:
            tag = "" if not args.expect else ("PASS ✅" if r["pass"] else "FAIL ❌")
            print("=" * 70)
            print(f"{os.path.basename(f)} {tag}")
            if args.expect:
                print(f"  coverage={r['coverage']} extra={r['extra']}")
                print(f"  应有: {normalize(args.expect)}")
            print(f"  转写: {hyp}")
    if args.json:
        print(json.dumps(results, ensure_ascii=False))
    elif args.expect:
        bad = [r for r in results if not r["pass"]]
        print(f"\n通过 {len(results) - len(bad)}/{len(results)}")
        sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
