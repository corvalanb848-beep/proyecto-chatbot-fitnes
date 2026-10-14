const STORAGE_KEY = "fitai-local-progress-v1";
const PREFERENCES_KEY = "fitai-local-preferences-v1";
const ANALYTICS_CONSENT_KEY = "fitai-local-analytics-consent-v1";
const ANALYTICS_EVENTS_KEY = "fitai-local-analytics-events-v1";

function readPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    const focus = ["consistencia", "entrenamiento", "nutricion"].includes(preferences.focus)
      ? preferences.focus
      : "consistencia";
    const weeklyGoal = Number(preferences.weeklyGoal);
    return {
      name: typeof preferences.name === "string" ? preferences.name.slice(0, 40) : "",
      focus,
      weeklyGoal: Number.isInteger(weeklyGoal) && weeklyGoal >= 2 && weeklyGoal <= 7 ? weeklyGoal : 4,
      configured: preferences.configured === true
    };
  } catch {
    return { name: "", focus: "consistencia", weeklyGoal: 4, configured: false };
  }
}

let userPreferences = readPreferences();

const dayNames = ["D", "L", "M", "X", "J", "V", "S"];
const today = new Date();
const weekStart = new Date(today);
weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));

function readProgress() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((date) => typeof date === "string") : [];
  } catch {
    return [];
  }
}

