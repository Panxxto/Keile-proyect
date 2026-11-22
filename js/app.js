/* ==========================================================================
   LÓGICA PRINCIPAL DE C4LEB BARBER Y GESTIÓN DE AGENDA
   Soporta Modo Nube (Supabase) automático y respaldo en Modo Local (localStorage)
   ========================================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "c4leb_barber_state_v1";
  const SESSION_AUTH_KEY = "c4leb_admin_unlocked";
  const SESSION_PIN_KEY = "c4leb_admin_pin";

  const DAY_NAMES_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const DAY_NAMES_FULL = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado"
  ];

  // Cliente de Supabase (null si no se ha configurado supabaseUrl y supabaseAnonKey)
  let supabaseClient = null;

  // Estado global de la aplicación
  let appState = null;
  let busySlotsCache = [];
  let busySlotsRangeEnd = null;
  let activeAdminPin = "";
  let activeServiceCategory = "Todos";
  let activeAdminDateFilter = "today";
  let activeAdminTab = "appointments";

  // ------------------------------------------------------------------------
  // DETECCIÓN DE MODO (NUBE SUPABASE VS LOCAL)
  // ------------------------------------------------------------------------
  function initSupabaseClient() {
    const cfg = window.SALON_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === "function") {
      supabaseClient = window.supabase.createClient(cfg.supabaseUrl.trim(), cfg.supabaseAnonKey.trim());
    } else {
      supabaseClient = null;
    }
  }

  function isSupabaseMode() {
    return supabaseClient !== null;
  }

  function updateSyncBadge() {
    const badge = document.getElementById("sync-status-badge");
    if (!badge) return;
    if (isSupabaseMode()) {
      badge.className = "sync-badge sync-cloud";
      badge.textContent = "Conectado a Supabase";
    } else {
      badge.className = "sync-badge sync-local";
      badge.textContent = "Modo Local (sin Supabase)";
    }
  }

  // ------------------------------------------------------------------------
  // MAPEO ENTRE COLUMNAS DE SUPABASE (snake_case) Y APP (camelCase)
  // ------------------------------------------------------------------------
  function mapDbSettings(row) {
    const cfg = window.SALON_CONFIG;
    if (!row) return buildDefaultState().settings;
    return {
      businessName: row.business_name || cfg.businessName,
      stylistName: row.stylist_name || cfg.stylistName,
      businessTagline: row.business_tagline || cfg.businessTagline,
      instagramHandle: row.instagram_handle || cfg.instagramHandle,
      instagramUrl: row.instagram_url || cfg.instagramUrl,
      whatsappNumber: row.whatsapp_number || "",
      currencySymbol: row.currency_symbol || "$",
      adminPin: activeAdminPin || cfg.adminPin,
      schedule: {
        openTime: row.schedule?.openTime || cfg.schedule.openTime,
        closeTime: row.schedule?.closeTime || cfg.schedule.closeTime,
        breakStart: row.schedule?.breakStart ?? "",
        breakEnd: row.schedule?.breakEnd ?? "",
        slotStepMinutes: Number(row.schedule?.slotStepMinutes) || 15,
        workingDays: Array.isArray(row.schedule?.workingDays)
          ? row.schedule.workingDays
          : [...cfg.schedule.workingDays]
      }
    };
  }

  function mapDbService(row) {
    return {
      id: row.id,
      name: row.name,
      category: row.category || "Cortes",
      duration: Number(row.duration) || 30,
      price: Number(row.price) || 0,
      description: row.description || "",
      active: Boolean(row.active)
    };
  }

  function mapDbAppointment(row) {
    return {
      id: row.id,
      code: row.code,
      clientName: row.client_name ?? row.clientName ?? "",
      clientPhone: row.client_phone ?? row.clientPhone ?? "",
      serviceId: row.service_id ?? row.serviceId ?? "",
      serviceName: row.service_name ?? row.serviceName ?? "",
      duration: Number(row.duration) || 30,
      price: Number(row.price) || 0,
      date: row.date,
      time: row.time,
      status: row.status || "pendiente",
      notes: row.notes || "",
      createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString()
    };
  }

  // ------------------------------------------------------------------------
  // UTILIDADES DE FECHA, HORA, FORMATO Y SEGURIDAD
  // ------------------------------------------------------------------------
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function formatLocalISO(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getTodayISO() {
    return formatLocalISO(new Date());
  }

  function addDaysISO(baseISO, days) {
    const date = parseISODateLocal(baseISO);
    date.setDate(date.getDate() + days);
    return formatLocalISO(date);
  }

  function parseISODateLocal(isoString) {
    const [y, m, d] = isoString.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDisplayDate(isoString) {
    if (!isoString) return "—";
    const date = parseISODateLocal(isoString);
    return date.toLocaleDateString("es-CL", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function timeToMinutes(hhmm) {
    if (!hhmm || !hhmm.includes(":")) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function formatCurrency(amount) {
    const symbol = appState.settings.currencySymbol || "$";
    const num = Math.round(Number(amount) || 0);
    return `${symbol}${num.toLocaleString("es-CL")}`;
  }

  function formatDuration(minutes) {
    const mins = Number(minutes) || 0;
    if (mins === 60) return "1 hora";
    if (mins > 60 && mins % 60 === 0) return `${mins / 60} horas`;
    return `${mins} min`;
  }

  function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
  }

  function generateBookingCode() {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `CITA-${num}`;
  }

  function generateId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3600);
  }

  // ------------------------------------------------------------------------
  // PERSISTENCIA EN LOCALSTORAGE (MODO LOCAL / RESPUESTA INICIAL)
  // ------------------------------------------------------------------------
  function buildDefaultState() {
    const cfg = window.SALON_CONFIG;
    const today = getTodayISO();
    const tomorrow = addDaysISO(today, 1);

    const services = cfg.defaultServices.map((s) => ({ ...s }));
    const srvClasico = services[0];
    const srvFade = services[1] || services[0];
    const srvCombo = services[2] || services[0];

    return {
      settings: {
        businessName: cfg.businessName,
        stylistName: cfg.stylistName,
        businessTagline: cfg.businessTagline,
        instagramHandle: cfg.instagramHandle,
        instagramUrl: cfg.instagramUrl,
        whatsappNumber: cfg.whatsappNumber,
        currencySymbol: cfg.currencySymbol,
        adminPin: cfg.adminPin,
        schedule: {
          ...cfg.schedule,
          workingDays: [...cfg.schedule.workingDays]
        }
      },
      services,
      appointments: [
        {
          id: "apt-demo-1",
          code: "CITA-1024",
          clientName: "Benjamín Soto",
          clientPhone: "+56 9 8412 3301",
          serviceId: srvFade.id,
          serviceName: srvFade.name,
          duration: srvFade.duration,
          price: srvFade.price,
          date: today,
          time: "11:00",
          status: "confirmada",
          notes: "Mid fade con textura arriba",
          createdAt: new Date().toISOString()
        },
        {
          id: "apt-demo-2",
          code: "CITA-1025",
          clientName: "Tomás Vargas",
          clientPhone: "+56 9 7720 1190",
          serviceId: srvCombo.id,
          serviceName: srvCombo.name,
          duration: srvCombo.duration,
          price: srvCombo.price,
          date: today,
          time: "16:30",
          status: "pendiente",
          notes: "Barba marcada con navaja",
          createdAt: new Date().toISOString()
        },
        {
          id: "apt-demo-3",
          code: "CITA-1026",
          clientName: "Vicente Morales",
          clientPhone: "+56 9 6509 4482",
          serviceId: srvClasico.id,
          serviceName: srvClasico.name,
          duration: srvClasico.duration,
          price: srvClasico.price,
          date: tomorrow,
          time: "12:00",
          status: "confirmada",
          notes: "",
          createdAt: new Date().toISOString()
        }
      ]
    };
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const fresh = buildDefaultState();
        saveLocalState(fresh);
        return fresh;
      }
      const parsed = JSON.parse(raw);
      if (!parsed.settings || !Array.isArray(parsed.services) || !Array.isArray(parsed.appointments)) {
        throw new Error("Estructura inválida");
      }
      return parsed;
    } catch (err) {
      console.warn("Restaurando estado por defecto:", err);
      const fresh = buildDefaultState();
      saveLocalState(fresh);
      return fresh;
    }
  }

  function saveLocalState(nextState = appState) {
    appState = nextState;
    if (!isSupabaseMode()) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    }
  }

  // ------------------------------------------------------------------------
  // SINCRONIZACIÓN DE DATOS PÚBLICOS DESDE SUPABASE
  // ------------------------------------------------------------------------
  function syncBusySlotsFromAppointments() {
    busySlotsCache = appState.appointments
      .filter((a) => a.status !== "cancelada")
      .map((a) => ({ date: a.date, time: a.time, duration: Number(a.duration) || 30 }));
  }

  async function refreshBusySlotsRange(fromISO, toISO) {
    if (!isSupabaseMode()) {
      syncBusySlotsFromAppointments();
      return;
    }
    const { data, error } = await supabaseClient.rpc("get_busy_slots_range", {
      p_from_date: fromISO,
      p_to_date: toISO
    });
    if (error) {
      console.error("Error consultando horarios:", error);
      return;
    }
    busySlotsCache = Array.isArray(data)
      ? data.map((row) => ({
          date: row.slot_date ?? row.date,
          time: row.slot_time ?? row.time,
          duration: Number(row.duration) || 30
        }))
      : [];
    busySlotsRangeEnd = toISO;
  }

  async function refreshPublicDataFromSupabase() {
    if (!isSupabaseMode()) return;

    const today = getTodayISO();
    const horizon = addDaysISO(today, 30);

    try {
      const [settingsRes, servicesRes, slotsRes] = await Promise.all([
        supabaseClient.from("salon_settings").select("*").eq("id", 1).single(),
        supabaseClient.from("services").select("*").eq("active", true).order("sort_order", { ascending: true }),
        supabaseClient.rpc("get_busy_slots_range", { p_from_date: today, p_to_date: horizon })
      ]);

      if (!settingsRes.error && settingsRes.data) {
        appState.settings = mapDbSettings(settingsRes.data);
      }
      if (!servicesRes.error && Array.isArray(servicesRes.data)) {
        appState.services = servicesRes.data.map(mapDbService);
      }
      if (!slotsRes.error && Array.isArray(slotsRes.data)) {
        busySlotsCache = slotsRes.data.map((row) => ({
          date: row.slot_date ?? row.date,
          time: row.slot_time ?? row.time,
          duration: Number(row.duration) || 30
        }));
        busySlotsRangeEnd = horizon;
      }
    } catch (err) {
      console.error("Error cargando datos públicos desde Supabase:", err);
      showToast("No se pudo conectar con Supabase. Revisa tu conexión o configuración.", "error");
    }
  }

  // ------------------------------------------------------------------------
  // MOTOR DE DISPONIBILIDAD DE HORARIOS
  // ------------------------------------------------------------------------
  function isWorkingDay(dateISO) {
    const dayOfWeek = parseISODateLocal(dateISO).getDay();
    return appState.settings.schedule.workingDays.includes(dayOfWeek);
  }

  function getAvailableSlotsForDate(dateISO, serviceDuration, excludeAppointmentId = null) {
    const schedule = appState.settings.schedule;
    if (!dateISO || !isWorkingDay(dateISO)) {
      return [];
    }

    const openMin = timeToMinutes(schedule.openTime);
    const closeMin = timeToMinutes(schedule.closeTime);
    const step = Number(schedule.slotStepMinutes) || 15;
    const duration = Number(serviceDuration) || 30;

    if (openMin === null || closeMin === null || openMin >= closeMin) {
      return [];
    }

    const breakStart = timeToMinutes(schedule.breakStart);
    const breakEnd = timeToMinutes(schedule.breakEnd);
    const hasBreak = breakStart !== null && breakEnd !== null && breakStart < breakEnd;

    // En modo Supabase público usamos busySlotsCache; en modo local usamos appState.appointments
    const dayBusyBlocks = isSupabaseMode()
      ? busySlotsCache.filter((b) => b.date === dateISO)
      : appState.appointments.filter(
          (apt) =>
            apt.date === dateISO &&
            apt.status !== "cancelada" &&
            apt.id !== excludeAppointmentId
        );

    const todayISO = getTodayISO();
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const slots = [];
    for (let start = openMin; start + duration <= closeMin; start += step) {
      const end = start + duration;
      let available = true;
      let reason = "";

      if (dateISO === todayISO && start <= nowMinutes + 15) {
        available = false;
        reason = "Horario pasado";
      }

      if (available && hasBreak && start < breakEnd && end > breakStart) {
        available = false;
        reason = "Descanso";
      }

      if (available) {
        const conflict = dayBusyBlocks.some((apt) => {
          const aptStart = timeToMinutes(apt.time);
          const aptEnd = aptStart + (Number(apt.duration) || 30);
          return start < aptEnd && end > aptStart;
        });
        if (conflict) {
          available = false;
          reason = "Ocupado";
        }
      }

      slots.push({
        time: minutesToTime(start),
        available,
        reason
      });
    }

    return slots;
  }

  function findNextWorkingDateWithSlots(serviceDuration) {
    const today = getTodayISO();
    for (let offset = 0; offset < 21; offset++) {
      const candidateISO = addDaysISO(today, offset);
      const slots = getAvailableSlotsForDate(candidateISO, serviceDuration);
      if (slots.some((s) => s.available)) {
        return { dateISO: candidateISO, slots };
      }
    }
    return { dateISO: today, slots: [] };
  }

  // ------------------------------------------------------------------------
  // SINCRONIZACIÓN DE TEXTOS DEL NEGOCIO Y HERO
  // ------------------------------------------------------------------------
  function renderBusinessInfo() {
    const s = appState.settings;
    document.title = `${s.businessName} | Agenda tu Cita`;

    document.querySelectorAll("[data-bind]").forEach((el) => {
      const key = el.getAttribute("data-bind");
      if (s[key] !== undefined) {
        if (key === "instagramHandle" && el.closest(".meta-link")) {
          el.textContent = `${s[key]} ↗`;
        } else {
          el.textContent = s[key];
        }
      }
    });

    document.querySelectorAll("[data-bind-href]").forEach((el) => {
      const key = el.getAttribute("data-bind-href");
      if (s[key]) {
        el.setAttribute("href", s[key]);
      }
    });

    const workingLabels = [...s.schedule.workingDays]
      .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
      .map((d) => DAY_NAMES_SHORT[d])
      .join(", ");

    const hoursEl = document.getElementById("hero-hours-text");
    if (hoursEl) {
      hoursEl.textContent = `${workingLabels || "Sin días activos"} · ${s.schedule.openTime} a ${s.schedule.closeTime}`;
    }

    renderHeroQuickSlots();
  }

  function renderHeroQuickSlots() {
    const container = document.getElementById("hero-quick-slots");
    if (!container) return;

    const activeServices = appState.services.filter((srv) => srv.active);
    const defaultDuration = activeServices[0] ? activeServices[0].duration : 30;
    const { dateISO, slots } = findNextWorkingDateWithSlots(defaultDuration);
    const freeSlots = slots.filter((s) => s.available).slice(0, 6);

    if (freeSlots.length === 0) {
      container.innerHTML = `<span class="muted-text">Consulta el calendario para ver próximas fechas disponibles.</span>`;
      return;
    }

    const labelDate = dateISO === getTodayISO() ? "Hoy" : formatDisplayDate(dateISO);
    container.innerHTML = "";

    const infoLabel = document.createElement("div");
    infoLabel.style.width = "100%";
    infoLabel.style.fontSize = "0.82rem";
    infoLabel.style.color = "#d4d4dc";
    infoLabel.textContent = `${labelDate}:`;
    container.appendChild(infoLabel);

    freeSlots.forEach((slot) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-slot-chip";
      btn.textContent = slot.time;
      btn.addEventListener("click", () => {
        document.getElementById("booking-date").value = dateISO;
        renderBookingSlots();
        selectBookingTime(slot.time);
        document.getElementById("reservar").scrollIntoView({ behavior: "smooth" });
      });
      container.appendChild(btn);
    });
  }

  // ------------------------------------------------------------------------
  // RENDERIZADO DEL CATÁLOGO DE SERVICIOS (VISTA CLIENTE)
  // ------------------------------------------------------------------------
  function renderClientServices() {
    const activeServices = appState.services.filter((s) => s.active);
    const categories = ["Todos", ...new Set(activeServices.map((s) => s.category))];

    if (!categories.includes(activeServiceCategory)) {
      activeServiceCategory = "Todos";
    }

    const filtersContainer = document.getElementById("service-category-filters");
    filtersContainer.innerHTML = "";

    if (activeServices.length > 3 && categories.length > 2) {
      filtersContainer.classList.remove("hidden");
      categories.forEach((cat) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `pill-btn${cat === activeServiceCategory ? " active" : ""}`;
        btn.textContent = cat;
        btn.addEventListener("click", () => {
          activeServiceCategory = cat;
          renderClientServices();
        });
        filtersContainer.appendChild(btn);
      });
    } else {
      filtersContainer.classList.add("hidden");
      activeServiceCategory = "Todos";
    }

    const filtered =
      activeServiceCategory === "Todos"
        ? activeServices
        : activeServices.filter((s) => s.category === activeServiceCategory);

    const grid = document.getElementById("services-grid");
    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty-state">No hay servicios activos en esta categoría.</div>`;
      return;
    }

    grid.innerHTML = filtered
      .map(
        (srv) => `
      <article class="service-card">
        <div>
          <div class="service-top">
            <span class="service-cat">${escapeHtml(srv.category)}</span>
            <span class="service-price">${escapeHtml(formatCurrency(srv.price))}</span>
          </div>
          <h3 class="service-name">${escapeHtml(srv.name)}</h3>
          <p class="service-desc">${escapeHtml(srv.description || "Atención profesional personalizada.")}</p>
        </div>
        <div class="service-footer">
          <span class="service-duration">⏱ ${escapeHtml(formatDuration(srv.duration))}</span>
          <button type="button" class="btn btn-outline btn-sm choose-service-btn" data-service-id="${escapeHtml(srv.id)}">
            Elegir corte
          </button>
        </div>
      </article>
    `
      )
      .join("");

    grid.querySelectorAll(".choose-service-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const select = document.getElementById("booking-service");
        select.value = btn.getAttribute("data-service-id");
        renderBookingSlots();
        updateBookingSummary();
        document.getElementById("reservar").scrollIntoView({ behavior: "smooth" });
      });
    });

    populateServiceDropdowns();
  }

  function populateServiceDropdowns() {
    const activeServices = appState.services.filter((s) => s.active);
    const clientSelect = document.getElementById("booking-service");
    const currentClientVal = clientSelect.value;

    clientSelect.innerHTML = activeServices
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(formatDuration(s.duration))} · ${escapeHtml(formatCurrency(s.price))})</option>`
      )
      .join("");

    if (activeServices.some((s) => s.id === currentClientVal)) {
      clientSelect.value = currentClientVal;
    }

    const adminSelect = document.getElementById("admin-apt-service");
    const currentAdminVal = adminSelect.value;
    adminSelect.innerHTML = appState.services
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(formatDuration(s.duration))} · ${escapeHtml(formatCurrency(s.price))})</option>`
      )
      .join("");
    if (appState.services.some((s) => s.id === currentAdminVal)) {
      adminSelect.value = currentAdminVal;
    }
  }

  // ------------------------------------------------------------------------
  // FORMULARIO DE RESERVA DEL CLIENTE
  // ------------------------------------------------------------------------
  function initBookingDefaults() {
    const dateInput = document.getElementById("booking-date");
    const today = getTodayISO();
    dateInput.min = today;

    const firstService = appState.services.find((s) => s.active);
    const duration = firstService ? firstService.duration : 30;
    const { dateISO } = findNextWorkingDateWithSlots(duration);
    dateInput.value = dateISO;

    renderBookingSlots();
    updateBookingSummary();
  }

  function getSelectedBookingService() {
    const id = document.getElementById("booking-service").value;
    return appState.services.find((s) => s.id === id) || null;
  }

  function renderBookingSlots() {
    const service = getSelectedBookingService();
    const dateInput = document.getElementById("booking-date");
    const dateISO = dateInput.value;
    const grid = document.getElementById("time-slots-grid");
    const hint = document.getElementById("date-helper-text");
    const hiddenTime = document.getElementById("booking-time");

    hiddenTime.value = "";
    hint.textContent = "";
    hint.className = "field-hint";

    if (!service) {
      grid.innerHTML = `<div class="empty-slots-msg">No hay servicios disponibles para reservar en este momento.</div>`;
      updateBookingSummary();
      return;
    }

    if (!dateISO) {
      grid.innerHTML = `<div class="empty-slots-msg">Selecciona una fecha para ver los horarios disponibles.</div>`;
      updateBookingSummary();
      return;
    }

    if (!isWorkingDay(dateISO)) {
      const dayName = DAY_NAMES_FULL[parseISODateLocal(dateISO).getDay()];
      hint.textContent = `Los ${dayName.toLowerCase()} no hay atención.`;
      hint.className = "field-hint error";
      grid.innerHTML = `<div class="empty-slots-msg">Cerrado los ${dayName.toLowerCase()}. Por favor elige otro día laboral en el calendario.</div>`;
      updateBookingSummary();
      return;
    }

    const slots = getAvailableSlotsForDate(dateISO, service.duration);
    const hasFree = slots.some((s) => s.available);

    if (slots.length === 0 || !hasFree) {
      grid.innerHTML = `<div class="empty-slots-msg">No quedan horarios libres para este servicio en la fecha elegida. Prueba con otro día.</div>`;
      updateBookingSummary();
      return;
    }

    grid.innerHTML = "";
    slots.forEach((slot) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "time-slot-btn";
      btn.textContent = slot.time;
      btn.dataset.time = slot.time;
      if (!slot.available) {
        btn.disabled = true;
        btn.title = slot.reason;
      } else {
        btn.addEventListener("click", () => selectBookingTime(slot.time));
      }
      grid.appendChild(btn);
    });

    updateBookingSummary();
  }

  function selectBookingTime(timeStr) {
    const hiddenTime = document.getElementById("booking-time");
    const buttons = document.querySelectorAll("#time-slots-grid .time-slot-btn");
    let matched = false;

    buttons.forEach((btn) => {
      if (btn.dataset.time === timeStr && !btn.disabled) {
        btn.classList.add("selected");
        matched = true;
      } else {
        btn.classList.remove("selected");
      }
    });

    hiddenTime.value = matched ? timeStr : "";
    updateBookingSummary();
  }

  function updateBookingSummary() {
    const service = getSelectedBookingService();
    const dateISO = document.getElementById("booking-date").value;
    const timeStr = document.getElementById("booking-time").value;

    document.getElementById("summary-service").textContent = service ? service.name : "—";
    document.getElementById("summary-duration").textContent = service ? formatDuration(service.duration) : "—";
    document.getElementById("summary-date").textContent = dateISO ? formatDisplayDate(dateISO) : "—";
    document.getElementById("summary-time").textContent = timeStr || "Por elegir";
    document.getElementById("summary-price").textContent = service ? formatCurrency(service.price) : "—";
  }

  async function handleDateInputChange() {
    const dateISO = document.getElementById("booking-date").value;
    if (isSupabaseMode() && dateISO && (!busySlotsRangeEnd || dateISO > busySlotsRangeEnd)) {
      await refreshBusySlotsRange(getTodayISO(), addDaysISO(dateISO, 14));
    }
    renderBookingSlots();
  }

  async function handleClientBookingSubmit(event) {
    event.preventDefault();

    const service = getSelectedBookingService();
    const dateISO = document.getElementById("booking-date").value;
    const timeStr = document.getElementById("booking-time").value;
    const clientName = document.getElementById("client-name").value.trim();
    const clientPhone = document.getElementById("client-phone").value.trim();
    const notes = document.getElementById("client-notes").value.trim();

    if (!service) {
      showToast("Selecciona un servicio válido.", "error");
      return;
    }
    if (!dateISO || dateISO < getTodayISO()) {
      showToast("Elige una fecha válida a partir de hoy.", "error");
      return;
    }
    if (!timeStr) {
      showToast("Por favor selecciona una hora disponible.", "error");
      return;
    }
    if (!clientName || clientName.length < 2) {
      showToast("Ingresa tu nombre o apodo.", "error");
      document.getElementById("client-name").focus();
      return;
    }
    if (normalizePhone(clientPhone).length < 6) {
      showToast("Ingresa un teléfono o WhatsApp válido.", "error");
      document.getElementById("client-phone").focus();
      return;
    }

    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Reservando...";

    try {
      let createdAppointment = null;

      if (isSupabaseMode()) {
        const { data, error } = await supabaseClient.rpc("create_client_appointment", {
          p_id: generateId("apt"),
          p_client_name: clientName,
          p_client_phone: clientPhone,
          p_service_id: service.id,
          p_date: dateISO,
          p_time: timeStr,
          p_notes: notes
        });

        if (error) {
          if (error.message && error.message.includes("HORARIO_OCUPADO")) {
            showToast("Ese horario acaba de ser ocupado por otro cliente. Elige otro.", "error");
            await refreshBusySlotsRange(getTodayISO(), addDaysISO(dateISO, 21));
            renderBookingSlots();
            renderHeroQuickSlots();
            return;
          }
          throw error;
        }

        createdAppointment = mapDbAppointment(data);
        busySlotsCache.push({
          date: createdAppointment.date,
          time: createdAppointment.time,
          duration: createdAppointment.duration
        });
      } else {
        const latestSlots = getAvailableSlotsForDate(dateISO, service.duration);
        const targetSlot = latestSlots.find((s) => s.time === timeStr && s.available);
        if (!targetSlot) {
          showToast("Ese horario ya no está disponible. Elige otro por favor.", "error");
          renderBookingSlots();
          return;
        }

        createdAppointment = {
          id: generateId("apt"),
          code: generateBookingCode(),
          clientName,
          clientPhone,
          serviceId: service.id,
          serviceName: service.name,
          duration: service.duration,
          price: service.price,
          date: dateISO,
          time: timeStr,
          status: "pendiente",
          notes,
          createdAt: new Date().toISOString()
        };

        appState.appointments.push(createdAppointment);
        saveLocalState();
      }

      document.getElementById("client-name").value = "";
      document.getElementById("client-phone").value = "";
      document.getElementById("client-notes").value = "";
      renderBookingSlots();
      renderHeroQuickSlots();
      if (!document.getElementById("admin-view").classList.contains("hidden")) {
        renderAdminPanel();
      }

      openConfirmationModal(createdAppointment);
      showToast("¡Reserva creada con éxito!", "success");
    } catch (err) {
      console.error("Error al crear reserva:", err);
      showToast("Ocurrió un error al guardar tu reserva. Intenta nuevamente.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  }

  function buildWhatsAppUrl(phoneNumber, messageText) {
    const cleanPhone = normalizePhone(phoneNumber);
    const encoded = encodeURIComponent(messageText);
    return `https://wa.me/${cleanPhone}?text=${encoded}`;
  }

  function openConfirmationModal(apt) {
    const detailsEl = document.getElementById("conf-details");
    detailsEl.innerHTML = `
      <p><strong>Código de reserva:</strong> <code>${escapeHtml(apt.code)}</code></p>
      <p><strong>Cliente:</strong> ${escapeHtml(apt.clientName)}</p>
      <p><strong>Servicio:</strong> ${escapeHtml(apt.serviceName)} (${escapeHtml(formatDuration(apt.duration))})</p>
      <p><strong>Fecha y hora:</strong> ${escapeHtml(formatDisplayDate(apt.date))} a las ${escapeHtml(apt.time)}</p>
      <p style="margin-bottom:0;"><strong>Total estimado:</strong> ${escapeHtml(formatCurrency(apt.price))}</p>
    `;

    const waBtn = document.getElementById("conf-whatsapp-link");
    const salonPhone = normalizePhone(appState.settings.whatsappNumber);
    if (salonPhone) {
      const msg =
        `Hola ${appState.settings.stylistName}, acabo de agendar una cita en ${appState.settings.businessName}:\n` +
        `• Código: ${apt.code}\n` +
        `• Nombre: ${apt.clientName}\n` +
        `• Servicio: ${apt.serviceName}\n` +
        `• Fecha: ${formatDisplayDate(apt.date)} a las ${apt.time}`;
      waBtn.href = buildWhatsAppUrl(salonPhone, msg);
      waBtn.classList.remove("hidden");
    } else {
      waBtn.classList.add("hidden");
    }

    openModal("confirmation-modal");
  }

  // ------------------------------------------------------------------------
  // CONSULTAR / CANCELAR CITA (CLIENTE)
  // ------------------------------------------------------------------------
  async function handleLookupSubmit(event) {
    event.preventDefault();
    const rawQuery = document.getElementById("lookup-query").value.trim();
    const resultsContainer = document.getElementById("lookup-results");

    if (!rawQuery) return;

    let matches = [];
    if (isSupabaseMode()) {
      const isCode = /^CITA-/i.test(rawQuery);
      const digits = normalizePhone(rawQuery);
      if (!isCode && digits.length < 6) {
        resultsContainer.innerHTML = `<div class="empty-state">Ingresa tu código (ej. <code>CITA-1024</code>) o al menos 6 dígitos de tu teléfono.</div>`;
        return;
      }

      resultsContainer.innerHTML = `<div class="empty-state">Buscando...</div>`;
      const { data, error } = await supabaseClient.rpc("lookup_client_appointments", {
        p_query: rawQuery
      });
      if (error) {
        console.error(error);
        showToast("Error al buscar tu cita.", "error");
        resultsContainer.innerHTML = "";
        return;
      }
      matches = Array.isArray(data) ? data.map(mapDbAppointment) : [];
    } else {
      const queryUpper = rawQuery.toUpperCase();
      const queryDigits = normalizePhone(rawQuery);

      matches = appState.appointments
        .filter((apt) => {
          const codeMatch = apt.code.toUpperCase() === queryUpper;
          const phoneMatch = queryDigits.length >= 4 && normalizePhone(apt.clientPhone).includes(queryDigits);
          return codeMatch || phoneMatch;
        })
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    }

    if (matches.length === 0) {
      resultsContainer.innerHTML = `<div class="empty-state">No encontramos citas con ese código o número de teléfono.</div>`;
      return;
    }

    resultsContainer.innerHTML = "";
    matches.forEach((apt) => {
      const card = document.createElement("div");
      card.className = "client-apt-item";

      const canCancel = apt.status === "pendiente" || apt.status === "confirmada";
      card.innerHTML = `
        <div>
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
            <strong>${escapeHtml(apt.serviceName)}</strong>
            <span class="status-badge status-${escapeHtml(apt.status)}">${escapeHtml(apt.status)}</span>
          </div>
          <div class="muted-text">
            ${escapeHtml(formatDisplayDate(apt.date))} · ${escapeHtml(apt.time)} · Código: <code>${escapeHtml(apt.code)}</code>
          </div>
        </div>
        <div>
          ${
            canCancel
              ? `<button type="button" class="btn btn-danger-outline btn-sm cancel-client-apt-btn">Cancelar cita</button>`
              : ""
          }
        </div>
      `;

      const cancelBtn = card.querySelector(".cancel-client-apt-btn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", async () => {
          if (!confirm(`¿Seguro que deseas cancelar tu cita ${apt.code} del ${formatDisplayDate(apt.date)}?`)) {
            return;
          }

          if (isSupabaseMode()) {
            const { data, error } = await supabaseClient.rpc("cancel_client_appointment", {
              p_id: apt.id,
              p_code: apt.code
            });
            if (error || !data) {
              showToast("No se pudo cancelar la cita.", "error");
              return;
            }
            await refreshBusySlotsRange(getTodayISO(), addDaysISO(getTodayISO(), 30));
          } else {
            apt.status = "cancelada";
            saveLocalState();
          }

          renderBookingSlots();
          renderHeroQuickSlots();
          handleLookupSubmit(new Event("submit"));
          showToast("Cita cancelada correctamente.", "success");
        });
      }

      resultsContainer.appendChild(card);
    });
  }

  // ------------------------------------------------------------------------
  // AUTENTICACIÓN Y NAVEGACIÓN AL PANEL DEL BARBERO
  // ------------------------------------------------------------------------
  function getStoredPin() {
    return activeAdminPin || sessionStorage.getItem(SESSION_PIN_KEY) || "";
  }

  function isAdminUnlocked() {
    return sessionStorage.getItem(SESSION_AUTH_KEY) === "true" && Boolean(getStoredPin());
  }

  async function loadAdminDashboardFromSupabase(pin) {
    const { data, error } = await supabaseClient.rpc("admin_verify_and_load", { p_pin: pin });
    if (error) throw error;

    activeAdminPin = pin;
    appState.settings = mapDbSettings(data.settings);
    appState.services = Array.isArray(data.services) ? data.services.map(mapDbService) : [];
    appState.appointments = Array.isArray(data.appointments) ? data.appointments.map(mapDbAppointment) : [];
    syncBusySlotsFromAppointments();
  }

  async function requestOpenAdmin() {
    if (isAdminUnlocked()) {
      if (isSupabaseMode()) {
        try {
          await loadAdminDashboardFromSupabase(getStoredPin());
          showAdminView();
          return;
        } catch (err) {
          sessionStorage.removeItem(SESSION_AUTH_KEY);
          sessionStorage.removeItem(SESSION_PIN_KEY);
          activeAdminPin = "";
        }
      } else {
        showAdminView();
        return;
      }
    }

    document.getElementById("pin-input").value = "";
    openModal("pin-modal");
    setTimeout(() => document.getElementById("pin-input").focus(), 80);
  }

  async function handlePinSubmit(event) {
    event.preventDefault();
    const entered = document.getElementById("pin-input").value.trim();
    const submitBtn = event.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      if (isSupabaseMode()) {
        await loadAdminDashboardFromSupabase(entered);
      } else if (entered !== appState.settings.adminPin) {
        throw new Error("PIN_INVALIDO");
      }

      activeAdminPin = entered;
      sessionStorage.setItem(SESSION_AUTH_KEY, "true");
      sessionStorage.setItem(SESSION_PIN_KEY, entered);
      closeModal("pin-modal");
      showAdminView();
      showToast("Bienvenido al panel de gestión.", "success");
    } catch (err) {
      showToast("PIN incorrecto. Intenta nuevamente.", "error");
      document.getElementById("pin-input").select();
    } finally {
      submitBtn.disabled = false;
    }
  }

  function showAdminView() {
    document.getElementById("client-view").classList.add("hidden");
    document.getElementById("admin-view").classList.remove("hidden");
    updateSyncBadge();
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderAdminPanel();
  }

  async function hideAdminView() {
    document.getElementById("admin-view").classList.add("hidden");
    document.getElementById("client-view").classList.remove("hidden");
    if (isSupabaseMode()) {
      await refreshPublicDataFromSupabase();
    }
    renderBusinessInfo();
    renderClientServices();
    renderBookingSlots();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function lockAdminPanel() {
    sessionStorage.removeItem(SESSION_AUTH_KEY);
    sessionStorage.removeItem(SESSION_PIN_KEY);
    activeAdminPin = "";
    hideAdminView();
    showToast("Panel bloqueado.", "info");
  }

  // ------------------------------------------------------------------------
  // PANEL DEL BARBERO: KPIs Y AGENDA DE CITAS
  // ------------------------------------------------------------------------
  function renderAdminPanel() {
    renderAdminKPIs();
    renderAdminAppointments();
    renderAdminServices();
    populateSettingsForm();

    // En modo nube ocultamos botones exclusivos de modo local para evitar confusión
    const resetBtn = document.getElementById("reset-demo-btn");
    const importLabel = document.getElementById("import-data-input")?.closest("label");
    if (resetBtn) resetBtn.classList.toggle("hidden", isSupabaseMode());
    if (importLabel) importLabel.classList.toggle("hidden", isSupabaseMode());
  }

  function renderAdminKPIs() {
    const today = getTodayISO();
    const activeToday = appState.appointments.filter(
      (a) => a.date === today && a.status !== "cancelada"
    );
    const pendingCount = appState.appointments.filter((a) => a.status === "pendiente").length;
    const completedCount = appState.appointments.filter((a) => a.status === "completada").length;

    const currentMonthPrefix = today.slice(0, 7);
    const monthRevenue = appState.appointments
      .filter(
        (a) =>
          a.date.startsWith(currentMonthPrefix) &&
          (a.status === "completada" || a.status === "confirmada")
      )
      .reduce((acc, a) => acc + (Number(a.price) || 0), 0);

    document.getElementById("admin-kpis").innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">Citas para hoy</span>
        <div class="kpi-value">${activeToday.length}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Pendientes por confirmar</span>
        <div class="kpi-value">${pendingCount}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Completadas (total)</span>
        <div class="kpi-value">${completedCount}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Ingresos est. este mes</span>
        <div class="kpi-value">${escapeHtml(formatCurrency(monthRevenue))}</div>
      </div>
    `;
  }

  function renderAdminAppointments() {
    const today = getTodayISO();
    const tomorrow = addDaysISO(today, 1);
    const statusFilter = document.getElementById("admin-status-filter").value;
    const searchQuery = document.getElementById("admin-search-input").value.trim().toLowerCase();

    const filtered = appState.appointments
      .filter((apt) => {
        if (activeAdminDateFilter === "today" && apt.date !== today) return false;
        if (activeAdminDateFilter === "tomorrow" && apt.date !== tomorrow) return false;
        if (activeAdminDateFilter === "upcoming" && apt.date < today) return false;
        if (statusFilter !== "all" && apt.status !== statusFilter) return false;

        if (searchQuery) {
          const haystack = `${apt.clientName} ${apt.clientPhone} ${apt.code} ${apt.serviceName}`.toLowerCase();
          if (!haystack.includes(searchQuery)) return false;
        }
        return true;
      })
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

    const container = document.getElementById("admin-appointments-list");
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">No hay citas que coincidan con este filtro.</div>`;
      return;
    }

    container.innerHTML = "";
    filtered.forEach((apt) => {
      const card = document.createElement("article");
      card.className = "apt-card";

      const waReminder = buildWhatsAppUrl(
        apt.clientPhone,
        `Hola ${apt.clientName}, te escribimos de ${appState.settings.businessName} para recordarte tu cita de ${apt.serviceName} el ${formatDisplayDate(apt.date)} a las ${apt.time}. ¡Te esperamos!`
      );

      card.innerHTML = `
        <div class="apt-time-box">
          <span class="apt-hour">${escapeHtml(apt.time)}</span>
          <span class="apt-date-small">${escapeHtml(formatDisplayDate(apt.date))}</span>
        </div>

        <div class="apt-details">
          <div class="apt-info-header">
            <span class="apt-client">${escapeHtml(apt.clientName)}</span>
            <span class="status-badge status-${escapeHtml(apt.status)}">${escapeHtml(apt.status)}</span>
            <span class="apt-code">${escapeHtml(apt.code)}</span>
          </div>
          <div class="apt-meta">
            <strong>${escapeHtml(apt.serviceName)}</strong> · ${escapeHtml(formatDuration(apt.duration))} · ${escapeHtml(formatCurrency(apt.price))} · Tel: ${escapeHtml(apt.clientPhone)}
          </div>
          ${apt.notes ? `<div class="apt-notes">Nota: ${escapeHtml(apt.notes)}</div>` : ""}
        </div>

        <div class="apt-actions">
          ${
            apt.status === "pendiente"
              ? `<button type="button" class="btn btn-secondary btn-sm" data-action="confirm">Confirmar</button>`
              : ""
          }
          ${
            apt.status === "pendiente" || apt.status === "confirmada"
              ? `<button type="button" class="btn btn-primary btn-sm" data-action="complete">Completar</button>`
              : ""
          }
          <button type="button" class="btn btn-outline btn-sm" data-action="edit">Editar</button>
          <a href="${waReminder}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm">WhatsApp</a>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete">Eliminar</button>
        </div>
      `;

      card.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => handleAppointmentAction(apt.id, btn.dataset.action));
      });

      container.appendChild(card);
    });
  }

  async function handleAppointmentAction(id, action) {
    const apt = appState.appointments.find((a) => a.id === id);
    if (!apt) return;

    try {
      if (action === "confirm") {
        if (isSupabaseMode()) {
          const { error } = await supabaseClient.rpc("admin_update_appointment_status", {
            p_pin: getStoredPin(),
            p_id: id,
            p_status: "confirmada"
          });
          if (error) throw error;
        }
        apt.status = "confirmada";
        saveLocalState();
        renderAdminPanel();
        showToast(`Cita ${apt.code} confirmada.`, "success");
      } else if (action === "complete") {
        if (isSupabaseMode()) {
          const { error } = await supabaseClient.rpc("admin_update_appointment_status", {
            p_pin: getStoredPin(),
            p_id: id,
            p_status: "completada"
          });
          if (error) throw error;
        }
        apt.status = "completada";
        saveLocalState();
        renderAdminPanel();
        showToast(`Cita ${apt.code} marcada como completada.`, "success");
      } else if (action === "edit") {
        openAdminAppointmentModal(apt);
      } else if (action === "delete") {
        if (!confirm(`¿Eliminar la cita de ${apt.clientName} (${apt.code})?`)) return;
        if (isSupabaseMode()) {
          const { error } = await supabaseClient.rpc("admin_delete_appointment", {
            p_pin: getStoredPin(),
            p_id: id
          });
          if (error) throw error;
        }
        appState.appointments = appState.appointments.filter((a) => a.id !== id);
        syncBusySlotsFromAppointments();
        saveLocalState();
        renderAdminPanel();
        showToast("Cita eliminada.", "info");
      }
    } catch (err) {
      console.error("Error ejecutando acción:", err);
      showToast("No se pudo actualizar la cita en la base de datos.", "error");
    }
  }

  function openAdminAppointmentModal(apt = null) {
    populateServiceDropdowns();
    document.getElementById("apt-modal-title").textContent = apt
      ? `Editar Cita ${apt.code}`
      : "Nueva Cita Manual";
    document.getElementById("admin-apt-id").value = apt ? apt.id : "";
    document.getElementById("admin-apt-client").value = apt ? apt.clientName : "";
    document.getElementById("admin-apt-phone").value = apt ? apt.clientPhone : "";
    document.getElementById("admin-apt-service").value = apt
      ? apt.serviceId
      : appState.services[0]?.id || "";
    document.getElementById("admin-apt-status").value = apt ? apt.status : "confirmada";
    document.getElementById("admin-apt-date").value = apt ? apt.date : getTodayISO();
    document.getElementById("admin-apt-time").value = apt ? apt.time : "10:00";
    document.getElementById("admin-apt-notes").value = apt ? apt.notes || "" : "";

    openModal("appointment-modal");
  }

  async function handleAdminAppointmentSubmit(event) {
    event.preventDefault();
    const id = document.getElementById("admin-apt-id").value;
    const clientName = document.getElementById("admin-apt-client").value.trim();
    const clientPhone = document.getElementById("admin-apt-phone").value.trim();
    const serviceId = document.getElementById("admin-apt-service").value;
    const status = document.getElementById("admin-apt-status").value;
    const date = document.getElementById("admin-apt-date").value;
    const time = document.getElementById("admin-apt-time").value;
    const notes = document.getElementById("admin-apt-notes").value.trim();

    const service = appState.services.find((s) => s.id === serviceId);
    if (!service || !clientName || !clientPhone || !date || !time) {
      showToast("Completa todos los campos obligatorios.", "error");
      return;
    }

    try {
      const targetId = id || generateId("apt");

      if (isSupabaseMode()) {
        const { data, error } = await supabaseClient.rpc("admin_save_appointment", {
          p_pin: getStoredPin(),
          p_id: targetId,
          p_client_name: clientName,
          p_client_phone: clientPhone,
          p_service_id: service.id,
          p_service_name: service.name,
          p_duration: service.duration,
          p_price: Math.round(service.price),
          p_date: date,
          p_time: time,
          p_status: status,
          p_notes: notes
        });
        if (error) throw error;

        const saved = mapDbAppointment(data);
        const idx = appState.appointments.findIndex((a) => a.id === saved.id);
        if (idx >= 0) {
          appState.appointments[idx] = saved;
        } else {
          appState.appointments.push(saved);
        }
        syncBusySlotsFromAppointments();
      } else {
        if (id) {
          const existing = appState.appointments.find((a) => a.id === id);
          if (existing) {
            existing.clientName = clientName;
            existing.clientPhone = clientPhone;
            existing.serviceId = service.id;
            existing.serviceName = service.name;
            existing.duration = service.duration;
            existing.price = service.price;
            existing.status = status;
            existing.date = date;
            existing.time = time;
            existing.notes = notes;
          }
        } else {
          appState.appointments.push({
            id: targetId,
            code: generateBookingCode(),
            clientName,
            clientPhone,
            serviceId: service.id,
            serviceName: service.name,
            duration: service.duration,
            price: service.price,
            date,
            time,
            status,
            notes,
            createdAt: new Date().toISOString()
          });
        }
        saveLocalState();
      }

      closeModal("appointment-modal");
      renderAdminPanel();
      showToast(id ? "Cita actualizada." : "Cita agregada a la agenda.", "success");
    } catch (err) {
      console.error("Error guardando cita:", err);
      showToast("Error al guardar la cita.", "error");
    }
  }

  // ------------------------------------------------------------------------
  // PANEL DEL BARBERO: GESTIÓN DE SERVICIOS
  // ------------------------------------------------------------------------
  function renderAdminServices() {
    const container = document.getElementById("admin-services-list");
    if (appState.services.length === 0) {
      container.innerHTML = `<div class="empty-state">No hay servicios creados todavía.</div>`;
      return;
    }

    container.innerHTML = "";
    appState.services.forEach((srv) => {
      const row = document.createElement("div");
      row.className = `admin-service-item${srv.active ? "" : " inactive"}`;
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(srv.name)}</strong> ${srv.active ? "" : '<span class="muted-text">(Oculto)</span>'}
          <div class="muted-text">
            ${escapeHtml(srv.category)} · ${escapeHtml(formatDuration(srv.duration))} · ${escapeHtml(formatCurrency(srv.price))}
          </div>
        </div>
        <div class="apt-actions">
          <button type="button" class="btn btn-outline btn-sm" data-srv-action="toggle">${srv.active ? "Ocultar" : "Activar"}</button>
          <button type="button" class="btn btn-outline btn-sm" data-srv-action="edit">Editar</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-srv-action="delete">Borrar</button>
        </div>
      `;

      row.querySelector('[data-srv-action="toggle"]').addEventListener("click", async () => {
        try {
          if (isSupabaseMode()) {
            const { error } = await supabaseClient.rpc("admin_save_service", {
              p_pin: getStoredPin(),
              p_id: srv.id,
              p_name: srv.name,
              p_category: srv.category,
              p_duration: srv.duration,
              p_price: Math.round(srv.price),
              p_description: srv.description || "",
              p_active: !srv.active
            });
            if (error) throw error;
          }
          srv.active = !srv.active;
          saveLocalState();
          renderAdminServices();
          renderClientServices();
          showToast(srv.active ? "Servicio activado." : "Servicio ocultado para clientes.", "info");
        } catch (err) {
          showToast("No se pudo actualizar el servicio.", "error");
        }
      });

      row.querySelector('[data-srv-action="edit"]').addEventListener("click", () => {
        document.getElementById("service-form-title").textContent = "Editar servicio";
        document.getElementById("edit-service-id").value = srv.id;
        document.getElementById("service-name-input").value = srv.name;
        document.getElementById("service-category-input").value = srv.category;
        document.getElementById("service-duration-input").value = srv.duration;
        document.getElementById("service-price-input").value = srv.price;
        document.getElementById("service-active-input").checked = srv.active;
        document.getElementById("service-desc-input").value = srv.description || "";
        document.getElementById("cancel-service-edit-btn").classList.remove("hidden");
      });

      row.querySelector('[data-srv-action="delete"]').addEventListener("click", async () => {
        if (appState.services.length <= 1) {
          showToast("Debes mantener al menos un servicio.", "error");
          return;
        }
        if (!confirm(`¿Eliminar el servicio "${srv.name}"?`)) return;
        try {
          if (isSupabaseMode()) {
            const { error } = await supabaseClient.rpc("admin_delete_service", {
              p_pin: getStoredPin(),
              p_id: srv.id
            });
            if (error) throw error;
          }
          appState.services = appState.services.filter((s) => s.id !== srv.id);
          saveLocalState();
          renderAdminServices();
          renderClientServices();
          showToast("Servicio eliminado.", "info");
        } catch (err) {
          showToast("No se pudo eliminar el servicio.", "error");
        }
      });

      container.appendChild(row);
    });
  }

  function resetServiceForm() {
    document.getElementById("service-form-title").textContent = "Agregar nuevo servicio";
    document.getElementById("admin-service-form").reset();
    document.getElementById("edit-service-id").value = "";
    document.getElementById("service-duration-input").value = 45;
    document.getElementById("service-active-input").checked = true;
    document.getElementById("cancel-service-edit-btn").classList.add("hidden");
  }

  async function handleAdminServiceSubmit(event) {
    event.preventDefault();
    const editId = document.getElementById("edit-service-id").value;
    const name = document.getElementById("service-name-input").value.trim();
    const category = document.getElementById("service-category-input").value.trim() || "Cortes";
    const duration = Number(document.getElementById("service-duration-input").value);
    const price = Number(document.getElementById("service-price-input").value);
    const active = document.getElementById("service-active-input").checked;
    const description = document.getElementById("service-desc-input").value.trim();

    if (!name || duration < 10 || Number.isNaN(price) || price < 0) {
      showToast("Revisa el nombre, duración (mín. 10 min) y precio.", "error");
      return;
    }

    try {
      const targetId = editId || generateId("srv");
      if (isSupabaseMode()) {
        const { data, error } = await supabaseClient.rpc("admin_save_service", {
          p_pin: getStoredPin(),
          p_id: targetId,
          p_name: name,
          p_category: category,
          p_duration: duration,
          p_price: Math.round(price),
          p_description: description,
          p_active: active
        });
        if (error) throw error;

        const saved = mapDbService(data);
        const idx = appState.services.findIndex((s) => s.id === saved.id);
        if (idx >= 0) {
          appState.services[idx] = saved;
        } else {
          appState.services.push(saved);
        }
      } else {
        if (editId) {
          const target = appState.services.find((s) => s.id === editId);
          if (target) {
            target.name = name;
            target.category = category;
            target.duration = duration;
            target.price = price;
            target.active = active;
            target.description = description;
          }
        } else {
          appState.services.push({
            id: targetId,
            name,
            category,
            duration,
            price,
            active,
            description
          });
        }
        saveLocalState();
      }

      resetServiceForm();
      renderAdminServices();
      renderClientServices();
      showToast(editId ? "Servicio actualizado." : "Nuevo servicio agregado.", "success");
    } catch (err) {
      console.error("Error guardando servicio:", err);
      showToast("No se pudo guardar el servicio.", "error");
    }
  }

  // ------------------------------------------------------------------------
  // PANEL DEL BARBERO: CONFIGURACIÓN, HORARIOS Y RESPALDO
  // ------------------------------------------------------------------------
  function populateSettingsForm() {
    const s = appState.settings;
    document.getElementById("setting-business-name").value = s.businessName;
    document.getElementById("setting-stylist-name").value = s.stylistName;
    document.getElementById("setting-whatsapp").value = s.whatsappNumber;
    document.getElementById("setting-currency").value = s.currencySymbol;
    document.getElementById("setting-instagram-handle").value = s.instagramHandle || "";
    document.getElementById("setting-instagram-url").value = s.instagramUrl || "";
    document.getElementById("setting-open-time").value = s.schedule.openTime;
    document.getElementById("setting-close-time").value = s.schedule.closeTime;
    document.getElementById("setting-slot-step").value = String(s.schedule.slotStepMinutes);
    document.getElementById("setting-break-start").value = s.schedule.breakStart || "";
    document.getElementById("setting-break-end").value = s.schedule.breakEnd || "";
    document.getElementById("setting-admin-pin").value = getStoredPin() || s.adminPin;

    document.querySelectorAll('#setting-working-days input[type="checkbox"]').forEach((cb) => {
      cb.checked = s.schedule.workingDays.includes(Number(cb.value));
    });
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();

    const openTime = document.getElementById("setting-open-time").value;
    const closeTime = document.getElementById("setting-close-time").value;
    const breakStart = document.getElementById("setting-break-start").value;
    const breakEnd = document.getElementById("setting-break-end").value;
    const workingDays = Array.from(
      document.querySelectorAll('#setting-working-days input[type="checkbox"]:checked')
    ).map((cb) => Number(cb.value));

    if (timeToMinutes(openTime) >= timeToMinutes(closeTime)) {
      showToast("La hora de cierre debe ser posterior a la de apertura.", "error");
      return;
    }
    if (workingDays.length === 0) {
      showToast("Selecciona al menos un día laboral.", "error");
      return;
    }
    if (breakStart && breakEnd && timeToMinutes(breakStart) >= timeToMinutes(breakEnd)) {
      showToast("El horario de descanso tiene horas inválidas.", "error");
      return;
    }

    const newPin = document.getElementById("setting-admin-pin").value.trim();
    if (newPin.length < 4) {
      showToast("El PIN debe tener al menos 4 caracteres.", "error");
      return;
    }

    const nextSchedule = {
      openTime,
      closeTime,
      breakStart,
      breakEnd,
      slotStepMinutes: Number(document.getElementById("setting-slot-step").value) || 15,
      workingDays
    };

    const nextBusinessName = document.getElementById("setting-business-name").value.trim();
    const nextStylistName = document.getElementById("setting-stylist-name").value.trim();
    const nextWhatsapp = normalizePhone(document.getElementById("setting-whatsapp").value);
    const nextCurrency = document.getElementById("setting-currency").value.trim() || "$";
    const nextIgHandle = document.getElementById("setting-instagram-handle").value.trim();
    const nextIgUrl = document.getElementById("setting-instagram-url").value.trim();

    try {
      if (isSupabaseMode()) {
        const currentPin = getStoredPin();
        const { data, error } = await supabaseClient.rpc("admin_save_settings", {
          p_pin: currentPin,
          p_business_name: nextBusinessName,
          p_stylist_name: nextStylistName,
          p_whatsapp_number: nextWhatsapp,
          p_currency_symbol: nextCurrency,
          p_instagram_handle: nextIgHandle,
          p_instagram_url: nextIgUrl,
          p_schedule: nextSchedule,
          p_new_pin: newPin
        });
        if (error) throw error;

        activeAdminPin = newPin;
        sessionStorage.setItem(SESSION_PIN_KEY, newPin);
        appState.settings = mapDbSettings(data);
      } else {
        appState.settings.businessName = nextBusinessName;
        appState.settings.stylistName = nextStylistName;
        appState.settings.whatsappNumber = nextWhatsapp;
        appState.settings.currencySymbol = nextCurrency;
        appState.settings.instagramHandle = nextIgHandle;
        appState.settings.instagramUrl = nextIgUrl;
        appState.settings.adminPin = newPin;
        appState.settings.schedule = nextSchedule;
        activeAdminPin = newPin;
        sessionStorage.setItem(SESSION_PIN_KEY, newPin);
        saveLocalState();
      }

      renderBusinessInfo();
      renderBookingSlots();
      showToast("Configuración guardada correctamente.", "success");
    } catch (err) {
      console.error("Error guardando configuración:", err);
      showToast("No se pudo guardar la configuración.", "error");
    }
  }

  function handleExportData() {
    const exportPayload = {
      ...appState,
      settings: { ...appState.settings, adminPin: undefined }
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `respaldo-c4leb-barber-${getTodayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Respaldo descargado.", "success");
  }

  function handleImportData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!imported.settings || !Array.isArray(imported.services) || !Array.isArray(imported.appointments)) {
          throw new Error("Archivo incompatible");
        }
        saveLocalState(imported);
        renderBusinessInfo();
        renderClientServices();
        renderAdminPanel();
        showToast("Respaldo restaurado con éxito.", "success");
      } catch (err) {
        showToast("El archivo seleccionado no es un respaldo válido.", "error");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  function handleResetDemo() {
    if (!confirm("¿Seguro que deseas restaurar los datos iniciales? Se perderán los cambios actuales.")) {
      return;
    }
    const fresh = buildDefaultState();
    saveLocalState(fresh);
    syncBusySlotsFromAppointments();
    renderBusinessInfo();
    renderClientServices();
    initBookingDefaults();
    renderAdminPanel();
    showToast("Datos iniciales restaurados.", "info");
  }

  // ------------------------------------------------------------------------
  // GESTIÓN DE MODALES Y EVENTOS GLOBALES
  // ------------------------------------------------------------------------
  function openModal(modalId) {
    document.getElementById(modalId).classList.remove("hidden");
  }

  function closeModal(modalId) {
    document.getElementById(modalId).classList.add("hidden");
  }

  function bindEvents() {
    const menuToggle = document.getElementById("menu-toggle");
    const mainNav = document.getElementById("main-nav");
    menuToggle.addEventListener("click", () => {
      const isOpen = mainNav.classList.toggle("open");
      menuToggle.setAttribute("aria-expanded", String(isOpen));
    });
    mainNav.querySelectorAll("a, button").forEach((el) => {
      el.addEventListener("click", () => {
        mainNav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.getAttribute("data-close-modal")));
    });
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.classList.add("hidden");
      });
    });

    document.getElementById("booking-service").addEventListener("change", () => {
      renderBookingSlots();
      updateBookingSummary();
    });
    document.getElementById("booking-date").addEventListener("change", handleDateInputChange);
    document.getElementById("booking-form").addEventListener("submit", handleClientBookingSubmit);
    document.getElementById("lookup-form").addEventListener("submit", handleLookupSubmit);

    document.getElementById("open-admin-btn").addEventListener("click", requestOpenAdmin);
    document.getElementById("pin-form").addEventListener("submit", handlePinSubmit);
    document.getElementById("close-admin-btn").addEventListener("click", hideAdminView);
    document.getElementById("admin-lock-btn").addEventListener("click", lockAdminPanel);
    document.getElementById("nav-brand-link").addEventListener("click", () => {
      if (!document.getElementById("admin-view").classList.contains("hidden")) {
        hideAdminView();
      }
    });

    document.querySelectorAll(".admin-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        activeAdminTab = tabBtn.dataset.adminTab;
        document.querySelectorAll(".admin-tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".admin-tab-panel").forEach((p) => p.classList.remove("active"));
        tabBtn.classList.add("active");
        document.getElementById(`tab-${activeAdminTab}`).classList.add("active");
      });
    });

    document.querySelectorAll("#admin-date-filters .pill-btn").forEach((pill) => {
      pill.addEventListener("click", () => {
        activeAdminDateFilter = pill.dataset.dateFilter;
        document
          .querySelectorAll("#admin-date-filters .pill-btn")
          .forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        renderAdminAppointments();
      });
    });
    document.getElementById("admin-status-filter").addEventListener("change", renderAdminAppointments);
    document.getElementById("admin-search-input").addEventListener("input", renderAdminAppointments);

    document.getElementById("admin-new-apt-btn").addEventListener("click", () => openAdminAppointmentModal(null));
    document.getElementById("admin-apt-form").addEventListener("submit", handleAdminAppointmentSubmit);

    document.getElementById("admin-service-form").addEventListener("submit", handleAdminServiceSubmit);
    document.getElementById("cancel-service-edit-btn").addEventListener("click", resetServiceForm);

    document.getElementById("admin-settings-form").addEventListener("submit", handleSettingsSubmit);
    document.getElementById("export-data-btn").addEventListener("click", handleExportData);
    document.getElementById("import-data-input").addEventListener("change", handleImportData);
    document.getElementById("reset-demo-btn").addEventListener("click", handleResetDemo);

    // Refresco automático de disponibilidad en la vista cliente cuando Supabase está activo
    document.addEventListener("visibilitychange", async () => {
      if (
        document.visibilityState === "visible" &&
        isSupabaseMode() &&
        document.getElementById("admin-view").classList.contains("hidden")
      ) {
        await refreshBusySlotsRange(getTodayISO(), addDaysISO(getTodayISO(), 30));
        renderBookingSlots();
        renderHeroQuickSlots();
      }
    });

    setInterval(async () => {
      if (
        isSupabaseMode() &&
        document.visibilityState === "visible" &&
        document.getElementById("admin-view").classList.contains("hidden")
      ) {
        await refreshBusySlotsRange(getTodayISO(), addDaysISO(getTodayISO(), 30));
        renderBookingSlots();
        renderHeroQuickSlots();
      }
    }, 30000);
  }

  // ------------------------------------------------------------------------
  // INICIALIZACIÓN
  // ------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    initSupabaseClient();
    appState = isSupabaseMode() ? buildDefaultState() : loadLocalState();
    syncBusySlotsFromAppointments();
    bindEvents();

    if (isSupabaseMode()) {
      await refreshPublicDataFromSupabase();
    }

    updateSyncBadge();
    renderBusinessInfo();
    renderClientServices();
    initBookingDefaults();
  });
})();
