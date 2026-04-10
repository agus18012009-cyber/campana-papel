'use strict';
// ============================================================
// app.js — Campaña Papel Verde · Control de Asistencia
// Requiere: supabase-config.js (cargado antes en index.html)
// ============================================================

// ── Estado global ─────────────────────────────────────────────
let profile         = null;   // { id, name, course, role }
let realtimeChannel = null;   // Canal Supabase Realtime
let selectedCourse  = null;   // Curso tapeado, pendiente confirmar
let pendingDeleteId = null;   // ID de visita a eliminar

// ── Utilidades ────────────────────────────────────────────────
function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(+y, +m - 1, 1)
    .toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('es-AR',
    { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('es-AR',
    { hour: '2-digit', minute: '2-digit' });
}

function getGrade(course) {
  const n = course.charAt(0);
  return n === '1' ? '1er Año'
       : n === '2' ? '2do Año'
       : n === '3' ? '3er Año'
       : n === '4' ? '4to Año'
       : '';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Loading ───────────────────────────────────────────────────
function showLoading(v) {
  document.getElementById('loading').style.display = v ? 'flex' : 'none';
}

// ── Toast ─────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ── Error auth en español ─────────────────────────────────────
function authErr(codeOrMsg) {
  const map = {
    'invalid_credentials':   'Email o contraseña incorrectos.',
    'email_not_confirmed':   'Confirmá tu email antes de ingresar.',
    'user_already_exists':   'Ya existe una cuenta con ese email.',
    'weak_password':         'La contraseña debe tener al menos 6 caracteres.',
    'email_address_invalid': 'El email ingresado no es válido.',
    'over_email_send_rate_limit': 'Límite de registros alcanzado. En Supabase → Authentication → Email desactivá "Confirm email", o esperá unos minutos.',
  };
  return map[codeOrMsg] || 'Error: ' + codeOrMsg;
}

// ── Gestión de pantallas ──────────────────────────────────────
function showAuth() {
  document.getElementById('screen-auth').style.display = 'flex';
  document.getElementById('screen-app').style.display  = 'none';
}

function showApp() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('screen-app').style.display  = 'flex';

  // Header
  document.getElementById('hdr-name').textContent   = profile.name;
  document.getElementById('hdr-course').textContent = profile.course;
  document.getElementById('hdr-admin').style.display =
    profile.role === 'admin' ? 'inline-block' : 'none';

  if (profile.role === 'admin') {
    document.getElementById('view-student').style.display = 'none';
    document.getElementById('view-admin').style.display   = 'flex';
    initAdminView();
  } else {
    document.getElementById('view-admin').style.display   = 'none';
    document.getElementById('view-student').style.display = 'flex';
    initStudentView();
  }
}

// ── Limpieza al cerrar sesión ─────────────────────────────────
function teardown() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  profile         = null;
  selectedCourse  = null;
  pendingDeleteId = null;
}

// ── Observador de sesión ──────────────────────────────────────
sb.auth.onAuthStateChange(async (event, session) => {
  showLoading(true);

  if (session && session.user) {
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();

    if (error || !data) {
      // Perfil no encontrado (caso raro) → cerrar sesión
      await sb.auth.signOut();
      showAuth();
      showLoading(false);
      return;
    }

    profile = data;
    showApp();
    subscribeRealtime();
  } else {
    teardown();
    showAuth();
  }

  showLoading(false);
});

// ── Toggles Login ↔ Registro ──────────────────────────────────
document.getElementById('go-register').addEventListener('click', () => {
  document.getElementById('panel-login').style.display    = 'none';
  document.getElementById('panel-register').style.display = 'block';
  document.getElementById('err-login').style.display      = 'none';
});
document.getElementById('go-login').addEventListener('click', () => {
  document.getElementById('panel-register').style.display = 'none';
  document.getElementById('panel-login').style.display    = 'block';
  document.getElementById('err-register').style.display   = 'none';
});