let sessions = readProgress();

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getCurrentStreak() {
  const savedDays = new Set(sessions);
  const cursor = new Date(today);
  if (!savedDays.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (savedDays.has(dateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function renderAchievements(streak, weeklySessions) {
  const achievements = {
    first: sessions.length >= 1,
    five: sessions.length >= 5,
    streak: streak >= 3,
    weekly: weeklySessions >= userPreferences.weeklyGoal
  };
  let earnedCount = 0;

  Object.entries(achievements).forEach(([key, earned]) => {
    const item = document.querySelector(`[data-achievement="${key}"]`);
    item.classList.toggle("is-earned", earned);
    item.querySelector(".achievement-state").textContent = earned ? "Desbloqueado" : "Pendiente";
    if (earned) earnedCount += 1;
  });

  document.querySelector("#weekly-achievement-description").textContent = `Completa ${userPreferences.weeklyGoal} ${userPreferences.weeklyGoal === 1 ? "sesión" : "sesiones"}`;
  document.querySelector("#achievement-count").textContent = `${earnedCount} / 4`;
}

function renderActivity() {
  const weekBars = document.querySelector("#week-bars");
  const weekDays = document.querySelector("#week-days");
  const chart = document.querySelector("#progress-chart");
  const weekCount = document.querySelector("#week-count");
  const total = document.querySelector("#total-sessions");
  const activeThisWeek = [];
  const labels = [];
  const chartBars = [];
  const todayOffset = Math.floor((today - weekStart) / 86400000);

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + offset);
    const key = dateKey(date);
    const completed = sessions.includes(key);
    const isToday = key === dateKey(today);
    const isFuture = offset > todayOffset;
    if (completed) activeThisWeek.push(key);
    labels.push(`<span class="${isToday ? "today" : ""}">${dayNames[date.getDay()]}</span>`);
    weekBars.insertAdjacentHTML("beforeend", `<span class="week-bar ${completed ? "is-done" : ""} ${isToday ? "is-today" : ""}" title="${completed ? "Sesión registrada" : "Sin sesión registrada"}"></span>`);
    chartBars.push(`<div class="chart-column ${isToday ? "is-today" : ""} ${isFuture ? "is-future" : ""}" style="--bar-height:${completed ? "68px" : "4px"}" title="${isFuture ? "Día futuro" : completed ? "1 sesión" : "0 sesiones"}"><span class="chart-value">${isFuture ? "—" : completed ? "1" : "0"}</span><span class="chart-stick ${completed ? (isToday ? "is-today" : "is-active") : ""}"></span><span class="chart-label">${dayNames[date.getDay()]}</span></div>`);
  }

  weekBars.innerHTML = "";
  weekDays.innerHTML = labels.join("");
  chart.innerHTML = `<span class="chart-goal-line" aria-hidden="true"></span>${chartBars.join("")}`;
  weekCount.textContent = activeThisWeek.length;
  document.querySelector("#progress-week-count").textContent = activeThisWeek.length;
  document.querySelector("#week-goal-label").textContent = userPreferences.weeklyGoal;
  document.querySelector("#progress-week-goal").textContent = userPreferences.weeklyGoal;
  total.textContent = sessions.length;
  const streak = getCurrentStreak();
  document.querySelector("#streak-count").textContent = streak;
  document.querySelector("#streak-label").textContent = streak === 1 ? "día de racha" : "días de racha";
  document.querySelector("#progress-streak-count").textContent = streak;
  document.querySelector("#progress-streak-label").textContent = streak === 1 ? "día de racha" : "días de racha";
  chart.hidden = activeThisWeek.length === 0;
  document.querySelector("#progress-empty").hidden = activeThisWeek.length > 0;
  renderAchievements(streak, activeThisWeek.length);
  renderPersonalRecommendation();
}

function recordSession() {
  const key = dateKey(today);
  if (!sessions.includes(key)) {
    sessions.push(key);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    trackMarketingEvent("workout_registered");
    renderActivity();
    showDialog("Sesión registrada", "¡Listo! Tu sesión quedó guardada en este dispositivo y ya cuenta para tu progreso semanal.", "Ver mi progreso", "progreso");
  } else {
    showDialog("Ya registraste tu sesión de hoy", "Tu actividad de hoy ya está contabilizada. Mañana puedes sumar una nueva sesión.", "Entendido");
  }
}

const featureDialog = document.querySelector("#feature-dialog");
const chatDialog = document.querySelector("#chat-dialog");
let mapInstance;
let mapConfigPromise;
let locationMarker;
let mapTileError = false;

function setMapStatus(message, isError = false) {
  const status = document.querySelector("#map-status");
  status.classList.toggle("is-error", isError);
  status.innerHTML = message;
}

async function getMapConfig() {
  if (!mapConfigPromise) {
    mapConfigPromise = fetch("/api/map-config", { headers: { Accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error("No se pudo leer la configuración del mapa.");
        return response.json();
      });
  }
  return mapConfigPromise;
}

async function initializeMap() {
  if (mapInstance) {
    requestAnimationFrame(() => mapInstance.invalidateSize({ pan: false }));
    return mapInstance;
  }
  if (!window.L) {
    setMapStatus("No se pudo cargar la biblioteca del mapa. Comprueba tu conexión y vuelve a intentarlo.", true);
    return null;
  }

  const mapElement = document.querySelector("#fitai-map");
  mapElement.setAttribute("aria-busy", "true");
  setMapStatus("Cargando mapa…");
  try {
    const config = await getMapConfig();
    mapInstance = window.L.map(mapElement, {
      center: [20, 0],
      zoom: 2,
      scrollWheelZoom: true,
      preferCanvas: true
    });
    const tileLayer = window.L.tileLayer(config.tileUrl, {
      attribution: config.attribution,
      maxZoom: 19,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 2
    });
    tileLayer.on("tileerror", () => {
      if (mapTileError) return;
      mapTileError = true;
      setMapStatus('No se pudieron cargar los mosaicos. Revisa la configuración del proveedor o su política de uso. <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">Consultar OpenStreetMap</a>.', true);
    });
    tileLayer.on("load", () => {
      if (!mapTileError) {
        mapElement.setAttribute("aria-busy", "false");
        setMapStatus("Mapa listo. La ubicación solo se consulta si pulsas «Mi ubicación».");
      }
    });
    tileLayer.addTo(mapInstance);
    window.L.control.scale({ imperial: false, maxWidth: 120 }).addTo(mapInstance);
    requestAnimationFrame(() => mapInstance.invalidateSize({ pan: false }));
    return mapInstance;
  } catch {
    if (!mapInstance) mapConfigPromise = null;
    mapElement.setAttribute("aria-busy", "false");
    setMapStatus('No se pudo preparar el mapa. Inicia FitAI con <code>npm start</code> y revisa la conexión. <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">Abrir un mapa alternativo</a>.', true);
    return null;
  }
}

async function showMap() {
  trackMarketingEvent("map_open");
  const section = document.querySelector("#mapa");
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  await initializeMap();
}

async function showCurrentLocation() {
  const map = await initializeMap();
  if (!map) return;
  const locationStatus = document.querySelector("#location-status");
  if (!navigator.geolocation) {
    locationStatus.textContent = "Este navegador no ofrece geolocalización.";
    return;
  }

  locationStatus.textContent = "Solicitando permiso de ubicación…";
  navigator.geolocation.getCurrentPosition((position) => {
    const point = [position.coords.latitude, position.coords.longitude];
    map.flyTo(point, 15);
    if (!locationMarker) locationMarker = window.L.marker(point).addTo(map);
    else locationMarker.setLatLng(point);
    locationMarker.bindPopup("Estás aquí").openPopup();
    locationStatus.textContent = "Ubicación mostrada. No se guarda ni se registra tu recorrido.";
  }, (error) => {
    const messages = {
      1: "No se concedió permiso para acceder a la ubicación.",
      2: "No se pudo determinar la ubicación. Comprueba la señal e inténtalo de nuevo.",
      3: "La solicitud de ubicación tardó demasiado. Inténtalo otra vez."
    };
    locationStatus.textContent = messages[error.code] || "No se pudo obtener la ubicación.";
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}

function showDialog(title, text, actionLabel, actionView) {
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-eyebrow").textContent = "TU PROGRESO";
  document.querySelector("#dialog-body").innerHTML = `<p>${text}</p>`;
  const actions = document.querySelector("#dialog-actions");
  actions.innerHTML = actionLabel ? `<button data-dialog-view="${actionView || ""}">${actionLabel}</button>` : `<button data-dismiss>Entendido</button>`;
  featureDialog.showModal();
}

function showFeature(view) {
  if (view === "presentacion") {
    document.querySelector("#presentacion").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (view === "nutricion") {
    trackMarketingEvent("scanner_open");
    document.querySelector("#nutrition-scanner").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (view === "mapa") {
    showMap();
    return;
  }
  if (view === "chat") {
    chatDialog.showModal();
    return;
  }

  const content = {
    entrenamiento: {
      eyebrow: "ENTRENAMIENTO",
      title: "Muévete a tu manera.",
      body: "<p>Una rutina breve para activar todo el cuerpo, sin equipamiento.</p><ul><li>Sentadillas · 3 series de 10</li><li>Flexiones inclinadas · 3 series de 8</li><li>Puente de glúteos · 3 series de 12</li><li>Bird-dog · 3 series de 8 por lado</li><li>Marcha en el lugar · 3 series de 30 segundos</li></ul><p>Adapta cada ejercicio a tu condición física y detente si sientes dolor.</p>",
      action: "Registrar sesión"
    },
    nutricion: {
      eyebrow: "NUTRICIÓN",
      title: "Ideas para nutrirte bien.",
      body: "<p>Una alimentación saludable puede ser flexible y placentera.</p><ul><li>Incluye vegetales o frutas de distintos colores.</li><li>Agrega una fuente de proteína que disfrutes.</li><li>Elige carbohidratos que te aporten energía, como avena, legumbres o arroz.</li><li>Hidrátate según tu sed y tu actividad.</li></ul><p>Estas ideas son generales y no sustituyen orientación nutricional individual.</p>",
      action: "Entendido"
    },
    progreso: {
      eyebrow: "TU PROGRESO",
      title: "La constancia se construye.",
      body: `<p>Tienes <strong>${sessions.length}</strong> sesiones registradas en este dispositivo. ${sessions.length ? "Sigue a tu ritmo: cada sesión suma." : "Registra una sesión cuando completes tu próximo entrenamiento."}</p><p>Tu actividad se guarda localmente en este navegador.</p>`,
      action: "Registrar sesión"
    }
  }[view];

  if (!content) return;
  document.querySelector("#dialog-eyebrow").textContent = content.eyebrow;
  document.querySelector("#dialog-title").textContent = content.title;
  document.querySelector("#dialog-body").innerHTML = content.body;
  document.querySelector("#dialog-actions").innerHTML = `<button data-view-action="${view}">${content.action}</button><button class="secondary" data-dismiss>Cerrar</button>`;
  featureDialog.showModal();
}

function openPremium() {
  trackMarketingEvent("premium_interest");
  document.querySelector("#dialog-eyebrow").textContent = "FITAI PREMIUM · EN PREPARACIÓN";
  document.querySelector("#dialog-title").textContent = "Un plan más completo, cuando esté listo.";
  document.querySelector("#dialog-body").innerHTML = "<p>Premium todavía no está disponible. No hay precio confirmado, funciones de pago activas ni cobros.</p><p>La propuesta contempla estadísticas avanzadas, historial ampliado, planificación y herramientas adicionales de IA. Cada función se anunciará cuando exista y se haya probado.</p><p>Esta versión gratuita mantiene disponibles el escáner configurado, el diario local, la rutina inicial, el mapa y el seguimiento básico. No se bloquea ninguna función actual.</p>";
  document.querySelector("#dialog-actions").innerHTML = "<button data-dismiss>Entendido</button>";
  featureDialog.showModal();
}

function openProfile() {
  document.querySelector("#dialog-eyebrow").textContent = "PERFIL PERSONAL";
  document.querySelector("#dialog-title").textContent = "Tu espacio en FitAI.";
  document.querySelector("#dialog-body").innerHTML = `<p>Tu progreso y preferencias se guardan en este navegador y no se sincronizan con otros dispositivos.</p><p><strong>${sessions.length}</strong> ${sessions.length === 1 ? "sesión registrada" : "sesiones registradas"} hasta ahora. Tu meta elegida es <strong>${userPreferences.weeklyGoal} ${userPreferences.weeklyGoal === 1 ? "sesión" : "sesiones"} por semana</strong>.</p><p>No hay una cuenta FitAI configurada en esta versión.</p>`;
  document.querySelector("#dialog-actions").innerHTML = '<button type="button" data-open-onboarding>Editar mis preferencias</button><button class="secondary" data-dismiss>Cerrar</button>';
  featureDialog.showModal();
}

function renderPersonalRecommendation() {
  const title = document.querySelector("#recommendation-title");
  const copy = document.querySelector("#recommendation-copy");
  const action = document.querySelector("#recommendation-action");
  if (!userPreferences.configured) {
    title.textContent = "Empieza por lo que te importa.";
    copy.textContent = "Configura una intención personal; tus preferencias se guardan solo en este navegador.";
    action.textContent = "Configurar mi espacio →";
    action.dataset.recommendationAction = "onboarding";
    action.setAttribute("data-open-onboarding", "");
    return;
  }

  const firstName = userPreferences.name ? `${userPreferences.name}, ` : "";
  const recommendations = {
    consistencia: {
      title: `${firstName}un paso pequeño también cuenta.`,
      copy: "Elige una acción amable para hoy: registrar una sesión o anotar una comida.",
      action: "Ver mi progreso →",
      destination: "progreso"
    },
    entrenamiento: {
      title: `${firstName}tu meta semanal es ${userPreferences.weeklyGoal} ${userPreferences.weeklyGoal === 1 ? "sesión" : "sesiones"}.`,
      copy: "Puedes revisar la rutina inicial y registrar una sesión cuando termines.",
      action: "Ver entrenamiento →",
      destination: "entrenamiento"
    },
    nutricion: {
      title: `${firstName}conoce mejor una comida de hoy.`,
      copy: "Escanea una foto, revisa la estimación con calma y decide si quieres guardarla en tu diario.",
      action: "Abrir escáner →",
      destination: "nutricion"
    }
  };
  const recommendation = recommendations[userPreferences.focus];
  title.textContent = recommendation.title;
  copy.textContent = recommendation.copy;
  action.textContent = recommendation.action;
  action.dataset.recommendationAction = recommendation.destination;
  action.removeAttribute("data-open-onboarding");
}

function openOnboarding() {
  trackMarketingEvent("onboarding_open");
  document.querySelector("#onboarding-name").value = userPreferences.name;
  document.querySelector("#onboarding-focus").value = userPreferences.focus;
  document.querySelector("#onboarding-goal").value = String(userPreferences.weeklyGoal);
  document.querySelector("#onboarding-dialog").showModal();
}

const marketingEventNames = new Set([
  "landing_view", "cta_click", "onboarding_open", "onboarding_complete",
  "scanner_open", "scan_requested", "meal_saved", "workout_registered",
  "map_open", "premium_interest", "share_progress", "share_fitai",
  "campaign_copy"
]);

function readMarketingEvents() {
  try {
    const events = JSON.parse(localStorage.getItem(ANALYTICS_EVENTS_KEY) || "[]");
    if (!Array.isArray(events)) return [];
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return events.filter((event) => event && marketingEventNames.has(event.name)
      && Number.isFinite(event.at) && event.at >= cutoff).slice(-500);
  } catch {
    return [];
  }
}

function trackMarketingEvent(name) {
  if (!marketingEventNames.has(name)) return;
  try {
    if (localStorage.getItem(ANALYTICS_CONSENT_KEY) !== "accepted") return;
    const events = readMarketingEvents();
    events.push({ name, at: Date.now() });
    localStorage.setItem(ANALYTICS_EVENTS_KEY, JSON.stringify(events.slice(-500)));
  } catch {
    const status = document.querySelector("#analytics-status");
    if (status) status.textContent = "No se pudo guardar la métrica local. Tus funciones principales siguen disponibles.";
  }
}

function setMarketingAnalyticsConsent(accepted) {
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, accepted ? "accepted" : "rejected");
    document.querySelector("#analytics-consent").hidden = true;
    document.querySelector("#analytics-status").textContent = accepted
      ? "Métricas locales activadas. No se envía información a FitAI ni a terceros."
      : "Métricas locales desactivadas.";
    if (accepted) trackMarketingEvent("landing_view");
    renderLocalMarketingMetrics();
    return true;
  } catch {
    document.querySelector("#analytics-status").textContent = "No se pudo guardar tu preferencia. No se registrarán métricas.";
    return false;
  }
}

function renderLocalMarketingMetrics() {
  let consent = "unavailable";
  try {
    consent = localStorage.getItem(ANALYTICS_CONSENT_KEY);
  } catch {
    document.querySelector("#local-metrics").innerHTML = "<p>El almacenamiento local no está disponible; no se recopilan métricas.</p>";
    document.querySelector("#analytics-toggle").disabled = true;
    document.querySelector("#analytics-clear").disabled = true;
    return;
  }
  const events = consent === "accepted" ? readMarketingEvents() : [];
  const counts = events.reduce((total, event) => {
    total[event.name] = (total[event.name] || 0) + 1;
    return total;
  }, {});
  const metrics = [
    ["Visitas a la presentación (en este navegador)", counts.landing_view || 0],
    ["Clics en «Empezar gratis»", counts.cta_click || 0],
    ["Configuraciones locales completadas", counts.onboarding_complete || 0],
    ["Aperturas del escáner", counts.scanner_open || 0],
    ["Análisis solicitados", counts.scan_requested || 0],
    ["Comidas guardadas localmente", counts.meal_saved || 0],
    ["Sesiones de entrenamiento registradas", counts.workout_registered || 0],
    ["Interés en Premium", counts.premium_interest || 0],
    ["Compartidos iniciados", (counts.share_fitai || 0) + (counts.share_progress || 0)]
  ];
  document.querySelector("#local-metrics").innerHTML = consent !== "accepted"
    ? '<p>Las métricas están desactivadas. Puedes activarlas solo para esta instalación.</p>'
    : `${metrics.map(([label, count]) => `<div><span>${label}</span><b>${count}</b></div>`).join("")}<p>Registros reales, usuarios activos entre dispositivos, invitaciones convertidas y pagos no se pueden medir hasta que exista backend de cuentas, analítica autorizada y pagos.</p>`;
  document.querySelector("#analytics-toggle").textContent = consent === "accepted"
    ? "Desactivar métricas locales"
    : "Activar métricas locales";
}

async function shareFitAI(title, text, eventName) {
  const url = window.location.href.split("#")[0];
  if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    document.querySelector("#campaign-copy-status").textContent = "FitAI se está ejecutando en localhost. Publica la aplicación en un dominio antes de compartir un enlace funcional.";
    return;
  }
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
    } else if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(`${text} ${url}`);
      document.querySelector("#campaign-copy-status").textContent = "Enlace de FitAI copiado. Puedes pegarlo donde quieras compartirlo.";
    } else {
      throw new Error("Este navegador no permite compartir ni copiar desde una página no segura.");
    }
    trackMarketingEvent(eventName);
  } catch (error) {
    if (error.name === "AbortError") return;
    document.querySelector("#campaign-copy-status").textContent = error.message || "No se pudo compartir el enlace. Inténtalo de nuevo.";
  }
}

document.querySelector("#onboarding-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const weeklyGoal = Number(form.get("weeklyGoal"));
  const name = String(form.get("name") || "").trim();
  const focus = String(form.get("focus"));
  if (name.length > 40 || !Number.isInteger(weeklyGoal) || weeklyGoal < 2 || weeklyGoal > 7
    || !["consistencia", "entrenamiento", "nutricion"].includes(focus)) {
    document.querySelector("#onboarding-title").textContent = "Revisa tus preferencias";
    return;
  }
  const preferences = { name, focus, weeklyGoal, configured: true };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    document.querySelector("#onboarding-intro").textContent = "No se pudieron guardar tus preferencias en este navegador. Revisa el almacenamiento disponible e inténtalo de nuevo.";
    return;
  }
  userPreferences = preferences;
  document.querySelector("#onboarding-dialog").close();
  renderActivity();
  trackMarketingEvent("onboarding_complete");
  document.querySelector("#mi-siguiente-paso").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector("#analytics-accept").addEventListener("click", () => setMarketingAnalyticsConsent(true));
document.querySelector("#analytics-reject").addEventListener("click", () => setMarketingAnalyticsConsent(false));
document.querySelector("#analytics-settings").addEventListener("click", () => {
  renderLocalMarketingMetrics();
  document.querySelector("#analytics-dialog").showModal();
});
document.querySelector("#analytics-toggle").addEventListener("click", () => {
  const currentlyAccepted = localStorage.getItem(ANALYTICS_CONSENT_KEY) === "accepted";
  if (currentlyAccepted) {
    try {
      localStorage.setItem(ANALYTICS_CONSENT_KEY, "rejected");
      localStorage.removeItem(ANALYTICS_EVENTS_KEY);
      document.querySelector("#analytics-status").textContent = "Métricas desactivadas y registros locales borrados.";
      renderLocalMarketingMetrics();
    } catch {
      document.querySelector("#analytics-status").textContent = "No se pudo actualizar la preferencia de métricas.";
    }
  } else {
    setMarketingAnalyticsConsent(true);
  }
});
document.querySelector("#analytics-clear").addEventListener("click", () => {
  try {
    localStorage.removeItem(ANALYTICS_EVENTS_KEY);
    document.querySelector("#analytics-status").textContent = "Métricas locales borradas.";
    renderLocalMarketingMetrics();
  } catch {
    document.querySelector("#analytics-status").textContent = "No se pudieron borrar las métricas locales.";
  }
});
document.querySelector("#share-progress").addEventListener("click", () => {
  const activeDays = sessions.filter((sessionDate) => sessionDate >= dateKey(weekStart) && sessionDate <= dateKey(today)).length;
  shareFitAI(
    "Mi progreso en FitAI",
    `Esta semana registré ${activeDays} de ${userPreferences.weeklyGoal} días de actividad en FitAI. Cada paso cuenta.`,
    "share_progress"
  );
});

document.querySelectorAll("[data-view]").forEach((element) => {
  element.addEventListener("click", (event) => {
    event.preventDefault();
    const view = element.dataset.view;
    document.querySelectorAll("[data-view]").forEach((link) => link.classList.toggle("is-active", link.dataset.view === view));
    if (view === "inicio") {
      document.querySelector("#inicio").scrollIntoView({ behavior: "smooth" });
      return;
    }
    showFeature(view);
  });
});

document.querySelectorAll("[data-open-premium]").forEach((button) => button.addEventListener("click", openPremium));
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelector("#open-profile").addEventListener("click", openProfile);
document.querySelector("#open-chat").addEventListener("click", () => showFeature("chat"));
document.querySelector("#map-location").addEventListener("click", showCurrentLocation);
document.querySelector("#start-workout").addEventListener("click", () => showFeature("entrenamiento"));
document.querySelector("#open-progress").addEventListener("click", () => showDialog("Registrar actividad", "Al registrar una sesión de entrenamiento, se sumará al resumen de esta semana.", "Registrar sesión", "progreso"));

document.addEventListener("click", (event) => {
  const onboarding = event.target.closest("[data-open-onboarding]");
  if (onboarding) {
    if (featureDialog.open) featureDialog.close();
    if (onboarding.hasAttribute("data-marketing-cta")) trackMarketingEvent("cta_click");
    openOnboarding();
    return;
  }
  const scannerLink = event.target.closest("[data-go-scanner]");
  if (scannerLink) {
    showFeature("nutricion");
    return;
  }
  if (event.target.closest("[data-premium-info]")) {
    openPremium();
    return;
  }
  const recommendation = event.target.closest("[data-recommendation-action]");
  if (recommendation) {
    if (recommendation.dataset.recommendationAction === "onboarding") {
      openOnboarding();
    } else {
      showFeature(recommendation.dataset.recommendationAction);
    }
    return;
  }
  const campaign = event.target.closest("[data-copy-campaign]");
  if (campaign) {
    const status = document.querySelector("#campaign-copy-status");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(campaign.dataset.copyCampaign).then(() => {
        status.textContent = "Guion copiado. Revísalo y adáptalo antes de publicar.";
        trackMarketingEvent("campaign_copy");
      }).catch(() => {
        status.textContent = "No se pudo copiar el guion. Selecciona el texto de la tarjeta para copiarlo manualmente.";
      });
    } else {
      status.textContent = "La copia automática requiere HTTPS. Puedes seleccionar el texto de la tarjeta manualmente.";
    }
    return;
  }
  if (event.target.closest("[data-share-fitai]")) {
    shareFitAI("FitAI", "Descubrí FitAI: herramientas para entender mejor lo que comes y acompañar tu progreso.", "share_fitai");
    return;
  }
  const dismiss = event.target.closest("[data-dismiss]");
  if (dismiss) dismiss.closest("dialog").close();
  const action = event.target.closest("[data-view-action]");
  if (action) {
    featureDialog.close();
    if (action.dataset.viewAction === "entrenamiento" || action.dataset.viewAction === "progreso") recordSession();
    return;
  }
  const dialogView = event.target.closest("[data-dialog-view]");
  if (dialogView) {
    featureDialog.close();
    if (dialogView.dataset.dialogView) showFeature(dialogView.dataset.dialogView);
  }
});

