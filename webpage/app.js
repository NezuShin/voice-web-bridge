/*
 * Voice Web Bridge — Simple Voice Chat style browser client
 *
 * - Captures mic PCM via Web Audio, applies configurable gain and Voice
 *   Activation (Open Mic or dB threshold + holdover), and encodes
 *   48 kHz / 20 ms mono Opus frames via vendored opus-recorder worker.
 * - Incoming binary frames [0x02][16-byte speaker uuid][opus] are decoded per
 *   speaker with dedicated GainNodes for per-player volume/mute & live activity.
 * - Supports server-synced in-game Minecraft keybinds (Double Shift, Double
 *   Ctrl, Shift+F, Shift+Q) and /mic for toggling microphone On/Off.
 * - Includes a configurable Simple Voice Chat style floating HUD overlay with
 *   drag positioning, themes, Overlay Focus Mode, and Document PiP popout.
 *
 * Wire protocol is documented in webpage/README.md.
 */
(function () {
  'use strict';

  var ENCODER_WORKER_PATH = 'lib/encoderWorker.min.js';
  var DECODER_WORKER_PATH = 'lib/decoderWorker.min.js';
  var IDLE_TIMEOUT_MS = 5000;
  var PLAY_AHEAD_SECONDS = 0.08;
  var MAX_LOG_LINES = 100;

  var STORAGE_SETTINGS_KEY = 'voicebridge-settings-v1';
  var STORAGE_VOLUME_KEY = 'voicebridge-volume';
  var STORAGE_SPEAKERS_KEY = 'voicebridge-speakers-v1';
  var STORAGE_LANG_KEY = 'voicebridge-lang';

  // --- DOM References ---
  var statusEl = document.getElementById('status');
  var micSel = document.getElementById('mic-select');
  var speakerSel = document.getElementById('speaker-select');
  var volumeEl = document.getElementById('volume');
  var volumeValEl = document.getElementById('volume-val');
  var micGainEl = document.getElementById('mic-gain');
  var micGainValEl = document.getElementById('mic-gain-val');
  var outputEl = document.getElementById('output');

  var identityPillEl = document.getElementById('identity-pill');
  var selfAvatarCanvas = document.getElementById('self-avatar');
  var playerNameTextEl = document.getElementById('player-name-text');
  var connBadgeEl = document.getElementById('conn-badge');
  var connBadgeTextEl = document.getElementById('conn-badge-text');
  var btnReconnect = document.getElementById('btn-reconnect');
  var btnExitFocus = document.getElementById('btn-exit-focus');
  var btnPopout = document.getElementById('btn-popout-overlay');
  var langSel = document.getElementById('lang-select');

  var bannerMissingId = document.getElementById('banner-missing-id');
  var manualSessionInput = document.getElementById('manual-session-input');
  var btnManualConnect = document.getElementById('btn-manual-connect');
  var bannerInsecure = document.getElementById('banner-insecure');
  var bannerPermission = document.getElementById('banner-permission');
  var bannerPermTitle = document.getElementById('banner-permission-title');
  var bannerPermHint = document.getElementById('banner-permission-hint');
  var btnEnableMic = document.getElementById('btn-enable-mic');
  var btnEnableMicText = document.getElementById('btn-enable-mic-text');
  var bannerPlaybackResume = document.getElementById('banner-playback-resume');
  var btnResumeAudio = document.getElementById('btn-resume-audio');

  // Hero & primary controls
  var heroMicBox = document.getElementById('hero-mic-box');
  var heroMicSvg = document.getElementById('hero-mic-svg');
  var heroStateTitle = document.getElementById('hero-state-title');
  var heroStateSub = document.getElementById('hero-state-sub');
  var heroMeterLabel = document.getElementById('hero-meter-label');
  var heroMeterDb = document.getElementById('hero-meter-db');
  var heroMeterFill = document.getElementById('hero-meter-fill');
  var heroMeterThreshold = document.getElementById('hero-meter-threshold');

  var btnMicToggle = document.getElementById('btn-mic-toggle');
  var btnMicIcon = document.getElementById('btn-mic-icon');
  var btnMicKey = document.getElementById('btn-mic-key');
  var btnMicStateText = document.getElementById('btn-mic-state-text');
  var btnMicSub = document.getElementById('btn-mic-sub');

  var btnDeafen = document.getElementById('btn-deafen');
  var btnDeafenIcon = document.getElementById('btn-deafen-icon');
  var btnDeafenStateText = document.getElementById('btn-deafen-state-text');
  var btnDeafenSub = document.getElementById('btn-deafen-sub');

  // Voice & Controls Tab
  var btnRefreshDevices = document.getElementById('btn-refresh-devices');
  var sinkIdNoteEl = document.getElementById('sinkid-note');
  var btnMicTest = document.getElementById('btn-mic-test');
  var vadThresholdEl = document.getElementById('vad-threshold');
  var vadThresholdValEl = document.getElementById('vad-threshold-val');
  var vadMeterFill = document.getElementById('vad-meter-fill');
  var vadThresholdMark = document.getElementById('vad-threshold-mark');
  var vadHoldoverEl = document.getElementById('vad-holdover');
  var vadHoldoverValEl = document.getElementById('vad-holdover-val');

  var toggleMuteOnDeafen = document.getElementById('toggle-mute-on-deafen');
  var toggleUiSounds = document.getElementById('toggle-ui-sounds');
  var toggleEcBtn = document.getElementById('toggle-ec');
  var toggleNsBtn = document.getElementById('toggle-ns');
  var toggleAgcBtn = document.getElementById('toggle-agc');
  var btnResetAudio = document.getElementById('btn-reset-audio');
  var ingameSyncPill = document.getElementById('ingame-sync-pill');
  var ingameTriggerSel = document.getElementById('ingame-trigger-mode');
  var ingameTriggerHintEl = document.getElementById('ingame-trigger-hint');

  // Overlay Config Tab
  var pipActiveNotice = document.getElementById('pip-active-notice');
  var btnRecallPip = document.getElementById('btn-recall-pip');
  var toggleOvLabel = document.getElementById('toggle-ov-label');
  var toggleOvName = document.getElementById('toggle-ov-name');
  var toggleOvControls = document.getElementById('toggle-ov-controls');
  var toggleOvMeter = document.getElementById('toggle-ov-meter');
  var toggleOvKeys = document.getElementById('toggle-ov-keys');
  var toggleOvSpeakers = document.getElementById('toggle-ov-speakers');
  var btnResetOverlay = document.getElementById('btn-reset-overlay');
  var obsUrlInput = document.getElementById('obs-url-input');
  var btnCopyObsUrl = document.getElementById('btn-copy-obs-url');

  // Players & Log Tabs
  var speakerCountBadge = document.getElementById('speaker-count-badge');
  var playersSummaryEl = document.getElementById('players-summary');
  var btnRefreshPlayers = document.getElementById('btn-refresh-players');
  var btnResetAllVolumes = document.getElementById('btn-reset-all-volumes');
  var playerSearchEl = document.getElementById('player-search');
  var speakersListEl = document.getElementById('speakers-list');
  var sessionMetaEl = document.getElementById('session-meta');
  var eventLogEl = document.getElementById('event-log');
  var btnClearLog = document.getElementById('btn-clear-log');

  // Overlay Elements (Pop-Out PiP & Standalone/OBS)
  var overlayEl = document.getElementById('voice-overlay');
  var ovMicSvg = document.getElementById('ov-mic-svg');
  var ovStateLine = document.getElementById('ov-state-line');
  var ovSubLine = document.getElementById('ov-sub-line');
  var ovMeterEl = document.getElementById('ov-meter');
  var ovMeterFill = document.getElementById('ov-meter-fill');
  var ovControlsEl = document.getElementById('ov-controls');
  var ovBtnMic = document.getElementById('ov-btn-mic');
  var ovSpeakersEl = document.getElementById('ov-speakers');

  // --- Internationalization (i18n) ---

  var SUPPORTED_LOCALES = ['en_US', 'ru_RU'];

  var INLINE_EN_US = {
    'page.title': 'Voice Web Bridge - Proximity Voice Chat',

    'common.on': 'ON',
    'common.off': 'OFF',
    'common.refresh': 'Refresh',

    'focus.label': 'Overlay Focus Mode',
    'focus.exit': 'Exit Overlay Mode',

    'header.brand_title': 'VOICE WEB BRIDGE',
    'header.brand_subtitle': 'SIMPLE VOICE CHAT + PLASMO PROXIMITY WEB',
    'header.identity_title': 'Connected Minecraft player',
    'header.player_default': 'Player',
    'header.conn_connecting': 'CONNECTING',
    'header.conn_connected': 'CONNECTED',
    'header.conn_offline': 'OFFLINE',
    'header.conn_no_session': 'NO SESSION',
    'header.reconnect': 'Reconnect',
    'header.popout': 'Pop Out',
    'header.popout_title': 'Pop out always-on-top overlay window',
    'header.lang_title': 'Interface language',

    'banner.missing_id_title': 'No session ID in URL.',
    'banner.missing_id_hint': 'Open the link from Minecraft chat (?id=...) or paste your session UUID below. Settings and local mic test still work!',
    'banner.manual_session_placeholder': 'Paste session UUID or URL...',
    'banner.connect_btn': 'Connect',
    'banner.insecure_title': 'Microphone unavailable on insecure HTTP.',
    'banner.insecure_hint': 'Browsers require https:// or localhost for getUserMedia. You can still hear nearby players.',
    'banner.perm_needed_title': 'Microphone permission needed.',
    'banner.perm_needed_hint': 'Click Enable Microphone so the browser shows the audio permission prompt.',
    'banner.perm_unavailable_title': 'Microphone unavailable.',
    'banner.perm_unavailable_hint': 'Allow microphone permission and click Enable Microphone.',
    'banner.enable_mic_btn': 'Enable Microphone',
    'banner.retry_mic_btn': 'Retry Microphone',
    'banner.playback_paused_title': 'Browser paused audio playback.',
    'banner.playback_paused_hint': 'Click Resume Audio to hear nearby players.',
    'banner.resume_audio_btn': 'Resume Audio',

    'hero.unsupported_title': 'UNSUPPORTED BROWSER',
    'hero.unsupported_sub': 'WebRTC + WebAssembly + Workers required',
    'hero.unsupported_ov': 'UNSUPPORTED',
    'hero.insecure_title': 'LISTEN ONLY (HTTP)',
    'hero.insecure_sub': 'Serve over https:// or localhost for mic',
    'hero.insecure_ov': 'LISTEN ONLY',
    'hero.disconnected_title': 'DISCONNECTED',
    'hero.disconnected_sub': 'Not connected to voice server',
    'hero.missing_id_sub': 'Missing session ID',
    'hero.disconnected_ov': 'OFFLINE',
    'hero.deafened_title': 'DEAFENED',
    'hero.deafened_both_sub': 'Output & microphone muted',
    'hero.deafened_out_sub': 'Speaker output muted',
    'hero.deafened_ov': 'DEAFENED',
    'hero.muted_title': 'MIC OFF (MUTED)',
    'hero.muted_keybind_sub': 'Press {trigger} in Minecraft or click Mic',
    'hero.muted_default_sub': 'Click Mic or run /mic in Minecraft to unmute',
    'hero.muted_ov': 'MIC OFF',
    'hero.blocked_title': 'MIC BLOCKED',
    'hero.blocked_sub': 'Check browser permission and retry',
    'hero.blocked_ov': 'MIC ERROR',
    'hero.click_enable_title': 'CLICK TO ENABLE MIC',
    'hero.click_enable_sub': 'Browser requires a click to prompt mic access',
    'hero.click_enable_ov': 'ENABLE MIC',
    'hero.test_speaking_title': 'MIC TEST (SPEAKING)',
    'hero.test_active_title': 'MIC TEST ACTIVE',
    'hero.test_sub': 'Local loopback only — not sent to server',
    'hero.test_speaking_ov': 'TEST: SPEAKING',
    'hero.test_active_ov': 'MIC TEST',
    'hero.connecting_title': 'CONNECTING...',
    'hero.connecting_sub': 'Waiting for voice server handshake',
    'hero.connecting_ov': 'CONNECTING',
    'hero.speaking_title': 'SPEAKING',
    'hero.speaking_sub': 'Voice transmitting to nearby players',
    'hero.speaking_ov': 'SPEAKING',
    'hero.open_mic_title': 'MIC ON (OPEN)',
    'hero.open_mic_sub': 'Open microphone active',
    'hero.open_mic_ov': 'MIC ON',
    'hero.voice_ready_title': 'VOICE READY',
    'hero.voice_ready_sub': 'Threshold: {db} dB',
    'hero.voice_ready_ov': 'MIC READY',

    'meter.input_level': 'Input Level',
    'meter.input_muted': 'Input Level (Muted)',
    'meter.transmitting': 'Transmitting',
    'unit.db': '{value} dB',
    'unit.ms': '{value} ms',

    'controls.mic_prefix': 'Mic: ',
    'controls.mic_muted_sub': 'Muted (click to enable)',
    'controls.mic_transmitting_sub': 'Transmitting...',
    'controls.mic_active_sub': 'Active (click to mute)',
    'controls.sound_prefix': 'Sound: ',
    'controls.deafened_sub': 'Deafened (click to unmute)',
    'controls.deafen_sub': 'Click to deafen',
    'controls.speakers_volume': 'Speakers Volume',
    'controls.mic_gain': 'Microphone Gain',

    'tabs.voice': 'Voice & Controls',
    'tabs.players': 'Players',
    'tabs.overlay': 'Overlay Config',
    'tabs.log': 'Log',

    'devices.title': 'Audio Devices',
    'devices.mic_label': 'Recording Device (Microphone)',
    'devices.speaker_label': 'Playback Device (Speakers)',
    'devices.default_device': 'Default Device',
    'devices.numbered_device': 'Device {index}',
    'devices.sinkid_unsupported': 'This browser does not support speaker selection (setSinkId); system default output is used.',
    'devices.mic_test_label': 'Test Microphone (Local Loopback)',
    'devices.mic_test_hint': 'Hear your own mic locally without sending to server',
    'devices.testing': 'TESTING',

    'vad.title': 'Voice Activation',
    'vad.threshold_label': 'Voice Activation Threshold',
    'vad.threshold_open': '{db} dB (Open Mic)',
    'vad.open_mic': 'Open Mic',
    'vad.preset_65': '-65 dB',
    'vad.preset_50': '-50 dB',
    'vad.preset_35': '-35 dB',
    'vad.holdover_label': 'Voice Holdover Delay',

    'keybind.title': 'Minecraft Keybind',
    'keybind.sync_ready': 'Server Sync: READY',
    'keybind.sync_update': 'Server Sync: Update Plugin',
    'keybind.sync_offline': 'Server Sync: Offline',
    'keybind.section_hint': 'Toggle your microphone On/Off directly inside Minecraft (synced live via the server, zero client mods).',
    'keybind.select_label': 'Mic On/Off Keybind (In-Game)',
    'keybind.off_option': 'Off (Disabled)',
    'keybind.off_label': 'Off',
    'keybind.off_hint': 'No Minecraft keybind active. You can still run /mic in Minecraft chat or click Mic On/Off here.',
    'keybind.double_shift_label': 'Double Shift',
    'keybind.double_shift_hint': 'Quickly double-tap Shift (Sneak) in Minecraft to toggle your microphone On/Off.',
    'keybind.double_ctrl_label': 'Double Ctrl',
    'keybind.double_ctrl_hint': 'Quickly double-tap Ctrl (Sprint) in Minecraft to toggle your microphone On/Off.',
    'keybind.shift_f_label': 'Shift+F',
    'keybind.shift_f_hint': 'Press Shift+F (Sneak + Swap Hand) in Minecraft to toggle your microphone On/Off. Accidental item swaps are cancelled.',
    'keybind.shift_q_label': 'Shift+Q',
    'keybind.shift_q_hint': 'Press Shift+Q (Sneak + Drop) in Minecraft to toggle your microphone On/Off. Accidental item drops are cancelled (requires holding an item).',

    'processing.title': 'Mic & Audio Processing',
    'processing.mute_on_deafen': 'Mute Mic When Deafened',
    'processing.ui_sounds': 'UI Sound Cues (Click/Beep)',
    'processing.filters_label': 'Browser Mic Filters (restarts mic)',
    'processing.ec_btn': 'Echo Cancel: {state}',
    'processing.ns_btn': 'Noise Supp: {state}',
    'processing.agc_btn': 'Auto Gain: {state}',
    'processing.reset_audio': 'Reset Audio Defaults',

    'overlay.pip_active': 'Overlay is currently popped out in an Always-on-Top window.',
    'overlay.dock_back': 'Dock Back to Page',
    'overlay.appearance_title': 'Overlay Appearance & Elements',
    'overlay.show_label': 'Show State Text (SPEAKING / MUTED)',
    'overlay.show_name': 'Show Player Name in Overlay',
    'overlay.show_controls': 'Show Quick Mic Button',
    'overlay.show_meter': 'Show Live Mic Bar',
    'overlay.show_keys': 'Show Minecraft Keybind Hint',
    'overlay.show_speakers': 'Show Active Speakers',
    'overlay.reset_defaults': 'Reset Overlay Defaults',
    'overlay.obs_title': 'Standalone / OBS Browser Source URL',
    'overlay.obs_hint': 'Open this URL in a small window or OBS Browser Source (add &transparent=1 for transparent backdrop).',
    'overlay.copy_url': 'Copy URL',
    'overlay.copied': 'Copied!',
    'overlay.aria_label': 'Microphone State Overlay',
    'overlay.pip_window_title': 'Voice Web Bridge Overlay',
    'overlay.connected_sub': 'Connected',
    'overlay.mic_btn': 'Mic: {state}',

    'players.title': 'Adjust Player Volumes',
    'players.summary': 'Online: {online} • Voice: {voice}',
    'players.summary_speaking': 'Online: {online} • Voice: {voice} • Speaking: {speaking}',
    'players.reset_volumes': 'Reset Volumes',
    'players.search_placeholder': 'Search server players...',
    'players.filter_all': 'All',
    'players.filter_voice': 'Voice Only',
    'players.filter_speaking': 'Speaking',
    'players.section_hint': 'Adjust individual player volumes (0%-200%) or mute players like in Simple Voice Chat. Changes save automatically per player.',
    'players.empty_server': 'No other players online on the server yet. Online players will appear here automatically once connected.',
    'players.empty_filter': 'No players match the current search/filter.',
    'players.fallback_name': 'Player {id}',
    'players.badge_voice': 'VOICE',
    'players.badge_no_voice': 'NO VOICE',
    'players.speaking_tag': 'SPEAKING',
    'players.alias_title': 'Click to set local alias',
    'players.reset_one_title': 'Reset player volume to 100%',
    'players.mute': 'MUTE',
    'players.muted': 'MUTED',

    'log.title': 'Connection & Event Log',
    'log.session_meta': 'Session: {id}',
    'log.session_none': 'none',
    'log.clear': 'Clear Log',

    'footer.connecting': 'Connecting...',
    'footer.codec': 'Opus 48 kHz • 20 ms • Mono',

    'status.connecting_ws': 'Connecting to voice server...',
    'status.connected_insecure': 'Connected (listen only — https:// or localhost required for mic).',
    'status.connected_unsupported': 'Connected (listen only — browser lacks recording support).',
    'status.connected': 'Connected to Voice Web Bridge.',
    'status.ws_closed': 'Closed ({code})',
    'status.ws_closed_reason': 'Closed ({code}): {reason}',
    'status.reconnecting': 'Reconnecting in {seconds}s (attempt {attempt}/{max})...',
    'status.ws_error': 'WebSocket error — is the voice server running?',
    'status.insecure_append': 'Microphone unavailable: serve this page over https:// (or localhost).',
    'status.encoder_error': 'Encoder worker error: {error}',
    'status.mic_active': 'Microphone active — Voice active.',
    'status.mic_err_denied': 'Microphone permission was not granted. Allow the microphone in browser site settings, then click Enable Microphone.',
    'status.mic_err_not_found': 'No microphone found. Connect a microphone and retry.',
    'status.mic_err_busy': 'Microphone is busy in another application. Close it and retry.',
    'status.mic_err_overconstrained': 'Selected microphone does not support requested settings. Pick another device.',
    'status.mic_err_generic': 'Microphone error: {error}',
    'status.pip_unsupported': 'Pop-Out Always-on-Top window requires a Chromium browser (Chrome/Edge/Brave).',
    'status.pip_opened': 'Popped out always-on-top overlay window.',
    'status.pip_failed': 'Could not open popout window: {error}',
    'status.speaker_unsupported': 'This browser does not support speaker selection.',
    'status.speaker_failed': 'Speaker change failed: {error}',
    'status.audio_reset': 'Audio & keybind settings reset to defaults.',
    'status.keybind_set': 'Minecraft Mic On/Off keybind set to: {label}',
    'status.overlay_reset': 'Overlay settings reset to defaults.',
    'status.volumes_reset': 'Reset all player volumes to 100%.',
    'status.boot_unsupported': 'This browser does not support recording (getUserMedia + WebAssembly + Workers required).',
    'status.boot_insecure': 'Microphone unavailable: serve this page over https:// (or localhost). Playback still works.',
    'status.boot_no_id': 'No id parameter in URL. Open the link from game chat (?id=...) or paste a session ID above.',

    'server.connected_as': 'Connected as {player}',
    'server.replaced_info': 'New page opened; closing this connection',
    'server.replaced_reason': 'New page opened',
    'server.missing_id': 'Missing id parameter',
    'server.session_not_found': 'Session not found',
    'server.player_left': 'Player left the game',
    'server.server_stopped': 'Server stopped'
  };

  var loadedLocales = { en_US: INLINE_EN_US };
  var localePromises = {};

  function matchSupportedLocale(tag) {
    if (!tag || typeof tag !== 'string') return null;
    var cleaned = tag.trim().replace(/-/g, '_');
    if (!cleaned) return null;
    var lower = cleaned.toLowerCase();
    for (var i = 0; i < SUPPORTED_LOCALES.length; i++) {
      if (SUPPORTED_LOCALES[i].toLowerCase() === lower) {
        return SUPPORTED_LOCALES[i];
      }
    }
    var prefix = lower.split('_')[0];
    if (prefix === 'ru') return 'ru_RU';
    if (prefix === 'en') return 'en_US';
    return null;
  }

  function detectInitialLocale() {
    try {
      var saved = localStorage.getItem(STORAGE_LANG_KEY);
      var matchedSaved = matchSupportedLocale(saved);
      if (matchedSaved) return matchedSaved;
    } catch (e) {}

    var browserList = [];
    if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages)) {
        browserList = browserList.concat(navigator.languages);
      }
      if (navigator.language) {
        browserList.push(navigator.language);
      }
    }
    for (var i = 0; i < browserList.length; i++) {
      var matched = matchSupportedLocale(browserList[i]);
      if (matched) return matched;
    }
    return 'en_US';
  }

  var currentLocale = detectInitialLocale();

  function htmlLangForLocale(locale) {
    return String(locale || 'en_US').split('_')[0].toLowerCase() || 'en';
  }

  function t(key, params) {
    var dict = loadedLocales[currentLocale] || INLINE_EN_US;
    var template = Object.prototype.hasOwnProperty.call(dict, key)
      ? dict[key]
      : (Object.prototype.hasOwnProperty.call(INLINE_EN_US, key) ? INLINE_EN_US[key] : key);
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, function (full, k) {
      return Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined && params[k] !== null
        ? String(params[k])
        : full;
    });
  }

  function loadLocaleFile(locale) {
    if (localePromises[locale]) return localePromises[locale];
    if (typeof fetch !== 'function') {
      if (!loadedLocales[locale]) loadedLocales[locale] = INLINE_EN_US;
      return Promise.resolve(loadedLocales[locale]);
    }
    var url = 'lang/' + encodeURIComponent(locale) + '.json';
    localePromises[locale] = fetch(url, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json && typeof json === 'object') {
          var merged = {};
          var k;
          for (k in INLINE_EN_US) merged[k] = INLINE_EN_US[k];
          for (k in json) {
            if (Object.prototype.hasOwnProperty.call(json, k) && typeof json[k] === 'string') {
              merged[k] = json[k];
            }
          }
          loadedLocales[locale] = merged;
        }
        return loadedLocales[locale] || INLINE_EN_US;
      })
      .catch(function () {
        delete localePromises[locale];
        if (!loadedLocales[locale]) loadedLocales[locale] = INLINE_EN_US;
        return loadedLocales[locale];
      });
    return localePromises[locale];
  }

  function applyDomTranslations(rootDoc) {
    var doc = rootDoc || document;
    if (!doc) return;
    doc.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    doc.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', t(key));
    });
    doc.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', t(key));
    });
    doc.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-aria-label');
      if (key) el.setAttribute('aria-label', t(key));
    });
  }

  // --- Minecraft In-Game Mic Keybinds ---

  var INGAME_TRIGGER_INFO = {
    off: {
      chip: '',
      labelKey: 'keybind.off_label',
      hintKey: 'keybind.off_hint'
    },
    double_shift: {
      chip: '2x SHIFT',
      labelKey: 'keybind.double_shift_label',
      hintKey: 'keybind.double_shift_hint'
    },
    double_ctrl: {
      chip: '2x CTRL',
      labelKey: 'keybind.double_ctrl_label',
      hintKey: 'keybind.double_ctrl_hint'
    },
    shift_f: {
      chip: 'SHIFT+F',
      labelKey: 'keybind.shift_f_label',
      hintKey: 'keybind.shift_f_hint'
    },
    shift_q: {
      chip: 'SHIFT+Q',
      labelKey: 'keybind.shift_q_label',
      hintKey: 'keybind.shift_q_hint'
    }
  };

  function normalizeIngameTrigger(value) {
    if (value === 'sneak_swap_mic') return 'shift_f';
    if (value && Object.prototype.hasOwnProperty.call(INGAME_TRIGGER_INFO, value)) {
      return value;
    }
    return 'off';
  }

  function getIngameTriggerInfo(value) {
    var meta = INGAME_TRIGGER_INFO[normalizeIngameTrigger(value)];
    return {
      chip: meta.chip,
      label: t(meta.labelKey),
      hint: t(meta.hintKey)
    };
  }

  // --- Defaults & Settings Persistence ---

  function defaultAudioSettings() {
    return {
      volume: 100,
      micGain: 100,
      micDeviceId: null,
      speakerDeviceId: null,
      micMuted: false,
      deafened: false,
      muteMicOnDeafen: true,
      vadThresholdDb: -100,  // -100 = Open Mic
      vadHoldoverMs: 300,
      uiSounds: true,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ingameTrigger: 'off'   // 'off' | 'double_shift' | 'double_ctrl' | 'shift_f' | 'shift_q'
    };
  }

  function defaultOverlaySettings() {
    return {
      showLabel: true,
      showPlayerName: true,
      showControls: true,
      showMeter: true,
      showKeyHints: true,
      showSpeakers: true
    };
  }

  function mergeDefined(base, src) {
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    if (src && typeof src === 'object') {
      for (k in base) {
        if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) {
          out[k] = src[k];
        }
      }
    }
    return out;
  }

  function loadSettings() {
    var audio = defaultAudioSettings();
    var overlay = defaultOverlaySettings();
    try {
      var legacyVol = localStorage.getItem(STORAGE_VOLUME_KEY);
      if (legacyVol !== null && !isNaN(parseInt(legacyVol, 10))) {
        audio.volume = clamp(parseInt(legacyVol, 10), 0, 200);
      }
      var raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.audio) audio = mergeDefined(audio, parsed.audio);
        if (parsed && parsed.overlay) overlay = mergeDefined(overlay, parsed.overlay);
      }
    } catch (e) {}
    audio.ingameTrigger = normalizeIngameTrigger(audio.ingameTrigger);
    return { audio: audio, overlay: overlay };
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(STORAGE_VOLUME_KEY, String(settings.audio.volume));
    } catch (e) {}
  }

  function loadSpeakerPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_SPEAKERS_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      return {};
    }
  }

  function saveSpeakerPrefs() {
    try {
      localStorage.setItem(STORAGE_SPEAKERS_KEY, JSON.stringify(speakerPrefs));
    } catch (e) {}
  }

  var settings = loadSettings();
  var speakerPrefs = loadSpeakerPrefs();

  // --- URL Params ---
  var urlParams = new URLSearchParams(window.location.search);
  var sessionId = urlParams.get('id');
  var overlayFocusMode = urlParams.get('overlay') === '1';
  if (urlParams.get('transparent') === '1') {
    document.documentElement.classList.add('obs-transparent');
  }
  if (overlayFocusMode) {
    document.body.classList.add('overlay-focus-mode');
  }

  // --- Runtime State ---
  var secureContext = window.isSecureContext !== false;
  var browserSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext) &&
    window.WebAssembly && window.Worker);

  var ws = null;
  var wsState = sessionId ? 'connecting' : 'idle'; // 'idle' | 'connecting' | 'connected' | 'disconnected'
  var allowReconnect = false;
  var reconnectTimer = null;
  var reconnectAttempt = 0;

  var playerName = 'Player';
  var selfUuid = null;
  var hasPlayerIdentity = false;
  var serverCapabilities = {};
  var serverPlayers = {}; // uuid -> { uuid, name, mods, web, voice }
  var playerSearchQuery = '';
  var playerFilter = 'all'; // 'all' | 'voice' | 'speaking'

  var captureCtx = null;
  var micStream = null;
  var micSource = null;
  var micGainNode = null;
  var micProcessor = null;
  var encoderWorker = null;
  var encoderReady = false;
  var captureSeq = 0;
  var micPermissionState = !browserSupported ? 'unsupported' : (!secureContext ? 'insecure' : 'prompt');
  var micErrorKey = '';
  var micErrorParams = null;

  var playbackCtx = null;
  var playbackDest = null;
  var playbackGain = null;

  var streams = {};        // speaker uuid -> { worker, gainNode, pageIndex, lastActivity, lastSpokeAt, level, serial, nextPlayTime }
  var knownSpeakers = {};  // speaker uuid -> { uuid, lastSeen, speaking }
  var localTestStream = { nextPlayTime: 0 };

  var micTestEnabled = false;
  var vadHoldUntil = 0;
  var wasTransmitting = false;
  var flushingFinalFrame = false;

  var currentDb = -100;
  var smoothedLevel = 0;
  var lastUiMeterPaint = 0;
  var pipWindow = null;
  var copyObsCopied = false;
  var copyObsTimer = null;
  var lastStatus = null;

  // --- Logging & Status ---

  function logEvent(message, level) {
    if (!eventLogEl) return;
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    var line = document.createElement('div');
    line.className = 'log-line log-line--' + (level || 'info');
    line.textContent = '[' + hh + ':' + mm + ':' + ss + '] ' + message;
    eventLogEl.appendChild(line);
    while (eventLogEl.children.length > MAX_LOG_LINES) {
      eventLogEl.removeChild(eventLogEl.firstChild);
    }
    eventLogEl.scrollTop = eventLogEl.scrollHeight;
  }

  function translateServerText(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    var m = raw.match(/^Connected as (.+)$/);
    if (m && m[1]) return t('server.connected_as', { player: m[1].trim() });
    if (raw === 'New page opened; closing this connection') return t('server.replaced_info');
    if (raw === 'New page opened') return t('server.replaced_reason');
    if (raw === 'Missing id parameter') return t('server.missing_id');
    if (raw === 'Session not found') return t('server.session_not_found');
    if (raw === 'Player left the game') return t('server.player_left');
    if (raw === 'Server stopped') return t('server.server_stopped');
    return raw;
  }

  function formatStatusDescriptor(desc) {
    if (!desc) return '';
    if (desc.kind === 'key') {
      return t(desc.key, desc.params);
    }
    if (desc.kind === 'ws_closed') {
      var translatedReason = desc.reason ? translateServerText(desc.reason) : '';
      return translatedReason
        ? t('status.ws_closed_reason', { code: desc.code, reason: translatedReason })
        : t('status.ws_closed', { code: desc.code });
    }
    if (desc.kind === 'server') {
      var base = translateServerText(desc.raw);
      return desc.appendInsecure ? (base + '\n' + t('status.insecure_append')) : base;
    }
    return String(desc.raw || '');
  }

  function setStatusDescriptor(desc, level) {
    lastStatus = desc;
    var text = formatStatusDescriptor(desc);
    statusEl.textContent = text;
    logEvent(text.replace(/\n/g, ' | '), level || 'info');
  }

  function show(message, level) {
    setStatusDescriptor({ kind: 'raw', raw: message }, level);
  }

  function showKey(key, params, level) {
    setStatusDescriptor({ kind: 'key', key: key, params: params || null }, level);
  }

  function refreshStatusText() {
    if (lastStatus) {
      statusEl.textContent = formatStatusDescriptor(lastStatus);
    }
  }

  // --- Deterministic Pixel Steve Avatar ---

  function drawPixelAvatar(canvas, seedStr) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var hash = 2166136261;
    var str = String(seedStr || 'player');
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    var hue = (hash >>> 0) % 360;
    var hairHue = ((hash >>> 9) % 360);
    var skinTone = 'hsl(' + (22 + (hue % 24)) + ', ' + (45 + (hue % 25)) + '%, ' + (54 + (hue % 18)) + '%)';
    var hairTone = 'hsl(' + hairHue + ', 45%, 28%)';
    var accentTone = 'hsl(' + hue + ', 65%, 45%)';
    var eyeTone = '#181822';

    ctx.fillStyle = skinTone;
    ctx.fillRect(0, 0, 8, 8);
    // Hair top
    ctx.fillStyle = hairTone;
    ctx.fillRect(0, 0, 8, 2);
    ctx.fillRect(0, 2, 1, 2);
    ctx.fillRect(7, 2, 1, 2);
    // Symmetric pixel pattern on forehead/beard
    if ((hash & 1) === 0) {
      ctx.fillStyle = accentTone;
      ctx.fillRect(2, 1, 4, 1);
    }
    // Eyes
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1, 4, 2, 1);
    ctx.fillRect(5, 4, 2, 1);
    ctx.fillStyle = eyeTone;
    ctx.fillRect(2, 4, 1, 1);
    ctx.fillRect(5, 4, 1, 1);
    // Nose / Mouth
    ctx.fillStyle = hairTone;
    ctx.fillRect(3, 5, 2, 1);
    ctx.fillRect(2, 6, 4, 1);
  }

  // --- Subtle 8-bit UI Feedback Tones ---

  function playUiCue(kind) {
    if (!settings.audio.uiSounds || settings.audio.deafened) return;
    if (!playbackCtx || playbackCtx.state !== 'running') return;
    try {
      var now = playbackCtx.currentTime;
      var osc = playbackCtx.createOscillator();
      var g = playbackCtx.createGain();
      osc.type = 'triangle';
      if (kind === 'mic-on') {
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.setValueAtTime(760, now + 0.035);
        g.gain.setValueAtTime(0.055, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
        osc.connect(g); g.connect(playbackDest);
        osc.start(now); osc.stop(now + 0.09);
      } else if (kind === 'mic-off') {
        osc.frequency.setValueAtTime(560, now);
        osc.frequency.setValueAtTime(370, now + 0.035);
        g.gain.setValueAtTime(0.055, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
        osc.connect(g); g.connect(playbackDest);
        osc.start(now); osc.stop(now + 0.09);
      } else if (kind === 'deafen') {
        osc.frequency.setValueAtTime(410, now);
        g.gain.setValueAtTime(0.045, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
        osc.connect(g); g.connect(playbackDest);
        osc.start(now); osc.stop(now + 0.075);
      }
    } catch (e) {}
  }

  // --- SVG Icon Helper ---

  function setSvgHref(svgEl, symbolId) {
    if (!svgEl) return;
    var useEl = svgEl.querySelector('use');
    if (useEl) useEl.setAttribute('href', '#' + symbolId);
  }

  // --- WebSocket Connection ---

  function wsUrlForSession(id) {
    var path = '/voice-ws?id=' + encodeURIComponent(id);
    if (window.location.protocol === 'https:') return 'wss://' + window.location.host + path;
    if (window.location.protocol === 'http:') return 'ws://' + window.location.host + path;
    return 'ws://127.0.0.1:8090' + path; // file:// development fallback
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connectWebSocket() {
    clearReconnectTimer();
    if (!sessionId) {
      wsState = 'idle';
      updateUiState();
      return;
    }
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch (e) {}
      ws = null;
    }

    wsState = 'connecting';
    allowReconnect = true;
    updateUiState();
    showKey('status.connecting_ws');

    ws = new WebSocket(wsUrlForSession(sessionId));
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      wsState = 'connected';
      reconnectAttempt = 0;
      ensurePlayback();
      refreshDevices();
      sendIngameTriggerConfig();
      sendMicState(false);
      requestServerPlayers();
      if (!secureContext) {
        showKey('status.connected_insecure', null, 'warn');
        updateUiState();
        return;
      }
      if (!browserSupported) {
        showKey('status.connected_unsupported', null, 'warn');
        updateUiState();
        return;
      }
      showKey('status.connected');
      maybeAutoStartMicOnConnect();
      updateUiState();
    };

    ws.onmessage = function (event) {
      if (typeof event.data === 'string') {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        handleServerJson(msg);
        return;
      }
      handleAudioFrame(new Uint8Array(event.data));
    };

    ws.onclose = function (event) {
      var code = event.code;
      var reason = event.reason || '';
      wsState = 'disconnected';
      wasTransmitting = false;
      flushingFinalFrame = false;
      serverCapabilities = {};

      if (code === 4001 || code === 4004 || (code === 1000 && reason.indexOf('Player left') !== -1)) {
        allowReconnect = false;
      }

      setStatusDescriptor(
        { kind: 'ws_closed', code: code, reason: reason },
        code === 1000 ? 'warn' : 'error'
      );
      updateUiState();

      if (allowReconnect && reconnectAttempt < 5) {
        var delayMs = Math.min(10000, 1500 * Math.pow(2, reconnectAttempt));
        reconnectAttempt++;
        logEvent(t('status.reconnecting', {
          seconds: Math.round(delayMs / 1000),
          attempt: reconnectAttempt,
          max: 5
        }), 'warn');
        reconnectTimer = setTimeout(connectWebSocket, delayMs);
      }
    };

    ws.onerror = function () {
      showKey('status.ws_error', null, 'error');
      updateUiState();
    };
  }

  function sendWsJson(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }

  function sendIngameTriggerConfig() {
    sendWsJson({ type: 'config', ingameTrigger: normalizeIngameTrigger(settings.audio.ingameTrigger) });
  }

  function sendMicState(notify) {
    sendWsJson({ type: 'mic_state', muted: !!settings.audio.micMuted, notify: !!notify });
  }

  function requestServerPlayers() {
    sendWsJson({ type: 'request_players' });
  }

  function handleServerJson(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'welcome') {
      if (msg.playerUuid) selfUuid = String(msg.playerUuid);
      if (msg.playerName) {
        playerName = String(msg.playerName);
        hasPlayerIdentity = true;
        drawPixelAvatar(selfAvatarCanvas, playerName);
      }
      serverCapabilities = {};
      if (Array.isArray(msg.capabilities)) {
        msg.capabilities.forEach(function (c) { serverCapabilities[c] = true; });
      }
      sendIngameTriggerConfig();
      sendMicState(false);
      updateUiState();
      renderSpeakersList();
      return;
    }

    if (msg.type === 'players' && Array.isArray(msg.players)) {
      var nextMap = {};
      msg.players.forEach(function (p) {
        if (!p || !p.uuid) return;
        nextMap[p.uuid] = {
          uuid: String(p.uuid),
          name: String(p.name || p.uuid.slice(0, 8)),
          mods: Array.isArray(p.mods) ? p.mods : [],
          web: !!p.web,
          voice: !!p.voice
        };
      });
      serverPlayers = nextMap;
      renderSpeakersList();
      updateUiState();
      return;
    }

    if (msg.type === 'control') {
      handleRemoteControl(msg);
      return;
    }

    // Optional forward-compatible speaker metadata support
    if (msg.type === 'speaker' && msg.uuid && msg.name) {
      var pref = getSpeakerPref(msg.uuid);
      if (!pref.nickname) {
        pref.serverName = msg.name;
      }
      renderSpeakersList();
      return;
    }

    var rawText = msg.message ? String(msg.message) : JSON.stringify(msg);
    if (typeof msg.message === 'string') {
      var m = msg.message.match(/^Connected as (.+)$/);
      if (m && m[1]) {
        playerName = m[1].trim();
        hasPlayerIdentity = true;
        drawPixelAvatar(selfAvatarCanvas, playerName);
      }
    }
    setStatusDescriptor(
      { kind: 'server', raw: rawText, appendInsecure: !secureContext },
      msg.type === 'error' ? 'error' : 'ok'
    );
    updateUiState();
  }

  function handleRemoteControl(msg) {
    if (msg.action === 'mic_toggle') {
      toggleMicMute(true);
    }
  }

  function maybeAutoStartMicOnConnect() {
    if (micStream && captureCtx) return;
    if (navigator.permissions && navigator.permissions.query) {
      try {
        navigator.permissions.query({ name: 'microphone' }).then(function (perm) {
          if (perm && perm.state === 'granted') {
            startCapture(settings.audio.micDeviceId);
          } else if (perm && perm.state === 'denied') {
            micPermissionState = 'denied';
            updateUiState();
          }
        }).catch(function () {});
      } catch (e) {}
    }
  }

  // --- Microphone Capture & Encoder ---

  function initEncoder(sampleRate) {
    if (encoderWorker) { try { encoderWorker.terminate(); } catch (e) {} }
    encoderReady = false;
    packetParts = [];
    encoderWorker = new Worker(ENCODER_WORKER_PATH);
    encoderWorker.onerror = function (e) {
      showKey('status.encoder_error', { error: (e && e.message ? e.message : 'unknown') }, 'error');
    };
    encoderWorker.onmessage = function (e) {
      var data = e.data;
      if (!data) return;
      if (data.message === 'ready') {
        encoderReady = true;
        return;
      }
      if (data.message === 'done') {
        flushingFinalFrame = false;
        return;
      }
      if (data.page && !micTestEnabled && ws && ws.readyState === WebSocket.OPEN && (wasTransmitting || flushingFinalFrame)) {
        var packets = extractOpusPackets(data.page);
        for (var i = 0; i < packets.length; i++) {
          ws.send(packets[i]);
        }
      }
    };
    postEncoderInit(sampleRate);
  }

  function postEncoderInit(sampleRate) {
    if (!encoderWorker) return;
    encoderWorker.postMessage({
      command: 'init',
      encoderApplication: 2048,
      encoderFrameSize: 20,
      encoderSampleRate: 48000,
      encoderBitRate: 32000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
      originalSampleRate: sampleRate,
      resampleQuality: 3,
      serial: Math.floor(Math.random() * 4294967296)
    });
  }

  function resetEncoderCycle() {
    if (!encoderWorker || !captureCtx) return;
    packetParts = [];
    encoderWorker.postMessage({ command: 'done' });
    postEncoderInit(captureCtx.sampleRate);
  }

  function stopCapture() {
    wasTransmitting = false;
    flushingFinalFrame = false;
    currentDb = -100;
    smoothedLevel = 0;
    if (encoderWorker) {
      try { encoderWorker.terminate(); } catch (e) {}
      encoderWorker = null;
      encoderReady = false;
    }
    if (micProcessor) { try { micProcessor.disconnect(); } catch (e) {} micProcessor = null; }
    if (micGainNode) { try { micGainNode.disconnect(); } catch (e) {} micGainNode = null; }
    if (micSource) { try { micSource.disconnect(); } catch (e) {} micSource = null; }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    if (captureCtx) { captureCtx.close().catch(function () {}); captureCtx = null; }
    updateUiState();
  }

  function applyMicGain() {
    if (micGainNode) {
      micGainNode.gain.value = clamp(settings.audio.micGain, 0, 200) / 100;
    }
  }

  function computeShouldTransmit(now, db) {
    if (!micStream || !captureCtx) return false;
    if (settings.audio.micMuted) return false;
    if (!micTestEnabled && (!ws || ws.readyState !== WebSocket.OPEN)) return false;

    if (settings.audio.vadThresholdDb <= -95) {
      return true; // Open Mic
    }
    if (db >= settings.audio.vadThresholdDb) {
      vadHoldUntil = now + settings.audio.vadHoldoverMs;
      return true;
    }
    return now < vadHoldUntil;
  }

  function startCapture(deviceId) {
    if (!secureContext || !browserSupported) return;
    var seq = ++captureSeq;
    stopCapture();

    var AC = window.AudioContext || window.webkitAudioContext;
    var constraints = {
      audio: {
        echoCancellation: !!settings.audio.echoCancellation,
        noiseSuppression: !!settings.audio.noiseSuppression,
        autoGainControl: !!settings.audio.autoGainControl,
        channelCount: 1
      }
    };
    if (deviceId && deviceId !== 'default') {
      constraints.audio.deviceId = { exact: deviceId };
    }

    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      if (seq !== captureSeq) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      micStream = stream;
      micPermissionState = 'granted';
      micErrorKey = '';
      micErrorParams = null;

      captureCtx = new AC();
      var proceed = function () {
        if (seq !== captureSeq || micStream !== stream || !captureCtx) return;
        initEncoder(captureCtx.sampleRate);
        micSource = captureCtx.createMediaStreamSource(stream);
        micGainNode = captureCtx.createGain();
        applyMicGain();
        micProcessor = captureCtx.createScriptProcessor(2048, 1, 1);

        micProcessor.onaudioprocess = function (e) {
          var chunk = e.inputBuffer.getChannelData(0);
          if (!chunk || chunk.length === 0) return;

          var sumSq = 0;
          for (var i = 0; i < chunk.length; i++) {
            sumSq += chunk[i] * chunk[i];
          }
          var rms = Math.sqrt(sumSq / chunk.length);
          currentDb = rms > 1e-5 ? clamp(20 * Math.log10(rms), -100, 0) : -100;
          var norm = clamp((currentDb + 100) / 100, 0, 1);
          smoothedLevel = norm > smoothedLevel ? norm : (smoothedLevel * 0.78 + norm * 0.22);

          var now = Date.now();
          var shouldTransmit = computeShouldTransmit(now, currentDb);

          if (micTestEnabled && !settings.audio.micMuted) {
            ensurePlayback();
            if (shouldTransmit && !settings.audio.deafened) {
              var loopCopy = new Float32Array(chunk.length);
              loopCopy.set(chunk);
              playChunk(localTestStream, loopCopy, null);
            }
          }

          if (shouldTransmit) {
            flushingFinalFrame = false;
            if (!wasTransmitting) {
              wasTransmitting = true;
              updateMicStateVisuals();
            }
            if (encoderReady && encoderWorker && !micTestEnabled) {
              var copy = new Float32Array(chunk.length);
              copy.set(chunk);
              encoderWorker.postMessage({ command: 'encode', buffers: [copy] });
            }
          } else if (wasTransmitting) {
            wasTransmitting = false;
            flushingFinalFrame = !settings.audio.micMuted;
            resetEncoderCycle();
            updateMicStateVisuals();
          }

          if (now - lastUiMeterPaint >= 45) {
            lastUiMeterPaint = now;
            paintMeters();
          }
        };

        micSource.connect(micGainNode);
        micGainNode.connect(micProcessor);
        var muteTap = captureCtx.createGain();
        muteTap.gain.value = 0;
        micProcessor.connect(muteTap);
        muteTap.connect(captureCtx.destination);

        showKey('status.mic_active', null, 'ok');
        refreshDevices();
        updateUiState();
      };

      if (captureCtx.state === 'suspended') {
        captureCtx.resume().then(proceed).catch(proceed);
      } else {
        proceed();
      }
    }).catch(function (err) {
      var name = err && err.name ? err.name : '';
      var errKey;
      var errParams = null;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        micPermissionState = 'denied';
        errKey = 'status.mic_err_denied';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        micPermissionState = 'error';
        errKey = 'status.mic_err_not_found';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        micPermissionState = 'error';
        errKey = 'status.mic_err_busy';
      } else if (name === 'OverconstrainedError') {
        micPermissionState = 'error';
        errKey = 'status.mic_err_overconstrained';
      } else {
        micPermissionState = 'error';
        errKey = 'status.mic_err_generic';
        errParams = { error: (err && err.message ? err.message : err) };
      }
      micErrorKey = errKey;
      micErrorParams = errParams;
      showKey(errKey, errParams, 'error');
      updateUiState();
    });
  }

  // --- Devices ---

  function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
      var speakers = devices.filter(function (d) { return d.kind === 'audiooutput'; });
      fillSelect(micSel, mics, settings.audio.micDeviceId);
      fillSelect(speakerSel, speakers, settings.audio.speakerDeviceId);

      if (!settings.audio.micDeviceId && micSel.value) {
        settings.audio.micDeviceId = micSel.value;
      }
      if (!settings.audio.speakerDeviceId && speakerSel.value) {
        settings.audio.speakerDeviceId = speakerSel.value;
      }
      applySavedSpeakerSink();
    }).catch(function () {});
  }

  function fillSelect(sel, devices, preferred) {
    sel.innerHTML = '';
    if (!devices.length) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = 'default';
      emptyOpt.setAttribute('data-device-fallback', 'default');
      emptyOpt.textContent = t('devices.default_device');
      sel.appendChild(emptyOpt);
      return;
    }
    devices.forEach(function (d, idx) {
      var opt = document.createElement('option');
      opt.value = d.deviceId || 'default';
      if (d.label) {
        opt.textContent = d.label;
      } else {
        opt.setAttribute('data-device-index', String(idx + 1));
        opt.textContent = t('devices.numbered_device', { index: idx + 1 });
      }
      sel.appendChild(opt);
    });
    var match = devices.some(function (d) { return (d.deviceId || 'default') === preferred; });
    sel.value = match ? preferred : (devices[0].deviceId || 'default');
  }

  function refreshDeviceFallbackLabels() {
    [micSel, speakerSel].forEach(function (sel) {
      if (!sel) return;
      sel.querySelectorAll('option[data-device-fallback="default"]').forEach(function (opt) {
        opt.textContent = t('devices.default_device');
      });
      sel.querySelectorAll('option[data-device-index]').forEach(function (opt) {
        var idx = opt.getAttribute('data-device-index');
        opt.textContent = t('devices.numbered_device', { index: idx });
      });
    });
  }

  function applySavedSpeakerSink() {
    if (typeof outputEl.setSinkId !== 'function') {
      sinkIdNoteEl.classList.remove('hidden');
      speakerSel.disabled = true;
      return;
    }
    sinkIdNoteEl.classList.add('hidden');
    speakerSel.disabled = false;
    var targetId = settings.audio.speakerDeviceId;
    if (targetId && targetId !== 'default') {
      outputEl.setSinkId(targetId).catch(function () {});
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  // --- Playback Output Chain ---

  function applyVolume() {
    var percent = clamp(parseInt(volumeEl.value, 10) || 0, 0, 200);
    settings.audio.volume = percent;
    volumeValEl.textContent = percent + '%';
    if (playbackGain) {
      playbackGain.gain.value = settings.audio.deafened ? 0 : (percent / 100);
    }
    saveSettings();
  }

  function ensurePlayback() {
    if (!playbackCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      playbackCtx = new AC();
      if (typeof outputEl.setSinkId === 'function') {
        playbackDest = playbackCtx.createMediaStreamDestination();
        outputEl.srcObject = playbackDest.stream;
        outputEl.play().catch(function () {});
      } else {
        playbackDest = playbackCtx.destination;
      }
      playbackGain = playbackCtx.createGain();
      playbackGain.connect(playbackDest);
      applyVolume();
      applySavedSpeakerSink();

      playbackCtx.onstatechange = function () {
        updatePlaybackResumeBanner();
      };
    }
    updatePlaybackResumeBanner();
  }

  function updatePlaybackResumeBanner() {
    if (!playbackCtx) {
      bannerPlaybackResume.classList.add('hidden');
      return;
    }
    if (playbackCtx.state === 'suspended') {
      bannerPlaybackResume.classList.remove('hidden');
    } else {
      bannerPlaybackResume.classList.add('hidden');
    }
  }

  function resumePlaybackFromGesture() {
    ensurePlayback();
    if (playbackCtx && playbackCtx.state !== 'running') {
      playbackCtx.resume().then(function () {
        updatePlaybackResumeBanner();
      }).catch(function () {});
    }
    if (outputEl.paused && outputEl.srcObject) {
      outputEl.play().catch(function () {});
    }
  }

  function playChunk(streamObj, chunk, targetNode) {
    if (!playbackCtx || !playbackGain || !chunk || chunk.length === 0) return;
    var dest = targetNode || playbackGain;
    var now = playbackCtx.currentTime;
    var duration = chunk.length / playbackCtx.sampleRate;
    var when;
    if (!streamObj.nextPlayTime || streamObj.nextPlayTime < now) {
      when = now + PLAY_AHEAD_SECONDS;
    } else {
      when = streamObj.nextPlayTime;
    }
    var buffer = playbackCtx.createBuffer(1, chunk.length, playbackCtx.sampleRate);
    buffer.copyToChannel(chunk, 0);
    var source = playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    source.start(when);
    streamObj.nextPlayTime = when + duration;
  }

  // --- Per-Speaker Decoder & Volume Controls ---

  function getSpeakerPref(uuid) {
    if (!speakerPrefs[uuid]) {
      speakerPrefs[uuid] = { volume: 100, muted: false, nickname: '' };
    }
    return speakerPrefs[uuid];
  }

  function getSpeakerDisplayName(uuid) {
    var pref = getSpeakerPref(uuid);
    if (pref.nickname) return pref.nickname;
    if (serverPlayers[uuid] && serverPlayers[uuid].name) return serverPlayers[uuid].name;
    if (pref.serverName) return pref.serverName;
    return t('players.fallback_name', { id: uuid.slice(0, 8) });
  }

  function applySpeakerGain(uuid) {
    var s = streams[uuid];
    if (!s || !s.gainNode) return;
    var pref = getSpeakerPref(uuid);
    s.gainNode.gain.value = pref.muted ? 0 : (clamp(pref.volume, 0, 200) / 100);
  }

  function handleAudioFrame(frame) {
    if (frame.length < 18 || frame[0] !== 0x02) return;
    var uuid = bytesToUuid(frame.subarray(1, 17));
    var opus = frame.subarray(17);

    var wasSpeaking = !!(knownSpeakers[uuid] && knownSpeakers[uuid].speaking);
    var isNewSpeakerEntry = !knownSpeakers[uuid];
    if (isNewSpeakerEntry) {
      knownSpeakers[uuid] = { uuid: uuid, lastSeen: Date.now(), speaking: true };
    }

    var stream = streams[uuid];
    if (!stream) {
      ensurePlayback();
      var worker = new Worker(DECODER_WORKER_PATH);
      var gainNode = playbackCtx.createGain();
      gainNode.connect(playbackGain);

      worker.postMessage({
        command: 'init',
        decoderSampleRate: 48000,
        outputBufferSampleRate: playbackCtx.sampleRate,
        bufferLength: 2048
      });

      stream = {
        uuid: uuid,
        worker: worker,
        gainNode: gainNode,
        pageIndex: 0,
        lastActivity: Date.now(),
        lastSpokeAt: Date.now(),
        level: 0,
        serial: undefined,
        nextPlayTime: 0
      };
      streams[uuid] = stream;
      applySpeakerGain(uuid);

      worker.onmessage = function (e) {
        if (!e.data) return;
        var channels = e.data;
        var maxRms = 0;
        for (var i = 0; i < channels.length; i++) {
          var ch = channels[i];
          playChunk(stream, ch, stream.gainNode);
          var sum = 0;
          for (var j = 0; j < ch.length; j += 4) sum += ch[j] * ch[j];
          var rms = Math.sqrt(sum / Math.max(1, ch.length / 4));
          if (rms > maxRms) maxRms = rms;
        }
        stream.level = maxRms;
        if (maxRms > 0.005) {
          stream.lastSpokeAt = Date.now();
        }
      };

      var head = buildOpusHeadPage(stream);
      worker.postMessage({ command: 'decode', pages: head }, [head.buffer]);
    }

    stream.lastActivity = Date.now();
    knownSpeakers[uuid].lastSeen = Date.now();
    knownSpeakers[uuid].speaking = true;

    var page = buildAudioPage(stream, opus);
    stream.worker.postMessage({ command: 'decode', pages: page }, [page.buffer]);

    if (isNewSpeakerEntry || !wasSpeaking) {
      renderSpeakersList();
    }
  }

  function buildPlayerEntries() {
    var map = {};
    var uuid;
    for (uuid in serverPlayers) {
      if (selfUuid && uuid === selfUuid) continue;
      var sp = serverPlayers[uuid];
      var ks = knownSpeakers[uuid];
      map[uuid] = {
        uuid: uuid,
        name: sp.name,
        mods: sp.mods || [],
        web: !!sp.web,
        voice: !!sp.voice,
        online: true,
        speaking: !!(ks && ks.speaking),
        lastSeen: ks ? ks.lastSeen : 0
      };
    }
    for (uuid in knownSpeakers) {
      if (selfUuid && uuid === selfUuid) continue;
      if (!map[uuid]) {
        var k = knownSpeakers[uuid];
        map[uuid] = {
          uuid: uuid,
          name: getSpeakerDisplayName(uuid),
          mods: [],
          web: false,
          voice: true,
          online: false,
          speaking: !!k.speaking,
          lastSeen: k.lastSeen || 0
        };
      }
    }
    return Object.keys(map).map(function (id) { return map[id]; });
  }

  function createModBadges(entry) {
    var badges = [];
    var hasSvc = entry.mods.indexOf('SVC') !== -1;
    var hasPv = entry.mods.indexOf('PV') !== -1;
    if (hasSvc && hasPv) {
      badges.push({ text: 'SVC+PV', cls: 'mod-badge--dual' });
    } else if (hasSvc) {
      badges.push({ text: 'SVC', cls: 'mod-badge--svc' });
    } else if (hasPv) {
      badges.push({ text: 'PV', cls: 'mod-badge--pv' });
    }
    if (entry.web) {
      badges.push({ text: 'WEB', cls: 'mod-badge--web' });
    }
    if (!badges.length) {
      badges.push({ text: entry.voice ? t('players.badge_voice') : t('players.badge_no_voice'), cls: 'mod-badge--none' });
    }
    return badges;
  }

  function renderSpeakersList(force) {
    if (!force && speakersListEl.querySelector('.speaker-name-input')) {
      renderOverlaySpeakers();
      return;
    }

    var allEntries = buildPlayerEntries();
    var totalOnline = allEntries.filter(function (e) { return e.online; }).length;
    var totalVoice = allEntries.filter(function (e) { return e.voice; }).length;
    var totalSpeaking = allEntries.filter(function (e) { return e.speaking; }).length;

    speakerCountBadge.textContent = String(allEntries.length);
    if (playersSummaryEl) {
      playersSummaryEl.textContent = totalSpeaking
        ? t('players.summary_speaking', { online: totalOnline, voice: totalVoice, speaking: totalSpeaking })
        : t('players.summary', { online: totalOnline, voice: totalVoice });
    }

    var query = (playerSearchQuery || '').trim().toLowerCase();
    var filtered = allEntries.filter(function (entry) {
      if (playerFilter === 'voice' && !entry.voice) return false;
      if (playerFilter === 'speaking' && !entry.speaking) return false;
      if (query) {
        var disp = getSpeakerDisplayName(entry.uuid).toLowerCase();
        var rawName = (entry.name || '').toLowerCase();
        if (disp.indexOf(query) === -1 && rawName.indexOf(query) === -1 && entry.uuid.toLowerCase().indexOf(query) === -1) {
          return false;
        }
      }
      return true;
    });

    if (!filtered.length) {
      var emptyMsg = allEntries.length ? t('players.empty_filter') : t('players.empty_server');
      speakersListEl.innerHTML = '';
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = emptyMsg;
      speakersListEl.appendChild(emptyDiv);
      renderOverlaySpeakers();
      return;
    }

    // Sort: speaking first -> voice connected -> online -> alphabetical by name
    filtered.sort(function (a, b) {
      if (a.speaking !== b.speaking) return a.speaking ? -1 : 1;
      if (a.voice !== b.voice) return a.voice ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return getSpeakerDisplayName(a.uuid).localeCompare(getSpeakerDisplayName(b.uuid));
    });

    speakersListEl.innerHTML = '';
    filtered.forEach(function (entry) {
      var uuid = entry.uuid;
      var pref = getSpeakerPref(uuid);

      var card = document.createElement('div');
      card.className = 'speaker-card' + (entry.speaking ? ' is-speaking' : '');
      card.setAttribute('data-speaker-uuid', uuid);

      var left = document.createElement('div');
      left.className = 'speaker-identity';

      var avatar = document.createElement('canvas');
      avatar.className = 'speaker-avatar';
      avatar.width = 8;
      avatar.height = 8;
      drawPixelAvatar(avatar, entry.name || uuid);
      left.appendChild(avatar);

      var nameMeta = document.createElement('div');
      var nameRow = document.createElement('div');
      nameRow.className = 'speaker-name-row';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'speaker-name';
      nameSpan.textContent = getSpeakerDisplayName(uuid);
      nameSpan.title = t('players.alias_title');
      nameSpan.style.cursor = 'pointer';
      nameSpan.onclick = function () {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'speaker-name-input';
        inp.value = pref.nickname || '';
        inp.placeholder = entry.name || t('players.fallback_name', { id: uuid.slice(0, 8) });
        var commit = function () {
          pref.nickname = inp.value.trim();
          saveSpeakerPrefs();
          renderSpeakersList(true);
        };
        inp.onblur = commit;
        inp.onkeydown = function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { renderSpeakersList(true); }
        };
        nameRow.replaceChild(inp, nameSpan);
        inp.focus();
      };
      nameRow.appendChild(nameSpan);

      createModBadges(entry).forEach(function (b) {
        var badge = document.createElement('span');
        badge.className = 'mod-badge ' + b.cls;
        badge.textContent = b.text;
        nameRow.appendChild(badge);
      });

      if (entry.speaking) {
        var speakTag = document.createElement('span');
        speakTag.className = 'key-chip';
        speakTag.style.color = '#55ff55';
        speakTag.textContent = t('players.speaking_tag');
        nameRow.appendChild(speakTag);
      }

      var uuidDiv = document.createElement('div');
      uuidDiv.className = 'speaker-uuid';
      uuidDiv.textContent = pref.nickname && entry.name ? (entry.name + ' (' + uuid.slice(0, 8) + ')') : uuid;

      nameMeta.appendChild(nameRow);
      nameMeta.appendChild(uuidDiv);
      left.appendChild(nameMeta);

      var controls = document.createElement('div');
      controls.className = 'speaker-controls';

      var volWrap = document.createElement('div');
      volWrap.className = 'speaker-vol-wrap';

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'mc-range';
      slider.min = '0';
      slider.max = '200';
      slider.value = String(pref.volume);

      var volText = document.createElement('span');
      volText.className = 'field-val';
      volText.style.minWidth = '42px';
      volText.textContent = pref.volume + '%';

      var resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'mc-btn mc-btn--xs';
      resetBtn.textContent = '100%';
      resetBtn.title = t('players.reset_one_title');
      resetBtn.disabled = pref.volume === 100;
      resetBtn.onclick = function () {
        pref.volume = 100;
        slider.value = '100';
        volText.textContent = '100%';
        resetBtn.disabled = true;
        applySpeakerGain(uuid);
        saveSpeakerPrefs();
      };

      slider.oninput = function () {
        pref.volume = clamp(parseInt(slider.value, 10) || 0, 0, 200);
        volText.textContent = pref.volume + '%';
        resetBtn.disabled = pref.volume === 100;
        applySpeakerGain(uuid);
        saveSpeakerPrefs();
      };

      volWrap.appendChild(slider);
      volWrap.appendChild(volText);

      var muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'mc-btn mc-btn--xs ' + (pref.muted ? 'mc-btn--red' : 'mc-btn--green');
      muteBtn.textContent = pref.muted ? t('players.muted') : t('players.mute');
      muteBtn.onclick = function () {
        pref.muted = !pref.muted;
        applySpeakerGain(uuid);
        saveSpeakerPrefs();
        renderSpeakersList(true);
      };

      controls.appendChild(volWrap);
      controls.appendChild(resetBtn);
      controls.appendChild(muteBtn);

      card.appendChild(left);
      card.appendChild(controls);
      speakersListEl.appendChild(card);
    });

    renderOverlaySpeakers();
  }

  function renderOverlaySpeakers() {
    var active = Object.keys(knownSpeakers).filter(function (uuid) {
      return knownSpeakers[uuid].speaking && !getSpeakerPref(uuid).muted;
    });

    if (!settings.overlay.showSpeakers || !active.length) {
      ovSpeakersEl.classList.add('hidden');
      ovSpeakersEl.innerHTML = '';
      return;
    }

    ovSpeakersEl.classList.remove('hidden');
    ovSpeakersEl.innerHTML = '';
    active.slice(0, 5).forEach(function (uuid) {
      var item = document.createElement('div');
      item.className = 'overlay-speaker-item';
      var dot = document.createElement('span');
      dot.className = 'overlay-speaker-dot';
      var label = document.createElement('span');
      label.textContent = getSpeakerDisplayName(uuid);
      item.appendChild(dot);
      item.appendChild(label);
      ovSpeakersEl.appendChild(item);
    });
  }

  // --- Ogg Page Helpers ---

  function buildOpusHeadPage(stream) {
    var body = new Uint8Array(19);
    body.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    body[8] = 1;  // version
    body[9] = 1;  // channels
    body[12] = 0x80; body[13] = 0xBB; body[14] = 0x00; body[15] = 0x00; // 48000 LE
    return buildOggPage(body, 0x02 /* BOS */, 0, streamSerial(stream));
  }

  function buildAudioPage(stream, opus) {
    var pageIndex = 2 + stream.pageIndex;
    stream.pageIndex++;
    return buildOggPage(opus, 0x00, pageIndex, streamSerial(stream));
  }

  function streamSerial(stream) {
    if (stream.serial === undefined) {
      stream.serial = Math.floor(Math.random() * 0x7FFFFFFF);
    }
    return stream.serial;
  }

  function buildOggPage(body, headerType, pageIndex, serial) {
    var lacing = [];
    var remaining = body.length;
    while (remaining >= 255) { lacing.push(255); remaining -= 255; }
    lacing.push(remaining);

    var page = new Uint8Array(27 + lacing.length + body.length);
    page.set([0x4F, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0;
    page[5] = headerType;
    writeUint32LE(page, 14, serial);
    writeUint32LE(page, 18, pageIndex);
    page[26] = lacing.length;
    page.set(lacing, 27);
    page.set(body, 27 + lacing.length);
    return page;
  }

  function writeUint32LE(out, offset, value) {
    out[offset] = value & 0xFF;
    out[offset + 1] = (value >>> 8) & 0xFF;
    out[offset + 2] = (value >>> 16) & 0xFF;
    out[offset + 3] = (value >>> 24) & 0xFF;
  }

  var packetParts = [];

  function extractOpusPackets(page) {
    var packets = [];
    if (page.length < 27) return packets;
    var segCount = page[26];
    var bodyStart = 27 + segCount;
    if (bodyStart > page.length) return packets;

    if (bodyStart + 8 <= page.length && isOpusHeaderMagic(page, bodyStart)) return packets;

    var offset = bodyStart;
    for (var i = 0; i < segCount; i++) {
      var lacing = page[27 + i];
      if (offset + lacing > page.length) break;
      packetParts.push(page.slice(offset, offset + lacing));
      offset += lacing;
      if (lacing < 255) {
        packets.push(concatParts());
        packetParts = [];
      }
    }
    return packets;
  }

  function isOpusHeaderMagic(page, offset) {
    return (page[offset] === 0x4F && page[offset + 1] === 0x70 &&
            page[offset + 2] === 0x75 && page[offset + 3] === 0x73 &&
            page[offset + 4] === 0x48 && page[offset + 5] === 0x65 &&
            page[offset + 6] === 0x61 && page[offset + 7] === 0x64) ||
           (page[offset] === 0x4F && page[offset + 1] === 0x70 &&
            page[offset + 2] === 0x75 && page[offset + 3] === 0x73 &&
            page[offset + 4] === 0x54 && page[offset + 5] === 0x61 &&
            page[offset + 6] === 0x67 && page[offset + 7] === 0x73);
  }

  function concatParts() {
    if (packetParts.length === 1) return packetParts[0];
    var total = 0;
    for (var i = 0; i < packetParts.length; i++) total += packetParts[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var j = 0; j < packetParts.length; j++) {
      out.set(packetParts[j], pos);
      pos += packetParts[j].length;
    }
    return out;
  }

  function bytesToUuid(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // --- Action Handlers (Mic On/Off, Deafen) ---

  function syncTransmissionStop(allowFlush) {
    if (wasTransmitting) {
      wasTransmitting = false;
      flushingFinalFrame = !!allowFlush;
      resetEncoderCycle();
    }
    updateMicStateVisuals();
  }

  function toggleMicMute(fromIngame) {
    resumePlaybackFromGesture();
    // If mic hasn't been enabled yet, clicking Mic button on the page activates permission!
    if (!fromIngame && secureContext && browserSupported && !micStream && !settings.audio.micMuted) {
      settings.audio.micMuted = false;
      saveSettings();
      playUiCue('mic-on');
      startCapture(settings.audio.micDeviceId);
      sendMicState(!!fromIngame);
      updateUiState();
      return;
    }

    settings.audio.micMuted = !settings.audio.micMuted;
    if (settings.audio.micMuted) {
      playUiCue('mic-off');
      syncTransmissionStop(false);
    } else {
      playUiCue('mic-on');
      if (!micStream && secureContext && browserSupported) {
        startCapture(settings.audio.micDeviceId);
      }
    }
    saveSettings();
    sendMicState(!!fromIngame);
    updateUiState();
  }

  function toggleDeafen() {
    resumePlaybackFromGesture();
    settings.audio.deafened = !settings.audio.deafened;
    if (settings.audio.deafened && settings.audio.muteMicOnDeafen && !settings.audio.micMuted) {
      settings.audio.micMuted = true;
      syncTransmissionStop(false);
    } else if (!settings.audio.deafened && settings.audio.muteMicOnDeafen && settings.audio.micMuted) {
      settings.audio.micMuted = false;
      if (!micStream && secureContext && browserSupported) {
        startCapture(settings.audio.micDeviceId);
      }
    }
    applyVolume();
    saveSettings();
    sendMicState(false);
    playUiCue('deafen');
    updateUiState();
  }

  // --- Visual State Calculation & Rendering ---

  function computeMicStateInfo() {
    var a = settings.audio;
    if (!browserSupported) {
      return {
        key: 'error',
        title: t('hero.unsupported_title'),
        sub: t('hero.unsupported_sub'),
        ovLine: t('hero.unsupported_ov'),
        icon: 'px-plug-off',
        speaking: false
      };
    }
    if (!secureContext) {
      return {
        key: 'error',
        title: t('hero.insecure_title'),
        sub: t('hero.insecure_sub'),
        ovLine: t('hero.insecure_ov'),
        icon: 'px-mic-off',
        speaking: false
      };
    }
    if (wsState === 'disconnected') {
      return {
        key: 'error',
        title: t('hero.disconnected_title'),
        sub: sessionId ? t('hero.disconnected_sub') : t('hero.missing_id_sub'),
        ovLine: t('hero.disconnected_ov'),
        icon: 'px-plug-off',
        speaking: false
      };
    }
    if (a.deafened) {
      return {
        key: 'deafened',
        title: t('hero.deafened_title'),
        sub: a.micMuted ? t('hero.deafened_both_sub') : t('hero.deafened_out_sub'),
        ovLine: t('hero.deafened_ov'),
        icon: 'px-headphones-off',
        speaking: false
      };
    }
    if (a.micMuted) {
      var triggerInfo = getIngameTriggerInfo(a.ingameTrigger);
      return {
        key: 'muted',
        title: t('hero.muted_title'),
        sub: triggerInfo.chip
          ? t('hero.muted_keybind_sub', { trigger: triggerInfo.label })
          : t('hero.muted_default_sub'),
        ovLine: t('hero.muted_ov'),
        icon: 'px-mic-off',
        speaking: false
      };
    }
    if (!micStream || !captureCtx) {
      if (micPermissionState === 'denied' || micPermissionState === 'error') {
        return {
          key: 'error',
          title: t('hero.blocked_title'),
          sub: t('hero.blocked_sub'),
          ovLine: t('hero.blocked_ov'),
          icon: 'px-mic-off',
          speaking: false
        };
      }
      return {
        key: 'waiting',
        title: t('hero.click_enable_title'),
        sub: t('hero.click_enable_sub'),
        ovLine: t('hero.click_enable_ov'),
        icon: 'px-mic',
        speaking: false
      };
    }
    if (micTestEnabled) {
      var testActive = wasTransmitting;
      return {
        key: testActive ? 'speaking' : 'ready',
        title: testActive ? t('hero.test_speaking_title') : t('hero.test_active_title'),
        sub: t('hero.test_sub'),
        ovLine: testActive ? t('hero.test_speaking_ov') : t('hero.test_active_ov'),
        icon: testActive ? 'px-mic-speaking' : 'px-mic',
        speaking: testActive
      };
    }
    if (wsState !== 'connected') {
      return {
        key: 'waiting',
        title: t('hero.connecting_title'),
        sub: t('hero.connecting_sub'),
        ovLine: t('hero.connecting_ov'),
        icon: 'px-mic',
        speaking: false
      };
    }
    if (wasTransmitting) {
      return {
        key: 'speaking',
        title: t('hero.speaking_title'),
        sub: t('hero.speaking_sub'),
        ovLine: t('hero.speaking_ov'),
        icon: 'px-mic-speaking',
        speaking: true
      };
    }
    if (a.vadThresholdDb <= -95) {
      return {
        key: 'ready',
        title: t('hero.open_mic_title'),
        sub: t('hero.open_mic_sub'),
        ovLine: t('hero.open_mic_ov'),
        icon: 'px-mic',
        speaking: false
      };
    }
    return {
      key: 'ready',
      title: t('hero.voice_ready_title'),
      sub: t('hero.voice_ready_sub', { db: a.vadThresholdDb }),
      ovLine: t('hero.voice_ready_ov'),
      icon: 'px-mic',
      speaking: false
    };
  }

  function updateMicStateVisuals() {
    var st = computeMicStateInfo();
    var a = settings.audio;
    var ov = settings.overlay;
    var triggerInfo = getIngameTriggerInfo(a.ingameTrigger);

    // Hero card
    heroMicBox.className = 'mic-avatar-box state-' + st.key;
    setSvgHref(heroMicSvg, st.icon);
    heroStateTitle.textContent = st.title;
    heroStateSub.textContent = st.sub;

    // Primary Mic On/Off button (always shown)
    btnMicToggle.className = 'mc-btn action-btn ' + (a.micMuted ? 'mc-btn--red' : ('mc-btn--green' + (st.speaking ? ' is-speaking' : '')));
    setSvgHref(btnMicIcon, a.micMuted ? 'px-mic-off' : (st.speaking ? 'px-mic-speaking' : 'px-mic'));
    btnMicStateText.textContent = a.micMuted ? t('common.off') : t('common.on');
    btnMicSub.textContent = a.micMuted
      ? t('controls.mic_muted_sub')
      : (st.speaking ? t('controls.mic_transmitting_sub') : t('controls.mic_active_sub'));
    btnMicKey.textContent = triggerInfo.chip;
    btnMicKey.classList.toggle('hidden', !triggerInfo.chip);

    // Overlay visuals
    overlayEl.classList.remove('state-speaking', 'state-ready', 'state-waiting', 'state-muted', 'state-deafened', 'state-error', 'is-speaking');
    overlayEl.classList.add('state-' + st.key);
    if (st.speaking) overlayEl.classList.add('is-speaking');

    setSvgHref(ovMicSvg, st.icon);
    if (!ov.showLabel) {
      ovStateLine.classList.add('hidden');
    } else {
      ovStateLine.classList.remove('hidden');
      var showMcHint = ov.showKeyHints && triggerInfo.chip && (st.key === 'muted' || st.key === 'ready');
      ovStateLine.textContent = showMcHint ? (st.ovLine + ' [' + triggerInfo.chip + ']') : st.ovLine;
    }

    if (!ov.showPlayerName) {
      ovSubLine.classList.add('hidden');
    } else {
      ovSubLine.classList.remove('hidden');
      ovSubLine.textContent = hasPlayerIdentity ? playerName : (wsState === 'connected' ? t('overlay.connected_sub') : 'Voice Web Bridge');
    }

    // Overlay quick mic button
    ovBtnMic.className = 'mc-btn mc-btn--xs ' + (a.micMuted ? 'mc-btn--red' : ('mc-btn--green' + (st.speaking ? ' is-speaking' : '')));
    ovBtnMic.textContent = t('overlay.mic_btn', { state: a.micMuted ? t('common.off') : t('common.on') });
  }

  function paintMeters() {
    var pct = clamp(Math.round(smoothedLevel * 100), 0, 100);
    var active = wasTransmitting;
    var muted = settings.audio.micMuted;

    heroMeterFill.style.width = pct + '%';
    heroMeterFill.className = 'meter-fill' + (active ? ' is-active' : (muted && pct > 1 ? ' is-preview' : ''));
    heroMeterDb.textContent = t('unit.db', { value: Math.round(currentDb) });
    heroMeterLabel.textContent = muted
      ? t('meter.input_muted')
      : (active ? t('meter.transmitting') : t('meter.input_level'));

    vadMeterFill.style.width = pct + '%';
    vadMeterFill.className = 'meter-fill' + (currentDb >= settings.audio.vadThresholdDb && !muted ? ' is-active' : ' is-preview');

    ovMeterFill.style.width = (muted ? 0 : pct) + '%';
  }

  function setToggleButtonUi(btn, on, onLabel, offLabel) {
    btn.textContent = on ? (onLabel || t('common.on')) : (offLabel || t('common.off'));
    btn.classList.remove('mc-btn--green', 'mc-btn--red');
    btn.classList.add(on ? 'mc-btn--green' : 'mc-btn--red');
  }

  function updateObsUrlPreview() {
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('overlay', '1');
      if (sessionId) u.searchParams.set('id', sessionId);
      obsUrlInput.value = u.toString();
    } catch (e) {
      obsUrlInput.value = window.location.href;
    }
  }

  function applyOverlayConfig() {
    var ov = settings.overlay;
    var showOverlay = !!(pipWindow || overlayFocusMode);
    overlayEl.classList.toggle('hidden', !showOverlay);

    ovMeterEl.classList.toggle('hidden', !ov.showMeter);
    ovControlsEl.classList.toggle('hidden', !ov.showControls);
    renderOverlaySpeakers();
  }

  function updateUiState() {
    var a = settings.audio;
    var ov = settings.overlay;
    var onText = t('common.on');
    var offText = t('common.off');

    // Header connection + identity
    identityPillEl.classList.toggle('hidden', !hasPlayerIdentity);
    playerNameTextEl.textContent = hasPlayerIdentity ? playerName : t('header.player_default');

    connBadgeEl.className = 'conn-badge conn-badge--' + (wsState === 'connected' ? 'connected' : (wsState === 'connecting' ? 'connecting' : 'disconnected'));
    connBadgeTextEl.textContent = wsState === 'connected'
      ? t('header.conn_connected')
      : (wsState === 'connecting' ? t('header.conn_connecting') : (sessionId ? t('header.conn_offline') : t('header.conn_no_session')));
    btnReconnect.classList.toggle('hidden', !sessionId || wsState === 'connected' || wsState === 'connecting');

    sessionMetaEl.textContent = t('log.session_meta', { id: sessionId || t('log.session_none') });

    // Banners
    bannerMissingId.classList.toggle('hidden', !!sessionId);
    bannerInsecure.classList.toggle('hidden', secureContext);
    var needsPermBanner = secureContext && browserSupported && (!micStream || !captureCtx);
    bannerPermission.classList.toggle('hidden', !needsPermBanner);
    if (micPermissionState === 'denied' || micPermissionState === 'error') {
      bannerPermTitle.textContent = t('banner.perm_unavailable_title');
      bannerPermHint.textContent = micErrorKey ? t(micErrorKey, micErrorParams) : t('banner.perm_unavailable_hint');
      btnEnableMicText.textContent = t('banner.retry_mic_btn');
    } else {
      bannerPermTitle.textContent = t('banner.perm_needed_title');
      bannerPermHint.textContent = t('banner.perm_needed_hint');
      btnEnableMicText.textContent = t('banner.enable_mic_btn');
    }
    updatePlaybackResumeBanner();

    // Sliders & controls
    volumeEl.value = String(a.volume);
    volumeValEl.textContent = a.volume + '%';
    micGainEl.value = String(a.micGain);
    micGainValEl.textContent = a.micGain + '%';

    // Deafen button
    btnDeafen.className = 'mc-btn action-btn ' + (a.deafened ? 'mc-btn--red' : '');
    setSvgHref(btnDeafenIcon, a.deafened ? 'px-headphones-off' : 'px-headphones');
    btnDeafenStateText.textContent = a.deafened ? offText : onText;
    btnDeafenSub.textContent = a.deafened ? t('controls.deafened_sub') : t('controls.deafen_sub');

    // Threshold / VAD UI
    vadThresholdEl.value = String(a.vadThresholdDb);
    vadThresholdValEl.textContent = a.vadThresholdDb <= -95
      ? t('vad.threshold_open', { db: a.vadThresholdDb })
      : t('unit.db', { value: a.vadThresholdDb });
    var threshPct = clamp(a.vadThresholdDb + 100, 0, 100);
    vadThresholdMark.style.left = threshPct + '%';
    heroMeterThreshold.style.left = threshPct + '%';
    heroMeterThreshold.classList.toggle('hidden', a.vadThresholdDb <= -95);
    vadHoldoverEl.value = String(a.vadHoldoverMs);
    vadHoldoverValEl.textContent = t('unit.ms', { value: a.vadHoldoverMs });

    // Mic & Audio Processing controls
    setToggleButtonUi(btnMicTest, micTestEnabled, t('devices.testing'), offText);
    setToggleButtonUi(toggleMuteOnDeafen, a.muteMicOnDeafen, onText, offText);
    setToggleButtonUi(toggleUiSounds, a.uiSounds, onText, offText);

    toggleEcBtn.textContent = t('processing.ec_btn', { state: a.echoCancellation ? onText : offText });
    toggleEcBtn.classList.toggle('mc-btn--green', a.echoCancellation);
    toggleNsBtn.textContent = t('processing.ns_btn', { state: a.noiseSuppression ? onText : offText });
    toggleNsBtn.classList.toggle('mc-btn--green', a.noiseSuppression);
    toggleAgcBtn.textContent = t('processing.agc_btn', { state: a.autoGainControl ? onText : offText });
    toggleAgcBtn.classList.toggle('mc-btn--green', a.autoGainControl);

    // Minecraft Keybind controls (In-Game Server Sync)
    if (ingameSyncPill) {
      var hasIngame = wsState === 'connected' && !!serverCapabilities.ingame_mic;
      ingameSyncPill.textContent = hasIngame
        ? t('keybind.sync_ready')
        : (wsState === 'connected' ? t('keybind.sync_update') : t('keybind.sync_offline'));
      ingameSyncPill.className = 'sync-pill ' + (hasIngame ? 'sync-pill--ok' : 'sync-pill--warn');
    }
    var normalizedTrigger = normalizeIngameTrigger(a.ingameTrigger);
    ingameTriggerSel.value = normalizedTrigger;
    if (ingameTriggerHintEl) {
      ingameTriggerHintEl.textContent = getIngameTriggerInfo(normalizedTrigger).hint;
    }

    // Overlay Config Tab controls
    setToggleButtonUi(toggleOvLabel, ov.showLabel, onText, offText);
    setToggleButtonUi(toggleOvName, ov.showPlayerName, onText, offText);
    setToggleButtonUi(toggleOvControls, ov.showControls, onText, offText);
    setToggleButtonUi(toggleOvMeter, ov.showMeter, onText, offText);
    setToggleButtonUi(toggleOvKeys, ov.showKeyHints, onText, offText);
    setToggleButtonUi(toggleOvSpeakers, ov.showSpeakers, onText, offText);

    pipActiveNotice.classList.toggle('hidden', !pipWindow);
    if (copyObsCopied) {
      btnCopyObsUrl.textContent = t('overlay.copied');
    }

    applyOverlayConfig();
    updateMicStateVisuals();
    updateObsUrlPreview();
  }

  // --- Overlay Focus Mode & Document Picture-in-Picture ---

  function setOverlayFocusMode(enabled) {
    overlayFocusMode = !!enabled;
    document.body.classList.toggle('overlay-focus-mode', overlayFocusMode);
    applyOverlayConfig();
  }

  function dockOverlayBack() {
    if (overlayEl.parentNode !== document.body) {
      document.body.appendChild(overlayEl);
    }
    pipWindow = null;
    updateUiState();
  }

  function openPopoutOverlay() {
    if (pipWindow && !pipWindow.closed) {
      try { pipWindow.focus(); } catch (e) {}
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      showKey('status.pip_unsupported', null, 'warn');
      return;
    }

    window.documentPictureInPicture.requestWindow({
      width: 310,
      height: 175
    }).then(function (win) {
      pipWindow = win;
      var pipDoc = win.document;
      pipDoc.documentElement.lang = htmlLangForLocale(currentLocale);

      var fontStyle = pipDoc.createElement('style');
      var fontUrl = new URL('lib/Roboto.ttf', window.location.href).href;
      fontStyle.textContent = "@font-face { font-family: 'Roboto'; src: url('" + fontUrl + "') format('truetype'); font-weight: 100 900; font-style: normal; }";
      pipDoc.head.appendChild(fontStyle);

      var cssLink = pipDoc.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = new URL('styles.css', window.location.href).href;
      pipDoc.head.appendChild(cssLink);

      pipDoc.title = t('overlay.pip_window_title');
      pipDoc.body.className = 'pip-window';

      var svgDefs = document.getElementById('svg-defs');
      if (svgDefs) {
        pipDoc.body.appendChild(pipDoc.importNode(svgDefs, true));
      }
      pipDoc.body.appendChild(overlayEl);

      win.addEventListener('pagehide', function () {
        dockOverlayBack();
      });

      updateUiState();
      logEvent(t('status.pip_opened'), 'ok');
    }).catch(function (err) {
      showKey('status.pip_failed', { error: (err && err.message ? err.message : err) }, 'warn');
    });
  }

  // --- Wire UI Event Listeners ---

  // Tabs
  document.querySelectorAll('.mc-tab').forEach(function (tabBtn) {
    tabBtn.addEventListener('click', function () {
      var target = tabBtn.getAttribute('data-tab');
      document.querySelectorAll('.mc-tab').forEach(function (b) {
        var active = b === tabBtn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'tab-' + target);
      });
    });
  });

  // Manual session connect (when page opened without ?id=)
  btnManualConnect.addEventListener('click', function () {
    var val = (manualSessionInput.value || '').trim();
    if (!val) return;
    var extracted = val;
    try {
      if (val.indexOf('http') === 0 || val.indexOf('?') !== -1) {
        var u = new URL(val, window.location.href);
        extracted = u.searchParams.get('id') || val;
      }
    } catch (e) {}
    sessionId = extracted;
    try {
      var nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('id', sessionId);
      window.history.replaceState(null, '', nextUrl.toString());
    } catch (e) {}
    connectWebSocket();
    updateUiState();
  });

  btnReconnect.addEventListener('click', function () {
    reconnectAttempt = 0;
    connectWebSocket();
  });

  btnEnableMic.addEventListener('click', function () {
    resumePlaybackFromGesture();
    startCapture(settings.audio.micDeviceId);
  });

  btnResumeAudio.addEventListener('click', resumePlaybackFromGesture);

  // Header & Popout buttons
  btnExitFocus.addEventListener('click', function () { setOverlayFocusMode(false); });
  btnPopout.addEventListener('click', openPopoutOverlay);
  btnRecallPip.addEventListener('click', function () {
    if (pipWindow && !pipWindow.closed) pipWindow.close();
    dockOverlayBack();
  });
  if (langSel) {
    langSel.addEventListener('change', function () {
      setLocale(langSel.value, true);
    });
  }

  // Primary Action Buttons (Hero Dock + Overlay Quick Controls)
  btnMicToggle.addEventListener('click', function () { toggleMicMute(false); });
  ovBtnMic.addEventListener('click', function () { toggleMicMute(false); });
  btnDeafen.addEventListener('click', toggleDeafen);

  // Volume & Mic Gain
  volumeEl.addEventListener('input', applyVolume);
  micGainEl.addEventListener('input', function () {
    settings.audio.micGain = clamp(parseInt(micGainEl.value, 10) || 0, 0, 200);
    micGainValEl.textContent = settings.audio.micGain + '%';
    applyMicGain();
    saveSettings();
  });

  // Devices
  btnRefreshDevices.addEventListener('click', refreshDevices);
  micSel.addEventListener('change', function () {
    settings.audio.micDeviceId = micSel.value || null;
    saveSettings();
    startCapture(settings.audio.micDeviceId);
  });
  speakerSel.addEventListener('change', function () {
    settings.audio.speakerDeviceId = speakerSel.value || null;
    saveSettings();
    if (typeof outputEl.setSinkId !== 'function') {
      showKey('status.speaker_unsupported', null, 'warn');
      return;
    }
    outputEl.setSinkId(settings.audio.speakerDeviceId).then(function () {
      if (outputEl.paused) outputEl.play().catch(function () {});
    }).catch(function (err) {
      showKey('status.speaker_failed', { error: (err && err.message ? err.message : err) }, 'error');
    });
  });

  // Mic Test
  btnMicTest.addEventListener('click', function () {
    resumePlaybackFromGesture();
    micTestEnabled = !micTestEnabled;
    if (micTestEnabled && !micStream && secureContext && browserSupported) {
      settings.audio.micMuted = false;
      startCapture(settings.audio.micDeviceId);
    }
    updateUiState();
  });

  // VAD Threshold & Presets
  vadThresholdEl.addEventListener('input', function () {
    settings.audio.vadThresholdDb = clamp(parseInt(vadThresholdEl.value, 10) || -100, -100, 0);
    saveSettings();
    updateUiState();
  });
  document.querySelectorAll('[data-vad-preset]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      settings.audio.vadThresholdDb = parseInt(btn.getAttribute('data-vad-preset'), 10);
      saveSettings();
      updateUiState();
    });
  });
  vadHoldoverEl.addEventListener('input', function () {
    settings.audio.vadHoldoverMs = clamp(parseInt(vadHoldoverEl.value, 10) || 0, 0, 1000);
    saveSettings();
    updateUiState();
  });

  // Mic & Audio Processing Config
  toggleMuteOnDeafen.addEventListener('click', function () {
    settings.audio.muteMicOnDeafen = !settings.audio.muteMicOnDeafen;
    saveSettings();
    updateUiState();
  });
  toggleUiSounds.addEventListener('click', function () {
    settings.audio.uiSounds = !settings.audio.uiSounds;
    saveSettings();
    updateUiState();
  });

  function toggleAudioFilter(key) {
    settings.audio[key] = !settings.audio[key];
    saveSettings();
    updateUiState();
    if (micStream) startCapture(settings.audio.micDeviceId);
  }
  toggleEcBtn.addEventListener('click', function () { toggleAudioFilter('echoCancellation'); });
  toggleNsBtn.addEventListener('click', function () { toggleAudioFilter('noiseSuppression'); });
  toggleAgcBtn.addEventListener('click', function () { toggleAudioFilter('autoGainControl'); });

  btnResetAudio.addEventListener('click', function () {
    settings.audio = defaultAudioSettings();
    micTestEnabled = false;
    saveSettings();
    applyVolume();
    applyMicGain();
    sendIngameTriggerConfig();
    sendMicState(false);
    if (micStream) startCapture(settings.audio.micDeviceId);
    updateUiState();
    logEvent(t('status.audio_reset'), 'info');
  });

  // Minecraft In-Game Keybind Config Listener
  ingameTriggerSel.addEventListener('change', function () {
    settings.audio.ingameTrigger = normalizeIngameTrigger(ingameTriggerSel.value);
    saveSettings();
    sendIngameTriggerConfig();
    updateUiState();
    logEvent(t('status.keybind_set', { label: getIngameTriggerInfo(settings.audio.ingameTrigger).label }), 'info');
  });

  // Overlay Config Listeners
  function bindOvToggle(el, key) {
    el.addEventListener('click', function () {
      settings.overlay[key] = !settings.overlay[key];
      saveSettings();
      updateUiState();
    });
  }
  bindOvToggle(toggleOvLabel, 'showLabel');
  bindOvToggle(toggleOvName, 'showPlayerName');
  bindOvToggle(toggleOvControls, 'showControls');
  bindOvToggle(toggleOvMeter, 'showMeter');
  bindOvToggle(toggleOvKeys, 'showKeyHints');
  bindOvToggle(toggleOvSpeakers, 'showSpeakers');

  btnResetOverlay.addEventListener('click', function () {
    settings.overlay = defaultOverlaySettings();
    saveSettings();
    updateUiState();
    logEvent(t('status.overlay_reset'), 'info');
  });

  btnCopyObsUrl.addEventListener('click', function () {
    var val = obsUrlInput.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(function () {
        copyObsCopied = true;
        btnCopyObsUrl.textContent = t('overlay.copied');
        if (copyObsTimer) clearTimeout(copyObsTimer);
        copyObsTimer = setTimeout(function () {
          copyObsCopied = false;
          copyObsTimer = null;
          btnCopyObsUrl.textContent = t('overlay.copy_url');
        }, 1500);
      }).catch(function () {});
    } else {
      obsUrlInput.select();
      try { document.execCommand('copy'); } catch (e) {}
    }
  });

  // Server Players & Log tab listeners
  playerSearchEl.addEventListener('input', function () {
    playerSearchQuery = playerSearchEl.value || '';
    renderSpeakersList(true);
  });
  document.querySelectorAll('[data-player-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      playerFilter = btn.getAttribute('data-player-filter') || 'all';
      document.querySelectorAll('[data-player-filter]').forEach(function (b) {
        b.classList.toggle('mc-btn--green', b === btn);
      });
      renderSpeakersList(true);
    });
  });
  btnRefreshPlayers.addEventListener('click', function () {
    requestServerPlayers();
    renderSpeakersList(true);
  });
  btnResetAllVolumes.addEventListener('click', function () {
    Object.keys(speakerPrefs).forEach(function (uuid) {
      speakerPrefs[uuid].volume = 100;
      speakerPrefs[uuid].muted = false;
      applySpeakerGain(uuid);
    });
    saveSpeakerPrefs();
    renderSpeakersList(true);
    logEvent(t('status.volumes_reset'), 'info');
  });
  btnClearLog.addEventListener('click', function () {
    eventLogEl.innerHTML = '';
  });

  // Periodic cleanup for idle decoder streams & speaking status
  setInterval(function () {
    var now = Date.now();
    var speakerUiDirty = false;

    for (var uuid in streams) {
      var st = streams[uuid];
      if (now - st.lastActivity > IDLE_TIMEOUT_MS) {
        st.worker.terminate();
        if (st.gainNode) { try { st.gainNode.disconnect(); } catch (e) {} }
        delete streams[uuid];
        if (knownSpeakers[uuid] && knownSpeakers[uuid].speaking) {
          knownSpeakers[uuid].speaking = false;
          speakerUiDirty = true;
        }
      } else if (knownSpeakers[uuid]) {
        var stillSpeaking = (now - st.lastSpokeAt) < 450;
        if (knownSpeakers[uuid].speaking !== stillSpeaking) {
          knownSpeakers[uuid].speaking = stillSpeaking;
          speakerUiDirty = true;
        }
      }
    }

    if (speakerUiDirty) {
      renderSpeakersList();
    }
  }, 350);

  function refreshAllTranslations() {
    var htmlLang = htmlLangForLocale(currentLocale);
    document.documentElement.lang = htmlLang;
    document.title = t('page.title');
    if (langSel) langSel.value = currentLocale;

    applyDomTranslations(document);
    if (pipWindow && !pipWindow.closed && pipWindow.document) {
      pipWindow.document.documentElement.lang = htmlLang;
      pipWindow.document.title = t('overlay.pip_window_title');
      applyDomTranslations(pipWindow.document);
    }

    refreshDeviceFallbackLabels();
    updateUiState();
    paintMeters();
    renderSpeakersList(true);
    refreshStatusText();
  }

  function setLocale(nextLocale, persist) {
    var matched = matchSupportedLocale(nextLocale) || 'en_US';
    currentLocale = matched;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_LANG_KEY, currentLocale);
      } catch (e) {}
    }
    if (langSel) langSel.value = currentLocale;
    return loadLocaleFile(currentLocale).then(function () {
      if (currentLocale === matched) {
        refreshAllTranslations();
      }
    });
  }

  // --- Initial Boot ---
  drawPixelAvatar(selfAvatarCanvas, playerName);
  applySavedSpeakerSink();
  refreshAllTranslations();

  var bootStarted = false;
  function finishInitialBoot() {
    if (bootStarted) return;
    bootStarted = true;
    refreshAllTranslations();

    if (!browserSupported) {
      showKey('status.boot_unsupported', null, 'error');
    } else if (!secureContext) {
      showKey('status.boot_insecure', null, 'warn');
    }

    if (sessionId) {
      connectWebSocket();
    } else {
      showKey('status.boot_no_id', null, 'warn');
    }
  }

  var bootFallbackTimer = setTimeout(finishInitialBoot, 1500);
  loadLocaleFile(currentLocale).then(function () {
    clearTimeout(bootFallbackTimer);
    finishInitialBoot();
  });
})();
