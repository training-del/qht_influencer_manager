/**
 * "My details" — the part of a profile its owner fills in.
 *
 * The admin registers someone with three things: name, phone and email. Address,
 * ID proof and bank details are the person's own to enter, and this is where
 * they do it. One module, mounted by both the influencer app and the head
 * influencer's dashboard, so the two cannot drift apart.
 *
 * What is deliberately NOT here: role, who they report to, their token amount,
 * their status, and their phone number. Those decide money and hierarchy, or
 * are the login identifier. The server refuses them too — this is not the only
 * thing standing in the way.
 *
 * The page answers "what is left?" as you type: a ring and four step chips
 * track completion live, each field says whether its format looks right, and
 * the save bar only wakes up when something has actually changed.
 */
import { api, $, $$, esc, toast, loadProtectedImage } from '/js/api.js';
import { shrinkImage, ID_PHOTO, sizeLabel } from '/js/shrink.js';

/* ---------------------------------- formats ---------------------------------- */
/* Checked in the browser to catch a typo while it is still on screen.
   Aadhaar is the only ID the app takes, and it is twelve digits — nothing
   else. The spaces are cosmetic: put in while typing, taken out before the
   number is sent or checked. */
const AADHAAR = {
  ok: v => /^\d{12}$/.test(digitsOf(v)),
  hint: '12 digits',
  eg: '1234 5678 9012'
};
const digitsOf = v => String(v || '').replace(/\D/g, '').slice(0, 12);
const spaced = v => digitsOf(v).replace(/\d{4}(?=\d)/g, m => m + ' ');

const RULES = {
  email:         { ok: v => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v), hint: 'name@example.com' },
  instagram:     { ok: v => /^@?[A-Za-z0-9._]{1,30}$/.test(v),   hint: 'like qht.clinic' },
  upiId:         { ok: v => /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v),  hint: 'like name@okhdfcbank' },
  bankIfsc:      { ok: v => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v),      hint: '4 letters, a zero, then 6 characters' },
  bankAccountNo: { ok: v => /^\d{9,18}$/.test(v),                  hint: '9 to 18 digits' }
};

/* upper-case as they type — these are always written in capitals */
const UPPER = new Set(['bankIfsc']);

const FIELDS = ['email', 'instagram', 'address', 'idProofType', 'idProofNumber',
                'upiId', 'bankAccountName', 'bankAccountNo', 'bankIfsc'];

const ICON = {
  contact: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  address: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  id:      '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h5M14 14h3"/>',
  payout:  '<path d="M6 4h12"/><path d="M6 9h12"/><path d="M14 4c0 4-2.5 5-8 5l8 11"/>'
};
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

/**
 * How complete the saved details are — the same four checks the form runs,
 * applied to what is on record, so a button elsewhere can show "2/4" without
 * mounting the form.
 */
export function detailsProgress(u) {
  const state = {
    email: RULES.email.ok(u.email || '') && RULES.instagram.ok(u.instagram_id || ''),
    address: (u.address || '').trim().length >= 8,
    'ID proof': AADHAAR.ok(u.id_proof_number || '') && !!u.id_proof_file,
    'UPI or bank details': RULES.upiId.ok(u.upi_id || '') ||
      (RULES.bankAccountNo.ok(u.bank_account_no || '') && RULES.bankIfsc.ok(u.bank_ifsc || '') &&
       !!u.bank_account_name)
  };
  const todo = Object.keys(state).filter(k => !state[k]);
  return { done: 4 - todo.length, todo };
}

/**
 * @param {HTMLElement} host   where to render
 * @param {object} user        the signed-in user, as /auth/me returns them
 * @param {(u: object) => void} [onSaved]
 */
