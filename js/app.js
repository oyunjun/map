/* ============================================================
 * 我们的爱情旅行地图 · 主逻辑（云端版）
 * 认证：密码登录 + 手机验证码登录/注册（新用户验证后设密码）
 * 资料：profiles 表（用户名 / 头像 / 地图公开开关）
 * 数据：云数据库 memories 表（本人可读写；开启分享后他人只读）
 * 照片：云存储 shared/<uid>/photos/（本人可写，登录用户可读）
 * ============================================================ */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function nl2br(s) { return esc(s).replace(/\r?\n/g, '<br>'); }

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function fmtDate(d) {
  if (!d) return '';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function maskPhone(p) {
  const s = String(p || '');
  return s.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') || '用户';
}

/* ---------------- 云客户端（初始化一次，全模块共用） ---------------- */
const cfg = window.PUBLIC_CONFIG || {};
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: cfg.endpoint,
  oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
  publishableKey: cfg.publishableKey,
});

/* 腾讯地图与数据库统一使用 GCJ-02 坐标，无需任何转换 */

/* ---------------- 状态 ---------------- */
const state = {
  user: null,
  profile: null,      // 自己的 profiles 行
  viewer: null,       // 浏览他人地图时的对方 uid（null = 自己的地图）
  memories: [],
  selectedId: null,
  editMode: false,
  editingId: null,
  form: null,
  pickMode: false,
  search: '',
  filter: { mood: null, weather: null },
  map: null,
  markerLayer: null,
  pickerLayer: null,
  routeLayer: null,
  routeOn: false,
  mapReady: false,
  urlCache: {},
  profileExtra: { bio: '', anniversary: '', avatarEmoji: '' }, // 个性签名 / 纪念日 / 表情头像（存云存储 JSON）
  albums: [],          // 我拥有或参与的相册
  albumId: null,       // 当前相册
  albumRole: null,     // 我在当前相册的角色：owner / editor / viewer
  draftEmoji: '',
  yearView: null       // 年度回顾当前查看的年份
};

const ALBUM_KINDS = [
  { id: 'couple',   label: '与 Ta 一起', emoji: '💞' },
  { id: 'personal', label: '个人',       emoji: '🧭' },
  { id: 'travel',   label: '旅行',       emoji: '✈️' },
  { id: 'campus',   label: '校园',       emoji: '🏫' },
  { id: 'family',   label: '家庭',       emoji: '👨‍👩‍👧' },
  { id: 'friends',  label: '朋友',       emoji: '🤝' },
  { id: 'anniv',    label: '纪念日',     emoji: '🎂' }
];
function kindOf(k) { return ALBUM_KINDS.find(x => x.id === k) || { id: k || 'personal', label: k || '相册', emoji: '🗺️' }; }

const AVATAR_EMOJIS = ['❤', '🌟', '🌈', '🐱', '🐰', '🌸', '🍰', '🎀', '🦄', '☀️', '🌙', '🍓'];

/* ---------------- 标记图标（内联 SVG） ---------------- */
function svgUri(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

const HEART_DEFAULT = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="32" height="40"><path d="M16 29C7.5 22.5 2 17.2 2 11 2 6.6 5.4 3 9.8 3c2.6 0 5 1.4 6.2 3.8C17.2 4.4 19.6 3 22.2 3 26.6 3 30 6.6 30 11c0 6.2-5.5 11.5-14 18z" fill="#ff5a7a" stroke="#fff" stroke-width="2"/></svg>');
const HEART_ACTIVE = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="32" height="40"><path d="M16 29C7.5 22.5 2 17.2 2 11 2 6.6 5.4 3 9.8 3c2.6 0 5 1.4 6.2 3.8C17.2 4.4 19.6 3 22.2 3 26.6 3 30 6.6 30 11c0 6.2-5.5 11.5-14 18z" fill="#ff2d55" stroke="#f2a65a" stroke-width="2.5"/></svg>');
const PIN_ICON = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 36" width="32" height="36"><path d="M16 1.5C8.5 1.5 2.5 7.4 2.5 14.6 2.5 23 16 34.5 16 34.5S29.5 23 29.5 14.6C29.5 7.4 23.5 1.5 16 1.5z" fill="#e94f6d" stroke="#fff" stroke-width="2"/><circle cx="16" cy="14" r="5" fill="#fff"/></svg>');

/* ---------------- 腾讯地图标记样式（内联 SVG，不依赖外部图片） ---------------- */
function makeMarkerStyles() {
  return {
    default: new TMap.MarkerStyle({ width: 28, height: 35, anchor: { x: 14, y: 35 }, src: HEART_DEFAULT }),
    active: new TMap.MarkerStyle({ width: 36, height: 45, anchor: { x: 18, y: 45 }, src: HEART_ACTIVE })
  };
}
function makePickerLayer(geos) {
  return new TMap.MultiMarker({
    map: state.map,
    styles: { pin: new TMap.MarkerStyle({ width: 30, height: 34, anchor: { x: 15, y: 34 }, src: PIN_ICON }) },
    geometries: geos || []
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindUI();
  bindExtras();

  cloud.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showAuth();
  });

  window._mapReady
    .then(initMap)
    .catch(() => { $('#mapError').classList.remove('hidden'); });

  const { data: session, error } = await cloud.auth.getSession();
  if (error || !session || !session.user) {
    showAuth();
    return;
  }
  enterApp(session.user);
}

/* ============================================================
 * 认证：密码登录 + 验证码登录/注册
 * ============================================================ */
let pendingOtp = null;
let countdownTimer = null;

function showAuth() {
  state.user = null;
  state.profile = null;
  state.viewer = null;
  state.memories = [];
  state.albums = [];
  state.albumId = null;
  state.albumRole = null;
  stopPresence();
  pendingOtp = null;
  $('#pPwd').value = '';
  $('#sCode').value = '';
  $('#sPwd').value = '';
  setAuthMode('pwd');
  showAuthError('');
  $('#authOverlay').classList.remove('hidden');
  $('#userChip').classList.add('hidden');
  $('#filmstrip').classList.add('hidden');
  refreshMenuAuth();
  $('#migrateBar').classList.add('hidden');
  $('#visitorBar').classList.add('hidden');
  // 退出时清空地图图层与面板，避免上一个账号的隐私残留
  if (state.markerLayer) { try { state.markerLayer.setMap(null); } catch (e) { /* 静默 */ } state.markerLayer = null; }
  if (state.routeLayer) { try { state.routeLayer.setMap(null); } catch (e) { /* 静默 */ } state.routeLayer = null; }
  state.routeOn = false;
  state.selectedId = null;
  state.editMode = false;
  const rt = $('#routeToggle');
  if (rt) { rt.classList.add('hidden'); rt.classList.remove('on'); rt.setAttribute('aria-pressed', 'false'); }
  const panel = $('#panel');
  if (panel) panel.classList.add('hidden');
  const tl = $('#timelineView');
  if (tl) tl.classList.add('hidden');
  const otd = $('#otdModal');
  if (otd) otd.classList.add('hidden');
  const yr = $('#yearModal');
  if (yr) yr.classList.add('hidden');
  const dg = $('#dangerModal');
  if (dg) dg.classList.add('hidden');
  const pm = $('#profileModal');
  if (pm) pm.classList.add('hidden');
  state.yearView = null;
  dangerAction = null;
  renderStats();
  renderList();
  renderAnnivBar();
}

function setAuthMode(mode) {
  $('#tabPwd').classList.toggle('active', mode === 'pwd');
  $('#tabSms').classList.toggle('active', mode === 'sms');
  $('#pwdView').classList.toggle('hidden', mode !== 'pwd');
  $('#smsView').classList.toggle('hidden', mode !== 'sms');
  showAuthError('');
}

function showAuthError(msg) {
  const el = $('#authError');
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

/* 登录前必须勾选用户协议与隐私政策 */
function requireAgree() {
  const cb = $('#agreePolicy');
  if (!cb) return true;
  if (cb.checked) return true;
  showAuthError('请先阅读并勾选同意「用户协议」和「隐私政策」');
  const row = cb.closest('.agree-row');
  if (row) { row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake'); }
  return false;
}

function setCodeBtn(text, disabled) {
  const b = $('#aSendCode');
  b.textContent = text;
  b.disabled = !!disabled;
}

function startCountdown(sec) {
  clearInterval(countdownTimer);
  let left = sec;
  setCodeBtn(`重新发送(${left}s)`, true);
  countdownTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(countdownTimer); setCodeBtn('获取验证码', false); }
    else setCodeBtn(`重新发送(${left}s)`, true);
  }, 1000);
}

async function sendPhoneCode() {
  const phone = $('#sPhone').value.trim();
  if (!/^1\d{10}$/.test(phone)) { showAuthError('请输入正确的 11 位手机号'); return; }
  showAuthError('');
  setCodeBtn('发送中…', true);
  try {
    const sent = await cloud.auth.sendOtp({ phone });
    if (sent.error) {
      setCodeBtn('获取验证码', false);
      showAuthError(sent.error.message || '验证码发送失败');
      return;
    }
    pendingOtp = {
      phone,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser
    };
    startCountdown(60);
    toast(pendingOtp.isExistingUser ? '验证码已发送，请查看短信' : '新手机号，验证后将创建账号');
  } catch (e) {
    setCodeBtn('获取验证码', false);
    showAuthError('网络异常，请稍后重试');
  }
}

/* ---------- 底层认证 API（SDK 的 verifyOtp 会忽略老用户的密码，补设密码需直连） ---------- */
async function rawAuth(path, body) {
  const ep = ((window.PUBLIC_CONFIG && window.PUBLIC_CONFIG.endpoint) || location.origin).replace(/\/+$/, '');
  const key = (window.PUBLIC_CONFIG && window.PUBLIC_CONFIG.publishableKey) || '';
  try {
    const r = await fetch(ep + '/.cloud/auth' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wb-webapp-access-key': key },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: data || {} };
  } catch (e) {
    return { ok: false, status: 0, data: {} };
  }
}

/* 与 SDK normalizePhone 一致：大陆 11 位手机号 → "+86 xxx" */
function normPhoneUser(t) {
  t = String(t || '').trim().replace(/^\+86\s*/, '').replace(/^86(?=1\d{10}$)/, '');
  return /^1\d{10}$/.test(t) ? ('+86 ' + t) : t;
}

function extractVerificationToken(d) {
  if (!d) return '';
  if (typeof d.verification_token === 'string') return d.verification_token;
  if (d.data && typeof d.data.verification_token === 'string') return d.data.verification_token;
  return '';
}

/* 验证码登录 / 注册：新用户注册即设密码；老账号填写密码时自动补设 */
async function submitSms() {
  const phone = $('#sPhone').value.trim();
  const code = $('#sCode').value.trim();
  const pwd = $('#sPwd').value;
  if (!requireAgree()) return;
  if (!/^1\d{10}$/.test(phone)) { showAuthError('请输入正确的 11 位手机号'); return; }
  if (!pendingOtp || pendingOtp.phone !== phone) { showAuthError('请先获取验证码'); return; }
  if (!code) { showAuthError('请输入验证码'); return; }
  if (!pendingOtp.isExistingUser && pwd.length < 6) { showAuthError('新用户请设置至少 6 位的密码，之后可用密码登录'); return; }
  showAuthError('');
  const btn = $('#smsSubmit');
  btn.disabled = true; btn.textContent = '验证中…';
  try {
    /* 老账号 + 填了密码 → 走底层 API 补设密码 */
    if (pendingOtp.isExistingUser && pwd.length >= 6) {
      const v = await rawAuth('/v1/verification/verify', {
        verification_id: pendingOtp.verificationId,
        verification_code: code
      });
      const vToken = extractVerificationToken(v.data);
      if (!v.ok || !vToken) {
        showAuthError((v.data && (v.data.error_description || v.data.error)) || '验证码校验失败，请重新获取');
        return;
      }
      const up = await rawAuth('/v1/signup', {
        phone_number: normPhoneUser(phone),
        password: pwd,
        verification_token: vToken
      });
      if (up.ok) {
        // 密码已设置 → 用密码登录建立正式会话
        const { data: session, error } = await cloud.auth.signInWithPassword({ phone, password: pwd });
        if (!error && session && session.user) {
          pendingOtp = null;
          $('#sPwd').value = '';
          enterApp(session.user);
          toast('密码已设置 ✅ 下次可直接用密码登录');
        } else {
          showAuthError('密码已设置，但自动登录失败，请切换到「密码登录」再试一次');
        }
        return;
      }
      // 补设失败（服务端拒绝）→ 回退普通验证码登录，并如实告知
      const done = await cloud.auth.verifyOtp({
        phone: pendingOtp.phone,
        verificationId: pendingOtp.verificationId,
        isExistingUser: true,
        token: code
      });
      if (!done.error) {
        pendingOtp = null;
        $('#sPwd').value = '';
        enterApp(done.data && done.data.user ? done.data.user : { phone });
        toast('已登录。该账号暂不支持自动补设密码，请继续用验证码登录');
      } else {
        showAuthError('验证码已被使用，请重新获取验证码后再登录（密码可留空）');
      }
      return;
    }
    /* 常规路径：新用户注册（带密码）/ 老用户验证码登录（不带密码） */
    const done = await cloud.auth.verifyOtp({
      phone: pendingOtp.phone,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token: code,
      password: pendingOtp.isExistingUser ? undefined : pwd
    });
    if (done.error) {
      showAuthError(done.error.message || '验证失败，请重试');
      return;
    }
    pendingOtp = null;
    $('#sPwd').value = '';
    enterApp(done.data && done.data.user ? done.data.user : { phone });
    if (pwd.length >= 6) toast('账号已创建 ✅ 下次可用密码登录');
  } catch (e) {
    showAuthError('网络异常，请稍后重试');
  } finally {
    btn.disabled = false; btn.textContent = '登录 / 注册';
  }
}

/* 密码登录 */
async function submitPwd() {
  const phone = $('#pPhone').value.trim();
  const pwd = $('#pPwd').value;
  if (!requireAgree()) return;
  if (!/^1\d{10}$/.test(phone)) { showAuthError('请输入正确的 11 位手机号'); return; }
  if (!pwd) { showAuthError('请输入密码'); return; }
  showAuthError('');
  const btn = $('#pwdSubmit');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const { data: session, error } = await cloud.auth.signInWithPassword({ phone, password: pwd });
    if (error || !session || !session.user) {
      const msg = (error && error.message) || '';
      if (/not\s*set/i.test(msg)) {
        // 老账号（密码功能上线前注册）没有密码记录 → 引导用验证码登录补设
        const el = $('#authError');
        el.innerHTML = '这个手机号还没有设置过密码，暂时请用「验证码登录」进入。' +
          '<a href="javascript:void(0)" id="goSms" style="color:#b93350;font-weight:600;text-decoration:underline">改用验证码登录 →</a>';
        el.classList.remove('hidden');
        const go = document.getElementById('goSms');
        if (go) go.addEventListener('click', () => {
          setAuthMode('sms');
          $('#sPhone').value = phone;
          $('#sPwd').value = '';
          $('#sPwd').focus();
        });
      } else {
        showAuthError(msg || '手机号或密码不正确');
      }
      return;
    }
    $('#pPwd').value = '';
    enterApp(session.user);
  } catch (e) {
    showAuthError('网络异常，请稍后重试');
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
}

async function doLogout() {
  try { await cloud.auth.signOut(); } catch (e) { /* 忽略 */ }
  showAuth();
}

function enterApp(user) {
  state.user = user || {};
  $('#authOverlay').classList.add('hidden');
  $('#userChip').classList.remove('hidden');
  initAccount().catch(e => console.error('初始化账号失败', e));
}

/* 登录后：加载/创建个人资料，然后决定是自己地图还是访客视图 */
async function initAccount() {
  try { await ensureProfile(); } catch (e) { /* 资料加载失败不阻断主流程 */ }
  try { await loadProfileExtra(); } catch (e) { /* 扩展资料缺失不阻断 */ }
  await renderUserChip();
  renderAnnivBar();

  // 加载我拥有或参与的相册
  try { await loadAlbums(); } catch (e) { console.error('加载相册失败', e); }
  try { await checkPendingInvites(); } catch (e) { /* 邀请通知忽略 */ }

  const params = new URLSearchParams(location.search);
  const albumCode = params.get('album');
  const mapUid = params.get('map');
  if (albumCode) { await enterAlbumViewer(albumCode); return; }
  if (mapUid && mapUid !== state.user.id) { await enterLegacyViewer(mapUid); return; }

  state.viewer = null;
  $('#visitorBar').classList.add('hidden');
  applyEditorVisibility(true);
  try {
    await ensureCurrentAlbum();   // 选好当前相册（必要时建默认）
    await loadMemories();
  } catch (e) {
    console.error('初始化相册失败', e);
    toast('相册加载失败，请刷新重试', true);
  }
}

/* ============================================================
 * 个人资料：用户名 / 头像 / 密码 / 地图分享开关
 * ============================================================ */
async function ensureProfile() {
  const uid = state.user.id;
  const q = await cloud.database.from('profiles').select('*').eq('id', uid);
  if (q.error) throw q.error;
  let row;
  if (q.data && q.data[0]) { row = q.data[0]; }
  else {
    const ins = await cloud.database.from('profiles').insert({ id: uid }).select();
    if (ins.error) {
      // 并发首次登录可能撞主键，重查一次即可
      const again = await cloud.database.from('profiles').select('*').eq('id', uid);
      if (again.error) throw again.error;
      if (again.data && again.data[0]) { row = again.data[0]; }
      else throw new Error('创建个人资料失败');
    } else { row = ins.data[0]; }
  }
  state.profile = row;
  // 同步手机号，便于按手机号邀请协作
  const phone = normPhone(state.user.phone);
  if (phone && row.phone !== phone) {
    try {
      await cloud.database.from('profiles').update({ phone }).eq('id', uid);
      state.profile.phone = phone;
    } catch (e) { /* 忽略 */ }
  }
  return state.profile;
}

async function renderUserChip() {
  const p = state.profile || {};
  const ex = state.profileExtra || {};
  const name = p.username || maskPhone(state.user.phone || state.user.email || '');
  $('#userName').textContent = name;
  const img = $('#userAvatar'), fb = $('#userAvatarFb');
  if (ex.avatarEmoji) {
    img.classList.add('hidden'); fb.classList.remove('hidden'); fb.textContent = ex.avatarEmoji;
    return;
  }
  if (p.avatar_path) {
    try { await ensureSignedUrls([p.avatar_path]); } catch (e) { /* 忽略 */ }
    const u = urlOf(p.avatar_path);
    if (u) { img.src = u; img.classList.remove('hidden'); fb.classList.add('hidden'); return; }
  }
  img.classList.add('hidden');
  fb.classList.remove('hidden');
  fb.textContent = (name || '❤').slice(0, 1);
}

function myMapUrl() {
  return myAlbumUrl();
}

function openProfile() {
  if (!state.user || state.viewer) return;
  fillProfileModal();
  $('#profileModal').classList.remove('hidden');
  if (state.profile && state.profile.avatar_path) {
    ensureSignedUrls([state.profile.avatar_path])
      .then(fillProfileModal)
      .catch(() => {});
  }
}

/* ============================================================
 * 侧边菜单抽屉
 * ============================================================ */
function openAppMenu() {
  $('#appMenu').classList.add('open');
  $('#appMenu').setAttribute('aria-hidden', 'false');
  $('#menuBackdrop').classList.remove('hidden');
  refreshMenuAuth();
}
function closeAppMenu() {
  $('#appMenu').classList.remove('open');
  $('#appMenu').setAttribute('aria-hidden', 'true');
  $('#menuBackdrop').classList.add('hidden');
}
function refreshMenuAuth() {
  const logged = !!state.user && !state.viewer;
  const hasData = (state.memories || []).length > 0;
  document.querySelectorAll('#menuList .menu-item').forEach(it => {
    let hide = false;
    if (it.classList.contains('mi-auth') && !logged) hide = true;
    if (it.classList.contains('mi-data') && !hasData) hide = true;
    it.classList.toggle('hidden', hide);
  });
  const foot = $('#menuFoot');
  if (logged) {
    const name = (state.profile && state.profile.username) || maskPhone(state.user.phone || state.user.email || '');
    const album = state.albums.find(a => a.id === state.albumId);
    const albumTx = album ? ' · 当前：<b>' + esc(album.name) + '</b>' : '';
    foot.innerHTML = '已登录：<b>' + esc(name) + '</b>' + albumTx;
  } else if (state.viewer) {
    foot.innerHTML = '正在浏览 <b>' + esc((state.profile && state.profile.username) || 'TA') + '</b> 的地图';
  } else {
    foot.innerHTML = '游客模式 · 登录后开启全部功能';
  }
}
function menuAct(act) {
  closeAppMenu();
  switch (act) {
    case 'profile': openProfile(); break;
    case 'badges': openBadges(); break;
    case 'passport': openPassport(); break;
    case 'postcards': openPostcards(); break;
    case 'year': openYearReview(); break;
    case 'list': document.body.classList.toggle('sidebar-open'); break;
    case 'timeline': openTimeline(); break;
    case 'share': openShare(); break;
    case 'export': exportData(); break;
    case 'new-album': openNewAlbum(); break;
    case 'manage-album': openAlbumModal(); break;
    case 'help': $('#helpModal').classList.remove('hidden'); break;
    case 'logout': doLogout(); break;
  }
}

/* ============================================================
 * 我的明信片画廊
 * ============================================================ */
function openPostcards() {
  renderPostcardsGrid();
  $('#postcardsModal').classList.remove('hidden');
}
function renderPostcardsGrid() {
  const grid = $('#pcGrid');
  if (!grid) return;
  const list = (state.memories || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (!list.length) { grid.innerHTML = '<div class="pc-empty">还没有回忆，先在地图上留下第一段故事吧</div>'; return; }
  grid.innerHTML = '';
  list.forEach(m => {
    const first = (m.photos && m.photos[0]) ? (m.photos[0].thumb || m.photos[0].path) : null;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pc-item';
    const img = first ? `<img src="${esc(urlOf(first)) || ''}" alt="${esc(m.name)}" onerror="this.style.visibility='hidden'">` : '<div style="height:120px;background:var(--cream);border-bottom:var(--line)"></div>';
    item.innerHTML = img + `<div class="pc-cap"><div class="pc-t">${esc(m.name)}</div><div class="pc-d">${esc(m.date || '')}</div></div>`;
    item.addEventListener('click', () => { $('#postcardsModal').classList.add('hidden'); openPostcard(m.id); });
    grid.appendChild(item);
  });
  try { ensureSignedUrls(allPhotoPaths(state.memories)); } catch (e) {}
}


function fillProfileModal() {
  const p = state.profile || {};
  const ex = state.profileExtra || {};
  $('#profName').value = p.username || '';
  $('#profBio').value = ex.bio || '';
  $('#profAnniversary').value = ex.anniversary || '';
  const img = $('#profAvatar'), fb = $('#profAvatarFb');
  const u = (p.avatar_path && !ex.avatarEmoji) ? urlOf(p.avatar_path) : '';
  if (u) { img.src = u; img.classList.remove('hidden'); fb.classList.add('hidden'); }
  else {
    img.classList.add('hidden'); fb.classList.remove('hidden');
    fb.textContent = ex.avatarEmoji || (p.username || '❤').slice(0, 1);
  }
  state.draftEmoji = ex.avatarEmoji || '';
  buildEmojiPicker();
  updateAnnivDays();
  renderProfStats();
}

function renderProfStats() {
  const ms = state.memories || [];
  const n = ms.length;
  let pc = 0, sc = 0;
  const cities = new Set();
  ms.forEach(m => {
    pc += (m.photos || []).length;
    sc += (m.stickies || []).length;
    if (m.city) cities.add(m.city);
  });
  const boxes = [[n, '回忆'], [cities.size, '城市'], [pc, '照片'], [sc, '便签']];
  const box = $('#profStats');
  if (box) box.innerHTML = boxes.map(([v, l]) =>
    `<div class="prof-stat"><div class="n">${v}</div><div class="l">${l}</div></div>`).join('');
}

function buildEmojiPicker() {
  const box = $('#profEmoji');
  if (!box) return;
  box.innerHTML = '';
  AVATAR_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    if (em === state.draftEmoji) b.classList.add('sel');
    b.addEventListener('click', () => {
      state.draftEmoji = (state.draftEmoji === em) ? '' : em;
      buildEmojiPicker();
      const fb = $('#profAvatarFb'), img = $('#profAvatar');
      if (state.draftEmoji) {
        img.classList.add('hidden'); fb.classList.remove('hidden'); fb.textContent = state.draftEmoji;
      } else if (state.profile && state.profile.avatar_path) {
        img.classList.remove('hidden'); fb.classList.add('hidden');
      } else {
        fb.textContent = ((state.profile && state.profile.username) || '❤').slice(0, 1);
      }
    });
    box.appendChild(b);
  });
}

