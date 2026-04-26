#!/usr/bin/env python3
"""Reorganize CSV datasets into language and size categories."""

import csv
from pathlib import Path
from typing import List, Dict, Tuple

DATASETS_DIR = Path("datasets")

def read_csv(filepath: Path) -> List[Dict]:
    """Read CSV file and return list of dicts."""
    rows = []
    try:
        with open(filepath, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
    return rows

def get_url_column(row: Dict) -> str:
    """Extract URL from different column names."""
    for key in ['URL', 'url', 'website_url']:
        if key in row:
            return row[key].strip()
    return ""

def detect_language(urls: List[str]) -> str:
    """Detect primary language from URLs (simple heuristic)."""
    arabic_keywords = ['yalla', 'koora', 'kora', 'shoot', 'mena', 'arab', 'arabic']
    spanish_keywords = ['es', 'es-', 'español']

    arabic_count = sum(1 for url in urls if any(kw in url.lower() for kw in arabic_keywords))

    if arabic_count > len(urls) * 0.3:
        return 'arabic'
    elif any(kw in ' '.join(urls).lower() for kw in spanish_keywords):
        return 'spanish'
    return 'english'

def categorize_by_size(count: int) -> str:
    """Categorize dataset by size."""
    if count <= 20:
        return 'small'
    elif count <= 100:
        return 'medium'
    else:
        return 'large'

def write_csv(filepath: Path, rows: List[Dict], fieldnames: List[str]):
    """Write CSV file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

def reorganize_datasets():
    """Reorganize all datasets."""
    # Collect all URLs
    all_rows = []
    all_urls = []

    for csv_file in DATASETS_DIR.glob("*.csv"):
        if csv_file.name.startswith('.'):
            continue
        rows = read_csv(csv_file)
        print(f"Read {len(rows)} rows from {csv_file.name}")
        all_rows.extend(rows)
        all_urls.extend([get_url_column(row) for row in rows if get_url_column(row)])

    # Detect overall language
    language = detect_language(all_urls)
    print(f"Detected language: {language}")

    # Categorize by size
    size = categorize_by_size(len(all_rows))
    print(f"Dataset size: {size} ({len(all_rows)} sites)")

    # Write to appropriate location
    output_dir = DATASETS_DIR / language / size
    output_file = output_dir / "sites.csv"

    # Standardize to just URL column
    standardized = []
    for row in all_rows:
        url = get_url_column(row)
        if url:
            standardized.append({'id': row.get('id', ''), 'url': url})

    write_csv(output_file, standardized, fieldnames=['id', 'url'])
    print(f"Wrote {len(standardized)} sites to {output_file}")

    # Create a manifest
    manifest = {
        'language': language,
        'size': size,
        'count': len(standardized),
        'files': [str(output_file)]
    }

    return manifest

if __name__ == '__main__':
    reorganize_datasets()
