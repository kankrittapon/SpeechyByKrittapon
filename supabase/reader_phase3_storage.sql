alter table public.reader_documents
add column if not exists storage_path text;

create index if not exists reader_documents_user_storage_updated_idx
  on public.reader_documents (user_id, updated_at desc)
  where storage_path is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reader-texts',
  'reader-texts',
  false,
  10485760,
  array['text/plain']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "reader_texts_select_own" on storage.objects;
create policy "reader_texts_select_own"
on storage.objects for select
using (
  bucket_id = 'reader-texts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "reader_texts_insert_own" on storage.objects;
create policy "reader_texts_insert_own"
on storage.objects for insert
with check (
  bucket_id = 'reader-texts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "reader_texts_update_own" on storage.objects;
create policy "reader_texts_update_own"
on storage.objects for update
using (
  bucket_id = 'reader-texts'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'reader-texts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "reader_texts_delete_own" on storage.objects;
create policy "reader_texts_delete_own"
on storage.objects for delete
using (
  bucket_id = 'reader-texts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