export function mountMyDetails(host, user, onSaved) {
  let u = user;

  const draw = () => {
    const payoutStart = u.upi_id || !u.bank_account_no ? 'upi' : 'bank';

    host.innerHTML = `
      <div class="card md">
        <div class="md-top">
          <div>
            <h2>My details</h2>
            <p class="md-sum" id="mdSum"></p>
          </div>
          <div class="ring" id="mdRing" role="img"><span class="ring-num" id="mdRingNum"></span></div>
        </div>

        <!-- tap one to jump to it; each ticks itself off as it is completed -->
        <div class="md-steps" id="mdSteps">
          ${[['contact', 'Contact'], ['address', 'Address'], ['id', 'ID proof'], ['payout', 'Payout']]
            .map(([k, l], i) => `
              <button type="button" class="md-step" data-go="${k}">
                <span class="md-tick" aria-hidden="true">${i + 1}</span>${l}
              </button>`).join('')}
        </div>

        <form id="mdForm" novalidate>
          <section class="md-sec" data-sec="contact">
            <div class="md-sec-head">
              <span class="md-sec-ic">${svg(ICON.contact)}</span>
              <h3>Contact</h3><span class="md-state"></span>
            </div>
            <div class="grid2">
              <div class="field">
                <label>Full name</label>
                <input value="${esc(u.full_name)}" disabled>
              </div>
              <div class="field">
                <label>Phone</label>
                <input value="${esc((u.country_code || '+91') + ' ' + u.phone)}" disabled>
              </div>
            </div>
            <p class="md-hint" style="margin:-.4rem 0 .8rem">Ask QHT Admin to change your name or phone number.</p>
            <div class="field">
              <label for="mdEmail">Email *</label>
              <input id="mdEmail" name="email" type="email" required
                     value="${esc(u.email || '')}" autocomplete="email">
              <p class="md-hint" data-for="email"></p>
            </div>
            <div class="field">
              <label for="mdInstagram">Instagram id *</label>
              <div class="ig-field">
                <span class="ig-at" aria-hidden="true">@</span>
                <input id="mdInstagram" name="instagram" value="${esc(u.instagram_id || '')}"
                       placeholder="username" autocomplete="off">
              </div>
              <p class="md-hint" data-for="instagram"></p>
            </div>
          </section>

          <section class="md-sec" data-sec="address">
            <div class="md-sec-head">
              <span class="md-sec-ic">${svg(ICON.address)}</span>
              <h3>Address</h3><span class="md-state"></span>
            </div>
            <div class="field">
              <label for="mdAddress">Where you live</label>
              <textarea id="mdAddress" name="address"
                        placeholder="House, street, city, PIN">${esc(u.address || '')}</textarea>
              <p class="md-hint" data-for="address"></p>
            </div>
          </section>

          <section class="md-sec" data-sec="id">
            <div class="md-sec-head">
              <span class="md-sec-ic">${svg(ICON.id)}</span>
              <h3>ID proof</h3><span class="md-state"></span>
            </div>
            <input type="hidden" id="mdIdType" name="idProofType" value="aadhaar">
            <div class="field">
              <label for="mdIdNumber">Aadhaar number</label>
              <input id="mdIdNumber" name="idProofNumber" value="${esc(spaced(u.id_proof_number || ''))}"
                     inputmode="numeric" maxlength="14" autocomplete="off"
                     placeholder="1234 5678 9012">
              <p class="md-hint" data-for="idProofNumber"></p>
            </div>

            <div class="field">
              <label for="mdIdFile">Photo of the document</label>
              <div class="md-file">
                <img class="md-thumb" id="mdThumb" alt="" hidden>
                <div class="grow">
                  <input id="mdIdFile" name="idProofFile" type="file" accept="image/*">
                  <p class="md-hint" id="mdFileHint">
                    ${u.id_proof_file
                      ? 'One is already on file. <button type="button" class="link" id="mdViewId">See it</button>'
                      : 'A clear photo of your Aadhaar card.'}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section class="md-sec" data-sec="payout">
            <div class="md-sec-head">
              <span class="md-sec-ic">${svg(ICON.payout)}</span>
              <h3>Where your payout goes</h3><span class="md-state"></span>
            </div>

            <div class="md-seg" role="group" aria-label="Payout method">
              <button type="button" data-method="upi" aria-pressed="${payoutStart === 'upi'}">UPI</button>
              <button type="button" data-method="bank" aria-pressed="${payoutStart === 'bank'}">Bank account</button>
            </div>

            <div data-group="upi" ${payoutStart === 'upi' ? '' : 'hidden'}>
              <div class="field">
                <label for="mdUpi">UPI ID</label>
                <input id="mdUpi" name="upiId" value="${esc(u.upi_id || '')}" placeholder="name@upi"
                       autocomplete="off">
                <p class="md-hint" data-for="upiId"></p>
              </div>
            </div>

            <div data-group="bank" ${payoutStart === 'bank' ? '' : 'hidden'}>
              <div class="field">
                <label for="mdAccName">Account holder</label>
                <input id="mdAccName" name="bankAccountName" value="${esc(u.bank_account_name || '')}">
              </div>
              <div class="grid2">
                <div class="field">
                  <label for="mdAccNo">Account number</label>
                  <input id="mdAccNo" name="bankAccountNo" value="${esc(u.bank_account_no || '')}"
                         inputmode="numeric" autocomplete="off">
                  <p class="md-hint" data-for="bankAccountNo"></p>
                </div>
                <div class="field">
                  <label for="mdIfsc">IFSC</label>
                  <input id="mdIfsc" name="bankIfsc" value="${esc(u.bank_ifsc || '')}" autocomplete="off">
                  <p class="md-hint" data-for="bankIfsc"></p>
                </div>
              </div>
            </div>
          </section>

          <div id="mdMsg"></div>

          <!-- sticks to the bottom of the screen, and only asks for attention
               once there is something to save -->
          <div class="md-savebar" id="mdBar">
            <span class="md-status" id="mdStatus"></span>
            <button class="btn" id="mdSave" type="submit" disabled>Save my details</button>
          </div>
        </form>
      </div>`;

    const form = $('#mdForm', host);
    const fileInput = $('#mdIdFile', host);
    /** the picked ID photo, shrunk — a promise, so a quick Save can wait for it */
    let idReady = null;
    const field = name => form.elements[name];

    /* what was on file when the form opened — "changed" is measured against this */
    const initial = Object.fromEntries(FIELDS.map(n => [n, field(n).value.trim()]));
    const current = n => field(n).value.trim();
    const changed = () => {
      const names = FIELDS.filter(n => current(n) !== initial[n]);
      if (fileInput.files[0]) names.push('idProofFile');
      return names;
    };

    /* ------------------------------- completion ------------------------------- */
    const SECTIONS = {
      contact: () => RULES.email.ok(current('email')) && RULES.instagram.ok(current('instagram')),
      address: () => current('address').length >= 8,
      id: () => AADHAAR.ok(current('idProofNumber')) && (!!u.id_proof_file || !!fileInput.files[0]),
      payout: () => RULES.upiId.ok(current('upiId')) ||
        (RULES.bankAccountNo.ok(current('bankAccountNo')) && RULES.bankIfsc.ok(current('bankIfsc')) &&
         !!current('bankAccountName'))
    };
    const LABEL = { contact: 'email and Instagram id', address: 'address', id: 'ID proof', payout: 'UPI or bank details' };

    /* ------------------------------- field hints ------------------------------- */
    /* A stored value nobody has touched is left alone even if it would fail a
       check now — only what is being typed gets judged. */
    const judge = name => {
      const hint = $(`.md-hint[data-for="${name}"]`, host);
      const input = field(name);
      const v = current(name);
      const rule = name === 'idProofNumber'
        ? { ok: AADHAAR.ok, hint: `${AADHAAR.hint}, like ${AADHAAR.eg}` }
        : RULES[name];

      input.classList.remove('md-ok', 'md-bad');
      if (!hint) return true;
      hint.classList.remove('ok', 'bad');

      if (name === 'address') {
        hint.textContent = v.length && v.length < 8 ? 'A little more, please — street, city and PIN.' : '';
        return true;
      }
      if (!v) { hint.textContent = rule.hint; return true; }

      const good = rule.ok(v);
      const edited = v !== initial[name];
      if (good) {
        hint.textContent = 'Looks right';
        hint.classList.add('ok');
        input.classList.add('md-ok');
      } else if (edited) {
        hint.textContent = `Doesn’t look right — ${rule.hint}`;
        hint.classList.add('bad');
        input.classList.add('md-bad');
      } else {
        hint.textContent = rule.hint;
      }
      return good || !edited;
    };

    const refresh = () => {
      const state = Object.fromEntries(Object.keys(SECTIONS).map(k => [k, SECTIONS[k]()]));
      const done = Object.values(state).filter(Boolean).length;
      const pct = Math.round((done / 4) * 100);

      const ring = $('#mdRing', host);
      ring.style.setProperty('--pct', pct);
      ring.className = `ring ${pct === 100 ? 'good' : pct >= 50 ? 'warn' : 'bad'}`;
      ring.setAttribute('aria-label', `${done} of 4 sections complete`);
      $('#mdRingNum', host).textContent = `${done}/4`;

      const todo = Object.keys(state).filter(k => !state[k]).map(k => LABEL[k]);
      $('#mdSum', host).innerHTML = todo.length
        ? `Still to add: <b>${esc(todo.join(', '))}</b>. Payouts wait until your ID and payment details are in.`
        : 'All done — your payouts can be released.';

      $$('.md-step', host).forEach((b, i) => {
        const ok = state[b.dataset.go];
        b.classList.toggle('done', ok);
        b.querySelector('.md-tick').textContent = ok ? '✓' : String(i + 1);
      });
      $$('.md-sec', host).forEach(s => {
        const ok = state[s.dataset.sec];
        s.classList.toggle('done', ok);
        s.querySelector('.md-state').textContent = ok ? 'Done' : 'To add';
      });

      ['email', 'instagram', 'address', 'idProofNumber', 'upiId', 'bankAccountNo', 'bankIfsc'].forEach(judge);

      const edits = changed();
      $('#mdBar', host).classList.toggle('dirty', edits.length > 0);
      $('#mdStatus', host).textContent = edits.length
        ? `${edits.length} unsaved change${edits.length === 1 ? '' : 's'}`
        : 'Everything is saved';
      $('#mdSave', host).disabled = edits.length === 0;
    };

    /* --------------------------------- wiring --------------------------------- */
    form.addEventListener('input', e => {
      if (e.target.name === 'idProofNumber') {
        /* letters simply never appear; the caret stays at the end, which is
           where it is while a number is being typed in */
        const tidy = spaced(e.target.value);
        if (tidy !== e.target.value) e.target.value = tidy;
      }
      if (UPPER.has(e.target.name)) {
        const upper = e.target.value.toUpperCase();
        if (upper !== e.target.value) e.target.value = upper;
      }
      refresh();
    });
    form.addEventListener('change', refresh);

    $$('.md-step', host).forEach(b => b.onclick = () => {
      const sec = $(`.md-sec[data-sec="${b.dataset.go}"]`, host);
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sec.classList.remove('flash');
      void sec.offsetWidth;
      sec.classList.add('flash');
      setTimeout(() => sec.classList.remove('flash'), 1400);
    });

    /* UPI or bank: one at a time on screen. Switching hides, never clears —
       whatever was typed in the other is still there to come back to. */
    $$('.md-seg button', host).forEach(b => b.onclick = () => {
      $$('.md-seg button', host).forEach(o => o.setAttribute('aria-pressed', String(o === b)));
      $$('[data-group]', host).forEach(g => { g.hidden = g.dataset.group !== b.dataset.method; });
      refresh();
    });

    /* the document shows up the moment it is picked, before anything is sent */
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      const hint = $('#mdFileHint', host);
      const thumb = $('#mdThumb', host);
      idReady = null;
      if (!f) { thumb.hidden = true; refresh(); return; }
      if (!/^image\//.test(f.type)) {
        hint.textContent = 'That is not a photo — choose an image of the document.';
        hint.className = 'md-hint bad';
        fileInput.value = '';
        refresh();
        return;
      }

      thumb.src = URL.createObjectURL(f);
      thumb.hidden = false;
      hint.textContent = `${f.name} — preparing…`;
      hint.className = 'md-hint';

      /* Shrunk once, here. The 8 MB limit applies to what is actually sent,
         so a 12 MB camera photo is fine — it goes up at a few hundred KB. */
      const ready = idReady = shrinkImage(f, ID_PHOTO);
      ready.then(small => {
        if (idReady !== ready) return;             // another file was picked since
        if (small.size > 8 * 1024 * 1024) {
          hint.textContent = 'That photo is over 8 MB even after shrinking — try another.';
          hint.className = 'md-hint bad';
          fileInput.value = '';
          idReady = null;
          thumb.hidden = true;
          refresh();
          return;
        }
        hint.textContent = `${f.name} — ${sizeLabel(small.size)}, will be saved with your details.`;
        hint.className = 'md-hint ok';
      });
      refresh();
    };

    const view = $('#mdViewId', host);
    if (view) view.onclick = () => {
      const thumb = $('#mdThumb', host);
      thumb.hidden = false;
      loadProtectedImage(thumb, u.id_proof_file);
    };

    /* leaving the page with unsaved edits asks first */
    const guard = e => {
      if (!form.isConnected) return window.removeEventListener('beforeunload', guard);
      if (changed().length) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);

    /* ---------------------------------- save ---------------------------------- */
    form.onsubmit = async e => {
      e.preventDefault();
      const edits = changed();
      if (!edits.length) return;

      /* a field being typed into must be right before it is sent */
      const wrong = edits.find(n => n !== 'idProofFile' && !judge(n));
      if (wrong) {
        field(wrong).focus();
        toast($('#mdMsg', host), 'Please fix the field marked in red first.', 'error');
        return;
      }

      const btn = $('#mdSave', host);
      btn.disabled = true;
      btn.textContent = 'Saving…';

      /* Only what changed goes up. Sending the whole form would overwrite
         anything edited elsewhere since this page was opened. */
      const fd = new FormData();
      for (const n of edits) {
        if (n === 'idProofFile') fd.append('idProofFile', await (idReady ?? fileInput.files[0]));
        else fd.append(n, n === 'idProofNumber' ? digitsOf(current(n)) : current(n));
      }

      try {
        const res = await api('/users/me', { method: 'PATCH', body: fd });
        u = res.user;
        onSaved?.(u);
        // redraw first — it rebuilds the form, and with it the message slot
        draw();
        toast($('#mdMsg', host), 'Saved.', 'ok');
      } catch (err) {
        toast($('#mdMsg', host), err.message, 'error');
        btn.textContent = 'Save my details';
        refresh();
      }
    };

    refresh();
  };

  draw();

  /* lets whoever opened this ask before navigating away from unsaved edits */
  return { hasUnsaved: () => !!$('#mdBar', host)?.classList.contains('dirty') };
}
