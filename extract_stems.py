#!/usr/bin/env python3
"""
Extracts stems from zombie.mp3 using the AudioShake API.
Run once before starting app.py.

Usage:
    python extract_stems.py [path_to_mp3]

Saves stems to ./stems/  e.g. stems/vocals.mp3, stems/drums.mp3 ...
"""

import os
import sys
import json
import time
import requests

API_KEY = os.environ.get('AUDIOSHAKE_API_KEY')
if not API_KEY:
    sys.exit("Error: AUDIOSHAKE_API_KEY environment variable not set.")

BASE_URL = 'https://api.audioshake.ai'
HEADERS = {'x-api-key': API_KEY}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MP3 = '/Users/divyabudihal/Downloads/zombie.mp3'
STEMS_DIR = os.path.join(SCRIPT_DIR, 'stems')
TASK_CACHE = os.path.join(SCRIPT_DIR, '.task_cache.json')

STEM_MODELS = ['vocals', 'drums', 'bass', 'wind', 'guitar', 'keys']
POLL_INTERVAL = 15  # seconds


def upload_asset(filepath):
    print(f"Uploading {os.path.basename(filepath)} ({os.path.getsize(filepath) // 1024 // 1024} MB)...")
    with open(filepath, 'rb') as f:
        resp = requests.post(
            f'{BASE_URL}/assets',
            headers=HEADERS,
            files={'file': (os.path.basename(filepath), f, 'audio/mpeg')},
            timeout=300,
        )
    resp.raise_for_status()
    asset = resp.json()
    print(f"  Asset ID: {asset['id']}")
    return asset['id']


def create_task(asset_id):
    print(f"Creating stem separation task for: {STEM_MODELS}")
    targets = [{'model': m, 'formats': ['mp3']} for m in STEM_MODELS]
    resp = requests.post(
        f'{BASE_URL}/tasks',
        headers={**HEADERS, 'Content-Type': 'application/json'},
        json={'assetId': asset_id, 'targets': targets},
        timeout=30,
    )
    resp.raise_for_status()
    task = resp.json()
    print(f"  Task ID: {task['id']}")
    return task


def poll_task(task_id):
    print(f"Polling (every {POLL_INTERVAL}s) — this takes several minutes for a 12-min track...")
    attempt = 0
    while True:
        attempt += 1
        resp = requests.get(f'{BASE_URL}/tasks/{task_id}', headers=HEADERS, timeout=30)
        resp.raise_for_status()
        task = resp.json()

        targets = task.get('targets', [])
        status_parts = [f"{t.get('model','?')}:{t.get('status','?')}" for t in targets]
        completed = sum(1 for t in targets if t.get('status') == 'completed')
        print(f"  [{attempt:>3}] {completed}/{len(targets)} done — {', '.join(status_parts)}")

        if all(t.get('status') == 'completed' for t in targets):
            print("All stems completed!")
            return task
        if any(t.get('status') == 'failed' for t in targets):
            failed = [t.get('model') for t in targets if t.get('status') == 'failed']
            raise RuntimeError(f"Stem separation failed for: {failed}")

        time.sleep(POLL_INTERVAL)


def download_stems(task):
    os.makedirs(STEMS_DIR, exist_ok=True)
    for target in task.get('targets', []):
        model = target.get('model', 'unknown')
        outputs = target.get('output', [])
        downloaded = False
        for output in outputs:
            if output.get('format') == 'mp3':
                url = output.get('link')
                if not url:
                    continue
                print(f"  Downloading {model}.mp3...")
                resp = requests.get(url, timeout=120)
                resp.raise_for_status()
                filepath = os.path.join(STEMS_DIR, f'{model}.mp3')
                with open(filepath, 'wb') as f:
                    f.write(resp.content)
                size_kb = len(resp.content) // 1024
                print(f"    Saved {filepath} ({size_kb} KB)")
                downloaded = True
                break
        if not downloaded:
            print(f"  Warning: no mp3 output found for {model}")


def stems_complete():
    return all(
        os.path.exists(os.path.join(STEMS_DIR, f'{m}.mp3'))
        for m in STEM_MODELS
    )


def main():
    mp3_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MP3

    if not os.path.exists(mp3_path):
        sys.exit(f"Error: MP3 not found at {mp3_path}")

    if stems_complete():
        print("All stems already exist in stems/. Nothing to do.")
        print("Run: python app.py")
        return

    # Resume from cached task if available
    task_id = None
    if os.path.exists(TASK_CACHE):
        with open(TASK_CACHE) as f:
            cache = json.load(f)
        task_id = cache.get('task_id')
        print(f"Resuming cached task: {task_id}")

    if not task_id:
        asset_id = upload_asset(mp3_path)
        task = create_task(asset_id)
        task_id = task['id']
        with open(TASK_CACHE, 'w') as f:
            json.dump({'task_id': task_id, 'asset_id': asset_id}, f)

    task = poll_task(task_id)
    download_stems(task)

    if os.path.exists(TASK_CACHE):
        os.remove(TASK_CACHE)

    print(f"\nDone! Stems in: {STEMS_DIR}/")
    print("Start the app with: python app.py")


if __name__ == '__main__':
    main()
