/* ============================================================
   MedSync — app.js
   Vanilla JS SPA with Supabase GoTrue Auth + Role-Based Routing.
   Talks to /api/*.php endpoints for data and Supabase Auth REST
   for authentication.
   ============================================================ */

/* ---- API Endpoints (PHP backend) ---- */
const API = {
  requests: '/medsync/api/requests.php',
  pharmacies: '/medsync/api/pharmacies.php',
  chat: '/medsync/api/chat.php',
  auth: '/medsync/api/auth.php',
};

const STATUS_ORDER = ['Pending', 'Matched', 'Locked', 'Picked Up'];

/* ---- App State ---- */
const state = {
  currentView: 'patient',               // 'patient' | 'pharmacy' | 'admin'
  user: null,                            // { id, email, role, full_name, ... }
  userProfile: null,                     // profile fetched from backend
  accessToken: null,
  patientName: '',
  requests: [],
  pharmacyFeed: [],
  pharmacies: [],
  pollTimer: null,
  pendingPayment: null,
  chatHistory: [],
};

/* ============================================================
   Utilities
   ============================================================ */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function timeAgo(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusBadgeClass(status) {
  return {
    'Pending': 'badge-pending',
    'Matched': 'badge-matched',
    'Locked': 'badge-locked',
    'Picked Up': 'badge-pickedup',
  }[status] || 'badge-pending';
}

function showToast(message, type = 'success') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18">
      ${type === 'error'
        ? '<path fill="currentColor" d="M12 2 1 21h22Zm0 6 1.5 1.5L12 11l-1.5-1.5Zm0 9.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"/>'
        : '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.6-4.4-4.4 1.4-1.4 3 3 6-6 1.4 1.4Z"/>'}
    </svg>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3800);
}

async function apiCall(url, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const message = (data && data.error) ? data.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

/* ---- Proximity / Geolocation Helpers ---- */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null || 
      lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) {
    return null;
  }
  const R = 6371; // Radius of the Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distance in km
}

function formatDistance(d) {
  if (d === null || d === undefined || isNaN(d)) return '';
  if (d < 1) {
    return `${Math.round(d * 1000)}m away`;
  }
  return `${d.toFixed(1)} km away`;
}

/* ============================================================

/* ============================================================
   Supabase GoTrue Auth — Direct REST API
   ============================================================ */
function getSupabaseAuthUrl(path) {
  return `${SUPABASE_URL}/auth/v1${path}`;
}

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
  };
}

/**
 * Sign up a new user via Supabase /auth/v1/signup.
 * Passes full_name and role as user_metadata so the database trigger
 * can read them when creating the profiles row.
 */
async function supabaseSignUp(email, password, fullName, role) {
  const res = await fetch(getSupabaseAuthUrl('/signup'), {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      email,
      password,
      data: { full_name: fullName, role },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || data.message || 'Signup failed.');
  }
  return data;
}

/**
 * Sign in via Supabase /auth/v1/token?grant_type=password.
 * Returns access_token, refresh_token, and user object with metadata.
 */
async function supabaseSignIn(email, password) {
  const res = await fetch(getSupabaseAuthUrl('/token?grant_type=password'), {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || data.message || 'Login failed.');
  }
  return data;
}

/**
 * Decode a JWT token payload (base64url → JSON).
 */
function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Check if the current session is valid (token not expired).
 */
function isSessionValid() {
  const token = localStorage.getItem('medsync_access_token');
  if (!token) return false;
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return false;
  return (payload.exp * 1000) > Date.now();
}

/**
 * Save session to localStorage after successful login.
 */
function saveSession(data) {
  localStorage.setItem('medsync_access_token', data.access_token);
  localStorage.setItem('medsync_refresh_token', data.refresh_token || '');
  localStorage.setItem('medsync_user', JSON.stringify(data.user));
}

/**
 * Load session from localStorage. Returns user object or null.
 */
function loadSession() {
  if (!isSessionValid()) {
    clearSession();
    return null;
  }
  const token = localStorage.getItem('medsync_access_token');
  const userStr = localStorage.getItem('medsync_user');
  if (!token || !userStr) return null;

  state.accessToken = token;
  try {
    state.user = JSON.parse(userStr);
  } catch {
    clearSession();
    return null;
  }
  return state.user;
}

/**
 * Clear session and reset state.
 */
function clearSession() {
  localStorage.removeItem('medsync_access_token');
  localStorage.removeItem('medsync_refresh_token');
  localStorage.removeItem('medsync_user');
  localStorage.removeItem('medsync_user_lat');
  localStorage.removeItem('medsync_user_lng');
  state.user = null;
  state.userProfile = null;
  state.accessToken = null;
}

/**
 * Extract the user role from the session.
 */
function getUserRole() {
  if (!state.user) return 'patient';
  // Role is stored in user_metadata during signup
  const meta = state.user.user_metadata || {};
  return meta.role || 'patient';
}

/**
 * Get the user's display name.
 */
function getUserName() {
  if (!state.user) return 'User';
  const meta = state.user.user_metadata || {};
  return meta.full_name || state.user.email || 'User';
}

/* ============================================================
   Auth UI — Login / Signup screens
   ============================================================ */
