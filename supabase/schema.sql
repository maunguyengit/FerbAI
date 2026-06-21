-- ChalkAI — database schema for recordings + sharing.
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query → paste → Run).
-- Safe to re-run.

-- ───────────────────────── recordings table ─────────────────────────
create table if not exists public.recordings (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Untitled lesson',
  duration_ms integer not null default 0,
  events      jsonb not null default '[]'::jsonb,   -- timestamped scene event log
  snapshots   jsonb not null default '[]'::jsonb,   -- periodic full scene states
  transcript  jsonb,                                 -- word-level transcript (Deepgram), timeline-aligned
  chapters    jsonb,                                 -- auto-generated chapters
  audio_path  text,                                  -- key into the 'recordings' storage bucket
  audio_mime  text,
  shared      boolean not null default false,        -- teacher flipped "share"
  created_at  timestamptz not null default now()
);

create index if not exists recordings_owner_created_idx
  on public.recordings (owner, created_at desc);

alter table public.recordings enable row level security;

-- READ: your own recordings, OR any recording that's been shared.
drop policy if exists "read own or shared" on public.recordings;
create policy "read own or shared" on public.recordings
  for select to authenticated
  using (owner = auth.uid() or shared = true);

-- INSERT: only as yourself.
drop policy if exists "insert own" on public.recordings;
create policy "insert own" on public.recordings
  for insert to authenticated
  with check (owner = auth.uid());

-- UPDATE / DELETE: only your own.
drop policy if exists "update own" on public.recordings;
create policy "update own" on public.recordings
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "delete own" on public.recordings;
create policy "delete own" on public.recordings
  for delete to authenticated using (owner = auth.uid());

-- ───────────────────────── audio storage bucket ─────────────────────────
-- Private bucket. Owners read/write their own folder (<uid>/...).
-- Cross-user access to SHARED audio is granted by the server via signed URLs
-- (service_role), so no broad storage policy is needed.
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

drop policy if exists "audio read own" on storage.objects;
create policy "audio read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "audio write own" on storage.objects;
create policy "audio write own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "audio delete own" on storage.objects;
create policy "audio delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
