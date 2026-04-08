-- Align legacy ai_log.timestamp -> ai_log.created_at safely.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_log' and column_name = 'timestamp'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_log' and column_name = 'created_at'
  ) then
    alter table ai_log rename column "timestamp" to created_at;
  end if;
end $$;
