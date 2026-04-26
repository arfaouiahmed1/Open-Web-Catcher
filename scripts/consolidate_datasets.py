import csv
from pathlib import Path

DATASETS_DIR = Path("datasets")
out_rows = []
seen = set()
idx = 1

for csv_file in sorted(DATASETS_DIR.rglob("*.csv")):
    if csv_file.name == "sites.csv" and csv_file.parent == DATASETS_DIR:
        continue  # skip output file if it exists
    with open(csv_file, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            url = row.get('url', '').strip()
            if not url or url in seen:
                continue
            seen.add(url)
            out_rows.append({'id': idx, 'url': url, 'language': '', 'label': '', 'notes': ''})
            idx += 1

out_file = DATASETS_DIR / 'sites.csv'
with open(out_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=['id', 'url', 'language', 'label', 'notes'])
    writer.writeheader()
    writer.writerows(out_rows)

print(f"Wrote {len(out_rows)} sites to {out_file}")
