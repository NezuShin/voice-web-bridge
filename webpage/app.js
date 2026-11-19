/*
 * Voice Bridge — browser voice page (prototype)
 *
 * - Open microphone (no buttons): PCM from the selected input device is fed to
 *   the vendored opus-recorder encoder worker, which emits Ogg pages; app.js
 *   strips the container and sends bare Opus 48 kHz / 20 ms frames over WS.
 * - Incoming binary frames [0x02][16-byte speaker uuid][opus] are decoded per
 *   speaker with a dedicated decoder worker and played through the selected
 *   output device (HTMLMediaElement.setSinkId via a MediaStreamDestination).
 * - Server JSON messages (info/error) are displayed as the "last message".
 *
 * Wire protocol is documented in README.md.
 */
(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  var micSel = document.getElementById('mic-select');
  var speakerSel = document.getElementById('speaker-select');
  var outputEl = document.getElementById('output');
  var sessionId = new URLSearchParams(window.location.search).get('id');

  var ENCODER_WORKER_PATH = 'lib/encoderWorker.min.js';
  var DECODER_WORKER_PATH = 'lib/decoderWorker.min.js';
  // Drop decoder streams only after a long silence. Destroying a stream
  // mid-conversation (e.g. on a 1.5s pause) re-initializes the decoder and
  // adds artifacts; 5s covers normal speech pauses while still cleaning up
  // speakers who left or walked out of range.
  var IDLE_TIMEOUT_MS = 5000;

  // --- Status display (last message wins) ---
  function show(message) {
    statusEl.textContent = message;
  }

  // --- Support check ---
  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext) &&
      window.WebAssembly && window.Worker);
  }

  if (!sessionId) {
    show('Missing id parameter. Open this page from the link in the game chat.');
    return;
  }
  // getUserMedia only exists in secure contexts (https:// or localhost).
  // The browser silently skips the permission prompt otherwise.
  var secureContext = window.isSecureContext !== false;
  if (!secureContext) {
    show('Microphone unavailable: this page must be served over https:// ' +
      '(or from localhost). You can still hear players.');
  } else if (!supported()) {
    show('This browser does not support recording (getUserMedia + WebAssembly + Workers required).');
    return;
  }

  // --- WebSocket ---
  function wsUrl() {
    var path = '/voice-ws?id=' + encodeURIComponent(sessionId);
    if (window.location.protocol === 'https:') return 'wss://' + window.location.host + path;
    if (window.location.protocol === 'http:') return 'ws://' + window.location.host + path;
    return 'ws://127.0.0.1:8090' + path; // file:// development fallback
  }

  var ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';

  ws.onopen = function () {
    ensurePlayback();
    refreshDevices();
    if (!secureContext) return;
    // Request the microphone only from a user gesture — browsers reliably show
    // the permission prompt then, while un-gestured requests may be skipped.
    show('Connected. Click anywhere on the page to enable the microphone.');
    armGestureFallback('Click anywhere on the page to enable the microphone.');
  };

  ws.onmessage = function (event) {
    if (typeof event.data === 'string') {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      var text = msg && msg.message ? msg.message : JSON.stringify(msg);
      if (!secureContext) {
        text += '\nMicrophone unavailable: serve this page over https:// (or localhost).';
      }
      show(text);
      return;
    }
    handleAudioFrame(new Uint8Array(event.data));
  };

  ws.onclose = function (event) {
    show('Closed (' + event.code + ')' + (event.reason ? ': ' + event.reason : ''));
  };

  ws.onerror = function () {
    show('WebSocket error — is the voice server running?');
  };

  // --- Microphone capture → encoder worker ---

  var captureCtx = null;
  var micStream = null;
  var micSource = null;
  var micProcessor = null;
  var encoderWorker = null;
  var encoderReady = false;
  var selectedMicId = null;
  var selectedSpeakerId = null;
  var gestureHandler = null;
  var captureSeq = 0; // guards against racing getUserMedia prompts

  function initEncoder(sampleRate) {
    if (encoderWorker) { try { encoderWorker.terminate(); } catch (e) {} }
    encoderReady = false;
    encoderWorker = new Worker(ENCODER_WORKER_PATH);
    encoderWorker.onerror = function (e) {
      show('Encoder worker error: ' + (e && e.message ? e.message : 'unknown'));
    };
    encoderWorker.onmessage = function (e) {
      var data = e.data;
      if (!data) return;
      if (data.message === 'ready') { encoderReady = true; return; }
      if (data.page && ws.readyState === WebSocket.OPEN) {
        var packets = extractOpusPackets(data.page);
        for (var i = 0; i < packets.length; i++) ws.send(packets[i]);
      }
    };
    // Classic-Worker protocol of opus-recorder v8.0.5: config keys at top level.
    encoderWorker.postMessage({
      command: 'init',
      encoderApplication: 2048, // VOIP
      encoderFrameSize: 20,     // 20 ms frames
      encoderSampleRate: 48000,
      encoderBitRate: 32000,
      maxFramesPerPage: 1,      // one frame per page → stream immediately
      numberOfChannels: 1,
      originalSampleRate: sampleRate, // input rate; worker resamples to 48k
      resampleQuality: 3,
      serial: Math.floor(Math.random() * 4294967296)
    });
  }

  function stopCapture() {
    if (micProcessor) { try { micProcessor.disconnect(); } catch (e) {} micProcessor = null; }
    if (micSource) { try { micSource.disconnect(); } catch (e) {} micSource = null; }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    if (captureCtx) { captureCtx.close().catch(function () {}); captureCtx = null; }
  }

  function startCapture(deviceId) {
    var seq = ++captureSeq;
    stopCapture();
    var AC = window.AudioContext || window.webkitAudioContext;
    var constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    };
    if (deviceId && deviceId !== 'default') constraints.audio.deviceId = { exact: deviceId };

    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      if (seq !== captureSeq) {
        // A newer startCapture replaced this one while the prompt was open.
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      micStream = stream;
      captureCtx = new AC();
      var proceed = function () {
        if (seq !== captureSeq || micStream !== stream || !captureCtx) return;
        initEncoder(captureCtx.sampleRate);
        micSource = captureCtx.createMediaStreamSource(stream);
        micProcessor = captureCtx.createScriptProcessor(4096, 1, 1);
        micProcessor.onaudioprocess = function (e) {
          if (!encoderReady || !encoderWorker) return;
          var chunk = e.inputBuffer.getChannelData(0);
          if (!chunk || chunk.length === 0) return;
          var copy = new Float32Array(chunk.length);
          copy.set(chunk);
          encoderWorker.postMessage({ command: 'encode', buffers: [copy] });
        };
        micSource.connect(micProcessor);
        // ScriptProcessor only fires while connected to the destination;
        // mute the tap so the mic is not echoed into the speakers.
        var mute = captureCtx.createGain();
        mute.gain.value = 0;
        micProcessor.connect(mute);
        mute.connect(captureCtx.destination);
        show('Microphone active — speak and listen.');
        refreshDevices();
      };
      if (captureCtx.state === 'suspended') {
        captureCtx.resume().then(proceed).catch(proceed);
      } else {
        proceed();
      }
    }).catch(function (err) {
      var name = err && err.name ? err.name : '';
      var hint;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        hint = 'Microphone permission was not granted. Allow the microphone for this site ' +
          '(click the lock/padlock icon in the address bar), then click this page to retry.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        hint = 'No microphone found. Connect one, then click this page to retry.';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        hint = 'The microphone is in use by another application. Close it, then click this page to retry.';
      } else if (name === 'OverconstrainedError') {
        hint = 'The selected microphone does not support the requested settings. Pick another device.';
      } else {
        hint = 'Microphone error: ' + (err && err.message ? err.message : err);
      }
      show(hint);
      armGestureFallback(hint);
    });
  }

  // --- Gesture fallback (autoplay policy / suspended contexts) ---

  function armGestureFallback(message) {
    if (gestureHandler) return;
    show(message);
    gestureHandler = function () {
      document.removeEventListener('click', gestureHandler);
      document.removeEventListener('touchstart', gestureHandler);
      gestureHandler = null;
      if (playbackCtx && playbackCtx.state !== 'running') playbackCtx.resume().catch(function () {});
      if (outputEl.paused) outputEl.play().catch(function () {});
      if (!micStream || (captureCtx && captureCtx.state !== 'running')) {
        show('Requesting microphone permission…');
        startCapture(selectedMicId); // inside a user gesture → prompt is shown
      } else {
        show('Running.');
      }
    };
    document.addEventListener('click', gestureHandler);
    document.addEventListener('touchstart', gestureHandler);
  }

  // --- Device selects (applied instantly) ---

  function refreshDevices() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      fillSelect(micSel, devices.filter(function (d) { return d.kind === 'audioinput'; }), selectedMicId);
      fillSelect(speakerSel, devices.filter(function (d) { return d.kind === 'audiooutput'; }), selectedSpeakerId);
      // Adopt the visible default as the selection only if nothing was picked yet.
      if (!selectedMicId) selectedMicId = micSel.value || null;
      if (!selectedSpeakerId) selectedSpeakerId = speakerSel.value || null;
    }).catch(function () {});
  }

  function fillSelect(sel, devices, preferred) {
    sel.innerHTML = '';
    devices.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId || 'default';
      opt.textContent = d.label || d.deviceId || 'Default';
      sel.appendChild(opt);
    });
    if (!devices.length) return;
    var match = devices.some(function (d) { return (d.deviceId || 'default') === preferred; });
    sel.value = match ? preferred : devices[0].deviceId || 'default';
  }

  micSel.onchange = function () {
    selectedMicId = micSel.value || null;
    // Restart capture on the new device immediately.
    if (micStream || selectedMicId) startCapture(selectedMicId);
  };

  speakerSel.onchange = function () {
    selectedSpeakerId = speakerSel.value || null;
    if (typeof outputEl.setSinkId !== 'function') {
      show('This browser does not support speaker selection.');
      return;
    }
    outputEl.setSinkId(selectedSpeakerId).then(function () {
      if (outputEl.paused) outputEl.play().catch(function () {});
    }).catch(function (err) {
      show('Speaker change failed: ' + (err && err.message ? err.message : err));
    });
  };

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  // --- Playback output chain (AudioContext → MediaStreamDestination → <audio>) ---

  var playbackCtx = null;
  var playbackDest = null;
  var playbackGain = null; // master gain for the volume slider
  var volumeEl = document.getElementById('volume');

  function applyVolume() {
    var percent = parseInt(volumeEl.value, 10);
    if (isNaN(percent)) percent = 100;
    if (playbackGain) playbackGain.gain.value = percent / 100;
    try { localStorage.setItem('voicebridge-volume', String(percent)); } catch (e) {}
  }

  volumeEl.addEventListener('input', applyVolume);

  function ensurePlayback() {
    if (playbackCtx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    playbackCtx = new AC();
    if (typeof outputEl.setSinkId === 'function') {
      // Chromium: route through a media element so setSinkId can pick the device.
      playbackDest = playbackCtx.createMediaStreamDestination();
      outputEl.srcObject = playbackDest.stream;
      outputEl.play().catch(function () {});
    } else {
      // No device selection support: play directly to the default output.
      playbackDest = playbackCtx.destination;
    }
    // Master volume: pure gain (no dynamics processing — 100% is transparent).
    playbackGain = playbackCtx.createGain();
    playbackGain.connect(playbackDest);
    var saved = null;
    try { saved = localStorage.getItem('voicebridge-volume'); } catch (e) {}
    if (saved !== null && !isNaN(parseInt(saved, 10))) volumeEl.value = saved;
    applyVolume();
  }

  // Schedule decoded chunks back-to-back with a small lead. Starting every
  // chunk at "now" leaves an audible gap whenever the main thread stalls for
  // a moment (GC, message handling) — that gap is the stutter. Scheduling
  // ahead keeps playback gapless as long as stalls stay within the lead.
  var PLAY_AHEAD_SECONDS = 0.08;

  function playChunk(stream, chunk) {
    if (!playbackCtx || !playbackGain || !chunk || chunk.length === 0) return;
    var now = playbackCtx.currentTime;
    var duration = chunk.length / playbackCtx.sampleRate;
    var when;
    if (!stream.nextPlayTime || stream.nextPlayTime < now) {
      // First chunk of a stream, or the schedule fell behind (stall):
      // re-anchor with a fresh lead to absorb jitter.
      when = now + PLAY_AHEAD_SECONDS;
    } else {
      when = stream.nextPlayTime;
    }
    var buffer = playbackCtx.createBuffer(1, chunk.length, playbackCtx.sampleRate);
    buffer.copyToChannel(chunk, 0);
    var source = playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackGain);
    source.start(when);
    stream.nextPlayTime = when + duration;
  }

  // --- Server → speaker audio (per-speaker decoder workers) ---

  var streams = {}; // speaker uuid -> { worker, pageIndex, lastActivity, serial }

  function handleAudioFrame(frame) {
    if (frame.length < 18 || frame[0] !== 0x02) return;
    var uuid = bytesToUuid(frame.subarray(1, 17));
    var opus = frame.subarray(17);

    var stream = streams[uuid];
    if (!stream) {
      ensurePlayback();
      var worker = new Worker(DECODER_WORKER_PATH);
      worker.postMessage({
        command: 'init',
        decoderSampleRate: 48000,
        outputBufferSampleRate: playbackCtx.sampleRate,
        bufferLength: 2048
      });
      worker.onmessage = function (e) {
        if (!e.data) return; // null = finished
        var channels = e.data;
        for (var i = 0; i < channels.length; i++) playChunk(stream, channels[i]);
      };
      stream = {
        worker: worker,
        pageIndex: 0,
        lastActivity: Date.now(),
        serial: undefined,
        nextPlayTime: 0
      };
      streams[uuid] = stream;
      // Fake OpusHead BOS page so the worker initializes its decoder
      var head = buildOpusHeadPage(stream);
      worker.postMessage({ command: 'decode', pages: head }, [head.buffer]);
    }

    stream.lastActivity = Date.now();
    var page = buildAudioPage(stream, opus);
    stream.worker.postMessage({ command: 'decode', pages: page }, [page.buffer]);
  }

  // --- Ogg page helpers (decoder side: wrap bare frames into minimal pages) ---

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
    page[4] = 0;            // version
    page[5] = headerType;
    // granule position = 0 (ignored by the decoder)
    writeUint32LE(page, 14, serial);
    writeUint32LE(page, 18, pageIndex);
    // checksum = 0 (not verified by the decoder)
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

  // --- Ogg page parsing (encoder side: pages → bare Opus frames) ---

  var packetParts = []; // continuation accumulator across pages

  function extractOpusPackets(page) {
    var packets = [];
    if (page.length < 27) return packets;
    var segCount = page[26];
    var bodyStart = 27 + segCount;
    if (bodyStart > page.length) return packets;

    // Skip OpusHead / OpusTags header pages (not sent in this pipeline, kept for safety)
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
    return (page[offset] === 0x4F && page[offset + 1] === 0x70 &&   // "Op"
            page[offset + 2] === 0x75 && page[offset + 3] === 0x73 && // "us"
            page[offset + 4] === 0x48 && page[offset + 5] === 0x65 && // "He"
            page[offset + 6] === 0x61 && page[offset + 7] === 0x64) || // "ad"
           (page[offset] === 0x4F && page[offset + 1] === 0x70 &&
            page[offset + 2] === 0x75 && page[offset + 3] === 0x73 &&
            page[offset + 4] === 0x54 && page[offset + 5] === 0x61 && // "Ta"
            page[offset + 6] === 0x67 && page[offset + 7] === 0x73);  // "gs"
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

  // --- Utils ---

  function bytesToUuid(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }

  // Drop decoder streams that have been silent for a while
  // (speaker walked out of range, stopped talking, or left).
  setInterval(function () {
    var now = Date.now();
    for (var uuid in streams) {
      if (now - streams[uuid].lastActivity > IDLE_TIMEOUT_MS) {
        streams[uuid].worker.terminate();
        delete streams[uuid];
      }
    }
  }, 1000);
})();