function sendChatMessage(message) {
  const cleanMessage = message.trim();
  if (!cleanMessage) return;
  const bubble = document.createElement("div");
  bubble.className = "user-message";
  bubble.textContent = cleanMessage;
  document.querySelector("#chat-messages").append(bubble);
  document.querySelector("#chat-suggestions").hidden = true;
  bubble.scrollIntoView({ block: "nearest" });
}

document.querySelector("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#chat-input");
  sendChatMessage(input.value);
  input.value = "";
});

document.querySelectorAll("[data-chat-suggestion]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("#chat-input");
    input.value = button.dataset.chatSuggestion;
    document.querySelector("#chat-form").requestSubmit();
  });
});

const motivationalLines = [
  "No hace falta hacerlo perfecto: solo empezar.",
  "Tu ritmo también cuenta. Sigue construyéndolo.",
  "Un movimiento pequeño puede cambiar el día.",
  "La constancia crece cada vez que vuelves.",
  "Hoy también es una buena oportunidad para cuidarte."
];
const dayOfYear = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(today.getFullYear(), 0, 0)) / 86400000);
const hour = today.getHours();
const greeting = hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
document.querySelector("#day-greeting").textContent = greeting.toLocaleUpperCase("es");
document.querySelector("#daily-motivation").textContent = motivationalLines[dayOfYear % motivationalLines.length];

