-- ChalkAI migration v2 — add transcript + chapters to recordings.
-- Run this once in the Supabase SQL Editor if you already ran the original
-- schema.sql (which created the recordings table without these columns).
-- Safe to re-run.

alter table public.recordings add column if not exists transcript jsonb;
alter table public.recordings add column if not exists chapters   jsonb;
