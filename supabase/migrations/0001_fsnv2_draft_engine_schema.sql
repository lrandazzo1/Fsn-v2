-- =============================================================================
-- FSN v2 — Draft & League Engine (Phase 1)
-- Applied to the Supabase project `FSN` as migration `fsnv2_draft_engine_schema`.
--
-- The engine lives in its own `fsnv2` schema so it cannot collide with the
-- existing `public.*` tables used by the league-import product.
-- =============================================================================

create schema if not exists fsnv2;

-- ----------------------------------------------------------------- leagues --
create table if not exists fsnv2.leagues (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 1 and 120),
  total_teams     integer not null default 12 check (total_teams between 2 and 32),
  roster_settings jsonb not null default jsonb_build_object(
                    'starters', jsonb_build_object('QB',1,'RB',2,'WR',2,'TE',1,'FLEX',1,'DST',1,'K',1),
                    'bench', 6,
                    'flex_positions', jsonb_build_array('RB','WR','TE')
                  ),
  scoring_type    text not null default 'ppr'
                    check (scoring_type in ('standard','half_ppr','ppr','superflex')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ------------------------------------------------------------------ drafts --
create table if not exists fsnv2.drafts (
  id             uuid primary key default gen_random_uuid(),
  league_id      uuid not null references fsnv2.leagues(id) on delete cascade,
  current_pick   integer not null default 1 check (current_pick >= 1),
  status         text not null default 'scheduled'
                   check (status in ('scheduled','in_progress','paused','complete')),
  timer_seconds  integer not null default 60 check (timer_seconds between 5 and 600),
  rounds         integer not null default 15 check (rounds between 1 and 30),
  draft_type     text not null default 'snake' check (draft_type in ('snake','linear')),
  teams          jsonb not null default '[]'::jsonb,   -- [{slot,name,abbr,is_user}]
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists drafts_league_idx on fsnv2.drafts (league_id);

-- ----------------------------------------------------------------- players --
create table if not exists fsnv2.players (
  id         text primary key,
  name       text not null,
  position   text not null check (position in ('QB','RB','WR','TE','K','DST')),
  team       text not null,
  adp        numeric(6,2) not null default 999,
  stats      jsonb not null default '{}'::jsonb,  -- {projection, vor, tier, pos_rank}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists players_position_idx on fsnv2.players (position);
create index if not exists players_adp_idx on fsnv2.players (adp);

-- ------------------------------------------------------------- draft_picks --
create table if not exists fsnv2.draft_picks (
  id          uuid primary key default gen_random_uuid(),
  draft_id    uuid not null references fsnv2.drafts(id) on delete cascade,
  pick_number integer not null check (pick_number >= 1),
  round       integer not null check (round >= 1),
  team_id     integer not null check (team_id >= 1),
  player_id   text not null references fsnv2.players(id),
  picked_at   timestamptz not null default now(),
  auto        boolean not null default false,
  source      text not null default 'manual'
                check (source in ('manual','bot','timer_expiry','simulation')),
  constraint draft_picks_unique_slot   unique (draft_id, pick_number),
  constraint draft_picks_unique_player unique (draft_id, player_id)
);
create index if not exists draft_picks_draft_idx on fsnv2.draft_picks (draft_id, pick_number);
create index if not exists draft_picks_team_idx  on fsnv2.draft_picks (draft_id, team_id);

-- ------------------------------------------------------------- updated_at ---
create or replace function fsnv2.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leagues_touch on fsnv2.leagues;
create trigger leagues_touch before update on fsnv2.leagues
  for each row execute function fsnv2.touch_updated_at();

drop trigger if exists drafts_touch on fsnv2.drafts;
create trigger drafts_touch before update on fsnv2.drafts
  for each row execute function fsnv2.touch_updated_at();

drop trigger if exists players_touch on fsnv2.players;
create trigger players_touch before update on fsnv2.players
  for each row execute function fsnv2.touch_updated_at();

-- RLS on, with no direct-table policies: all client access goes through the
-- security-definer RPCs in `public` (see 0002).
alter table fsnv2.leagues     enable row level security;
alter table fsnv2.drafts      enable row level security;
alter table fsnv2.players     enable row level security;
alter table fsnv2.draft_picks enable row level security;
