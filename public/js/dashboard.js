/* Admin + Head Influencer dashboard. The same shell renders a different set of
   panels per role: admin gets full control, a head influencer gets their own
   downline only (no token editing, no payment release, flag-only review). */
import { mountUploader } from '/js/uploader.js';
import { mountMyDetails } from '/js/mydetails.js';
import { enablePush } from '/js/push.js';
import { THEME_BUTTON } from '/js/theme.js';
import {
  api, auth, $, $$, esc, money, fmtDate, fmtTime, todayStr, badge, roleLabel, statusLabel,
  complianceBar, toast, loadProtectedImage, downloadProtectedImage, enablePhotoViewer, mountTopbar, requireUser,
  COUNTRY_CODES, DEFAULT_COUNTRY, validatePhone, formatPhone, enablePasswordToggle,
  setupMonthControl, watchTables
} from '/js/api.js';
import { apiUrl } from '/js/config.js';

const me = await requireUser(['admin', 'head_influencer']);
const isAdmin = me.user.role === 'admin';
mountTopbar($('#topbar'));
enablePhotoViewer();              // any proof thumbnail, on any panel, opens full size
// in the Android app: a review summary or a new photo to review opens the queue
// (head influencers and the admin); a head's own rejected photo opens My Daily Proof
enablePush(me, screen => {
  if (screen === 'review') show('submissions');
  else if (screen === 'myproof') show('myproof');
});

/* ------------------------------ sidebar chrome ------------------------------ */
const svg = d =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICON = {
  overview: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  hierarchy: svg('<rect x="9" y="2.5" width="6" height="5" rx="1.2"/><rect x="2.5" y="16.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="16.5" width="6" height="5" rx="1.2"/><path d="M12 7.5v4M5.5 16.5v-2.5h13v2.5"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/><path d="M16.5 11.2A3 3 0 0 0 16.5 5.4M18 20c0-2.2-.8-3.9-2.2-5"/>'),
  register: svg('<circle cx="9.5" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.7-5.4 6-5.4 1 0 2 .2 2.8.6"/><path d="M17.5 14v6M14.5 17h6"/>'),
  submissions: svg('<rect x="2.5" y="6.5" width="19" height="14" rx="2.5"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 6.5l1.4-2.6h4.2l1.4 2.6"/>'),
  payments: svg('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M8 9.5h6.5M8 12.5h6.5M13 9.5c1.8 0 1.8 3 0 3l3 4"/>'),
  myproof: svg('<rect x="2.5" y="6.5" width="19" height="14" rx="2.5"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 6.5l1.4-2.6h4.2l1.4 2.6"/>'),
  reports: svg('<path d="M3 20.5h18"/><rect x="5" y="11" width="3.6" height="7" rx="1"/><rect x="10.2" y="6.5" width="3.6" height="11.5" rx="1"/><rect x="15.4" y="9" width="3.6" height="9" rx="1"/>'),
  mydetails: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="m19 3 2 2-2 2"/>')
};

/* Grouped like the reference: a short uppercase label over each cluster. */
const NAV = isAdmin
  ? [['Overview',   [['overview', 'Dashboard']]],
     ['People',     [['hierarchy', 'Hierarchy'], ['people', 'People'], ['register', 'Register']]],
     ['Compliance', [['submissions', 'Submissions', 'pendingReviews']]],
     ['Finance',    [['payments', 'Payments']]],
     ['Reporting',  [['reports', 'Reports']]]]
  : [['Overview',   [['overview', 'Dashboard']]],
     ['My proof',   [['myproof', 'My Daily Proof']]],
     ['My team',    [['people', 'My Team'], ['register', 'Add Influencer']]],
     ['Compliance', [['submissions', 'Submissions', 'pendingReviews']]],
     ['My account', [['mydetails', 'My Details']]]];

/* Counts shown as badges; fetched once up front so the sidebar opens populated. */
const stats = await api('/reports/summary').catch(() => ({}));

$('#brandBlock').innerHTML = `
  <span class="qht-mark" aria-hidden="true"></span>
  <span>
    <span class="name">QHT Influencer Manager</span>
    <span class="sub">${isAdmin ? 'Programme control' : 'Team management'}</span>
  </span>`;

$('#tabs').innerHTML = NAV.map(([group, items]) => `
  <div class="nav-group">
    <span class="group-label">${esc(group)}</span>
    ${items.map(([key, label, countKey]) => {
      const n = countKey ? Number(stats[countKey]) || 0 : 0;
      return `<button data-tab="${key}" class="${key === 'overview' ? 'active' : ''}">
          ${ICON[key]}<span>${esc(label)}</span>
          ${n ? `<span class="count">${n}</span>` : ''}
        </button>`;
    }).join('')}
  </div>`).join('');

const initials = me.user.full_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
$('#sideFoot').innerHTML = `
  <span class="avatar">${esc(initials)}</span>
  <span class="who-text">
    <span class="who-name">${esc(me.user.full_name)}</span>
    <span class="who-role">${esc(roleLabel(me.user.role))}</span>
  </span>
  ${THEME_BUTTON('side-theme')}
  <button class="out" id="sideOut" title="Sign out" aria-label="Sign out">${svg('<path d="M15 17l5-5-5-5M20 12H9M11 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/>')}</button>`;
$('#sideOut').onclick = () => auth.logout();

/* ---------------------------- mobile nav drawer ---------------------------- */
const backdrop = $('#navBackdrop');
const toggle = $('#navToggle');

const setNav = open => {
  document.body.classList.toggle('nav-open', open);
  backdrop.hidden = !open;
  toggle?.setAttribute('aria-expanded', String(open));
  toggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
};

toggle?.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
backdrop.addEventListener('click', () => setNav(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setNav(false); });

// picking a section should get the drawer out of the way
$$('#tabs button').forEach(b => b.onclick = () => { setNav(false); show(b.dataset.tab); });

const VIEWS = {
  overview: renderOverview, hierarchy: renderHierarchy, people: renderPeople,
  register: renderRegister, submissions: renderSubmissions, payments: renderPayments,
  reports: renderReports, myproof: renderMyProof, mydetails: renderMyDetails
};

/** The part of their own profile a head influencer fills in themselves. */
async function renderMyDetails() {
  mountMyDetails($('#view'), me.user, saved => { me.user = saved; });
}

/** Keeps every table's cells labelled so they can stack into cards on a phone. */
watchTables($('#view'));

/** Releases the camera when the head influencer navigates off the proof tab. */
let releaseCamera = null;

async function show(tab) {
  releaseCamera?.();
  releaseCamera = null;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#view').innerHTML = '<p class="muted">Loading…</p>';
  try {
    await VIEWS[tab]();
    /* Here rather than in each view: the reports tiles were rendered but never
       animated, so every one of them sat at its starting zero. */
    countUp($('#view'));
  }
  catch (err) { $('#view').innerHTML = `<div class="msg error">${esc(err.message)}</div>`; }
  window.scrollTo({ top: 0 });
}

/* ==================================== overview ==================================== */
async function renderOverview() {
  const s = await api('/reports/summary');

  const expected = s.submittedToday + s.awaitingSubmissionToday;
  const donePct = expected ? Math.round((s.submittedToday / expected) * 100) : 100;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  /* First name only, unless that leaves something that does not read as a name
     — "QHT Admin" would otherwise be greeted as "QHT". */
  const [first] = me.user.full_name.split(' ');
  const greetName = (first.length < 4 || first === first.toUpperCase())
    ? me.user.full_name : first;
  const today = new Date().toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long' });

  $('#view').innerHTML = `
    <div class="stack">
      <!-- today's proof run, the one number worth leading with -->
      <section class="day-hero">
        <div class="day-hero-text">
          <p class="day-hero-date">${esc(today)}</p>
          <h2>${greeting}, ${esc(greetName)}</h2>
          <p class="day-hero-sub">${expected
            ? `<b>${s.submittedToday}</b> of <b>${expected}</b> sent today&rsquo;s proof`
            : 'No one is due to send proof today'}</p>
        </div>
        ${ring(donePct)}
      </section>

      <div class="kpis">
        ${kpi('Head Influencers', s.headInfluencers, '', { icon: 'heads', go: 'people', note: 'in the programme' })}
        ${kpi('Influencers', s.influencers, '', { icon: 'people', go: 'people', note: 'in the programme' })}
        ${kpi('Active', s.activeInfluencers, 'good', { icon: 'check', go: 'people', note: 'signed and running' })}
        ${kpi('Awaiting T&C', s.pendingAgreement, s.pendingAgreement ? 'warn' : '', { icon: 'doc', go: 'people', note: 'not signed yet' })}
        ${kpi('Submitted today', s.submittedToday, '', { icon: 'camera', go: 'submissions', note: 'photos in' })}
        ${kpi('Not yet today', s.awaitingSubmissionToday, s.awaitingSubmissionToday ? 'warn' : 'good', { icon: 'clock', go: 'submissions', note: 'still outstanding' })}
        ${kpi('Pending review', s.pendingReviews, s.pendingReviews ? 'warn' : 'good', { icon: 'inbox', go: 'submissions', note: 'waiting on you' })}
        ${kpi('Avg compliance', s.avgCompliance + '%', s.avgCompliance >= 80 ? 'good' : 'bad', { icon: 'chart', go: 'reports', note: '80% is the floor' })}
      </div>

      <div class="card">
        <h2>Below the 80% compliance floor</h2>
        ${s.lowCompliance.length ? `<ul class="low-list">
            ${s.lowCompliance.map((u, i) => `
              <li class="low-row ${u.pct >= 50 ? 'warn' : 'bad'}" data-view="${u.id}" tabindex="0"
                  role="button" style="--i:${i}">
                <span class="avatar" aria-hidden="true">${esc(initialsOf(u.name))}</span>
                <span class="low-main">
                  <b class="low-name">${esc(u.name)}</b>
                  <span class="bar"><i style="--to:${Math.min(100, u.pct)}%"></i></span>
                  <span class="low-meta tiny">
                    <b class="mono">${u.pct}%</b> compliance
                    <span class="sep" aria-hidden="true">·</span>
                    <b class="mono">${u.missed}</b> missed ${u.missed === 1 ? 'day' : 'days'}
                  </span>
                </span>
                <span class="chev" aria-hidden="true">${svg('<path d="m9 18 6-6-6-6"/>')}</span>
              </li>`).join('')}
          </ul>`
          : `<p class="all-clear"><span aria-hidden="true">✓</span>
               Everyone is at or above 80%.</p>`}
      </div>
    </div>`;

  // the whole row opens the person, not just a small button at the end of it
  $$('#view [data-view]').forEach(row => {
    const open = () => openPerson(Number(row.dataset.view));
    row.onclick = open;
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });

  // every tile is a shortcut into the view that explains its number
  $$('#view .kpi[data-go]').forEach(t => t.onclick = () => show(t.dataset.go));
}