function updateAnnivDays() {
  const el = $('#profAnnivDays');
  const v = $('#profAnniversary').value;
  if (!el) return;
  if (!v) { el.textContent = ''; return; }
  const a = new Date(v + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - a) / 86400000);
  el.textContent = diff >= 0
    ? '❤ 我们已经在一起 ' + diff + ' 天啦'
    : '⏳ 还有 ' + (-diff) + ' 天就到纪念日';
}

/* 顶栏纪念日倒计时：登录后常驻展示「在一起 N 天 / 距纪念日 N 天」 */
function renderAnnivBar() {
  const bar = $('#annivBar');
  if (!bar) return;
  const v = (state.profileExtra && state.profileExtra.anniversary) || '';
  if (!state.user || state.viewer || !v) { bar.classList.add('hidden'); return; }
  const a = new Date(v + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - a) / 86400000);
  if (diff === 0) bar.innerHTML = '🎉 今天就是纪念日 <b>!</b>';
  else if (diff > 0) bar.innerHTML = '❤ 在一起 <b>' + diff + '</b> 天';
  else bar.innerHTML = '⏳ 距纪念日 <b>' + (-diff) + '</b> 天';
  bar.classList.remove('hidden');
}

async function loadProfileExtra() {
  if (!state.user) return;
  const path = cloud.storage.sharedPath(state.user.id, 'profile_extra.json');
  try {
    await ensureSignedUrls([path]);
    const url = urlOf(path);
    if (!url) return;
    const res = await fetch(url);
    if (!res.ok) return;
    const obj = await res.json();
    if (obj && typeof obj === 'object') {
      state.profileExtra = {
        bio: obj.bio || '',
        anniversary: obj.anniversary || '',
        avatarEmoji: obj.avatarEmoji || ''
      };
    }
  } catch (e) { /* 无扩展资料 */ }
}

async function saveProfileExtra() {
  if (!state.user) return;
  const path = cloud.storage.sharedPath(state.user.id, 'profile_extra.json');
  const blob = new Blob([JSON.stringify(state.profileExtra)], { type: 'application/json' });
  await uploadBlob(path, blob, 'application/json', '资料保存', 'profile_extra.json');
}

async function saveProfile() {
  if (!state.user) return;
  const errEl = $('#profError');
  const show = m => {
    if (m) { errEl.textContent = m; errEl.classList.remove('hidden'); }
    else errEl.classList.add('hidden');
  };
  show('');
  const btn = $('#profSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const newName = $('#profName').value.trim();
    if (newName && newName.length < 2) throw new Error('用户名至少 2 个字符');

    const newPwd = $('#profNewPwd').value;
    if (newPwd) {
      if (newPwd.length < 6) throw new Error('新密码至少 6 位');
      if (newPwd !== $('#profNewPwd2').value) throw new Error('两次输入的新密码不一致');
      const r = await cloud.auth.resetPasswordForOld({
        oldPassword: $('#profOldPwd').value,
        newPassword: newPwd
      });
      if (r.error) {
        const m = (r.error.message || '');
        throw new Error(/not\s*set/i.test(m)
          ? '这个账号还没设置过密码：请退出后在「验证码登录」页登录并填一个新密码，即可自动补设'
          : (m || '密码修改失败，请检查当前密码是否正确'));
      }
      $('#profOldPwd').value = '';
      $('#profNewPwd').value = '';
      $('#profNewPwd2').value = '';
    }

    const patch = {
      username: newName || null,
      updated_at: new Date().toISOString()
    };
    const { data, error } = await cloud.database.from('profiles')
      .update(patch).eq('id', state.user.id).select();
    if (error) {
      const msg = error.message || '';
      throw new Error(/duplicate|unique/i.test(msg) ? '这个用户名已被占用，换一个吧' : (msg || '保存失败'));
    }
    if (data && data[0]) state.profile = data[0];

    state.profileExtra = {
      bio: $('#profBio').value.trim(),
      anniversary: $('#profAnniversary').value || '',
      avatarEmoji: state.draftEmoji || ''
    };
    try { await saveProfileExtra(); } catch (e) { console.warn('扩展资料保存失败', e); }

    await renderUserChip();
    fillProfileModal();
    renderAnnivBar();
    toast('资料已保存 ✅');
  } catch (e) {
    show(e.message || '保存失败，请重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存资料';
  }
}

async function changeAvatar(file) {
  if (!file || !state.user) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('请选择 JPG / PNG / WebP 图片', true); return; }
  if (file.size > 20 * 1024 * 1024) { toast('图片太大（超过 20MB）', true); return; }
  const btn = $('#profAvatarBtn');
  btn.disabled = true; btn.textContent = '处理中…';
  try {
    const blob = await shrinkImage(file, 256, 0.85);
    const path = cloud.storage.sharedPath(state.user.id, 'avatar_' + Date.now().toString(36) + '.jpg');
    await uploadBlob(path, blob, 'image/jpeg', '头像上传', 'avatar.jpg');
    const old = state.profile && state.profile.avatar_path;
    const { data, error } = await cloud.database.from('profiles')
      .update({ avatar_path: path, updated_at: new Date().toISOString() })
      .eq('id', state.user.id).select();
    if (error) throw new Error(error.message || '头像保存失败');
    if (data && data[0]) state.profile = data[0];
    if (state.profileExtra.avatarEmoji) { state.profileExtra.avatarEmoji = ''; try { await saveProfileExtra(); } catch (e) {} }
    if (old && old !== path) removeStorageObjects([old]);
    await renderUserChip();
    fillProfileModal();
    toast('头像已更新 ✨');
  } catch (e) {
    toast(e.message || '头像更新失败', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '更换头像';
  }
}

/* ============================================================
 * 访客视图：浏览他人公开的地图（只读）
 * ============================================================ */
/* 添加按钮只在「浏览自己地图 + 编辑模式开启」时显示 */
function updateAddVisibility() {
  const show = !!state.user && !state.viewer && state.editMode;
  $('#btnAdd').classList.toggle('hidden', !show);
  $('#emptyAdd').classList.toggle('hidden', !show);
  $('#emptyHint').textContent = state.editMode
    ? '点「＋ 添加回忆」，在地图上标下你们的第一站吧'
    : '当前为浏览模式：打开右上角「编辑模式」，即可添加新的回忆';
}

function applyEditorVisibility(editable) {
  document.querySelector('.edit-toggle').classList.toggle('hidden', !editable);
  $('#migrateBar').classList.add('hidden');
  if (!editable) {
    state.editMode = false;
    $('#editToggle').checked = false;
    document.body.classList.remove('edit-mode');
  }
  updateAddVisibility();
}

async function enterAlbumViewer(code) {
  try {
    const { data, error } = await cloud.database.from('albums')
      .select('*').eq('share_code', code).eq('is_public', true).limit(1);
    if (error || !data || !data[0]) {
      toast('分享链接无效或对方已关闭公开', true);
      goOwnMap();
      return;
    }
    const album = data[0];
    state.viewer = true;
    state.albumId = album.id;
    state.albumRole = 'viewer';
    applyEditorVisibility(false);
    $('#visitorName').textContent = album.name || 'TA 的地图';
    $('#visitorBar').classList.remove('hidden');
    document.title = (album.name || 'TA') + ' 的地图';
    await loadMemories();
  } catch (e) {
    toast('加载分享地图失败：' + (e.message || '请稍后重试'), true);
    goOwnMap();
  }
}

async function enterLegacyViewer(uid) {
  try {
    const { data, error } = await cloud.database.from('albums')
      .select('*').eq('owner_id', uid).eq('is_public', true).limit(1);
    if (error || !data || !data[0]) {
      toast('TA 还没有开放地图', true);
      goOwnMap();
      return;
    }
    await enterAlbumViewer(data[0].share_code || '');
    if (!data[0].share_code) goOwnMap();
  } catch (e) {
    toast('加载分享地图失败', true);
    goOwnMap();
  }
}

function goOwnMap() {
  location.href = appBaseUrl();
}

/* ============================================================
 * 相册：多地图集 + 多人协作
 * ============================================================ */
function normPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  return d.slice(-11); // 统一取后 11 位
}
function genShareCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

async function loadAlbums() {
  const { data, error } = await cloud.database.from('albums').select('*');
  if (error) throw error;
  const albums = data || [];
  const { data: mem } = await cloud.database.from('album_members')
    .select('album_id, role').eq('user_id', state.user.id);
  const roleMap = {};
  (mem || []).forEach(m => { roleMap[m.album_id] = m.role; });
  albums.forEach(a => { a.role = roleMap[a.id] || (a.owner_id === state.user.id ? 'owner' : 'viewer'); });
  state.albums = albums;
}

async function ensureCurrentAlbum() {
  let album = null;
  const saved = localStorage.getItem('ltm_album_' + state.user.id);
  if (saved) album = state.albums.find(a => a.id === saved);
  if (!album) album = state.albums.find(a => a.role === 'owner') || state.albums[0];
  if (!album) album = await createAlbum('我的地图', 'personal');
  await setCurrentAlbum(album.id);
}

async function setCurrentAlbum(id) {
  state.albumId = id;
  const a = state.albums.find(x => x.id === id);
  state.albumRole = a ? a.role : null;
  if (state.user) localStorage.setItem('ltm_album_' + state.user.id, id);
  refreshAlbumUI();
  startPresence();
}

async function createAlbum(name, kind) {
  const { data, error } = await cloud.database.from('albums')
    .insert({ owner_id: state.user.id, name: name || '我的地图', kind: kind || 'personal' }).select();
  if (error) throw error;
  const album = data[0];
  await cloud.database.from('album_members').insert({ album_id: album.id, user_id: state.user.id, role: 'owner' });
  album.role = 'owner';
  state.albums.push(album);
  return album;
}

async function switchAlbum(id) {
  if (id === state.albumId) { closeAppMenu(); return; }
  await setCurrentAlbum(id);
  state.viewer = null;
  $('#visitorBar').classList.add('hidden');
  applyEditorVisibility(true);
  await loadMemories();
  toast('已切换到「' + (state.albums.find(a => a.id === id) || {}).name + '」');
}

function refreshAlbumUI() {
  renderAlbumChips();
  renderUserChip && renderUserChip().catch(() => {});
  refreshMenuAuth();
}

function renderAlbumChips() {
  const box = $('#menuAlbums');
  if (!box) return;
  box.innerHTML = '';
  state.albums.forEach(a => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'album-chip' + (a.id === state.albumId ? ' active' : '');
    const k = kindOf(a.kind);
    const cover = (a.cover_path && urlOf(a.cover_path)) ? `<img class="ac-cover" src="${esc(urlOf(a.cover_path))}" alt="">` : '';
    btn.innerHTML = cover +
      `<span class="ac-emoji">${k.emoji}</span><span class="ac-name">${esc(a.name)}</span>` +
      (a.role === 'owner' ? '<span class="ac-role">主</span>' : a.role === 'editor' ? '<span class="ac-role ed">编</span>' : '<span class="ac-role v">看</span>');
    btn.addEventListener('click', () => switchAlbum(a.id));
    box.appendChild(btn);
  });
}

// 平台访问令牌（?sharecode=）必须保留在每一个链接里，否则会被站点网关拦截成“链接不完整”
function appBaseUrl() {
  const p = new URLSearchParams(location.search);
  const sc = p.get('sharecode');
  return location.origin + location.pathname + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
}

function myAlbumUrl() {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a || !a.share_code) return '';
  const base = appBaseUrl();
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'album=' + a.share_code;
}

/* 相册类型：可点选标签组（当前类型高亮；仅创建者可修改） */
function renderAlbumKindTags(a) {
  const box = $('#albumKind');
  if (!box) return;
  const canEdit = a.role === 'owner';
  box.innerHTML = '';
  ALBUM_KINDS.forEach(k => {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'kind-tag' + (a.kind === k.id ? ' active' : '') + (canEdit ? '' : ' ro');
    tag.textContent = k.emoji + ' ' + k.label;
    if (canEdit) tag.addEventListener('click', () => setAlbumKind(k.id));
    else tag.disabled = true;
    box.appendChild(tag);
  });
}
async function setAlbumKind(kind) {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a || a.role !== 'owner' || a.kind === kind) return;
  try {
    const { error } = await cloud.database.from('albums').update({ kind }).eq('id', a.id);
    if (error) throw error;
    a.kind = kind;
    renderAlbumKindTags(a);
    renderAlbumChips();
    const k = kindOf(kind);
    toast('类型已改为 ' + k.emoji + ' ' + k.label);
  } catch (e) { toast('修改类型失败：' + (e.message || ''), true); }
}

/* 相册管理弹窗 */
function openAlbumModal() {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  $('#albumName').value = a.name || '';
  renderAlbumKindTags(a);
  $('#albumPublic').checked = !!a.is_public;
  $('#albumBadge').textContent = a.role === 'owner' ? '（我创建）' : (a.role === 'editor' ? '（我可编辑）' : '（我可查看）');
  updateAlbumShareRow();
  renderAlbumMembers();
  const amOwner = a.role === 'owner';
  $('#albumInviteRow').classList.toggle('hidden', !amOwner);
  $('#albumMemberHint').textContent = amOwner ? '' : '（仅创建者可邀请）';
  $('#albumDelete').classList.toggle('hidden', !amOwner);
  $('#albumLeave').classList.toggle('hidden', amOwner);
  renderAlbumCover();
  $('#albumModal').classList.remove('hidden');
}
function updateAlbumShareRow() {
  const on = $('#albumPublic').checked;
  $('#albumShareRow').classList.toggle('hidden', !on);
  if (on) {
    const a = state.albums.find(x => x.id === state.albumId);
    $('#albumShareUrl').textContent = myAlbumUrl() || '（保存后生成链接）';
  }
}
async function saveAlbumMeta() {
  const name = $('#albumName').value.trim();
  if (!name) { toast('请填写相册名称', true); return; }
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  try {
    const patch = { name, is_public: $('#albumPublic').checked };
    if (patch.is_public && !a.share_code) { patch.share_code = genShareCode(); }
    const { error } = await cloud.database.from('albums').update(patch).eq('id', a.id);
    if (error) throw error;
    Object.assign(a, patch);
    updateAlbumShareRow();
    renderAlbumChips();
    toast('相册已更新 ✅');
  } catch (e) { toast('保存失败：' + (e.message || ''), true); }
}
async function inviteMember() {
  const phone = normPhone($('#invitePhone').value);
  if (phone.length < 11) { toast('请输入完整的 11 位手机号', true); return; }
  const role = $('#inviteRole').value || 'editor';
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a || a.role !== 'owner') return;
  const btn = $('#inviteBtn');
  btn.disabled = true; btn.textContent = '邀请中…';
  try {
    const { data, error } = await cloud.database.from('profiles').select('id, username').eq('phone', phone).limit(1);
    if (error) throw error;
    const exists = data && data[0];
    if (a.owner_id === (exists && exists.id)) { toast('这就是你自己创建的相册～', true); return; }
    // 避免重复邀请同一手机号
    const dup = await cloud.database.from('album_invites').select('id').eq('album_id', a.id).eq('phone', phone).limit(1);
    if (dup.error) throw dup.error;
    if (dup.data && dup.data.length) { toast('已经邀请过这个手机号啦', true); return; }
    // 也避免对方已经是成员
    const mem = await cloud.database.from('album_members').select('user_id').eq('album_id', a.id).eq('user_id', exists ? exists.id : '__none__').limit(1);
    if (mem.data && mem.data.length) { toast('对方已经在相册里啦', true); return; }
    const id = 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ins = await cloud.database.from('album_invites').insert({
      id, album_id: a.id, phone, role, invited_by: state.user.id, status: 'pending'
    });
    if (ins.error) throw ins.error;
    toast(exists ? ('已邀请 ' + (exists.username || 'TA') + '，等待对方接受 🎉') : '已发出邀请，对方注册登录后将收到通知');
    $('#invitePhone').value = '';
    await loadAlbums();
    setCurrentAlbum(a.id);
    renderAlbumMembers();
  } catch (e) { toast('邀请失败：' + (e.message || ''), true); }
  finally { btn.disabled = false; btn.textContent = '邀请'; }
}

async function cancelInvite(invId) {
  try {
    const { error } = await cloud.database.from('album_invites').delete().eq('id', invId);
    if (error) throw error;
    await renderAlbumMembers();
    toast('已撤销邀请');
  } catch (e) { toast('撤销失败：' + (e.message || ''), true); }
}

async function acceptInvite(iv) {
  try {
    const ins = await cloud.database.from('album_members').insert({ album_id: iv.album_id, user_id: state.user.id, role: iv.role });
    if (ins.error) throw ins.error;
    await cloud.database.from('album_invites').update({ status: 'accepted' }).eq('id', iv.id);
    toast('已加入相册 🎉');
    state.pendingInvites = (state.pendingInvites || []).filter(x => x.id !== iv.id);
    renderNotifBell(state.pendingInvites.length);
    await loadAlbums();
    await ensureCurrentAlbum();
    await loadMemories();
    closeAppMenu();
    $('#albumModal').classList.add('hidden');
  } catch (e) { toast('接受失败：' + (e.message || ''), true); }
}
async function declineInvite(iv) {
  try {
    await cloud.database.from('album_invites').update({ status: 'declined' }).eq('id', iv.id);
    state.pendingInvites = (state.pendingInvites || []).filter(x => x.id !== iv.id);
    renderNotifBell(state.pendingInvites.length);
    toast('已婉拒邀请');
    closeNotifPanel();
  } catch (e) { toast('操作失败：' + (e.message || ''), true); }
}