function initAuth() {
  const loginTab = $('#auth-tab-login');
  const signupTab = $('#auth-tab-signup');
  const loginForm = $('#login-form');
  const signupForm = $('#signup-form');
  const authToggle = loginTab.parentElement;

  // Toggle between login/signup
  loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginTab.setAttribute('aria-selected', 'true');
    signupTab.setAttribute('aria-selected', 'false');
    authToggle.removeAttribute('data-active');
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
    hideAuthErrors();
  });

  signupTab.addEventListener('click', () => {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    signupTab.setAttribute('aria-selected', 'true');
    loginTab.setAttribute('aria-selected', 'false');
    authToggle.dataset.active = 'signup';
    signupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    hideAuthErrors();
  });

  // Login form submit
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) return;

    setAuthLoading('login', true);
    hideAuthErrors();

    try {
      const data = await supabaseSignIn(email, password);
      saveSession(data);
      state.user = data.user;
      state.accessToken = data.access_token;
      showToast('Welcome back! Logging you in…');
      enterApp();
    } catch (err) {
      showAuthError('login', err.message);
    } finally {
      setAuthLoading('login', false);
    }
  });

  // Signup form submit
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = $('#signup-name').value.trim();
    const email = $('#signup-email').value.trim();
    const password = $('#signup-password').value;
    const role = $('#signup-role').value;
    if (!fullName || !email || !password) return;

    setAuthLoading('signup', true);
    hideAuthErrors();

    try {
      const data = await supabaseSignUp(email, password, fullName, role);

      // Supabase returns a user object. If email confirmation is enabled,
      // the user will need to verify their email before logging in.
      if (data.id || (data.user && data.user.id)) {
        // If we got tokens back, user is auto-confirmed (Supabase setting)
        if (data.access_token) {
          saveSession(data);
          state.user = data.user;
          state.accessToken = data.access_token;
          showToast('Account created! Welcome to MedSync.');
          enterApp();
        } else {
          showToast('Account created! Check your email to verify, then log in.');
          // Switch to login tab
          loginTab.click();
        }
      }
    } catch (err) {
      showAuthError('signup', err.message);
    } finally {
      setAuthLoading('signup', false);
    }
  });

  // Logout
  $('#logout-btn').addEventListener('click', () => {
    clearSession();
    exitApp();
    showToast('Logged out successfully.');
  });
}

function setAuthLoading(form, loading) {
  const btn = $(`#${form}-submit-btn`);
  const text = $(`#${form}-btn-text`);
  const spinner = $(`#${form}-btn-spinner`);
  btn.disabled = loading;
  text.textContent = loading ? (form === 'login' ? 'Logging in…' : 'Creating account…') : (form === 'login' ? 'Log In' : 'Create Account');
  spinner.classList.toggle('hidden', !loading);
}

function showAuthError(form, message) {
  const el = $(`#${form}-error`);
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAuthErrors() {
  $('#login-error').classList.add('hidden');
  $('#signup-error').classList.add('hidden');
}

/**
 * Transition from auth screen to the main app.
 * Fetches the user profile from the backend to get the authoritative role.
 */
async function enterApp() {
  let role = getUserRole();   // fallback from JWT metadata
  const name = getUserName();

  // Fetch the authoritative role from the profiles table
  if (state.user && state.user.id) {
    try {
      const profile = await apiCall(`${API.auth}?action=profile&user_id=${state.user.id}`);
      if (profile && profile.role) {
        state.userProfile = profile;
        role = profile.role;
        // Update user metadata in state & localStorage so subsequent reads are correct
        if (!state.user.user_metadata) state.user.user_metadata = {};
        state.user.user_metadata.role = role;
        if (profile.full_name) state.user.user_metadata.full_name = profile.full_name;
        if (profile.pharmacy_id) state.user.user_metadata.pharmacy_id = profile.pharmacy_id;
        localStorage.setItem('medsync_user', JSON.stringify(state.user));
      }
    } catch (err) {
      console.warn('Could not fetch profile, using JWT metadata role:', err.message);
    }
  }

  // Ensure state.userProfile is set (fallback)
  if (!state.userProfile && state.user) {
    state.userProfile = {
      role: role,
      full_name: name,
      pharmacy_id: (state.user.user_metadata && state.user.user_metadata.pharmacy_id) || state.user.pharmacy_id
    };
  }

  // Update topbar user info
  const displayName = (state.user && state.user.user_metadata && state.user.user_metadata.full_name) || name;
  $('#user-name').textContent = displayName;
  $('#user-avatar').textContent = displayName.charAt(0).toUpperCase();

  // Set patient name for the request form
  state.patientName = displayName;
  const nameInput = $('#patient_name');
  if (nameInput) nameInput.value = displayName;

  // Configure view toggle visibility based on role
  configureViewToggle(role);

  // Hide auth, show app
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');

  // Navigate to the default dashboard for this role
  const user = {
    role: role,
    pharmacy_id: state.userProfile ? state.userProfile.pharmacy_id : null
  };

  if (user.role === 'admin') {
    switchView('admin');
    renderAdminDashboard();
  } else if (user.role === 'pharmacy_staff') {
    switchView('pharmacy');
    renderPharmacyDashboard(user.pharmacy_id);
    const selectContainer = $('#pharmacy-select-container');
    if (selectContainer) selectContainer.classList.add('hidden');
  } else if (user.role === 'patient') {
    switchView('patient');
    renderPatientDashboard();
  }

  // Load data
  loadPharmacies();
  startPolling();

  // Trigger geolocation for patient role to enable proximity calculations
  if (role === 'patient') {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          localStorage.setItem('medsync_user_lat', position.coords.latitude);
          localStorage.setItem('medsync_user_lng', position.coords.longitude);
          console.log('User coordinates acquired:', position.coords.latitude, position.coords.longitude);
        },
        (error) => {
          console.warn('Geolocation access denied or failed:', error.message);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    } else {
      console.warn('Geolocation not supported by this browser.');
    }
  }
}

