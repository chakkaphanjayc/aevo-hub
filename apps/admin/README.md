# Transitional Admin workspace

The canonical Aevo Admin web/BFF now lives in the standalone sibling repository
at `/Users/jayc/Project/aevo-admin` and is intended to deploy independently.

This workspace is retained temporarily for rollback and comparison while the
standalone deployment is validated. New Admin UI work should land in
`aevo-admin`; the Core API and privileged `/api/v1/admin/*` handlers remain in
this repository as the source of truth.