const initialsOf = name =>
  name.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();

/**
 * Progress ring for the day, drawn with a conic gradient. Only the number goes
 * inside — a caption as well crowded the hole and collided with the ring, and
 * the line beside it already says these are today's photos.
 */
const ring = pct => `
  <div class="ring ${pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad'}" style="--pct:${pct}"
       role="img" aria-label="${pct}% of today's proof is in">
    <span class="ring-num" data-count="${pct}" data-suffix="%">0%</span>
  </div>`;

const KPI_ICONS = {
  heads: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4 12 14.01l-3-3"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  rupee: '<path d="M6 4h12"/><path d="M6 9h12"/><path d="M14 4c0 4-2.5 5-8 5l8 11"/>'
};

/**
 * A tile: icon, label, number and a line saying what the number is *of*.
 * `go` turns it into a shortcut to the view that explains it; the tone drives
 * the whole tile (background, border, label) as well as the number.
 */
const kpi = (label, value, tone = '', { icon = 'chart', go = '', note = '' } = {}) => {
  /* Only a bare number (optionally a percentage) can be counted up. Anything
     already formatted — "₹1,23,000" — is printed as it is; splitting it into
     digits and a suffix turned it into "123000₹,,". */
  const text = String(value);
  const countable = /^-?\d+(?:\.\d+)?%?$/.test(text);
  const number = countable
    ? `<span class="value ${tone}" data-count="${text.replace('%', '')}"
             data-suffix="${text.endsWith('%') ? '%' : ''}">0${text.endsWith('%') ? '%' : ''}</span>`
    : `<span class="value ${tone}">${esc(text)}</span>`;

  return `
  <${go ? 'button type="button"' : 'div'} class="kpi ${tone}" ${go ? `data-go="${go}"` : ''}>
    <span class="kpi-top">
      <span class="kpi-ic" aria-hidden="true">${svg(KPI_ICONS[icon] || KPI_ICONS.chart)}</span>
      <span class="label">${esc(label)}</span>
    </span>
    ${number}
    ${note ? `<span class="kpi-note">${esc(note)}</span>` : ''}
  </${go ? 'button' : 'div'}>`;
};

/**
 * Rolls every [data-count] up from zero. Cheap enough to run on a phone, and
 * skipped entirely when the viewer has asked for less motion.
 */
function countUp(root) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $$('[data-count]', root).forEach(el => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    if (!Number.isFinite(target)) { el.textContent = el.dataset.count + suffix; return; }
    const whole = Number.isInteger(target);
    const show = v => { el.textContent = (whole ? Math.round(v) : v.toFixed(1)) + suffix; };
    if (calm || target === 0) return show(target);

    const started = performance.now();
    const step = now => {
      const t = Math.min(1, (now - started) / 650);
      show(target * (1 - Math.pow(1 - t, 3)));       // ease-out, lands exactly on target
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* =================================== hierarchy =================================== */
async function renderHierarchy() {
  const tree = await api('/users/tree');

  /* Top-down org chart: each level is a horizontal row under its parent. */

  /**
   * On a phone the tree opens showing the top two levels — everyone reporting
   * to you, with their own teams folded away. Expanding one head is a tap; the
   * fully expanded tree was several screens of scrolling before you saw
   * anything. The desktop chart is wide, not tall, so it opens in full.
   */
  const foldByDefault = matchMedia('(max-width: 719px)').matches;

  /** One person's card. The whole card opens them — a separate "open" button
   *  cost a line of its own on every node, which on a phone was most of the page. */
  const card = (n, folded = false) => {
    const c = n.compliance;
    const canOpen = n.role !== 'admin';
    return `
      <div class="org-node ${esc(n.role)}"
           ${canOpen ? `role="button" tabindex="0" data-person="${n.id}"
             aria-label="Open ${esc(n.full_name)}"` : ''}>
        <div class="org-av" aria-hidden="true">${esc(initialsOf(n.full_name))}</div>
        <div class="org-main">
          <b class="org-name">${esc(n.full_name)}</b>
          <span class="org-role">${esc(roleLabel(n.role))}</span>
          ${canOpen ? `<span class="org-tags">${badge(n.status)}</span>` : ''}
          ${c ? `<div class="org-bar">${complianceBar(c.compliancePct)}
                   <span class="tiny muted">${c.missedDays} missed ${c.missedDays === 1 ? 'day' : 'days'}</span>
                 </div>` : ''}
        </div>
        ${n.children.length ? `
          <button class="org-toggle" type="button" data-fold="${n.id}" aria-expanded="${!folded}"
                  aria-label="${folded ? 'Show' : 'Hide'} the ${n.children.length} people under ${esc(n.full_name)}">
            <span class="org-count">${n.children.length}</span>
            ${svg('<path d="m6 9 6 6 6-6"/>')}
          </button>` : ''}
        ${canOpen ? `<span class="org-chev" aria-hidden="true">${svg('<path d="m9 18 6-6-6-6"/>')}</span>` : ''}
      </div>`;
  };

  const node = n => {
    const folded = foldByDefault && n.children.length > 0;
    return `<li class="${folded ? 'folded' : ''}">
      ${card(n, folded)}
      ${n.children.length ? `<ul>${n.children.map(node).join('')}</ul>` : ''}
    </li>`;
  };

  /**
   * Rows are by role, not by depth: every Head Influencer sits in row 2 and every
   * Influencer in row 3. An influencer registered straight by the admin would
   * otherwise land in row 2, so it gets an invisible pass-through slot there —
   * the connector runs through it, keeping the reporting line honest.
   */
  const hasHeads = tree.children.some(c => c.role === 'head_influencer');
  const rootChildren = tree.children.map(child =>
    (hasHeads && tree.role === 'admin' && child.role === 'influencer')
      ? `<li class="org-passli"><div class="org-pass" aria-hidden="true"></div><ul>${node(child)}</ul></li>`
      : node(child)
  ).join('');

  const chart = `<li>
      ${card({ ...tree, children: rootChildren ? tree.children : [] })}
      ${rootChildren ? `<ul>${rootChildren}</ul>` : ''}
    </li>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2 style="margin:0">${isAdmin ? 'Full hierarchy' : 'My team'}</h2>
        <!-- doubles as a legend: each level is tinted like its node in the chart -->
        <span class="org-legend">
          <span class="lvl admin">Admin</span>
          <span class="arrow">→</span>
          <span class="lvl head">Head Influencers</span>
          <span class="arrow">→</span>
          <span class="lvl infl">Influencers</span>
        </span>
      </div>
      <div class="org-scroll">
        <ul class="org">${chart}</ul>
      </div>
      <div class="org-foot">
        <button class="btn ghost sm" id="foldAll" type="button">
          ${foldByDefault ? 'Expand everyone' : 'Collapse to heads'}
        </button>
        <span class="tiny muted chart-hint">Scroll sideways to see the full chart.</span>
      </div>
    </div>`;

  $$('#view .org-node[data-person]').forEach(el => {
    const open = () => openPerson(Number(el.dataset.person));
    el.onclick = e => { if (!e.target.closest('.org-toggle')) open(); };
    el.onkeydown = e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.org-toggle')) {
        e.preventDefault(); open();
      }
    };
  });

  /* Fold a branch away. A head with several people made the phone's indented
     tree very long, and most of the time you are only looking at one branch. */
  const setFold = (li, folded) => {
    li.classList.toggle('folded', folded);
    const btn = li.querySelector(':scope > .org-node > .org-toggle');
    if (!btn) return;
    btn.setAttribute('aria-expanded', String(!folded));
    const n = btn.querySelector('.org-count').textContent;
    btn.setAttribute('aria-label',
      `${folded ? 'Show' : 'Hide'} the ${n} people under this person`);
  };

  $$('#view .org-toggle').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const li = btn.closest('li');
      setFold(li, !li.classList.contains('folded'));
    };
  });

  /* One control for the whole chart, so you are never tapping open five
     branches one at a time. The root stays open either way. */
  const foldAll = $('#foldAll');
  let allFolded = foldByDefault;
  foldAll.onclick = () => {
    allFolded = !allFolded;
    $$('#view .org ul li').forEach(li => {
      if (li.querySelector(':scope > .org-node > .org-toggle')) setFold(li, allFolded);
    });
    foldAll.textContent = allFolded ? 'Expand everyone' : 'Collapse to heads';
  };
}

