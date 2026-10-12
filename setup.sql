-- Jalankan di Supabase: SQL Editor > New query > paste > Run

-- 1. Tabel untuk menyimpan temuan peserta
create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  teks       text,
  foto_url   text,
  audio_url  text,
  created_at timestamptz not null default now()
);

alter table public.entries enable row level security;

-- Peserta (anon) boleh menambah data dan membaca data
-- (TouchDesigner juga membaca lewat anon key)
drop policy if exists "anon boleh insert" on public.entries;
create policy "anon boleh insert"
  on public.entries for insert to anon
  with check (true);

drop policy if exists "anon boleh baca" on public.entries;
create policy "anon boleh baca"
  on public.entries for select to anon
  using (true);

-- 2. Bucket storage untuk foto dan audio (public, maksimal 10 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 10485760)
on conflict (id) do nothing;

drop policy if exists "anon boleh upload media" on storage.objects;
create policy "anon boleh upload media"
  on storage.objects for insert to anon
  with check (bucket_id = 'media');

drop policy if exists "anon boleh baca media" on storage.objects;
create policy "anon boleh baca media"
  on storage.objects for select to anon
  using (bucket_id = 'media');
