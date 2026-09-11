/**
 * Daily proof uploader — the live camera / file-picker widget.
 *
 * Shared by the influencer app and the Head Influencer dashboard, because both
 * roles sign the same agreement and owe the same daily photo.
 */
import { api, $, esc, toast, todayStr, fmtDate } from '/js/api.js';
import { shrinkImage, PROOF_PHOTO } from '/js/shrink.js';

/**
 * Renders the picker into `host` and wires it up.
 * @param {HTMLElement} host   container to fill
 * @param {object}  opts
 * @param {string}  opts.date  submission date, YYYY-MM-DD
 * @param {Function} opts.onDone   called after a successful submit
 * @param {HTMLElement} opts.msgEl where toasts should appear
 * @returns {{ stop: Function }}  stop() releases the camera
 */
export function mountUploader(host, { date = todayStr(), onDone, msgEl } = {}) {
  /* Browsers remove getUserMedia entirely on an insecure origin, so over plain
     http:// to a LAN address there is no camera to offer. Say so on the card
     rather than letting someone tap it and get an error. */
  const cameraPossible = !!navigator.mediaDevices?.getUserMedia;

  host.innerHTML = `
    <h3>Proof for ${esc(fmtDate(date))}</h3>
    <!-- messages land here when the page gives no place of its own; toast()
         replaces its container's contents, so it must never be the host -->
    <div data-el="msg"></div>

    <!-- two explicit choices: the live camera, or a file already on the device -->
    <div class="pick-row" data-el="pickRow">
      <button type="button" class="pick ${cameraPossible ? '' : 'unavailable'}" data-el="useCamera"
              ${cameraPossible ? '' : 'disabled'}>
        <span class="pick-ico">📷</span>
        <b>Take a live photo</b>
        <span class="small muted">${cameraPossible
          ? 'Use your camera now'
          : 'Needs a secure (https) connection'}</span>
      </button>
      <button type="button" class="pick ${cameraPossible ? '' : 'preferred'}" data-el="useFile">
        <span class="pick-ico">🖼️</span>
        <b>Choose a file</b>
        <span class="small muted">From your gallery or folder</span>
      </button>
    </div>
    <input type="file" data-el="photoInput" accept="image/*" hidden>
    ${cameraPossible ? '' : `<p class="hint">
      Your phone's camera can only be opened over https. Take the photo with the
      camera app and pick it here — the date and time are still recorded on upload.
    </p>`}

    <div class="cam-wrap hide" data-el="camWrap">
      <video data-el="cam" playsinline autoplay muted></video>
      <!-- sits on the preview itself, where a phone camera app puts it -->
      <button type="button" class="cam-flip" data-el="flip"
              title="Switch camera" aria-label="Switch camera">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 4h3a2 2 0 0 1 2 2v9"/><path d="m18 12 2 3 2-3"/>
          <path d="M9 20H6a2 2 0 0 1-2-2V9"/><path d="m6 12-2-3-2 3"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <div class="row" style="margin-top:.6rem">
        <button type="button" class="btn grow" data-el="snap">Capture photo</button>
        <button type="button" class="btn ghost" data-el="camCancel">Cancel</button>
      </div>
    </div>

    <img class="preview hide" data-el="preview" alt="Selected proof">
    <div class="row hide" data-el="retakeRow" style="margin-top:.5rem">
      <button type="button" class="btn ghost sm" data-el="retake">Choose a different photo</button>
    </div>

    <div class="field" style="margin-top:.8rem">
      <label>Note (optional)</label>
      <input data-el="note" placeholder="e.g. taken after breakfast">
    </div>
    <p class="tiny muted">Date and time are attached automatically: <b>${esc(date)}</b></p>
    <div class="row">
      <button class="btn grow" data-el="sendBtn" disabled>Submit proof</button>
    </div>`;

  const el = name => host.querySelector(`[data-el="${name}"]`);
  const say = (text, kind) => toast(msgEl || el('msg'), text, kind);
  const quiet = () => { const m = msgEl || el('msg'); if (m) m.innerHTML = ''; };

  let file = null;
  let stream = null;

  const stopCamera = () => {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    el('camWrap')?.classList.add('hide');
  };

  const reset = () => {
    file = null;
    stopCamera();
    el('photoInput').value = '';
    el('preview').classList.add('hide');
    el('retakeRow').classList.add('hide');
    el('pickRow').classList.remove('hide');
    el('sendBtn').disabled = true;
  };

  const usePhoto = blob => {
    file = blob;
    stopCamera();
    el('preview').src = URL.createObjectURL(blob);
    el('preview').classList.remove('hide');
    el('pickRow').classList.add('hide');
    el('retakeRow').classList.remove('hide');
    el('sendBtn').disabled = false;
  };

  /* ---- option 1: the live camera ---- */
  /**
   * Opens on the front camera. The proof is a photo of the person taking the
   * dava, so the selfie camera is the one they actually want; the flip button
   * is there for anyone who prefers the back one.
   */
  let facing = 'user';

  const openCamera = async () => {
    stream?.getTracks().forEach(t => t.stop());   // release before asking again
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 } }, audio: false
    });
    el('cam').srcObject = stream;
    /* A front camera preview is mirrored, the way a mirror is — otherwise
       people move the wrong way trying to line themselves up. The captured
       photo is NOT mirrored: that would flip any text on the packet. */
    el('cam').classList.toggle('mirrored', facing === 'user');
  };

  const cameraTrouble = err => {
    say(err.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Allow it in the browser, or choose a file instead.'
      : err.name === 'NotFoundError'
        ? 'No camera found on this device. Choose a file instead.'
        : 'Could not open the camera. Choose a file instead.', 'warn');
  };

  el('useCamera').onclick = async () => {
    if (!cameraPossible) return;                 // the card already explains why
    try {
      await openCamera();
      el('pickRow').classList.add('hide');
      el('camWrap').classList.remove('hide');
    } catch (err) {
      cameraTrouble(err);
      stopCamera();
      el('pickRow').classList.remove('hide');
    }
  };

  el('flip').onclick = async () => {
    const previous = facing;
    facing = facing === 'user' ? 'environment' : 'user';
    try {
      await openCamera();
    } catch {
      /* A tablet or laptop may only have the one camera. Go back to the one
         that was working rather than leaving a dead preview. */
      facing = previous;
      try { await openCamera(); } catch (err) { cameraTrouble(err); stopCamera(); }
      say('This device has only one camera.', 'warn');
    }
  };

  el('snap').onclick = () => {
    const video = el('cam');
    /* captured straight at upload size — a 4K camera frame at 90% was several
       MB for a photo that only has to show a person and a bottle */
    const scale = Math.min(1, PROOF_PHOTO.maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) return say('Could not capture the photo. Try again.', 'error');
      usePhoto(new File([blob], `proof-${date}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', PROOF_PHOTO.quality);
  };

  el('camCancel').onclick = () => { stopCamera(); el('pickRow').classList.remove('hide'); };

  /* ---- option 2: a file already on the device ---- */
  el('useFile').onclick = () => el('photoInput').click();
  /* a gallery photo is shrunk before it is previewed, so what is shown is
     exactly what will be sent */
  el('photoInput').onchange = async e => {
    const picked = e.target.files[0];
    if (!picked) return;
    say('Preparing photo…', 'info');
    usePhoto(await shrinkImage(picked, PROOF_PHOTO));
    quiet();                                       // the preview says the rest
  };
  el('retake').onclick = reset;

  el('sendBtn').onclick = async () => {
    if (!file) return;
    const btn = el('sendBtn');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('photo', file);
      fd.append('note', el('note').value);
      fd.append('date', date);
      await api('/submissions', { method: 'POST', body: fd });
      say('Proof submitted. It is now pending review.', 'ok');
      onDone?.();
    } catch (err) {
      say(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Submit proof';
    }
  };

  return { stop: stopCamera };
}