async function checkPendingInvites(showToast) {
  if (!state.user || !state.profile || !state.profile.phone) return;
  try {
    const { data, error } = await cloud.database.from('album_invites')
      .select('*').eq('phone', state.profile.phone).eq('status', 'pending');
    if (error) return;
    const list = (data || []).filter(iv => iv.invited_by !== state.user.id);
    state.pendingInvites = list;
    renderNotifBell(list.length);
    const newOnes = list.filter(iv => !seenInviteIds.has(iv.id));
    newOnes.forEach(iv => seenInviteIds.add(iv.id));
    if (showToast && newOnes.length) {
      toast('📨 你收到 ' + newOnes.length + ' 个相册协作邀请，点右上角 🔔 查看');
    }
  } catch (e) { /* 忽略 */ }
}

function renderNotifBell(count) {
  const btn = $('#notifBtn'), badge = $('#notifBadge');
  if (!btn) return;
  if (!count) { btn.classList.add('hidden'); if (badge) badge.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  if (badge) { badge.textContent = count > 9 ? '9+' : String(count); badge.classList.remove('hidden'); }
}
function openNotifPanel() {
  const panel = $('#notifPanel');
  if (!panel) return;
  const list = state.pendingInvites || [];
  if (!list.length) { panel.innerHTML = '<div class="notif-empty">暂无邀请通知</div>'; }
  else {
    panel.innerHTML = list.map(iv => {
      const role = iv.role === 'editor' ? '可编辑' : '仅查看';
      return `<div class="notif-item" data-id="${iv.id}">
        <div class="ni-tx">有人邀请你以「${role}」身份协作一个地图相册</div>
        <div class="ni-actions">
          <button class="btn small primary" data-act="accept">接受</button>
          <button class="btn small" data-act="decline">婉拒</button>
        </div>
      </div>`;
    }).join('');
    panel.querySelectorAll('.notif-item').forEach(el => {
      const iv = list.find(x => x.id === el.dataset.id);
      el.querySelector('[data-act="accept"]').addEventListener('click', () => acceptInvite(iv));
      el.querySelector('[data-act="decline"]').addEventListener('click', () => declineInvite(iv));
    });
  }
  panel.classList.toggle('hidden');
}
function closeNotifPanel() { const p = $('#notifPanel'); if (p) p.classList.add('hidden'); }
async function removeMember(uid) {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a || a.role !== 'owner') return;
  if (!confirm('移除该成员后，TA 将无法再查看或编辑此相册？')) return;
  try {
    const { error } = await cloud.database.from('album_members').delete().eq('album_id', a.id).eq('user_id', uid);
    if (error) throw error;
    await loadAlbums();
    setCurrentAlbum(a.id);
    renderAlbumMembers();
    toast('已移除成员');
  } catch (e) { toast('移除失败：' + (e.message || ''), true); }
}
async function leaveAlbum() {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  if (!confirm('确定退出「' + a.name + '」吗？退出后需重新被邀请才能加入。')) return;
  try {
    const { error } = await cloud.database.from('album_members').delete().eq('album_id', a.id).eq('user_id', state.user.id);
    if (error) throw error;
    await loadAlbums();
    await ensureCurrentAlbum();
    await loadMemories();
    closeAppMenu();
    $('#albumModal').classList.add('hidden');
    toast('已退出相册');
  } catch (e) { toast('退出失败：' + (e.message || ''), true); }
}
async function deleteAlbum() {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a || a.role !== 'owner') return;
  if (!confirm('删除「' + a.name + '」会一并删除其中的全部回忆，此操作不可恢复。确定吗？')) return;
  try {
    await cloud.database.from('memories').delete().eq('album_id', a.id);
    const { error } = await cloud.database.from('albums').delete().eq('id', a.id);
    if (error) throw error;
    await loadAlbums();
    await ensureCurrentAlbum();
    await loadMemories();
    $('#albumModal').classList.add('hidden');
    closeAppMenu();
    toast('相册已删除');
  } catch (e) { toast('删除失败：' + (e.message || ''), true); }
}
async function renderAlbumMembers() {
  const box = $('#albumMembers');
  if (!box) return;
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  const { data, error } = await cloud.database.from('album_members').select('user_id, role').eq('album_id', a.id);
  if (error) { box.innerHTML = '<div class="member-row muted">成员加载失败</div>'; return; }
  const list = data || [];

  // 待确认邀请
  let invites = [];
  try {
    const iv = await cloud.database.from('album_invites').select('*').eq('album_id', a.id).eq('status', 'pending');
    invites = iv.data || [];
  } catch (e) {}

  if (!list.length && !invites.length) {
    box.innerHTML = '<div class="member-row muted">暂无其他成员</div>';
    return;
  }
  box.innerHTML = '';
  for (const m of list) {
    let name = 'TA';
    try {
      const p = await cloud.database.from('profiles').select('username').eq('id', m.user_id).limit(1);
      if (p.data && p.data[0]) name = p.data[0].username || 'TA';
    } catch (e) {}
    const row = document.createElement('div');
    row.className = 'member-row';
    const isOwner = m.user_id === a.owner_id;
    row.innerHTML = '<span class="mr-name">' + esc(name) + (isOwner ? '（创建者）' : '') + '</span>' +
      '<span class="mr-role">' + (m.role === 'editor' ? '可编辑' : '仅查看') + '</span>';
    if (a.role === 'owner' && !isOwner) {
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '移除';
      del.addEventListener('click', () => removeMember(m.user_id));
      row.appendChild(del);
    }
    box.appendChild(row);
  }
  for (const iv of invites) {
    const row = document.createElement('div');
    row.className = 'member-row pending';
    row.innerHTML = '<span class="mr-name">📨 ' + esc(maskPhone(iv.phone)) + '</span>' +
      '<span class="mr-role">' + (iv.role === 'editor' ? '可编辑' : '仅查看') + '·待接受</span>';
    if (a.role === 'owner') {
      const c = document.createElement('button');
      c.className = 'btn small danger';
      c.textContent = '撤销';
      c.addEventListener('click', () => cancelInvite(iv.id));
      row.appendChild(c);
    }
    box.appendChild(row);
  }
}

/* ---------------- 相册封面 ---------------- */
async function signAlbumCovers() {
  const paths = state.albums.map(a => a.cover_path).filter(Boolean);
  if (paths.length) { try { await ensureSignedUrls(paths); } catch (e) {} }
  renderAlbumChips();
  renderAlbumCover();
}
function renderAlbumCover() {
  const a = state.albums.find(x => x.id === state.albumId);
  const el = $('#albumCover');
  if (!el) return;
  const has = !!(a && a.cover_path && urlOf(a.cover_path));
  if (has) {
    el.style.backgroundImage = 'url("' + urlOf(a.cover_path) + '")';
    el.textContent = '';
    el.classList.add('has');
  } else {
    el.style.backgroundImage = ''; el.textContent = '🖼️'; el.classList.remove('has');
  }
  const cb = $('#coverClearBtn');
  if (cb) cb.classList.toggle('hidden', !has);
}
async function setAlbumCover(path) {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  try {
    const { error } = await cloud.database.from('albums').update({ cover_path: (path || null) }).eq('id', a.id);
    if (error) throw error;
    a.cover_path = path || null;
    await signAlbumCovers();
    toast(path ? '封面已更新 🖼️' : '已移除封面');
  } catch (e) { toast('设置封面失败：' + (e.message || ''), true); }
}
async function uploadAlbumCover(file) {
  const blob = await shrinkImage(file, 900, 0.85);
  const path = cloud.storage.sharedPath(state.user.id, 'covers/c_' + state.albumId + '_' + Date.now().toString(36) + '.jpg');
  await uploadBlob(path, blob, 'image/jpeg', '封面上传', 'cover.jpg');
  return path;
}
async function openCoverPicker() {
  const a = state.albums.find(x => x.id === state.albumId);
  if (!a) return;
  const list = state.memories.filter(m => m.photos && m.photos.length);
  const grid = $('#coverGrid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = '<div class="minor">这个相册还没有照片，先去添加一段带照片的回忆，或点「上传图片」</div>';
  } else {
    grid.innerHTML = list.map((m, i) => {
      const p = m.photos[0];
      const u = urlOf(p.thumb || p.path);
      return `<button type="button" class="cover-opt" data-i="${i}"><img src="${esc(u)}" alt=""><span>${esc(m.name)}</span></button>`;
    }).join('');
    grid.querySelectorAll('.cover-opt').forEach(el => {
      el.addEventListener('click', () => {
        const m = list[Number(el.dataset.i)];
        setAlbumCover(m.photos[0].path);
        $('#coverPickerModal').classList.add('hidden');
      });
    });
  }
  $('#coverPickerModal').classList.remove('hidden');
}

/* ---------------- 实时协作在线状态 ---------------- */
let presenceTimer = null, presencePoll = null, inviteTimer = null;
let seenInviteIds = new Set();
async function startPresence() {
  if (!state.user || !state.albumId || state.viewer) return;
  stopPresence();
  await upsertPresence();
  presenceTimer = setInterval(upsertPresence, 8000);
  presencePoll = setInterval(pollPresence, 10000);
  inviteTimer = setInterval(() => checkPendingInvites(true), 15000);
}
function stopPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  if (presencePoll) clearInterval(presencePoll);
  if (inviteTimer) clearInterval(inviteTimer);
  presenceTimer = presencePoll = inviteTimer = null;
  const bar = $('#presenceBar'); if (bar) bar.classList.add('hidden');
}
async function upsertPresence() {
  if (!state.user || !state.albumId || state.viewer) return;
  try {
    await cloud.database.from('album_presence').upsert({
      album_id: state.albumId, user_id: state.user.id,
      name: (state.profile && state.profile.username) || maskPhone(state.user.phone || state.user.email || ''),
      last_at: new Date().toISOString()
    });
  } catch (e) { /* 忽略 */ }
}
async function pollPresence() {
  if (!state.albumId || !state.user || state.viewer) return;
  try {
    const { data } = await cloud.database.from('album_presence')
      .select('user_id, name, last_at').eq('album_id', state.albumId);
    const now = Date.now();
    const others = (data || []).filter(p => p.user_id !== state.user.id && (new Date(p.last_at).getTime() > now - 30000));
    renderPresence(others);
  } catch (e) { /* 忽略 */ }
}
function renderPresence(others) {
  const bar = $('#presenceBar');
  if (!bar) return;
  if (!others.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '<span class="pr-dot"></span>正在一起编辑：' + others.map(o => esc(o.name || '协作者')).join('、');
}

async function openNewAlbum() {
  // 只用一个输入框问名字；类型在随后打开的相册弹窗里点选（更直观，也避免
  // 部分内置浏览器拦截多次 window.prompt 导致看不到类型选项）
  let name = '';
  try {
    name = (window.prompt('给新相册起个名字（如「和 TA 的地图」「我的个人旅行」）', '新的地图相册') || '').trim();
  } catch (e) { name = ''; }
  if (!name) return;
  try {
    const album = await createAlbum(name, 'couple');
    await setCurrentAlbum(album.id);
    toast('已创建「' + name + '」，在下方点一下就能选类型 🎉');
    await loadMemories();
    openAlbumModal();
  } catch (e) {
    toast('创建失败：' + (e.message || ''), true);
  }
}

/* ============================================================
 * 数据：云数据库
 * ============================================================ */
function rowToMemory(r) {
  return {
    id: r.id,
    name: r.name || '',
    province: r.province || '',
    city: r.city || '',
    district: r.district || '',
    address: r.address || '',
    lat: Number(r.lat),
    lng: Number(r.lng),
    date: r.trip_date || '',
    memory: r.memory_text || '',
    mood: r.mood || '',
    weather: r.weather || '',
    stickies: Array.isArray(r.stickies) ? r.stickies : [],
    photos: Array.isArray(r.photos) ? r.photos : [],
    marker: (r.marker && typeof r.marker === 'object') ? r.marker : { type: 'default' }
  };
}

function memoryToRow(m) {
  return {
    name: m.name,
    province: m.province,
    city: m.city,
    district: m.district,
    address: m.address || '',
    lat: m.lat,
    lng: m.lng,
    trip_date: m.date,
    memory_text: m.memory,
    mood: m.mood || null,
    weather: m.weather || null,
    stickies: m.stickies || [],
    photos: m.photos,
    marker: m.marker || { type: 'default' }
  };
}

function allPhotoPaths(list) {
  const paths = [];
  list.forEach(m => {
    (m.photos || []).forEach(p => {
      if (p.path) paths.push(p.path);
      if (p.thumb && p.thumb !== p.path) paths.push(p.thumb);
    });
    (m.stickies || []).forEach(s => { if (s) paths.push(s); });
  });
  return paths;
}

async function ensureSignedUrls(paths) {
  const need = [];
  const now = Date.now();
  paths.forEach(p => {
    const c = state.urlCache[p];
    if (!c || c.exp < now) need.push(p);
  });
  if (!need.length) return;
  const res = await cloud.storage.createSignedUrls(need, 3600);
  if (res.error) throw res.error;
  const arr = res.data;
  const exp = Date.now() + 3500 * 1000;
  if (Array.isArray(arr)) {
    arr.forEach((item, i) => {
      const p = (item && item.path) || need[i];
      const url = item && (item.signedUrl || item.url);
      if (p && url) state.urlCache[p] = { url, exp };
    });
  } else if (arr && typeof arr === 'object') {
    Object.keys(arr).forEach(p => {
      const v = arr[p];
      const url = typeof v === 'string' ? v : (v && (v.signedUrl || v.url));
      if (url) state.urlCache[p] = { url, exp };
    });
  }
}

function urlOf(path) {
  const c = path && state.urlCache[path];
  return c ? c.url : '';
}

async function loadMemories() {
  if (!state.albumId) return;
  try {
    const { data, error } = await cloud.database.from('memories').select('*').eq('album_id', state.albumId);
    if (error) throw error;
    state.memories = (data || []).map(rowToMemory)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    try { await ensureSignedUrls(allPhotoPaths(state.memories)); } catch (e) { /* 签名失败时照片稍后重试 */ }
    renderStats();
    renderList();
    renderFilters();
    refreshMarkers();
    renderEmptyState();
    renderFilmstrip();
    checkNewAchievements();
    if (!state.viewer) { maybeShowMigrate(); maybeShowOnThisDay(); }
    try { await signAlbumCovers(); } catch (e) { /* 封面签名失败不影响主流程 */ }
  } catch (e) {
    toast('回忆数据加载失败：' + (e.message || '请重新登录'), true);
  }
}

/* ============================================================
 * 云存储上传：统一入口（照片 / 缩略图 / 头像 / 封面 / 便签 / 扩展资料）
 * ------------------------------------------------------------
 * SDK 对 Blob 会包成 multipart FormData 并带自定义头做跨域 POST，
 * 部分网络或内置浏览器会在这一跳报 "Failed to fetch"。
 * 因此：① body 统一包装成带 name 的 File；
 *      ② 网络层失败时自动改用 ArrayBuffer 再试（走 SDK 的二进制分支，
 *         绕开 FormData）；③ 再短暂重试一次应对瞬时断网；
 *      ④ 仍失败则给出中文可诊断提示，且不改动/丢失已选点位与表单内容。
 * ============================================================ */
function toUploadFile(blob, name, type) {
  if (typeof File === 'function') {
    try { return new File([blob], name, { type: type || blob.type || 'application/octet-stream' }); }
    catch (e) { return blob; }
  }
  return blob;
}
async function blobToArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return await blob.arrayBuffer();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsArrayBuffer(blob);
  });
}
function friendlyUploadError(e, label) {
  const m = (e && e.message) || '';
  if (/Failed to fetch|Load failed|NetworkError|network|ERR_/i.test(m)) {
    return new Error(label + '失败：连不上云存储，请检查网络后重试；若是在微信里打开，建议改用系统浏览器打开本站');
  }
  if (/401|unauthorized|not authenticated|token|登录/i.test(m)) {
    return new Error(label + '失败：登录状态已过期，请重新登录后再试');
  }
  if (/403|forbidden|permission|denied/i.test(m)) {
    return new Error(label + '失败：没有上传权限，请确认已登录且是该相册成员');
  }
  if (/413|too large|payload|size/i.test(m)) {
    return new Error(label + '失败：图片太大，请换一张小一点的');
  }
  return new Error(label + '失败：' + (m || '请稍后重试'));
}
async function uploadBlob(path, blob, contentType, label, fileName) {
  const opts = { contentType, upsert: true };
  const file = toUploadFile(blob, fileName || 'upload.bin', contentType);
  let lastErr = null;

  // ① 标准 File 路径
  try {
    const r = await cloud.storage.upload(path, file, opts);
    if (r && r.error) throw new Error(r.error.message || 'upload error');
    return r;
  } catch (e) { lastErr = e; }

  // ② 网络层失败 → 改用 ArrayBuffer（SDK 的非 FormData 分支）
  try {
    const buf = await blobToArrayBuffer(blob);
    const r = await cloud.storage.upload(path, buf, opts);
    if (r && r.error) throw new Error(r.error.message || 'upload error');
    return r;
  } catch (e) { lastErr = e; }

  // ③ 瞬时断网：稍等后再试一次 File
  await new Promise(r => setTimeout(r, 500));
  try {
    const r = await cloud.storage.upload(path, file, opts);
    if (r && r.error) throw new Error(r.error.message || 'upload error');
    return r;
  } catch (e) { lastErr = e; }

  console.warn('[upload] 三次尝试均失败', label, lastErr);
  throw friendlyUploadError(lastErr, label);
}

/* 照片：云存储（shared/ 路径：本人可写，登录用户可读，便于地图分享） */
async function uploadPhotoPair(uid, mainBlob, thumbBlob) {
  const base = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const mainPath = cloud.storage.sharedPath(uid, 'photos/' + base + '.jpg');
  const thumbPath = cloud.storage.sharedPath(uid, 'photos/' + base + '_t.jpg');
  await uploadBlob(mainPath, mainBlob, 'image/jpeg', '照片上传', base + '.jpg');
  await uploadBlob(thumbPath, thumbBlob, 'image/jpeg', '缩略图上传', base + '_t.jpg');
  return { path: mainPath, thumb: thumbPath };
}

async function removeStorageObjects(paths) {
  if (!paths.length) return;
  try { await cloud.storage.remove(paths); } catch (e) { /* 清理失败不影响主流程 */ }
}

/* ============================================================
 * UI 事件绑定
 * ============================================================ */