/* {influencer}_{date}_{status}.jpg — kept plain so it sorts and types easily */
/** Wires every download button under a container (person sheet, review queue). */
function wireProofDownloads(root) {
  $$(".proof-dl", root).forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    try {
      await downloadProtectedImage(btn.dataset.dl, btn.dataset.file,
        btn.closest("td, .proof")?.querySelector("img"));
      btn.classList.add("done");
      setTimeout(() => btn.classList.remove("done"), 1600);
    } catch {
      btn.classList.add("failed");
      btn.title = "Could not save that photo — try again";
      setTimeout(() => btn.classList.remove("failed"), 2400);
    } finally { btn.disabled = false; }
  });
}

const proofFileName = (name, s) =>
  [String(name).trim().replace(/[^\w.-]+/g, '_'), s.submission_date, s.status]
    .join("_").replace(/_+/g, "_") + ".jpg";

/* ==================================== people ==================================== */
async function renderPeople() {
  const people = await api('/users');

  const heads = people.filter(u => u.role === 'head_influencer').length;
  const infl = people.filter(u => u.role === 'influencer').length;

  /* Chips rather than a dropdown: the counts are useful on their own, and one
     tap beats opening a select to answer "how many heads do I have?". */
  const chip = (value, label, n) => `
    <button type="button" class="pchip" data-role="${value}" aria-pressed="${value === '' }">
      ${esc(label)} <span class="pchip-n">${n}</span>
    </button>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2 style="margin:0">${isAdmin ? 'All people' : 'My influencers'}
          <span class="muted small">(${people.length})</span></h2>
      </div>

      <div class="people-tools">
        <div class="search">
          ${svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>')}
          <input id="peopleSearch" type="search" autocomplete="off"
                 placeholder="Search by name or number" aria-label="Search people">
        </div>
        <div class="pchips" role="group" aria-label="Filter by role">
          ${chip('', 'All', people.length)}
          ${isAdmin ? chip('head_influencer', 'Heads', heads) : ''}
          ${chip('influencer', 'Influencers', infl)}
        </div>
      </div>

      <div class="people-list" id="peopleRows"></div>
    </div>`;

  let role = '';

  const row = u => `
    <article class="pcard ${esc(u.role)}" role="button" tabindex="0" data-person="${u.id}"
             aria-label="Open ${esc(u.full_name)}">
      <span class="pav" aria-hidden="true">${esc(initialsOf(u.full_name))}</span>
      <div class="pmain">
        <div class="ptop">
          <b class="pname">${esc(u.full_name)}</b>
          ${badge(u.status)}
        </div>
        <!-- separators are drawn by CSS, so hiding an item on a phone never
             leaves a stray dot behind -->
        <div class="pmeta tiny">
          <span class="prole">${esc(roleLabel(u.role))}</span>
          <span class="mono">${esc(formatPhone(u.phone, u.country_code))}</span>
          <span class="pextra">by ${esc(u.parent_name || 'QHT Admin')}</span>
          ${u.role === 'head_influencer'
            ? `<span class="pextra">${u.team_size} in team</span>` : ''}
          ${u.token_amount ? `<span class="pextra mono">${money(u.token_amount)}</span>` : ''}
        </div>
        ${u.compliance ? `<div class="pbar">
            ${complianceBar(u.compliance.compliancePct)}
            <span class="tiny muted">${u.compliance.missedDays} missed
              ${u.compliance.missedDays === 1 ? 'day' : 'days'}</span>
          </div>` : ''}
      </div>
      <div class="pacts">
        ${isAdmin ? `<button class="picon" type="button" data-del="${u.id}"
            title="Delete ${esc(u.full_name)}" aria-label="Delete ${esc(u.full_name)}">
            ${svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>')}
          </button>` : ''}
        <span class="pchev" aria-hidden="true">${svg('<path d="m9 18 6-6-6-6"/>')}</span>
      </div>
    </article>`;

  const draw = () => {
    const q = $('#peopleSearch').value.trim().toLowerCase();
    const rows = people.filter(u =>
      (!role || u.role === role) &&
      (!q || u.full_name.toLowerCase().includes(q) || String(u.phone).includes(q)));

    $('#peopleRows').innerHTML = rows.length
      ? rows.map(row).join('')
      : `<p class="empty">${people.length
          ? 'Nobody matches that search.'
          : 'Nobody registered yet.'}</p>`;

    $$('#peopleRows .pcard').forEach(el => {
      const open = () => openPerson(Number(el.dataset.person));
      el.onclick = e => { if (!e.target.closest('[data-del]')) open(); };
      el.onkeydown = e => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-del]')) {
          e.preventDefault(); open();
        }
      };
    });
    $$('#peopleRows [data-del]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      confirmDelete(Number(b.dataset.del), () => show('people'));
    });
  };

  $$('#view .pchip').forEach(b => b.onclick = () => {
    role = b.dataset.role;
    $$('#view .pchip').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    draw();
  });
  $('#peopleSearch').oninput = draw;
  draw();
}

/* =================================== register =================================== */
/**
 * Registration runs as a wizard: one group of fields per step, validated as you
 * go, with a review of everything before the account is created. Same field
 * names as before, so the submitted payload is unchanged.
 */
