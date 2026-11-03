-- Draft board column headers (2026-11-02): a short "board name" per team (at most 12 characters, e.g.
-- "Nutcrackers", "Mullets", "Vandelay", "Puka"), so 12 columns fit across one screen. The full name stays
-- in the tooltip. Public like the rest of public.teams; the commissioner edits it (existing policy
-- "commissioner writes"), audited.

alter table public.teams add column if not exists board_name text check (board_name is null or char_length(btrim(board_name)) between 1 and 12);

update public.teams t set board_name = v.b
  from (values ('0001', 'NSFW'), ('0002', 'Stealers'), ('0003', 'H.N.I.C'), ('0004', 'Narco Dogs'), ('0005', 'Mullets'), ('0006', 'Vandelay'),
               ('0007', 'Sissy Boys'), ('0008', 'Nutcrackers'), ('0009', 'Toast'), ('0010', 'Puka'), ('0011', 'Mac Daddies'), ('0012', 'Giddy Up')) as v (id, b)
 where t.id = v.id and t.board_name is null;

create function private.audit_board_name() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.board_name is distinct from old.board_name and (select auth.uid()) is not null then
    insert into public.audit_log (actor, action, details)
    values ((select auth.uid()), 'draft:board_name', jsonb_build_object('team', new.id, 'old', old.board_name, 'new', new.board_name));
  end if;
  return new;
end;
$$;
create trigger audit_board_name after update of board_name on public.teams for each row execute function private.audit_board_name();
revoke execute on function private.audit_board_name() from public, anon;
