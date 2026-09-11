/* Mobile-first influencer app: daily proof upload, calendar, payout, profile. */
import {
  api, auth, $, $$, esc, money, fmtDate, fmtTime, todayStr, badge, enablePhotoViewer,
  complianceBar, toast, loadProtectedImage, roleLabel, requireUser, formatPhone, enablePasswordToggle,
  renderPasswordRules
} from '/js/api.js';
import { mountUploader } from '/js/uploader.js';
import { mountInstallButton } from '/js/pwa.js';
import { mountMyDetails, detailsProgress } from '/js/mydetails.js';

const me = await requireUser(['influencer']);
$('#myName').textContent = me.user.full_name;

/* Signing out is one tap from every tab, so it asks first — an accidental tap
   on a phone would otherwise drop them back at the login screen. */
const confirmSignOut = () => {
  if (confirm('Sign out of QHT Influencer Manager?')) auth.logout();
};
$('#signOut').onclick = confirmSignOut;
enablePhotoViewer();              // their own photos open full size too

let calMonth = todayStr().slice(0, 7);

/** Set by the Today tab so any other tab can shut the camera down. */
let releaseCamera = null;

/* --------------------------------- tab switching --------------------------------- */
const RENDER = { today: renderToday, history: renderHistory, profile: renderProfile };

$$('.bottom-nav button').forEach(b => b.onclick = () => show(b.dataset.tab));

/** The open "My details" screen, if any — so leaving it can ask about unsaved edits. */
let detailsView = null;
const leaveDetailsOk = () =>
  !detailsView?.hasUnsaved() || confirm('You have unsaved changes in My details. Leave without saving?');