async function renderRegister() {
  const heads = isAdmin ? await api('/users/heads') : [];

  /* Registration asks only for what you can actually know about someone else:
     who they are and how to reach them. ID proof, address and bank details are
     theirs to fill in from "My details" once they sign in — chasing that
     information before the account exists only delayed the account. */
  const STEPS = [
    { key: 'role',
      title: isAdmin ? 'Role & placement' : 'Who you are adding',
      hint: isAdmin ? 'Who are you adding, and who do they report to?'
                    : 'Everyone you add joins your own team.' },
    { key: 'personal', title: 'Their details', hint: 'Name, phone and email, plus the temporary password they first sign in with.' },
    ...(isAdmin ? [{ key: 'token', title: 'Token amount', hint: 'What they are paid each payout cycle.' }] : []),
    { key: 'review', title: 'Review & register', hint: 'Check it over, then create the account.' }
  ];

  /* Two roles, two descriptions — a dropdown hid the one thing worth knowing
     here, which is what each role can actually do. */
  const roleCard = (value, title, blurb, icon) => `
    <button type="button" class="choice" data-role-pick="${value}" aria-pressed="false">
      <span class="choice-ic" aria-hidden="true">${svg(icon)}</span>
      <span class="choice-body">
        <b>${esc(title)}</b>
        <span class="tiny">${esc(blurb)}</span>
      </span>
      <span class="choice-tick" aria-hidden="true">${svg('<path d="m5 13 4 4L19 7"/>')}</span>
    </button>`;

  const panel = {
    role: `
      <input type="hidden" id="role" name="role" value="influencer">
      ${isAdmin ? `
        <div class="choices" role="group" aria-label="Role">
          ${roleCard('influencer', 'Influencer',
              'Takes the dava and sends a photo every day.', KPI_ICONS.people)}
          ${roleCard('head_influencer', 'Head Influencer',
              'Registers and reviews their own influencers.', KPI_ICONS.heads)}
        </div>` : `
        <p class="msg info under-you">This influencer joins <b>your team</b> — ${esc(me.user.full_name)}.</p>
        <div class="choices" role="group" aria-label="Role">
          <div class="choice is-only">
            <span class="choice-ic" aria-hidden="true">${svg(KPI_ICONS.people)}</span>
            <span class="choice-body">
              <b>Influencer</b>
              <span class="tiny">Takes the dava and sends a photo every day.</span>
            </span>
          </div>
        </div>`}

      ${isAdmin ? `<div class="field" id="parentField" style="margin-top:1rem">
        <label for="parentId">Place under</label>
        <select id="parentId" name="parentId">
          <option value="">QHT Admin (direct)</option>
          ${heads.map(h => `<option value="${h.id}">${esc(h.full_name)} (${h.team_size} in team)</option>`).join('')}
        </select>
        <p class="hint">A Head Influencer always reports straight to QHT Admin.</p>
      </div>` : ''}`,

    personal: `
      <div class="grid2">
        <div class="field"><label for="fullName">Full name *</label>
          <input id="fullName" name="fullName" required autocomplete="name"></div>
        <div class="field">
          <label for="phone">Phone *</label>
          <div class="phone-row">
            <select id="countryCode" name="countryCode" aria-label="Country code">
              ${COUNTRY_CODES.map(c =>
                `<option value="${c.code}" ${c.code === DEFAULT_COUNTRY ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
            <input id="phone" name="phone" required inputmode="numeric" autocomplete="tel-national"
                   maxlength="10" placeholder="9876543210" aria-describedby="phoneHint">
          </div>
          <p class="hint" id="phoneHint">10 digits, starting with 6, 7, 8 or 9.</p>
        </div>
        <div class="field"><label for="email">Email *</label>
          <input id="email" name="email" type="email" required autocomplete="email"
                 placeholder="name@example.com"></div>
        <div class="field"><label for="password">Temporary password *</label>
          <input id="password" name="password" type="password" required minlength="6" value="pass123">
          <p class="hint">They must replace this the first time they sign in.</p></div>
      </div>
      <p class="hint">Address, ID proof and bank details are filled in by them,
         from <b>My details</b>, once they sign in.</p>`,



    token: `
      <div class="grid2">
        <div class="field"><label for="tokenAmount">Token amount (₹)</label>
          <input id="tokenAmount" name="tokenAmount" type="number" min="0" step="100" value="5000"></div>
        <div class="field"><label for="payoutCycle">Payout cycle</label>
          <select id="payoutCycle" name="payoutCycle">
            <option value="monthly">Monthly</option><option value="fortnightly">Fortnightly</option>
            <option value="weekly">Weekly</option>
          </select></div>
      </div>`,

    review: `<div id="reviewBox"></div>`
  };

  $('#view').innerHTML = `
    <div class="card wizard">
      <h2>Register a new ${isAdmin ? 'Head Influencer or Influencer' : 'Influencer'}</h2>
      <p class="small muted">
        They are created with status <b>Awaiting T&amp;C</b>, and must accept the agreement
        and set their own password before any dashboard access.
      </p>

      <!-- the bar carries the progress, the dots carry the navigation; the
           labels only fit on a wide screen and are hidden below it -->
      <div class="wiz-track" role="progressbar" aria-valuemin="1"
           aria-valuemax="${STEPS.length}" aria-valuenow="1" id="wizTrack">
        <i id="wizFill"></i>
      </div>

      <ol class="stepper" id="stepper">
        ${STEPS.map((s, i) => `
          <li data-go="${i}">
            <span class="dot">${i + 1}</span>
            <span class="lbl">${esc(s.title)}</span>
          </li>`).join('')}
      </ol>

      <div id="regMsg"></div>

      <form id="regForm" novalidate>
        ${STEPS.map((s, i) => `
          <section class="step" data-step="${i}" ${i ? 'hidden' : ''}>
            <h3 class="step-title">${esc(s.title)}</h3>
            <p class="step-hint">${esc(s.hint)}</p>
            ${panel[s.key]}
          </section>`).join('')}

        <div class="wizard-nav">
          <button type="button" class="btn ghost" id="backBtn" disabled>Back</button>
          <span class="step-count" id="stepCount"></span>
          <button type="button" class="btn" id="nextBtn">Continue</button>
          <button type="submit" class="btn" id="regBtn" hidden>Create account</button>
        </div>
      </form>
    </div>`;

  /* ------------------------------ field wiring ------------------------------ */
  if (isAdmin) {
    // a head influencer always sits directly under the admin
    const syncParent = () =>
      $('#parentField').classList.toggle('hide', $('#role').value === 'head_influencer');

    $$('#view [data-role-pick]').forEach(btn => {
      btn.onclick = () => {
        $('#role').value = btn.dataset.rolePick;
        $$('#view [data-role-pick]').forEach(o =>
          o.setAttribute('aria-pressed', String(o === btn)));
        syncParent();
      };
    });
    $('#view [data-role-pick="influencer"]').setAttribute('aria-pressed', 'true');
    syncParent();
  }
  enablePasswordToggle($('#password'));

  const phoneEl = $('#phone'), ccEl = $('#countryCode'), hintEl = $('#phoneHint');

  const checkPhone = ({ quiet = false } = {}) => {
    const res = validatePhone(phoneEl.value, ccEl.value);
    const empty = !phoneEl.value;
    phoneEl.classList.toggle('invalid', !res.ok && !empty);
    hintEl.classList.toggle('bad', !res.ok && !empty && !quiet);
    hintEl.textContent = (!res.ok && !empty)
      ? res.error
      : (ccEl.value === '+91' ? '10 digits, starting with 6, 7, 8 or 9.' : '10 digits.');
    return res;
  };

  phoneEl.oninput = () => {
    const cleaned = phoneEl.value.replace(/\D/g, '').slice(0, 10);
    if (cleaned !== phoneEl.value) phoneEl.value = cleaned;
    checkPhone({ quiet: cleaned.length < 10 });
  };
  phoneEl.onblur = () => checkPhone();
  ccEl.onchange = () => checkPhone();

  /* -------------------------------- stepping -------------------------------- */
  let at = 0;
  const sections = $$('#regForm .step');
  const stepItems = $$('#stepper li');

  /** Blocks Continue until the current step is actually usable. */
  const validateStep = i => {
    if (STEPS[i].key === 'personal') {
      if (!$('#fullName').value.trim()) return { ok: false, msg: 'Full name is required', focus: '#fullName' };
      const ph = checkPhone();
      if (!ph.ok) return { ok: false, msg: ph.error, focus: '#phone' };

      /* The email is how they are told their temporary password, so it is not
         optional any more — and a typo here means they never get in. */
      const email = $('#email').value.trim();
      if (!email) return { ok: false, msg: 'Email is required', focus: '#email' };
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
        return { ok: false, msg: 'That email address does not look right', focus: '#email' };
      }

      if ($('#password').value.length < 6) {
        return { ok: false, msg: 'Temporary password must be at least 6 characters', focus: '#password' };
      }
    }
    if (STEPS[i].key === 'token') {
      const n = Number($('#tokenAmount').value);
      if (!Number.isFinite(n) || n < 0) return { ok: false, msg: 'Token amount must be a positive number', focus: '#tokenAmount' };
    }
    return { ok: true };
  };

  const show = i => {
    at = i;
    sections.forEach((s, n) => { s.hidden = n !== i; });
    sections[i].classList.remove('enter');
    void sections[i].offsetWidth;          // restart the entrance animation
    sections[i].classList.add('enter');

    stepItems.forEach((li, n) => {
      li.classList.toggle('done', n < i);
      li.classList.toggle('now', n === i);
      li.querySelector('.dot').textContent = n < i ? '✓' : String(n + 1);
    });

    const pct = ((i + 1) / STEPS.length) * 100;
    $('#wizFill').style.width = pct + '%';
    $('#wizTrack').setAttribute('aria-valuenow', String(i + 1));

    $('#backBtn').disabled = i === 0;
    $('#stepCount').textContent = `Step ${i + 1} of ${STEPS.length}`;
    const last = i === STEPS.length - 1;
    $('#nextBtn').hidden = last;
    $('#regBtn').hidden = !last;
    if (last) buildReview();
    $('#view').scrollIntoView({ block: 'nearest' });
  };

  const go = i => {
    if (i > at) {                          // only validate when moving forward
      for (let s = at; s < i; s++) {
        const v = validateStep(s);
        if (!v.ok) { show(s); toast($('#regMsg'), v.msg, 'error'); $(v.focus)?.focus(); return; }
      }
    }
    $('#regMsg').innerHTML = '';
    show(Math.max(0, Math.min(STEPS.length - 1, i)));
  };

  $('#nextBtn').onclick = () => go(at + 1);
  $('#backBtn').onclick = () => go(at - 1);
  stepItems.forEach((li, i) => li.onclick = () => go(i));

  // Enter advances instead of submitting half a form
  $('#regForm').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && at < STEPS.length - 1) {
      e.preventDefault();
      go(at + 1);
    }
  });

  /* --------------------------------- review --------------------------------- */
  function buildReview() {
    const val = sel => $(sel)?.value.trim() || '';
    const roleLbl = isAdmin && $('#role').value === 'head_influencer' ? 'Head Influencer' : 'Influencer';
    const under = !isAdmin
      ? me.user.full_name
      : ($('#role').value === 'head_influencer'
          ? 'QHT Admin'
          : ($('#parentId').selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, '') || 'QHT Admin'));

    const line = (k, v, warn = false) => `
      <div class="rev-row ${warn ? 'warn' : ''}">
        <span class="rev-k">${esc(k)}</span>
        <span class="rev-v">${v ? esc(v) : '<i class="muted">not provided</i>'}</span>
      </div>`;

    $('#reviewBox').innerHTML = `
      <div class="rev-card">
        <div class="rev-head">
          <b>${esc(val('#fullName') || 'Unnamed')}</b>
          <span class="badge role">${esc(roleLbl)}</span>
          <span class="badge pending_agreement">Awaiting T&amp;C</span>
        </div>
        ${line('Reports to', under)}
        ${line('Phone', `${$('#countryCode').value} ${val('#phone')}`)}
        ${line('Email', val('#email'))}
        ${isAdmin ? line('Token amount', `${money(val('#tokenAmount') || 0)} / ${$('#payoutCycle').value}`) : ''}
        ${line('Temporary password', val('#password'))}
      </div>
      <p class="hint">
        Share the temporary password with them — it stops working once they set
        their own. They fill in their address, ID proof and bank details
        themselves, from <b>My details</b>.
      </p>`;
  }

  show(0);

  /* --------------------------------- submit --------------------------------- */
  $('#regForm').onsubmit = async e => {
    e.preventDefault();

    for (let s = 0; s < STEPS.length; s++) {
      const v = validateStep(s);
      if (!v.ok) { show(s); toast($('#regMsg'), v.msg, 'error'); $(v.focus)?.focus(); return; }
    }

    const btn = $('#regBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const fd = new FormData(e.target);
      if (!isAdmin) { fd.set('role', 'influencer'); fd.delete('tokenAmount'); fd.delete('payoutCycle'); }
      if ($('#role')?.value === 'head_influencer') fd.delete('parentId');
      const res = await api('/users', { method: 'POST', body: fd });
      await renderRegister();               // fresh, empty wizard
      toast($('#regMsg'),
        `${res.user.full_name} registered as ${roleLabel(res.user.role)}. They must accept the agreement and set their own password at first sign-in.`,
        'ok');
    } catch (err) {
      toast($('#regMsg'), err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create account';
    }
  };
}

/* ================================== submissions ================================== */
/**
 * Three ways to work with proofs:
 *   Review   — the pending queue, with Approve and Reject as their own columns
 *   Approved — who sent it, how many days they have sent, and what they sent
 *   Calendar — the same records laid out by date for a chosen month
 */
async function renderSubmissions() {
  let view = 'review';
  let month = todayStr().slice(0, 7);
  let day = '';                                   // '' = any date
  let who = '';                                   // '' = everyone

  const people = (await api('/users')).filter(u => u.role !== 'admin');
  const nameOf = id => people.find(p => p.id === id)?.full_name ?? '';

  $('#view').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2 style="margin:0">Daily proof submissions</h2>
        <div class="seg" id="seg">
          <button data-v="review">Review queue</button>
          <button data-v="approved">Approved log</button>
          <button data-v="calendar">Calendar</button>
        </div>
      </div>

      <div class="row filter-bar" id="filters" style="margin-bottom:.9rem">
        <label class="fl"><span>Person</span>
          <select id="whoFilter">
            <option value="">Everyone</option>
            ${people.map(p => `<option value="${p.id}">${esc(p.full_name)} — ${esc(roleLabel(p.role))}</option>`).join('')}
          </select>
        </label>

        <label class="fl" id="dayWrap"><span>Date</span>
          <input type="date" id="dayFilter" max="${todayStr()}">
        </label>

        <label class="fl hide" id="monthWrap"><span>Month</span>
          <input type="month" id="monthFilter" value="${month}">
        </label>

        <button class="btn ghost sm" id="clearFilters">Clear</button>
      </div>

      ${isAdmin ? '' : '<div class="msg info">You review proofs from your own team. Flagged ones are raised to QHT Admin.</div>'}
      <div id="subBody"><p class="muted small">Loading…</p></div>
    </div>`;

  $$('#seg button').forEach(b => b.onclick = () => { view = b.dataset.v; paint(); });
  $('#whoFilter').onchange = e => { who = e.target.value; paint(); };
  $('#dayFilter').onchange = e => { day = e.target.value; paint(); };
  // Safari has no month input, so this may swap in a month + year pair
  setupMonthControl($('#monthWrap'), month, v => { month = v; paint(); });
  $('#clearFilters').onclick = () => {
    who = ''; day = '';
    $('#whoFilter').value = '';
    $('#dayFilter').value = '';
    paint();
  };

  /* ---- one review action, shared by every view ---- */
  const act = async (id, status) => {
    let reviewNote = null;
    if (status === 'rejected' || status === 'flagged') {
      reviewNote = prompt(status === 'rejected' ? 'Reason for rejection:' : 'Why flag this?');
      if (reviewNote === null) return;
    }
    try {
      await api(`/submissions/${id}/review`, { method: 'PATCH', body: { status, reviewNote } });
      toast($('#msg'), `Marked ${statusLabel(status)}.`, 'ok');
      paint();
    } catch (err) { toast($('#msg'), err.message, 'error'); }
  };

  const wire = () => {
    $$('#subBody [data-act]').forEach(b => b.onclick = () => act(Number(b.dataset.id), b.dataset.act));
    $$('#subBody img[data-p]').forEach(img => loadProtectedImage(img, img.dataset.p));
    wireProofDownloads($('#subBody'));
  };

  const query = extra => {
    const q = new URLSearchParams(extra);
    if (who) q.set('userId', who);
    // an exact date narrows the lists; the calendar always works a month at a time
    if (day && view !== 'calendar') q.set('date', day);
    return q.toString();
  };

  /* ============================ 1. review queue ============================ */
  async function paintReview() {
    const rows = await api('/submissions?' + query({ status: 'pending' }));
    $('#filters').classList.remove('hide');

    $('#subBody').innerHTML = !rows.length
      ? `<p class="muted small">Nothing waiting for review${day ? ' on ' + esc(fmtDate(day)) : ''}${who ? ' for this person' : ''}.</p>`
      + (day || who ? '<button class="btn ghost sm" id="clearInline">Clear filters</button>' : '')
      : `<div class="table-wrap"><table class="review-table no-stack">
          <thead><tr>
            <th>Photo</th><th>Sent by</th><th>Date</th><th>Note</th>
            <th class="c col-approve">Approve</th>
            <th class="c col-reject">Reject</th>
            <th class="c">Flag</th>
          </tr></thead>
          <tbody>${rows.map(s => `
            <tr>
              <td><span class="qthumb-wrap"><img class="qthumb" data-p="${esc(s.photo_path)}" alt="Proof by ${esc(s.full_name)}"
                       data-cap="${esc(`${s.full_name} · ${fmtDate(s.submission_date)} · ${fmtTime(s.captured_at)}`)}">
                  <button class="proof-dl qthumb-dl" type="button" data-dl="${esc(s.photo_path)}"
                          data-file="${esc(proofFileName(s.full_name, s))}"
                          title="Save this photo" aria-label="Save the photo of ${esc(s.full_name)}">
                    ${svg('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>')}
                  </button></span></td>
              <td class="name"><b>${esc(s.full_name)}</b>
                <div class="tiny muted">${esc(roleLabel(s.role))} · ${esc(s.parent_name || 'QHT Admin')}</div></td>
              <td class="small">${esc(fmtDate(s.submission_date))}
                <div class="tiny muted">${esc(fmtTime(s.captured_at))}</div></td>
              <td class="small note-cell">${s.note ? esc(s.note) : ''}</td>
              <td class="c col-approve">
                <button class="btn sm" data-act="approved" data-id="${s.id}">Approve</button></td>
              <td class="c col-reject">
                <button class="btn sm danger" data-act="rejected" data-id="${s.id}">Reject</button></td>
              <td class="c">
                <button class="btn ghost sm" data-act="flagged" data-id="${s.id}">Flag</button></td>
            </tr>`).join('')}
          </tbody></table></div>`;
    wire();
    if ($('#clearInline')) $('#clearInline').onclick = () => $('#clearFilters').click();
  }

  /* =========================== 2. approved log =========================== */
  async function paintApproved() {
    const rows = await api('/submissions?' + query({ status: 'approved', limit: 500 }));
    $('#filters').classList.remove('hide');

    // who sent how many, from the roster's own compliance figures
    const senders = [...new Set(rows.map(r => r.user_id))].map(id => {
      const p = people.find(x => x.id === id) || {};
      const mine = rows.filter(r => r.user_id === id);
      return {
        id, name: p.full_name ?? nameOf(id), role: p.role,
        approvedHere: mine.length,
        submittedDays: p.compliance?.submitted ?? mine.length,
        daysActive: p.compliance?.daysActive ?? '—',
        missed: p.compliance?.missedDays ?? '—',
        pct: p.compliance?.compliancePct ?? 0,
        last: mine[0]?.submission_date
      };
    }).sort((a, b) => b.approvedHere - a.approvedHere);

    $('#subBody').innerHTML = `
      <h3>Who has sent proof</h3>
      <div class="table-wrap"><table class="senders-table">
        <thead><tr>
          <th>Sent by</th><th>Submitted days</th><th>Approved</th>
          <th>Missed</th><th>Compliance</th><th>Last proof</th><th></th>
        </tr></thead>
        <tbody>${senders.length ? senders.map(s => `
          <tr class="tappable" data-open="${s.id}">
            <td class="name">
              <span class="who-avatar" data-band="${
                s.pct >= 80 ? 'good' : s.pct >= 50 ? 'warn' : 'bad'}">${
                esc(s.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase())}</span>
              <span class="who-text"><b>${esc(s.name)}</b>
                <span class="tiny muted">${esc(roleLabel(s.role))}</span></span>
            </td>
            <td><b>${s.submittedDays}</b> <span class="tiny muted">of ${s.daysActive}</span></td>
            <td>${s.approvedHere}</td>
            <td class="sec">${s.missed}</td>
            <td class="wide" style="min-width:130px">${complianceBar(s.pct)}</td>
            <td class="small sec">${esc(fmtDate(s.last))}</td>
            <td><button class="btn ghost sm" data-person="${s.id}">Open</button></td>
          </tr>`).join('')
          : '<tr><td colspan="7" class="muted small">No approved proofs yet.</td></tr>'}
        </tbody></table></div>

      <h3 style="margin-top:1.4rem">What they sent</h3>
      <div class="proof-grid">
        ${rows.length ? rows.map(s => `
          <div class="proof">
            <img data-p="${esc(s.photo_path)}" alt="Proof by ${esc(s.full_name)}">
            <div class="meta">
              <b class="small">${esc(s.full_name)}</b>
              <div class="tiny muted">${esc(fmtDate(s.submission_date))}</div>
              ${badge(s.status)}
              ${s.note ? `<div class="tiny muted">“${esc(s.note)}”</div>` : ''}
              <div class="tiny muted">reviewed ${esc(fmtDate(s.reviewed_at))}</div>
              <button class="btn ghost sm" data-act="pending" data-id="${s.id}"
                      style="margin-top:.35rem">Undo</button>
            </div>
          </div>`).join('')
          : '<p class="muted small">Nothing approved in this selection.</p>'}
      </div>`;
    wire();
    $$('#subBody [data-person]').forEach(b => b.onclick = () => openPerson(Number(b.dataset.person)));

    // the whole row is the target, not just the button — easier on a phone
    $$('#subBody tr.tappable').forEach(row => row.onclick = e => {
      if (e.target.closest('button')) return;          // let the button handle itself
      openPerson(Number(row.dataset.open));
    });
  }

  /* ============================= 3. calendar ============================= */
  async function paintCalendar() {
    const rows = await api('/submissions?' + query({ month, limit: 500 }));
    $('#filters').classList.remove('hide');

    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;      // Monday-first
    const today = todayStr();

    const byDate = {};
    rows.forEach(s => (byDate[s.submission_date] ||= []).push(s));

    let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
      .map(d => `<div class="dow">${d}</div>`).join('');
    cells += '<div class="cday blank"></div>'.repeat(lead);

    for (let d = 1; d <= days; d++) {
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      const list = byDate[iso] || [];
      const n = k => list.filter(s => s.status === k).length;
      const future = iso > today;

      cells += `<div class="cday ${future ? 'future' : ''} ${iso === today ? 'today' : ''} ${list.length ? 'has' : ''}"
                     ${list.length ? `data-day="${iso}"` : ''}>
          <span class="dnum">${d}</span>
          ${list.length ? `<span class="pips">
              ${n('approved') ? `<i class="pip approved" title="${n('approved')} approved">${n('approved')}</i>` : ''}
              ${n('pending') ? `<i class="pip pending" title="${n('pending')} pending">${n('pending')}</i>` : ''}
              ${n('rejected') ? `<i class="pip rejected" title="${n('rejected')} rejected">${n('rejected')}</i>` : ''}
              ${n('flagged') ? `<i class="pip flagged" title="${n('flagged')} flagged">${n('flagged')}</i>` : ''}
            </span>` : ''}
        </div>`;
    }

    $('#subBody').innerHTML = `
      <div class="row-between" style="margin-bottom:.6rem">
        <h3 style="margin:0">${new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          ${who ? `· ${esc(nameOf(Number(who)))}` : '· everyone'}</h3>
        <span class="small muted">${rows.length} proof(s) this month</span>
      </div>
      <div class="cal team-cal">${cells}</div>
      <div class="legend" style="margin-top:.7rem">
        <span><i style="background:var(--green)"></i>approved</span>
        <span><i style="background:var(--amber)"></i>pending</span>
        <span><i style="background:var(--red)"></i>rejected</span>
        <span><i class="lg-flagged-dot"></i>flagged</span>
      </div>
      <div id="dayPanel" style="margin-top:1rem"></div>`;

    const openDay = iso => {
      const list = byDate[iso] || [];
      $('#dayPanel').innerHTML = `
        <div class="card" style="box-shadow:none;border:1px solid var(--line)">
          <div class="card-head"><h3 style="margin:0">${esc(fmtDate(iso))}</h3>
            <span class="small muted">${list.length} proof(s)</span></div>
          <div class="proof-grid">
            ${list.map(s => `
              <div class="proof">
                <img data-p="${esc(s.photo_path)}" alt="Proof by ${esc(s.full_name)}">
                <div class="meta">
                  <b class="small">${esc(s.full_name)}</b>
                  <div style="margin:.3rem 0">${badge(s.status)}</div>
                  ${s.note ? `<div class="tiny muted">“${esc(s.note)}”</div>` : ''}
                  ${s.status === 'pending' && s.user_id !== me.user.id ? `
                    <div class="row" style="gap:.3rem;margin-top:.35rem">
                      <button class="btn sm" data-act="approved" data-id="${s.id}">Approve</button>
                      <button class="btn sm danger" data-act="rejected" data-id="${s.id}">Reject</button>
                    </div>` : ''}
                </div>
              </div>`).join('')}
          </div>
        </div>`;
      wire();
    };

    $$('#subBody .cday[data-day]').forEach(c => c.onclick = () => {
      $$('#subBody .cday').forEach(x => x.classList.remove('picked'));
      c.classList.add('picked');
      openDay(c.dataset.day);
    });

    // open today if it has anything, otherwise the most recent day with proofs
    const firstDay = byDate[today] ? today : Object.keys(byDate).sort().pop();
    if (firstDay) {
      $(`#subBody .cday[data-day="${firstDay}"]`)?.classList.add('picked');
      openDay(firstDay);
    }
  }

  async function paint() {
    $$('#seg button').forEach(b => b.classList.toggle('active', b.dataset.v === view));
    $('#dayWrap').classList.toggle('hide', view === 'calendar');
    $('#monthWrap').classList.toggle('hide', view !== 'calendar');
    $('#subBody').innerHTML = '<p class="muted small">Loading…</p>';
    try {
      if (view === 'review') await paintReview();
      else if (view === 'approved') await paintApproved();
      else await paintCalendar();
    } catch (err) {
      $('#subBody').innerHTML = `<div class="msg error">${esc(err.message)}</div>`;
    }
  }

  await paint();
}

