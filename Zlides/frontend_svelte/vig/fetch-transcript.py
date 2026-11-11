#!/usr/bin/env python3
"""
VIG Transcript Fetcher — pulls real YouTube transcripts with correct timestamps.

Usage:
  uv run --with youtube-transcript-api fetch-transcript.py \
    --video <VIDEO_ID> --out transcript.json [--fallback manual.json] [--lang en]

Defaults to YouTube-fetched real timestamps. If fetch fails (offline, no captions,
restricted video), falls back to the manual JSON via --fallback.
"""
import argparse
import json
import os
import sys


def fetch_transcript(video_id: str, language: str = "en") -> list:
    from youtube_transcript_api import YouTubeTranscriptApi
    api = YouTubeTranscriptApi()
    fetched = api.fetch(video_id, languages=[language])
    cues = []
    for i, snippet in enumerate(fetched):
        start = round(snippet.start, 2)
        end = round(fetched[i + 1].start, 2) if i + 1 < len(fetched) else round(start + 3.0, 2)
        text = snippet.text.strip()
        if text:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def main():
    parser = argparse.ArgumentParser(description="Fetch real YouTube transcript for VIG")
    parser.add_argument("--video", required=True, help="YouTube video ID")
    parser.add_argument("--out", required=True, help="Output transcript.json path")
    parser.add_argument("--fallback", default=None, help="Manual transcript.json to use if fetch fails")
    parser.add_argument("--lang", default="en", help="Language code (default: en)")
    args = parser.parse_args()

    source = "youtube"
    cues = None
    try:
        cues = fetch_transcript(args.video, args.lang)
        print(f"✓ YouTube: {len(cues)} real-timestamp cues")
    except Exception as e:
        print(f"⚠ YouTube fetch failed: {e}", file=sys.stderr)
        if args.fallback and os.path.exists(args.fallback):
            with open(args.fallback) as f:
                cues = json.load(f)
            source = "manual-fallback"
            print(f"✓ Fallback: {len(cues)} cues from {args.fallback}")
        else:
            print("✗ No fallback provided and fetch failed.", file=sys.stderr)
            sys.exit(1)

    output = {
        "_source": source,
        "_video_id": args.video,
        "_fetched_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "cues": cues
    }
    with open(args.out, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"✓ {len(cues)} cues ({source}) → {args.out}")


if __name__ == "__main__":
    main()
