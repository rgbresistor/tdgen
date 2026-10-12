const BUCKET = 'media';
const MAX_REC_SECONDS = 60;
const TARGET_WIDTH = 900;  // Lebar target foto 3:4
const TARGET_HEIGHT = 1200; // Tinggi target foto 3:4

const $ = (id) => document.getElementById(id);

let sb = null;
const configured = typeof SUPABASE_URL !== 'undefined' && /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 100;
if (configured) {
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Gagal membuat klien Supabase:', e);
  }
}
if (!sb) {
  const warnEl = $('configWarn');
  if (warnEl) warnEl.classList.remove('hidden');
}

let photoBlob = null, photoExt = 'jpg';
let audioBlob = null, audioType = '', audioExt = 'm4a';
let photoUrl = null;

function setMsg(text, isError) {
  const el = $('msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------------- Modal & Request Izin Awal (Safe & Isolated) ---------------- */
async function requestInitialPermissions() {
  const btn = $('grantPermissionBtn');
  if (!btn || btn.disabled) return;
  
  btn.disabled = true;
  btn.textContent = 'Meminta izin...';

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      // 1. Minta izin Kamera
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        videoStream.getTracks().forEach((track) => track.stop());
      } catch (vErr) {
        console.warn('Izin kamera ditolak/dilewati:', vErr);
      }

      // 2. Minta izin Mikrofon
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream.getTracks().forEach((track) => track.stop());
      } catch (aErr) {
        console.warn('Izin mikrofon ditolak/dilewati:', aErr);
      }
    } catch (err) {
      console.warn('Gagal meminta izin:', err);
    } finally {
      // Selalu tutup modal
      const modal = $('permissionModal');
      if (modal) modal.classList.add('hidden');
    }
  } else {
    const modal = $('permissionModal');
    if (modal) modal.classList.add('hidden');
    setPhotoMsg('Browser tidak mendukung WebRTC. Gunakan kamera bawaan HP.');
  }
}

/* ---------------- WebGL / GLSL Shader Engine (With Fallback) ---------------- */
const vsSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
  }
`;

const fsSource = `
  precision mediump float;
  uniform sampler2D u_image;
  varying vec2 v_texCoord;

  float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec4 color = texture2D(u_image, v_texCoord);
    vec3 c = color.rgb;
    c = mix(vec3(0.5), c, 1.15); // Contrast
    
    float noise = (rand(v_texCoord) - 0.5) * 0.05; // Film grain
    c += noise;

    vec2 uv = v_texCoord - 0.5;
    float len = length(uv);
    float vignette = smoothstep(0.7, 0.2, len);
    c *= mix(0.75, 1.0, vignette); // Vignette

    gl_FragColor = vec4(c, color.a);
  }
