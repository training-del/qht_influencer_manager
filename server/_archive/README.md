# Archive

`schema.sql.superseded` was the single-file schema the app ran off before
versioned migrations existed. It is kept only so the original wording of the
comments is recoverable; nothing reads it.

The schema now lives in `server/migrations/`, applied in filename order and
recorded in the `schema_migrations` table. To change it, add the next numbered
file — never edit one that has already run.
