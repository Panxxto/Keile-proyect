-- ============================================================================
-- C4LEB BARBER — SCRIPT DE BASE DE DATOS PARA SUPABASE (PostgreSQL)
-- Copia y pega todo este archivo en: Supabase -> SQL Editor -> New query -> Run
-- ============================================================================

-- 1. TABLAS PRINCIPALES
-- ----------------------------------------------------------------------------
create table if not exists public.salon_settings (
  id int primary key default 1 check (id = 1),
  business_name text not null,
  stylist_name text not null,
  business_tagline text not null,
  instagram_handle text not null,
  instagram_url text not null,
  whatsapp_number text not null default '',
  currency_symbol text not null default '$',
  schedule jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_secrets (
  id int primary key default 1 check (id = 1),
  admin_pin text not null default '1234',
  updated_at timestamptz not null default now()
);

create table if not exists public.services (
  id text primary key,
  name text not null,
  category text not null default 'Cortes',
  duration int not null check (duration >= 10),
  price int not null check (price >= 0),
  description text not null default '',
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id text primary key,
  code text not null unique,
  client_name text not null,
  client_phone text not null,
  service_id text references public.services(id) on delete set null,
  service_name text not null,
  duration int not null,
  price int not null,
  date text not null,
  time text not null,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'confirmada', 'completada', 'cancelada')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_appointments_date on public.appointments(date);

-- 2. DATOS INICIALES (C4LEB BARBER + 3 SERVICIOS EN CLP)
-- ----------------------------------------------------------------------------
insert into public.salon_settings (
  id,
  business_name,
  stylist_name,
  business_tagline,
  instagram_handle,
  instagram_url,
  whatsapp_number,
  currency_symbol,
  schedule
)
values (
  1,
  'C4LEB BARBER',
  'Caleb',
  'Barbería independiente enfocada en fades limpios, cortes precisos y estilo urbano. Revisa nuestros horarios disponibles y reserva tu turno sin esperas.',
  '@c4leb.barber',
  'https://www.instagram.com/c4leb.barber/',
  '56912345678',
  '$',
  '{
    "openTime": "10:00",
    "closeTime": "20:00",
    "breakStart": "14:00",
    "breakEnd": "15:00",
    "slotStepMinutes": 15,
    "workingDays": [2, 3, 4, 5, 6]
  }'::jsonb
)
on conflict (id) do nothing;

insert into public.admin_secrets (id, admin_pin)
values (1, '1234')
on conflict (id) do nothing;

insert into public.services (id, name, category, duration, price, description, active, sort_order)
values
  ('srv-corte-clasico', 'Corte Clásico', 'Cortes', 30, 8000, 'Corte tradicional o limpio a tijera y máquina con terminación prolija.', true, 1),
  ('srv-corte-fade', 'Corte Fade', 'Cortes', 45, 10000, 'Degradado limpio (low, mid o high fade) con perfilado y styling final.', true, 2),
  ('srv-corte-barba', 'Corte más Barba', 'Combos', 60, 15000, 'Corte a elección más perfilado, rebaje y delineado completo de barba.', true, 3)
on conflict (id) do nothing;

-- 3. SEGURIDAD (ROW LEVEL SECURITY)
-- ----------------------------------------------------------------------------
alter table public.salon_settings enable row level security;
alter table public.admin_secrets enable row level security;
alter table public.services enable row level security;
alter table public.appointments enable row level security;

drop policy if exists "Lectura publica configuracion" on public.salon_settings;
create policy "Lectura publica configuracion"
  on public.salon_settings for select
  using (true);

drop policy if exists "Lectura publica servicios activos" on public.services;
create policy "Lectura publica servicios activos"
  on public.services for select
  using (active = true);

-- Nota: admin_secrets y appointments no tienen políticas SELECT directas para el público.
-- Todas las consultas de horarios, reservas y administración pasan por funciones RPC seguras.

-- 4. FUNCIONES PÚBLICAS (CLIENTES)
-- ----------------------------------------------------------------------------

-- Obtener configuración pública, servicios activos y bloques ocupados en una sola llamada
drop function if exists public.get_public_salon_data(text, text);
create or replace function public.get_public_salon_data(p_from_date text, p_to_date text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.salon_settings%rowtype;
  v_services jsonb;
  v_busy_slots jsonb;
begin
  select * into v_settings from public.salon_settings where id = 1;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.sort_order, s.created_at), '[]'::jsonb)
  into v_services
  from public.services s
  where s.active = true;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot_date', a.date,
        'slot_time', a.time,
        'duration', a.duration
      )
    ),
    '[]'::jsonb
  )
  into v_busy_slots
  from public.appointments a
  where a.date >= p_from_date
    and a.date <= p_to_date
    and a.status <> 'cancelada';

  return jsonb_build_object(
    'settings', to_jsonb(v_settings),
    'services', v_services,
    'busy_slots', v_busy_slots
  );