`;

function applyGLSLShader(sourceImageOrVideo, srcWidth, srcHeight) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = TARGET_HEIGHT;

    // Fungsi Fallback 2D
    const runFallback2D = () => {
      const ctx2d = canvas.getContext('2d');
      cropAndDraw2D(ctx2d, sourceImageOrVideo, srcWidth, srcHeight, TARGET_WIDTH, TARGET_HEIGHT);
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
    };

    try {
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) { runFallback2D(); return; }

      function createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      }

      const vertShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
      const fragShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
      if (!vertShader || !fragShader) { runFallback2D(); return; }

      const program = gl.createProgram();
      gl.attachShader(program, vertShader);
      gl.attachShader(program, fragShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        runFallback2D(); return;
      }

      gl.useProgram(program);

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

      const posAttr = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(posAttr);
      gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

      const targetAspect = TARGET_WIDTH / TARGET_HEIGHT;
      const srcAspect = srcWidth / srcHeight;

      let uMin = 0, uMax = 1, vMin = 0, vMax = 1;
      if (srcAspect > targetAspect) {
        const scale = targetAspect / srcAspect;
        uMin = (1 - scale) / 2;
        uMax = 1 - uMin;
      } else {
        const scale = srcAspect / targetAspect;
        vMin = (1 - scale) / 2;
        vMax = 1 - vMin;
      }

      const texBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        uMin, vMax,  uMax, vMax,  uMin, vMin,  uMax, vMin
      ]), gl.STATIC_DRAW);

      const texAttr = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(texAttr);
      gl.vertexAttribPointer(texAttr, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImageOrVideo);

      gl.viewport(0, 0, TARGET_WIDTH, TARGET_HEIGHT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
    } catch (err) {
      console.warn('GLSL Gagal, memakai Fallback Canvas 2D:', err);
      runFallback2D();
    }
  });
}

function cropAndDraw2D(ctx, img, sw, sh, tw, th) {
  const targetAspect = tw / th;
  const srcAspect = sw / sh;
  let dw = sw, dh = sh, sx = 0, sy = 0;

  if (srcAspect > targetAspect) {
    dw = sh * targetAspect;
    sx = (sw - dw) / 2;
  } else {
    dh = sw / targetAspect;
    sy = (sh - dh) / 2;
  }
  ctx.drawImage(img, sx, sy, dw, dh, 0, 0, tw, th);
}

/* ---------------- Foto Handler ---------------- */
function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const blob = await applyGLSLShader(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(url);
        resolve(blob);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak bisa dibaca')); };
    img.src = url;
  });
}

function showPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = photoBlob ? URL.createObjectURL(photoBlob) : null;
  const prev = $('photoPreview');
  if (prev) prev.src = photoUrl || '';
  const frame = $('photoFrame');
  if (frame) frame.classList.toggle('has-img', !!photoBlob);
  const rm = $('photoRemove');
  if (rm) rm.classList.toggle('hidden', !photoBlob);
  const btn = $('photoBtn');
  if (btn) btn.textContent = photoBlob ? 'Ambil ulang' : 'Ambil foto';
}

async function handlePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  setMsg('');
  try {
    photoBlob = await processImageFile(file);
    photoExt = 'jpg';
  } catch (err) {
    photoBlob = file;
    photoExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
  }
  showPhoto();
  e.target.value = '';
}

/* ---- Kamera langsung di halaman ---- */
let camStream = null;

function setPhotoMsg(text) { 
  const el = $('photoMsg');
  if (el) el.textContent = text || ''; 
}

function setCamUI(live) {
  const frame = $('photoFrame');
  if (frame) frame.classList.toggle('live', live);
  const ctrl = $('camControls');
  if (ctrl) ctrl.classList.toggle('hidden', !live);
  const row = $('photoRow');
  if (row) row.classList.toggle('hidden', live);
}

async function openCamera() {
  setMsg('');
  setPhotoMsg('');
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    const pi = $('photoInput');
    if (pi) pi.click();
    return;
  }
  try {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false
      });
    } catch (e1) {
      if (e1 && (e1.name === 'OverconstrainedError' || e1.name === 'NotFoundError')) {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else { throw e1; }
    }
  } catch (err) {
    const name = (err && err.name) || 'Error';
    let why = 'Kamera tidak bisa dibuka (' + name + ').';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      why = 'Izin kamera ditolak (' + name + '). Aktifkan izin Kamera di pengaturan browser.';
    }
    setPhotoMsg(why + ' Coba tombol "Kamera bawaan HP" atau "Pilih dari galeri".');
    return;
  }
  const v = $('camVideo');
  if (v) {
    v.srcObject = camStream;
    try { await v.play(); } catch (e) {}
  }
  setCamUI(true);
}

function closeCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const v = $('camVideo');
  if (v) v.srcObject = null;
  setCamUI(false);
}

async function snapPhoto() {
  const v = $('camVideo');
  if (!v || !v.videoWidth) { setPhotoMsg('Kamera belum siap, tunggu sebentar.'); return; }
  try {
    photoBlob = await applyGLSLShader(v, v.videoWidth, v.videoHeight);
    photoExt = 'jpg';
    closeCamera();
    showPhoto();
  } catch (err) {
    console.error(err);
    setPhotoMsg('Gagal memproses foto, coba lagi.');
  }
}

/* ---------------- Suara ---------------- */
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
let stream = null, recorder = null, chunks = [], timer = null, startedAt = 0, audioObjUrl = null;

function extFromType(type, fallbackName) {
  const t = (type || '').toLowerCase();
  if (t.includes('mp4') || t.includes('aac') || t.includes('m4a')) return 'm4a';
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('wav')) return 'wav';
  const fromName = (fallbackName || '').split('.').pop();
  return fromName && fromName.length <= 4 ? fromName.toLowerCase() : 'm4a';
}

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function showAudioState() {
  const has = !!audioBlob;
  if (canRecord) {
    if ($('recIdle'))$('recIdle').classList.toggle('hidden', has || !!recorder);
    if ($('recActive'))$('recActive').classList.toggle('hidden', !recorder);
    if ($('recDone'))$('recDone').classList.toggle('hidden', !has);
    if ($('recFallback'))$('recFallback').classList.add('hidden');
  } else {
    if ($('recIdle'))$('recIdle').classList.add('hidden');
    if ($('recActive'))$('recActive').classList.add('hidden');
    if ($('recDone'))$('recDone').classList.toggle('hidden', !has);
    if ($('recFallback'))$('recFallback').classList.toggle('hidden', has);
  }
  if (audioObjUrl) { URL.revokeObjectURL(audioObjUrl); audioObjUrl = null; }
  const prev = $('audioPreview');
  if (has && prev) {
    audioObjUrl = URL.createObjectURL(audioBlob);
    prev.src = audioObjUrl;
  } else if (prev) {
    prev.removeAttribute('src');
  }
}

async function startRec() {
  setMsg('');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setMsg('Mikrofon tidak bisa dipakai. Izinkan akses mikrofon di pengaturan browser.', true);
    return;
  }
  const mime = pickMime();
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || mime || 'audio/mp4';
    audioBlob = new Blob(chunks, { type });
    audioType = type.split(';')[0];
    audioExt = extFromType(audioType);
    recorder = null;
    showAudioState();
  };
  recorder.start();
  startedAt = Date.now();
  if ($('recTime'))$('recTime').textContent = '0:00';
  timer = setInterval(() => {
    const sec = (Date.now() - startedAt) / 1000;
    if ($('recTime'))$('recTime').textContent = fmt(sec);
    if (sec >= MAX_REC_SECONDS) stopRec();
  }, 250);
  showAudioState();
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function clearAudio() { audioBlob = null; showAudioState(); }

/* ---------------- Kirim ---------------- */
async function uploadFile(path, blob, contentType) {
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType, cacheControl: '3600', upsert: false
  });
  if (error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function submit() {
  closeCamera();
  if (!sb) { setMsg('URL atau anon key Supabase di config.js belum benar.', true); return; }
  if (recorder) { setMsg('Hentikan rekaman dulu sebelum mengirim.', true); return; }
  const teksEl = $('teks');
  const teks = teksEl ? teksEl.value.trim() : '';
  if (!teks && !photoBlob && !audioBlob) {
    setMsg('Isi minimal satu: foto, suara, atau tulisan.', true);
    return;
  }
  const btn = $('submitBtn');
  if (btn) btn.disabled = true;
  setMsg('Mengirim. Jangan tutup halaman ini.');
  try {
    const id = uid();
    let foto_url = null, audio_url = null;
    if (photoBlob) foto_url = await uploadFile(id + '/foto.' + photoExt, photoBlob, photoBlob.type || 'image/jpeg');
    if (audioBlob) audio_url = await uploadFile(id + '/suara.' + audioExt, audioBlob, audioType || 'audio/mp4');
    const { error } = await sb.from('entries').insert({ teks: teks || null, foto_url, audio_url });
    if (error) throw error;
    if ($('formView'))$('formView').classList.add('hidden');
    if ($('doneView'))$('doneView').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    setMsg('Gagal mengirim: ' + (err.message || 'periksa koneksi internet') + '. Coba kirim lagi.', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- Inisialisasi Event Listeners ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Event listener modal permission
  const modalBtn = $('grantPermissionBtn');
  if (modalBtn) {
    modalBtn.addEventListener('click', requestInitialPermissions);
  }

  // Foto listeners
  const pi = $('photoInput'); if (pi) pi.addEventListener('change', handlePhoto);
  const pgi = $('photoGalleryInput'); if (pgi) pgi.addEventListener('change', handlePhoto);
  const pgb = $('photoGalleryBtn'); if (pgb) pgb.addEventListener('click', () => { if (pgi) pgi.click(); });
  const pr = $('photoRemove'); if (pr) pr.addEventListener('click', () => { photoBlob = null; showPhoto(); });
  const pb = $('photoBtn'); if (pb) pb.addEventListener('click', openCamera);
  const pnb = $('photoNativeBtn'); if (pnb) pnb.addEventListener('click', () => { setPhotoMsg(''); if (pi) pi.click(); });
  const cs = $('camShot'); if (cs) cs.addEventListener('click', snapPhoto);
  const cc = $('camCancel'); if (cc) cc.addEventListener('click', closeCamera);

  // Audio listeners
  const rs = $('recStart'); if (rs) rs.addEventListener('click', startRec);
  const rst = $('recStop'); if (rst) rst.addEventListener('click', stopRec);
  const ra = $('recAgain'); if (ra) ra.addEventListener('click', () => { clearAudio(); startRec(); });
  const rm = $('recRemove'); if (rm) rm.addEventListener('click', clearAudio);
  const afb = $('audioFallbackBtn');
  const ai = $('audioInput');
  if (afb && ai) afb.addEventListener('click', () => ai.click());
  if (ai) {
    ai.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      audioBlob = file;
      audioType = (file.type || 'audio/mp4').split(';')[0];
      audioExt = extFromType(audioType, file.name);
      showAudioState();
      e.target.value = '';
    });
  }

  // Teks counter
  const teksEl = $('teks');
  if (teksEl) {
    teksEl.addEventListener('input', () => {
      const countEl = $('count');
      if (countEl) countEl.textContent = teksEl.value.length;
    });
  }

  // Submit & Reset
  const sbBtn = $('submitBtn'); if (sbBtn) sbBtn.addEventListener('click', submit);
  const agBtn = $('againBtn'); 
  if (agBtn) {
    agBtn.addEventListener('click', () => {
      photoBlob = null; audioBlob = null;
      setPhotoMsg('');
      if (teksEl) teksEl.value = '';
      if ($('count'))$('count').textContent = '0';
      setMsg('');
      showPhoto(); showAudioState();
      if ($('doneView'))$('doneView').classList.add('hidden');
      if ($('formView'))$('formView').classList.remove('hidden');
      window.scrollTo(0, 0);
    });
  }

  if (!canRecord) {
    const hint = $('audioHint');
    if (hint) hint.textContent = 'Rekam cerita singkat atau pilih file audio.';
  }
  showAudioState();
});