/**
 * Transition from app back to auth screen.
 */
function exitApp() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  $('#app-shell').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');

  // Reset forms
  $('#login-form').reset();
  $('#signup-form').reset();
  hideAuthErrors();
}

/**
 * Configure which toggle tabs are visible based on user role.
 */
function configureViewToggle(role) {
  const patientTab = $('#toggle-patient');
  const pharmacyTab = $('#toggle-pharmacy');
  const adminTab = $('#toggle-admin');
  const selectContainer = $('#pharmacy-select-container');
  const statusContainer = $('.pharmacy-status-toggle');

  // Show/hide tabs based on role
  if (role === 'patient') {
    patientTab.classList.remove('hidden-tab');
    pharmacyTab.classList.add('hidden-tab');
    adminTab.classList.add('hidden-tab');
  } else if (role === 'pharmacy_staff') {
    patientTab.classList.add('hidden-tab');
    pharmacyTab.classList.remove('hidden-tab');
    adminTab.classList.add('hidden-tab');
  } else if (role === 'admin') {
    patientTab.classList.remove('hidden-tab');
    pharmacyTab.classList.remove('hidden-tab');
    adminTab.classList.remove('hidden-tab');
  }

  // Show/hide acting selector and status toggle
  if (selectContainer) {
    if (role === 'pharmacy_staff') {
      selectContainer.classList.add('hidden');
    } else {
      selectContainer.classList.remove('hidden');
    }
  }
  if (statusContainer) {
    if (role === 'pharmacy_staff') {
      statusContainer.classList.remove('hidden');
    } else {
      // Hide status toggle for patients, keep for staff
      statusContainer.classList.add('hidden');
    }
  }
}

/* ============================================================
   View toggle (Patient <-> Pharmacy <-> Admin)
   ============================================================ */
function initViewToggle() {
  $('#toggle-patient').addEventListener('click', () => switchView('patient'));
  $('#toggle-pharmacy').addEventListener('click', () => switchView('pharmacy'));
  $('#toggle-admin').addEventListener('click', () => switchView('admin'));
}

function switchView(view) {
  state.currentView = view;

  // Update toggle buttons
  const buttons = { patient: '#toggle-patient', pharmacy: '#toggle-pharmacy', admin: '#toggle-admin' };
  Object.entries(buttons).forEach(([key, sel]) => {
    const btn = $(sel);
    btn.classList.toggle('active', key === view);
    btn.setAttribute('aria-selected', key === view);
  });

  // Update views
  const views = { patient: '#patient-dash', pharmacy: '#pharmacy-dash', admin: '#admin-dash' };
  Object.entries(views).forEach(([key, sel]) => {
    $(sel).classList.toggle('active', key === view);
  });

  // Position the glider
  positionGlider(view);

  refreshData();
}

function positionGlider(view) {
  const glider = $('#toggle-glider');
  const toggleBar = $('#view-toggle-bar');
  const buttons = { patient: '#toggle-patient', pharmacy: '#toggle-pharmacy', admin: '#toggle-admin' };
  const activeBtn = $(buttons[view]);

  if (!activeBtn || activeBtn.classList.contains('hidden-tab')) return;

  // Calculate position relative to toggle bar
  const barRect = toggleBar.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();

  glider.style.width = `${btnRect.width}px`;
  glider.style.transform = `translateX(${btnRect.left - barRect.left - 4}px)`;
}

/* ============================================================
   Data loading + polling
   ============================================================ */
async function loadPharmacies() {
  try {
    let url = API.pharmacies;
    if (state.user && state.user.id) {
      url += `?user_id=${state.user.id}`;
    }
    const data = await apiCall(url);
    state.pharmacies = Array.isArray(data) ? data : [];
    
    // For admin oversight, populate the dropdown once pharmacies load
    if (getUserRole() === 'admin') {
      const select = $('#pharmacy_select');
      if (select) {
        const currentVal = select.value;
        select.innerHTML = state.pharmacies.map(p =>
          `<option value="${p.id}">${escapeHtml(p.pharmacy_name)} — ${escapeHtml(p.area || '')}</option>`
        ).join('');
        if (currentVal && state.pharmacies.some(p => String(p.id) === String(currentVal))) {
          select.value = currentVal;
        }
      }
    }
    
    updatePharmacyStatusUI();
  } catch (err) {
    console.error('Failed to load pharmacies', err);
  }
}

// populatePharmacySelect removed to sanitize app.js