// ── Registro ──────────────────────────────────────────────────
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('err-register');
  errEl.style.display = 'none';

  const name   = document.getElementById('reg-name').value.trim();
  const course = document.getElementById('reg-course').value;
  const email  = document.getElementById('reg-email').value.trim();
  const pass   = document.getElementById('reg-password').value;
  const code   = document.getElementById('reg-code').value.trim();

  if (!name || !course || !email || !pass) {
    errEl.textContent   = 'Completá todos los campos obligatorios.';
    errEl.style.display = 'block';
    return;
  }
  if (pass.length < 6) {
    errEl.textContent   = 'La contraseña debe tener al menos 6 caracteres.';
    errEl.style.display = 'block';
    return;
  }

  const role = (code === ADMIN_CODE) ? 'admin' : 'student';

  showLoading(true);

  // 1. Crear usuario en Auth
  const { data: authData, error: authError } = await sb.auth.signUp({
    email,
    password: pass,
    options: { emailRedirectTo: window.location.href }
  });

  if (authError) {
    showLoading(false);
    errEl.textContent   = authErr(authError.code || authError.message);
    errEl.style.display = 'block';
    return;
  }

  // 2. Insertar perfil en la tabla profiles
  if (authData.user) {
    const { error: profileError } = await sb
      .from('profiles')
      .insert({ id: authData.user.id, name, course, role });

    if (profileError) {
      showLoading(false);
      errEl.textContent   = 'Error al guardar el perfil. Intentá de nuevo.';
      errEl.style.display = 'block';
      return;
    }
  }

  showLoading(false);
  // onAuthStateChange se encarga del resto si la sesión se establece.
  // Si Supabase requiere confirmación de email, mostrar aviso:
  if (!authData.session) {
    errEl.style.background = '#e8f5e9';
    errEl.style.color      = '#1b5e20';
    errEl.style.borderColor = '#a5d6a7';
    errEl.textContent      = '¡Cuenta creada! Revisá tu email para confirmar (si el link no llega, revisá spam). Si ya podés entrar, usá "Iniciar sesión".';
    errEl.style.display    = 'block';
  }
});

// ── Login ─────────────────────────────────────────────────────
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('err-login');
  errEl.style.display = 'none';

  const email = document.getElementById('log-email').value.trim();
  const pass  = document.getElementById('log-password').value;

  if (!email || !pass) {
    errEl.textContent   = 'Completá email y contraseña.';
    errEl.style.display = 'block';
    return;
  }

  showLoading(true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });

  if (error) {
    showLoading(false);
    errEl.textContent   = authErr(error.code || error.message);
    errEl.style.display = 'block';
  }
  // Éxito → onAuthStateChange lo maneja
});

// ── Logout ────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('¿Cerrar sesión?')) return;
  showLoading(true);
  teardown();
  await sb.auth.signOut();
});

// ── Realtime: escuchar cambios en visits ──────────────────────
function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);

  realtimeChannel = sb
    .channel('visits-watch')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'visits' },
      () => {
        if (!profile) return;
        if (profile.role === 'admin') loadAdminData();
        else loadStudentData();
      }
    )
    .subscribe();
}

// ============================================================
// VISTA ALUMNO
// ============================================================
async function initStudentView() {
  const monthKey = getMonthKey();
  document.getElementById('student-month-title').textContent =
    'Mes: ' + formatMonthLabel(monthKey);
  await loadStudentData();
}

async function loadStudentData() {
  const monthKey = getMonthKey();

  // Solo visitas del mismo curso (5°1°/5°2°/5°3°) y del mes actual
  const { data, error } = await sb
    .from('visits')
    .select('*')
    .eq('student_course', profile.course)
    .eq('month', monthKey)
    .order('created_at', { ascending: true });

  if (error) { console.error('loadStudentData:', error); return; }

  renderStudentGrid(data || []);
}