/* =================================== payments =================================== */
async function renderPayments() {
  const [rows, people] = await Promise.all([api('/payments'), api('/users')]);
  const payable = people.filter(u => u.status === 'active');

  $('#view').innerHTML = `
    <div class="stack">
      <div class="card">
        <h2>Raise a payout</h2>
        <div id="payMsg"></div>
        <div class="grid2">
          <div class="field"><label for="payUser">Person</label>
            <select id="payUser">${payable.map(u =>
              `<option value="${u.id}" data-token="${u.token_amount}">${esc(u.full_name)} — ${esc(roleLabel(u.role))}</option>`).join('')}</select></div>
          <div class="field"><label for="payAmount">Amount (₹)</label><input id="payAmount" type="number" min="0" step="100"></div>
          <div class="field"><label for="periodStart">Period start</label><input id="periodStart" type="date"></div>
          <div class="field"><label for="periodEnd">Period end</label><input id="periodEnd" type="date"></div>
        </div>
        <button class="btn" id="raiseBtn">Raise payout</button>
      </div>

      <div class="card">
        <div class="card-head"><h2 style="margin:0">Payouts</h2>
          <select id="payFilter" style="width:auto">
            <option value="">All</option><option value="pending">Pending</option>
            <option value="on_hold">On hold</option><option value="released">Released</option>
          </select></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Person</th><th>Period</th><th>Amount</th><th>Status</th><th>Paid to</th><th></th></tr></thead>
          <tbody id="payRows"></tbody>
        </table></div>
      </div>
    </div>`;

  const sync = () => {
    const opt = $('#payUser').selectedOptions[0];
    if (opt) $('#payAmount').value = opt.dataset.token;
  };
  $('#payUser').onchange = sync;
  sync();

  const end = new Date(); const startD = new Date(); startD.setDate(startD.getDate() - 30);
  $('#periodStart').value = startD.toLocaleDateString('en-CA');
  $('#periodEnd').value = end.toLocaleDateString('en-CA');

  $('#raiseBtn').onclick = async () => {
    try {
      await api('/payments', {
        method: 'POST',
        body: {
          userId: Number($('#payUser').value), amount: $('#payAmount').value,
          periodStart: $('#periodStart').value, periodEnd: $('#periodEnd').value
        }
      });
      toast($('#payMsg'), 'Payout raised as pending.', 'ok');
      draw();
    } catch (err) { toast($('#payMsg'), err.message, 'error'); }
  };

  const draw = async () => {
    const f = $('#payFilter').value;
    const list = await api('/payments' + (f ? '?status=' + f : ''));
    $('#payRows').innerHTML = list.length ? list.map(p => `
      <tr>
        <td class="name"><b>${esc(p.full_name)}</b><div class="tiny muted">${esc(roleLabel(p.role))}</div></td>
        <td class="small wide">${esc(fmtDate(p.period_start))} – ${esc(fmtDate(p.period_end))}</td>
        <td class="mono">${money(p.amount)}</td>
        <td>${badge(p.status)}${p.released_at ? `<div class="tiny muted">${esc(fmtDate(p.released_at))}</div>` : ''}</td>
        <td class="tiny mono sec">${esc(p.upi_id || p.bank_account_no || '—')}</td>
        <td>${p.status !== 'released'
          ? `<button class="btn sm" data-rel="${p.id}">Mark released</button>
             <button class="btn ghost sm" data-hold="${p.id}">Hold</button>`
          : '<span class="tiny muted">done</span>'}</td>
      </tr>`).join('')
      : '<tr><td colspan="6" class="muted small">No payouts.</td></tr>';

    $$('[data-rel]').forEach(b => b.onclick = async () => {
      const referenceNo = prompt('Payment reference / UTR number:');
      if (referenceNo === null) return;
      await api(`/payments/${b.dataset.rel}`, { method: 'PATCH', body: { status: 'released', referenceNo } });
      toast($('#msg'), 'Payment marked released.', 'ok');
      draw();
    });
    $$('[data-hold]').forEach(b => b.onclick = async () => {
      await api(`/payments/${b.dataset.hold}`, { method: 'PATCH', body: { status: 'on_hold' } });
      draw();
    });
  };

  $('#payFilter').onchange = draw;
  await draw();
}

