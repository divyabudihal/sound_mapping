#!/usr/bin/env python3
"""Flask server for the Zombie stem explorer."""

import os
import json
from flask import Flask, send_from_directory, jsonify

app = Flask(__name__, static_folder='static')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STEMS_DIR = os.path.join(SCRIPT_DIR, 'stems')
STEM_MODELS = ['vocals', 'drums', 'bass', 'wind', 'guitar', 'keys']


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)


@app.route('/stems/<path:filename>')
def serve_stem(filename):
    return send_from_directory(STEMS_DIR, filename)


@app.route('/api/stems')
def api_stems():
    available = [m for m in STEM_MODELS
                 if os.path.exists(os.path.join(STEMS_DIR, f'{m}.mp3'))]
    sizes = {}
    for m in available:
        path = os.path.join(STEMS_DIR, f'{m}.mp3')
        sizes[m] = os.path.getsize(path)
    return jsonify({'stems': available, 'sizes': sizes})


ANALYSIS_FILE = os.path.join(SCRIPT_DIR, 'analysis_output', 'song_analysis_for_app.json')


@app.route('/api/analysis')
def api_analysis():
    with open(ANALYSIS_FILE, 'r') as f:
        return jsonify(json.load(f))


if __name__ == '__main__':
    print("Zombie Stem Explorer — http://localhost:5001")
    app.run(debug=True, port=5001)