function renderStudentGrid(visits) {
  // Agrupar por curso destino
  const byTarget = {};
  visits.forEach(v => {
    if (!byTarget[v.target_course]) byTarget[v.target_course] = [];
    byTarget[v.target_course].push(v);
  });

  // Cursos visitados por mí este mes
  const myVisited = new Set(
    visits.filter(v => v.student_id === profile.id).map(v => v.target_course)
  );

  const visitedCount = Object.keys(byTarget).length;
  const total        = TARGET_COURSES.length;

  // Barra de progreso
  document.getElementById('prog-label').textContent  = `${visitedCount} visitados`;
  document.getElementById('prog-total').textContent  = `de ${total} cursos`;
  document.getElementById('progress-fill').style.width =
    `${Math.round((visitedCount / total) * 100)}%`;

  const grid = document.getElementById('student-grid');
  grid.innerHTML = '';

  TARGET_COURSES.forEach(course => {
    const courseVisits   = byTarget[course] || [];
    const visitedByOther = courseVisits.length > 0;
    const visitedByMe    = myVisited.has(course);

    const card = document.createElement('div');

    let cardClass, dotClass, statusText, statusClass, visitorHtml = '';

    if (visitedByMe) {
      cardClass   = 'course-card visited-mine';
      dotClass    = 'dot-dark';
      statusText  = 'Visitado por vos';
      statusClass = 'status-mine';
      const myVisit = courseVisits.find(v => v.student_id === profile.id);
      if (myVisit) {
        visitorHtml = `<div class="card-visitor">${esc(formatDate(myVisit.created_at))}</div>`;
      }
    } else if (visitedByOther) {
      cardClass   = 'course-card visited-other';
      dotClass    = 'dot-light';
      statusText  = 'Visitado por compañero';
      statusClass = 'status-other';
      const last  = courseVisits[courseVisits.length - 1];
      visitorHtml = `<div class="card-visitor">por ${esc(last.student_name)}</div>`;
    } else {
      cardClass   = 'course-card available';
      dotClass    = 'dot-gray';
      statusText  = 'Disponible — tocá para marcar';
      statusClass = 'status-available';
    }

    card.className = cardClass;
    card.innerHTML = `
      <div class="card-dot ${dotClass}"></div>
      <div class="card-grade">${esc(getGrade(course))}</div>
      <div class="card-name">${esc(course)}</div>
      <div class="card-status ${statusClass}">${statusText}</div>
      ${visitorHtml}
    `;

    // Solo cursos que el alumno no ha visitado aún son clickeables
    if (!visitedByMe) {
      card.addEventListener('click', () => openVisitModal(course));
    }

    grid.appendChild(card);
  });
}

// ── Modal confirmar visita ────────────────────────────────────
function openVisitModal(course) {
  selectedCourse = course;
  document.getElementById('modal-course-name').textContent = course;
  document.getElementById('modal-date-text').textContent   =
    new Date().toLocaleDateString('es-AR',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('modal-visit').style.display = 'flex';
}

function closeVisitModal() {
  selectedCourse = null;
  document.getElementById('modal-visit').style.display = 'none';
}

document.getElementById('modal-cancel').addEventListener('click', closeVisitModal);
document.getElementById('modal-visit').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeVisitModal();
});

document.getElementById('modal-confirm').addEventListener('click', async () => {
  if (!selectedCourse) return;
  const course = selectedCourse;
  closeVisitModal();
  showLoading(true);

  const monthKey = getMonthKey();

  // Verificar si ya existe la visita (double-check del lado del cliente)
  const { data: existing } = await sb
    .from('visits')
    .select('id')
    .eq('student_id',    profile.id)
    .eq('target_course', course)
    .eq('month',         monthKey)
    .maybeSingle();

  if (existing) {
    toast('Ya registraste una visita a este curso este mes.', 'error');
    showLoading(false);
    return;
  }

  const { error } = await sb.from('visits').insert({
    student_id:     profile.id,
    student_name:   profile.name,
    student_course: profile.course,
    target_course:  course,
    month:          monthKey
  });

  showLoading(false);

  if (error) {
    toast('Error al guardar. Intentá de nuevo.', 'error');
    console.error('insertVisit:', error);
  } else {
    toast(`¡Visita a ${course} registrada!`, 'success');
    // El listener de realtime actualizará automáticamente.
    // También recargamos manualmente por si hay demora:
    await loadStudentData();
  }
});

// ============================================================
// VISTA ADMINISTRADOR
// ============================================================
async function initAdminView() {
  populateMonthFilter();

  document.getElementById('admin-filter-month')
    .addEventListener('change', loadAdminData);
  document.getElementById('admin-filter-course')
    .addEventListener('change', loadAdminData);

  await loadAdminData();
}