async function loadPatientRequests(pharmacyId = null) {
  try {
    // If user is authenticated, filter by user_id to apply role-based request filtering
    let url = API.requests;
    const params = [];
    if (state.user && state.user.id) {
      params.push(`user_id=${state.user.id}`);
    }
    const resolvedId = pharmacyId || state.userProfile?.pharmacy_id;
    if (resolvedId) {
      params.push(`pharmacy_id=${resolvedId}`);
    }
    if (params.length > 0) {
      url += `?${params.join('&')}`;
    }
    const data = await apiCall(url);
    state.requests = Array.isArray(data) ? data : [];
    renderPatientRequests();
    if (state.currentView === 'pharmacy') {
      renderPharmacyDashboard(resolvedId);
    }
  } catch (err) {
    console.error('Failed to load requests', err);
  }
}

async function loadPharmacyFeed(pharmacyId = null) {
  try {
    const resolvedId = pharmacyId || state.userProfile?.pharmacy_id;
    let url = `${API.requests}?pharmacy_feed=1`;
    if (resolvedId) {
      url += `&pharmacy_id=${resolvedId}`;
    }
    const data = await apiCall(url);
    state.pharmacyFeed = Array.isArray(data) ? data : [];
    renderPharmacyDashboard(resolvedId);
  } catch (err) {
    console.error('Failed to load pharmacy feed', err);
  }
}

async function loadAdminStats() {
  try {
    const data = await apiCall(`${API.auth}?action=stats`);
    renderAdminDashboard(data);
  } catch (err) {
    console.error('Failed to load admin stats', err);
  }
}

function refreshData() {
  if (state.currentView === 'patient') {
    loadPatientRequests();
  } else if (state.currentView === 'pharmacy') {
    const role = getUserRole();
    const pharmacyId = role === 'admin' ? $('#pharmacy_select')?.value : null;
    loadPharmacyFeed(pharmacyId);
    loadPatientRequests(pharmacyId); // needed for "claimed by you" stat
  } else if (state.currentView === 'admin') {
    loadAdminStats();
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshData, 4000);
}

/* ============================================================
   Patient: submit a new request
   ============================================================ */