const dateLabel = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(today);
document.querySelector("#today-label").textContent = dateLabel.toLocaleUpperCase("es");
renderActivity();

const FOOD_DIARY_KEY = "fitai-food-diary-v1";
const FOOD_SERVICE = window.FitAIFoodScanner;
let foodEntries = [];
let selectedFoodImage = null;
let currentFoodResult = null;
let baseFoodPortion = 0;
let isFoodAnalysisInProgress = false;
let cameraStream = null;

function setFoodServiceStatus(message, state = "") {
  const status = document.querySelector("#food-service-status");
  status.textContent = message;
  status.classList.toggle("is-error", state === "error");
  status.classList.toggle("is-ready", state === "ready");
}

async function checkFoodService() {
  try {
    const status = await FOOD_SERVICE.getStatus();
    if (status.configured) {
      setFoodServiceStatus("Servicio de análisis conectado. La foto se procesa de forma segura y no se conserva en el servidor.", "ready");
    } else {
      setFoodServiceStatus("La selección de fotos está disponible. Para analizar con IA, configura OPENAI_API_KEY en el servidor y reinícialo.", "error");
    }
  } catch {
    setFoodServiceStatus("No hay conexión con el servidor de análisis. Inicia FitAI con npm start y revisa tu conexión; puedes elegir una foto mientras tanto.", "error");
  }
}

