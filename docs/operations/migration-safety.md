# Migration Safety

Operational rules for running Alembic migrations against Open Web Catcher
databases. The chain head is `c69a9ee239fd`; revisions `20260407_0001` and
`20260407_0002` carry explicit DDL, so `alembic upgrade head` builds the full
schema deterministically instead of mirroring `src/storage/models.py` through
`create_all`.

## Hard precondition: pg_dump before touching real data

Never run `alembic upgrade head` (or any individual migration) against a
PostgreSQL database holding real evidence without a fresh backup first:

```bash
pg_dump -h <host> -U owc -d owc -Fc -f owc_pre_migration_$(date +%Y%m%d_%H%M%S).dump
```

A failed migration on PostgreSQL can leave the schema half-migrated inside the
aborted transaction boundary; restoring from dump is the only clean recovery.
If a migration fails mid-chain, stop, restore, and fix forward — do not retry
against a mutated schema.

## Rehearse on a copy first

Rehearse every upgrade path on a throwaway copy before production:

```bash
# 1. Restore the latest dump into an empty scratch database
createdb -h <host> -U owc owc_rehearsal
pg_restore -h <host> -U owc -d owc_rehearsal owc_pre_migration_<ts>.dump

# 2. Point DATABASE_URL at the copy and upgrade
export DATABASE_URL=postgresql+psycopg2://owc:<password>@localhost:5432/owc_rehearsal
uv run alembic upgrade head      # first run: applies pending revisions
uv run alembic upgrade head      # second run must be a no-op (idempotency check)

# 3. Smoke the app against the copy, then discard it
dropdb -h <host> -U owc owc_rehearsal
```

The second `upgrade head` printing zero `Running upgrade ...` lines is the
acceptance signal. For a from-empty rehearsal, the same commands work on an
empty database; the full chain 0001 -> `c69a9ee239fd` has been verified to
apply cleanly from empty PostgreSQL and empty SQLite.

## Stamp strategy for legacy drifted databases

Revision IDs are preserved verbatim across the rewrite of
`20260407_0001`, `20260407_0002`, and `c69a9ee239fd`, so existing
`alembic_version` stamps remain valid — no re-stamping is needed for databases
that completed the old chain.

Legacy databases that were migrated under the old decorative chain can be
drifted: their schema was built by `create_all` at whatever point
`src/storage/models.py` stood then, and the old head revision crashed before
stamping. For such databases:

1. Compare the live schema against current metadata:
   `uv run alembic revision --autogenerate -m drift_check` (inspect, then
   delete the generated file).
2. If the schema already matches current models, stamp directly to head
   instead of replaying DDL:

   ```bash
   uv run alembic stamp c69a9ee239fd
   ```

3. If columns are missing, bring them in line with guarded migrations or a
   reviewed hand-written revision, then stamp.

Never `stamp head` blindly on a drifted database; stamp only after the drift
check shows parity.

## Known blocker: explicit commits in 0007/0008 (PostgreSQL)

`20260426_0007_seed_dataset_sites.py` and
`20260426_0008_import_sites_csv.py` call `connection.commit()` inside
`upgrade()`. On PostgreSQL this commits Alembic's outer transaction early;
everything after the last manual commit — including later DDL and the
`alembic_version` updates — is rolled back when the connection closes. Observed
symptoms: `upgrade head` exits 0 but `alembic_version` stalls at
`20260426_0007`, and every subsequent run replays 0008 -> head without ever
advancing the stamp. SQLite masks the bug because its driver runs with
non-transactional DDL semantics.

Fix (one line per file, both occurrences): delete the
`connection.commit()` calls and let Alembic own transaction boundaries. Until
that lands, treat PostgreSQL upgrades that cross revisions 0007/0008 as
unreliable and rehearse explicitly.

## Parity check recipe

After changing `src/storage/models.py` or adding a revision, prove the chain
still ends exactly at model metadata:

```bash
cp alembic.ini _migcheck.ini   # set sqlalchemy.url = sqlite:///./data/_migcheck.db
uv run alembic -c _migcheck.ini upgrade head
uv run alembic -c _migcheck.ini revision --autogenerate -m parity_check --rev-id _parity_check
```

The generated `alembic/versions/_parity_check*.py` must contain only `pass`
in `upgrade()` and `downgrade()`. Delete the generated revision, `_migcheck.ini`,
and `data/_migcheck.db*` afterwards.
