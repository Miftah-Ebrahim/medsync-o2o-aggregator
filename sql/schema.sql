-- ============================================================
-- MedSync (Felega Health) — Supabase Schema
-- O2O Pharmacy Aggregator — Addis Ababa
-- ============================================================

-- Drop existing (safe re-run during dev/demo)
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists medication_requests;
drop table if exists profiles;
drop table if exists pharmacies;

-- ============================================================
-- TABLE: pharmacies
-- ============================================================
create table pharmacies (
  id               bigint generated always as identity primary key,
  pharmacy_name    text not null,
  location_lat     double precision not null,
  location_lng     double precision not null,
  phone            text not null,
  area             text,                -- human-readable neighborhood label
  is_active        boolean not null default true, -- busy/offline toggle
  google_maps_link text,                -- Google Maps navigation link
  created_at       timestamptz not null default now()
);

-- ============================================================
-- TABLE: profiles
-- Links to Supabase auth.users via UUID foreign key.
-- Stores the user's selected role from registration.
-- ============================================================
create table profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'patient'
                check (role in ('patient', 'pharmacy_staff', 'admin')),
  pharmacy_id bigint references pharmacies(id),  -- only relevant for pharmacy_staff
  created_at  timestamptz not null default now()
);

-- ============================================================
-- TABLE: medication_requests
-- ============================================================
create table medication_requests (
  id                bigint generated always as identity primary key,
  patient_name      text not null,
  medication_name   text not null,
  status            text not null default 'Pending'
                      check (status in ('Pending','Matched','Locked','Picked Up')),
  pharmacy_id       bigint references pharmacies(id),
  user_id           uuid references profiles(id),   -- links request to authenticated patient
  notes             text,              -- optional dosage / quantity notes from patient
  fee_paid          boolean not null default false,
  telebirr_ref      text,              -- simulated transaction reference
  user_lat          double precision,  -- patient coordinates for proximity awareness
  user_lng          double precision,
  timestamp         timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Helpful indexes for the live-feed queries the dashboards poll
create index idx_requests_status on medication_requests(status);
create index idx_requests_pharmacy on medication_requests(pharmacy_id);
create index idx_requests_user on medication_requests(user_id);
create index idx_profiles_role on profiles(role);

-- ============================================================
-- TRIGGER: auto-create a profile row when a new user signs up
-- via Supabase Auth. Reads role & full_name from user_metadata.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, role, pharmacy_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'patient'),
    (new.raw_user_meta_data->>'pharmacy_id')::bigint
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- SEED DATA: 3 sample pharmacies across Addis Ababa
-- ============================================================
insert into pharmacies (pharmacy_name, location_lat, location_lng, phone, area, google_maps_link) values
('Bole Ruwi Pharmacy',          8.9930, 38.7920, '+251 911 200 301', 'Bole',           'https://maps.google.com/?q=Bole+Ruwi+Pharmacy+Addis+Ababa'),
('Churchill Road Pharmacy',     9.0150, 38.7530, '+251 911 200 302', 'Churchill Road', 'https://maps.google.com/?q=Churchill+Road+Pharmacy+Addis+Ababa'),
('Mercato Central Pharmacy',    9.0350, 38.7400, '+251 911 200 303', 'Mercato',        'https://maps.google.com/?q=Mercato+Central+Pharmacy+Addis+Ababa');

-- ============================================================
-- SEED DATA: a few sample requests so the dashboard isn't empty on first load
-- ============================================================
insert into medication_requests (patient_name, medication_name, status, pharmacy_id, notes) values
('Hana Tesfaye',   'Amoxicillin 500mg', 'Pending', null, '21 capsules, adult dose'),
('Dawit Bekele',   'Paracetamol 1g',    'Matched', 1,    'For fever, 10 tablets'),
('Selam Girma',    'Metformin 500mg',   'Locked',  2,    'Monthly refill');

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table pharmacies enable row level security;
alter table profiles enable row level security;
alter table medication_requests enable row level security;

-- Pharmacies: public read
create policy "Public read pharmacies" on pharmacies
  for select using (true);

-- Profiles: users can read their own profile; service_role bypasses for admin
create policy "Users read own profile" on profiles
  for select using (auth.uid() = id);

create policy "Service role full access profiles" on profiles
  for all using (true);

-- Medication requests: public read
create policy "Public read requests" on medication_requests
  for select using (true);

-- Inserts/updates are performed via the PHP backend using the service_role key,
-- which bypasses RLS automatically — no anon write policies are defined on purpose.
