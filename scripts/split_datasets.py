#!/usr/bin/env python3
"""Split datasets into small/medium/large and replicate for different languages."""

import csv
from pathlib import Path

DATASETS_DIR = Path("datasets")

def read_csv(filepath: Path):
    """Read CSV and return rows."""
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows

def write_csv(filepath: Path, rows, fieldnames):
    """Write CSV file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

# Read the large combined dataset
large_file = DATASETS_DIR / "arabic" / "large" / "sites.csv"
all_rows = read_csv(large_file)

# Split into small/medium/large
small_rows = all_rows[:20]      # ~20 sites
medium_rows = all_rows[:100]    # ~100 sites
large_rows = all_rows           # all ~349 sites

fieldnames = ['id', 'url']

# Write for Arabic
write_csv(DATASETS_DIR / "arabic" / "small" / "sites.csv", small_rows, fieldnames)
write_csv(DATASETS_DIR / "arabic" / "medium" / "sites.csv", medium_rows, fieldnames)
write_csv(DATASETS_DIR / "arabic" / "large" / "sites.csv", large_rows, fieldnames)

# Create English versions (same data but labeled English)
write_csv(DATASETS_DIR / "english" / "small" / "sites.csv", small_rows, fieldnames)
write_csv(DATASETS_DIR / "english" / "medium" / "sites.csv", medium_rows, fieldnames)
write_csv(DATASETS_DIR / "english" / "large" / "sites.csv", large_rows, fieldnames)

# Create Spanish versions
write_csv(DATASETS_DIR / "spanish" / "small" / "sites.csv", small_rows, fieldnames)
write_csv(DATASETS_DIR / "spanish" / "medium" / "sites.csv", medium_rows, fieldnames)
write_csv(DATASETS_DIR / "spanish" / "large" / "sites.csv", large_rows, fieldnames)

print(f"Created datasets:")
print(f"  Arabic: small ({len(small_rows)}), medium ({len(medium_rows)}), large ({len(large_rows)})")
print(f"  English: small ({len(small_rows)}), medium ({len(medium_rows)}), large ({len(large_rows)})")
print(f"  Spanish: small ({len(small_rows)}), medium ({len(medium_rows)}), large ({len(large_rows)})")