function populateMonthFilter() {
  const sel = document.getElementById('admin-filter-month');
  sel.innerHTML = '';
  const now = new Date();

  for (let i = 0; i < 6; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const opt = document.createElement('option');
    opt.value     = key;
    opt.textContent = formatMonthLabel(key);
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadAdminData() {
  const monthKey     = document.getElementById('admin-filter-month').value;
  const courseFilter = document.getElementById('admin-filter-course').value;

  let query = sb
    .from('visits')
    .select('*')
    .eq('month', monthKey)
    .order('created_at', { ascending: false });

  if (courseFilter) {
    query = query.eq('student_course', courseFilter);
  }

  const { data, error } = await query;

  if (error) { console.error('loadAdminData:', error); return; }

  renderAdminView(data || []);
}

function renderAdminView(visits) {
  // Estadísticas
  const uniqueCourses  = new Set(visits.map(v => v.target_course)).size;
  const uniqueStudents = new Set(visits.map(v => v.student_id)).size;

  document.getElementById('stat-total').textContent    = visits.length;
  document.getElementById('stat-courses').textContent  = uniqueCourses;
  document.getElementById('stat-students').textContent = uniqueStudents;

  // Agrupar por curso destino para el grid
  const byTarget = {};
  visits.forEach(v => {
    if (!byTarget[v.target_course]) byTarget[v.target_course] = [];
    byTarget[v.target_course].push(v);
  });

  // ── Grid de cursos (admin) ──────────────────────────────
  const grid = document.getElementById('admin-grid');
  grid.innerHTML = '';

  TARGET_COURSES.forEach(course => {
    const cv      = byTarget[course] || [];
    const visited = cv.length > 0;

    const card = document.createElement('div');
    card.className = `course-card ${visited ? 'visited-other' : ''}`;

    let visitorsHtml = '';
    if (visited) {
      visitorsHtml = cv.slice(0, 2)
        .map(v => `<div class="card-visitor">${esc(v.student_name)} · ${esc(formatDate(v.created_at))}</div>`)
        .join('');
      if (cv.length > 2) {
        visitorsHtml += `<div class="card-visitor">+${cv.length - 2} más</div>`;
      }
    }

    card.innerHTML = `
      <div class="card-dot ${visited ? 'dot-light' : 'dot-gray'}"></div>
      <div class="card-grade">${esc(getGrade(course))}</div>
      <div class="card-name">${esc(course)}</div>
      <div class="card-count">${
        visited
          ? `${cv.length} visita${cv.length > 1 ? 's' : ''}`
          : 'Sin visitar'
      }</div>
      ${visitorsHtml}
    `;

    grid.appendChild(card);
  });

  // ── Tabla completa ──────────────────────────────────────
  const tbody = document.getElementById('admin-tbody');

  if (visits.length === 0) {
    tbody.innerHTML =
      '<tr class="empty-row"><td colspan="6">No hay registros para este período.</td></tr>';
    return;
  }

  tbody.innerHTML = visits.map(v => `
    <tr>
      <td class="td-course">${esc(v.target_course)}</td>
      <td>${esc(v.student_name)}</td>
      <td class="col-student-course">
        <span class="td-badge">${esc(v.student_course)}</span>
      </td>
      <td>${esc(formatDate(v.created_at))}</td>
      <td class="td-time">${esc(formatTime(v.created_at))}</td>
      <td>
        <button class="btn-delete" data-id="${esc(v.id)}">Eliminar</button>
      </td>
    </tr>
  `).join('');

  // Enlazar botones de eliminar
  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
  });
}

// ── Modal confirmar eliminación ───────────────────────────────
function openDeleteModal(id) {
  pendingDeleteId = id;
  document.getElementById('modal-delete').style.display = 'flex';
}

function closeDeleteModal() {
  pendingDeleteId = null;
  document.getElementById('modal-delete').style.display = 'none';
}

document.getElementById('delete-cancel').addEventListener('click', closeDeleteModal);
document.getElementById('modal-delete').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeleteModal();
});

document.getElementById('delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  closeDeleteModal();
  showLoading(true);

  const { error } = await sb.from('visits').delete().eq('id', id);

  showLoading(false);

  if (error) {
    toast('Error al eliminar. Verificá tu conexión.', 'error');
    console.error('deleteVisit:', error);
  } else {
    toast('Registro eliminado.', 'success');
    await loadAdminData();
  }
});

