const BUCKET = 'media';
const MAX_REC_SECONDS = 60;
const MAX_IMG_PX = 1600;

const $ = (id) => document.getElementById(id);

// Validasi config + buat klien Supabase (tidak boleh membuat script berhenti)
let sb = null;
const configured =
  /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 100;
if (configured) {
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Gagal membuat klien Supabase:', e);
  }
}
if (!sb) $('configWarn').classList.remove('hidden');

let photoBlob = null, photoExt = 'jpg';
let audioBlob = null, audioType = '', audioExt = 'm4a';
let photoUrl = null;

function setMsg(text, isError) {
  const el = $('msg');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------------- Foto ---------------- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMG_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal memproses foto'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak bisa dibaca')); };
    img.src = url;
  });
}

function showPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = photoBlob ? URL.createObjectURL(photoBlob) : null;
  $('photoPreview').src = photoUrl || '';
  $('photoFrame').classList.toggle('has-img', !!photoBlob);
  $('photoRemove').classList.toggle('hidden', !photoBlob);
  $('photoBtn').textContent = photoBlob ? 'Ambil ulang' : 'Ambil foto';
}

async function handlePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  setMsg('');
  try {
    photoBlob = await compressImage(file);
    photoExt = 'jpg';
  } catch (err) {
    // Bila kompres gagal (misalnya format HEIC), kirim file aslinya
    photoBlob = file;
    photoExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
  }
  showPhoto();
  e.target.value = '';
}

$('photoInput').addEventListener('change', handlePhoto);
$('photoGalleryInput').addEventListener('change', handlePhoto);
$('photoBtn').addEventListener('click', () => $('photoInput').click());
$('photoGalleryBtn').addEventListener('click', () => $('photoGalleryInput').click());
$('photoRemove').addEventListener('click', () => { photoBlob = null; showPhoto(); });

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
    $('recIdle').classList.toggle('hidden', has || !!recorder);
    $('recActive').classList.toggle('hidden', !recorder);
    $('recDone').classList.toggle('hidden', !has);
    $('recFallback').classList.add('hidden');
  } else {
    $('recIdle').classList.add('hidden');
    $('recActive').classList.add('hidden');
    $('recDone').classList.toggle('hidden', !has);
    $('recFallback').classList.toggle('hidden', has);
  }
  if (audioObjUrl) { URL.revokeObjectURL(audioObjUrl); audioObjUrl = null; }
  if (has) {
    audioObjUrl = URL.createObjectURL(audioBlob);
    $('audioPreview').src = audioObjUrl;
  } else {
    $('audioPreview').removeAttribute('src');
  }
}

async function startRec() {
  setMsg('');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setMsg('Mikrofon tidak bisa dipakai. Izinkan akses mikrofon di pengaturan browser, lalu coba lagi.', true);
    return;
  }
  const mime = pickMime();
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || mime || 'audio/mp4';
    audioBlob = new Blob(chunks, { type });
    audioType = type.split(';')[0];
    audioExt = extFromType(audioType);
    recorder = null;
    showAudioState();
  };
  recorder.start();
  startedAt = Date.now();
  $('recTime').textContent = '0:00';
  timer = setInterval(() => {
    const sec = (Date.now() - startedAt) / 1000;
    $('recTime').textContent = fmt(sec);
    if (sec >= MAX_REC_SECONDS) stopRec();
  }, 250);
  showAudioState();
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function clearAudio() { audioBlob = null; showAudioState(); }

$('recStart').addEventListener('click', startRec);
$('recStop').addEventListener('click', stopRec);
$('recAgain').addEventListener('click', () => { clearAudio(); startRec(); });
$('recRemove').addEventListener('click', clearAudio);

// Cadangan: pilih/rekam file audio lewat aplikasi bawaan HP
$('audioFallbackBtn').addEventListener('click', () => $('audioInput').click());
$('audioInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  audioBlob = file;
  audioType = (file.type || 'audio/mp4').split(';')[0];
  audioExt = extFromType(audioType, file.name);
  showAudioState();
  e.target.value = '';
});

if (!canRecord) {
  $('audioHint').textContent = 'Rekam cerita singkat atau pilih file audio.';
}
showAudioState();

/* ---------------- Teks ---------------- */
$('teks').addEventListener('input', () => { $('count').textContent = $('teks').value.length; });

/* ---------------- Kirim ---------------- */
async function uploadFile(path, blob, contentType) {
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType, cacheControl: '3600', upsert: false
  });
  if (error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function submit() {
  if (!sb) { setMsg('URL atau anon key Supabase di config.js belum benar.', true); return; }
  if (recorder) { setMsg('Hentikan rekaman dulu sebelum mengirim.', true); return; }
  const teks = $('teks').value.trim();
  if (!teks && !photoBlob && !audioBlob) {
    setMsg('Isi minimal satu: foto, suara, atau tulisan.', true);
    return;
  }
  const btn = $('submitBtn');
  btn.disabled = true;
  setMsg('Mengirim. Jangan tutup halaman ini.');
  try {
    const id = uid();
    let foto_url = null, audio_url = null;
    if (photoBlob) foto_url = await uploadFile(id + '/foto.' + photoExt, photoBlob, photoBlob.type || 'image/jpeg');
    if (audioBlob) audio_url = await uploadFile(id + '/suara.' + audioExt, audioBlob, audioType || 'audio/mp4');
    const { error } = await sb.from('entries').insert({ teks: teks || null, foto_url, audio_url });
    if (error) throw error;
    $('formView').classList.add('hidden');
    $('doneView').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    setMsg('Gagal mengirim: ' + (err.message || 'periksa koneksi internet') + '. Coba kirim lagi.', true);
  } finally {
    btn.disabled = false;
  }
}

$('submitBtn').addEventListener('click', submit);

$('againBtn').addEventListener('click', () => {
  photoBlob = null; audioBlob = null;
  $('teks').value = ''; $('count').textContent = '0';
  setMsg('');
  showPhoto(); showAudioState();
  $('doneView').classList.add('hidden');
  $('formView').classList.remove('hidden');
  window.scrollTo(0, 0);
});