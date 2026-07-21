-- migrations/002_zec_block_height.sql — add the coherent Zcash chain-tip height metric.
-- Source of truth: DB-SCHEMA-CONCEPT.md §1 (registry is the metric vocabulary) + §8 (deploy profile).
--
-- Why: zec supply (ZecHub) is a date-keyed DAILY aggregate with no block height — storing a
-- current tip height on those rows would be an incoherent supply@height pairing. Instead we
-- capture the real Zcash block height as its OWN coherent hourly observation, sourced from
-- blockchair (/zcash/stats best_block_height, coherent with best_block_time). ZecHub's broken
-- negative `circulation` is why blockchair is NOT used for supply — height/time only.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. Safe to re-run. Additive-only (no DDL change).

\set ON_ERROR_STOP on
SET search_path TO onchain;

INSERT INTO onchain.metrics (id, unit, kind, description, gameability, source_priority) VALUES
  ('zec_block_height','block','state',
     'Zcash mainnet chain-tip block height — blockchair /zcash/stats best_block_height, stamped '
     'with the block''s UTC time (best_block_time). The value_raw/height both carry the height; '
     'this is the coherent block reference ZecHub''s daily supply lacks.',
     NULL,
     '["blockchair"]')
ON CONFLICT (id) DO NOTHING;