function bindUI() {
  /* 登录 */
  $('#tabPwd').addEventListener('click', () => setAuthMode('pwd'));
  $('#tabSms').addEventListener('click', () => setAuthMode('sms'));
  $('#pwdSubmit').addEventListener('click', submitPwd);
  $('#smsSubmit').addEventListener('click', submitSms);
  $('#pPhone').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pPwd').focus(); });
  $('#pPwd').addEventListener('keydown', e => { if (e.key === 'Enter') submitPwd(); });
  $('#sPhone').addEventListener('keydown', e => { if (e.key === 'Enter') sendPhoneCode(); });
  $('#sCode').addEventListener('keydown', e => { if (e.key === 'Enter') submitSms(); });
  $('#aSendCode').addEventListener('click', sendPhoneCode);

  /* 侧边菜单抽屉 */
  $('#sidebarToggle').addEventListener('click', openAppMenu);
  $('#menuClose').addEventListener('click', closeAppMenu);
  $('#menuBackdrop').addEventListener('click', closeAppMenu);
  $('#menuList').addEventListener('click', e => {
    const it = e.target.closest('.menu-item');
    if (it) menuAct(it.dataset.act);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAppMenu(); });

  /* 个人资料 */
  $('#userChip').addEventListener('click', openProfile);
  $('#profileClose').addEventListener('click', () => $('#profileModal').classList.add('hidden'));
  $('#profileModal').addEventListener('click', e => {
    if (e.target === $('#profileModal')) $('#profileModal').classList.add('hidden');
  });
  $('#profAvatarBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', e => {
    changeAvatar(e.target.files[0]);
    e.target.value = '';
  });
  $('#profSave').addEventListener('click', saveProfile);

  /* 相册管理 */
  $('#albumClose').addEventListener('click', () => $('#albumModal').classList.add('hidden'));
  $('#albumModal').addEventListener('click', e => {
    if (e.target === $('#albumModal')) $('#albumModal').classList.add('hidden');
  });
  $('#albumName').addEventListener('change', saveAlbumMeta);
  $('#albumPublic').addEventListener('change', saveAlbumMeta);
  $('#albumShareCopy').addEventListener('click', () => copyText($('#albumShareUrl').textContent, $('#albumShareCopy')));
  $('#inviteBtn').addEventListener('click', inviteMember);
  $('#albumDelete').addEventListener('click', deleteAlbum);
  $('#albumLeave').addEventListener('click', leaveAlbum);

  /* 邀请通知 */
  $('#notifBtn').addEventListener('click', e => { e.stopPropagation(); openNotifPanel(); });
  $('#notifPanel').addEventListener('click', e => { e.stopPropagation(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#notifBtn') && !e.target.closest('#notifPanel')) closeNotifPanel();
  });

  /* 相册封面 */
  $('#coverPickBtn').addEventListener('click', openCoverPicker);
  $('#coverUpBtn').addEventListener('click', () => $('#coverInput').click());
  $('#coverInput').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const btn = $('#coverUpBtn'); const old = btn.textContent;
    btn.disabled = true; btn.textContent = '上传中…';
    try {
      const path = await uploadAlbumCover(f);
      await setAlbumCover(path);
    } catch (err) { toast('封面上传失败：' + (err.message || ''), true); }
    finally { btn.disabled = false; btn.textContent = old; e.target.value = ''; }
  });
  $('#coverClearBtn').addEventListener('click', () => setAlbumCover(null));
  $('#coverPickerClose').addEventListener('click', () => $('#coverPickerModal').classList.add('hidden'));
  $('#coverPickerModal').addEventListener('click', e => {
    if (e.target === $('#coverPickerModal')) $('#coverPickerModal').classList.add('hidden');
  });

  /* 分享 */
  $('#shareClose').addEventListener('click', () => $('#shareModal').classList.add('hidden'));
  $('#shareModal').addEventListener('click', e => {
    if (e.target === $('#shareModal')) $('#shareModal').classList.add('hidden');
  });
  $('#shareCopy').addEventListener('click', () => copyText($('#shareUrl').textContent, $('#shareCopy')));
  $('#shareMyCopy').addEventListener('click', () => copyText($('#shareMyUrl').textContent, $('#shareMyCopy')));

  /* 访客视图 */
  $('#visitorExit').addEventListener('click', goOwnMap);

  $('#btnAdd').addEventListener('click', () => openForm(null));
  $('#emptyAdd').addEventListener('click', () => openForm(null));

  /* 地点搜索：腾讯正向地理编码 + POI 联想 */
  $('#fSearchBtn').addEventListener('click', () => searchAndLocate($('#fSearch').value));
  $('#fSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchAndLocate($('#fSearch').value); }
  });
  $('#fSearch').addEventListener('input', debounce(() => {
    const q = $('#fSearch').value.trim();
    if (state.form && q.length >= 2) querySuggest(q); else hideSuggest();
  }, 700));   // 稍长的节流，避免个人 Key 免费额度被联想请求快速消耗
  $('#fSuggest').addEventListener('click', e => {
    const it = e.target.closest('.sg-item');
    if (!it) return;
    const info = suggestList[Number(it.dataset.i)];
    if (info) applyLocated(info);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#fSearch') && !e.target.closest('#fSuggest')) hideSuggest();
  });
  $('#editToggle').addEventListener('change', e => {
    state.editMode = e.target.checked;
    document.body.classList.toggle('edit-mode', state.editMode);
    updateAddVisibility();
    toast(state.editMode ? '编辑模式已开启，可以添加和修改回忆 ✏️' : '已回到浏览模式');
  });

  /* 地图标记 */
  document.querySelectorAll('#markerPicker .mk-opt').forEach(b => {
    b.addEventListener('click', () => selectMkType(b.dataset.mk));
  });
  $('#markerRedraw').addEventListener('click', openDraw);
  $('#drawClose').addEventListener('click', closeDraw);
  $('#drawModal').addEventListener('click', e => {
    if (e.target === $('#drawModal')) closeDraw();
  });
  bindDrawTools();
  $('#helpClose').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
  $('#helpModal').addEventListener('click', e => {
    if (e.target === $('#helpModal')) $('#helpModal').classList.add('hidden');
  });

  $('#mapErrorClose').addEventListener('click', () => $('#mapError').classList.add('hidden'));

  $('#search').addEventListener('input', e => {
    state.search = e.target.value.trim();
    renderList();
  });

  /* 个人资料：标签页 / 表情头像 / 纪念日 */
  document.querySelectorAll('.prof-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.prof-tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.prof-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
    });
  });
  $('#profAnniversary').addEventListener('change', updateAnnivDays);
  $('#postcardsClose').addEventListener('click', () => $('#postcardsModal').classList.add('hidden'));
  $('#postcardsModal').addEventListener('click', e => {
    if (e.target === $('#postcardsModal')) $('#postcardsModal').classList.add('hidden');
  });

  $('#detailClose').addEventListener('click', closePanel);
  $('#btnEdit').addEventListener('click', () => openForm(state.selectedId));
  $('#btnDelete').addEventListener('click', deleteSelected);

  $('#formClose').addEventListener('click', closePanel);
  $('#formCancel').addEventListener('click', closePanel);
  $('#formSave').addEventListener('click', saveForm);

  const dz = $('#dropZone');
  dz.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', e => {
    addPendingPhotos(Array.from(e.target.files || []));
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', e => addPendingPhotos(Array.from(e.dataTransfer.files || [])));

  /* 护照 / 成就 / 明信片 */
  $('#passportClose').addEventListener('click', () => $('#passportModal').classList.add('hidden'));
  $('#passportModal').addEventListener('click', e => {
    if (e.target === $('#passportModal')) $('#passportModal').classList.add('hidden');
  });
  $('#badgesClose').addEventListener('click', () => $('#badgesModal').classList.add('hidden'));
  $('#badgesModal').addEventListener('click', e => {
    if (e.target === $('#badgesModal')) $('#badgesModal').classList.add('hidden');
  });
  $('#btnPostcard').addEventListener('click', () => openPostcard(state.selectedId));
  $('#postcardClose').addEventListener('click', () => $('#postcardModal').classList.add('hidden'));
  $('#postcardModal').addEventListener('click', e => {
    if (e.target === $('#postcardModal')) $('#postcardModal').classList.add('hidden');
  });
  $('#postcardDownload').addEventListener('click', downloadPostcard);
  $('#postcardShare').addEventListener('click', copyPostcardText);

  /* 胶片时间轴 */
  $('#filmToggle').addEventListener('click', () => {
    const el = $('#filmstrip');
    el.classList.toggle('collapsed');
    localStorage.setItem('filmCollapsed', el.classList.contains('collapsed') ? '1' : '0');
    syncFilmDock();
  });
  if (localStorage.getItem('filmCollapsed') === '1') $('#filmstrip').classList.add('collapsed');

  /* 情绪 / 天气筛选（动态芯片，事件委托） */
  $('#moodFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-mood]');
    if (!b) return;
    state.filter.mood = b.dataset.mood || null;
    renderFilters();
    renderList();
    refreshMarkers();
    renderFilmstrip();
  });
  $('#weatherFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-weather]');
    if (!b) return;
    state.filter.weather = b.dataset.weather || null;
    renderFilters();
    renderList();
    refreshMarkers();
    renderFilmstrip();
  });

  /* 手写便签 */
  $('#btnAddSticky').addEventListener('click', openStickyBoard);
  $('#stickyClose').addEventListener('click', closeStickyBoard);
  $('#stickyModal').addEventListener('click', e => {
    if (e.target === $('#stickyModal')) closeStickyBoard();
  });
  bindStickyTools();

  $('#migImport').addEventListener('click', doImportLocalData);
  $('#migLater').addEventListener('click', () => $('#migrateBar').classList.add('hidden'));

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('#lbNext').addEventListener('click', () => stepLightbox(1));
  $('#lightbox').addEventListener('click', e => {
    if (e.target === $('#lightbox')) closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });
}

function copyText(text, btn) {
  const done = () => {
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = '复制'; }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
  done();
}

async function openShare() {
  $('#shareUrl').textContent = appBaseUrl();
  const url = myAlbumUrl();
  const a = state.albums.find(x => x.id === state.albumId);
  $('#shareMyUrl').textContent = url || '（先在「管理当前相册」中开启公开分享，即可生成只读链接）';
  $('#shareMyCopy').disabled = !url;
  $('#shareModal').classList.remove('hidden');
}

/* ============================================================
 * 本地版数据迁移
 * ============================================================ */
async function maybeShowMigrate() {
  try {
    if (localStorage.getItem('ltm_migrated_v1')) return;
    const res = await fetch('assets/migration/local-data.json');
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return;
    if (state.memories.length) { localStorage.setItem('ltm_migrated_v1', '1'); return; }
    $('#migCount').textContent = list.length;
    $('#migrateBar').classList.remove('hidden');
  } catch (e) { /* 无迁移数据 */ }
}

async function doImportLocalData() {
  const btn = $('#migImport');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const res = await fetch('assets/migration/local-data.json');
    const list = await res.json();
    const uid = state.user.id;
    let imported = 0;
    for (const rec of (list || [])) {
      const photos = [];
      for (const ph of (rec.photos || [])) {
        try {
          const mainBlob = await (await fetch('assets/migration/' + ph.file)).blob();
          let thumbBlob = mainBlob;
          if (ph.thumb && ph.thumb !== ph.file) {
            thumbBlob = await (await fetch('assets/migration/' + ph.thumb)).blob();
          }
          const up = await uploadPhotoPair(uid, mainBlob, thumbBlob);
          photos.push({ path: up.path, thumb: up.thumb, caption: ph.caption || '' });
        } catch (e) { /* 单张失败跳过 */ }
      }
      const ins = await cloud.database.from('memories').insert({
        name: rec.name || '未命名回忆',
        province: rec.province || '',
        city: rec.city || '',
        district: rec.district || '',
        lat: Number(rec.lat) || 0,
        lng: Number(rec.lng) || 0,
        trip_date: rec.date || '',
        memory_text: rec.memory || '',
        photos,
        album_id: state.albumId
      });
      if (!ins.error) imported++;
    }
    localStorage.setItem('ltm_migrated_v1', '1');
    $('#migrateBar').classList.add('hidden');
    toast(imported ? `已导入 ${imported} 条回忆到你的账号 ❤` : '没有可导入的数据', !imported);
    await loadMemories();
  } catch (e) {
    toast('导入失败：' + (e.message || '请重试'), true);
  } finally {
    btn.disabled = false; btn.textContent = '导入';
  }
}

/* ============================================================
 * 地图
 * ============================================================ */
function initMap() {
  const map = new TMap.Map('map', {
    center: new TMap.LatLng(35, 105),
    zoom: 4,
    minZoom: 3
  });
  state.map = map;

  map.on('click', e => {
    if (state.pickMode) {
      setFormLocation(e.latLng.getLat(), e.latLng.getLng());
    } else if (state.selectedId) {
      closePanel();
    }
  });

  state.pickerLayer = makePickerLayer([]);
  state.mapReady = true;
  refreshMarkers();
  fitToData();
}

function markerSrcOf(m) {
  const mk = m.marker || {};
  if (mk.type === 'draw' && mk.data) return mk.data;
  if (mk.type === 'photo' && mk.path) return urlOf(mk.path);
  return null;
}

function refreshMarkers() {
  if (!state.mapReady) return;
  if (state.markerLayer) {
    state.markerLayer.setMap(null);
    state.markerLayer = null;
  }
  const base = makeMarkerStyles();
  const styles = { default: base.default, active: base.active };
  // 心情专属爱心（未选中 / 选中两种尺寸）
  MOODS.forEach(md => {
    styles['hm_' + md.id] = new TMap.MarkerStyle({
      width: 28, height: 35, anchor: { x: 14, y: 35 }, src: heartSvg(md.color, '#fff')
    });
    styles['hm_' + md.id + '_a'] = new TMap.MarkerStyle({
      width: 37, height: 46, anchor: { x: 18, y: 46 }, src: heartSvg(md.color, '#121212')
    });
  });
  const geos = [];
  visibleMemories().forEach(m => {
    const src = markerSrcOf(m);
    const pos = new TMap.LatLng(m.lat, m.lng);
    const props = { id: String(m.id) };
    const sel = m.id === state.selectedId;
    if (src) {
      const sid = 'c_' + String(m.id).replace(/[^a-zA-Z0-9]/g, '');
      if (!styles[sid]) {
        styles[sid] = new TMap.MarkerStyle({ width: 40, height: 40, anchor: { x: 20, y: 40 }, src });
        styles[sid + '_a'] = new TMap.MarkerStyle({ width: 50, height: 50, anchor: { x: 25, y: 50 }, src });
      }
      geos.push({ id: String(m.id), styleId: sel ? sid + '_a' : sid, position: pos, properties: props });
    } else if (m.mood && MOOD_COLORS[m.mood]) {
      geos.push({ id: String(m.id), styleId: 'hm_' + m.mood + (sel ? '_a' : ''), position: pos, properties: props });
    } else {
      geos.push({ id: String(m.id), styleId: sel ? 'active' : 'default', position: pos, properties: props });
    }
  });
  state.markerLayer = new TMap.MultiMarker({
    map: state.map,
    styles,
    geometries: geos
  });
  state.markerLayer.on('click', e => {
    if (e && e.geometry && e.geometry.properties) {
      const raw = e.geometry.properties.id;
      openDetail(isNaN(Number(raw)) ? raw : Number(raw), true);
    }
  });
  renderRoute();
}

function fitToData() {
  if (!state.mapReady || !state.memories.length) return;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  state.memories.forEach(m => {
    minLat = Math.min(minLat, m.lat); maxLat = Math.max(maxLat, m.lat);
    minLng = Math.min(minLng, m.lng); maxLng = Math.max(maxLng, m.lng);
  });
  const span = Math.max(maxLat - minLat, maxLng - minLng);
  const zoom = span > 20 ? 4 : span > 8 ? 5 : span > 4 ? 7 : span > 1.5 ? 9
             : span > 0.6 ? 11 : span > 0.25 ? 12 : 13;
  state.map.setZoom(zoom);
  state.map.setCenter(new TMap.LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2));
}

function flyTo(m) {
  if (!state.mapReady || !m) return;
  try {
    state.map.panTo(new TMap.LatLng(m.lat, m.lng));
    state.map.setZoom(Math.max(state.map.getZoom(), 11));
  } catch (e) { /* 静默 */ }
}

/* ============================================================
 * 行程连线：按日期把回忆点连成轨迹（Polarsteps 风格）
 * 跟随当前筛选（visibleMemories），保证与地图标记一致
 * ============================================================ */