function readFoodDiary() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOOD_DIARY_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Formato de diario no válido.");
    return saved.filter((entry) => entry && typeof entry.id === "string"
      && typeof entry.name === "string" && typeof entry.createdAt === "string"
      && Number.isFinite(entry.grams) && Number.isFinite(entry.calories)
      && Number.isFinite(entry.protein_g) && Number.isFinite(entry.carbs_g)
      && Number.isFinite(entry.fat_g)
      && (entry.fiber_g === null || Number.isFinite(entry.fiber_g)));
  } catch {
    setFoodServiceStatus("No se pudo leer el diario guardado en este navegador. Revisa el almacenamiento local del dispositivo.", "error");
    return [];
  }
}

function formatFoodNumber(value, digits = 0) {
  return new Intl.NumberFormat("es", { maximumFractionDigits: digits }).format(value);
}

function escapeFoodHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function renderFoodDiary() {
  const now = new Date();
  const todayKey = dateKey(now);
  const todayEntries = foodEntries.filter((entry) => dateKey(new Date(entry.createdAt)) === todayKey);
  const totals = todayEntries.reduce((sum, entry) => ({
    calories: sum.calories + entry.calories,
    protein_g: sum.protein_g + entry.protein_g,
    carbs_g: sum.carbs_g + entry.carbs_g,
    fat_g: sum.fat_g + entry.fat_g
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  const fiberEntries = todayEntries.filter((entry) => Number.isFinite(entry.fiber_g));
  const fiberTotal = fiberEntries.reduce((sum, entry) => sum + entry.fiber_g, 0);
  document.querySelector("#food-diary-date").textContent = new Intl.DateTimeFormat("es", {
    weekday: "short", day: "numeric", month: "short"
  }).format(now);
  document.querySelector("#food-daily-summary").innerHTML = `
    <div class="food-calorie-total"><strong>${formatFoodNumber(totals.calories)}</strong><span>kcal registradas</span></div>
    <div class="food-daily-macros">
      <span>Proteínas <b>${formatFoodNumber(totals.protein_g, 1)} g</b></span>
      <span>Carbohidratos <b>${formatFoodNumber(totals.carbs_g, 1)} g</b></span>
      <span>Grasas <b>${formatFoodNumber(totals.fat_g, 1)} g</b></span>
      ${fiberEntries.length ? `<span>Fibra <b>${formatFoodNumber(fiberTotal, 1)} g</b></span>` : ""}
    </div>`;
  const diaryList = document.querySelector("#food-diary-list");
  if (!todayEntries.length) {
    diaryList.innerHTML = '<p class="food-diary-empty">Todavía no has registrado alimentos hoy. Analiza una comida y agrégala a tu diario.</p>';
    return;
  }
  diaryList.innerHTML = todayEntries.slice().reverse().map((entry) => {
    const time = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt));
    return `<div class="food-diary-entry">
      <div><strong>${escapeFoodHtml(entry.name)}</strong><span>${time} · ${formatFoodNumber(entry.grams)} g · ${formatFoodNumber(entry.calories)} kcal</span></div>
      <button type="button" class="food-delete-entry" data-food-delete="${escapeFoodHtml(entry.id)}" aria-label="Eliminar ${escapeFoodHtml(entry.name)} del diario">×</button>
    </div>`;
  }).join("");
}

function stopFoodCamera() {
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  document.querySelector("#food-camera-video").srcObject = null;
  document.querySelector("#food-camera-view").hidden = true;
  document.querySelector("#food-picker").hidden = false;
}

function releaseSelectedFoodImage() {
  if (selectedFoodImage && selectedFoodImage.previewUrl && selectedFoodImage.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(selectedFoodImage.previewUrl);
  }
  selectedFoodImage = null;
}

function showFoodError(title, message) {
  document.querySelector("#food-error-title").textContent = title;
  document.querySelector("#food-error-message").textContent = message;
  document.querySelector("#food-error").hidden = false;
}

async function useFoodFile(file) {
  if (!file) return;
  document.querySelector("#food-error").hidden = true;
  try {
    const prepared = await FOOD_SERVICE.prepareImage(file);
    stopFoodCamera();
    releaseSelectedFoodImage();
    selectedFoodImage = {
      dataUrl: prepared.dataUrl,
      previewUrl: URL.createObjectURL(file),
      name: file.name || "Foto de comida"
    };
    currentFoodResult = null;
    document.querySelector("#food-picker").hidden = true;
    document.querySelector("#food-preview").hidden = false;
    document.querySelector("#food-preview-image").src = selectedFoodImage.previewUrl;
    document.querySelector("#food-preview-name").textContent = selectedFoodImage.name;
    document.querySelector("#food-results").hidden = true;
    document.querySelector("#food-analyze").disabled = false;
    document.querySelector("#food-analyze").textContent = "Analizar alimento con IA →";
  } catch (error) {
    showFoodError("No se pudo preparar la foto", error.message || "Elige otra imagen e inténtalo de nuevo.");
  }
}

async function openFoodCamera() {
  releaseSelectedFoodImage();
  currentFoodResult = null;
  document.querySelector("#food-preview").hidden = true;
  document.querySelector("#food-results").hidden = true;
  document.querySelector("#food-picker").hidden = false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    setFoodServiceStatus("Este navegador no admite la cámara directa. Si está disponible, intenta abrir la captura del dispositivo o elige una foto de la galería.", "error");
    document.querySelector("#food-camera-fallback").click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } }
    });
    const video = document.querySelector("#food-camera-video");
    video.srcObject = cameraStream;
    document.querySelector("#food-picker").hidden = true;
    document.querySelector("#food-preview").hidden = true;
    document.querySelector("#food-camera-view").hidden = false;
    document.querySelector("#food-error").hidden = true;
    await video.play().catch(() => {});
  } catch (error) {
    const message = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
      ? "No se concedió permiso para usar la cámara. Puedes continuar eligiendo una foto de la galería."
      : error.name === "NotFoundError"
        ? "No encontramos una cámara disponible. Puedes elegir una foto de la galería."
        : "No se pudo abrir la cámara. Comprueba los permisos o continúa con una foto de la galería.";
    setFoodServiceStatus(message, "error");
    document.querySelector("#food-picker").hidden = false;
  }
}

