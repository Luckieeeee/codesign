-- Codesign — initial schema
--
-- Run this in the Supabase SQL editor (or via `psql`) once.
--
-- We deliberately do NOT enable Row Level Security here: every signed-in
-- WorkOS user has full access for the hackathon, and the only writers are
-- the Next app + the Hocuspocus collab server (both using the service-role
-- key over the network, never the browser).

create extension if not exists "uuid-ossp";

-- One row per project / room. The id is also the Yjs document name and the
-- last path segment of /projects/[id], so we keep it as text (slugs are nice
-- to read in URLs).
create table if not exists public.projects (
  id          text primary key,
  name        text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists projects_created_at_idx
  on public.projects (created_at desc);

-- Yjs document state for each project, persisted as a base64-encoded
-- update blob. The Hocuspocus Database extension reads / writes this row.
create table if not exists public.project_documents (
  project_id   text primary key references public.projects(id) on delete cascade,
  state_b64    text not null,
  updated_at   timestamptz not null default now()
);