function datedMemories() {
  return visibleMemories()
    .filter(m => m.date && isFinite(m.lat) && isFinite(m.lng))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function renderRoute() {
  const btn = $('#routeToggle');
  if (state.routeLayer) { try { state.routeLayer.setMap(null); } catch (e) { /* 静默 */ } state.routeLayer = null; }
  const dated = datedMemories();
  if (btn) btn.classList.toggle('hidden', dated.length < 2);
  if (!state.mapReady || !state.routeOn || dated.length < 2) return;
  const paths = dated.map(m => new TMap.LatLng(m.lat, m.lng));
  try {
    state.routeLayer = new TMap.MultiPolyline({
      map: state.map,
      styles: {
        route: new TMap.PolylineStyle({
          color: '#FF5C93', width: 5, borderWidth: 1.5, borderColor: '#121212', lineCap: 'round'
        })
      },
      geometries: [{ styleId: 'route', paths }]
    });
  } catch (e) { state.routeLayer = null; }
  if (btn) { btn.classList.toggle('on', !!state.routeLayer); btn.setAttribute('aria-pressed', String(!!state.routeLayer)); }
}

function toggleRoute() {
  state.routeOn = !state.routeOn;
  renderRoute();
  toast(state.routeOn ? '行程连线已开启 🧭' : '行程连线已关闭');
}

/* ============================================================
 * 时光流：按时间倒序的图文 feed（小红书 / Instagram 风格）
 * ============================================================ */
function openTimeline() {
  renderTimeline();
  $('#timelineView').classList.remove('hidden');
}
function closeTimeline() {
  $('#timelineView').classList.add('hidden');
}
function renderTimeline() {
  const box = $('#timelineBody');
  if (!box) return;
  const list = (state.memories || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (!list.length) { box.innerHTML = '<div class="tl-empty">还没有回忆，先在地图上留下第一段故事吧 ❤</div>'; return; }
  box.innerHTML = list.map(m => {
    const ph = (m.photos && m.photos[0]) ? (m.photos[0].thumb || m.photos[0].path) : null;
    const u = ph ? urlOf(ph) : '';
    const place = [m.province, m.city, m.district].filter(Boolean).join(' · ');
    const md = moodOf(m.mood), wd = weatherOf(m.weather);
    const chips = [];
    if (md.emoji) chips.push(`<span class="tag">${md.emoji} ${esc(md.label)}</span>`);
    if (wd.emoji) chips.push(`<span class="tag weather">${wd.emoji} ${esc(wd.label)}</span>`);
    const meta = [place, m.date ? fmtDate(m.date) : ''].filter(Boolean).join(' · ');
    const img = u
      ? `<img class="tl-photo" loading="lazy" src="${esc(u)}" alt="${esc(m.name)}">`
      : `<div class="tl-photo fb">${md.emoji || '❤'}</div>`;
    const text = (m.memory || '').trim()
      ? `<div class="tl-text">${nl2br(m.memory)}</div>`
      : '';
    return `<div class="tl-item" data-id="${esc(String(m.id))}">
        ${img}
        <div class="tl-name">${esc(m.name)}</div>
        <div class="tl-meta">${esc(meta) || '&nbsp;'}</div>
        <div class="tl-chips">${chips.join('')}</div>
        ${text}
      </div>`;
  }).join('');
  box.querySelectorAll('.tl-item').forEach(el => {
    el.addEventListener('click', () => {
      const raw = el.dataset.id;
      closeTimeline();
      openDetail(isNaN(Number(raw)) ? raw : Number(raw), true);
    });
  });
}

/* ============================================================
 * 那年今日：登录后弹「N 年前的今天」回忆卡（每天一次）
 * ============================================================ */
let otdMemoryId = null;
function maybeShowOnThisDay() {
  if (!state.user || state.viewer) return;
  const list = state.memories || [];
  if (!list.length) return;
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const hits = list.filter(m => {
    if (!m.date) return false;
    const p = String(m.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!p) return false;
    return p[2] === mm && p[3] === dd && Number(p[1]) < today.getFullYear();
  });
  if (!hits.length) return;
  const key = 'ltm_otd_' + mm + '-' + dd;
  if (localStorage.getItem(key)) return;
  const m = hits.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  const year = Number(String(m.date).slice(0, 4));
  const yearsAgo = today.getFullYear() - year;
  const ph = (m.photos && m.photos[0]) ? (m.photos[0].thumb || m.photos[0].path) : null;
  const u = ph ? urlOf(ph) : '';
  const place = [m.province, m.city, m.district].filter(Boolean).join(' · ');
  $('#otdBody').innerHTML =
    (u ? `<img class="otd-photo" src="${esc(u)}" alt="">` : `<div class="otd-photo fb">❤</div>`) +
    `<div class="otd-years">${yearsAgo} 年前的今天</div>` +
    `<div class="otd-name">${esc(m.name)}</div>` +
    `<div class="otd-sub">${esc([place, fmtDate(m.date)].filter(Boolean).join(' · '))}</div>`;
  $('#otdModal').classList.remove('hidden');
  otdMemoryId = m.id;
  localStorage.setItem(key, '1');
}

/* ============================================================
 * 数据导出 / 备份：下载全量 JSON（所有相册 + 回忆元数据）
 * 照片与便签仍存于云端，导出中按原路径引用
 * ============================================================ */
async function exportData() {
  if (!state.user) return;
  if (state.viewer) { toast('访客模式不能导出 TA 的数据', true); return; }
  toast('正在整理数据…');
  try {
    const albums = state.albums || [];
    const memories = [];
    for (const alb of albums) {
      const { data, error } = await cloud.database.from('memories').select('*').eq('album_id', alb.id);
      if (error) continue;
      (data || []).forEach(r => {
        const m = rowToMemory(r);
        memories.push({
          id: m.id,
          album_id: alb.id,
          album_name: alb.name || '',
          name: m.name,
          province: m.province,
          city: m.city,
          district: m.district,
          address: m.address,
          lat: m.lat,
          lng: m.lng,
          date: m.date,
          mood: m.mood,
          weather: m.weather,
          memory: m.memory,
          photos: m.photos || [],
          stickies: m.stickies || [],
          marker: m.marker || { type: 'default' }
        });
      });
    }
    const payload = {
      app: 'love-travel-map',
      version: 1,
      exported_at: new Date().toISOString(),
      profile: {
        username: (state.profile && state.profile.username) || '',
        phone: maskPhone((state.profile && state.profile.phone) || state.user.phone || ''),
        bio: (state.profileExtra && state.profileExtra.bio) || '',
        anniversary: (state.profileExtra && state.profileExtra.anniversary) || ''
      },
      albums: albums.map(a => ({
        id: a.id,
        name: a.name || '',
        kind: a.kind || '',
        cover_path: a.cover_path || null,
        is_public: !!a.is_public,
        share_code: a.share_code || null
      })),
      memories
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'our-map-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast('数据已导出 📦（照片仍存于云端）');
  } catch (e) {
    toast('导出失败：' + (e.message || '请重试'), true);
  }
}

/* ============================================================
 * 年度回顾 Year in Review（Spotify Wrapped 式）
 * ============================================================ */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function availableYears() {
  const ys = new Set();
  (state.memories || []).forEach(m => {
    const y = String(m.date || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) ys.add(Number(y));
  });
  return [...ys].sort((a, b) => a - b);
}

function openYearReview(year) {
  if (!state.memories.length) { toast('还没有回忆，先去地图上记一段吧 ❤'); return; }
  const years = availableYears();
  if (!years.length) { toast('回忆还没有填写日期，暂时无法生成年度回顾', true); return; }
  if (year && years.includes(year)) state.yearView = year;
  else if (!state.yearView || !years.includes(state.yearView)) {
    const cy = new Date().getFullYear();
    state.yearView = years.includes(cy) ? cy : years[years.length - 1];
  }
  renderYearReview();
  $('#yearModal').classList.remove('hidden');
}

function renderYearReview() {
  const years = availableYears();
  const y = state.yearView;
  const idx = years.indexOf(y);
  const prev = $('#yearPrev'), next = $('#yearNext');
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx < 0 || idx >= years.length - 1;
  if ($('#yearNum')) $('#yearNum').textContent = String(y);

  const list = (state.memories || [])
    .filter(m => String(m.date || '').slice(0, 4) === String(y))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const grid = $('#yearGrid'), citiesBox = $('#yearCities'), empty = $('#yearEmpty');
  if (!list.length) {
    if (grid) grid.innerHTML = '';
    if (citiesBox) citiesBox.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  let photos = 0, stickies = 0, km = 0;
  const cityMap = new Map();
  const provSet = new Set();
  const moodMap = new Map();
  list.forEach((m, i) => {
    photos += (m.photos || []).length;
    stickies += (m.stickies || []).length;
    if (m.city) cityMap.set(m.city, (cityMap.get(m.city) || 0) + 1);
    if (m.province) provSet.add(m.province);
    if (m.mood) moodMap.set(m.mood, (moodMap.get(m.mood) || 0) + 1);
    if (i > 0 && isFinite(m.lat) && isFinite(m.lng) && isFinite(list[i - 1].lat) && isFinite(list[i - 1].lng)) {
      km += haversineKm(list[i - 1], m);
    }
  });
  km = Math.round(km);

  let topMood = '';
  moodMap.forEach((v, k) => { if (!topMood || v > (moodMap.get(topMood) || 0)) topMood = k; });
  const md = topMood ? moodOf(topMood) : null;

  const cells = [
    { v: list.length, s: '段', l: '回忆' },
    { v: cityMap.size, s: '座', l: '城市' },
    { v: provSet.size, s: '个', l: '省份' },
    { v: photos, s: '张', l: '照片' },
    { v: stickies, s: '张', l: '手写便签' },
    { v: km, s: 'km', l: '连点里程' }
  ];
  if (grid) {
    grid.innerHTML = cells.map(c =>
      `<div class="year-stat"><div class="ys-val">${c.v}<small>${c.s}</small></div><div class="ys-lab">${c.l}</div></div>`
    ).join('') + (md && md.emoji
      ? `<div class="year-stat wide"><div class="ys-val">${md.emoji} ${esc(md.label)}</div><div class="ys-lab">这一年最常出现的心情</div></div>`
      : '');
  }

  const topCities = [...cityMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (citiesBox) {
    citiesBox.innerHTML = topCities.length
      ? `<div class="yc-title">这一年去过</div><div class="yc-list">` +
        topCities.map(([c, n]) => `<span class="yc-chip">${esc(c)}<b>×${n}</b></span>`).join('') +
        `</div>`
      : '';
  }
}

function copyYearText() {
  const y = state.yearView;
  const list = (state.memories || []).filter(m => String(m.date || '').slice(0, 4) === String(y));
  if (!list.length) { toast('这一年还没有回忆', true); return; }
  const cities = new Set(list.map(m => m.city).filter(Boolean));
  const photos = list.reduce((s, m) => s + (m.photos || []).length, 0);
  const txt = `${y} 年，我们一起留下了 ${list.length} 段回忆，走过 ${cities.size} 座城市，存下 ${photos} 张照片。` +
    `\n—— 来自我们的地图 ❤`;
  copyText(txt, $('#yearCopy'));
}

function yearStep(dir) {
  const years = availableYears();
  const idx = years.indexOf(state.yearView);
  if (idx < 0) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= years.length) return;
  state.yearView = years[ni];
  renderYearReview();
}

/* ============================================================
 * 危险操作：清空回忆 / 注销账号（二次确认 + 云端级联删除）
 * ============================================================ */
let dangerAction = null;

function openDanger(opts) {
  $('#dangerTitle').textContent = opts.title || '确认操作';
  $('#dangerDesc').innerHTML = opts.desc || '';
  $('#dangerWord').textContent = opts.word || '确认';
  $('#dangerInput').value = '';
  $('#dangerError').classList.add('hidden');
  dangerAction = opts.onConfirm || null;
  $('#dangerModal').classList.remove('hidden');
  setTimeout(() => { try { $('#dangerInput').focus(); } catch (e) { /* 忽略 */ } }, 30);
}

function closeDanger() {
  $('#dangerModal').classList.add('hidden');
  dangerAction = null;
}

async function runDanger() {
  const word = $('#dangerWord').textContent;
  const typed = ($('#dangerInput').value || '').trim();
  if (typed !== word) {
    $('#dangerError').textContent = '输入不一致，请准确输入「' + word + '」';
    $('#dangerError').classList.remove('hidden');
    return;
  }
  const fn = dangerAction;
  const btn = $('#dangerOk');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '处理中…';
  $('#dangerError').classList.add('hidden');
  try {
    if (fn) await fn();
  } catch (e) {
    $('#dangerError').textContent = (e && e.message) || '操作失败，请稍后重试';
    $('#dangerError').classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

/* 一条回忆涉及的所有云存储文件路径 */
function memoryFilePaths(m) {
  const out = [];
  (m.photos || []).forEach(p => {
    if (p && p.path) out.push(p.path);
    if (p && p.thumb) out.push(p.thumb);
  });
  (m.stickies || []).forEach(p => { if (p) out.push(p); });
  if (m.marker && m.marker.path) out.push(m.marker.path);
  return out;
}

/* 清空回忆：只处理「我创建的相册」，不动别人相册里的数据 */
async function wipeAllMemories() {
  const owned = (state.albums || []).filter(a => a.role === 'owner');
  const paths = [];
  for (const alb of owned) {
    try {
      const { data } = await cloud.database.from('memories').select('*').eq('album_id', alb.id);
      (data || []).forEach(r => paths.push(...memoryFilePaths(rowToMemory(r))));
    } catch (e) { /* 读取失败则跳过该相册的文件收集 */ }
  }
  for (const alb of owned) {
    try { await cloud.database.from('memories').delete().eq('album_id', alb.id); } catch (e) { /* 忽略 */ }
  }
  if (paths.length) {
    try { await cloud.storage.remove(Array.from(new Set(paths))); } catch (e) { /* 文件删除失败不阻塞 */ }
  }
  closeDanger();
  toast('回忆已清空');
  try { await loadMemories(); } catch (e) { /* 忽略 */ }
  renderStats(); renderList(); renderFilmstrip();
}

/* 注销账号：删我创建的相册及其回忆/成员/邀请/在线，删我的成员关系、资料与文件，然后退出 */
async function deleteAccount() {
  const uid = state.user.id;
  const albums = state.albums || [];
  const owned = albums.filter(a => a.role === 'owner');

  const paths = [];
  for (const alb of owned) {
    if (alb.cover_path) paths.push(alb.cover_path);
    try {
      const { data } = await cloud.database.from('memories').select('*').eq('album_id', alb.id);
      (data || []).forEach(r => paths.push(...memoryFilePaths(rowToMemory(r))));
    } catch (e) { /* 忽略 */ }
  }
  if (state.profile && state.profile.avatar_path) paths.push(state.profile.avatar_path);
  try { paths.push(cloud.storage.sharedPath(uid, 'profile_extra.json')); } catch (e) { /* 忽略 */ }

  for (const alb of owned) {
    try { await cloud.database.from('memories').delete().eq('album_id', alb.id); } catch (e) { /* 忽略 */ }
    try { await cloud.database.from('album_members').delete().eq('album_id', alb.id); } catch (e) { /* 忽略 */ }
    try { await cloud.database.from('album_invites').delete().eq('album_id', alb.id); } catch (e) { /* 忽略 */ }
    try { await cloud.database.from('album_presence').delete().eq('album_id', alb.id); } catch (e) { /* 忽略 */ }
    try { await cloud.database.from('albums').delete().eq('id', alb.id); } catch (e) { /* 忽略 */ }
  }
  try { await cloud.database.from('album_members').delete().eq('user_id', uid); } catch (e) { /* 忽略 */ }
  try { await cloud.database.from('album_presence').delete().eq('user_id', uid); } catch (e) { /* 忽略 */ }
  try { await cloud.database.from('album_invites').delete().eq('phone', (state.profile && state.profile.phone) || ''); } catch (e) { /* 忽略 */ }
  if (paths.length) {
    try { await cloud.storage.remove(Array.from(new Set(paths))); } catch (e) { /* 忽略 */ }
  }
  try { await cloud.database.from('profiles').delete().eq('id', uid); } catch (e) { /* 忽略 */ }

  try { localStorage.removeItem('ltm_album_' + uid); } catch (e) { /* 忽略 */ }
  closeDanger();
  toast('账号数据已删除，正在退出…');
  try { await cloud.auth.signOut(); } catch (e) { /* 忽略 */ }
  setTimeout(() => {
    const cb = $('#agreePolicy');
    if (cb) cb.checked = false;
    showAuth();
  }, 600);
}

/* 新增 UI 的事件绑定（在 boot 里随 bindUI 一起调用） */
function bindExtras() {  $('#otdClose').addEventListener('click', () => $('#otdModal').classList.add('hidden'));
  $('#otdLater').addEventListener('click', () => $('#otdModal').classList.add('hidden'));
  $('#otdModal').addEventListener('click', e => {
    if (e.target === $('#otdModal')) $('#otdModal').classList.add('hidden');
  });
  $('#otdView').addEventListener('click', () => {
    $('#otdModal').classList.add('hidden');
    if (otdMemoryId) openDetail(otdMemoryId, true);
  });

  $('#timelineClose').addEventListener('click', closeTimeline);
  $('#timelineView').addEventListener('click', e => {
    if (e.target === $('#timelineView')) closeTimeline();
  });

  // Esc 依次关闭 时光流 → 那年今日 → 年度回顾
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const tl = $('#timelineView');
    if (tl && !tl.classList.contains('hidden')) { closeTimeline(); return; }
    const otd = $('#otdModal');
    if (otd && !otd.classList.contains('hidden')) { otd.classList.add('hidden'); return; }
    const yr = $('#yearModal');
    if (yr && !yr.classList.contains('hidden')) { yr.classList.add('hidden'); return; }
    const dg = $('#dangerModal');
    if (dg && !dg.classList.contains('hidden')) closeDanger();
  });
  $('#routeToggle').addEventListener('click', toggleRoute);

  /* 年度回顾 */
  $('#yearClose').addEventListener('click', () => $('#yearModal').classList.add('hidden'));
  $('#yearModal').addEventListener('click', e => {
    if (e.target === $('#yearModal')) $('#yearModal').classList.add('hidden');
  });
  $('#yearPrev').addEventListener('click', () => yearStep(-1));
  $('#yearNext').addEventListener('click', () => yearStep(1));
  $('#yearCopy').addEventListener('click', copyYearText);

  /* 登录协议勾选：记住上次的选择 */
  try {
    if (localStorage.getItem('ltm_agree') === '1') {
      const cb = $('#agreePolicy');
      if (cb) cb.checked = true;
    }
  } catch (e) { /* 忽略 */ }
  const agree = $('#agreePolicy');
  if (agree) {
    agree.addEventListener('change', () => {
      try { localStorage.setItem('ltm_agree', agree.checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
      if (agree.checked) showAuthError('');
    });
  }

  /* 账户与数据（危险操作） */
  const wipeBtn = $('#btnWipeData');
  if (wipeBtn) wipeBtn.addEventListener('click', () => {
    openDanger({
      title: '清空全部回忆',
      word: '清空',
      desc: '将永久删除你在<b>自己创建的相册</b>里的全部回忆、照片、便签与封面。<br>账号本身会保留。此操作<b>不可恢复</b>。',
      onConfirm: wipeAllMemories
    });
  });
  const delBtn = $('#btnDeleteAccount');
  if (delBtn) delBtn.addEventListener('click', () => {
    openDanger({
      title: '注销账号',
      word: '注销',
      desc: '将永久删除你创建的相册及其全部回忆、照片、封面，以及你的个人资料与头像，并退出登录。<br>此操作<b>不可恢复</b>。',
      onConfirm: deleteAccount
    });
  });
  $('#dangerClose').addEventListener('click', closeDanger);
  $('#dangerCancel').addEventListener('click', closeDanger);
  $('#dangerOk').addEventListener('click', runDanger);
  $('#dangerModal').addEventListener('click', e => {
    if (e.target === $('#dangerModal')) closeDanger();
  });
  $('#dangerInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runDanger(); }
  });
}

/* ============================================================
 * 腾讯位置服务：逆地址解析 / 正向搜索 / POI 联想
 * 使用 JS API GL 的 service 库，坐标即 GCJ-02，与数据库一致。
 * 解析失败不阻塞打点：所有地址框始终可手动填写，回忆照常保存。
 * ============================================================ */
function debounce(fn, ms) {
  let t = null;
  return function () {
    const a = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(self, a), ms);
  };
}

let geocoder = null;
function getGeocoder() {
  if (!geocoder && window.TMap && TMap.service && TMap.service.Geocoder) {
    geocoder = new TMap.service.Geocoder();
  }
  return geocoder;
}
function locOf(loc) {
  if (!loc) return { lat: NaN, lng: NaN };
  const lat = typeof loc.getLat === 'function' ? loc.getLat() : (loc.lat != null ? loc.lat : loc.latNum);
  const lng = typeof loc.getLng === 'function' ? loc.getLng() : (loc.lng != null ? loc.lng : loc.lngNum);
  return { lat: Number(lat), lng: Number(lng) };
}
/* 腾讯 WebService 的行政区划在 address_component（单数）/ ad_info 里，
 * 不是 Nominatim 那套 address_components（复数）——读错会让省市区三栏全空。
 * 结构化字段缺失时再从完整地址字符串解析兜底。 */
function parseAddressText(s) {
  const out = { province: '', city: '', district: '' };
  let rest = String(s || '').replace(/^中国[,，\s]*/, '').trim();
  let m = rest.match(/^([^,，\s]{2,12}?(?:省|自治区|特别行政区))/);
  if (m) { out.province = m[1]; rest = rest.slice(m[1].length); }
  m = rest.match(/^([^,，\s]{2,14}?(?:市|自治州|地区|盟))/);
  if (m) { out.city = m[1]; rest = rest.slice(m[1].length); }
  m = rest.match(/^([^,，\s]{2,14}?(?:区|县|旗))/);
  if (m) out.district = m[1];
  if (!out.province && /^(北京|天津|上海|重庆)/.test(out.city)) out.province = out.city;
  return out;
}
function addrParts(r) {
  r = r || {};
  // 逆解析=address_component(单数)，正向解析=address_components(复数)，
  // POI 提示把 province/city/district 直接放在顶层，三种都要认
  const ac = r.address_component || r.address_components || r.ad_info || r;
  const out = {
    province: ac.province || ac.state || '',
    city: ac.city || '',
    district: ac.district || ac.county || ''
  };
  if ((!out.province || !out.city || !out.district) && r.address) {
    const t = parseAddressText(r.address);
    out.province = out.province || t.province;
    out.city = out.city || t.city;
    out.district = out.district || t.district;
  }
  if (!out.province && /^(北京|天津|上海|重庆)/.test(out.city)) out.province = out.city;
  return out;
}

/* 逆地址解析：GCJ-02 坐标 → 省 / 市 / 区 / 详细地址 */
let lastGeoError = '';
async function reverseGeocode(lat, lng, isStale) {
  lastGeoError = '';
  try {
    const g = getGeocoder();
    if (!g) return null;
    const res = await g.getAddress({ location: new TMap.LatLng(lat, lng) });
    if (isStale && isStale()) return null;   // 期间又点了别处，丢弃过期结果
    if (res && Number(res.status || 0) !== 0) { lastGeoError = res.message || ''; return null; }
    const r = res && res.result;
    if (!r) return null;
    if (Number(r.status || 0) !== 0) { lastGeoError = r.message || ''; return null; }
    const p = addrParts(r);
    const fa = r.formatted_addresses || {};
    return {
      province: p.province, city: p.city, district: p.district,
      recommend: fa.recommend || r.address || [p.province, p.city, p.district].filter(Boolean).join(' '),
      title: r.title || fa.recommend || ''
    };
  } catch (e) { lastGeoError = (e && e.message) || ''; return null; }
}

/* 解析失败的友好提示：区分白名单 / 免费额度用尽 / 一般网络问题，
 * 但无论哪种都明确告诉用户可以手动填写，且点位已选好、回忆照常可保存 */
function geoFailMessage(tail) {
  const m = lastGeoError || '';
  if (/每日调用量|达到上限|配额|quota|over.?limit/i.test(m)) {
    return '地址解析失败，可手动填写：个人 Key 今日免费额度已用完，次日自动恢复' + (tail || '');
  }
  if (/来源域名未被授权|无来源信息|not authorized|referer|signature|鉴权/i.test(m)) {
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      return '地址解析失败：当前是本地预览，腾讯白名单会拦截；请用系统浏览器打开线上链接（仍可手动填写）' + (tail || '');
    }
    return '地址解析失败，可手动填写：请在腾讯位置服务控制台把当前域名加入 Key 的域名白名单' + (tail || '');
  }
  return '地址解析失败，可手动填写' + (tail || '');
}

/* ============================================================
 * 离线兜底：腾讯 WebService 被白名单 / 额度 / 网络拦住时，
 * 用内置城市中心点按最近邻推断省 / 市，保证编辑栏不会全空。
 * 区县不做猜测（容易填错），留给用户手填。
 * ============================================================ */
const REGION_CENTERS = [
  ['北京市', '北京市', 39.90, 116.41], ['天津市', '天津市', 39.13, 117.20],
  ['上海市', '上海市', 31.23, 121.47], ['重庆市', '重庆市', 29.56, 106.55],
  ['河北省', '石家庄市', 38.04, 114.51], ['山西省', '太原市', 37.87, 112.55],
  ['内蒙古自治区', '呼和浩特市', 40.84, 111.75], ['辽宁省', '沈阳市', 41.80, 123.43],
  ['吉林省', '长春市', 43.88, 125.32], ['黑龙江省', '哈尔滨市', 45.80, 126.53],
  ['江苏省', '南京市', 32.06, 118.80], ['浙江省', '杭州市', 30.27, 120.16],
  ['安徽省', '合肥市', 31.82, 117.23], ['福建省', '福州市', 26.07, 119.30],
  ['江西省', '南昌市', 28.68, 115.86], ['山东省', '济南市', 36.65, 117.12],
  ['河南省', '郑州市', 34.75, 113.63], ['湖北省', '武汉市', 30.59, 114.31],
  ['湖南省', '长沙市', 28.23, 112.94], ['广东省', '广州市', 23.13, 113.26],
  ['广西壮族自治区', '南宁市', 22.82, 108.37], ['海南省', '海口市', 20.04, 110.32],
  ['四川省', '成都市', 30.57, 104.07], ['贵州省', '贵阳市', 26.65, 106.63],
  ['云南省', '昆明市', 25.04, 102.71], ['西藏自治区', '拉萨市', 29.65, 91.13],
  ['陕西省', '西安市', 34.34, 108.94], ['甘肃省', '兰州市', 36.06, 103.83],
  ['青海省', '西宁市', 36.62, 101.78], ['宁夏回族自治区', '银川市', 38.49, 106.23],
  ['新疆维吾尔自治区', '乌鲁木齐市', 43.83, 87.62],
  ['浙江省', '宁波市', 29.87, 121.55], ['浙江省', '温州市', 27.99, 120.70],
  ['江苏省', '苏州市', 31.30, 120.62], ['江苏省', '无锡市', 31.49, 120.31],
  ['广东省', '深圳市', 22.54, 114.06], ['广东省', '珠海市', 22.27, 113.58],
  ['山东省', '青岛市', 36.07, 120.38], ['辽宁省', '大连市', 38.91, 121.61],
  ['福建省', '厦门市', 24.48, 118.09], ['湖北省', '黄石市', 30.20, 115.04],
  ['河南省', '洛阳市', 34.62, 112.45], ['四川省', '绵阳市', 31.47, 104.74],
  ['河北省', '唐山市', 39.63, 118.18], ['浙江省', '金华市', 29.08, 119.65]
];
function offlineRegion(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return { province: '', city: '', district: '' };
  const k = Math.cos(Number(lat) * Math.PI / 180);
  let best = null, bd = Infinity;
  REGION_CENTERS.forEach(r => {
    const dLat = r[2] - Number(lat), dLng = (r[3] - Number(lng)) * k;
    const d = dLat * dLat + dLng * dLng;
    if (d < bd) { bd = d; best = r; }
  });
  if (!best || Math.sqrt(bd) > 2.0) return { province: '', city: '', district: '' };
  return { province: best[0], city: best[1], district: '' };
}
/* 在线搜索全失败时，从已经保存过的回忆里按地名离线匹配 */
function localMemoryMatch(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const out = [];
  (state.memories || []).forEach(m => {
    if (out.length >= 6) return;
    const hay = [m.name, m.address, m.province, m.city, m.district].filter(Boolean).join(' ').toLowerCase();
    const nm = String(m.name || '').toLowerCase();
    if (hay.indexOf(s) >= 0 || (nm && s.indexOf(nm) >= 0)) {
      out.push({
        lat: m.lat, lng: m.lng,
        province: m.province || '', city: m.city || '', district: m.district || '',
        title: m.name || '', recommend: m.address || ''
      });
    }
  });
  return out;
}

/* 关键词地点搜索：GL SDK 用 TMap.service.Suggestion 做输入提示，
 * 它返回带坐标的候选，最适合「西湖 / 中国计量大学 / xx小区」这类地点名。 */
let suggester = null;
function getSuggester() {
  if (!suggester && window.TMap && TMap.service && TMap.service.Suggestion) {
    suggester = new TMap.service.Suggestion({ pageSize: 6, regionFix: false });
  }
  return suggester;
}
function normalizePoi(it) {
  const p = locOf(it.location);
  const a = addrParts(it);           // POI 的 ad_info 里有行政区划
  return {
    lat: p.lat, lng: p.lng,
    province: a.province, city: a.city, district: a.district,
    title: it.title || it.name || '',
    recommend: it.address || it.title || ''
  };
}
async function poiSuggest(q) {
  const svc = getSuggester();
  if (!svc) return [];
  const res = await svc.getSuggestions({ keyword: q });
  if (res && Number(res.status || 0) !== 0) { lastGeoError = res.message || ''; return []; }
  const data = (res && Array.isArray(res.data)) ? res.data : [];
  return data.map(normalizePoi).filter(x => isFinite(x.lat) && isFinite(x.lng));
}

/* 正向定位：① 关键词地点搜索（POI）② 标准地址解析，任一命中即可。
 * 腾讯返回 GCJ-02 坐标，可直接入库。 */
async function forwardGeocode(q) {
  lastGeoError = '';
  try {
    const list = await poiSuggest(q);
    if (list.length) return list;
  } catch (e) { lastGeoError = (e && e.message) || ''; }
  try {
    const g = getGeocoder();
    if (!g) return [];
    const res = await g.getLocation({ address: q });
    if (res && Number(res.status || 0) !== 0) { lastGeoError = res.message || lastGeoError; return []; }
    const r = res && res.result;
    if (!r || !r.location) return [];
    const p = locOf(r.location);
    if (!isFinite(p.lat) || !isFinite(p.lng)) return [];
    const a = addrParts(r);
    const fa = r.formatted_addresses || {};
    return [{
      lat: p.lat, lng: p.lng,
      province: a.province, city: a.city, district: a.district,
      title: r.title || fa.recommend || String(r.address || q).split(',')[0].trim(),
      recommend: fa.recommend || r.address || q
    }];
  } catch (e) { lastGeoError = (e && e.message) || lastGeoError; }
  return [];
}

// 把候选地点写回表单并飞过去（搜索已带地址，跳过再次逆解析）
function applyLocated(info) {
  if (!state.mapReady) return;
  // 搜索结果若没带行政区划，就交给点击链路的逆解析补全省 / 市 / 区
  const hasRegion = !!(info.province || info.city || info.district);
  setFormLocation(info.lat, info.lng, { skipGeocode: hasRegion });
  flyTo({ lat: info.lat, lng: info.lng });
  $('#fProvince').value = info.province || '';
  $('#fCity').value = info.city || '';
  $('#fDistrict').value = info.district || '';
  if ($('#fDetail')) $('#fDetail').value = info.recommend || '';
  if (!$('#fName').value && info.title) $('#fName').value = info.title;
  hideSuggest();
  toast('已定位到 ' + (info.title || info.recommend || '目标地点'));
}

async function searchAndLocate(q) {
  q = (q || '').trim();
  if (!q) { toast('请输入地点或地址', true); return; }
  if (!state.form) { toast('请先点「＋添加回忆」打开编辑栏', true); return; }
  const btn = $('#fSearchBtn');
  if (btn) { btn.disabled = true; btn.textContent = '搜索中'; }
  try {
    let list = await forwardGeocode(q);
    if (!list.length) {
      // 在线搜索全失败时，先在自己已保存的回忆里离线找同名地点
      list = localMemoryMatch(q);
      if (list.length) {
        if (list.length === 1) { applyLocated(list[0]); hideSuggest(); }
        else renderSuggest(list);
        toast(list.length === 1 ? '已在你的回忆里找到并定位' : '在你的回忆里找到 ' + list.length + ' 个结果，点选定位');
        return;
      }
      hideSuggest();
      toast(lastGeoError ? geoFailMessage('；也可直接点地图选点')
        : '没找到这个地点，换个简短关键词（如「西湖」）或直接点地图选点', true);
      return;
    }
    if (list.length === 1) { applyLocated(list[0]); hideSuggest(); return; }
    renderSuggest(list);
    toast('找到 ' + list.length + ' 个结果，点选一个定位');
  } catch (e) {
    hideSuggest();
    lastGeoError = (e && e.message) || '';
    toast(geoFailMessage('；也可直接点地图选点'), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '定位'; }
  }
}

/* 输入联想：用 Suggestion 列候选，过期结果丢弃，失败静默不影响主流程 */
let suggestSeq = 0;
function querySuggest(q) {
  const seq = ++suggestSeq;
  poiSuggest(q).then(list => {
    if (seq === suggestSeq) renderSuggest(list);
  }).catch(() => { if (seq === suggestSeq) hideSuggest(); });
}

/* 候选列表：点击即定位 */
let suggestList = [];
function renderSuggest(list) {
  const box = $('#fSuggest');
  if (!box) return;
  suggestList = list || [];
  if (!suggestList.length) { hideSuggest(); return; }
  box.innerHTML = suggestList.map((it, i) =>
    `<div class="sg-item" data-i="${i}"><span class="sg-t">${esc(it.title || it.recommend)}</span>` +
    `<span class="sg-a">${esc(it.recommend)}</span></div>`
  ).join('');
  box.classList.remove('hidden');
}
function hideSuggest() {
  const b = $('#fSuggest');
  if (b) { b.classList.add('hidden'); b.innerHTML = ''; }
}

/* ============================================================
 * 渲染
 * ============================================================ */
function renderStats() {
  const n = state.memories.length;
  let pc = 0;
  state.memories.forEach(m => { pc += (m.photos || []).length; });
  const prov = new Set(state.memories.map(m => m.province).filter(Boolean)).size;
  $('#stats').innerHTML = `已收藏 <b>${n}</b> 段回忆 · <b>${pc}</b> 张照片 · <b>${prov}</b> 个省份`;
}

function renderEmptyState() {
  $('#emptyState').classList.toggle('hidden', state.memories.length > 0);
}

function visibleMemories() {
  const q = (state.search || '').toLowerCase();
  return state.memories.filter(m => {
    if (state.filter.mood && m.mood !== state.filter.mood) return false;
    if (state.filter.weather && m.weather !== state.filter.weather) return false;
    if (!q) return true;
    return (m.name + m.province + m.city + m.district + (m.memory || '')).toLowerCase().includes(q);
  });
}

function renderList() {
  const box = $('#placeList');
  const filtered = visibleMemories();

  if (!filtered.length) {
    box.innerHTML = `<div class="list-empty">${state.memories.length ? '这个筛选下没有回忆，换个条件试试' : '还没有回忆，打开「编辑」添加第一段吧'}</div>`;
    return;
  }

  const groups = new Map();
  filtered.forEach(m => {
    const key = m.province || '未标注省份';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  let html = '';
  groups.forEach((arr, prov) => {
    html += `<div class="pv-group"><div class="pv-group-title">📍 ${esc(prov)} <span class="cnt">${arr.length}</span></div>`;
    arr.forEach(m => {
      const thumb = (m.photos && m.photos[0] && m.photos[0].thumb) ? m.photos[0].thumb : null;
      const thumbUrl = thumb ? urlOf(thumb) : '';
      const img = thumbUrl
        ? `<img class="pv-thumb" loading="lazy" src="${esc(thumbUrl)}" alt="">`
        : `<div class="pv-nothumb">${moodOf(m.mood).emoji || '❤'}</div>`;
      const bits = [m.city || '', m.date ? fmtDate(m.date) : ''].filter(Boolean);
      const tags = [moodOf(m.mood).emoji, weatherOf(m.weather).emoji].filter(Boolean).join(' ');
      const sub = (tags ? tags + ' · ' : '') + bits.join(' · ');
      html += `<div class="pv-item ${m.id === state.selectedId ? 'active' : ''}" data-id="${esc(String(m.id))}">
          ${img}
          <div class="pv-info">
            <div class="pv-name">${esc(m.name)}</div>
            <div class="pv-sub">${esc(sub)}</div>
          </div>
          <span class="pv-arrow">›</span>
        </div>`;
    });
    html += '</div>';
  });
  box.innerHTML = html;

  box.querySelectorAll('.pv-item').forEach(el => {
    el.addEventListener('click', () => {
      const raw = el.dataset.id;
      openDetail(isNaN(Number(raw)) ? raw : Number(raw), true);
    });
  });
}

/* ============================================================
 * 详情面板
 * ============================================================ */
function openDetail(id, shouldFly) {
  const m = state.memories.find(x => x.id === id);
  if (!m) return;
  state.selectedId = id;
  state.editingId = null;
  state.pickMode = false;
  clearPicker();

  $('#formView').classList.add('hidden');
  $('#detailView').classList.remove('hidden');
  $('#panel').classList.remove('hidden');
  document.body.classList.remove('sidebar-open');
  $('#emptyState').classList.add('hidden');

  $('#dName').textContent = m.name;
  // 每行只转义用户文本，<span class="muted"> 是我们自己的标记，不转义
  const metaLines = [];
  const place = [m.province, m.city, m.district].filter(Boolean).join(' · ');
  if (place) metaLines.push(esc('📍 ' + place));
  if (m.address) metaLines.push('<span class="muted">' + esc(m.address) + '</span>');
  if (m.date) metaLines.push(esc('🗓 ' + fmtDate(m.date)));
  $('#dMeta').innerHTML = metaLines.join('<br>');

  const md = moodOf(m.mood), wd = weatherOf(m.weather);
  const chips = [];
  if (md.emoji) chips.push(`<span class="tag">${md.emoji} ${esc(md.label)}</span>`);
  if (wd.emoji) chips.push(`<span class="tag weather">${wd.emoji} ${esc(wd.label)}</span>`);
  const stickyCnt = (m.stickies || []).length;
  if (stickyCnt) chips.push(`<span class="tag" style="background:#FFE1EE">✍️ ${stickyCnt} 张便签</span>`);
  $('#dChips').innerHTML = chips.join('');

  renderDetailStickies(m);

  const photos = m.photos || [];
  if (photos.length) {
    $('#dPhotos').innerHTML = photos.map((p, i) => {
      const u = urlOf(p.thumb || p.path);
      return `<div class="ph" data-i="${i}">
        <img loading="lazy" src="${esc(u)}" alt="">
        ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}
      </div>`;
    }).join('');
    $('#dPhotos').querySelectorAll('.ph').forEach(el => {
      el.addEventListener('click', () => openLightbox(m, Number(el.dataset.i)));
    });
  } else {
    $('#dPhotos').innerHTML = '<div class="photo-empty">这段回忆还没有照片</div>';
  }

  $('#dMemory').innerHTML = m.memory ? nl2br(m.memory) : '<span style="color:var(--ink-soft)">还没有写下回忆文字</span>';

  refreshMarkers();
  renderList();
  if (shouldFly) flyTo(m);
}

function closePanel() {
  $('#panel').classList.add('hidden');
  state.selectedId = null;
  state.pickMode = false;
  clearPicker();
  refreshMarkers();
  renderList();
}

/* ============================================================
 * 灯箱
 * ============================================================ */
let lbCtx = null;

function openLightbox(m, index) {
  lbCtx = { memory: m, index };
  showLbPhoto();
  $('#lightbox').classList.remove('hidden');
}

function showLbPhoto() {
  const m = lbCtx.memory;
  const photos = m.photos || [];
  const p = photos[lbCtx.index];
  if (!p) return;
  $('#lbImg').src = urlOf(p.path);
  $('#lbCaption').textContent = p.caption || m.name;
  $('#lbCounter').textContent = `${lbCtx.index + 1} / ${photos.length}`;
}

function stepLightbox(dir) {
  const photos = lbCtx.memory.photos || [];
  if (!photos.length) return;
  lbCtx.index = (lbCtx.index + dir + photos.length) % photos.length;
  showLbPhoto();
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lbImg').src = '';
  lbCtx = null;
}

/* ============================================================
 * 添加 / 编辑表单
 * ============================================================ */
function openForm(editId) {
  if (state.viewer) { toast('访客模式只能浏览，不能修改 TA 的地图', true); return; }
  const m = editId ? state.memories.find(x => x.id === editId) : null;
  if (editId && !m) return;

  state.editingId = editId || null;
  state.selectedId = null;
  state.pickMode = true;
  state.form = {
    lat: m ? m.lat : null,
    lng: m ? m.lng : null,
    marker: m ? (m.marker || { type: 'default' }) : { type: 'default' },
    mood: m ? (m.mood || '') : '',
    weather: m ? (m.weather || '') : '',
    stickies: (m ? (m.stickies || []) : []).map(p => ({
      path: p, previewUrl: urlOf(p), isNew: false, blob: null
    })),
    photos: (m ? (m.photos || []) : []).map(p => ({
      path: p.path, thumb: p.thumb, caption: p.caption || '',
      previewUrl: urlOf(p.thumb || p.path),
      isNew: false, mainBlob: null, thumbBlob: null
    }))
  };

  $('#detailView').classList.add('hidden');
  $('#formView').classList.remove('hidden');
  $('#panel').classList.remove('hidden');
  document.body.classList.remove('sidebar-open');
  $('#emptyState').classList.add('hidden');

  $('#formTitle').textContent = m ? '编辑回忆' : '添加回忆';
  $('#fName').value = m ? m.name : '';
  $('#fProvince').value = m ? (m.province || '') : '';
  $('#fCity').value = m ? (m.city || '') : '';
  $('#fDistrict').value = m ? (m.district || '') : '';
  $('#fDate').value = m ? (m.date || '') : new Date().toISOString().slice(0, 10);
  $('#fMemory').value = m ? (m.memory || '') : '';
  $('#fDetail').value = m ? (m.address || '') : '';
  $('#fSearch').value = '';
  hideSuggest();

  renderFormPhotos();
  renderMoodPicker();
  renderWeatherPicker();
  renderFormStickies();
  initMarkerPicker();
  updatePicker();
  updatePickHint();
  refreshMarkers();
  renderList();
  if (m) flyTo(m);
  if (!m) toast('在地图上点一下，标记你们去过的地方 💕');
}

let addrSeq = 0;

function setFormLocation(lat, lng, opts) {
  if (!state.form) return;
  opts = opts || {};
  state.form.lat = lat;
  state.form.lng = lng;
  updatePicker();
  updatePickHint();

  // 搜索结果已自带地址，无需再逆解析
  if (opts.skipGeocode) { addrSeq++; return; }
  fillAddressFromPoint(lat, lng);   // 腾讯地图与数据库同为 GCJ-02，无需转换
}

/* 点地图后立即回填右侧编辑栏：省 / 市 / 区 / 详细地址 */
async function fillAddressFromPoint(lat, lng) {
  const seq = ++addrSeq;
  const sels = ['#fProvince', '#fCity', '#fDistrict', '#fDetail'];
  const d = $('#fDetail');
  sels.forEach(s => { const el = $(s); if (el) el.classList.add('addr-resolving'); });
  if (d) d.value = '📍 正在获取详细地址…';

  const info = await reverseGeocode(lat, lng, () => seq !== addrSeq);
  if (seq !== addrSeq) return;   // 期间又点了别处，丢弃这次过期结果
  sels.forEach(s => { const el = $(s); if (el) el.classList.remove('addr-resolving'); });

  if (!info) {
    // 在线解析失败（预览环境白名单 / 额度 / 断网）时，至少按坐标补出省 / 市，
    // 不让三栏全是空的 placeholder；区县和详细地址仍可手填、不影响保存。
    const off = offlineRegion(lat, lng);
    if (off.province) {
      $('#fProvince').value = off.province;
      $('#fCity').value = off.city;
      if (d) d.value = '';
      toast('地址解析失败，已按位置填入省 / 市；区县和详细地址可手动填写', true);
    } else {
      if (d) d.value = '';
      toast(geoFailMessage('（地图点位已选好）'), true);
    }
    return;
  }
  $('#fProvince').value = info.province || '';
  $('#fCity').value = info.city || '';
  $('#fDistrict').value = info.district || '';
  if (d) d.value = info.recommend || [info.province, info.city, info.district].filter(Boolean).join(' ');
  if (!$('#fName').value) $('#fName').placeholder = '例如：' + (info.title || info.district || '西湖·断桥');
  toast('📍 地址已自动填充');
}

function updatePicker() {
  if (!state.mapReady) return;
  const f = state.form;
  const geos = (f && f.lat != null && f.lng != null)
    ? [{ id: 'picker', styleId: 'pin', position: new TMap.LatLng(f.lat, f.lng) }]
    : [];
  if (state.pickerLayer) { state.pickerLayer.setMap(null); state.pickerLayer = null; }
  state.pickerLayer = makePickerLayer(geos);
}

function clearPicker() {
  if (state.pickerLayer && state.mapReady) {
    state.pickerLayer.setMap(null);
    state.pickerLayer = null;
    state.pickerLayer = makePickerLayer([]);
  }
  updatePickHint();
}

function updatePickHint() {
  const hint = $('#pickHint');
  if (!state.pickMode) { hint.classList.add('hidden'); return; }
  hint.classList.remove('hidden');
  hint.textContent = state.form && state.form.lat != null
    ? '📍 已选好位置，可继续点击调整，然后填写右侧表单'
    : '📍 点击地图，选择回忆发生的地方';
}

/* ---------------- 照片选择与压缩 ---------------- */
async function shrinkImage(file, maxSide, quality) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('该图片格式无法处理（HEIC 请先转为 JPG）'));
      img.src = URL.createObjectURL(file);
    });
  }
  const iw = bmp.width, ih = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('图片处理失败');
  return blob;
}