async function captureFoodPhoto() {
  const video = document.querySelector("#food-camera-video");
  if (!video.videoWidth || !video.videoHeight) {
    setFoodServiceStatus("La cámara todavía se está preparando. Espera un momento e inténtalo de nuevo.", "error");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    setFoodServiceStatus("No se pudo capturar la imagen en este navegador. Elige una foto de la galería.", "error");
    stopFoodCamera();
    return;
  }
  context.drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) {
    setFoodServiceStatus("No se pudo preparar la fotografía. Elige una foto de la galería.", "error");
    stopFoodCamera();
    return;
  }
  const file = new File([blob], `fitai-${Date.now()}.jpg`, { type: "image/jpeg" });
  await useFoodFile(file);
}

function roundFoodValue(value, digits = 1) {
  const power = 10 ** digits;
  return Math.round((value + Number.EPSILON) * power) / power;
}

function renderFoodResult() {
  if (!currentFoodResult) return;
  const name = document.querySelector("#food-result-name").value.trim();
  const requestedPortion = Number(document.querySelector("#food-result-portion").value);
  const portion = Number.isFinite(requestedPortion) && requestedPortion > 0 ? requestedPortion : baseFoodPortion;
  const multiplier = portion / baseFoodPortion;
  const totals = currentFoodResult.totals;
  const values = [
    { label: "Proteínas", key: "protein_g", unit: "g", color: "protein", digits: 1 },
    { label: "Carbohidratos", key: "carbs_g", unit: "g", color: "carbs", digits: 1 },
    { label: "Grasas", key: "fat_g", unit: "g", color: "fat", digits: 1 }
  ];
  if (totals.fiber_g !== null) values.push({ label: "Fibra", key: "fiber_g", unit: "g", color: "fiber", digits: 1 });
  const scaled = values.map((item) => ({ ...item, value: roundFoodValue(totals[item.key] * multiplier, item.digits) }));
  const maxMacro = Math.max(1, ...scaled.filter((item) => item.key !== "fiber_g").map((item) => item.value));
  const macroCards = [
    `<div class="food-macro-card food-calorie-card"><span>ENERGÍA</span><strong>${formatFoodNumber(roundFoodValue(totals.calories * multiplier, 0))}<small>kcal</small></strong><div class="food-macro-track"><i style="--macro-fill:100%"></i></div></div>`,
    ...scaled.map((item) => `<div class="food-macro-card">
      <span>${item.label.toLocaleUpperCase("es")}</span>
      <strong>${formatFoodNumber(item.value, item.digits)}<small>${item.unit}</small></strong>
      <div class="food-macro-track ${item.color}" role="img" aria-label="${item.label}: ${formatFoodNumber(item.value, item.digits)} ${item.unit}"><i style="--macro-fill:${Math.min(100, Math.max(3, item.value / maxMacro * 100))}%"></i></div>
    </div>`)
  ];
  document.querySelector("#food-macros").innerHTML = macroCards.join("");
  const list = currentFoodResult.foods;
  document.querySelector("#food-components").innerHTML = list.map((food) => {
    const grams = roundFoodValue(food.grams * multiplier, 0);
    return `<li><span>${escapeFoodHtml(food.name)}</span><b>${formatFoodNumber(grams)} g</b></li>`;
  }).join("");
  document.querySelector("#food-components-wrap").hidden = list.length < 2;
  document.querySelector("#food-ingredients").textContent = currentFoodResult.ingredients.length
    ? currentFoodResult.ingredients.join(", ")
    : "No se distinguieron otros ingredientes visibles.";
  document.querySelector("#food-ingredients-wrap").hidden = !currentFoodResult.ingredients.length;
  document.querySelector("#food-result-type").textContent = currentFoodResult.meal_type
    ? `Tipo de comida: ${currentFoodResult.meal_type}`
    : "";
  document.querySelector("#food-portion-feedback").textContent = requestedPortion > 0 && requestedPortion <= 10000
    ? ""
    : "Introduce una porción entre 1 y 10 000 gramos.";
  document.querySelector("#food-result-portion").setAttribute("aria-invalid", String(!(requestedPortion > 0 && requestedPortion <= 10000)));
  document.querySelector("#food-save-meal").disabled = !(name && requestedPortion > 0 && requestedPortion <= 10000);
}

