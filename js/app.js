/* ==========================================================================
   LÓGICA PRINCIPAL DE C4LEB BARBER Y GESTIÓN DE AGENDA
   ========================================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "c4leb_barber_state_v1";
  const SESSION_AUTH_KEY = "c4leb_admin_unlocked";

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

  // Estado global de la aplicación
  let appState = null;
  let activeServiceCategory = "Todos";
  let activeAdminDateFilter = "today";
  let activeAdminTab = "appointments";

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
  // PERSISTENCIA EN LOCALSTORAGE Y DATOS INICIALES
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

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const fresh = buildDefaultState();
        saveState(fresh);
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
      saveState(fresh);
      return fresh;
    }
  }

  function saveState(nextState = appState) {
    appState = nextState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
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

    // Citas activas en la misma fecha (las canceladas liberan el espacio)
    const dayAppointments = appState.appointments.filter(
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

      // Si es hoy, exigir al menos 15 min de margen
      if (dateISO === todayISO && start <= nowMinutes + 15) {
        available = false;
        reason = "Horario pasado";
      }

      // Verificar cruce con horario de descanso / almuerzo
      if (available && hasBreak && start < breakEnd && end > breakStart) {
        available = false;
        reason = "Descanso";
      }

      // Verificar cruce con otras citas agendadas
      if (available) {
        const conflict = dayAppointments.some((apt) => {
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

    // Mostrar pestañas de categoría solo si hay más de 3 servicios activos y más de 1 categoría
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

  function handleClientBookingSubmit(event) {
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

    const latestSlots = getAvailableSlotsForDate(dateISO, service.duration);
    const targetSlot = latestSlots.find((s) => s.time === timeStr && s.available);
    if (!targetSlot) {
      showToast("Ese horario ya no está disponible. Elige otro por favor.", "error");
      renderBookingSlots();
      return;
    }

    const newAppointment = {
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

    appState.appointments.push(newAppointment);
    saveState();

    document.getElementById("client-name").value = "";
    document.getElementById("client-phone").value = "";
    document.getElementById("client-notes").value = "";
    renderBookingSlots();
    renderHeroQuickSlots();
    if (!document.getElementById("admin-view").classList.contains("hidden")) {
      renderAdminPanel();
    }

    openConfirmationModal(newAppointment);
    showToast("¡Reserva creada con éxito!", "success");
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
  function handleLookupSubmit(event) {
    event.preventDefault();
    const rawQuery = document.getElementById("lookup-query").value.trim();
    const resultsContainer = document.getElementById("lookup-results");

    if (!rawQuery) return;

    const queryUpper = rawQuery.toUpperCase();
    const queryDigits = normalizePhone(rawQuery);

    const matches = appState.appointments
      .filter((apt) => {
        const codeMatch = apt.code.toUpperCase() === queryUpper;
        const phoneMatch = queryDigits.length >= 4 && normalizePhone(apt.clientPhone).includes(queryDigits);
        return codeMatch || phoneMatch;
      })
      .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

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
              ? `<button type="button" class="btn btn-danger-outline btn-sm cancel-client-apt-btn" data-id="${escapeHtml(apt.id)}">Cancelar cita</button>`
              : ""
          }
        </div>
      `;

      const cancelBtn = card.querySelector(".cancel-client-apt-btn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
          if (!confirm(`¿Seguro que deseas cancelar tu cita ${apt.code} del ${formatDisplayDate(apt.date)}?`)) {
            return;
          }
          apt.status = "cancelada";
          saveState();
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
  function isAdminUnlocked() {
    return sessionStorage.getItem(SESSION_AUTH_KEY) === "true";
  }

  function requestOpenAdmin() {
    if (isAdminUnlocked()) {
      showAdminView();
    } else {
      document.getElementById("pin-input").value = "";
      openModal("pin-modal");
      setTimeout(() => document.getElementById("pin-input").focus(), 80);
    }
  }

  function handlePinSubmit(event) {
    event.preventDefault();
    const entered = document.getElementById("pin-input").value.trim();
    if (entered === appState.settings.adminPin) {
      sessionStorage.setItem(SESSION_AUTH_KEY, "true");
      closeModal("pin-modal");
      showAdminView();
      showToast("Bienvenido al panel de gestión.", "success");
    } else {
      showToast("PIN incorrecto. Intenta nuevamente.", "error");
      document.getElementById("pin-input").select();
    }
  }

  function showAdminView() {
    document.getElementById("client-view").classList.add("hidden");
    document.getElementById("admin-view").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderAdminPanel();
  }

  function hideAdminView() {
    document.getElementById("admin-view").classList.add("hidden");
    document.getElementById("client-view").classList.remove("hidden");
    renderBusinessInfo();
    renderClientServices();
    renderBookingSlots();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function lockAdminPanel() {
    sessionStorage.removeItem(SESSION_AUTH_KEY);
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

  function handleAppointmentAction(id, action) {
    const apt = appState.appointments.find((a) => a.id === id);
    if (!apt) return;

    if (action === "confirm") {
      apt.status = "confirmada";
      saveState();
      renderAdminPanel();
      showToast(`Cita ${apt.code} confirmada.`, "success");
    } else if (action === "complete") {
      apt.status = "completada";
      saveState();
      renderAdminPanel();
      showToast(`Cita ${apt.code} marcada como completada.`, "success");
    } else if (action === "edit") {
      openAdminAppointmentModal(apt);
    } else if (action === "delete") {
      if (!confirm(`¿Eliminar la cita de ${apt.clientName} (${apt.code})?`)) return;
      appState.appointments = appState.appointments.filter((a) => a.id !== id);
      saveState();
      renderAdminPanel();
      showToast("Cita eliminada.", "info");
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

  function handleAdminAppointmentSubmit(event) {
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
      showToast("Cita actualizada.", "success");
    } else {
      appState.appointments.push({
        id: generateId("apt"),
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
      showToast("Cita agregada a la agenda.", "success");
    }

    saveState();
    closeModal("appointment-modal");
    renderAdminPanel();
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

      row.querySelector('[data-srv-action="toggle"]').addEventListener("click", () => {
        srv.active = !srv.active;
        saveState();
        renderAdminServices();
        renderClientServices();
        showToast(srv.active ? "Servicio activado." : "Servicio ocultado para clientes.", "info");
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

      row.querySelector('[data-srv-action="delete"]').addEventListener("click", () => {
        if (appState.services.length <= 1) {
          showToast("Debes mantener al menos un servicio.", "error");
          return;
        }
        if (!confirm(`¿Eliminar el servicio "${srv.name}"?`)) return;
        appState.services = appState.services.filter((s) => s.id !== srv.id);
        saveState();
        renderAdminServices();
        renderClientServices();
        showToast("Servicio eliminado.", "info");
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

  function handleAdminServiceSubmit(event) {
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
      showToast("Servicio actualizado.", "success");
    } else {
      appState.services.push({
        id: generateId("srv"),
        name,
        category,
        duration,
        price,
        active,
        description
      });
      showToast("Nuevo servicio agregado.", "success");
    }

    saveState();
    resetServiceForm();
    renderAdminServices();
    renderClientServices();
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
    document.getElementById("setting-admin-pin").value = s.adminPin;

    document.querySelectorAll('#setting-working-days input[type="checkbox"]').forEach((cb) => {
      cb.checked = s.schedule.workingDays.includes(Number(cb.value));
    });
  }

  function handleSettingsSubmit(event) {
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

    const pin = document.getElementById("setting-admin-pin").value.trim();
    if (pin.length < 4) {
      showToast("El PIN debe tener al menos 4 caracteres.", "error");
      return;
    }

    appState.settings.businessName = document.getElementById("setting-business-name").value.trim();
    appState.settings.stylistName = document.getElementById("setting-stylist-name").value.trim();
    appState.settings.whatsappNumber = normalizePhone(document.getElementById("setting-whatsapp").value);
    appState.settings.currencySymbol = document.getElementById("setting-currency").value.trim() || "$";
    appState.settings.instagramHandle = document.getElementById("setting-instagram-handle").value.trim();
    appState.settings.instagramUrl = document.getElementById("setting-instagram-url").value.trim();
    appState.settings.adminPin = pin;
    appState.settings.schedule = {
      openTime,
      closeTime,
      breakStart,
      breakEnd,
      slotStepMinutes: Number(document.getElementById("setting-slot-step").value) || 15,
      workingDays
    };

    saveState();
    renderBusinessInfo();
    renderBookingSlots();
    showToast("Configuración guardada correctamente.", "success");
  }

  function handleExportData() {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
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
        saveState(imported);
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
    saveState(fresh);
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
    document.getElementById("booking-date").addEventListener("change", renderBookingSlots);
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
  }

  // ------------------------------------------------------------------------
  // INICIALIZACIÓN
  // ------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    appState = loadState();
    renderBusinessInfo();
    renderClientServices();
    initBookingDefaults();
    bindEvents();
  });
})();