async function addPendingPhotos(files) {
  if (!state.form) return;
  const imgs = files.filter(f => f.type.startsWith('image/'));
  if (!imgs.length) { toast('请选择图片文件', true); return; }
  for (const f of imgs) {
    if (!/image\/(jpeg|png|webp|gif)/.test(f.type)) {
      toast(`「${f.name}」格式暂不支持，请使用 JPG / PNG / WebP`, true);
      continue;
    }
    if (f.size > 60 * 1024 * 1024) { toast(`「${f.name}」太大（超过 60MB）`, true); continue; }
    try {
      const mainBlob = await shrinkImage(f, 2400, 0.87);
      const thumbBlob = await shrinkImage(f, 480, 0.8);
      state.form.photos.push({
        path: null, thumb: null, caption: '',
        previewUrl: URL.createObjectURL(thumbBlob),
        isNew: true, mainBlob, thumbBlob
      });
    } catch (e) {
      toast(e.message || '照片处理失败', true);
    }
    renderFormPhotos();
  }
}

function renderFormPhotos() {
  const box = $('#photoList');
  const photos = state.form ? state.form.photos : [];
  if (!photos.length) { box.innerHTML = ''; return; }
  box.innerHTML = photos.map((p, i) => `
    <div class="pe-item">
      <img src="${esc(p.previewUrl)}" alt="">
      <button class="pe-remove" data-i="${i}" title="移除">✕</button>
      <input class="pe-cap" data-i="${i}" placeholder="配一句话…" value="${esc(p.caption)}" maxlength="60">
    </div>`).join('');
  box.querySelectorAll('.pe-remove').forEach(el => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      const p = state.form.photos[i];
      if (p.previewUrl && p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl);
      state.form.photos.splice(i, 1);
      renderFormPhotos();
    });
  });
  box.querySelectorAll('.pe-cap').forEach(el => {
    el.addEventListener('input', () => {
      state.form.photos[Number(el.dataset.i)].caption = el.value;
    });
  });
}

