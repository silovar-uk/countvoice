(() => {
  "use strict";

  const STORAGE_KEY = "count-voice-settings-v1";
  const DEFAULT_SETTINGS = Object.freeze({
    voiceURI: null,
    rate: 1.25,
    volume: 0.7,
    isMuted: false
  });

  const RATE_OPTIONS = [
    { label: "ゆっくり", value: 1.0 },
    { label: "標準", value: 1.25 },
    { label: "速め", value: 1.5 }
  ];

  const VOLUME_OPTIONS = [
    { label: "小", value: 0.35 },
    { label: "中", value: 0.7 },
    { label: "大", value: 1.0 }
  ];

  const els = {
    app: document.querySelector(".app-shell"),
    headerAction: document.querySelector("#header-action"),
    primaryControls: document.querySelector("#primary-controls"),
    modeLabel: document.querySelector("#mode-label"),
    elapsedTime: document.querySelector("#elapsed-time"),
    soundHint: document.querySelector("#sound-hint"),
    appStatus: document.querySelector("#app-status"),
    settingsDialog: document.querySelector("#settings-dialog"),
    resetDialog: document.querySelector("#reset-dialog"),
    closeSettings: document.querySelector("#close-settings"),
    voiceSelect: document.querySelector("#voice-select"),
    testVoice: document.querySelector("#test-voice"),
    rateOptions: document.querySelector("#rate-options"),
    volumeOptions: document.querySelector("#volume-options"),
    cancelReset: document.querySelector("#cancel-reset"),
    confirmReset: document.querySelector("#confirm-reset"),
    resetCopy: document.querySelector("#reset-copy"),
    settingsButtonTemplate: document.querySelector("#settings-button-template"),
    soundButtonTemplate: document.querySelector("#sound-button-template")
  };

  const state = {
    mode: "stopped", // stopped | running | paused
    elapsedMs: 0,
    startedAt: null,
    timerId: null,
    voices: [],
    speechSupported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    pageVisible: document.visibilityState === "visible",
    lastHandledSecond: -1,
    lastSpokenSecond: -1,
    lastDialogTrigger: null
  };

  let settings = loadSettings();

  function init() {
    renderSegmentedOptions();
    hydrateVoices();
    bindEvents();
    render();
    updateTimerDisplay(0);

    if (!state.speechSupported) {
      announceStatus("このブラウザでは音声読み上げを利用できません。カウント表示のみ利用できます。");
    }
  }

  function bindEvents() {
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (state.speechSupported) {
      window.speechSynthesis.addEventListener?.("voiceschanged", hydrateVoices);
    }

    els.closeSettings.addEventListener("click", () => closeDialog(els.settingsDialog));
    els.testVoice.addEventListener("click", () => {
      speakText("カウントを開始します", { force: true });
    });

    els.voiceSelect.addEventListener("change", () => {
      settings.voiceURI = els.voiceSelect.value || null;
      saveSettings();
      announceStatus("音声を変更しました");
    });

    els.cancelReset.addEventListener("click", () => closeDialog(els.resetDialog));
    els.confirmReset.addEventListener("click", confirmReset);

    els.settingsDialog.addEventListener("click", (event) => {
      if (event.target === els.settingsDialog) {
        closeDialog(els.settingsDialog);
      }
    });

    // The reset dialog intentionally does not close on backdrop click.

    [els.settingsDialog, els.resetDialog].forEach((dialog) => {
      dialog.addEventListener("close", () => {
        const trigger = state.lastDialogTrigger;
        state.lastDialogTrigger = null;
        if (trigger instanceof HTMLElement) {
          requestAnimationFrame(() => trigger.focus());
        }
      });
    });
  }

  function render() {
    els.app.classList.toggle("is-running", state.mode === "running");
    els.modeLabel.dataset.mode = state.mode;
    els.modeLabel.textContent = getModeLabel();
    els.soundHint.hidden = !(settings.isMuted && state.mode !== "running");

    renderHeaderAction();
    renderPrimaryControls();
    updateTimerDisplay(getElapsedSeconds());
  }

  function renderHeaderAction() {
    els.headerAction.replaceChildren();

    if (state.mode === "running") {
      const soundButton = els.soundButtonTemplate.content.firstElementChild.cloneNode(true);
      const isSoundOn = !settings.isMuted;
      soundButton.setAttribute("aria-pressed", String(isSoundOn));
      soundButton.setAttribute("aria-label", isSoundOn ? "音声をオフにする" : "音声をオンにする");
      soundButton.addEventListener("click", toggleMute);
      els.headerAction.append(soundButton);
      return;
    }

    const settingsButton = els.settingsButtonTemplate.content.firstElementChild.cloneNode(true);
    settingsButton.addEventListener("click", (event) => openSettings(event.currentTarget));
    els.headerAction.append(settingsButton);
  }

  function renderPrimaryControls() {
    els.primaryControls.replaceChildren();

    const primaryButton = document.createElement("button");
    primaryButton.type = "button";
    primaryButton.className = "primary-action";

    if (state.mode === "stopped") {
      primaryButton.textContent = "カウント開始";
      primaryButton.addEventListener("click", startCount);
    } else if (state.mode === "running") {
      primaryButton.textContent = "一時停止";
      primaryButton.addEventListener("click", pauseCount);
    } else {
      primaryButton.textContent = "再開";
      primaryButton.addEventListener("click", resumeCount);
    }

    els.primaryControls.append(primaryButton);

    if (state.mode === "paused") {
      const resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "secondary-action";
      resetButton.textContent = "リセット";
      resetButton.addEventListener("click", (event) => openResetDialog(event.currentTarget));
      els.primaryControls.append(resetButton);
    }
  }

  function renderSegmentedOptions() {
    renderSegmentedGroup(els.rateOptions, RATE_OPTIONS, settings.rate, "rate");
    renderSegmentedGroup(els.volumeOptions, VOLUME_OPTIONS, settings.volume, "volume");
  }

  function renderSegmentedGroup(container, options, selectedValue, key) {
    container.replaceChildren();

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "segment-button";
      button.textContent = option.label;
      button.dataset.value = String(option.value);
      button.setAttribute("aria-pressed", String(option.value === selectedValue));
      button.addEventListener("click", () => {
        settings[key] = option.value;
        saveSettings();
        renderSegmentedOptions();
        announceStatus(`${key === "rate" ? "音声速度" : "音声音量"}を${option.label}に変更しました`);
      });
      container.append(button);
    }
  }

  function startCount() {
    state.mode = "running";
    state.elapsedMs = 0;
    state.startedAt = Date.now();
    state.lastHandledSecond = -1;
    state.lastSpokenSecond = -1;
    startTicker();
    render();
    announceStatus("カウントを開始しました");
  }

  function pauseCount() {
    if (state.mode !== "running") return;

    state.elapsedMs = getElapsedMs();
    state.startedAt = null;
    state.mode = "paused";
    stopTicker();
    cancelSpeech();
    render();
    announceStatus("カウントを一時停止しました");
  }

  function resumeCount() {
    if (state.mode !== "paused") return;

    state.mode = "running";
    state.startedAt = Date.now();
    state.lastHandledSecond = getElapsedSeconds();
    startTicker();
    render();
    announceStatus("カウントを再開しました");
  }

  function openResetDialog(trigger) {
    const seconds = getElapsedSeconds();
    els.resetCopy.textContent = `${formatSpokenDuration(seconds)}のカウントをリセットしますか？`;
    openDialog(els.resetDialog, trigger);
  }

  function confirmReset() {
    closeDialog(els.resetDialog);
    stopTicker();
    cancelSpeech();
    state.mode = "stopped";
    state.elapsedMs = 0;
    state.startedAt = null;
    state.lastHandledSecond = -1;
    state.lastSpokenSecond = -1;
    render();
    announceStatus("カウントをリセットしました");
  }

  function toggleMute() {
    settings.isMuted = !settings.isMuted;
    saveSettings();

    if (settings.isMuted) {
      cancelSpeech();
      announceStatus("音声をオフにしました");
    } else {
      announceStatus("音声をオンにしました");
    }

    render();
  }

  function startTicker() {
    stopTicker();
    tick();
    state.timerId = window.setInterval(tick, 180);
  }

  function stopTicker() {
    if (state.timerId !== null) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function tick() {
    const elapsedSeconds = getElapsedSeconds();
    updateTimerDisplay(elapsedSeconds);

    if (elapsedSeconds === state.lastHandledSecond) return;
    state.lastHandledSecond = elapsedSeconds;

    if (state.mode !== "running" || !state.pageVisible) return;

    const announcement = getAnnouncement(elapsedSeconds);
    if (!announcement || elapsedSeconds === state.lastSpokenSecond) return;

    state.lastSpokenSecond = elapsedSeconds;
    speakText(announcement);
  }

  function getElapsedMs() {
    if (state.mode === "running" && state.startedAt !== null) {
      return state.elapsedMs + (Date.now() - state.startedAt);
    }
    return state.elapsedMs;
  }

  function getElapsedSeconds() {
    return Math.floor(getElapsedMs() / 1000);
  }

  function getAnnouncement(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (totalSeconds >= 1 && totalSeconds <= 9) return String(totalSeconds);

    if (totalSeconds > 0 && hours > 0 && minutes === 0 && seconds === 0) {
      return `${hours}時間`;
    }

    if (totalSeconds > 0 && seconds === 0) {
      return `${minutes}分`;
    }

    if (seconds > 0 && seconds % 10 === 0) {
      return `${seconds}秒`;
    }

    return null;
  }

  function speakText(text, { force = false } = {}) {
    if (!state.speechSupported || (!force && settings.isMuted) || !text) return;

    const synth = window.speechSynthesis;
    cancelSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = settings.rate;
    utterance.volume = settings.volume;
    utterance.pitch = 1;

    const selectedVoice = state.voices.find((voice) => voice.voiceURI === settings.voiceURI);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    // Some mobile browsers can briefly report an interrupted state after cancel().
    // The zero-delay task lets the cancellation settle before the current cue starts.
    window.setTimeout(() => {
      if (!force && (state.mode !== "running" || !state.pageVisible || settings.isMuted)) return;
      synth.speak(utterance);
    }, 0);
  }

  function cancelSpeech() {
    if (state.speechSupported) {
      window.speechSynthesis.cancel();
    }
  }

  function hydrateVoices() {
    if (!state.speechSupported) {
      els.voiceSelect.innerHTML = "<option value=\"\">このブラウザでは音声を利用できません</option>";
      els.voiceSelect.disabled = true;
      els.testVoice.disabled = true;
      return;
    }

    const allVoices = window.speechSynthesis.getVoices();
    const japaneseVoices = allVoices.filter((voice) => voice.lang.toLowerCase().startsWith("ja"));
    state.voices = japaneseVoices.length > 0 ? japaneseVoices : allVoices;

    els.voiceSelect.replaceChildren();

    if (state.voices.length === 0) {
      const option = new Option("音声を読み込み中…", "");
      els.voiceSelect.add(option);
      els.voiceSelect.disabled = true;
      els.testVoice.disabled = true;
      return;
    }

    els.voiceSelect.disabled = false;
    els.testVoice.disabled = false;

    const preferredVoice = state.voices.find((voice) => voice.voiceURI === settings.voiceURI);
    const defaultVoice = preferredVoice || state.voices.find((voice) => voice.default) || state.voices[0];

    if (!settings.voiceURI || !preferredVoice) {
      settings.voiceURI = defaultVoice.voiceURI;
      saveSettings();
    }

    for (const voice of state.voices) {
      const source = voice.localService ? "端末" : "ネットワーク";
      const option = new Option(`${voice.name}（${voice.lang}・${source}）`, voice.voiceURI, false, voice.voiceURI === settings.voiceURI);
      els.voiceSelect.add(option);
    }
  }

  function openSettings(trigger) {
    hydrateVoices();
    openDialog(els.settingsDialog, trigger);
  }

  function openDialog(dialog, trigger) {
    state.lastDialogTrigger = trigger;

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
      return;
    }

    dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
      return;
    }

    dialog.removeAttribute("open");
    const trigger = state.lastDialogTrigger;
    state.lastDialogTrigger = null;
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  function handleVisibilityChange() {
    state.pageVisible = document.visibilityState === "visible";

    if (!state.pageVisible) {
      cancelSpeech();
      return;
    }

    // Do not replay missed milestones after returning from another tab/app.
    const currentSecond = getElapsedSeconds();
    state.lastHandledSecond = currentSecond;
    state.lastSpokenSecond = currentSecond;
    updateTimerDisplay(currentSecond);
  }

  function updateTimerDisplay(totalSeconds) {
    const visual = formatClock(totalSeconds);
    els.elapsedTime.querySelector("span").textContent = visual;
    els.elapsedTime.dataset.hasHours = String(totalSeconds >= 3600);
    els.elapsedTime.setAttribute("datetime", `PT${totalSeconds}S`);
    els.elapsedTime.setAttribute("aria-label", `経過時間 ${formatSpokenDuration(totalSeconds)}`);
  }

  function formatClock(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const two = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${two(hours)}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
  }

  function formatSpokenDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const units = [];

    if (hours > 0) units.push(`${hours}時間`);
    if (minutes > 0) units.push(`${minutes}分`);
    if (seconds > 0 || units.length === 0) units.push(`${seconds}秒`);

    return units.join("");
  }

  function getModeLabel() {
    if (state.mode === "running") return "カウント中";
    if (state.mode === "paused") return "一時停止中";
    return "準備完了";
  }

  function announceStatus(message) {
    // Clearing then setting helps repeated messages be announced consistently.
    els.appStatus.textContent = "";
    window.setTimeout(() => {
      els.appStatus.textContent = message;
    }, 20);
  }

  function loadSettings() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return { ...DEFAULT_SETTINGS };

      const parsed = JSON.parse(stored);
      return {
        voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : null,
        rate: RATE_OPTIONS.some((item) => item.value === parsed.rate) ? parsed.rate : DEFAULT_SETTINGS.rate,
        volume: VOLUME_OPTIONS.some((item) => item.value === parsed.volume) ? parsed.volume : DEFAULT_SETTINGS.volume,
        isMuted: typeof parsed.isMuted === "boolean" ? parsed.isMuted : DEFAULT_SETTINGS.isMuted
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing or storage-disabled environments can still use the app for this session.
    }
  }

  init();
})();