end;
$$;

-- Obtener solo fechas/horas ocupadas en un rango (sin exponer datos personales de otros clientes)
drop function if exists public.get_busy_slots_range(text, text);
create or replace function public.get_busy_slots_range(p_from_date text, p_to_date text)
returns table (slot_date text, slot_time text, duration int)
language sql
security definer
set search_path = public
as $$
  select a.date as slot_date, a.time as slot_time, a.duration
  from public.appointments a
  where a.date >= p_from_date
    and a.date <= p_to_date
    and a.status <> 'cancelada';
$$;

-- Crear cita de cliente con validación en el servidor contra topes de horario
create or replace function public.create_client_appointment(
  p_id text,
  p_client_name text,
  p_client_phone text,
  p_service_id text,
  p_date text,
  p_time text,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_srv record;
  v_new_start int;
  v_new_end int;
  v_conflict boolean;
  v_code text;
  v_inserted public.appointments%rowtype;
begin
  if p_time !~ '^\d{2}:\d{2}$' then
    raise exception 'FORMATO_HORA_INVALIDO';
  end if;

  select * into v_srv
  from public.services
  where id = p_service_id and active = true;

  if not found then
    raise exception 'SERVICIO_NO_DISPONIBLE';
  end if;

  v_new_start := split_part(p_time, ':', 1)::int * 60 + split_part(p_time, ':', 2)::int;
  v_new_end := v_new_start + v_srv.duration;

  -- Verifica si otro cliente reservó justo el mismo bloque antes
  select exists (
    select 1
    from public.appointments a
    where a.date = p_date
      and a.status <> 'cancelada'
      and a.time ~ '^\d{2}:\d{2}$'
      and v_new_start < (split_part(a.time, ':', 1)::int * 60 + split_part(a.time, ':', 2)::int + a.duration)
      and v_new_end > (split_part(a.time, ':', 1)::int * 60 + split_part(a.time, ':', 2)::int)
  ) into v_conflict;

  if v_conflict then
    raise exception 'HORARIO_OCUPADO';
  end if;

  -- Genera un código único CITA-XXXX
  loop
    v_code := 'CITA-' || floor(1000 + random() * 9000)::int::text;
    exit when not exists (select 1 from public.appointments where code = v_code);
  end loop;

  insert into public.appointments (
    id, code, client_name, client_phone, service_id, service_name,
    duration, price, date, time, status, notes
  )
  values (
    p_id, v_code, trim(p_client_name), trim(p_client_phone), v_srv.id, v_srv.name,
    v_srv.duration, v_srv.price, p_date, p_time, 'pendiente', coalesce(trim(p_notes), '')
  )
  returning * into v_inserted;

  return to_jsonb(v_inserted);
end;
$$;

-- Consultar citas propias del cliente por código o teléfono
create or replace function public.lookup_client_appointments(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upper text := upper(trim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_result jsonb;
begin
  if v_upper = '' then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'code', a.code,
        'clientName', a.client_name,
        'serviceName', a.service_name,
        'duration', a.duration,
        'price', a.price,
        'date', a.date,
        'time', a.time,
        'status', a.status
      )
      order by a.date desc, a.time desc
    ),
    '[]'::jsonb
  )
  into v_result
  from public.appointments a
  where upper(a.code) = v_upper
     or (
       length(v_digits) >= 6
       and regexp_replace(a.client_phone, '\D', '', 'g') like '%' || v_digits || '%'
     );

  return v_result;
end;
$$;

-- Cancelar cita desde la sección "Mis Citas"
create or replace function public.cancel_client_appointment(p_id text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.appointments
  set status = 'cancelada'
  where id = p_id
    and upper(code) = upper(p_code)
    and status in ('pendiente', 'confirmada');

  return found;
end;
$$;

-- 5. FUNCIONES DE ADMINISTRACIÓN (PROTEGIDAS POR PIN EN EL SERVIDOR)
-- ----------------------------------------------------------------------------

create or replace function public.admin_verify_and_load(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.salon_settings%rowtype;
  v_services jsonb;
  v_appointments jsonb;
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  select * into v_settings from public.salon_settings where id = 1;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.sort_order, s.created_at), '[]'::jsonb)
  into v_services
  from public.services s;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.date asc, a.time asc), '[]'::jsonb)
  into v_appointments
  from public.appointments a;

  return jsonb_build_object(
    'settings', to_jsonb(v_settings),
    'services', v_services,
    'appointments', v_appointments
  );
end;
$$;