async function analyzeSelectedFood() {
  if (!selectedFoodImage || isFoodAnalysisInProgress) return;
  if (navigator.onLine === false) {
    showFoodError("Sin conexión", "Conéctate a internet y vuelve a intentarlo. Tu foto sigue disponible y no se ha enviado.");
    return;
  }
  isFoodAnalysisInProgress = true;
  trackMarketingEvent("scan_requested");
  document.querySelector("#food-analyze").disabled = true;
  document.querySelector("#food-progress").hidden = false;
  document.querySelector("#food-error").hidden = true;
  document.querySelector("#food-results").hidden = true;
  try {
    const result = await FOOD_SERVICE.analyze(selectedFoodImage.dataUrl);
    if (!result.is_food) {
      showFoodError("No reconocimos un alimento", result.message || "Prueba con una foto más clara y centrada en la comida.");
      return;
    }
    currentFoodResult = result;
    baseFoodPortion = result.foods.reduce((sum, food) => sum + food.grams, 0);
    if (!Number.isFinite(baseFoodPortion) || baseFoodPortion <= 0) throw new Error("No se pudo estimar el tamaño de la porción.");
    document.querySelector("#food-result-name").value = result.foods.map((food) => food.name).join(" y ");
    document.querySelector("#food-result-portion").value = String(Math.max(1, Math.round(baseFoodPortion)));
    document.querySelector("#food-confidence").textContent = `Confianza ${result.confidence}`;
    document.querySelector("#food-result-image").src = selectedFoodImage.previewUrl;
    document.querySelector("#food-results").hidden = false;
    document.querySelector("#food-save-meal").textContent = "Agregar a mi diario nutricional";
    document.querySelector("#food-save-meal").disabled = false;
    renderFoodResult();
  } catch (error) {
    showFoodError(
      error.code === "MODEL_NOT_CONFIGURED" ? "Falta configurar el servicio de IA" : "No pudimos completar el análisis",
      error.message || "Comprueba tu conexión e inténtalo de nuevo."
    );
  } finally {
    isFoodAnalysisInProgress = false;
    document.querySelector("#food-progress").hidden = true;
    document.querySelector("#food-analyze").disabled = false;
  }
}

