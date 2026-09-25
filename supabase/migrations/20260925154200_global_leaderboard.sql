-- Global leaderboard. One best score per device per mode.
-- Writes go only through public.submit_score. The private function is the
-- security definer; the public wrapper stays security invoker.
-- Do not add the private schema to Exposed schemas.

create schema if not exists private;

create table public.scores (
  id bigint generated always as identity primary key,
  player_key uuid not null,
  game text not null,
  nickname text not null,
  score integer not null,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint scores_game_check check (game in ('cut', 'rhythm', 'prism')),
  constraint scores_nickname_check check (
    char_length(nickname) between 3 and 8
    and nickname !~ '[[:space:][:cntrl:]<>]'
  ),
  constraint scores_score_check check (score between 0 and 15000),
  constraint scores_player_game_key unique (game, player_key)
);

create index scores_game_rank_idx
  on public.scores (game, score desc, updated_at asc);

create index scores_global_rank_idx
  on public.scores (score desc, updated_at asc);

alter table public.scores enable row level security;

create policy scores_public_read
  on public.scores
  for select
  to anon, authenticated
  using (true);

revoke all on table public.scores from public, anon, authenticated;
grant select on table public.scores to anon, authenticated;

create or replace function private.submit_score(
  p_player_key text,
  p_game text,
  p_nickname text,
  p_score integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nick text := btrim(p_nickname);
  v_key uuid;
  v_row public.scores%rowtype;
  v_board jsonb;
begin
  if p_game not in ('cut', 'rhythm', 'prism') then
    raise exception 'bad game';
  end if;
  if v_nick is null
     or char_length(v_nick) < 3
     or char_length(v_nick) > 8
     or v_nick ~ '[[:space:][:cntrl:]<>]' then
    raise exception 'bad nickname';
  end if;
  if p_score is null or p_score < 0 or p_score > 15000 then
    raise exception 'bad score';
  end if;
  begin
    v_key := p_player_key::uuid;
  exception
    when invalid_text_representation then
      raise exception 'bad player';
  end;

  insert into public.scores (player_key, game, nickname, score)
  values (v_key, p_game, v_nick, p_score)
  on conflict (game, player_key) do update
    set nickname = excluded.nickname,
        score = excluded.score,
        updated_at = pg_catalog.now()
    where public.scores.score < excluded.score;

  select * into v_row
  from public.scores
  where game = p_game and player_key = v_key;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'nickname', s.nickname,
      'score', s.score,
      'at', (pg_catalog.date_part('epoch', s.updated_at) * 1000)::bigint
    )
    order by s.score desc, s.updated_at asc
  ), '[]'::jsonb)
  into v_board
  from (
    select nickname, score, updated_at
    from public.scores
    where game = p_game
    order by score desc, updated_at asc
    limit 10
  ) s;

  return pg_catalog.jsonb_build_object(
    'nickname', v_row.nickname,
    'score', v_row.score,
    'at', (pg_catalog.date_part('epoch', v_row.updated_at) * 1000)::bigint,
    'board', v_board
  );
end;
$$;

revoke all on function private.submit_score(text, text, text, integer) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.submit_score(text, text, text, integer) to anon, authenticated;

create or replace function public.submit_score(
  p_player_key text,
  p_game text,
  p_nickname text,
  p_score integer
) returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.submit_score(p_player_key, p_game, p_nickname, p_score);
$$;

revoke all on function public.submit_score(text, text, text, integer) from public;
grant execute on function public.submit_score(text, text, text, integer) to anon, authenticated;