create or replace function public.admin_save_appointment(
  p_pin text,
  p_id text,
  p_client_name text,
  p_client_phone text,
  p_service_id text,
  p_service_name text,
  p_duration int,
  p_price int,
  p_date text,
  p_time text,
  p_status text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_saved public.appointments%rowtype;
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  select code into v_code from public.appointments where id = p_id;
  if v_code is null then
    loop
      v_code := 'CITA-' || floor(1000 + random() * 9000)::int::text;
      exit when not exists (select 1 from public.appointments where code = v_code);
    end loop;
  end if;

  insert into public.appointments (
    id, code, client_name, client_phone, service_id, service_name,
    duration, price, date, time, status, notes
  )
  values (
    p_id, v_code, trim(p_client_name), trim(p_client_phone), p_service_id, p_service_name,
    p_duration, p_price, p_date, p_time, p_status, coalesce(trim(p_notes), '')
  )
  on conflict (id) do update set
    client_name = excluded.client_name,
    client_phone = excluded.client_phone,
    service_id = excluded.service_id,
    service_name = excluded.service_name,
    duration = excluded.duration,
    price = excluded.price,
    date = excluded.date,
    time = excluded.time,
    status = excluded.status,
    notes = excluded.notes
  returning * into v_saved;

  return to_jsonb(v_saved);
end;
$$;

create or replace function public.admin_update_appointment_status(
  p_pin text,
  p_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  update public.appointments set status = p_status where id = p_id;
  return found;
end;
$$;

create or replace function public.admin_delete_appointment(p_pin text, p_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  delete from public.appointments where id = p_id;
  return found;
end;
$$;

create or replace function public.admin_save_service(
  p_pin text,
  p_id text,
  p_name text,
  p_category text,
  p_duration int,
  p_price int,
  p_description text,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved public.services%rowtype;
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  insert into public.services (id, name, category, duration, price, description, active)
  values (p_id, trim(p_name), trim(p_category), p_duration, p_price, coalesce(trim(p_description), ''), p_active)
  on conflict (id) do update set
    name = excluded.name,
    category = excluded.category,
    duration = excluded.duration,
    price = excluded.price,
    description = excluded.description,
    active = excluded.active
  returning * into v_saved;

  return to_jsonb(v_saved);
end;
$$;

create or replace function public.admin_delete_service(p_pin text, p_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  select count(*) into v_count from public.services;
  if v_count <= 1 then
    raise exception 'MINIMO_UN_SERVICIO';
  end if;

  delete from public.services where id = p_id;
  return found;
end;
$$;

create or replace function public.admin_save_settings(
  p_pin text,
  p_business_name text,
  p_stylist_name text,
  p_whatsapp_number text,
  p_currency_symbol text,
  p_instagram_handle text,
  p_instagram_url text,
  p_schedule jsonb,
  p_new_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved public.salon_settings%rowtype;
begin
  if not exists (select 1 from public.admin_secrets where id = 1 and admin_pin = p_pin) then
    raise exception 'PIN_INVALIDO';
  end if;

  update public.salon_settings
  set
    business_name = trim(p_business_name),
    stylist_name = trim(p_stylist_name),
    whatsapp_number = coalesce(trim(p_whatsapp_number), ''),
    currency_symbol = coalesce(nullif(trim(p_currency_symbol), ''), '$'),
    instagram_handle = trim(p_instagram_handle),
    instagram_url = trim(p_instagram_url),
    schedule = p_schedule,
    updated_at = now()
  where id = 1
  returning * into v_saved;

  if p_new_pin is not null and length(trim(p_new_pin)) >= 4 then
    update public.admin_secrets
    set admin_pin = trim(p_new_pin), updated_at = now()
    where id = 1;
  end if;

  return to_jsonb(v_saved);
end;
$$;

-- Permisos explícitos de lectura pública y ejecución para la API de Supabase
grant usage on schema public to anon, authenticated;
grant select on public.salon_settings to anon, authenticated;
grant select on public.services to anon, authenticated;

grant execute on function public.get_public_salon_data(text, text) to anon, authenticated;
grant execute on function public.get_busy_slots_range(text, text) to anon, authenticated;
grant execute on function public.create_client_appointment(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.lookup_client_appointments(text) to anon, authenticated;
grant execute on function public.cancel_client_appointment(text, text) to anon, authenticated;
grant execute on function public.admin_verify_and_load(text) to anon, authenticated;
grant execute on function public.admin_save_appointment(text, text, text, text, text, text, int, int, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_update_appointment_status(text, text, text) to anon, authenticated;
grant execute on function public.admin_delete_appointment(text, text) to anon, authenticated;
grant execute on function public.admin_save_service(text, text, text, text, int, int, text, boolean) to anon, authenticated;
grant execute on function public.admin_delete_service(text, text) to anon, authenticated;
grant execute on function public.admin_save_settings(text, text, text, text, text, text, text, jsonb, text) to anon, authenticated;
