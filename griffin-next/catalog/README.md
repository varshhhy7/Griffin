# Capability catalog

`catalog/sources/` contains imported scientific skills and recipes. Catalog
content is not the same as core Griffin runtime code.

When adding or changing a catalog entry:

1. Keep the source's license and provenance metadata intact.
2. Define its input/output contract and required permissions.
3. Add or update validation metadata before enabling it in a recipe.
4. Keep large databases and downloaded caches out of Git.

See the catalog workflow in `../.github/workflows/catalog.yml` and the product
boundary in [`../docs/griffin-foundation.md`](../docs/griffin-foundation.md).