/* ---------------- 地图标记：默认 / 手绘 / 照片 ---------------- */
const PALETTE = ['#ff2d55', '#e74c3c', '#f39c12', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#8d6e63', '#333333', '#ffffff'];

const draw = { ctx: null, strokes: [], cur: null, color: '#ff2d55', size: 8, eraser: false };

function initMarkerPicker() {
  const f = state.form;
  const type = (f && f.marker && f.marker.type) || 'default';
  document.querySelectorAll('#markerPicker .mk-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.mk === type);
  });
  const preview = $('#markerPreview'), photoList = $('#markerPhotoList'), hint = $('#markerHint');
  if (type === 'draw' && f.marker.data) {
    $('#markerPreviewImg').src = f.marker.data;
    preview.classList.remove('hidden');
    photoList.classList.add('hidden');
    hint.textContent = '已使用手绘标记，点「重新绘制」可修改';
  } else if (type === 'draw') {
    preview.classList.add('hidden');
    photoList.classList.add('hidden');
    hint.textContent = '点击「手绘标记」开始创作（未绘制时地图上暂显示默认爱心）';
  } else if (type === 'photo') {
    preview.classList.add('hidden');
    photoList.classList.remove('hidden');
    renderMarkerPhotoList();
    hint.textContent = f.marker.path ? '已选择照片作为地图标记' : '从下方选择一张已保存的照片作为标记';
  } else {
    preview.classList.add('hidden');
    photoList.classList.add('hidden');
    hint.textContent = '';
  }
}

function selectMkType(t) {
  if (!state.form) return;
  if (t === 'draw') {
    state.form.marker = state.form.marker.type === 'draw' ? state.form.marker : { type: 'draw' };
    initMarkerPicker();
    openDraw();
  } else if (t === 'photo') {
    state.form.marker = state.form.marker.type === 'photo' ? state.form.marker : { type: 'photo' };
    initMarkerPicker();
  } else {
    state.form.marker = { type: 'default' };
    initMarkerPicker();
  }
}

function renderMarkerPhotoList() {
  const box = $('#markerPhotoList');
  const saved = (state.form ? state.form.photos : []).filter(p => p.path);
  if (!saved.length) {
    box.innerHTML = '<div class="minor">还没有已保存的照片——先把照片传好并保存，下次编辑时就能选照片标记啦</div>';
    return;
  }
  box.innerHTML = saved.map(p => `
    <button type="button" class="mk-photo ${state.form.marker.path === p.path ? 'active' : ''}">
      <img src="${esc(p.previewUrl)}" alt="">
    </button>`).join('');
  box.querySelectorAll('.mk-photo').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Array.prototype.indexOf.call(box.querySelectorAll('.mk-photo'), el);
      state.form.marker = { type: 'photo', path: saved[idx].path };
      renderMarkerPhotoList();
      $('#markerHint').textContent = '已选择照片作为地图标记';
    });
  });
}

/* ---------------- 手绘画板 ---------------- */
function openDraw() {
  if (!state.form) return;
  draw.strokes = [];
  draw.cur = null;
  const canvas = $('#drawCanvas');
  draw.ctx = canvas.getContext('2d');
  const data = state.form.marker && state.form.marker.type === 'draw' ? state.form.marker.data : null;
  if (data) {
    const img = new Image();
    img.onload = () => { if (draw.ctx) draw.ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
    img.src = data;
  } else {
    renderDraw();
  }
  buildPalette();
  updateBrushDot();
  $('#drawModal').classList.remove('hidden');
}

function closeDraw() {
  $('#drawModal').classList.add('hidden');
  draw.ctx = null;
}

function renderDraw() {
  if (!draw.ctx) return;
  const c = $('#drawCanvas');
  const ctx = draw.ctx;
  ctx.clearRect(0, 0, c.width, c.height);
  draw.strokes.forEach(s => {
    ctx.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.pts.forEach((pt, i) => {
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    if (s.pts.length === 1) ctx.lineTo(s.pts[0].x + 0.1, s.pts[0].y + 0.1);
    ctx.stroke();
  });
  ctx.globalCompositeOperation = 'source-over';
}

function canvasPos(e) {
  const c = $('#drawCanvas');
  const r = c.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (c.width / r.width),
    y: (e.clientY - r.top) * (c.height / r.height)
  };
}

function buildPalette() {
  const box = $('#drawPalette');
  box.innerHTML = PALETTE.map(c =>
    `<button type="button" class="swatch ${c === draw.color && !draw.eraser ? 'active' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`
  ).join('') + `<input type="color" id="drawCustom" value="${draw.color}" title="自定义颜色">`;
  box.querySelectorAll('.swatch').forEach(b => {
    b.addEventListener('click', () => {
      draw.color = b.dataset.c;
      draw.eraser = false;
      $('#drawEraser').classList.remove('active');
      buildPalette();
      updateBrushDot();
    });
  });
  $('#drawCustom').addEventListener('input', e => {
    draw.color = e.target.value;
    draw.eraser = false;
    $('#drawEraser').classList.remove('active');
    buildPalette();
    updateBrushDot();
  });
}

function updateBrushDot() {
  const dot = $('#brushDot');
  dot.style.width = Math.min(draw.size, 22) + 'px';
  dot.style.height = Math.min(draw.size, 22) + 'px';
  dot.style.background = draw.eraser ? '#fff' : draw.color;
  dot.style.border = '1.5px solid rgba(0,0,0,.25)';
}

function bindDrawTools() {
  const canvas = $('#drawCanvas');
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    draw.cur = {
      color: draw.color,
      size: draw.eraser ? Math.max(draw.size * 2.4, 16) : draw.size,
      eraser: draw.eraser,
      pts: [canvasPos(e)]
    };
    draw.strokes.push(draw.cur);
    renderDraw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!draw.cur) return;
    draw.cur.pts.push(canvasPos(e));
    renderDraw();
  });
  const end = () => { draw.cur = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  $('#brushSize').addEventListener('input', e => {
    draw.size = Number(e.target.value);
    updateBrushDot();
  });
  $('#drawEraser').addEventListener('click', () => {
    draw.eraser = !draw.eraser;
    $('#drawEraser').classList.toggle('active', draw.eraser);
    updateBrushDot();
  });
  $('#drawUndo').addEventListener('click', () => {
    draw.strokes.pop();
    renderDraw();
  });
  $('#drawClear').addEventListener('click', () => {
    draw.strokes = [];
    renderDraw();
  });
  $('#drawSave').addEventListener('click', () => {
    if (!draw.strokes.length) { toast('先画点什么吧 🎨', true); return; }
    const data = $('#drawCanvas').toDataURL('image/png');
    state.form.marker = { type: 'draw', data };
    closeDraw();
    initMarkerPicker();
    toast('标记已应用，保存回忆后生效 ✨');
  });
}

/* ---------------- 保存 ---------------- */
async function saveForm() {
  const f = state.form;
  if (!f) return;
  if (!state.user) { showAuth(); return; }
  if (state.viewer) return;
  const name = $('#fName').value.trim();
  if (!name) { toast('请填写回忆地点', true); $('#fName').focus(); return; }
  if (f.lat == null || f.lng == null) { toast('请先在地图上点击选择位置', true); return; }

  const btn = $('#formSave');
  btn.disabled = true;
  btn.textContent = '上传照片中…';
  try {
    const total = f.photos.filter(p => p.isNew).length;
    let i = 0;
    for (const p of f.photos) {
      if (p.isNew) {
        i++;
        btn.textContent = `上传照片 ${i}/${total}…`;
        const up = await uploadPhotoPair(state.user.id, p.mainBlob, p.thumbBlob);
        p.path = up.path; p.thumb = up.thumb; p.isNew = false;
      }
    }

    // 上传新手写便签
    const pendingNotes = f.stickies.filter(s => s.isNew && s.blob);
    let ni = 0;
    for (const s of pendingNotes) {
      ni++;
      btn.textContent = `上传便签 ${ni}/${pendingNotes.length}…`;
      const nPath = cloud.storage.sharedPath(state.user.id,
        'notes/n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7) + '.png');
      await uploadBlob(nPath, s.blob, 'image/png', '便签上传', 'note.png');
      s.path = nPath;
      s.isNew = false;
      if (s.previewUrl && s.previewUrl.startsWith('blob:')) URL.revokeObjectURL(s.previewUrl);
      s.previewUrl = urlOf(nPath);
    }
    const cleanStickies = f.stickies.map(s => s.path).filter(Boolean);

    const cleanPhotos = f.photos.map(p => ({ path: p.path, thumb: p.thumb, caption: p.caption }));
    const payload = memoryToRow({
      name, province: $('#fProvince').value.trim(), city: $('#fCity').value.trim(),
      district: $('#fDistrict').value.trim(), address: $('#fDetail').value.trim(), date: $('#fDate').value,
      memory: $('#fMemory').value.trim(), lat: f.lat, lng: f.lng, photos: cleanPhotos,
      mood: f.mood || '', weather: f.weather || '', stickies: cleanStickies,
      marker: f.marker || { type: 'default' }
    });
    payload.album_id = state.albumId;

    btn.textContent = '保存中…';
    let savedRow = null;
    if (state.editingId) {
      payload.updated_at = new Date().toISOString();
      const old = state.memories.find(x => x.id === state.editingId);
      const { data, error } = await cloud.database.from('memories')
        .update(payload).eq('id', state.editingId).select();
      if (error) throw new Error(error.message || '保存失败');
      if (!data || !data.length) throw new Error('保存失败：这段回忆可能不属于当前账号');
      savedRow = data[0];
      // 清理不再引用的旧照片
      if (old) {
        const keep = new Set();
        cleanPhotos.forEach(p => { keep.add(p.path); keep.add(p.thumb); });
        cleanStickies.forEach(p => keep.add(p));
        const orphans = [];
        (old.photos || []).forEach(p => {
          [p.path, p.thumb].forEach(k => { if (k && !keep.has(k)) orphans.push(k); });
        });
        (old.stickies || []).forEach(k => { if (k && !keep.has(k)) orphans.push(k); });
        removeStorageObjects(orphans);
      }
    } else {
      const { data, error } = await cloud.database.from('memories').insert(payload).select();
      if (error) throw new Error(error.message || '保存失败');
      savedRow = data && data[0];
    }

    f.photos.forEach(p => { if (p.previewUrl && p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl); });

    // 为新照片预签名
    try { await ensureSignedUrls(allPhotoPaths([rowToMemory(savedRow)])); } catch (e) { /* 忽略 */ }

    await loadMemories();
    openDetail(savedRow.id, false);
    toast('回忆已保存 ❤️');
  } catch (e) {
    toast(e.message || '保存失败，请重试', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存回忆';
  }
}

/* ---------------- 删除 ---------------- */
async function deleteSelected() {
  if (state.viewer) return;
  const id = state.selectedId;
  const m = state.memories.find(x => x.id === id);
  if (!m) return;
  const photoCnt = (m.photos || []).length;
  const msg = `确定删除「${m.name}」吗？\n` +
    (photoCnt ? `该回忆下的 ${photoCnt} 张照片也会一起删除，` : '') +
    '此操作不可恢复。';
  if (!window.confirm(msg)) return;
  try {
    const { data, error } = await cloud.database.from('memories').delete().eq('id', id).select();
    if (error) throw new Error(error.message || '删除失败');
    if (!data || !data.length) throw new Error('删除失败：这段回忆可能不属于当前账号');
    const paths = [];
    (m.photos || []).forEach(p => {
      if (p.path) paths.push(p.path);
      if (p.thumb && p.thumb !== p.path) paths.push(p.thumb);
    });
    removeStorageObjects(paths);
    closePanel();
    await loadMemories();
    toast('已删除');
  } catch (e) {
    toast(e.message || '删除失败', true);
  }
}

/* ============================================================
 * 心情 / 天气标签
 * ============================================================ */
const MOODS = [
  { id: 'happy',   emoji: '😊', label: '开心',     color: '#FF4D6D' },
  { id: 'touched', emoji: '🥹', label: '感动',     color: '#FF8FB1' },
  { id: 'laugh',   emoji: '🤣', label: '爆笑',     color: '#FFC53D' },
  { id: 'makep',   emoji: '😤', label: '吵架和好', color: '#A97BFF' },
  { id: 'sweet',   emoji: '🥰', label: '甜蜜',     color: '#FF6FA5' },
  { id: 'calm',    emoji: '😌', label: '安静',     color: '#2EC4B6' }
];
const MOOD_COLORS = {};
MOODS.forEach(m => { MOOD_COLORS[m.id] = m.color; });

const WEATHERS = [
  { id: 'sun',   emoji: '☀️', label: '晴' },
  { id: 'rain',  emoji: '🌧️', label: '雨' },
  { id: 'snow',  emoji: '❄️', label: '雪' },
  { id: 'cloud', emoji: '☁️', label: '阴' },
  { id: 'night', emoji: '🌙', label: '夜' },
  { id: 'fog',   emoji: '🌫️', label: '雾' }
];

function moodOf(id) { return MOODS.find(m => m.id === id) || {}; }
function weatherOf(id) { return WEATHERS.find(w => w.id === id) || {}; }

function heartSvg(fill, stroke) {
  return svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="32" height="40">' +
    '<path d="M16 29C7.5 22.5 2 17.2 2 11 2 6.6 5.4 3 9.8 3c2.6 0 5 1.4 6.2 3.8C17.2 4.4 19.6 3 22.2 3 26.6 3 30 6.6 30 11c0 6.2-5.5 11.5-14 18z" ' +
    'fill="' + fill + '" stroke="' + stroke + '" stroke-width="2"/></svg>');
}

/* ---------------- 筛选条 ---------------- */
function renderFilters() {
  const mBox = $('#moodFilter');
  const wBox = $('#weatherFilter');
  const moodCnt = {}, weatherCnt = {};
  state.memories.forEach(m => {
    if (m.mood) moodCnt[m.mood] = (moodCnt[m.mood] || 0) + 1;
    if (m.weather) weatherCnt[m.weather] = (weatherCnt[m.weather] || 0) + 1;
  });

  let h = '<span class="filter-label">mood · 心情</span>' +
    `<button class="chip ${!state.filter.mood ? 'active' : ''}" data-mood="">全部</button>`;
  MOODS.forEach(md => {
    if (!moodCnt[md.id]) return;
    h += `<button class="chip ${state.filter.mood === md.id ? 'active' : ''}" data-mood="${md.id}">${md.emoji} ${md.label} <b style="font-weight:800">${moodCnt[md.id]}</b></button>`;
  });
  mBox.innerHTML = h;

  let w = '<span class="filter-label">weather · 天气</span>' +
    `<button class="chip ${!state.filter.weather ? 'active' : ''}" data-weather="">全部</button>`;
  WEATHERS.forEach(wd => {
    if (!weatherCnt[wd.id]) return;
    w += `<button class="chip ${state.filter.weather === wd.id ? 'active' : ''}" data-weather="${wd.id}">${wd.emoji} ${wd.label}</button>`;
  });
  wBox.innerHTML = w;
}

/* ---------------- 表单里的心情 / 天气选择 ---------------- */
function renderMoodPicker() {
  const box = $('#moodPicker');
  if (!state.form) return;
  box.innerHTML = MOODS.map(md =>
    `<button type="button" class="pick-chip ${state.form.mood === md.id ? 'active' : ''}" data-mood="${md.id}">
      <span class="em">${md.emoji}</span>${md.label}</button>`
  ).join('');
  box.querySelectorAll('[data-mood]').forEach(b => {
    b.addEventListener('click', () => {
      if (!state.form) return;
      state.form.mood = state.form.mood === b.dataset.mood ? '' : b.dataset.mood;
      renderMoodPicker();
    });
  });
}

function renderWeatherPicker() {
  const box = $('#weatherPicker');
  if (!state.form) return;
  box.innerHTML = WEATHERS.map(wd =>
    `<button type="button" class="pick-chip ${state.form.weather === wd.id ? 'active' : ''}" data-weather="${wd.id}">
      <span class="em">${wd.emoji}</span>${wd.label}</button>`
  ).join('');
  box.querySelectorAll('[data-weather]').forEach(b => {
    b.addEventListener('click', () => {
      if (!state.form) return;
      state.form.weather = state.form.weather === b.dataset.weather ? '' : b.dataset.weather;
      renderWeatherPicker();
    });
  });
}

/* ============================================================
 * 手写便签
 * ============================================================ */
const stickyDraw = {
  strokes: [], cur: null, color: '#1B1B1B', size: 5, eraser: false,
  ctx: null, off: null, offCtx: null
};
const STICKY_PAPERS = ['#FFF7CF', '#FFE3EC', '#E4FF4F', '#FFE4C4', '#E3F4FF'];
let stickyPaperIdx = 0;

function openStickyBoard() {
  if (!state.form) return;
  if (state.form.stickies.length >= 3) { toast('最多贴 3 张便签哦', true); return; }
  stickyDraw.strokes = [];
  stickyDraw.cur = null;
  stickyDraw.eraser = false;
  stickyDraw.color = '#1B1B1B';
  stickyPaperIdx = state.form.stickies.length % STICKY_PAPERS.length;
  const cv = $('#stickyCanvas');
  stickyDraw.ctx = cv.getContext('2d');
  stickyDraw.off = document.createElement('canvas');
  stickyDraw.off.width = cv.width;
  stickyDraw.off.height = cv.height;
  stickyDraw.offCtx = stickyDraw.off.getContext('2d');
  buildStickyPalette();
  updateStickyDot();
  renderSticky();
  $('#stickyModal').classList.remove('hidden');
}

function closeStickyBoard() {
  $('#stickyModal').classList.add('hidden');
  stickyDraw.ctx = null;
  stickyDraw.offCtx = null;
}

function renderSticky() {
  const cv = $('#stickyCanvas');
  const ctx = stickyDraw.ctx;
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  // 纸张
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = STICKY_PAPERS[stickyPaperIdx];
  ctx.fillRect(0, 0, W, H);
  // 横线
  ctx.strokeStyle = 'rgba(0,0,0,.09)';
  ctx.lineWidth = 1;
  for (let y = 40; y < H; y += 34) {
    ctx.beginPath(); ctx.moveTo(18, y); ctx.lineTo(W - 18, y); ctx.stroke();
  }
  // 左侧竖线
  ctx.strokeStyle = 'rgba(255,92,147,.45)';
  ctx.beginPath(); ctx.moveTo(44, 0); ctx.lineTo(44, H); ctx.stroke();
  // 笔迹层
  const off = stickyDraw.offCtx;
  off.clearRect(0, 0, W, H);
  stickyDraw.strokes.forEach(s => {
    off.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
    off.strokeStyle = s.color;
    off.lineWidth = s.size;
    off.lineCap = 'round';
    off.lineJoin = 'round';
    off.beginPath();
    s.pts.forEach((pt, i) => { if (i === 0) off.moveTo(pt.x, pt.y); else off.lineTo(pt.x, pt.y); });
    if (s.pts.length === 1) off.lineTo(s.pts[0].x + 0.1, s.pts[0].y + 0.1);
    off.stroke();
  });
  off.globalCompositeOperation = 'source-over';
  ctx.drawImage(stickyDraw.off, 0, 0);
}

function stickyPos(e) {
  const c = $('#stickyCanvas');
  const r = c.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (c.width / r.width),
    y: (e.clientY - r.top) * (c.height / r.height)
  };
}

function buildStickyPalette() {
  const box = $('#stickyPalette');
  const colors = ['#1B1B1B', '#C2185B', '#1F3A6E', '#2F7A3A', '#FF7A00', '#7B3FA0', '#FFFFFF'];
  box.innerHTML = colors.map(c =>
    `<button type="button" class="swatch ${stickyDraw.color === c && !stickyDraw.eraser ? 'active' : ''}" data-c="${c}" style="background:${c}"></button>`
  ).join('') + `<input type="color" id="stickyCustom" value="${stickyDraw.color}" title="自定义颜色">`;
  box.querySelectorAll('.swatch').forEach(b => {
    b.addEventListener('click', () => {
      stickyDraw.color = b.dataset.c;
      stickyDraw.eraser = false;
      $('#stickyEraser').classList.remove('active');
      buildStickyPalette();
      updateStickyDot();
    });
  });
  $('#stickyCustom').addEventListener('input', e => {
    stickyDraw.color = e.target.value;
    stickyDraw.eraser = false;
    $('#stickyEraser').classList.remove('active');
    buildStickyPalette();
    updateStickyDot();
  });
}

function updateStickyDot() {
  const dot = $('#stickyBrushDot');
  const s = Math.min(stickyDraw.size + 6, 24);
  dot.style.width = s + 'px';
  dot.style.height = s + 'px';
  dot.style.background = stickyDraw.eraser ? '#fff' : stickyDraw.color;
  dot.style.border = '1.5px solid rgba(0,0,0,.3)';
}

