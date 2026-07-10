create extension if not exists pgcrypto;

create table if not exists public.reader_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_hash text not null,
  file_name text not null,
  text_length integer not null default 0 check (text_length >= 0),
  readable_count integer not null default 0 check (readable_count >= 0),
  display_count integer not null default 0 check (display_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, file_hash)
);

create table if not exists public.reader_progress (
  document_id uuid primary key references public.reader_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  current_readable_index integer not null default 0 check (current_readable_index >= 0),
  current_display_index integer not null default 0 check (current_display_index >= 0),
  rate numeric(4, 2) not null default 1 check (rate >= 0.5 and rate <= 2),
  voice_uri text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists reader_documents_user_updated_idx
  on public.reader_documents (user_id, updated_at desc);

create index if not exists reader_progress_user_updated_idx
  on public.reader_progress (user_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_reader_documents_updated_at on public.reader_documents;
create trigger set_reader_documents_updated_at
before update on public.reader_documents
for each row execute function public.set_updated_at();

drop trigger if exists set_reader_progress_updated_at on public.reader_progress;
create trigger set_reader_progress_updated_at
before update on public.reader_progress
for each row execute function public.set_updated_at();

alter table public.reader_documents enable row level security;
alter table public.reader_progress enable row level security;

drop policy if exists "reader_documents_select_own" on public.reader_documents;
create policy "reader_documents_select_own"
on public.reader_documents for select
using (auth.uid() = user_id);

drop policy if exists "reader_documents_insert_own" on public.reader_documents;
create policy "reader_documents_insert_own"
on public.reader_documents for insert
with check (auth.uid() = user_id);

drop policy if exists "reader_documents_update_own" on public.reader_documents;
create policy "reader_documents_update_own"
on public.reader_documents for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "reader_documents_delete_own" on public.reader_documents;
create policy "reader_documents_delete_own"
on public.reader_documents for delete
using (auth.uid() = user_id);

drop policy if exists "reader_progress_select_own" on public.reader_progress;
create policy "reader_progress_select_own"
on public.reader_progress for select
using (auth.uid() = user_id);

drop policy if exists "reader_progress_insert_own" on public.reader_progress;
create policy "reader_progress_insert_own"
on public.reader_progress for insert
with check (auth.uid() = user_id);

drop policy if exists "reader_progress_update_own" on public.reader_progress;
create policy "reader_progress_update_own"
on public.reader_progress for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "reader_progress_delete_own" on public.reader_progress;
create policy "reader_progress_delete_own"
on public.reader_progress for delete
using (auth.uid() = user_id);