/* ==================================== reports ==================================== */
async function renderReports() {
  const [s, people] = await Promise.all([api('/reports/summary'), api('/users')]);
  const infl = people.filter(u => u.role === 'influencer');

  $('#view').innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2 style="margin:0">Compliance report</h2>
          <button class="btn" id="exportBtn">Export CSV</button></div>
        <div class="kpis four" style="margin-bottom:1rem">
          ${kpi('Active influencers', s.activeInfluencers, '', { icon: 'people', note: 'signed and running' })}
          ${kpi('Avg compliance', s.avgCompliance + '%', s.avgCompliance >= 80 ? 'good' : 'bad',
                { icon: 'chart', note: '80% is the floor' })}
          ${kpi('Total missed days', s.totalMissedDays, s.totalMissedDays ? 'warn' : 'good',
                { icon: 'clock', note: 'across everyone' })}
          ${kpi('Outstanding payouts', money(s.payments.outstanding), 'warn',
                { icon: 'rupee', note: 'approved, not yet released' })}
        </div>

        <div class="report-tools">
          <label class="fl">
            <span>Sort by</span>
            <select id="reportSort">
              <option value="compliance">Compliance — lowest first</option>
              <option value="missed">Missed days — most first</option>
              <option value="submitted">Submitted — most first</option>
              <option value="name">Name — A to Z</option>
            </select>
          </label>
        </div>

        <div class="report-list" id="reportList"></div>
      </div>
    </div>`;

  /** One influencer's record: the bar first, then the numbers behind it. */
  const rcard = u => {
    const c = u.compliance;
    const tone = c.compliancePct >= 80 ? 'good' : c.compliancePct >= 50 ? 'warn' : 'bad';
    const stat = (n, what) => `<span class="rstat"><b>${n}</b>${esc(what)}</span>`;
    return `
      <article class="rcard ${tone}" role="button" tabindex="0" data-person="${u.id}"
               aria-label="Open ${esc(u.full_name)}">
        <header class="rhead">
          <span class="pav" aria-hidden="true">${esc(initialsOf(u.full_name))}</span>
          <span class="rwho">
            <b class="pname">${esc(u.full_name)}</b>
            <span class="tiny muted">by ${esc(u.parent_name || 'QHT Admin')}
              · last proof ${esc(fmtDate(c.lastSubmission))}</span>
          </span>
          <span class="rpct">${c.compliancePct}%</span>
        </header>
        <div class="bar"><i class="${tone === 'good' ? '' : tone}"
             style="width:${Math.min(100, c.compliancePct)}%"></i></div>
        <div class="rstats">
          ${stat(c.daysActive, 'days')}
          ${stat(c.submitted, 'submitted')}
          ${stat(c.approved, 'approved')}
          ${stat(c.rejected, 'rejected')}
          ${stat(c.missedDays, 'missed')}
        </div>
      </article>`;
  };

  const SORTS = {
    compliance: (a, b) => a.compliance.compliancePct - b.compliance.compliancePct,
    missed: (a, b) => b.compliance.missedDays - a.compliance.missedDays,
    submitted: (a, b) => b.compliance.submitted - a.compliance.submitted,
    name: (a, b) => a.full_name.localeCompare(b.full_name)
  };

  const drawReport = () => {
    const rows = [...infl].sort(SORTS[$('#reportSort').value]);
    $('#reportList').innerHTML = rows.length
      ? rows.map(rcard).join('')
      : '<p class="empty">No influencers to report on yet.</p>';
  };

  /* a card opens that influencer, like the People list does */
  const openFromCard = el => { const c = el?.closest?.('[data-person]'); if (c) { openPerson(Number(c.dataset.person)); return true; } };
  $('#reportList').onclick = e => openFromCard(e.target);
  $('#reportList').onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && openFromCard(e.target)) e.preventDefault();
  };

  $('#reportSort').onchange = drawReport;
  drawReport();

  // The CSV route needs the auth header, so fetch it as a blob rather than a plain link.
  $('#exportBtn').onclick = async () => {
    const res = await fetch(apiUrl('/api/reports/export.csv'), {
      headers: { Authorization: 'Bearer ' + auth.token }
    });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `qht-compliance-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

/* ============================== my own daily proof ============================== */
/** A Head Influencer signs the same agreement, so they owe the same daily photo. */
async function renderMyProof() {
  const data = await api('/submissions/mine?month=' + todayStr().slice(0, 7));
  const c = data.compliance;
  const todays = data.submissions.find(s => s.submission_date === data.today);

  $('#view').innerHTML = `
    <div class="stack">
      <div class="kpis four">
        ${kpi('Compliance', c.compliancePct + '%',
              c.compliancePct >= 80 ? 'good' : c.compliancePct >= 50 ? 'warn' : 'bad')}
        ${kpi('Submitted', c.submitted)}
        ${kpi('Missed days', c.missedDays, c.missedDays ? 'bad' : 'good')}
        ${kpi('Pending review', c.pending, c.pending ? 'warn' : '')}
      </div>

      <div class="card">
        <div class="card-head">
          <h2 style="margin:0">${todays ? "Today's proof is submitted" : 'Upload today’s proof'}</h2>
          ${todays ? badge(todays.status) : '<span class="badge missed">Not submitted yet</span>'}
        </div>
        <p class="small muted">
          ${todays
            ? 'You can replace it until an admin approves it.'
            : 'Take a photo showing you consuming the dava today.'}
        </p>
        <div id="uploaderHost"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2 style="margin:0">This month's proofs</h2>
          <span class="small muted">${esc(data.month)}</span>
        </div>
        <div class="proof-grid" id="myProofs"></div>
      </div>
    </div>`;

  const uploader = mountUploader($('#uploaderHost'), {
    date: data.today,
    msgEl: $('#msg'),
    onDone: () => show('myproof')
  });
  releaseCamera = uploader.stop;

  $('#myProofs').innerHTML = data.submissions.length
    ? data.submissions.map(s => `
        <div class="proof">
          <img data-p="${esc(s.photo_path)}" alt="Proof ${esc(s.submission_date)}">
          <div class="meta">
            <b class="small">${esc(fmtDate(s.submission_date))}</b><br>${badge(s.status)}
            ${s.review_note ? `<div class="tiny" style="color:var(--red);margin-top:.25rem">${esc(s.review_note)}</div>` : ''}
          </div>
        </div>`).join('')
    : '<p class="muted small">No proofs uploaded this month yet.</p>';

  $$('#myProofs img').forEach(img => loadProtectedImage(img, img.dataset.p));
}

/* ================================= person drawer ================================= */
async function openPerson(id) {
  const [u, subs, heads] = await Promise.all([
    api('/users/' + id),
    api('/submissions/user/' + id).catch(() => null),
    isAdmin ? api('/users/heads').catch(() => []) : Promise.resolve([])
  ]);

  $('#modalHost').innerHTML = `
    <div class="modal-bg" id="mbg"><div class="modal stack">
      <div class="row-between">
        <div>
          <h2 style="margin:0">${esc(u.full_name)}</h2>
          <span class="badge role">${esc(roleLabel(u.role))}</span> ${badge(u.status)}
        </div>
        <button class="icon-btn" id="closeM" title="Close" aria-label="Close">${svg('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </div>

      <div class="card" style="box-shadow:none;border:1px solid var(--line)">
        ${row('Phone', formatPhone(u.phone, u.country_code))}${row('Email', u.email)}${row('Address', u.address)}
        ${row('Registered by', u.registeredBy ? `${u.registeredBy.full_name} (${roleLabel(u.registeredBy.role)})` : 'QHT Admin')}
        ${row('ID proof', u.id_proof_type ? `${u.id_proof_type.toUpperCase()} ${u.id_proof_number || ''}` : null)}
        ${row('UPI', u.upi_id)}${row('Bank', u.bank_account_no)}
        ${row('Token amount', money(u.token_amount) + ' / ' + u.payout_cycle)}
        ${row('Next payout', fmtDate(u.next_payout_date))}
      </div>

      ${u.compliance ? `<div class="kpis four">
        ${kpi('Compliance', u.compliance.compliancePct + '%', u.compliance.compliancePct >= 80 ? 'good' : 'bad')}
        ${kpi('Missed', u.compliance.missedDays, 'bad')}
        ${kpi('Approved', u.compliance.approved)}
        ${kpi('Pending', u.compliance.pending)}</div>` : ''}

      ${isAdmin ? `<div class="card" style="box-shadow:none;border:1px solid var(--line)">
        <h3>Admin controls</h3>
        <div id="adminMsg"></div>
        <div class="grid2">
          <div class="field"><label for="tokAmt">Token amount (₹)</label>
            <input id="tokAmt" type="number" min="0" step="100" value="${u.token_amount}"></div>
          <div class="field"><label for="cyc">Payout cycle</label>
            <select id="cyc">
              ${['monthly', 'fortnightly', 'weekly'].map(c =>
                `<option ${u.payout_cycle === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select></div>
        </div>
        ${u.role === 'influencer' ? `
          <div class="field">
            <label for="parentSel">Reports to</label>
            <div class="inline-field">
              <select id="parentSel">
                <option value="">QHT Admin (direct)</option>
                ${heads.map(h => `<option value="${h.id}" ${u.parent_id === h.id ? 'selected' : ''}>${
                  esc(h.full_name)} (${h.team_size} in team)</option>`).join('')}
              </select>
              <button class="btn" id="saveParent">Save</button>
            </div>
            <p class="hint">Move this influencer under a different Head Influencer.</p>
          </div>
        ` : ''}
        ${u.role === 'head_influencer'
          ? `<label class="row small" style="font-weight:400;margin-bottom:.6rem">
               <input type="checkbox" id="applyTeam" style="width:auto;margin-right:.4rem">
               Apply this amount to their whole team as well</label>` : ''}
        <div class="row">
          <button class="btn" id="saveTok">Save token amount</button>
          <button class="btn ghost" id="toggleStatus">
            ${u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>
          <button class="btn danger" id="delPerson" style="margin-left:auto">Delete</button>
        </div>
      </div>` : ''}

      ${subs ? `<div class="card" style="box-shadow:none;border:1px solid var(--line)">
        <h3>Recent proofs (${esc(subs.month)})</h3>
        <div class="proof-grid" id="personProofs">
          ${subs.submissions.slice(0, 6).map(s => `
            <div class="proof"><img data-p="${esc(s.photo_path)}" alt="">
              <div class="meta">
                <span class="when"><b class="tiny">${esc(fmtDate(s.submission_date))}</b>${badge(s.status)}</span>
                <button class="proof-dl" type="button" data-dl="${esc(s.photo_path)}"
                        data-file="${esc(proofFileName(u.full_name, s))}"
                        title="Save this photo" aria-label="Save the photo of ${esc(u.full_name)} from ${esc(fmtDate(s.submission_date))}">
                  ${svg('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>')}
                </button>
              </div>
            </div>`).join('') || '<p class="muted small">No submissions this month.</p>'}
        </div>
      </div>` : ''}
    </div></div>`;

  const close = () => { $('#modalHost').innerHTML = ''; };
  $('#closeM').onclick = close;
  $('#mbg').onclick = e => { if (e.target.id === 'mbg') close(); };

  $$('#personProofs img').forEach(img => loadProtectedImage(img, img.dataset.p));

  wireProofDownloads($("#personProofs"));

  if (isAdmin) {
    $('#saveTok').onclick = async () => {
      try {
        const res = await api(`/users/${id}/token`, {
          method: 'PATCH',
          body: {
            tokenAmount: Number($('#tokAmt').value),
            payoutCycle: $('#cyc').value,
            applyToTeam: $('#applyTeam')?.checked || false
          }
        });
        toast($('#adminMsg'), `Token amount updated for ${res.updated} account(s).`, 'ok');
      } catch (err) { toast($('#adminMsg'), err.message, 'error'); }
    };
    if ($('#saveParent')) {
      $('#saveParent').onclick = async () => {
        try {
          const res = await api(`/users/${id}/parent`, {
            method: 'PATCH', body: { parentId: $('#parentSel').value || null }
          });
          toast($('#adminMsg'), res.unchanged
            ? `Already reporting to ${res.parentName}.`
            : `Moved from ${res.from} to ${res.parentName}.`, 'ok');
        } catch (err) { toast($('#adminMsg'), err.message, 'error'); }
      };
    }

    $('#delPerson').onclick = () => { close(); confirmDelete(id, () => show('people')); };
    $('#toggleStatus').onclick = async () => {
      const status = u.status === 'suspended' ? 'active' : 'suspended';
      try {
        await api(`/users/${id}/status`, { method: 'PATCH', body: { status } });
        close();
        toast($('#msg'), `Account ${statusLabel(status)}.`, 'ok');
        show('people');
      } catch (err) { toast($('#adminMsg'), err.message, 'error'); }
    };
  }
}

/* ------------------------------ delete a person ------------------------------ */
/** Shows exactly what will be destroyed before doing it — deletion is permanent. */
async function confirmDelete(id, onDone) {
  let impact;
  try { impact = await api(`/users/${id}/impact`); }
  catch (err) { return toast($('#msg'), err.message, 'error'); }

  const hasTeam = impact.children.length > 0;
  const movesTo = impact.reassignTo ? impact.reassignTo.full_name : 'QHT Admin';

  $('#modalHost').innerHTML = `
    <div class="modal-bg" id="delBg"><div class="modal stack">
      <div>
        <h2 style="margin:0">Delete ${esc(impact.fullName)}?</h2>
        <span class="badge role">${esc(roleLabel(impact.role))}</span>
      </div>

      <div class="msg error" style="margin:0">
        This permanently removes the account and cannot be undone.
      </div>

      <div class="card" style="box-shadow:none;border:1px solid var(--line)">
        <h3 style="margin-bottom:.5rem">What gets deleted</h3>
        ${row('Daily submissions', impact.submissions + ' (photos included)')}
        ${row('Payment records', impact.payments)}
        ${row('Already released', money(impact.releasedAmount))}
        ${row('Signed agreement', impact.hasAgreement ? 'Yes — the acceptance record is lost' : 'None')}
      </div>

      ${hasTeam ? `
        <div class="msg warn" style="margin:0">
          <b>${impact.children.length} influencer(s)</b> sit under this person:
          ${esc(impact.children.map(c => c.full_name).join(', '))}.
          They will <b>not</b> be deleted — they move to <b>${esc(movesTo)}</b>.
        </div>
        <label class="row small" style="font-weight:400">
          <input type="checkbox" id="reassignOk" style="width:auto;margin-right:.5rem">
          Yes, move their team to ${esc(movesTo)} and delete this account
        </label>` : ''}

      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" id="delCancel">Cancel</button>
        <button class="btn danger" id="delGo" ${hasTeam ? 'disabled' : ''}>Delete permanently</button>
      </div>
      <div id="delMsg"></div>
    </div></div>`;

  const close = () => { $('#modalHost').innerHTML = ''; };
  $('#delCancel').onclick = close;
  $('#delBg').onclick = e => { if (e.target.id === 'delBg') close(); };
  if (hasTeam) $('#reassignOk').onchange = e => { $('#delGo').disabled = !e.target.checked; };

  $('#delGo').onclick = async () => {
    const btn = $('#delGo');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const res = await api(`/users/${id}`, {
        method: 'DELETE',
        body: { reassignChildren: hasTeam }
      });
      close();
      toast($('#msg'),
        `${res.deleted} deleted${res.reassigned ? ` · ${res.reassigned} influencer(s) moved to ${movesTo}` : ''}.`, 'ok');
      onDone?.();
    } catch (err) {
      toast($('#delMsg'), err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Delete permanently';
    }
  };
}

const row = (label, value) => `
  <div class="row-between" style="padding:.35rem 0;border-bottom:1px solid var(--line)">
    <span class="small muted">${esc(label)}</span>
    <span class="small" style="text-align:right">${esc(value || '—')}</span>
  </div>`;

show('overview');
