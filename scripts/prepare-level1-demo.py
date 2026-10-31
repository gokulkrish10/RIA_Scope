#!/usr/bin/env python3
"""Build a clean, offline Level 1 presentation copy from saved verified runs.

The input databases and the operator's existing demo database are never modified.
This script makes no HTTP or model requests and refuses to overwrite its output.
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".data"
RBI = DATA / "rbi-history-repair"
REGIONS = DATA / "level1-four-region-VQTKb9"
GHANA = DATA / "level1-four-region-kK9YbO"

# These IDs are from the saved official-source verification reports. Keep only
# records with a completed, citation-validated structured analysis.
SELECTION = (
    (RBI, (
        "3ca2dc23-a70f-4725-abb2-d019c3cbf915",  # RBI 2022
        "1d94a2af-7aeb-447a-906a-cf86ca79f35d",  # RBI 2024
    )),
    (REGIONS, (
        "3f232dcc-4661-43c3-a6ea-186b962c2b4d",  # SAMA
        "71bb9976-c0c6-447b-a89a-076139414244",  # DFSA
        "58fc02a8-f8ba-457f-822c-b2584d6110a6",  # RBI listing
        "ffb8a9a0-24f3-4f90-b881-bc7e6ea136ad",  # CBK
    )),
    (GHANA, (
        "3b98e8a9-0ff1-4268-b918-33dba3d1e259",  # BoG notice
    )),
)


def row(connection, table, field, value):
    result = connection.execute(f"SELECT * FROM {table} WHERE {field}=?", (value,)).fetchone()
    if result is None:
        raise ValueError(f"Missing verified {table} record: {value}")
    return result


def insert(connection, table, value):
    columns = value.keys()
    connection.execute(
        f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
        tuple(value),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DATA / "level1-demo")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error(f"Output already exists; no files were changed: {output}")
    for source, _ in SELECTION:
        if not (source / "ria.sqlite").is_file():
            parser.error(f"Missing saved verification database: {source / 'ria.sqlite'}")
    staging = output.with_name(f".{output.name}.building-{os.getpid()}")
    staging.mkdir(mode=0o700, parents=True)
    try:
        with closing(sqlite3.connect(f"file:{RBI / 'ria.sqlite'}?mode=ro", uri=True)) as baseline:
            with closing(sqlite3.connect(staging / "ria.sqlite")) as destination:
                baseline.backup(destination)  # SQLite-consistent snapshot, including WAL.
                destination.execute("PRAGMA foreign_keys=OFF")
                tables = [r[0] for r in destination.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'"
                )]
                for table in tables:
                    destination.execute(f"DELETE FROM {table}")
                destination.commit()
                destination.execute("PRAGMA foreign_keys=ON")
                originals = staging / "originals"
                originals.mkdir(mode=0o700)
                manifest = []
                inserted_sources = set()
                for source, publication_ids in SELECTION:
                    with closing(sqlite3.connect(f"file:{source / 'ria.sqlite'}?mode=ro", uri=True)) as origin:
                        origin.row_factory = sqlite3.Row
                        for publication_id in publication_ids:
                            publication = row(origin, "publications", "id", publication_id)
                            version = row(origin, "document_versions", "id", publication["current_version_id"])
                            analysis = row(origin, "version_analysis", "version_id", version["id"])
                            if analysis["state"] != "succeeded" or not analysis["public_json"]:
                                raise ValueError(f"Publication lacks completed structured analysis: {publication_id}")
                            source_id = publication["source_id"]
                            if source_id not in inserted_sources:
                                insert(destination, "sources", row(origin, "sources", "id", source_id))
                                inserted_sources.add(source_id)
                            insert(destination, "publications", publication)
                            insert(destination, "document_versions", version)
                            insert(destination, "version_analysis", analysis)
                            key = version["original_key"]
                            raw = (source / "originals" / key).read_bytes()
                            if hashlib.sha256(raw).hexdigest() != key:
                                raise ValueError(f"Original integrity check failed: {publication_id}")
                            if not (originals / key).exists():
                                (originals / key).write_bytes(raw)
                                (originals / key).chmod(0o600)
                            discovery = json.loads(publication["discovery_json"])
                            manifest.append({
                                "publicationId": publication_id,
                                "title": discovery["title"],
                                "country": discovery["country"],
                                "sourceUrl": discovery["sourceUrl"],
                                "versionId": version["id"],
                                "savedEvidenceDirectory": source.name,
                            })
                        if source == RBI:
                            for job in origin.execute("SELECT * FROM analysis_jobs WHERE state='succeeded'"):
                                insert(destination, "analysis_jobs", job)
                            for comparison in origin.execute("SELECT * FROM comparisons"):
                                insert(destination, "comparisons", comparison)
                            for link in origin.execute("SELECT * FROM predecessor_links"):
                                insert(destination, "predecessor_links", link)
                destination.commit()
                violations = destination.execute("PRAGMA foreign_key_check").fetchall()
                if violations:
                    raise ValueError(f"Presentation database has {len(violations)} foreign-key violations")
                if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Presentation database integrity check failed")
                destination.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                (staging / "ria.sqlite").chmod(0o600)
                (staging / "manifest.json").write_text(json.dumps({
                    "label": "Saved official-source Level 1 presentation evidence; model findings await human review",
                    "publications": manifest,
                    "historicalComparisonId": "5dda2072-ce8b-4dbf-b152-2939f5c6e5ee",
                }, indent=2) + "\n")
        staging.rename(output)
        print(f"Created {output}: {len(manifest)} real publications, {len(inserted_sources)} sources, 1 saved RBI comparison.")
        print("No synthetic uploads, failed extraction records, monitoring jobs, HTTP requests or Bedrock calls were included.")
    except BaseException:
        shutil.rmtree(staging)
        raise


if __name__ == "__main__":
    main()
