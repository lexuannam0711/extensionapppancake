create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  role text not null default 'operator' check (role in ('admin', 'operator')),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  os text not null,
  channel text not null check (channel in ('modern', 'win7')),
  app_version text not null,
  online boolean not null default false,
  last_seen_at timestamptz not null default now(),
  last_update_status text not null default 'unknown',
  updater_error text not null default '',
  device_token_hash text not null default '',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.release_policies (
  version text primary key,
  blocked boolean not null default false,
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.audit_events enable row level security;
alter table public.release_policies enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active = true);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create policy profiles_self_read on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy devices_self_read on public.devices for select using (user_id = auth.uid() or public.is_admin());
create policy devices_admin_write on public.devices for all using (public.is_admin()) with check (public.is_admin());
create policy audit_admin_read on public.audit_events for select using (public.is_admin());
create policy audit_admin_write on public.audit_events for insert with check (public.is_admin());
create policy releases_admin_write on public.release_policies for all using (public.is_admin()) with check (public.is_admin());