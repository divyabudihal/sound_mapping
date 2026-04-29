#!/usr/bin/env python3
import argparse
import csv
import json
import os
import sys
import contextlib
from pathlib import Path
from collections import defaultdict

STEM_EXTS = {'.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aiff', '.aif'}


def normalize_name(name: str) -> str:
    return Path(name).stem.strip().lower().replace('&', 'and').replace('-', '_').replace(' ', '_')


def find_audio_files(folder: Path):
    return [p for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in STEM_EXTS]


def load_region_map(path: Path | None):
    if not path or not path.exists():
        return {}
    if path.suffix.lower() == '.json':
        with open(path) as f:
            raw = json.load(f)
        out = {}
        for k, v in raw.items():
            out[k.strip().lower()] = v
        return out
    mapping = {}
    with open(path, newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = row['style_key'].strip().lower() if row.get('style_key') else row['style'].strip().lower()
            mapping[key] = {
                'region': row.get('region', '').strip(),
                'subregion': row.get('subregion', '').strip(),
                'notes': row.get('notes', '').strip(),
            }
    return mapping


@contextlib.contextmanager
def suppress_stderr(enabled: bool = False):
    if not enabled:
        yield
        return
    old_stderr = sys.stderr
    with open(os.devnull, 'w') as devnull:
        sys.stderr = devnull
        try:
            yield
        finally:
            sys.stderr = old_stderr


def import_essentia():
    try:
        import essentia.standard as es
    except Exception as e:
        raise SystemExit(
            'Essentia is required. Install a TensorFlow-enabled Essentia build.\n'
            'If pip install of essentia-tensorflow fails, build Essentia from source with TensorFlow support.\n'
            f'Import error: {e}'
        )
    return es


def build_models(es, model_dir: Path):
    emb_graph = model_dir / 'discogs-effnet-bs64-1.pb'
    if not emb_graph.exists():
        emb_graph = model_dir / 'discogs-effnet-bs1-1.pb'
    cls_graph = model_dir / 'genre_discogs400-discogs-effnet-1.pb'
    labels_file = model_dir / 'genre_discogs400-discogs-effnet-1.json'

    missing = [str(p) for p in [emb_graph, cls_graph, labels_file] if not p.exists()]
    if missing:
        raise SystemExit(
            'Missing Essentia model files. Download these into your model directory:\n'
            '- discogs-effnet-bs64-1.pb (or discogs-effnet-bs1-1.pb)\n'
            '- genre_discogs400-discogs-effnet-1.pb\n'
            '- genre_discogs400-discogs-effnet-1.json\n'
            f'Missing: {missing}'
        )

    with open(labels_file) as f:
        labels_json = json.load(f)
    labels = labels_json['classes'] if isinstance(labels_json, dict) and 'classes' in labels_json else labels_json

    embedding_model = es.TensorflowPredictEffnetDiscogs(
        graphFilename=str(emb_graph),
        output='PartitionedCall:1'
    )
    classifier_model = es.TensorflowPredict2D(
        graphFilename=str(cls_graph),
        input='serving_default_model_Placeholder',
        output='PartitionedCall:0'
    )
    return embedding_model, classifier_model, labels


def parse_discogs_label(label: str):
    text = str(label).strip()
    if '---' in text:
        parent, child = text.split('---', 1)
        parent = parent.strip()
        child = child.strip()
    else:
        parent = 'Unknown'
        child = text
    style_key = child.lower()
    parent_key = parent.lower()
    combined_key = f'{parent_key}---{style_key}'
    return {
        'raw_label': text,
        'parent_family': parent,
        'style': child,
        'parent_key': parent_key,
        'style_key': style_key,
        'combined_key': combined_key,
    }


def classify_file(es, audio_file: Path, embedding_model, classifier_model, labels, sample_rate: int = 16000):
    audio = es.MonoLoader(filename=str(audio_file), sampleRate=sample_rate)()
    embeddings = embedding_model(audio)
    preds = classifier_model(embeddings)

    if hasattr(preds, 'shape') and len(preds.shape) == 2:
        mean_probs = preds.mean(axis=0)
    else:
        mean_probs = preds

    results = []
    for label, prob in zip(labels, mean_probs):
        parsed = parse_discogs_label(label)
        results.append({
            **parsed,
            'probability': float(prob),
        })
    results.sort(key=lambda x: x['probability'], reverse=True)
    return results


def aggregate_regions(results, region_map):
    reg = defaultdict(float)
    detailed = []
    for item in results:
        mapped = region_map.get(item['combined_key']) or region_map.get(item['style_key']) or {}
        region = mapped.get('region', '')
        if region:
            reg[region] += item['probability']
        detailed.append({
            **item,
            'region': mapped.get('region', ''),
            'subregion': mapped.get('subregion', ''),
            'notes': mapped.get('notes', ''),
        })
    region_scores = [{'region': k, 'score': v} for k, v in sorted(reg.items(), key=lambda x: x[1], reverse=True)]
    return region_scores, detailed


def aggregate_style_totals(results):
    by_style = defaultdict(float)
    by_parent = defaultdict(float)
    style_parent_breakdown = defaultdict(lambda: defaultdict(float))

    for item in results:
        by_style[item['style']] += item['probability']
        by_parent[item['parent_family']] += item['probability']
        style_parent_breakdown[item['style']][item['parent_family']] += item['probability']

    style_totals = [
        {
            'style': style,
            'total_probability': prob,
            'parent_breakdown': [
                {'parent_family': parent, 'probability': p}
                for parent, p in sorted(parents.items(), key=lambda x: x[1], reverse=True)
            ]
        }
        for style, (prob, parents) in (
            (style, (prob, style_parent_breakdown[style])) for style, prob in by_style.items()
        )
    ]
    style_totals.sort(key=lambda x: x['total_probability'], reverse=True)

    parent_totals = [
        {'parent_family': parent, 'total_probability': prob}
        for parent, prob in sorted(by_parent.items(), key=lambda x: x[1], reverse=True)
    ]
    return style_totals, parent_totals


def weighted_song_profile(stem_outputs):
    weights = {
        'drums': 1.0,
        'bass': 0.9,
        'vocals': 1.0,
        'guitar': 0.8,
        'keys': 0.8,
        'wind': 0.8,
        'horns': 0.8,
    }
    agg = defaultdict(float)
    total_w = 0.0
    for stem_name, genres in stem_outputs.items():
        w = weights.get(stem_name, 0.75)
        total_w += w
        for g in genres:
            agg[g['raw_label']] += g['probability'] * w
    if total_w == 0:
        return []

    out = []
    for raw_label, prob in agg.items():
        parsed = parse_discogs_label(raw_label)
        out.append({**parsed, 'probability': prob / total_w})
    out.sort(key=lambda x: x['probability'], reverse=True)
    return out


def build_atlas_regions(stem_outputs_detailed, per_stem_limit=8):
    regions = []
    for stem, detailed_preds in stem_outputs_detailed.items():
        for p in detailed_preds[:per_stem_limit]:
            regions.append({
                'id': f'{stem}__{p["style_key"].replace(" ", "_")}__{p["parent_key"].replace(" ", "_")}',
                'stem': stem,
                'parent_family': p['parent_family'],
                'style': p['style'],
                'raw_label': p['raw_label'],
                'score': round(p['probability'], 6),
                'region': p.get('region', ''),
                'subregion': p.get('subregion', ''),
                'notes': p.get('notes', ''),
                'active_if_stems': [stem],
            })
    return regions


def nested_parent_child(items, top_k=12):
    out = []
    for item in items[:top_k]:
        out.append({
            'parent_family': item['parent_family'],
            'style': item['style'],
            'raw_label': item['raw_label'],
            'probability': round(item['probability'], 6),
        })
    return out


def main():
    parser = argparse.ArgumentParser(description='Classify stems and optional full mix with Essentia Discogs400 and store hierarchical parent/style outputs.')
    parser.add_argument('--stems-dir', default='stems', help='Folder containing stem audio files')
    parser.add_argument('--full-mix', default=None, help='Optional full-song audio file to classify separately')
    parser.add_argument('--model-dir', default='models/essentia', help='Folder containing Essentia .pb and labels files')
    parser.add_argument('--output-dir', default='analysis_output', help='Output folder')
    parser.add_argument('--top-k', type=int, default=12, help='Top K classifications to retain per file')
    parser.add_argument('--region-map', default='genre_region_map.csv', help='CSV or JSON mapping style/style_key to regions')
    parser.add_argument('--quiet', action='store_true', help='Suppress noisy library warnings written to stderr during model inference')
    args = parser.parse_args()

    stems_dir = Path(args.stems_dir)
    model_dir = Path(args.model_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    full_mix_file = Path(args.full_mix) if args.full_mix else None
    if full_mix_file and not full_mix_file.exists():
        raise SystemExit(f'Full mix file not found: {full_mix_file}')
    if not stems_dir.exists():
        raise SystemExit(f'Stems directory not found: {stems_dir}')

    stem_files = find_audio_files(stems_dir)
    if not stem_files:
        raise SystemExit(f'No audio stems found in {stems_dir}')

    region_map = load_region_map(Path(args.region_map))
    es = import_essentia()
    with suppress_stderr(args.quiet):
        embedding_model, classifier_model, labels = build_models(es, model_dir)

    stem_outputs = {}
    stem_outputs_detailed = {}
    full_mix_top_preds = []
    full_mix_region_scores = []
    full_mix_style_totals = []
    full_mix_parent_totals = []

    if full_mix_file:
        with suppress_stderr(args.quiet):
            full_mix_predictions = classify_file(es, full_mix_file, embedding_model, classifier_model, labels)
        full_mix_top_preds = full_mix_predictions[:args.top_k]
        full_mix_region_scores, full_mix_detailed = aggregate_regions(full_mix_top_preds, region_map)
        full_mix_style_totals, full_mix_parent_totals = aggregate_style_totals(full_mix_top_preds)
        with open(output_dir / 'full_mix_top_genres.json', 'w') as f:
            json.dump({
                'file': str(full_mix_file),
                'top_classifications': full_mix_detailed,
                'style_totals': full_mix_style_totals,
                'parent_totals': full_mix_parent_totals,
                'region_scores': full_mix_region_scores,
            }, f, indent=2)

    stem_style_totals = {}
    stem_parent_totals = {}

    for stem_file in stem_files:
        stem_id = normalize_name(stem_file.name)
        with suppress_stderr(args.quiet):
            predictions = classify_file(es, stem_file, embedding_model, classifier_model, labels)
        top_preds = predictions[:args.top_k]
        region_scores, detailed_preds = aggregate_regions(top_preds, region_map)
        style_totals, parent_totals = aggregate_style_totals(top_preds)
        stem_outputs[stem_id] = top_preds
        stem_outputs_detailed[stem_id] = detailed_preds
        stem_style_totals[stem_id] = style_totals
        stem_parent_totals[stem_id] = parent_totals

        with open(output_dir / f'{stem_id}_top_genres.json', 'w') as f:
            json.dump({
                'stem': stem_id,
                'file': str(stem_file),
                'top_classifications': detailed_preds,
                'style_totals': style_totals,
                'parent_totals': parent_totals,
                'region_scores': region_scores,
            }, f, indent=2)

    stem_aggregate_profile = weighted_song_profile(stem_outputs)
    stem_aggregate_region_scores, stem_aggregate_detailed = aggregate_regions(stem_aggregate_profile[:args.top_k], region_map)
    stem_aggregate_style_totals, stem_aggregate_parent_totals = aggregate_style_totals(stem_aggregate_profile[:args.top_k])
    atlas_regions = build_atlas_regions(stem_outputs_detailed)

    app_payload = {
        'song': {
            'title': 'REPLACE_ME',
            'artist': 'REPLACE_ME',
            'year': None,
            'country': 'REPLACE_ME',
            'movement': 'REPLACE_ME',
            'summary': 'REPLACE_ME',
            'why_meaningful': 'REPLACE_ME'
        },
        'audio': {
            'full_mix': str(full_mix_file) if full_mix_file else None,
            'stems_dir': str(stems_dir),
            'stems': [
                {
                    'id': normalize_name(p.name),
                    'label': Path(p.name).stem.replace('_', ' ').title(),
                    'file': str(p)
                }
                for p in stem_files
            ]
        },
        'analysis': {
            'baseline_source': 'full_mix' if full_mix_top_preds else 'stem_aggregate',
            'full_mix_classifications': nested_parent_child(full_mix_top_preds, top_k=args.top_k),
            'full_mix_style_totals': full_mix_style_totals,
            'full_mix_parent_totals': full_mix_parent_totals,
            'full_mix_region_probs': {item['region']: round(item['score'], 6) for item in full_mix_region_scores},
            'stem_aggregate_classifications': nested_parent_child(stem_aggregate_profile, top_k=args.top_k),
            'stem_aggregate_style_totals': stem_aggregate_style_totals,
            'stem_aggregate_parent_totals': stem_aggregate_parent_totals,
            'stem_aggregate_region_probs': {item['region']: round(item['score'], 6) for item in stem_aggregate_region_scores},
            'song_classifications': nested_parent_child(full_mix_top_preds if full_mix_top_preds else stem_aggregate_profile, top_k=args.top_k),
            'song_style_totals': full_mix_style_totals if full_mix_top_preds else stem_aggregate_style_totals,
            'song_parent_totals': full_mix_parent_totals if full_mix_top_preds else stem_aggregate_parent_totals,
            'region_probs': {
                item['region']: round(item['score'], 6)
                for item in (full_mix_region_scores if full_mix_region_scores else stem_aggregate_region_scores)
            },
            'stem_classifications': {
                stem: nested_parent_child(preds, top_k=args.top_k)
                for stem, preds in stem_outputs.items()
            },
            'stem_style_totals': stem_style_totals,
            'stem_parent_totals': stem_parent_totals,
            'stem_region_probs': {
                stem: {item['region']: round(item['score'], 6) for item in aggregate_regions(preds[:args.top_k], region_map)[0]}
                for stem, preds in stem_outputs.items()
            },
            'atlas_regions': atlas_regions
        }
    }

    with open(output_dir / 'song_analysis_for_app.json', 'w') as f:
        json.dump(app_payload, f, indent=2)

    with open(output_dir / 'all_stems_top_genres.csv', 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['stem', 'parent_family', 'style', 'raw_label', 'probability', 'region', 'subregion', 'notes'])
        writer.writeheader()
        for stem, detailed in stem_outputs_detailed.items():
            for row in detailed[:args.top_k]:
                writer.writerow({
                    'stem': stem,
                    'parent_family': row['parent_family'],
                    'style': row['style'],
                    'raw_label': row['raw_label'],
                    'probability': row['probability'],
                    'region': row.get('region', ''),
                    'subregion': row.get('subregion', ''),
                    'notes': row.get('notes', '')
                })

    if not Path(args.region_map).exists():
        with open(output_dir / 'genre_region_map_template.csv', 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['style_key', 'region', 'subregion', 'notes'])
            writer.writerow(['afrobeat', 'West Africa', 'Nigeria/Ghana', 'Canonical geographic anchor for Afrobeat'])
            writer.writerow(['highlife', 'West Africa', 'Ghana/Nigeria', ''])
            writer.writerow(['cumbia', 'Latin America', 'Colombia/Andean region', ''])
            writer.writerow(['trap', 'North America', 'United States', ''])

    print(f'Processed {len(stem_files)} stems from {stems_dir}')
    if full_mix_file:
        print(f'Also classified full mix: {full_mix_file}')
    print(f'Wrote app-ready JSON to {output_dir / "song_analysis_for_app.json"}')
    print(f'Wrote CSV summary to {output_dir / "all_stems_top_genres.csv"}')
    if not Path(args.region_map).exists():
        print(f'Created template region map at {output_dir / "genre_region_map_template.csv"}')


if __name__ == '__main__':
    main()