function show(tab) {
  if (!leaveDetailsOk()) return;
  detailsView = null;
  releaseCamera?.();
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.phone section').forEach(s => s.classList.toggle('hide', s.id !== 'tab-' + tab));
  RENDER[tab]();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------ today ------------------------------------ */
async function renderToday() {
  const el = $('#tab-today');
  el.innerHTML = '<p class="muted small">Loading…</p>';

  const data = await api('/submissions/mine?month=' + todayStr().slice(0, 7));
  const c = data.compliance;
  const todays = data.submissions.find(s => s.submission_date === data.today);

  el.innerHTML = `
    <div class="hero">
      <h2>Hello, ${esc(me.user.full_name.split(' ')[0])}</h2>
      <div class="sub">Day ${c.daysActive} of your QHT programme</div>
      <div class="row" style="margin-top:.8rem;gap:1.2rem">
        <div><div class="tiny" style="opacity:.85">Compliance</div><b style="font-size:1.2rem">${c.compliancePct}%</b></div>
        <div><div class="tiny" style="opacity:.85">Submitted</div><b style="font-size:1.2rem">${c.submitted}</b></div>
        <div><div class="tiny" style="opacity:.85">Missed</div><b style="font-size:1.2rem">${c.missedDays}</b></div>
      </div>
    </div>

    <div class="today-card ${todays ? 'done' : ''}" id="todayCard">
      <div class="big ${todays ? 'done' : ''}" aria-hidden="true">
        ${todays
          ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.6 2.6L16 9.6"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'}
      </div>
      <h3 style="margin-bottom:.2rem">${todays ? "Today's proof is submitted" : 'Upload today’s proof'}</h3>
      <p class="small muted" style="margin-bottom:.7rem">
        ${todays
          ? `Status: ${badge(todays.status)} · sent ${esc(fmtTime(todays.captured_at))}`
          : 'Take a photo showing you consuming the dava today.'}
      </p>
      <button class="btn ${todays ? 'ghost' : ''}" id="openUpload">
        ${todays ? 'Replace photo' : 'Upload photo'}
      </button>
    </div>

    <div class="card hide" id="uploadPanel">
      <h3>Proof for ${esc(fmtDate(data.today))}</h3>
      <div id="uploaderHost"></div>
      <div class="row" style="margin-top:.6rem">
        <button class="btn ghost grow" id="cancelUpload">Cancel</button>
      </div>
    </div>

    ${c.submittedToday ? '' : `<div class="msg warn">
      You have not submitted for today yet. Missed days reduce your compliance and can hold up your payout.
    </div>`}

    <div class="card">
      <div class="card-head"><h3 style="margin:0">Recent submissions</h3>
        <button class="link" id="seeAll">See all</button></div>
      <div id="recent"></div>
    </div>`;

  $('#seeAll').onclick = () => show('history');

  /* ---- upload panel wiring ---- */
  const panel = $('#uploadPanel');
  $('#openUpload').onclick = () => { panel.classList.remove('hide'); panel.scrollIntoView({ behavior: 'smooth' }); };
  $('#cancelUpload').onclick = () => { panel.classList.add('hide'); uploader.stop(); };

  /* ---- shared camera / file uploader ---- */
  const uploader = mountUploader($('#uploaderHost'), {
    date: data.today,
    msgEl: $('#msg'),
    onDone: renderToday
  });
  releaseCamera = uploader.stop;

  /* ---- recent list ---- */
  const recent = data.submissions.slice(0, 5);
  $('#recent').innerHTML = recent.length
    ? recent.map(s => `
        <div class="list-item">
          <img class="thumb" data-p="${esc(s.photo_path)}" alt="">
          <div class="grow">
            <b class="small">${esc(fmtDate(s.submission_date))}</b>
            <div class="tiny muted">${esc(s.note || 'No note')}</div>
          </div>
          ${badge(s.status)}
        </div>`).join('')
    : '<p class="muted small" style="margin:0">No submissions yet.</p>';

  $$('#recent img.thumb').forEach(img => loadProtectedImage(img, img.dataset.p));
}

/* ----------------------------------- history ----------------------------------- */
async function renderHistory() {
  const el = $('#tab-history');
  el.innerHTML = '<p class="muted small">Loading…</p>';

  const data = await api('/submissions/mine?month=' + calMonth);
  const byDate = Object.fromEntries(data.submissions.map(s => [s.submission_date, s]));
  const c = data.compliance;

  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;                 // Monday-first grid
  const today = todayStr();

  // Days before the programme started are not "missed" — only blank.
  const start = new Date();
  start.setDate(start.getDate() - (c.daysActive - 1));
  const startIso = start.toLocaleDateString('en-CA');

  let cells = '<div class="dow">M</div><div class="dow">T</div><div class="dow">W</div>' +
              '<div class="dow">T</div><div class="dow">F</div><div class="dow">S</div><div class="dow">S</div>';
  cells += '<div class="day blank"></div>'.repeat(lead);

  for (let d = 1; d <= days; d++) {
    const iso = `${calMonth}-${String(d).padStart(2, '0')}`;
    const sub = byDate[iso];
    const inProgramme = iso >= startIso && iso <= today;

    const cls = sub ? sub.status : (iso > today ? 'future' : inProgramme ? 'missed' : 'future');
    const mark = sub
      ? ({ approved: '✓', pending: '•', rejected: '✕', flagged: '!' }[sub.status] || '')
      : (inProgramme ? '–' : '');
    cells += `<div class="day ${cls} ${iso === today ? 'today' : ''}" title="${iso}${sub ? ' · ' + sub.status : ''}">
        <span>${d}</span><span class="tick">${mark}</span>
      </div>`;
  }

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <button class="btn ghost sm" id="prevM">‹</button>
        <h3 style="margin:0">${first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h3>
        <button class="btn ghost sm" id="nextM">›</button>
      </div>
      <div class="cal">${cells}</div>
      <div class="legend" style="margin-top:.8rem">
        <span><i style="background:#d1fae5;border:1px solid #6ee7b7"></i>Approved</span>
        <span><i style="background:#fef3c7;border:1px solid #fcd34d"></i>Pending</span>
        <span><i style="background:#fee2e2;border:1px solid #fca5a5"></i>Rejected</span>
        <span><i style="background:#fff1f2;border:1px solid #fecdd3"></i>Missed</span>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi ${c.compliancePct >= 80 ? 'good' : c.compliancePct >= 50 ? 'warn' : 'bad'}"><div class="label">Compliance</div>
        <div class="value ${c.compliancePct >= 80 ? 'good' : c.compliancePct >= 50 ? 'warn' : 'bad'}">${c.compliancePct}%</div></div>
      <div class="kpi ${c.missedDays ? 'bad' : 'good'}"><div class="label">Missed days</div><div class="value ${c.missedDays ? 'bad' : 'good'}">${c.missedDays}</div></div>
      <div class="kpi good"><div class="label">Approved</div><div class="value">${c.approved}</div></div>
      <div class="kpi warn"><div class="label">Pending</div><div class="value">${c.pending}</div></div>
    </div>

    <div class="card">
      <h3>This month's photos</h3>
      <div class="proof-grid" id="grid"></div>
    </div>`;

  $('#prevM').onclick = () => { calMonth = shiftMonth(calMonth, -1); renderHistory(); };
  $('#nextM').onclick = () => { calMonth = shiftMonth(calMonth, 1); renderHistory(); };

  $('#grid').innerHTML = data.submissions.length
    ? data.submissions.map(s => `
        <div class="proof">
          <img data-p="${esc(s.photo_path)}" alt="Proof ${esc(s.submission_date)}">
          <div class="meta">
            <b class="small">${esc(fmtDate(s.submission_date))}</b><br>${badge(s.status)}
            ${s.review_note ? `<div class="tiny" style="color:var(--red);margin-top:.25rem">${esc(s.review_note)}</div>` : ''}
          </div>
        </div>`).join('')
    : '<p class="muted small">No photos this month.</p>';

  $$('#grid img').forEach(img => loadProtectedImage(img, img.dataset.p));
}

const shiftMonth = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/* ---------------------------------- my details ---------------------------------- */
/* A button on the profile, with how far along they are, instead of the whole
   form inline — the form is long, and the profile is for glancing at. */
function detailsButton(u) {
  const { done, todo } = detailsProgress(u);
  const pct = done * 25;
  return `
    <button type="button" class="md-open" id="openDetails">
      <span class="ring ${pct === 100 ? 'good' : pct >= 50 ? 'warn' : 'bad'}" style="--pct:${pct}">
        <span class="ring-num">${done}/4</span></span>
      <span class="md-open-txt">
        <b>My details</b>
        <span>${todo.length ? `Still to add: ${esc(todo.join(', '))}` : 'All done — tap to view or edit'}</span>
      </span>
      <svg class="md-open-go" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
    </button>`;
}

/* Its own screen, still under the Profile tab. It is a history entry, so the
   phone's back gesture returns to the profile rather than leaving the app. */
function openDetails() {
  const el = $('#tab-mydetails');
  $$('.phone section').forEach(s => s.classList.toggle('hide', s !== el));
  el.innerHTML = `
    <button type="button" class="md-back" id="detailsBack">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg> Profile
    </button>
    <div id="myDetails"></div>`;
  /* keep the local copy current, so the profile shows what was just saved */
  detailsView = mountMyDetails($('#myDetails'), me.user, saved => { me.user = saved; });
  history.pushState({ details: true }, '');
  $('#detailsBack').onclick = () => history.back();
  window.scrollTo({ top: 0 });
}

window.addEventListener('popstate', () => {
  if ($('#tab-mydetails').classList.contains('hide')) return;
  // back was pressed with edits pending and they chose to stay: undo the back
  if (!leaveDetailsOk()) { history.pushState({ details: true }, ''); return; }
  detailsView = null;
  show('profile');
});

/* ----------------------------------- profile ----------------------------------- */
async function renderProfile() {
  const el = $('#tab-profile');
  const u = me.user;
  const by = me.registeredBy;

  el.innerHTML = `
    <div class="card">
      <h3>${esc(u.full_name)}</h3>
      <p class="small muted" style="margin-bottom:.8rem">${badge(u.status)} · Influencer</p>
      ${field('Phone', formatPhone(u.phone, u.country_code))}
      ${field('Registered by', by ? `${by.full_name} — ${roleLabel(by.role)}` : 'QHT Admin')}
      ${field('Joined', fmtDate(u.created_at))}
    </div>

    <!-- everything the admin did not fill in is entered on its own screen -->
    ${detailsButton(u)}

    <div class="card install-card" data-install-card hidden>
      <h3>Add to home screen</h3>
      <p class="small muted">Open QHT straight from your home screen, like an app — no download needed.</p>
      <button class="btn ghost block" data-install hidden>＋ Add QHT to home screen</button>
    </div>

    <div class="card">
      <h3>My agreement</h3>
      <p class="small muted">Read the terms you accepted at any time.</p>
      <button class="btn ghost block" id="viewAg">View accepted agreement</button>
    </div>

    <div class="card">
      <h3>Change password</h3>
      <div id="pwMsg"></div>
      <div class="field"><label for="cur">Current password</label><input id="cur" type="password"></div>
      <div class="field"><label for="nw">New password</label><input id="nw" type="password">
        <ul class="rules" id="pwRules"></ul></div>
      <button class="btn block" id="pwBtn" disabled>Update password</button>
    </div>

    <button class="btn ghost block sign-out" id="out">Sign out</button>`;

  $('#openDetails').onclick = openDetails;

  enablePasswordToggle($('#cur'));
  enablePasswordToggle($('#nw'));

  const checkPw = () => {
    const ok = renderPasswordRules($('#pwRules'), $('#nw').value, [
      { key: 'diff', label: 'Different from your current one',
        test: v => v.length > 0 && v !== $('#cur').value }
    ]);
    $('#pwBtn').disabled = !(ok && $('#cur').value);
  };
  $('#cur').oninput = checkPw;
  $('#nw').oninput = checkPw;
  checkPw();

  mountInstallButton();
  const installBtn = el.querySelector('[data-install]');
  el.querySelector('[data-install-card]').hidden = !installBtn || installBtn.hidden;

  $('#viewAg').onclick = () => location.href = '/agreement.html';
  $('#out').onclick = confirmSignOut;
  $('#pwBtn').onclick = async () => {
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: $('#cur').value, newPassword: $('#nw').value }
      });
      toast($('#pwMsg'), 'Password updated.', 'ok');
      $('#cur').value = $('#nw').value = '';
    } catch (err) { toast($('#pwMsg'), err.message, 'error'); }
  };
}

const field = (label, value) => `
  <div class="row-between" style="padding:.4rem 0;border-bottom:1px solid var(--line)">
    <span class="small muted">${esc(label)}</span>
    <span class="small" style="text-align:right">${esc(value || '—')}</span>
  </div>`;

show('today');