function bindStickyTools() {
  const canvas = $('#stickyCanvas');
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    stickyDraw.cur = {
      color: stickyDraw.color,
      size: stickyDraw.eraser ? Math.max(stickyDraw.size * 2.6, 16) : stickyDraw.size,
      eraser: stickyDraw.eraser,
      pts: [stickyPos(e)]
    };
    stickyDraw.strokes.push(stickyDraw.cur);
    renderSticky();
  });
  canvas.addEventListener('pointermove', e => {
    if (!stickyDraw.cur) return;
    stickyDraw.cur.pts.push(stickyPos(e));
    renderSticky();
  });
  const end = () => { stickyDraw.cur = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  $('#stickyBrush').addEventListener('input', e => {
    stickyDraw.size = Number(e.target.value);
    updateStickyDot();
  });
  $('#stickyEraser').addEventListener('click', () => {
    stickyDraw.eraser = !stickyDraw.eraser;
    $('#stickyEraser').classList.toggle('active', stickyDraw.eraser);
    updateStickyDot();
  });
  $('#stickyUndo').addEventListener('click', () => {
    stickyDraw.strokes.pop();
    renderSticky();
  });
  $('#stickyClear').addEventListener('click', () => {
    stickyDraw.strokes = [];
    renderSticky();
  });
  $('#stickySave').addEventListener('click', () => {
    if (!stickyDraw.strokes.length) { toast('先写点什么吧 ✍️', true); return; }
    const cv = $('#stickyCanvas');
    cv.toBlob(blob => {
      if (!blob) { toast('便签生成失败，请重试', true); return; }
      state.form.stickies.push({
        path: null, blob, previewUrl: URL.createObjectURL(blob), isNew: true
      });
      closeStickyBoard();
      renderFormStickies();
      toast('便签已贴好，保存回忆时一起保存 ✨');
    }, 'image/png');
  });
}

function renderFormStickies() {
  const box = $('#formStickies');
  if (!box || !state.form) return;
  const list = state.form.stickies;
  if (!list.length) {
    box.innerHTML = '<div class="minor">还没有便签</div>';
    return;
  }
  box.innerHTML = list.map((s, i) =>
    `<div class="sticky-note" data-i="${i}">
      <img src="${esc(s.previewUrl || urlOf(s.path))}" alt="便签">
      <button type="button" class="sticky-del" data-del="${i}" title="删除">✕</button>
    </div>`
  ).join('');
  box.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      const i = Number(b.dataset.del);
      const rm = list.splice(i, 1)[0];
      if (rm && rm.previewUrl && rm.previewUrl.startsWith('blob:')) URL.revokeObjectURL(rm.previewUrl);
      renderFormStickies();
    });
  });
}

function renderDetailStickies(m) {
  const box = $('#dStickies');
  const list = (m.stickies || []).filter(Boolean);
  if (!list.length) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  box.innerHTML = list.map((p, i) =>
    `<div class="sticky-note" data-i="${i}"><img src="${esc(urlOf(p))}" alt="手写便签"></div>`
  ).join('');
  box.querySelectorAll('.sticky-note').forEach(el => {
    el.addEventListener('click', () => {
      openLightbox({ photos: list.map(p => ({ path: p, caption: '手写便签' })), name: '手写便签' },
        Number(el.dataset.i));
    });
  });
}

/* ============================================================
 * 时光胶片
 * ============================================================ */
let filmDragBound = false;

/* 胶片带占据底部空间：让左右两栏自动让位，避免遮住底片 */
function syncFilmDock() {
  const bar = $('#filmstrip');
  if (!bar) return;
  const hidden = bar.classList.contains('hidden') || !state.user || !state.memories.length;
  let h = 0;
  if (!hidden) h = bar.classList.contains('collapsed') ? 34 : Math.round(bar.offsetHeight || 156);
  document.documentElement.style.setProperty('--film-h', h + 'px');
}

function renderFilmstrip() {
  const bar = $('#filmstrip');
  const has = !!state.user && state.memories.length > 0;
  bar.classList.toggle('hidden', !has);
  refreshMenuAuth();
  if (!has) { syncFilmDock(); return; }

  const vis = new Set(visibleMemories().map(m => String(m.id)));
  const items = state.memories
    .filter(m => vis.has(String(m.id)))
    .slice()
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

  $('#filmCounter').textContent = String(items.length).padStart(2, '0') + ' FRAMES';
  const track = $('#filmTrack');
  if (!items.length) {
    track.innerHTML = '<div class="film-empty">这个筛选下没有底片</div>';
    return;
  }
  track.innerHTML = items.map(m => {
    const th = (m.photos && m.photos[0] && m.photos[0].thumb) || '';
    const u = th ? urlOf(th) : '';
    const d = m.date ? m.date.slice(2).replace(/-/g, '.') : '—';
    const em = moodOf(m.mood).emoji || '❤';
    return `<div class="film-frame ${m.id === state.selectedId ? 'active' : ''}" data-id="${esc(String(m.id))}">
      ${u ? `<img src="${esc(u)}" loading="lazy" alt="">` : `<div class="ff-none">${em}</div>`}
      <div class="ff-date">${esc(d)}</div>
    </div>`;
  }).join('');

  track.querySelectorAll('.film-frame').forEach(f => {
    f.addEventListener('click', () => {
      const raw = f.dataset.id;
      openDetail(isNaN(Number(raw)) ? raw : Number(raw), true);
    });
  });

  if (!filmDragBound) {
    filmDragBound = true;
    let down = false, sx = 0, sl = 0;
    track.addEventListener('pointerdown', e => {
      down = true; sx = e.clientX; sl = track.scrollLeft;
      track.style.cursor = 'grabbing';
    });
    track.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 4) track.scrollLeft = sl - dx;
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      track.addEventListener(ev, () => { down = false; track.style.cursor = 'grab'; })
    );
  }

  const act = track.querySelector('.film-frame.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'center' });
  syncFilmDock();
}

/* ============================================================
 * 邮戳护照
 * ============================================================ */
function stampSvg(m, idx) {
  const ink = ['#1F3A6E', '#8C2F39', '#2F5D3A'][idx % 3];
  const uid = 'sp' + idx;
  const place = (m.city || m.province || m.name || 'OUR MAP').replace(/市$/, '').slice(0, 8);
  const date = m.date ? m.date.replace(/-/g, '.') : 'NO DATE';
  const rot = ((idx % 5) - 2) * 2.6;
  return `<svg viewBox="0 0 120 120" style="transform:rotate(${rot}deg)" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <path id="${uid}a" d="M60,60 m-46,0 a46,46 0 1,1 92,0" fill="none"/>
      <path id="${uid}b" d="M60,60 m-42,0 a42,42 0 1,0 84,0" fill="none"/>
    </defs>
    <circle cx="60" cy="60" r="55" fill="none" stroke="${ink}" stroke-width="1.6" stroke-dasharray="3.2 3.2" opacity=".85"/>
    <circle cx="60" cy="60" r="49" fill="none" stroke="${ink}" stroke-width="1.1" opacity=".65"/>
    <text font-size="10" fill="${ink}" font-family="monospace" letter-spacing="1.2">
      <textPath href="#${uid}a" xlink:href="#${uid}a" startOffset="50%" text-anchor="middle">${esc(place)}</textPath>
    </text>
    <text font-size="6.4" fill="${ink}" font-family="monospace" letter-spacing="1.6">
      <textPath href="#${uid}b" xlink:href="#${uid}b" startOffset="50%" text-anchor="middle">OUR MAP · CHINA</textPath>
    </text>
    <text x="60" y="38" font-size="15" text-anchor="middle">❤</text>
    <text x="60" y="62" font-size="9.6" fill="${ink}" text-anchor="middle" font-family="monospace" font-weight="700">${esc(date)}</text>
    <text x="60" y="78" font-size="8" fill="${ink}" text-anchor="middle" font-family="monospace" opacity=".8">NO.${String(idx + 1).padStart(2, '0')}</text>
  </svg>`;
}

function openPassport() {
  const list = state.memories.slice()
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  const first = list.find(m => m.date);
  const cities = new Set(list.map(m => m.city).filter(Boolean)).size;
  const holder = (state.viewer
    ? ($('#visitorName').textContent || 'TA')
    : ((state.profile && state.profile.username) || '我们'));
  $('#passportMeta').innerHTML =
    `<span>holder · 持有人 <b>${esc(holder)}</b></span>` +
    `<span>stamps · 印章 <b>${list.length}</b></span>` +
    `<span>cities · 城市 <b>${cities}</b></span>` +
    `<span>since · 起始 <b>${esc(first ? fmtDate(first.date) : '—')}</b></span>`;
  $('#stampGrid').innerHTML = list.length
    ? list.map((m, i) => `<div class="stamp" data-id="${esc(String(m.id))}">${stampSvg(m, i)}</div>`).join('')
    : '<div class="minor">还没有邮戳，记录第一段回忆就会盖下第一枚章</div>';
  $('#stampGrid').querySelectorAll('.stamp').forEach(el => {
    el.addEventListener('click', () => {
      const raw = el.dataset.id;
      $('#passportModal').classList.add('hidden');
      openDetail(isNaN(Number(raw)) ? raw : Number(raw), true);
    });
  });
  $('#passportModal').classList.remove('hidden');
}

/* ============================================================
 * 成就徽章
 * ============================================================ */
const ACHIEVEMENTS = [
  { id: 'first',   icon: '👣', name: '第一枚脚印', desc: '记录第一段回忆',        goal: 1,  get: s => s.count },
  { id: 'cities3', icon: '🏙', name: '三城记',     desc: '走过 3 个城市',          goal: 3,  get: s => s.cities },
  { id: 'prov5',   icon: '🌏', name: '五湖四海',   desc: '走过 5 个省级地区',      goal: 5,  get: s => s.provinces },
  { id: 'photos10',icon: '📸', name: '摄影大师',   desc: '上传 10 张照片',         goal: 10, get: s => s.photos },
  { id: 'notes3',  icon: '✍️', name: '手账控',     desc: '贴 3 张手写便签',        goal: 3,  get: s => s.stickies },
  { id: 'months3', icon: '🗓', name: '常来常往',   desc: '在 3 个不同月份留下回忆', goal: 3, get: s => s.months },
  { id: 'sweet5',  icon: '💗', name: '甜度超标',   desc: '5 段甜蜜 / 开心的回忆',  goal: 5,  get: s => s.sweet },
  { id: 'story3',  icon: '📖', name: '写故事的人', desc: '3 段超过 100 字的回忆',  goal: 3,  get: s => s.longStories }
];

function achStats(memories = state.memories || []) {
  const cities = new Set(), provinces = new Set(), months = new Set();
  let photos = 0, stickies = 0, sweet = 0, longStories = 0;
  memories.forEach(m => {
    if (m.city) cities.add(m.city);
    if (m.province) provinces.add(m.province);
    if (m.date) months.add(String(m.date).slice(0, 7));
    photos += (m.photos || []).length;
    stickies += (m.stickies || []).length;
    if (m.mood === 'sweet' || m.mood === 'happy') sweet++;
    if ((m.memory || '').length >= 100) longStories++;
  });
  return {
    count: memories.length, cities: cities.size, provinces: provinces.size,
    months: months.size, photos, stickies, sweet, longStories
  };
}

function achResult() {
  const s = achStats(state.memories);
  return ACHIEVEMENTS.map(a => {
    const cur = Math.min(a.get(s), a.goal);
    return { def: a, cur, unlocked: a.get(s) >= a.goal };
  });
}

function openBadges() {
  const list = achResult();
  const done = list.filter(x => x.unlocked).length;
  $('#achSummary').textContent = `unlocked ${String(done).padStart(2, '0')} / ${String(list.length).padStart(2, '0')} · 继续记录解锁更多`;
  $('#achGrid').innerHTML = list.map(x => `
    <div class="ach-badge ${x.unlocked ? '' : 'locked'}">
      ${x.unlocked ? '<span class="ach-unlocked-tag">GET</span>' : ''}
      <div class="ach-icon">${x.unlocked ? x.def.icon : '🔒'}</div>
      <div class="ach-name">${esc(x.def.name)}</div>
      <div class="ach-desc">${esc(x.def.desc)}</div>
      <div class="ach-progress">${x.cur} / ${x.def.goal}</div>
    </div>`).join('');
  $('#badgesModal').classList.remove('hidden');
}

/* 新成就检测：解锁时撒彩带 */
function checkNewAchievements() {
  if (!state.user || state.viewer) return;
  const list = achResult();
  const nowIds = list.filter(x => x.unlocked).map(x => x.def.id);
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem('achSeen') || 'null'); } catch (e) { seen = null; }
  if (!Array.isArray(seen)) {
    localStorage.setItem('achSeen', JSON.stringify(nowIds));
    return;
  }
  const fresh = nowIds.filter(id => seen.indexOf(id) === -1);
  localStorage.setItem('achSeen', JSON.stringify(nowIds));
  if (!fresh.length) return;
  const names = fresh.map(id => {
    const a = ACHIEVEMENTS.find(x => x.id === id);
    return a ? a.icon + ' ' + a.name : id;
  });
  fireConfetti();
  setTimeout(() => toast('解锁新成就：' + names.join('、') + ' 🎉'), 220);
}

function fireConfetti() {
  const cv = $('#confettiCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const w = cv.width = window.innerWidth;
  const h = cv.height = window.innerHeight;
  const colors = ['#FF5C93', '#E4FF4F', '#4D96FF', '#FFC53D', '#2EC4B6', '#A97BFF'];
  const parts = [];
  for (let i = 0; i < 90; i++) {
    parts.push({
      x: w / 2 + (Math.random() - 0.5) * 120,
      y: h * 0.62 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 12,
      vy: -Math.random() * 13 - 4,
      s: 4 + Math.random() * 6,
      c: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3
    });
  }
  let frames = 0;
  const tick = () => {
    ctx.clearRect(0, 0, w, h);
    parts.forEach(p => {
      p.vy += 0.42;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62);
      ctx.restore();
    });
    frames++;
    if (frames < 110) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  };
  tick();
}

/* ============================================================
 * 明信片导出
 * ============================================================ */
const PC_W = 900, PC_H = 1200;
let pcMemory = null;

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const chars = Array.from(String(text || ''));
  let line = '', lines = 0;
  for (let i = 0; i < chars.length; i++) {
    const test = line + chars[i];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lineH;
      lines++;
      line = chars[i];
      if (maxLines && lines >= maxLines) { ctx.fillText(line + '…', x, y); return y; }
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}

async function fetchImageDataUrl(url) {
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error('fetch ' + r.status);
    const blob = await r.blob();
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    // 降级：直接把图片当跨域资源画到临时画布，成功则视为可用
    return await new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          res(c.toDataURL('image/png'));
        } catch (err) { rej(err); }
      };
      img.onerror = rej;
      img.src = url;
    });
  }
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function openPostcard(id) {
  const m = state.memories.find(x => x.id === id);
  if (!m) { toast('先选一段回忆吧', true); return; }
  pcMemory = m;
  const cv = $('#postcardCanvas');
  const ctx = cv.getContext('2d');
  $('#postcardModal').classList.remove('hidden');
  $('#postcardHint').textContent = '明信片生成中…';

  // 背景
  ctx.fillStyle = '#FFF6E9';
  ctx.fillRect(0, 0, PC_W, PC_H);
  ctx.fillStyle = '#FFB3CE';
  ctx.fillRect(0, 0, PC_W, 150);

  // 顶部大字
  ctx.fillStyle = '#121212';
  ctx.font = '900 54px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('我们的地图', 60, 96);
  ctx.font = '18px ui-monospace, monospace';
  ctx.fillText('POSTCARD · NO.' + String(m.id).slice(-4), 62, 128);

  // 照片拍立得
  let photoOk = true;
  const first = (m.photos && m.photos[0]) ? (m.photos[0].thumb || m.photos[0].path) : null;
  try {
    if (!first) throw new Error('no photo');
    const url = urlOf(first) || urlOf(m.photos[0].path);
    if (!url) throw new Error('no url');
    const dataUrl = await fetchImageDataUrl(url);
    const img = await loadImg(dataUrl);
    const boxX = 60, boxY = 200, boxW = 780, boxH = 600;
    ctx.save();
    ctx.translate(boxX + boxW / 2, boxY + boxH / 2);
    ctx.rotate(-0.02);
    ctx.translate(-(boxX + boxW / 2), -(boxY + boxH / 2));
    // 白边
    ctx.fillStyle = '#fff';
    ctx.fillRect(boxX, boxY, boxW, boxH + 46);
    ctx.strokeStyle = '#121212';
    ctx.lineWidth = 6;
    ctx.strokeRect(boxX, boxY, boxW, boxH + 46);
    // 图片裁切填满
    const iw = img.width, ih = img.height;
    const scale = Math.max(boxW / iw, boxH / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.clip();
    ctx.drawImage(img, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
    ctx.restore();
    ctx.restore();
  } catch (e) {
    photoOk = false;
    ctx.fillStyle = '#FFE3EC';
    ctx.fillRect(60, 200, 780, 600);
    ctx.strokeStyle = '#121212';
    ctx.lineWidth = 4;
    ctx.strokeRect(60, 200, 780, 600);
    ctx.fillStyle = '#121212';
    ctx.font = '900 34px "PingFang SC",sans-serif';
    ctx.fillText('这张回忆还没有照片', 230, 500);
  }

  // 邮戳
  const stampX = 640, stampY = 860;
  ctx.save();
  ctx.translate(stampX, stampY);
  ctx.rotate(0.16);
  ctx.strokeStyle = '#8C2F39';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, 72, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0, 0, 64, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#8C2F39';
  ctx.textAlign = 'center';
  ctx.font = '900 22px "PingFang SC",sans-serif';
  const cityTxt = (m.city || m.province || '地图').replace(/市$/, '').slice(0, 5);
  ctx.fillText(cityTxt, 0, 2);
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText(m.date ? m.date.replace(/-/g, '.') : '', 0, 24);
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText('OUR MAP · CHINA', 0, -26);
  ctx.restore();

  // 标题 + 地点
  ctx.textAlign = 'left';
  ctx.fillStyle = '#121212';
  ctx.font = '900 40px "PingFang SC","Microsoft YaHei",sans-serif';
  wrapText(ctx, m.name, 60, 880, 540, 50, 2);

  ctx.font = '16px ui-monospace, monospace';
  ctx.fillStyle = '#5B5B5B';
  const place = [m.province, m.city, m.district].filter(Boolean).join(' · ');
  ctx.fillText([place, m.date ? fmtDate(m.date) : ''].filter(Boolean).join('  |  '), 62, 950);

  // 心情天气
  const md = moodOf(m.mood), wd = weatherOf(m.weather);
  const tags = [md.emoji ? md.emoji + ' ' + md.label : '', wd.emoji ? wd.emoji + ' ' + wd.label : ''].filter(Boolean);
  if (tags.length) {
    ctx.font = '900 17px "PingFang SC",sans-serif';
    ctx.fillStyle = '#121212';
    ctx.fillText(tags.join('   '), 62, 985);
  }

  // 回忆文字
  ctx.fillStyle = '#121212';
  ctx.font = '19px "PingFang SC","Microsoft YaHei",sans-serif';
  const body = (m.memory || '').replace(/\s+/g, ' ').trim();
  wrapText(ctx, body || '（还没写下回忆文字）', 62, 1032, 760, 32, 4);

  // 页脚
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, PC_H - 54, PC_W, 54);
  ctx.fillStyle = '#E4FF4F';
  ctx.font = '15px ui-monospace, monospace';
  ctx.fillText('our map · things happened', 60, PC_H - 21);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.fillText('STICKER EDITION', PC_W - 60, PC_H - 21);
  ctx.textAlign = 'left';

  $('#postcardHint').textContent = photoOk
    ? '贴纸风明信片 · 900×1200 · 点「下载图片」保存'
    : '贴纸风明信片 · 图片跨域受限，本张未包含照片（可先截图分享）';
}

function downloadPostcard() {
  try {
    const cv = $('#postcardCanvas');
    cv.toBlob(blob => {
      if (!blob) { toast('导出失败，请重试', true); return; }
      const a = document.createElement('a');
      const name = (pcMemory ? pcMemory.name : 'postcard').replace(/[\\/:*?"<>|]/g, '');
      a.href = URL.createObjectURL(blob);
      a.download = name + '-明信片.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
      toast('明信片已下载 ✉️');
    }, 'image/png');
  } catch (e) {
    toast('导出被浏览器拦截，请长按图片保存', true);
  }
}

function copyPostcardText() {
  const m = pcMemory;
  if (!m) return;
  const txt = `${m.name}｜${[m.province, m.city].filter(Boolean).join(' · ')}｜${m.date ? fmtDate(m.date) : ''}\n` +
    ((m.memory || '').trim() || '（这段回忆还没有文字）') + '\n—— 来自我们的地图 ❤';
  navigator.clipboard.writeText(txt)
    .then(() => toast('文案已复制 📋'))
    .catch(() => toast('复制失败，请手动选择', true));
}
