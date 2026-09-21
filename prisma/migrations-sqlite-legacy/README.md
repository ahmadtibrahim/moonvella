# Retired SQLite migrations

These migrations were generated against the original SQLite datasource
(`provider = "sqlite"`, `url = "file:dev.sqlite"`). They contain SQLite-specific
type syntax (DATETIME, TEXT PRIMARY KEY, AUTOINCREMENT) and CANNOT be applied to
PostgreSQL.

They are retained for historical reference only. The production baseline for
PostgreSQL lives in ../migrations/.

Do not move these back into ../migrations/.
