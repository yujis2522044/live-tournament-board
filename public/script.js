(function () {
  'use strict';

  const DATA_FILE_PATH = 'data.json';
  const LOCAL_STORAGE_KEY = 'compass-live-tournament-state-v2';
  const LOCAL_CHANNEL_NAME = 'compass-live-tournament-channel';
  const SOUND_STORAGE_KEY = 'compass-live-tournament-sound';
  const BGM_STORAGE_KEY = 'compass-live-tournament-bgm';
  const VIEWER_PROFILE_STORAGE_KEY = 'compass-live-tournament-viewer-profile-v1';
  const SAVE_DEBOUNCE_MS = 450;

  const config = window.LIVE_TOURNAMENT_CONFIG || {};
  const query = new URLSearchParams(window.location.search);
  const isAdminMode = query.get('admin') === '1' || window.location.hash === '#admin';
  const roomId = sanitizeRoomId(query.get('room') || config.room || 'main');

  const elements = {
    title: document.getElementById('event-title'),
    headerLoginControl: document.getElementById('header-login-control'),
    headerLoginLabel: document.getElementById('header-login-label'),
    headerLoginDetail: document.getElementById('header-login-detail'),
    connectionLight: document.getElementById('connection-light'),
    connectionLabel: document.getElementById('connection-label'),
    connectionDetail: document.getElementById('connection-detail'),
    activityToggle: document.getElementById('activity-toggle'),
    activityMiniList: document.getElementById('activity-mini-list'),
    activityPanel: document.getElementById('activity-panel'),
    activityPanelList: document.getElementById('activity-panel-list'),
    toolsToggle: document.getElementById('tools-toggle'),
    toolsMenu: document.getElementById('tools-menu'),
    feedbackLink: document.getElementById('feedback-link'),
    adminDockLink: document.getElementById('admin-dock-link'),
    qrImage: document.getElementById('qr-image'),
    soundToggle: document.getElementById('sound-toggle'),
    soundState: document.getElementById('sound-state'),
    bgmToggle: document.getElementById('bgm-toggle'),
    bgmAudio: document.getElementById('site-bgm'),
    youtubeBgm: document.getElementById('youtube-bgm'),
    spectatorToggle: document.getElementById('spectator-toggle'),
    fullscreenToggle: document.getElementById('fullscreen-toggle'),
    lastUpdated: document.getElementById('last-updated'),
    eventMessage: document.getElementById('event-message'),
    metricTeams: document.getElementById('metric-teams'),
    metricProgress: document.getElementById('metric-progress'),
    metricMatches: document.getElementById('metric-matches'),
    viewerPassSection: document.getElementById('viewer-pass-section'),
    viewerRoleBadge: document.getElementById('viewer-role-badge'),
    viewerPassName: document.getElementById('viewer-pass-name'),
    viewerPassEmail: document.getElementById('viewer-pass-email'),
    viewerFavoriteTeam: document.getElementById('viewer-favorite-team'),
    teamProgressGrid: document.getElementById('team-progress-grid'),
    matchesContainer: document.getElementById('matches-container'),
    rankingTableBody: document.getElementById('ranking-table-body'),
    playerListGrouped: document.getElementById('player-list-grouped'),
    roundRobinHeader: document.getElementById('round-robin-header'),
    roundRobinBody: document.getElementById('round-robin-body'),
    roundRobinCards: document.getElementById('round-robin-cards'),
    adminPanel: document.getElementById('admin-panel'),
    authCard: document.getElementById('auth-card'),
    authStatus: document.getElementById('auth-status'),
    authUser: document.getElementById('auth-user'),
    loginButton: document.getElementById('login-btn'),
    logoutButton: document.getElementById('logout-btn'),
    claimAdminButton: document.getElementById('claim-admin-btn'),
    adminManager: document.getElementById('admin-manager'),
    refreshAdminsButton: document.getElementById('refresh-admins-btn'),
    adminList: document.getElementById('admin-list'),
    viewerList: document.getElementById('viewer-list'),
    adminTitle: document.getElementById('admin-title'),
    adminMessage: document.getElementById('admin-message'),
    adminMaxTeams: document.getElementById('admin-max-teams'),
    adminPlayersPerTeam: document.getElementById('admin-players-per-team'),
    seedRemoteButton: document.getElementById('seed-remote-btn'),
    exportJsonButton: document.getElementById('export-json-btn'),
    addTeamButton: document.getElementById('add-team-btn'),
    addMatchButton: document.getElementById('add-match-btn'),
    teamEditor: document.getElementById('team-editor'),
    matchEditor: document.getElementById('match-editor')
  };

  let state = null;
  let store = null;
  let authApi = null;
  let saveTimer = null;
  let ignoreNextAdminInput = false;
  let ignoreViewerProfileInput = false;
  let adminDirectoryLoaded = false;
  let adminDirectory = [];
  let viewerDirectory = [];
  const matchVisualCache = new Map();
  let soundEnabled = localStorage.getItem(SOUND_STORAGE_KEY) === '1';
  let bgmEnabled = localStorage.getItem(BGM_STORAGE_KEY) === '1';
  let youtubeApiPromise = null;
  let youtubeBgmPlayer = null;
  let youtubeBgmReady = false;
  let youtubeBgmVideoId = '';
  let lastFeedbackAt = 0;
  const authState = {
    enabled: false,
    ready: false,
    user: null,
    isAdmin: false,
    token: '',
    viewerProfile: loadStoredViewerProfile()
  };

  init();

  async function init() {
    const fallbackData = await loadFallbackData();
    state = normalizeTournamentData(loadLocalState() || fallbackData);

    bindHeaderControls();
    bindDockControls();
    bindGlobalPressFeedback();
    bindViewerActions();
    if (isAdminMode) {
      elements.adminPanel.hidden = false;
      bindAuthActions();
      bindAdminActions();
    }

    render();
    authApi = createAuthApi();
    await authApi.start();
    store = await createStore(fallbackData);
    syncAdminAccess();
    store.subscribe((nextState, source) => {
      state = normalizeTournamentData(nextState);
      render(source);
    });
  }

  async function loadFallbackData() {
    try {
      const response = await fetch(DATA_FILE_PATH, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('data.json could not be loaded');
      }
      return await response.json();
    } catch (error) {
      console.warn(error);
      return createEmptyTournament();
    }
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY}:${roomId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  async function createStore(fallbackData) {
    const databaseUrl = getDatabaseUrl();

    if (databaseUrl) {
      const remoteStore = await createFirebaseRestStore(databaseUrl, fallbackData);
      if (remoteStore) {
        setConnection('is-live', 'リアルタイム接続中');
        return remoteStore;
      }
    }

    setConnection('is-local', 'ローカルプレビュー');
    return createLocalStore();
  }

  async function createFirebaseRestStore(databaseUrl, fallbackData) {
    const endpoint = `${databaseUrl}/tournaments/${encodeURIComponent(roomId)}.json`;
    let remoteState = null;
    let subscribers = [];
    let eventSource = null;

    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Realtime Database returned ${response.status}`);
      }
      remoteState = await response.json();
    } catch (error) {
      console.warn(error);
      return null;
    }

    const storeApi = {
      subscribe(callback) {
        subscribers.push(callback);

        if (remoteState) {
          callback(remoteState, 'remote');
        } else {
          remoteState = normalizeTournamentData(fallbackData);
          callback(remoteState, 'remote-empty');
        }

        if (!eventSource) {
          eventSource = new EventSource(endpoint);
          eventSource.addEventListener('put', handleStreamEvent);
          eventSource.addEventListener('patch', handleStreamEvent);
          eventSource.onerror = () => {
            setConnection('is-error', '再接続中');
          };
          eventSource.onopen = () => {
            setConnection('is-live', 'リアルタイム接続中');
          };
        }

        return () => {
          subscribers = subscribers.filter((item) => item !== callback);
        };
      },
      async save(nextState) {
        const payload = normalizeTournamentData({
          ...nextState,
          meta: {
            ...nextState.meta,
            updatedAt: Date.now()
          }
        });
        const writeEndpoint = await getAuthenticatedEndpoint(endpoint);
        const response = await fetch(writeEndpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`Save failed with ${response.status}`);
        }
      },
      type: 'remote'
    };

    function handleStreamEvent(event) {
      try {
        const payload = JSON.parse(event.data);
        if (payload.path === '/') {
          remoteState = payload.data;
        } else {
          remoteState = setPath(remoteState || {}, payload.path, payload.data);
        }
        if (!remoteState) return;
        subscribers.forEach((callback) => callback(remoteState, 'remote'));
      } catch (error) {
        console.warn(error);
      }
    }

    return storeApi;
  }

  function createLocalStore() {
    let subscribers = [];
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(`${LOCAL_CHANNEL_NAME}:${roomId}`) : null;

    if (channel) {
      channel.onmessage = (event) => {
        if (!event.data) return;
        subscribers.forEach((callback) => callback(event.data, 'local'));
      };
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== `${LOCAL_STORAGE_KEY}:${roomId}` || !event.newValue) return;
      try {
        subscribers.forEach((callback) => callback(JSON.parse(event.newValue), 'local'));
      } catch (error) {
        console.warn(error);
      }
    });

    return {
      subscribe(callback) {
        subscribers.push(callback);
        return () => {
          subscribers = subscribers.filter((item) => item !== callback);
        };
      },
      async save(nextState) {
        const payload = normalizeTournamentData({
          ...nextState,
          meta: {
            ...nextState.meta,
            updatedAt: Date.now()
          }
        });
        localStorage.setItem(`${LOCAL_STORAGE_KEY}:${roomId}`, JSON.stringify(payload));
        if (channel) {
          channel.postMessage(payload);
        }
        subscribers.forEach((callback) => callback(payload, 'local-save'));
      },
      type: 'local'
    };
  }

  function createAuthApi() {
    const databaseUrl = getDatabaseUrl();
    const firebaseConfig = getFirebaseConfig();
    const hasSdk = typeof window.firebase !== 'undefined' && window.firebase.auth;
    const hasConfig = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);

    if (!databaseUrl || !hasSdk || !hasConfig) {
      return {
        async start() {
          updateAuthState({
            enabled: false,
            ready: true,
            user: null,
            isAdmin: false,
            token: '',
            viewerProfile: loadStoredViewerProfile()
          });
        },
        async login() {},
        async logout() {},
        async claimAdmin() {},
        async refresh() {},
        async saveViewerProfile() {},
        async listAdmins() {
          return [];
        },
        async listViewers() {
          return [];
        },
        async addAdmin() {},
        async removeAdmin() {},
        async getToken() {
          return '';
        }
      };
    }

    const appConfig = {
      ...firebaseConfig,
      databaseURL: databaseUrl
    };
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(appConfig);
    }

    const auth = window.firebase.auth();
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    return {
      start() {
        return new Promise((resolve) => {
          let resolved = false;
          auth.onAuthStateChanged(async (user) => {
            if (!user) {
              updateAuthState({
                enabled: true,
                ready: true,
                user: null,
                isAdmin: false,
                token: '',
                viewerProfile: loadStoredViewerProfile()
              });
              if (!resolved) {
                resolved = true;
                resolve();
              }
              return;
            }

            const token = await user.getIdToken();
            const viewerProfile = await ensureViewerProfile(databaseUrl, user, token);
            const isAdmin = await fetchAdminFlag(databaseUrl, user.uid, token);
            updateAuthState({
              enabled: true,
              ready: true,
              user,
              isAdmin,
              token,
              viewerProfile
            });
            if (!resolved) {
              resolved = true;
              resolve();
            }
          });
        });
      },
      async login() {
        try {
          await auth.signInWithPopup(provider);
        } catch (error) {
          const code = error && error.code ? String(error.code) : '';
          if (code.includes('popup-blocked') || code.includes('operation-not-supported')) {
            await auth.signInWithRedirect(provider);
            return;
          }
          throw error;
        }
      },
      async logout() {
        await auth.signOut();
      },
      async refresh() {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken(true);
        const viewerProfile = await ensureViewerProfile(databaseUrl, user, token);
        const isAdmin = await fetchAdminFlag(databaseUrl, user.uid, token);
        updateAuthState({
          enabled: true,
          ready: true,
          user,
          isAdmin,
          token,
          viewerProfile
        });
      },
      async claimAdmin() {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken(true);
        const payload = {
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          createdAt: Date.now(),
          createdBy: 'initial-claim'
        };
        const response = await fetch(`${databaseUrl}/admins/${encodeURIComponent(user.uid)}.json?auth=${encodeURIComponent(token)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`Admin claim failed with ${response.status}`);
        }
        updateAuthState({
          enabled: true,
          ready: true,
          user,
          isAdmin: true,
          token,
          viewerProfile: authState.viewerProfile
        });
      },
      async saveViewerProfile(patch) {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken();
        const nextProfile = normalizeViewerProfile({
          ...(authState.viewerProfile || {}),
          ...patch,
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          photoURL: user.photoURL || '',
          lastSeenAt: Date.now()
        });
        await writeJson(`${databaseUrl}/viewers/${encodeURIComponent(user.uid)}.json?auth=${encodeURIComponent(token)}`, nextProfile, 'PUT');
        saveStoredViewerProfile(nextProfile);
        updateAuthState({ viewerProfile: nextProfile, token });
      },
      async listAdmins() {
        const token = await this.getToken();
        if (!token || !authState.isAdmin) return [];
        const data = await readJson(`${databaseUrl}/admins.json?auth=${encodeURIComponent(token)}`);
        return objectToDirectory(data);
      },
      async listViewers() {
        const token = await this.getToken();
        if (!token || !authState.isAdmin) return [];
        const data = await readJson(`${databaseUrl}/viewers.json?auth=${encodeURIComponent(token)}`);
        return objectToDirectory(data);
      },
      async addAdmin(uid, sourceProfile) {
        const token = await this.getToken();
        if (!token || !authState.isAdmin || !uid) return;
        const payload = {
          uid,
          email: sourceProfile.email || '',
          displayName: sourceProfile.displayName || '',
          createdAt: Date.now(),
          createdBy: authState.user ? authState.user.email || authState.user.uid : ''
        };
        await writeJson(`${databaseUrl}/admins/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(token)}`, payload, 'PUT');
      },
      async removeAdmin(uid) {
        const token = await this.getToken();
        if (!token || !authState.isAdmin || !uid) return;
        await writeJson(`${databaseUrl}/admins/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(token)}`, null, 'DELETE');
      },
      async getToken() {
        const user = auth.currentUser;
        if (!user) return '';
        const token = await user.getIdToken();
        updateAuthState({ token });
        return token;
      }
    };
  }

  async function fetchAdminFlag(databaseUrl, uid, token) {
    try {
      const response = await fetch(`${databaseUrl}/admins/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(token)}`, {
        cache: 'no-store'
      });
      if (!response.ok) return false;
      const data = await response.json();
      return Boolean(data);
    } catch (error) {
      console.warn(error);
      return false;
    }
  }

  async function ensureViewerProfile(databaseUrl, user, token) {
    const localProfile = loadStoredViewerProfile();
    let remoteProfile = null;
    try {
      remoteProfile = await readJson(`${databaseUrl}/viewers/${encodeURIComponent(user.uid)}.json?auth=${encodeURIComponent(token)}`);
    } catch (error) {
      console.warn(error);
    }

    const profile = normalizeViewerProfile({
      ...(localProfile || {}),
      ...(remoteProfile || {}),
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      photoURL: user.photoURL || '',
      lastSeenAt: Date.now()
    });

    try {
      await writeJson(`${databaseUrl}/viewers/${encodeURIComponent(user.uid)}.json?auth=${encodeURIComponent(token)}`, profile, 'PUT');
    } catch (error) {
      console.warn(error);
    }
    saveStoredViewerProfile(profile);
    return profile;
  }

  async function readJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Read failed with ${response.status}`);
    }
    return response.json();
  }

  async function writeJson(url, payload, method) {
    const options = { method: method || 'PUT' };
    if (options.method !== 'DELETE') {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Write failed with ${response.status}`);
    }
    if (options.method === 'DELETE') return null;
    return response.json();
  }

  function objectToDirectory(data) {
    if (!data || typeof data !== 'object') return [];
    return Object.entries(data)
      .map(([uid, value]) => normalizeViewerProfile({ uid, ...(value || {}) }))
      .sort((a, b) => numberValue(b.lastSeenAt || b.createdAt) - numberValue(a.lastSeenAt || a.createdAt));
  }

  function normalizeViewerProfile(profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    return {
      uid: String(source.uid || ''),
      email: String(source.email || ''),
      displayName: String(source.displayName || source.email || 'Googleユーザー'),
      photoURL: String(source.photoURL || ''),
      favoriteTeamId: String(source.favoriteTeamId || ''),
      createdAt: numberValue(source.createdAt) || Date.now(),
      lastSeenAt: numberValue(source.lastSeenAt) || Date.now(),
      createdBy: String(source.createdBy || '')
    };
  }

  function loadStoredViewerProfile() {
    try {
      const raw = localStorage.getItem(`${VIEWER_PROFILE_STORAGE_KEY}:${roomId}`);
      return raw ? normalizeViewerProfile(JSON.parse(raw)) : null;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  function saveStoredViewerProfile(profile) {
    try {
      localStorage.setItem(`${VIEWER_PROFILE_STORAGE_KEY}:${roomId}`, JSON.stringify(normalizeViewerProfile(profile)));
    } catch (error) {
      console.warn(error);
    }
  }

  function updateAuthState(nextState) {
    Object.assign(authState, nextState);
    syncAdminAccess();
    if (state) {
      render('auth');
    }
  }

  async function getAuthenticatedEndpoint(endpoint) {
    if (store && store.type === 'local') return endpoint;
    if (!authApi) {
      throw new Error('Admin login is required');
    }
    const token = await authApi.getToken();
    if (!token || !authState.isAdmin) {
      throw new Error('Admin login is required');
    }
    return `${endpoint}?auth=${encodeURIComponent(token)}`;
  }

  function bindHeaderControls() {
    elements.headerLoginControl.addEventListener('click', async () => {
      playFeedback(360);
      try {
        if (!authState.enabled) {
          window.location.href = buildAdminUrl();
          return;
        }
        if (!authState.user) {
          await authApi.login();
          return;
        }
        if (!authState.isAdmin && authApi.refresh) {
          await authApi.refresh();
        }
        if (authState.isAdmin && !isAdminMode) {
          window.location.href = buildAdminUrl();
          return;
        }
        if (authState.user && elements.viewerPassSection && !elements.viewerPassSection.hidden) {
          elements.viewerPassSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (error) {
        console.warn(error);
      }
    });

    elements.connectionLabel.addEventListener('click', () => {
      playFeedback(420);
    });

    if (elements.feedbackLink) {
      elements.feedbackLink.addEventListener('click', () => {
        playFeedback(680);
      });
    }

    elements.activityToggle.addEventListener('click', () => {
      togglePanel(elements.activityPanel, elements.activityToggle);
    });

    elements.toolsToggle.addEventListener('click', () => {
      togglePanel(elements.toolsMenu, elements.toolsToggle);
      updateQrImage();
    });

    document.querySelectorAll('[data-close-panel]').forEach((button) => {
      button.addEventListener('click', () => {
        closePanel(document.getElementById(button.dataset.closePanel));
      });
    });

    document.addEventListener('click', (event) => {
      if (!elements.toolsMenu.hidden && !elements.toolsMenu.contains(event.target) && !elements.toolsToggle.contains(event.target)) {
        closePanel(elements.toolsMenu);
      }
      if (!elements.activityPanel.hidden && !elements.activityPanel.contains(event.target) && !elements.activityToggle.contains(event.target)) {
        closePanel(elements.activityPanel);
      }
    });

    elements.soundToggle.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem(SOUND_STORAGE_KEY, soundEnabled ? '1' : '0');
      renderSoundState();
      playFeedback(520);
    });

    if (elements.bgmToggle) {
      elements.bgmToggle.addEventListener('click', async () => {
        await toggleBgm();
      });
    }

    elements.spectatorToggle.addEventListener('click', () => {
      document.body.classList.toggle('spectator-mode');
      elements.spectatorToggle.textContent = document.body.classList.contains('spectator-mode')
        ? '📷 観戦モード解除'
        : '📷 観戦モード';
      playFeedback(480);
    });

    elements.fullscreenToggle.addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          elements.fullscreenToggle.textContent = '⛶ 解除';
        } else {
          await document.exitFullscreen();
          elements.fullscreenToggle.textContent = '⛶ フルスクリーン';
        }
        playFeedback(560);
      } catch (error) {
        console.warn(error);
      }
    });

    renderSoundState();
    renderBgmState();
    updateQrImage();
  }

  function bindDockControls() {
    document.querySelectorAll('.mode-dock a').forEach((link) => {
      const release = () => {
        link.classList.remove('is-pressing');
      };
      link.addEventListener('pointerdown', () => {
        link.classList.add('is-pressing');
      });
      link.addEventListener('pointerup', release);
      link.addEventListener('pointercancel', release);
      link.addEventListener('mouseleave', release);
      link.addEventListener('click', () => {
        window.setTimeout(release, 140);
      });
    });
  }

  function bindGlobalPressFeedback() {
    document.addEventListener('pointerdown', (event) => {
      const target = event.target.closest('button, a');
      if (!target || target.disabled) return;
      playFeedback(target.closest('.mode-dock') ? 560 : 430);
      if (bgmEnabled) {
        startBgm();
      }
    }, { passive: true });
  }

  function togglePanel(panel, trigger) {
    const shouldOpen = panel.hidden;
    closePanel(elements.activityPanel);
    closePanel(elements.toolsMenu);
    panel.hidden = !shouldOpen;
    trigger.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) playFeedback(420);
  }

  function closePanel(panel) {
    if (!panel) return;
    panel.hidden = true;
    if (panel === elements.activityPanel) {
      elements.activityToggle.setAttribute('aria-expanded', 'false');
    }
    if (panel === elements.toolsMenu) {
      elements.toolsToggle.setAttribute('aria-expanded', 'false');
    }
  }

  function buildAdminUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('admin', '1');
    url.hash = '';
    return url.toString();
  }

  function updateQrImage() {
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.delete('admin');
    shareUrl.hash = '';
    elements.qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(shareUrl.toString())}`;
  }

  function renderSoundState() {
    const label = soundEnabled ? '🔊 SE ON' : '🔇 SE OFF';
    elements.soundToggle.textContent = label;
    elements.soundState.textContent = soundEnabled ? 'SE ON' : 'SE OFF';
  }

  async function toggleBgm() {
    if (!elements.bgmToggle || !hasBgmSource()) {
      renderBgmState('BGM未設定');
      playFeedback(260);
      return;
    }

    bgmEnabled = !bgmEnabled;
    localStorage.setItem(BGM_STORAGE_KEY, bgmEnabled ? '1' : '0');

    if (bgmEnabled) {
      const started = await startBgm();
      if (!started) {
        renderBgmState('BGM待機中');
        return;
      }
    } else {
      stopBgm();
    }
    renderBgmState();
  }

  async function startBgm() {
    if (!bgmEnabled || !hasBgmSource()) return false;

    const youtubeId = getBgmYouTubeId();
    if (youtubeId) {
      if (elements.bgmAudio) elements.bgmAudio.pause();
      return startYouTubeBgm(youtubeId);
    }

    const bgmUrl = getBgmUrl();
    if (!elements.bgmAudio || !bgmUrl) return false;
    stopYouTubeBgm();

    if (elements.bgmAudio.getAttribute('src') !== bgmUrl) {
      elements.bgmAudio.src = bgmUrl;
      elements.bgmAudio.volume = 0.32;
    }

    try {
      await elements.bgmAudio.play();
      renderBgmState();
      return true;
    } catch (error) {
      console.warn(error);
      renderBgmState('BGM待機中');
      return false;
    }
  }

  async function startYouTubeBgm(videoId) {
    if (!elements.youtubeBgm) return false;
    renderBgmState('BGM起動中');

    try {
      await loadYouTubeApi();
    } catch (error) {
      console.warn(error);
      return false;
    }

    if (youtubeBgmPlayer && !youtubeBgmReady) {
      return true;
    }

    if (youtubeBgmPlayer && youtubeBgmReady) {
      try {
        if (youtubeBgmVideoId !== videoId) {
          youtubeBgmVideoId = videoId;
          youtubeBgmPlayer.loadVideoById(videoId);
        }
        youtubeBgmPlayer.setVolume(32);
        youtubeBgmPlayer.playVideo();
        return true;
      } catch (error) {
        console.warn(error);
        return false;
      }
    }

    youtubeBgmVideoId = videoId;
    youtubeBgmReady = false;
    youtubeBgmPlayer = new window.YT.Player(elements.youtubeBgm, {
      width: '200',
      height: '113',
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        loop: 1,
        modestbranding: 1,
        playsinline: 1,
        playlist: videoId,
        rel: 0
      },
      events: {
        onReady(event) {
          youtubeBgmReady = true;
          event.target.setVolume(32);
          if (bgmEnabled) {
            event.target.playVideo();
            renderBgmState();
          }
        },
        onStateChange(event) {
          if (event.data === window.YT.PlayerState.ENDED && bgmEnabled) {
            event.target.seekTo(0);
            event.target.playVideo();
          }
        },
        onError(error) {
          console.warn(error);
          renderBgmState('BGMエラー');
        }
      }
    });
    return true;
  }

  function stopBgm() {
    if (elements.bgmAudio) {
      elements.bgmAudio.pause();
    }
    stopYouTubeBgm();
  }

  function stopYouTubeBgm() {
    if (!youtubeBgmPlayer || !youtubeBgmReady) return;
    try {
      youtubeBgmPlayer.pauseVideo();
    } catch (error) {
      console.warn(error);
    }
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      return Promise.resolve();
    }
    if (youtubeApiPromise) {
      return youtubeApiPromise;
    }

    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === 'function') previousReady();
        resolve();
      };

      if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => reject(new Error('YouTube IFrame API could not be loaded'));
      document.head.appendChild(script);
    });

    return youtubeApiPromise;
  }

  function renderBgmState(fallbackLabel) {
    if (!elements.bgmToggle) return;
    if (!hasBgmSource()) {
      elements.bgmToggle.textContent = `♫ ${fallbackLabel || 'BGM未設定'}`;
      elements.bgmToggle.disabled = true;
      return;
    }
    elements.bgmToggle.disabled = false;
    const title = config.bgmTitle || 'BGM';
    elements.bgmToggle.textContent = fallbackLabel ? `♫ ${fallbackLabel}` : bgmEnabled ? `🎵 ON` : `🎵 OFF`;
  }

  function hasBgmSource() {
    return Boolean(getBgmYouTubeId() || getBgmUrl());
  }

  function getBgmUrl() {
    return typeof config.bgmUrl === 'string' ? config.bgmUrl.trim() : '';
  }

  function getBgmYouTubeId() {
    const configuredId = typeof config.bgmYouTubeId === 'string' ? config.bgmYouTubeId.trim() : '';
    if (configuredId) return sanitizeYouTubeId(configuredId);

    const configuredUrl = typeof config.bgmYouTubeUrl === 'string' ? config.bgmYouTubeUrl.trim() : '';
    if (!configuredUrl) return '';
    return parseYouTubeVideoId(configuredUrl);
  }

  function parseYouTubeVideoId(value) {
    const directId = sanitizeYouTubeId(value);
    if (directId) return directId;

    try {
      const url = new URL(value);
      const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

      if (host === 'youtu.be') {
        return sanitizeYouTubeId(url.pathname.split('/').filter(Boolean)[0] || '');
      }

      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const watchId = sanitizeYouTubeId(url.searchParams.get('v') || '');
        if (watchId) return watchId;

        const [kind, id] = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(kind)) {
          return sanitizeYouTubeId(id || '');
        }
      }
    } catch (error) {
      console.warn(error);
    }

    return '';
  }

  function sanitizeYouTubeId(value) {
    const id = String(value || '').trim();
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
  }

  function bindViewerActions() {
    if (!elements.viewerFavoriteTeam) return;

    elements.viewerFavoriteTeam.addEventListener('change', async () => {
      if (ignoreViewerProfileInput) return;
      const favoriteTeamId = elements.viewerFavoriteTeam.value;
      const profile = normalizeViewerProfile({
        ...(authState.viewerProfile || {}),
        favoriteTeamId
      });
      saveStoredViewerProfile(profile);
      updateAuthState({ viewerProfile: profile });
      render('viewer-local');

      if (!authState.enabled || !authState.user || !authApi) return;
      try {
        await authApi.saveViewerProfile({ favoriteTeamId });
      } catch (error) {
        console.warn(error);
      }
    });
  }

  function renderViewerPass() {
    if (!elements.viewerPassSection) return;

    const shouldShow = Boolean(authState.enabled && authState.user);
    elements.viewerPassSection.hidden = !shouldShow;
    if (!shouldShow) return;

    const profile = normalizeViewerProfile({
      ...(authState.viewerProfile || {}),
      uid: authState.user.uid,
      email: authState.user.email || '',
      displayName: authState.user.displayName || ''
    });

    elements.viewerPassName.textContent = profile.displayName || 'Googleユーザー';
    elements.viewerPassEmail.textContent = profile.email || '';
    elements.viewerRoleBadge.textContent = authState.isAdmin ? '運営' : '閲覧者';
    elements.viewerRoleBadge.classList.toggle('is-admin', authState.isAdmin);

    ignoreViewerProfileInput = true;
    elements.viewerFavoriteTeam.replaceChildren();
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '未選択';
    elements.viewerFavoriteTeam.appendChild(emptyOption);
    state.teams.forEach((team) => {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name;
      elements.viewerFavoriteTeam.appendChild(option);
    });
    elements.viewerFavoriteTeam.value = getFavoriteTeamId();
    ignoreViewerProfileInput = false;
  }

  function getFavoriteTeamId() {
    if (!authState.user || !authState.viewerProfile) return '';
    const favoriteTeamId = String(authState.viewerProfile.favoriteTeamId || '');
    if (!favoriteTeamId || !state || !state.teams.some((team) => team.id === favoriteTeamId)) {
      return '';
    }
    return favoriteTeamId;
  }

  function playFeedback(frequency) {
    if (!soundEnabled || !window.AudioContext && !window.webkitAudioContext) return;
    const now = performance.now();
    if (now - lastFeedbackAt < 42) return;
    lastFeedbackAt = now;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audio = new AudioContextClass();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.03, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.08);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.08);
  }

  function bindAuthActions() {
    elements.loginButton.addEventListener('click', async () => {
      try {
        await authApi.login();
      } catch (error) {
        console.warn(error);
        updateAuthStatus('ログインに失敗しました');
      }
    });

    elements.logoutButton.addEventListener('click', async () => {
      try {
        await authApi.logout();
      } catch (error) {
        console.warn(error);
        updateAuthStatus('ログアウトに失敗しました');
      }
    });

    elements.claimAdminButton.addEventListener('click', async () => {
      try {
        await authApi.claimAdmin();
        updateAuthStatus('管理者として登録しました');
        adminDirectoryLoaded = false;
        await refreshAdminDirectory();
      } catch (error) {
        console.warn(error);
        updateAuthStatus('管理者登録に失敗しました。既に初期管理者がいる可能性があります。');
      }
    });

    if (elements.refreshAdminsButton) {
      elements.refreshAdminsButton.addEventListener('click', async () => {
        adminDirectoryLoaded = false;
        await refreshAdminDirectory();
      });
    }
  }

  function canEditAdmin() {
    if (!isAdminMode) return false;
    return Boolean(authState.enabled && authState.user && authState.isAdmin);
  }

  function syncAdminAccess() {
    renderHeaderAuthState();
    elements.adminDockLink.hidden = !authState.isAdmin;
    elements.adminDockLink.parentElement.classList.toggle('has-admin', authState.isAdmin);
    if (!isAdminMode || !elements.adminPanel) return;

    const editable = canEditAdmin();
    elements.adminPanel.classList.toggle('is-locked', !editable);
    elements.adminPanel.classList.toggle('is-login-only', !editable);

    elements.loginButton.hidden = !authState.enabled || Boolean(authState.user);
    elements.logoutButton.hidden = !authState.enabled || !authState.user;
    elements.claimAdminButton.hidden = !authState.enabled || !authState.user || authState.isAdmin;
    if (elements.adminManager) {
      elements.adminManager.hidden = !authState.isAdmin;
    }

    if (authState.user) {
      elements.authUser.textContent = `${authState.user.displayName || 'Googleユーザー'} / ${authState.user.email || ''}`;
    } else {
      elements.authUser.textContent = '';
    }

    if (!authState.enabled) {
      updateAuthStatus('Firebase設定を入れるとGoogleログインが有効になります');
    } else if (!authState.user) {
      updateAuthStatus('編集するにはGoogleログインしてください');
    } else if (authState.isAdmin) {
      updateAuthStatus('管理者として編集できます');
    } else {
      updateAuthStatus('ログイン済みです。初回セットアップ時だけ管理者登録できます。通常は運営に昇格してもらってください');
    }

    elements.adminPanel.querySelectorAll('input, select, textarea, button').forEach((control) => {
      const isAuthControl = elements.authCard.contains(control);
      const isExportButton = control.id === 'export-json-btn';
      if (isAuthControl || isExportButton) {
        control.disabled = false;
        return;
      }
      control.disabled = !editable;
    });

    if (authState.isAdmin && !adminDirectoryLoaded) {
      refreshAdminDirectory();
    }
  }

  async function refreshAdminDirectory() {
    if (!isAdminMode || !authState.isAdmin || !authApi || !elements.adminList || !elements.viewerList) return;
    adminDirectoryLoaded = true;
    renderAccountLoading();
    try {
      const [admins, viewers] = await Promise.all([
        authApi.listAdmins(),
        authApi.listViewers()
      ]);
      adminDirectory = admins;
      viewerDirectory = viewers;
      renderAdminDirectory();
    } catch (error) {
      console.warn(error);
      adminDirectoryLoaded = false;
      renderAccountError();
    }
  }

  function renderAccountLoading() {
    if (!elements.adminList || !elements.viewerList) return;
    elements.adminList.replaceChildren(accountEmpty('読み込み中'));
    elements.viewerList.replaceChildren(accountEmpty('読み込み中'));
  }

  function renderAccountError() {
    if (!elements.adminList || !elements.viewerList) return;
    elements.adminList.replaceChildren(accountEmpty('取得できませんでした'));
    elements.viewerList.replaceChildren(accountEmpty('取得できませんでした'));
  }

  function renderAdminDirectory() {
    if (!elements.adminList || !elements.viewerList) return;
    elements.adminList.replaceChildren();
    elements.viewerList.replaceChildren();

    if (!adminDirectory.length) {
      elements.adminList.appendChild(accountEmpty('管理者が未登録です'));
    } else {
      adminDirectory.forEach((admin) => {
        elements.adminList.appendChild(accountCard(admin, {
          label: '解除',
          danger: true,
          disabled: adminDirectory.length <= 1,
          onClick: async () => {
            if (adminDirectory.length <= 1) {
              updateAuthStatus('最後の管理者は削除できません');
              return;
            }
            await authApi.removeAdmin(admin.uid);
            updateAuthStatus(`${accountName(admin)} を管理者から外しました`);
            adminDirectoryLoaded = false;
            await refreshAdminDirectory();
            if (authState.user && authState.user.uid === admin.uid) {
              await authApi.logout();
            }
          }
        }));
      });
    }

    const adminIds = new Set(adminDirectory.map((admin) => admin.uid));
    const candidates = viewerDirectory.filter((viewer) => viewer.uid && !adminIds.has(viewer.uid));
    if (!candidates.length) {
      elements.viewerList.appendChild(accountEmpty('昇格できる閲覧者はいません'));
    } else {
      candidates.forEach((viewer) => {
        elements.viewerList.appendChild(accountCard(viewer, {
          label: '昇格',
          onClick: async () => {
            await authApi.addAdmin(viewer.uid, viewer);
            updateAuthStatus(`${accountName(viewer)} を管理者に追加しました`);
            adminDirectoryLoaded = false;
            await refreshAdminDirectory();
          }
        }));
      });
    }
  }

  function accountCard(profile, action) {
    const card = document.createElement('div');
    card.className = 'account-card';

    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = accountName(profile);
    const detail = document.createElement('small');
    detail.textContent = profile.email || profile.uid || 'no id';
    text.append(name, detail);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.danger ? 'danger-button' : 'secondary-button';
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        await action.onClick();
      } catch (error) {
        console.warn(error);
        updateAuthStatus('管理者操作に失敗しました');
        button.disabled = false;
      }
    });

    card.append(text, button);
    return card;
  }

  function accountEmpty(message) {
    const item = document.createElement('div');
    item.className = 'account-empty';
    item.textContent = message;
    return item;
  }

  function accountName(profile) {
    return profile.displayName || profile.email || profile.uid || 'Googleユーザー';
  }

  function renderHeaderAuthState() {
    if (!authState.enabled) {
      elements.headerLoginLabel.textContent = '未設定';
      elements.headerLoginDetail.textContent = 'Firebase config';
      return;
    }

    if (!authState.user) {
      elements.headerLoginLabel.textContent = 'ログイン';
      elements.headerLoginDetail.textContent = 'viewer pass';
      return;
    }

    if (authState.isAdmin) {
      elements.headerLoginLabel.textContent = '運営';
      elements.headerLoginDetail.textContent = authState.user.email || 'admin';
    } else {
      elements.headerLoginLabel.textContent = '観戦';
      elements.headerLoginDetail.textContent = authState.user.email || 'viewer';
    }
  }

  function updateAuthStatus(message) {
    if (elements.authStatus) {
      elements.authStatus.textContent = message;
    }
  }
  function render(source) {
    if (!state) return;

    const stats = calculateStats(state);
    const completedMatches = state.matches.filter(isCompletedMatch).length;
    const totalMatches = state.matches.length;
    const progressPercent = totalMatches ? Math.round((completedMatches / totalMatches) * 100) : 0;

    elements.title.textContent = state.meta.title || 'コンパス ギルド大会';
    elements.eventMessage.textContent = state.meta.message || '進行状況を更新中';
    elements.metricTeams.textContent = String(state.teams.length);
    elements.metricProgress.textContent = `${progressPercent}%`;
    elements.metricMatches.textContent = `${completedMatches} / ${totalMatches}`;
    elements.lastUpdated.textContent = formatUpdatedAt(state.meta.updatedAt);

    renderTeamProgress(stats);
    renderMatches(stats);
    renderRanking(stats);
    renderPlayers();
    renderViewerPass();
    renderRoundRobin();
    renderActivityLog();
    renderHeaderAuthState();

    const isEditingAdminPanel = elements.adminPanel.contains(document.activeElement);
    const shouldRefreshAdmin = source === 'admin-local' || source === undefined || !isEditingAdminPanel;

    if (isAdminMode && shouldRefreshAdmin) {
      renderAdmin();
    }

    syncAdminAccess();

    if (source === 'remote') {
      setConnection('is-live', 'リアルタイム接続中');
    }
  }

  function renderTeamProgress(stats) {
    elements.teamProgressGrid.replaceChildren();
    const favoriteTeamId = getFavoriteTeamId();

    if (!state.teams.length) {
      elements.teamProgressGrid.appendChild(emptyState('チームが未登録です。'));
      return;
    }

    stats.ranking.forEach((team) => {
      const percent = team.scheduled ? Math.round((team.completed / team.scheduled) * 100) : 0;
      const card = document.createElement('article');
      card.className = 'team-card';
      if (team.id === favoriteTeamId) {
        card.classList.add('is-favorite');
      }

      const header = document.createElement('div');
      header.className = 'team-card-header';
      const name = document.createElement('h3');
      name.className = 'team-name';
      name.textContent = team.name;
      const rank = document.createElement('span');
      rank.className = 'team-rank';
      rank.textContent = `#${team.rank}`;
      header.append(name, rank);

      const meter = document.createElement('div');
      meter.className = 'progress-meter';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      const progressText = document.createElement('div');
      progressText.className = 'progress-text';
      const left = document.createElement('span');
      left.textContent = `${team.completed}/${team.scheduled} 試合`;
      const right = document.createElement('span');
      right.textContent = team.live ? '試合中' : `${percent}%`;
      progressText.append(left, right);
      meter.append(bar, progressText);

      const numbers = document.createElement('div');
      numbers.className = 'team-stats';
      numbers.append(
        miniStat('勝', team.wins),
        miniStat('ポータル', team.totalPortals),
        miniStat('Pt', team.totalPoints)
      );

      card.append(header, meter, numbers);
      elements.teamProgressGrid.appendChild(card);
    });
  }

  function renderMatches(stats) {
    elements.matchesContainer.replaceChildren();

    if (!state.matches.length) {
      elements.matchesContainer.appendChild(emptyState('試合が未登録です。'));
      return;
    }

    const orderedMatches = [...state.matches].sort((a, b) => numberValue(a.matchNo) - numberValue(b.matchNo));
    orderedMatches.forEach((match) => {
      const teamA = findTeam(match.teamAId);
      const teamB = findTeam(match.teamBId);
      const winnerId = getWinnerId(match);
      const card = document.createElement('article');
      card.className = `match-card is-${match.status}`;
      applyMatchCardEffects(card, match, winnerId);

      const top = document.createElement('div');
      top.className = 'match-card-top';
      const matchNo = document.createElement('span');
      matchNo.className = 'match-number';
      matchNo.textContent = `Match ${match.matchNo || '-'}`;
      top.append(matchNo, statusPill(match.status));

      const teams = document.createElement('div');
      teams.className = 'match-teams';
      teams.append(
        matchTeam(teamA.name, match.portalA, winnerId === teamA.id, match.id, 'a'),
        versus(),
        matchTeam(teamB.name, match.portalB, winnerId === teamB.id, match.id, 'b')
      );

      const meta = document.createElement('div');
      meta.className = 'match-meta';
      const round = document.createElement('span');
      round.textContent = match.round || '総当たり';
      const winner = document.createElement('span');
      winner.textContent = winnerId ? `勝者 ${findTeam(winnerId).name}` : '勝者 未定';
      meta.append(round, winner);

      card.append(top, teams, meta);
      elements.matchesContainer.appendChild(card);
    });
  }

  function renderRanking(stats) {
    elements.rankingTableBody.replaceChildren();
    const favoriteTeamId = getFavoriteTeamId();

    if (!stats.ranking.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'ランキングデータがありません。';
      row.appendChild(cell);
      elements.rankingTableBody.appendChild(row);
      return;
    }

    stats.ranking.forEach((team) => {
      const row = document.createElement('tr');
      if (team.id === favoriteTeamId) {
        row.className = 'is-favorite';
      }
      row.append(
        tableCell(String(team.rank), `rank-cell ${team.rank === 1 ? 'rank-top' : ''}`, '順位'),
        tableCell(team.name, '', 'チーム名'),
        tableCell(String(team.wins), '', '勝'),
        tableCell(String(team.losses), '', '負'),
        tableCell(String(team.totalPortals), '', 'ポータル'),
        tableCell(String(team.totalPoints), '', 'ポイント')
      );
      elements.rankingTableBody.appendChild(row);
    });
  }

  function renderPlayers() {
    elements.playerListGrouped.replaceChildren();
    const favoriteTeamId = getFavoriteTeamId();

    if (!state.teams.length) {
      elements.playerListGrouped.appendChild(emptyState('プレイヤーが未登録です。'));
      return;
    }

    state.teams.forEach((team) => {
      const members = state.teamMembers.filter((member) => member.teamId === team.id);
      const group = document.createElement('article');
      group.className = 'player-team-group';
      if (team.id === favoriteTeamId) {
        group.classList.add('is-favorite');
      }
      const title = document.createElement('h3');
      title.className = 'player-team-title';
      title.textContent = team.name;
      const list = document.createElement('ul');
      list.className = 'player-list';

      if (members.length) {
        members.forEach((member) => {
          const item = document.createElement('li');
          item.textContent = member.name;
          list.appendChild(item);
        });
      } else {
        const item = document.createElement('li');
        item.textContent = '未登録';
        list.appendChild(item);
      }

      group.append(title, list);
      elements.playerListGrouped.appendChild(group);
    });
  }

  function renderRoundRobin() {
    elements.roundRobinHeader.replaceChildren();
    elements.roundRobinBody.replaceChildren();
    if (elements.roundRobinCards) {
      elements.roundRobinCards.replaceChildren();
    }

    const headRow = document.createElement('tr');
    headRow.appendChild(tableHeader('\\'));
    state.teams.forEach((team) => {
      const th = tableHeader(team.name);
      th.className = 'matrix-team';
      headRow.appendChild(th);
    });
    elements.roundRobinHeader.appendChild(headRow);

    state.teams.forEach((rowTeam) => {
      const row = document.createElement('tr');
      const rowHeader = tableHeader(rowTeam.name);
      rowHeader.className = 'matrix-team';
      row.appendChild(rowHeader);

      state.teams.forEach((columnTeam) => {
        const cell = document.createElement('td');
        if (rowTeam.id === columnTeam.id) {
          cell.className = 'matrix-self';
          cell.textContent = '-';
        } else {
          const match = state.matches.find((item) => hasTeams(item, rowTeam.id, columnTeam.id));
          renderMatrixCell(cell, match, rowTeam.id);
        }
        row.appendChild(cell);
      });

      elements.roundRobinBody.appendChild(row);
    });

    renderRoundRobinCards();
  }

  function renderRoundRobinCards() {
    if (!elements.roundRobinCards) return;

    const orderedMatches = state.matches
      .filter((match) => findTeam(match.teamAId).id && findTeam(match.teamBId).id)
      .slice()
      .sort((a, b) => numberValue(a.matchNo) - numberValue(b.matchNo));

    if (!orderedMatches.length) {
      elements.roundRobinCards.appendChild(emptyState('総当たりデータがありません。'));
      return;
    }

    orderedMatches.forEach((match) => {
      const teamA = findTeam(match.teamAId);
      const teamB = findTeam(match.teamBId);
      const winnerId = getWinnerId(match);
      const card = document.createElement('article');
      card.className = `matrix-mobile-card is-${match.status}`;

      const top = document.createElement('div');
      top.className = 'matrix-mobile-top';
      const no = document.createElement('strong');
      no.textContent = `Match ${match.matchNo || '-'}`;
      top.append(no, statusPill(match.status));

      const teams = document.createElement('div');
      teams.className = 'matrix-mobile-teams';
      teams.append(
        matrixMobileTeam(teamA.name, match.portalA, winnerId === teamA.id),
        matrixMobileTeam(teamB.name, match.portalB, winnerId === teamB.id)
      );

      const result = document.createElement('div');
      result.className = 'matrix-mobile-result';
      result.textContent = winnerId ? `勝者 ${findTeam(winnerId).name}` : '結果 未入力';

      card.append(top, teams, result);
      elements.roundRobinCards.appendChild(card);
    });
  }

  function matrixMobileTeam(name, score, isWinner) {
    const row = document.createElement('div');
    row.className = `matrix-mobile-team${isWinner ? ' is-winner' : ''}`;

    const teamName = document.createElement('span');
    teamName.textContent = name || '未定';

    const scoreText = document.createElement('strong');
    scoreText.textContent = score === null || score === undefined || score === '' ? '-' : String(score);

    row.append(teamName, scoreText);
    return row;
  }

  function renderActivityLog() {
    const entries = getActivityEntries();
    elements.activityMiniList.replaceChildren();
    elements.activityPanelList.replaceChildren();

    entries.slice(0, 3).forEach((entry) => {
      const item = document.createElement('span');
      item.textContent = entry.message;
      elements.activityMiniList.appendChild(item);
    });

    if (!entries.length) {
      const empty = document.createElement('span');
      empty.textContent = '更新なし';
      elements.activityMiniList.appendChild(empty);
    }

    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'activity-entry';
      const message = document.createElement('span');
      message.textContent = entry.message;
      const time = document.createElement('time');
      time.textContent = formatLogTime(entry.createdAt);
      row.append(message, time);
      elements.activityPanelList.appendChild(row);
    });
  }

  function getActivityEntries() {
    const explicitEntries = Array.isArray(state.activityLog) ? state.activityLog : [];
    if (explicitEntries.length) {
      return explicitEntries
        .slice()
        .sort((a, b) => numberValue(b.createdAt) - numberValue(a.createdAt));
    }

    return state.matches
      .slice()
      .sort((a, b) => numberValue(b.matchNo) - numberValue(a.matchNo))
      .map((match) => {
        const winnerId = getWinnerId(match);
        const message = winnerId
          ? `${findTeam(winnerId).name}勝利`
          : `Match ${match.matchNo} ${statusLabel(match.status)}`;
        return {
          id: `auto-${match.id}`,
          message,
          type: winnerId ? 'result' : 'match',
          createdAt: state.meta.updatedAt || Date.now()
        };
      })
      .slice(0, 12);
  }

  function appendActivityLog(message, type) {
    const entry = {
      id: createId('log'),
      message,
      type: type || 'system',
      createdAt: Date.now()
    };
    state.activityLog = [entry, ...(state.activityLog || [])].slice(0, 60);
  }

  function renderMatrixCell(cell, match, rowTeamId) {
    if (!match) {
      cell.className = 'matrix-empty';
      cell.textContent = '未定';
      return;
    }

    if (['live', 'pause', 'review', 'extra'].includes(match.status)) {
      cell.className = 'matrix-live';
      cell.textContent = formatScoreForTeam(match, rowTeamId, statusLabel(match.status));
      return;
    }

    const winnerId = getWinnerId(match);
    if (!winnerId) {
      cell.className = 'matrix-empty';
      cell.textContent = formatScoreForTeam(match, rowTeamId, '未入力');
      return;
    }

    cell.className = winnerId === rowTeamId ? 'matrix-win' : 'matrix-loss';
    cell.textContent = formatScoreForTeam(match, rowTeamId, winnerId === rowTeamId ? '勝' : '負');
  }

  function renderAdmin() {
    ignoreNextAdminInput = true;
    elements.adminTitle.value = state.meta.title || '';
    elements.adminMessage.value = state.meta.message || '';
    elements.adminMaxTeams.value = state.settings.maxTeams;
    elements.adminPlayersPerTeam.value = state.settings.playersPerTeam;
    renderTeamEditor();
    renderMatchEditor();
    elements.addTeamButton.disabled = !canEditAdmin() || state.teams.length >= state.settings.maxTeams;
    ignoreNextAdminInput = false;
  }

  function renderTeamEditor() {
    elements.teamEditor.replaceChildren();

    state.teams.forEach((team) => {
      const row = document.createElement('div');
      row.className = 'team-editor-row';

      const nameField = field('チーム名');
      const nameInput = input('text', team.name);
      nameInput.addEventListener('input', () => {
        team.name = nameInput.value.trim();
        render();   
        queueSave();
      });
      nameField.appendChild(nameInput);

      const memberField = field('メンバー');
      const membersTextarea = document.createElement('textarea');
      membersTextarea.value = state.teamMembers
        .filter((member) => member.teamId === team.id)
        .map((member) => member.name)
        .join('\n');
      membersTextarea.addEventListener('input', () => {
        const names = membersTextarea.value
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean);
        const limitedNames = names.slice(0, state.settings.playersPerTeam);
        state.teamMembers = state.teamMembers.filter((member) => member.teamId !== team.id);
        limitedNames.forEach((name) => {
          state.teamMembers.push({ id: createId('member'), teamId: team.id, name });
        });
        if (names.length > limitedNames.length) {
          membersTextarea.value = limitedNames.join('\n');
        }
        render();   
        queueSave();
      });
      memberField.appendChild(membersTextarea);

      const removeButton = removeButtonFor('チーム削除');
      removeButton.addEventListener('click', () => {
        state.teams = state.teams.filter((item) => item.id !== team.id);
        state.teamMembers = state.teamMembers.filter((member) => member.teamId !== team.id);
        state.matches = state.matches.filter((match) => match.teamAId !== team.id && match.teamBId !== team.id);
        queueSave(true);
      });

      row.append(nameField, memberField, removeButton);
      elements.teamEditor.appendChild(row);
    });
  }

  function renderMatchEditor() {
    elements.matchEditor.replaceChildren();

    state.matches
      .slice()
      .sort((a, b) => numberValue(a.matchNo) - numberValue(b.matchNo))
      .forEach((match) => {
        const row = document.createElement('div');
        row.className = 'match-editor-row';

        const noField = field('No');
        const noInput = input('number', match.matchNo || '');
        noInput.min = '1';
        noInput.addEventListener('input', () => {
          match.matchNo = numberValue(noInput.value);
          queueSave();
        });
        noField.appendChild(noInput);

        const teamAField = field('チームA');
        const teamASelect = teamSelect(match.teamAId);
        teamASelect.addEventListener('change', () => {
          match.teamAId = teamASelect.value;
          if (match.winnerTeamId && ![match.teamAId, match.teamBId].includes(match.winnerTeamId)) {
            match.winnerTeamId = '';
          }
          queueSave(true);
        });
        teamAField.appendChild(teamASelect);

        const teamBField = field('チームB');
        const teamBSelect = teamSelect(match.teamBId);
        teamBSelect.addEventListener('change', () => {
          match.teamBId = teamBSelect.value;
          if (match.winnerTeamId && ![match.teamAId, match.teamBId].includes(match.winnerTeamId)) {
            match.winnerTeamId = '';
          }
          queueSave(true);
        });
        teamBField.appendChild(teamBSelect);

        const portalAField = field('ポータルA');
        const portalAInput = input('number', valueOrEmpty(match.portalA));
        portalAInput.min = '0';
        portalAInput.addEventListener('input', () => {
          match.portalA = nullableNumber(portalAInput.value);
          render('score-preview');
          queueSave();
        });
        portalAField.appendChild(portalAInput);

        const portalBField = field('ポータルB');
        const portalBInput = input('number', valueOrEmpty(match.portalB));
        portalBInput.min = '0';
        portalBInput.addEventListener('input', () => {
          match.portalB = nullableNumber(portalBInput.value);
          render('score-preview');
          queueSave();
        });
        portalBField.appendChild(portalBInput);

        const statusField = field('状態');
        const statusSelect = select([
          ['ready', '準備中'],
          ['waiting', '待機中'],
          ['live', '配信中'],
          ['pause', '中断'],
          ['review', '審議中'],
          ['done', '結果確定'],
          ['cancel', '中止'],
          ['extra', '延長戦']
        ], match.status);
        statusSelect.addEventListener('change', () => {
          const oldStatus = match.status;
          match.status = statusSelect.value;
          if (oldStatus !== match.status) {
            appendActivityLog(`Match ${match.matchNo} ${statusLabel(match.status)}`, 'match');
          }
          queueSave();
        });
        statusField.appendChild(statusSelect);

        const winnerField = field('勝者');
        const winnerSelect = winnerTeamSelect(match);
        winnerSelect.addEventListener('change', () => {
          const oldWinner = match.winnerTeamId;
          match.winnerTeamId = winnerSelect.value;
          if (match.winnerTeamId) {
            match.status = 'done';
          }
          if (oldWinner !== match.winnerTeamId && match.winnerTeamId) {
            appendActivityLog(`${findTeam(match.winnerTeamId).name}勝利`, 'result');
            appendActivityLog('ランキング更新', 'ranking');
          }
          queueSave(true);
        });
        winnerField.appendChild(winnerSelect);

        const removeButton = removeButtonFor('試合削除');
        removeButton.addEventListener('click', () => {
          state.matches = state.matches.filter((item) => item.id !== match.id);
          queueSave(true);
        });

        row.append(noField, teamAField, teamBField, portalAField, portalBField, statusField, winnerField, removeButton);
        elements.matchEditor.appendChild(row);
      });
  }

  function bindAdminActions() {
    elements.adminTitle.addEventListener('input', () => {
      if (ignoreNextAdminInput) return;
      state.meta.title = elements.adminTitle.value.trim();
      queueSave();
    });

    elements.adminMessage.addEventListener('input', () => {
      if (ignoreNextAdminInput) return;
      state.meta.message = elements.adminMessage.value.trim();
      queueSave();
    });

    elements.adminMaxTeams.addEventListener('input', () => {
      if (ignoreNextAdminInput) return;
      state.settings.maxTeams = clampInteger(elements.adminMaxTeams.value, 2, 32, 10);
      queueSave(true);
    });

    elements.adminPlayersPerTeam.addEventListener('input', () => {
      if (ignoreNextAdminInput) return;
      state.settings.playersPerTeam = clampInteger(elements.adminPlayersPerTeam.value, 1, 10, 3);
      trimTeamMembersToLimit();
      queueSave(true);
    });

    elements.addTeamButton.addEventListener('click', () => {
      if (state.teams.length >= state.settings.maxTeams) {
        updateAuthStatus(`チーム上限は${state.settings.maxTeams}チームです`);
        return;
      }
      state.teams.push({ id: createId('team'), name: `新チーム${state.teams.length + 1}` });
      appendActivityLog('チーム追加', 'team');
      queueSave(true);
    });

    elements.addMatchButton.addEventListener('click', () => {
      const teamA = state.teams[0] ? state.teams[0].id : '';
      const teamB = state.teams[1] ? state.teams[1].id : teamA;
      state.matches.push({
        id: createId('match'),
        matchNo: nextMatchNo(),
        round: '総当たり',
        teamAId: teamA,
        teamBId: teamB,
        portalA: null,
        portalB: null,
        winnerTeamId: '',
        status: 'waiting'
      });
      appendActivityLog(`Match ${nextMatchNo() - 1} 待機中`, 'match');
      queueSave(true);
    });

    elements.seedRemoteButton.addEventListener('click', async () => {
      await saveNow();
    });

    elements.exportJsonButton.addEventListener('click', () => {
      const json = JSON.stringify(normalizeTournamentData(state), null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `tournament-${roomId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  function queueSave(shouldRenderImmediately) {
    if (!isAdminMode || !store || !canEditAdmin()) return;
    state.meta.updatedAt = Date.now();
    if (shouldRenderImmediately) {
      render('admin-local');
    }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    if (!store || !canEditAdmin()) return;
    window.clearTimeout(saveTimer);
    try {
      setConnection('is-loading', '保存中');
      await store.save(normalizeTournamentData(state));
      if (store.type === 'remote') {
        setConnection('is-live', '保存済み');
      } else {
        setConnection('is-local', 'ローカル保存済み');
      }
    } catch (error) {
      console.warn(error);
      setConnection('is-error', '保存失敗');
    }
  }

  function calculateStats(data) {
    const statsByTeam = new Map();
    data.teams.forEach((team) => {
      statsByTeam.set(team.id, {
        id: team.id,
        name: team.name,
        wins: 0,
        losses: 0,
        scheduled: 0,
        completed: 0,
        live: 0,
        totalPortals: 0,
        totalPoints: 0,
        rank: 0
      });
    });

    data.matches.forEach((match) => {
      const teamA = statsByTeam.get(match.teamAId);
      const teamB = statsByTeam.get(match.teamBId);
      if (!teamA || !teamB || teamA.id === teamB.id) return;

      teamA.scheduled += 1;
      teamB.scheduled += 1;

      if (match.status === 'live') {
        teamA.live += 1;
        teamB.live += 1;
      }

      if (numberValue(match.portalA) || match.portalA === 0) {
        teamA.totalPortals += numberValue(match.portalA);
      }
      if (numberValue(match.portalB) || match.portalB === 0) {
        teamB.totalPortals += numberValue(match.portalB);
      }

      if (!isCompletedMatch(match)) return;

      teamA.completed += 1;
      teamB.completed += 1;

      const winnerId = getWinnerId(match);
      if (winnerId === teamA.id) {
        teamA.wins += 1;
        teamB.losses += 1;
      } else if (winnerId === teamB.id) {
        teamB.wins += 1;
        teamA.losses += 1;
      }
    });

    const ranking = [...statsByTeam.values()]
      .map((team) => ({
        ...team,
        totalPoints: team.wins * 2 + team.totalPortals
      }))
      .sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return b.totalPortals - a.totalPortals;
      })
      .map((team, index) => ({
        ...team,
        rank: index + 1
      }));

    return { statsByTeam, ranking };
  }

  function normalizeTournamentData(raw) {
    const source = raw || createEmptyTournament();
    const meta = {
      title: source.meta && source.meta.title ? source.meta.title : 'ギルドバトル 戦況解析ボード',
      message: source.meta && source.meta.message ? source.meta.message : '戦況データを解析待機中',
      updatedAt: source.meta && source.meta.updatedAt ? source.meta.updatedAt : Date.now()
    };
    const settings = {
      maxTeams: clampInteger(source.settings && source.settings.maxTeams, 2, 32, 10),
      playersPerTeam: clampInteger(source.settings && source.settings.playersPerTeam, 1, 10, 3)
    };

    const legacyTeams = Array.isArray(source.teams) ? source.teams : [];
    const nameToId = new Map();
    const teams = legacyTeams.map((team, index) => {
      const id = team.id || createStableId('team', team.name || `team-${index + 1}`);
      const name = team.name || `チーム${index + 1}`;
      nameToId.set(name, id);
      return { id, name };
    });

    const teamMembers = Array.isArray(source.teamMembers)
      ? source.teamMembers.map((member, index) => ({
          id: member.id || createStableId('member', `${member.team || member.teamId}-${member.name}-${index}`),
          name: member.name || '',
          teamId: member.teamId || nameToId.get(member.team) || teams[0]?.id || ''
        })).filter((member) => member.name && member.teamId)
      : [];

    const matches = Array.isArray(source.matches)
      ? source.matches.map((match, index) => {
          const teamAId = match.teamAId || nameToId.get(match.teamA) || teams[0]?.id || '';
          const teamBId = match.teamBId || nameToId.get(match.teamB) || teams[1]?.id || teamAId;
          const winnerTeamId = match.winnerTeamId || nameToId.get(match.winner) || '';
          return {
            id: match.id || createStableId('match', `${match.matchNo || index + 1}-${teamAId}-${teamBId}`),
            matchNo: numberValue(match.matchNo || index + 1),
            round: match.round || '総当たり',
            teamAId,
            teamBId,
            portalA: nullableNumber(match.portalA),
            portalB: nullableNumber(match.portalB),
            winnerTeamId,
            status: normalizeStatus(match.status, winnerTeamId)
          };
        }).filter((match) => match.teamAId && match.teamBId)
      : [];

    const activityLog = Array.isArray(source.activityLog)
      ? source.activityLog.map((entry, index) => ({
          id: entry.id || createStableId('log', `${entry.message || 'log'}-${index}`),
          message: entry.message || '',
          type: entry.type || 'system',
          createdAt: numberValue(entry.createdAt || meta.updatedAt || Date.now())
        })).filter((entry) => entry.message)
      : [];

    return { meta, settings, activityLog, teams, teamMembers, matches };
  }

  function createEmptyTournament() {
    return {
      meta: {
        title: 'ギルドバトル 戦況解析ボード',
        message: '戦況データを解析待機中',
        updatedAt: Date.now()
      },
      settings: {
        maxTeams: 10,
        playersPerTeam: 3
      },
      activityLog: [],
      teams: [],
      teamMembers: [],
      matches: []
    };
  }

  function normalizeStatus(status, winnerTeamId) {
    if (['ready', 'waiting', 'live', 'pause', 'review', 'done', 'cancel', 'extra'].includes(status)) return status;
    if (status === 'scheduled') return 'waiting';
    return winnerTeamId ? 'done' : 'waiting';
  }

  function isCompletedMatch(match) {
    return match.status === 'done' || Boolean(getWinnerId(match));
  }

  function getWinnerId(match) {
    return match.winnerTeamId && [match.teamAId, match.teamBId].includes(match.winnerTeamId)
      ? match.winnerTeamId
      : '';
  }

  function findTeam(teamId) {
    return state.teams.find((team) => team.id === teamId) || { id: teamId, name: '未定' };
  }

  function hasTeams(match, teamAId, teamBId) {
    return (match.teamAId === teamAId && match.teamBId === teamBId)
      || (match.teamAId === teamBId && match.teamBId === teamAId);
  }

  function formatScoreForTeam(match, teamId, label) {
    const isTeamA = match.teamAId === teamId;
    const ownScore = isTeamA ? match.portalA : match.portalB;
    const opponentScore = isTeamA ? match.portalB : match.portalA;
    const hasScore = ownScore !== null && opponentScore !== null;
    return hasScore ? `${label} ${ownScore}-${opponentScore}` : label;
  }

  function formatUpdatedAt(value) {
    if (!value) return '最終更新 --';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '最終更新 --';
    return `最終更新 ${date.toLocaleString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })}`;
  }

  function formatLogTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return date.toLocaleString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function setConnection(className, text) {
    const labels = {
      'is-live': '接続中',
      'is-loading': '同期中',
      'is-error': 'エラー',
      'is-local': 'ローカル'
    };
    elements.connectionLight.className = `status-light ${className}`;
    elements.connectionLabel.textContent = labels[className] || '接続';
    elements.connectionDetail.textContent = text;
  }

  function miniStat(label, value) {
    const wrapper = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    wrapper.append(span, strong);
    return wrapper;
  }

  function statusPill(status) {
    const pill = document.createElement('span');
    pill.className = `status-pill is-${status}`;
    pill.textContent = statusLabel(status);
    return pill;
  }

  function statusLabel(status) {
    const labels = {
      ready: '準備中',
      waiting: '待機中',
      live: '配信中',
      pause: '中断',
      review: '審議中',
      done: '結果確定',
      cancel: '中止',
      extra: '延長戦'
    };
    return labels[status] || '待機中';
  }

  function applyMatchCardEffects(card, match, winnerId) {
    const key = `match:${match.id}`;
    const nextSignature = `${match.status}|${winnerId || ''}`;
    const previousSignature = matchVisualCache.get(key);
    const hasSeen = matchVisualCache.has(key);
    matchVisualCache.set(key, nextSignature);

    if (!hasSeen) return;

    if (match.status === 'live' && previousSignature !== nextSignature) {
      card.classList.add('is-live-started');
    }

    if (winnerId && previousSignature !== nextSignature) {
      card.classList.add('is-result-updated');
      playFeedback(760);
    }
  }

  function matchTeam(name, score, isWinner, matchId, side) {
    const wrapper = document.createElement('div');
    wrapper.className = `match-team${isWinner ? ' is-winner' : ''}`;
    const teamName = document.createElement('span');
    teamName.className = 'match-team-name';
    teamName.textContent = name || '未定';
    const scoreText = document.createElement('span');
    scoreText.className = 'match-score';
    const displayScore = score === null || score === undefined || score === '' ? '-' : String(score);
    scoreText.textContent = displayScore;

    const scoreKey = `score:${matchId || 'unknown'}:${side || name || 'team'}`;
    const previousScore = matchVisualCache.get(scoreKey);
    const hasSeenScore = matchVisualCache.has(scoreKey);
    matchVisualCache.set(scoreKey, displayScore);

    if (hasSeenScore && previousScore !== displayScore) {
      requestAnimationFrame(() => {
        scoreText.classList.add('score-updated');
        window.setTimeout(() => {
          scoreText.classList.remove('score-updated');
        }, 260);
      });
    }

    wrapper.append(teamName, scoreText);
    return wrapper;
  }

  function versus() {
    const span = document.createElement('span');
    span.className = 'versus';
    span.textContent = 'VS';
    return span;
  }

  function tableCell(text, className, label) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    if (label) cell.dataset.label = label;
    cell.textContent = text;
    return cell;
  }

  function tableHeader(text) {
    const cell = document.createElement('th');
    cell.textContent = text;
    return cell;
  }

  function emptyState(text) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = text;
    return div;
  }

  function field(labelText) {
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    return label;
  }

  function input(type, value) {
    const node = document.createElement('input');
    node.type = type;
    node.value = value;
    node.autocomplete = 'off';
    return node;
  }

  function select(options, selectedValue) {
    const node = document.createElement('select');
    options.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      node.appendChild(option);
    });
    node.value = selectedValue;
    return node;
  }

  function teamSelect(selectedValue) {
    const node = document.createElement('select');
    state.teams.forEach((team) => {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name;
      node.appendChild(option);
    });
    node.value = selectedValue;
    return node;
  }

  function winnerTeamSelect(match) {
    const node = document.createElement('select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '未定';
    node.appendChild(emptyOption);
    [match.teamAId, match.teamBId].forEach((teamId) => {
      const team = findTeam(teamId);
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name;
      node.appendChild(option);
    });
    node.value = match.winnerTeamId || '';
    return node;
  }

  function removeButtonFor(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'danger-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = '×';
    return button;
  }

  function nextMatchNo() {
    const numbers = state.matches.map((match) => numberValue(match.matchNo));
    return numbers.length ? Math.max(...numbers) + 1 : 1;
  }

  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function trimTeamMembersToLimit() {
    const seenByTeam = new Map();
    state.teamMembers = state.teamMembers.filter((member) => {
      const count = seenByTeam.get(member.teamId) || 0;
      if (count >= state.settings.playersPerTeam) return false;
      seenByTeam.set(member.teamId, count + 1);
      return true;
    });
  }

  function nullableNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function createId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createStableId(prefix, value) {
    const normalized = String(value || prefix)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `${prefix}-${normalized || Math.random().toString(36).slice(2, 8)}`;
  }

  function sanitizeRoomId(value) {
    return String(value || 'main').replace(/[.#$/[\]]/g, '-').slice(0, 80) || 'main';
  }

  function normalizeDatabaseUrl(value) {
    if (!value || typeof value !== 'string') return '';
    return value.replace(/\/+$/, '');
  }

  function getDatabaseUrl() {
    return normalizeDatabaseUrl(
      config.firebaseDatabaseURL
      || config.databaseURL
      || (config.firebaseConfig && config.firebaseConfig.databaseURL)
    );
  }

  function getFirebaseConfig() {
    return config.firebaseConfig || {};
  }

  function setPath(target, path, value) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return value;
    const clone = Array.isArray(target) ? [...target] : { ...target };
    let cursor = clone;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      const next = cursor[key];
      cursor[key] = Array.isArray(next) ? [...next] : { ...(next || {}) };
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
    return clone;
  }
})();