function saveFoodToDiary() {
  if (!currentFoodResult) return;
  const name = document.querySelector("#food-result-name").value.trim();
  const grams = Number(document.querySelector("#food-result-portion").value);
  if (!name || !Number.isFinite(grams) || grams < 1 || grams > 10000) {
    document.querySelector("#food-portion-feedback").textContent = "Revisa el nombre y la porción antes de guardar.";
    return;
  }
  if (foodEntries.length >= 1000) {
    showFoodError("Diario completo", "Este navegador alcanzó el límite de 1 000 registros locales. Elimina registros antiguos antes de agregar otro.");
    return;
  }
  const multiplier = grams / baseFoodPortion;
  const values = currentFoodResult.totals;
  const entry = {
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    name,
    grams,
    calories: roundFoodValue(values.calories * multiplier, 0),
    protein_g: roundFoodValue(values.protein_g * multiplier),
    carbs_g: roundFoodValue(values.carbs_g * multiplier),
    fat_g: roundFoodValue(values.fat_g * multiplier),
    fiber_g: values.fiber_g === null ? null : roundFoodValue(values.fiber_g * multiplier)
  };
  const nextEntries = [...foodEntries, entry];
  try {
    localStorage.setItem(FOOD_DIARY_KEY, JSON.stringify(nextEntries));
    foodEntries = nextEntries;
    trackMarketingEvent("meal_saved");
    renderFoodDiary();
    document.querySelector("#food-save-meal").textContent = "Agregado a tu diario";
    document.querySelector("#food-save-meal").disabled = true;
  } catch {
    showFoodError("No se pudo guardar", "El almacenamiento local no está disponible o está lleno. Libera espacio en el navegador e inténtalo de nuevo.");
  }
}

document.querySelector("#food-open-camera").addEventListener("click", openFoodCamera);
document.querySelector("#food-open-gallery").addEventListener("click", () => document.querySelector("#food-gallery-input").click());
document.querySelector("#food-camera-fallback").addEventListener("click", () => setFoodServiceStatus("Si no se abre la cámara del dispositivo, elige una foto con «Subir una foto».", "error"));
document.querySelector("#food-gallery-input").addEventListener("change", (event) => {
  useFoodFile(event.target.files && event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#food-camera-fallback").addEventListener("change", (event) => {
  useFoodFile(event.target.files && event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#food-camera-cancel").addEventListener("click", stopFoodCamera);
document.querySelector("#food-camera-capture").addEventListener("click", captureFoodPhoto);
document.querySelector("#food-change-image").addEventListener("click", () => {
  releaseSelectedFoodImage();
  document.querySelector("#food-preview").hidden = true;
  document.querySelector("#food-results").hidden = true;
  currentFoodResult = null;
  document.querySelector("#food-picker").hidden = false;
});
document.querySelector("#food-analyze").addEventListener("click", analyzeSelectedFood);
document.querySelector("#food-retry").addEventListener("click", analyzeSelectedFood);
document.querySelector("#food-result-name").addEventListener("input", renderFoodResult);
document.querySelector("#food-result-portion").addEventListener("input", renderFoodResult);
document.querySelector("#food-save-meal").addEventListener("click", saveFoodToDiary);
document.querySelector("#food-scan-another").addEventListener("click", () => {
  releaseSelectedFoodImage();
  currentFoodResult = null;
  document.querySelector("#food-results").hidden = true;
  document.querySelector("#food-preview").hidden = true;
  document.querySelector("#food-picker").hidden = false;
  document.querySelector("#food-error").hidden = true;
  document.querySelector("#food-gallery-input").value = "";
  document.querySelector("#food-save-meal").disabled = false;
});
document.querySelector("#food-diary-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-food-delete]");
  if (!button) return;
  const nextEntries = foodEntries.filter((entry) => entry.id !== button.dataset.foodDelete);
  try {
    localStorage.setItem(FOOD_DIARY_KEY, JSON.stringify(nextEntries));
    foodEntries = nextEntries;
    renderFoodDiary();
  } catch {
    setFoodServiceStatus("No se pudo actualizar el diario local. Revisa el almacenamiento del navegador.", "error");
  }
});
window.addEventListener("online", checkFoodService);
window.addEventListener("beforeunload", () => {
  stopFoodCamera();
  releaseSelectedFoodImage();
});

foodEntries = readFoodDiary();
renderFoodDiary();
checkFoodService();

document.querySelector("#footer-year").textContent = String(new Date().getFullYear());
try {
  const consent = localStorage.getItem(ANALYTICS_CONSENT_KEY);
  document.querySelector("#analytics-consent").hidden = consent === "accepted" || consent === "rejected";
  renderLocalMarketingMetrics();
  if (consent === "accepted") trackMarketingEvent("landing_view");
} catch {
  document.querySelector("#analytics-consent").hidden = true;
  document.querySelector("#analytics-status").textContent = "El almacenamiento local no está disponible. No se registran métricas.";
}