function initRequestForm() {
  const form = $('#request-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patient_name = $('#patient_name').value.trim();
    const medication_name = $('#medication_name').value.trim();
    const notes = $('#notes').value.trim();

    if (!patient_name || !medication_name) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const body = { patient_name, medication_name, notes };
      // Attach user_id if authenticated
      if (state.user && state.user.id) {
        body.user_id = state.user.id;
      }
      // Attach coordinates if stored in localStorage
      const userLat = localStorage.getItem('medsync_user_lat');
      const userLng = localStorage.getItem('medsync_user_lng');
      if (userLat && userLng) {
        body.user_lat = parseFloat(userLat);
        body.user_lng = parseFloat(userLng);
      }
      await apiCall(API.requests, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      state.patientName = patient_name;
      $('#medication_name').value = '';
      $('#notes').value = '';
      showToast(`Request sent — broadcasting "${medication_name}" to nearby pharmacies.`);
      await loadPatientRequests();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/* ============================================================
   Render: Patient requests list (status tracker)
   ============================================================ */
function renderPatientRequests() {
  const container = $('#patient-requests-list');
  // If user is authenticated and role is patient, show all their requests.
  // Otherwise fall back to name-based filtering.
  let myRequests;
  if (state.user && state.user.id && getUserRole() === 'patient') {
    myRequests = state.requests; // already filtered by user_id on backend
  } else if (state.patientName) {
    myRequests = state.requests.filter(r => r.patient_name.toLowerCase() === state.patientName.toLowerCase());
  } else {
    myRequests = state.requests;
  }

  if (myRequests.length === 0) {
    container.innerHTML = `<p class="empty-state">No requests yet — send one above to start the search.</p>`;
    return;
  }

  container.innerHTML = myRequests.map(r => requestCardHtml(r)).join('');

  // Wire "Lock Stock" buttons
  $all('.btn-lock-stock').forEach(btn => {
    btn.addEventListener('click', () => openTelebirrModal(btn.dataset));
  });

  // Wire "Mark as picked up" buttons
  $all('.btn-pickup').forEach(btn => {
    btn.addEventListener('click', () => markPickedUp(btn.dataset.requestId));
  });

  // If any request is freshly Locked, show it on the map panel
  const lockedReq = myRequests.find(r => r.status === 'Locked');
  if (lockedReq) {
    renderMapForRequest(lockedReq);
  }
}

function requestCardHtml(r) {
  const stepIndex = STATUS_ORDER.indexOf(r.status);
  const pharmacyName = r.pharmacies ? r.pharmacies.pharmacy_name : null;

  let distanceStr = '';
  const userLat = localStorage.getItem('medsync_user_lat');
  const userLng = localStorage.getItem('medsync_user_lng');
  if (r.pharmacies && r.pharmacies.location_lat !== null && r.pharmacies.location_lng !== null && userLat && userLng) {
    const d = calculateDistance(parseFloat(userLat), parseFloat(userLng), r.pharmacies.location_lat, r.pharmacies.location_lng);
    if (d !== null && !isNaN(d)) {
      distanceStr = ` · <span class="req-distance-pill">${formatDistance(d)}</span>`;
    }
  }

  const progressSteps = STATUS_ORDER.map((_, i) =>
    `<span class="step ${i <= stepIndex ? 'done' : ''}"></span>`
  ).join('');

  let actionHtml = '';
  if (r.status === 'Matched') {
    actionHtml = `
      <div class="req-actions">
        <button class="btn btn-primary btn-lock-stock"
          data-request-id="${r.id}"
          data-medication-name="${escapeHtml(r.medication_name)}"
          data-pharmacy-name="${escapeHtml(pharmacyName || 'Pharmacy')}">
          Lock Stock for 20 ETB
        </button>
      </div>`;
  } else if (r.status === 'Locked') {
    actionHtml = `
      <div class="req-actions">
        <button class="btn btn-claim btn-pickup" data-request-id="${r.id}">
          Mark as Picked Up
        </button>
      </div>`;
  }

  return `
    <div class="req-card">
      <div class="req-top">
        <div>
          <div class="req-med">${escapeHtml(r.medication_name)}</div>
          <div class="req-patient">${escapeHtml(r.patient_name)}${pharmacyName ? ' · ' + escapeHtml(pharmacyName) : ''}${distanceStr}</div>
        </div>
        <span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
      </div>
      ${r.notes ? `<div class="req-notes">${escapeHtml(r.notes)}</div>` : ''}
      <div class="req-progress">${progressSteps}</div>
      <div class="req-meta">
        <span>${timeAgo(r.timestamp)}</span>
        ${r.telebirr_ref ? `<span>· Ref: ${escapeHtml(r.telebirr_ref)}</span>` : ''}
      </div>
      ${actionHtml}
    </div>
  `;
}

/* ============================================================
   Render: Pharmacy live feed
   ============================================================ */
function renderPharmacyFeed(overridePharmacyId = null) {
  const container = $('#pharmacy-feed-list');
  const pharmacyId = overridePharmacyId || state.userProfile?.pharmacy_id;
  const activePharmacy = state.pharmacies.find(p => String(p.id) === String(pharmacyId));

  // Compute distances and map requests to a decorated list
  const decoratedFeed = state.pharmacyFeed.map(r => {
    let distance = null;
    if (activePharmacy && r.user_lat !== null && r.user_lng !== null && r.user_lat !== undefined && r.user_lng !== undefined) {
      distance = calculateDistance(activePharmacy.location_lat, activePharmacy.location_lng, r.user_lat, r.user_lng);
    }
    return { ...r, _distance: distance };
  });

  // Sort feed: closest requests first. Null distances (no coordinates) go to bottom.
  decoratedFeed.sort((a, b) => {
    if (a._distance === null && b._distance === null) return 0;
    if (a._distance === null) return 1;
    if (b._distance === null) return -1;
    return a._distance - b._distance;
  });

  if (decoratedFeed.length === 0) {
    container.innerHTML = `<p class="empty-state">No open requests right now. New patient requests will appear here in real time.</p>`;
  } else {
    container.innerHTML = decoratedFeed.map(r => {
      const distanceStr = r._distance !== null 
        ? `<span class="req-distance"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>${formatDistance(r._distance)}</span>` 
        : '';
      return `
        <div class="req-card">
          <div class="req-top">
            <div>
              <div class="req-med">${escapeHtml(r.medication_name)}</div>
              <div class="req-patient">Patient: ${escapeHtml(r.patient_name)}</div>
            </div>
            <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
              <span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
              ${distanceStr}
            </div>
          </div>
          ${r.notes ? `<div class="req-notes">${escapeHtml(r.notes)}</div>` : ''}
          <div class="req-meta"><span>${timeAgo(r.timestamp)}</span></div>
          <div class="req-actions">
            <button class="btn btn-claim" data-claim-id="${r.id}">
              Confirm Stock &amp; Claim
            </button>
          </div>
        </div>
      `;
    }).join('');

    $all('[data-claim-id]').forEach(btn => {
      btn.addEventListener('click', () => claimRequest(btn.dataset.claimId, btn));
    });
  }

  // Stats
  $('#stat-open').textContent = state.pharmacyFeed.length;
  const claimedByYou = state.requests.filter(r =>
    String(r.pharmacy_id) === String(pharmacyId) && r.status !== 'Pending'
  ).length;
  $('#stat-claimed').textContent = claimedByYou;
}

async function renderPharmacyDashboard(overridePharmacyId = null) {
  const pharmacyId = overridePharmacyId || state.userProfile?.pharmacy_id;

  const role = getUserRole();
  if (role === 'admin') {
    if (!pharmacyId) {
      // If no pharmacy is selected for oversight yet, hide the feed sections
      $('#pharmacy-live-section')?.classList.add('hidden');
      $('#pharmacy-completed-section')?.classList.add('hidden');
      $('.pharmacy-status-toggle')?.classList.add('hidden');
      $('.pharmacy-tabs')?.classList.add('hidden');
      const selectContainer = $('#pharmacy-select-container');
      if (selectContainer) selectContainer.classList.add('hidden');
      return;
    }
    // If a pharmacy is selected, show the feed sections
    $('.pharmacy-tabs')?.classList.remove('hidden');
    const liveTab = $('#tab-pharmacy-live');
    if (liveTab && liveTab.classList.contains('active')) {
      $('#pharmacy-live-section')?.classList.remove('hidden');
      $('#pharmacy-completed-section')?.classList.add('hidden');
    } else {
      $('#pharmacy-live-section')?.classList.add('hidden');
      $('#pharmacy-completed-section')?.classList.remove('hidden');
    }
    $('.pharmacy-status-toggle')?.classList.add('hidden'); // Ensure offline/online toggle is hidden for admin
    const selectContainer = $('#pharmacy-select-container');
    if (selectContainer) selectContainer.classList.remove('hidden');
  } else {
    // Non-admin staff view
    $('#pharmacy-live-section')?.classList.remove('hidden');
    $('.pharmacy-status-toggle')?.classList.remove('hidden');
    $('.pharmacy-tabs')?.classList.remove('hidden');
  }

  // Load feed if pharmacyId has changed
  if (state.lastFetchedPharmacyId !== pharmacyId) {
    state.lastFetchedPharmacyId = pharmacyId;
    await Promise.all([
      loadPharmacyFeed(pharmacyId),
      loadPatientRequests(pharmacyId)
    ]);
    return;
  }

  renderPharmacyFeed(pharmacyId);
  renderCompletedOrders(pharmacyId);
  updatePharmacyPerformanceMetrics(pharmacyId);
  updatePharmacyStatusUI(pharmacyId);
}

function renderPatientDashboard() {
  loadPatientRequests();
}

async function claimRequest(requestId, btn) {
  const pharmacyId = state.userProfile.pharmacy_id;
  if (!pharmacyId) {
    showToast('Unauthorized: No pharmacy assigned to this account.', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Claiming...';
  try {
    await apiCall(`${API.requests}?action=claim`, {
      method: 'PATCH',
      body: JSON.stringify({ request_id: requestId, pharmacy_id: pharmacyId }),
    });
    showToast('Stock confirmed — request locked to your pharmacy for patient payment.');
    await Promise.all([loadPharmacyFeed(), loadPatientRequests()]);
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Confirm Stock & Claim';
  }
}

/* ============================================================
   Render: Admin Dashboard
   ============================================================ */
async function renderAdminDashboard(data) {
  const role = getUserRole();
  if (role !== 'admin') {
    return;
  }
  
  // Populate 'Acting as pharmacy' dropdown with ALL registered pharmacies
  const select = $('#pharmacy_select');
  if (select) {
    const currentVal = select.value;
    if (state.pharmacies.length > 0) {
      select.innerHTML = state.pharmacies.map(p =>
        `<option value="${p.id}">${escapeHtml(p.pharmacy_name)} — ${escapeHtml(p.area || '')}</option>`
      ).join('');
      if (currentVal && state.pharmacies.some(p => String(p.id) === String(currentVal))) {
        select.value = currentVal;
      }
    }
    
    // Add onchange listener for Admin
    select.onchange = (e) => {
      const selectedPharmacyId = e.target.value;
      renderPharmacyDashboard(selectedPharmacyId);
    };
  }

  if (!data) {
    try {
      data = await apiCall(`${API.auth}?action=stats`);
    } catch (err) {
      console.error('Failed to load admin stats', err);
      return;
    }
  }
  // Animate KPI numbers
  animateKpiNumber('kpi-active-requests', data.total_active_requests);
  animateKpiNumber('kpi-pharmacies', data.total_pharmacies);
  animateKpiNumber('kpi-volume', data.total_volume_etb, true);
  animateKpiNumber('kpi-patients', data.total_patients);

  // Render requests table
  const tbody = $('#admin-requests-tbody');
  if (!data.recent_requests || data.recent_requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No requests in the system yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.recent_requests.map(r => {
    const pharmacyName = r.pharmacies ? r.pharmacies.pharmacy_name : '—';
    return `
      <tr>
        <td>#${r.id}</td>
        <td>${escapeHtml(r.patient_name)}</td>
        <td>${escapeHtml(r.medication_name)}</td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(pharmacyName)}</td>
        <td>${r.fee_paid ? '✅ Yes' : '—'}</td>
        <td>${r.telebirr_ref ? escapeHtml(r.telebirr_ref) : '—'}</td>
        <td>${timeAgo(r.timestamp)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Animate a KPI number counter from 0 to target value.
 */
function animateKpiNumber(elementId, targetValue, isCurrency = false) {
  const el = $(`#${elementId}`);
  if (!el) return;

  const currentText = el.textContent.replace(/[^0-9]/g, '');
  const current = parseInt(currentText) || 0;
  const target = parseInt(targetValue) || 0;

  // If the value hasn't changed, skip animation
  if (current === target) {
    el.textContent = isCurrency ? `${target.toLocaleString()} ETB` : target.toLocaleString();
    return;
  }

  const duration = 800;
  const startTime = performance.now();

  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(current + (target - current) * eased);
    el.textContent = isCurrency ? `${value.toLocaleString()} ETB` : value.toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

/* ============================================================
   Telebirr modal — "Lock Stock for 20 ETB"
   ============================================================ */
function initTelebirrModal() {
  $('#modal-close').addEventListener('click', closeTelebirrModal);
  $('#telebirr-modal').addEventListener('click', (e) => {
    if (e.target.id === 'telebirr-modal') closeTelebirrModal();
  });
  $('#confirm-pay-btn').addEventListener('click', confirmTelebirrPayment);
}

function openTelebirrModal({ requestId, medicationName, pharmacyName }) {
  state.pendingPayment = { request_id: requestId, medication_name: medicationName, pharmacy_name: pharmacyName };
  $('#modal-med-name').textContent = medicationName;
  $('#modal-pharmacy-name').textContent = pharmacyName;
  $('#telebirr-modal').classList.add('open');
  $('#telebirr-modal').setAttribute('aria-hidden', 'false');
}

function closeTelebirrModal() {
  $('#telebirr-modal').classList.remove('open');
  $('#telebirr-modal').setAttribute('aria-hidden', 'true');
  state.pendingPayment = null;
}

async function confirmTelebirrPayment() {
  if (!state.pendingPayment) return;
  const payBtnText = $('#pay-btn-text');
  const payBtnSpinner = $('#pay-btn-spinner');
  const payBtn = $('#confirm-pay-btn');

  payBtn.disabled = true;
  payBtnText.textContent = 'Processing...';
  payBtnSpinner.classList.remove('hidden');

  try {
    // Small artificial delay so the "payment processing" moment feels real for the demo
    await new Promise(resolve => setTimeout(resolve, 900));

    await apiCall(`${API.requests}?action=pay`, {
      method: 'PATCH',
      body: JSON.stringify({ request_id: state.pendingPayment.request_id }),
    });

    showToast(`Payment confirmed — ${state.pendingPayment.medication_name} is locked for pickup.`);
    closeTelebirrModal();
    await loadPatientRequests();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    payBtn.disabled = false;
    payBtnText.textContent = 'Pay 20 ETB & Lock Stock';
    payBtnSpinner.classList.add('hidden');
  }
}

async function markPickedUp(requestId) {
  try {
    await apiCall(`${API.requests}?action=pickup`, {
      method: 'PATCH',
      body: JSON.stringify({ request_id: requestId }),
    });
    showToast('Marked as picked up. Thanks for using MedSync!');
    await loadPatientRequests();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ============================================================
   Map simulation — show pin + route info for a Locked request
   ============================================================ */
function renderMapForRequest(request) {
  const mapEl = $('#map-simulation');
  const pharmacy = request.pharmacies;
  if (!pharmacy) return;

  let walkTimeStr = '🚶 ~12 min walk';
  const userLat = localStorage.getItem('medsync_user_lat');
  const userLng = localStorage.getItem('medsync_user_lng');
  if (userLat && userLng && pharmacy.location_lat !== null && pharmacy.location_lng !== null) {
    const d = calculateDistance(parseFloat(userLat), parseFloat(userLng), pharmacy.location_lat, pharmacy.location_lng);
    if (d !== null && !isNaN(d)) {
      const walkTime = Math.round(d * 12);
      walkTimeStr = `🚶 ~${walkTime > 0 ? walkTime : 1} min walk (${formatDistance(d)})`;
    }
  }

  mapEl.innerHTML = `
    <div class="map-nav-container">
      <div class="map-nav-icon">
        <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
      </div>
      <h3 class="map-nav-title">${escapeHtml(pharmacy.pharmacy_name)}</h3>
      <p class="map-nav-subtitle">📍 Located in <strong>${escapeHtml(pharmacy.area || 'Addis Ababa')}</strong> · ${walkTimeStr}</p>
      <button class="btn btn-primary btn-nav-open" id="btn-open-nav" type="button">
        <svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align: middle; margin-right: 4px;"><path fill="currentColor" d="M12 2L2 22l10-4 10 4L12 2z"/></svg>
        Open Navigation
      </button>
    </div>
  `;

  const navBtn = $('#btn-open-nav');
  if (navBtn) {
    navBtn.addEventListener('click', () => {
      const mapsLink = pharmacy.google_maps_link || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pharmacy.pharmacy_name + ' Addis Ababa')}`;
      window.open(mapsLink, '_blank');
    });
  }
}

/* ============================================================
   Chat widget — Groq AI Assistant
   ============================================================ */
function initChat() {
  const fab = $('#chat-fab');
  const sidebar = $('#chat-sidebar');
  const closeBtn = $('#chat-close');
  const form = $('#chat-form');
  const input = $('#chat-input');
  const suggestions = $('#chat-suggestions');

  fab.addEventListener('click', () => {
    sidebar.classList.add('open');
    sidebar.setAttribute('aria-hidden', 'false');
    $('#chat-fab-badge').classList.remove('show');
    input.focus();
  });
  closeBtn.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebar.setAttribute('aria-hidden', 'true');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChatMessage(text);
  });

  suggestions.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    sendChatMessage(chip.textContent);
  });
}

function appendChatMessage(role, text) {
  const messages = $('#chat-messages');
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = `<p>${escapeHtml(text)}</p>`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
  return msg;
}

function appendTypingIndicator() {
  const messages = $('#chat-messages');
  const msg = document.createElement('div');
  msg.className = 'chat-msg assistant typing';
  msg.id = 'typing-indicator';
  msg.innerHTML = `<p><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></p>`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

function removeTypingIndicator() {
  const el = $('#typing-indicator');
  if (el) el.remove();
}

async function sendChatMessage(text) {
  appendChatMessage('user', text);
  state.chatHistory.push({ role: 'user', content: text });
  appendTypingIndicator();

  try {
    const data = await apiCall(API.chat, {
      method: 'POST',
      body: JSON.stringify({ message: text, history: state.chatHistory.slice(-10) }),
    });
    removeTypingIndicator();
    appendChatMessage('assistant', data.reply);
    state.chatHistory.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    removeTypingIndicator();
    appendChatMessage('assistant', `Sorry, I couldn't reach the AI service: ${err.message}`);
  }
}

/* ============================================================
   Init
   ============================================================ */
function updatePharmacyStatusUI(overridePharmacyId = null) {
  const btn = $('#pharmacy-status-btn');
  const text = $('#pharmacy-status-text');
  if (!btn || !text) return;

  const pharmacyId = overridePharmacyId || state.userProfile?.pharmacy_id;
  const pharmacy = state.pharmacies.find(p => String(p.id) === String(pharmacyId));
  if (!pharmacy) {
    btn.className = 'btn btn-status-offline';
    text.textContent = 'Offline';
    btn.querySelector('.status-indicator').className = 'status-indicator offline';
    return;
  }

  if (pharmacy.is_active) {
    btn.className = 'btn btn-status-online';
    text.textContent = 'Online / Active';
    btn.querySelector('.status-indicator').className = 'status-indicator online';
  } else {
    btn.className = 'btn btn-status-offline';
    text.textContent = 'Busy / Offline';
    btn.querySelector('.status-indicator').className = 'status-indicator offline';
  }
}

function initPharmacyStatusToggle() {
  const btn = $('#pharmacy-status-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const pharmacyId = state.userProfile?.pharmacy_id;
    if (!pharmacyId) return;
    const pharmacy = state.pharmacies.find(p => String(p.id) === String(pharmacyId));
    if (!pharmacy) return;

    const newActive = !pharmacy.is_active;
    btn.disabled = true;
    try {
      await apiCall(`${API.pharmacies}?action=toggle_status`, {
        method: 'PATCH',
        body: JSON.stringify({
          pharmacy_id: pharmacyId,
          is_active: newActive
        })
      });
      showToast(`Pharmacy status updated to ${newActive ? 'Online' : 'Offline'}.`);
      await loadPharmacies();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function initPharmacyTabs() {
  const liveTab = $('#tab-pharmacy-live');
  const completedTab = $('#tab-pharmacy-completed');
  const liveSection = $('#pharmacy-live-section');
  const completedSection = $('#pharmacy-completed-section');

  if (!liveTab || !completedTab) return;

  liveTab.addEventListener('click', () => {
    liveTab.classList.add('active');
    liveTab.setAttribute('aria-selected', 'true');
    completedTab.classList.remove('active');
    completedTab.setAttribute('aria-selected', 'false');
    liveSection.classList.remove('hidden');
    completedSection.classList.add('hidden');
  });

  completedTab.addEventListener('click', () => {
    completedTab.classList.add('active');
    completedTab.setAttribute('aria-selected', 'true');
    liveTab.classList.remove('active');
    liveTab.setAttribute('aria-selected', 'false');
    completedSection.classList.remove('hidden');
    liveSection.classList.add('hidden');
    renderCompletedOrders();
  });
}

function renderCompletedOrders(overridePharmacyId = null) {
  const tbody = $('#pharmacy-completed-tbody');
  if (!tbody) return;

  const pharmacyId = overridePharmacyId || state.userProfile?.pharmacy_id;
  if (!pharmacyId) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No pharmacy assigned to this account.</td></tr>`;
    return;
  }

  const completed = state.requests.filter(r =>
    String(r.pharmacy_id) === String(pharmacyId) && r.status === 'Picked Up'
  );

  if (completed.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No completed orders yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = completed.map(r => {
    const dateStr = new Date(r.updated_at).toLocaleString();
    return `
      <tr>
        <td>#${r.id}</td>
        <td>${escapeHtml(r.patient_name)}</td>
        <td>${escapeHtml(r.medication_name)}</td>
        <td>${r.telebirr_ref ? escapeHtml(r.telebirr_ref) : '—'}</td>
        <td>${dateStr}</td>
      </tr>
    `;
  }).join('');
}

function updatePharmacyPerformanceMetrics(overridePharmacyId = null) {
  const claimsTodayEl = $('#stat-today-claims');
  const avgTimeEl = $('#stat-avg-time');
  if (!claimsTodayEl || !avgTimeEl) return;

  const pharmacyId = overridePharmacyId || state.userProfile?.pharmacy_id;
  if (!pharmacyId) {
    claimsTodayEl.textContent = '0';
    avgTimeEl.textContent = '0m';
    return;
  }

  const claimedRequests = state.requests.filter(r =>
    String(r.pharmacy_id) === String(pharmacyId) && r.status !== 'Pending'
  );

  const today = new Date().toDateString();
  const claimsToday = claimedRequests.filter(r => new Date(r.updated_at).toDateString() === today).length;

  let totalDiffMin = 0;
  let count = 0;
  claimedRequests.forEach(r => {
    const start = new Date(r.timestamp);
    const end = new Date(r.updated_at);
    const diffMs = end - start;
    if (diffMs > 0) {
      totalDiffMin += diffMs / (1000 * 60);
      count++;
    }
  });

  const avgResponseTime = count > 0 ? Math.round(totalDiffMin / count) : 0;

  claimsTodayEl.textContent = claimsToday;
  avgTimeEl.textContent = `${avgResponseTime}m`;
}

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initViewToggle();
  initRequestForm();
  initTelebirrModal();
  initChat();
  initPharmacyStatusToggle();
  initPharmacyTabs();

  // Load pharmacies immediately so they are available for signup dropdown
  loadPharmacies();

  // Check for existing session
  const user = loadSession();
  if (user) {
    enterApp();
  }
});
