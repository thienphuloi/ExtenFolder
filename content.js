/**
 * Content Script
 * Injects and manages the sidebar panel.
 */

(function() {
  if (window.hasRunInvoiceExtension) return;
  window.hasRunInvoiceExtension = true;

  const PANEL_WIDTH = '440px';
  let panelContainer = null;
  let shadowRoot = null;
  let isProcessing = false;
  let isStopping = false;
  let isAttachedWorkflow = false;
  let hasStickyStatus = false;
  let resumeSession = null;
  let currentAccountKey = null;
  let backgroundPort = null;
  let reconnectTimer = null;
  let reconnectDelay = 500;
  let loginRetryTimer = null;
  let pendingInvoiceTypes = [];
  let currentInvoiceType = '';
  let startParams = null;
  let currentStatusText = 'Hệ thống sẵn sàng.';
  let formSyncReady = false;
  let isApplyingFormState = false;
  let formSyncTimer = null;
  let isPanelPinned = false;
  const formClientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let observer = null;
  const HOME_URL = 'https://hoadondientu.gdt.gov.vn/';
  const SUPPORT_BADGE_FALLBACK_IMAGE = 'template/qr-ungho.jpg';
  const PENDING_AUTO_LOGIN_KEY = 'hdPendingAutoLogin';
  const SESSION_RECOVERY_KEY = 'hdLastSessionRecoveryAt';
  const LOGIN_DEBUG_PREFIX = '[HD-EXT login]';
  let supportBadgeConfig = null;
  let supportBadgeCards = [];
  let supportBadgeIndex = 0;
  let supportBadgeSlideTimer = null;

  function init() {
    createPanel();
    connectBackgroundPort();
    setupFormStateSync();
    handlePendingAutoLogin();
    setTimeout(() => {
      if (!isContextValid()) return;
      readPendingAutoLogin((pending) => {
        if (pending) return;
        recoverSessionErrorPage(false);
      });
    }, 300);
    checkConnection();
    restoreState();
    requestFormState();
    requestResumeSession();
    requestActiveDownloadState();
    setupMutationObserver();
    setupDateValidation();
    
    // Periodically check connection as user navigates or logs in externally
    setInterval(checkConnection, 5000);
    setInterval(() => {
      if (!isProcessing) requestActiveDownloadState();
    }, 3000);
  }

  function schedulePortReconnect() {
    if (reconnectTimer || backgroundPort || !isContextValid()) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isContextValid()) return;
      connectBackgroundPort();
      if (backgroundPort) {
        reconnectDelay = 500;
        requestActiveDownloadState();
        return;
      }
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
      schedulePortReconnect();
    }, reconnectDelay);
  }

  function connectBackgroundPort() {
    if (!isContextValid()) return;
    if (backgroundPort) return;
    try {
      backgroundPort = chrome.runtime.connect({ name: 'hoa-don-content' });
      backgroundPort.onMessage.addListener(handleBackgroundMessage);
      backgroundPort.onDisconnect.addListener(() => {
        backgroundPort = null;
        schedulePortReconnect();
      });
    } catch (_) {
      backgroundPort = null;
    }
  }

  function setupMutationObserver() {
    // Watch for login state changes on the host page
    observer = new MutationObserver((mutations) => {
        // Find elements that indicate being logged in (like user name or logout button)
        const logoutElement = document.querySelector('a[href*="/logout"], .user-info, .btn-logout, #user-name');
        const loginForm = document.querySelector('form[action*="/login"], #login-form');
        
        // If we see changes in key areas, re-check connection
        if (mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
           checkConnection();
        }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupDateValidation() {
    const fromInput = shadowRoot.getElementById('date-from');
    const toInput = shadowRoot.getElementById('date-to');
    
    if (toInput && fromInput) {
      toInput.addEventListener('change', () => {
        if (toInput.value && fromInput.value) {
          if (new Date(toInput.value) < new Date(fromInput.value)) {
            fromInput.value = toInput.value;
            fromInput.classList.add('flash-val');
            setTimeout(() => fromInput.classList.remove('flash-val'), 500);
          }
        }
      });
    }
  }

  function extensionAssetUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (_) {
      return path;
    }
  }

  function getDefaultSupportBadgeConfig() {
    return {
      enabled: true,
      mode: 'carousel',
      intervalMs: 7000,
      title: 'Ủng hộ phát triển',
      body: 'Nếu thấy công cụ hữu ích, bạn có thể ủng hộ để KanTech tiếp tục duy trì và cải tiến.',
      imageUrl: extensionAssetUrl(SUPPORT_BADGE_FALLBACK_IMAGE),
      imageAlt: 'Mã QR ủng hộ KanTech',
      ctaText: 'Liên hệ',
      ctaUrl: CONTACT_URL,
      note: 'Góp ý về phần mềm, xin liên hệ.'
    };
  }

  function textOrFallback(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
  }

  function createPanel() {
    panelContainer = document.createElement('div');
    panelContainer.id = 'hd-ext-container';
    document.body.appendChild(panelContainer);

    shadowRoot = panelContainer.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap');
      :host {
        all: initial;
        font-family: 'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        --hd-primary: #1a73e8;
        --hd-primary-dark: #0d47a1;
        --hd-primary-hover: #2563eb;
        --hd-accent: #1a73e8;
        --hd-border: #e2e8f0;
        --hd-text: #1e293b;
        --hd-muted: #64748b;
        box-sizing: border-box; 
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      * { box-sizing: border-box; font-family: inherit; }
      .sidebar { 
        position: fixed; 
        top: 0; 
        right: 0; 
        width: min(${PANEL_WIDTH}, calc(100vw - 56px)); 
        height: 100%; 
        max-height: 100vh;
        background: #fff; 
        box-shadow: -10px 0 30px rgba(0,0,0,0.15); 
        z-index: 2147483647; 
        display: flex; 
        flex-direction: column; 
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); 
        border-left: 1px solid #e2e8f0;
        overflow-x: hidden;
      }
      .sidebar.hidden { transform: translateX(105%); }
      .header { 
        padding: 14px 20px;
        background: #f8fafc; 
        border-bottom: 1px solid #e2e8f0; 
        display: flex; 
        flex-direction: column;
        gap: 12px;
        flex-shrink: 0;
      }
      .body-content {
        flex-grow: 1;
        overflow-y: auto;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 24px;
      }
      .body-content.support-only {
        justify-content: center;
        align-items: center;
      }
      .footer {
        flex-shrink: 0;
        padding: 15px 20px;
        background: white;
        border-top: 1px solid #e2e8f0;
        box-shadow: 0 -4px 10px rgba(0,0,0,0.05);
      }
      .header-banner {
        padding: 14px 20px; 
        background: var(--hd-primary); 
        color: white; 
        font-weight: 700 !important; 
        font-size: 13px; 
        text-align: center;
        flex-shrink: 0;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        box-shadow: inset 0 -2px 10px rgba(0,0,0,0.05);
        margin: -20px -20px 0;
      }
      .status-badge {
        font-size: 11px;
        padding: 0;
        border-radius: 0;
        font-weight: 700 !important;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
        white-space: nowrap;
        border: 0;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: transparent !important;
        font-family: inherit !important;
      }
      .status-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .status-badge-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
        max-width: 100%;
        line-height: 1.15;
      }
      .status-badge-mst,
      .status-badge-company {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status-badge-company {
        margin-top: 2px;
        color: #166534;
        font-size: 10px;
        font-weight: 600 !important;
        letter-spacing: 0;
        text-transform: none;
      }
      .status-badge.checking { color: #92400e; }
      .status-badge.checking::before { background: #f59e0b; animation: pulse 2s infinite; }
      .status-badge.connected { color: #15803d; }
      .status-badge.connected::before { background: #22c55e; }
      .status-badge.error { color: #b91c1c; }
      .status-badge.error::before { background: #ef4444; }

      .header-main {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        gap: 12px;
      }
      .connection-card {
        display: inline-flex;
        align-items: center;
        gap: 0;
        min-width: 0;
        max-width: 260px;
        padding: 6px 12px;
        border: 1px solid #e2e8f0;
        border-radius: 999px;
        background: #ffffff;
        box-shadow: 0 1px 4px rgba(0,0,0,0.07);
        transition: border-color 0.2s, background 0.2s;
      }
      .connection-card.connected {
        border-color: #bbf7d0;
        background: #f0fdf4;
      }
      .conn-mst {
        display: none;
        align-items: baseline;
        gap: 4px;
        min-width: 0;
        padding-left: 13px;
        white-space: nowrap;
        font-family: inherit !important;
      }
      .conn-mst-label {
        color: #94a3b8;
        font-size: 9px;
        font-weight: 500 !important;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-family: inherit !important;
      }
      .conn-mst-value {
        color: #166534;
        font-size: 11px;
        font-weight: 600 !important;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: inherit !important;
      }
      .header-actions {
        display: flex;
        align-items: stretch;
        gap: 8px;
        flex-shrink: 0;
      }

      @keyframes pulse {
        0% { transform: scale(0.95); opacity: 1; }
        50% { transform: scale(1.1); opacity: 0.7; }
        100% { transform: scale(0.95); opacity: 1; }
      }

      .status-message-hint {
        font-size: 12px; 
        font-weight: normal; 
        color: #ef4444; 
        margin: 4px 0;
        display: none; 
        line-height: 1.6;
        letter-spacing: -0.01em;
      }
      .pin-btn {
        cursor: pointer; 
        background: #f1f5f9; 
        border: 1px solid #cbd5e1; 
        font-size: 12px;
        color: #475569; 
        transition: all 0.2s;
        padding: 8px 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        gap: 8px;
        font-weight: 600 !important;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .pin-btn:hover { background: #e2e8f0; color: #1e293b; border-color: #94a3b8; }
      .pin-btn::after { content: 'GHIM'; font-size: 11px; letter-spacing: 0.04em; }
      .pin-btn.pinned {
        background: #eff6ff;
        color: #1d4ed8;
        border-color: #93c5fd;
      }
      .pin-btn.pinned::after { content: 'GHIM'; }

      .login-header-btn {
        background: #1e293b;
        color: white;
        border: none;
        padding: 7px 14px;
        border-radius: 6px;
        font-family: inherit;
        font-size: 11px;
        font-weight: 600 !important;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        display: none; 
        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
      }
      .login-header-btn:hover {
        background: #0f172a;
        transform: translateY(-1px);
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }

      .contact-header-btn {
        background: #ffffff;
        color: var(--hd-primary);
        border: 1px solid #bfdbfe;
        padding: 0 12px;
        border-radius: 6px;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700 !important;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
        display: flex;
        align-items: center;
      }
      .contact-header-btn:hover {
        background: #eff6ff;
        border-color: #93c5fd;
      }
      
      .section { margin-bottom: 0; }
      .section-title { 
        display: flex; 
        align-items: center; 
        gap: 12px; 
        font-size: 15px; 
        font-weight: 700 !important; 
        margin-bottom: 20px; 
        color: #0f172a; 
        letter-spacing: -0.02em;
      }
      .step-num { 
        background: var(--hd-primary); 
        color: white; 
        width: 22px; 
        height: 22px; 
        border-radius: 50%; 
        display: flex; 
        align-items: center; 
        justify-content: center; 
        font-size: 11px; 
        font-weight: 700 !important;
        box-shadow: 0 2px 4px rgba(21, 101, 192, 0.2);
      }
      .form-group { margin-bottom: 16px; }
      label { display: block; font-size: 11px; color: #64748b; margin-bottom: 8px; font-weight: 500 !important; text-transform: uppercase; letter-spacing: 0.08em; }
      
      /* Date styling */
      .date-container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      select { 
        width: 100%; 
        padding: 12px 14px; 
        border: 1px solid #cbd5e1; 
        border-radius: 8px; 
        font-size: 13px; 
        color: #1e293b;
        background: #fff;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: inherit !important;
        outline: none;
        appearance: none;
      }
      select:focus { border-color: #3b82f6; box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1); }
      .flash-val { border-color: #3b82f6 !important; background-color: #eff6ff; }

      .date-input-wrapper {
        position: relative;
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        height: 42px;
        transition: all 0.2s;
        display: flex;
        align-items: stretch;
      }
      .date-input-wrapper:focus-within {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px #eff6ff;
      }
      .date-input-wrapper.error .segments-container input, .date-input-wrapper.error .seg-sep {
        color: #ef4444;
      }
      .segments-container {
        flex: 1; display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 600; color: #1e293b; font-family: inherit;
        min-width: 0; padding: 0 4px;
      }
      .segments-container input {
        border: none; background: transparent; outline: none; text-align: center;
        padding: 0; color: inherit; font-family: inherit; border-radius: 4px;
      }
      .segments-container input::placeholder {
        color: #94a3b8;
      }
      .seg-dd, .seg-mm { width: 28px; }
      .seg-yyyy { width: 46px; }
      .seg-sep { color: #94a3b8; margin: 0 4px; }
      .date-icon-btn {
        position: relative;
        width: 44px;
        flex-shrink: 0;
        border-left: 1px solid #e2e8f0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0 8px 8px 0;
        transition: background 0.15s;
      }
      .date-icon-btn:hover {
        background: #f1f5f9;
      }
      .date-picker {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        z-index: 10;
      }
      .date-picker::-webkit-calendar-picker-indicator {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        padding: 0;
        margin: 0;
        cursor: pointer;
        opacity: 0;
      }
      .date-icon-btn svg {
        width: 18px; height: 18px; stroke: #64748b; pointer-events: none;
      }
      .toast-msg {
        position: absolute; top: -36px; left: 50%; transform: translateX(-50%);
        background: #1e293b; color: #fff; font-size: 11px; padding: 6px 10px;
        border-radius: 6px; opacity: 0; pointer-events: none; transition: all 0.2s;
        white-space: nowrap; z-index: 50; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
        transform: translate(-50%, 8px);
      }
      .toast-msg.show {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      
      .button-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px; }
      .mini-btn { 
        padding: 11px; 
        font-size: 11px; 
        background: #f8fafc; 
        border: 1px solid #e2e8f0; 
        border-radius: 8px; 
        cursor: pointer; 
        color: #475569;
        font-weight: 500 !important;
        transition: all 0.2s;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-family: inherit !important;
      }
      .mini-btn.active { background: var(--hd-primary); border-color: var(--hd-primary); color: white; box-shadow: 0 4px 12px rgba(21, 101, 192, 0.2); }
      .mini-btn:hover:not(.active) { background: #f1f5f9; border-color: #cbd5e1; }
      
      .filter-group-combined { 
        background: white; 
        border: 1px solid #e2e8f0; 
        border-radius: 10px; 
        padding: 16px; 
      }
      .radio-group-inner { 
        display: flex; 
        gap: 30px; 
        font-size: 14px; 
      }
      .adjustment-box-inner {
        border-top: 1px dashed #e2e8f0;
        margin-top: 12px;
        padding-top: 12px;
      }
      .radio-item { 
        display: flex; 
        align-items: center; 
        gap: 10px; 
        cursor: pointer; 
        color: #334155; 
        font-weight: 400 !important; 
      }
      .radio-item input[type="radio"], .radio-item input[type="checkbox"] {
        accent-color: var(--hd-primary);
        width: 16px;
        height: 16px;
      }
      
      .format-grid {
        display: grid; 
        grid-template-columns: 1fr 1fr; 
        gap: 16px; 
        background-color: #eff6ff; 
        border: 1px solid #dbeafe;
        padding: 18px 24px; 
        border-radius: 12px;
      }
      .format-title {
        justify-content: space-between;
      }
      .section-title-main {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      .clear-formats-btn {
        display: none;
        border: 1px solid #bfdbfe;
        background: #ffffff;
        color: var(--hd-primary);
        border-radius: 999px;
        padding: 5px 10px;
        font-size: 10px;
        font-weight: 700 !important;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        cursor: pointer;
        font-family: inherit !important;
      }
      .clear-formats-btn:hover {
        background: #eff6ff;
        border-color: var(--hd-primary);
      }

      .main-btn { 
        width: 100%; 
        padding: 18px; 
        background: var(--hd-primary); 
        color: white; 
        border: none; 
        border-radius: 10px; 
        font-weight: 600 !important; 
        font-size: 16px; 
        cursor: pointer; 
        margin-top: 10px; 
        box-shadow: 0 4px 14px rgba(26, 115, 232, 0.3);
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-family: inherit !important;
      }
      .main-btn:hover { background: var(--hd-primary-hover); box-shadow: 0 8px 20px rgba(26, 115, 232, 0.4); transform: translateY(-2px); }
      .main-btn:active { transform: translateY(0); }
      .main-btn:disabled { background: #94a3b8 !important; cursor: not-allowed; box-shadow: none; transform: none; }
      .main-btn.stop {
        background: #dc2626;
        box-shadow: 0 4px 14px rgba(220, 38, 38, 0.25);
      }
      .main-btn.stop:hover {
        background: #b91c1c;
        box-shadow: 0 8px 20px rgba(220, 38, 38, 0.35);
      }
      
      .progress-container { 
        margin-top: 25px; 
        background: #f1f5f9; 
        border-radius: 20px; 
        overflow: hidden; 
        height: 14px; 
        display: none; 
        border: 1px solid #e2e8f0;
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);
      }
      .progress-bar { 
        background: linear-gradient(90deg, #3b82f6, #2563eb); 
        height: 100%; 
        width: 0%; 
        transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); 
      }
      .status-log { 
        margin-top: 16px; 
        font-size: 12px; 
        color: #475569; 
        padding: 14px; 
        background: #fff; 
        border-radius: 8px; 
        min-height: 50px; 
        display: flex; 
        flex-direction: column; 
        justify-content: center;
        gap: 6px; 
        border: 1px solid #e2e8f0;
        line-height: 1.5;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      }
      .status-log b { color: #1e293b; font-weight: 500 !important; }

      .resume-card {
        display: none;
        margin-bottom: 12px;
        padding: 12px;
        border: 1px solid #bfdbfe;
        border-radius: 8px;
        background: #eff6ff;
        color: #1e3a8a;
        font-size: 12px;
        line-height: 1.45;
        gap: 10px;
        flex-direction: column;
      }
      .resume-card.visible { display: flex; }
      .resume-title {
        font-size: 12px;
        font-weight: 700 !important;
        color: #1e40af;
      }
      .resume-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .resume-btn {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        padding: 9px 10px;
        background: #ffffff;
        color: #1d4ed8;
        font-size: 11px;
        font-weight: 700 !important;
        cursor: pointer;
        text-transform: uppercase;
      }
      .resume-btn.primary {
        background: #2563eb;
        color: #ffffff;
        border-color: #2563eb;
      }
      .resume-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .support-badge {
        display: none;
        width: 100%;
        max-width: 330px;
        padding: 20px;
        border: 1px solid #dbe5f0;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.10);
        gap: 14px;
        align-items: center;
        flex-direction: column;
        text-align: center;
        font-family: Arial, "Segoe UI", sans-serif !important;
      }
      @keyframes supportFade {
        from { opacity: 0.45; transform: translateY(3px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .support-disclosure {
        margin-top: 8px;
        color: #64748b;
        font-size: 10.5px;
        line-height: 1.4;
        font-weight: 500 !important;
      }  
      .open-tab { 
        position: fixed; 
        right: 12px; 
        top: 50%; 
        transform: translateY(-50%); 
        width: 52px; 
        height: auto; 
        min-height: 480px;
        background: var(--hd-primary); 
        color: white; 
        display: flex; 
        flex-direction: column; 
        align-items: center; 
        justify-content: space-between; 
        padding: 24px 0;
        border-radius: 16px; 
        cursor: pointer; 
        z-index: 2147483646; 
        box-shadow: -8px 0 25px rgba(21, 101, 192, 0.25); 
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        border: 1px solid rgba(255,255,255,0.15);
        gap: 20px;
      }
      .open-tab:hover { 
        width: 62px; 
        background: var(--hd-primary-dark);
      }
      .open-tab-logo {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
      }
      .open-tab-logo svg {
        width: 100%;
        height: 100%;
        opacity: 1;
        filter: drop-shadow(0 4px 6px rgba(0,0,0,0.1));
      }
      .open-tab-text { 
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        font-size: 13px; 
        font-weight: 700 !important; 
        white-space: nowrap; 
        letter-spacing: 0.15em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.95);
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 10px 0;
      }
      .open-tab-status {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        flex-shrink: 0;
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.4);
      }
      .status-dot.online { background: #4ade80; box-shadow: 0 0 10px #4ade80; }
      .status-dot.offline { background: #f87171; box-shadow: 0 0 10px #f87171; }
      .open-tab-alert {
        position: fixed;
        right: 10px;
        top: calc(50% - 282px);
        transform: none;
        min-width: max-content;
        height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        background: #dc2626;
        color: #ffffff;
        border: none;
        box-shadow: 0 10px 24px rgba(185, 28, 28, 0.24);
        font-family: Arial, "Segoe UI", sans-serif !important;
        font-size: 12px;
        font-weight: 700 !important;
        line-height: 1;
        letter-spacing: 0;
        text-transform: uppercase;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        pointer-events: auto;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        transform-origin: right center;
        z-index: 2147483646;
      }
      .open-tab-alert::before {
        content: '!';
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        border-radius: 50%;
        background: #ffffff;
        color: #dc2626;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 800 !important;
        line-height: 1;
      }
      .open-tab-alert.visible { display: flex; }
      .open-tab-alert:hover {
        background: #b91c1c;
        box-shadow: 0 14px 28px rgba(185, 28, 28, 0.34);
        transform: translateY(-2px) scale(1.03);
      }
      .open-tab-alert:active {
        transform: translateY(0) scale(0.98);
      }
      .quick-login-btn {
        width: 34px;
        height: 34px;
        background: rgba(255,255,255,0.2);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        border: 1px solid rgba(255,255,255,0.3);
      }
      .quick-login-btn:hover { background: rgba(255,255,255,0.35); transform: scale(1.1); }
      .quick-login-btn svg { width: 18px; height: 18px; color: white; }

      @media (max-width: 1080px) {
        .sidebar {
          width: min(${PANEL_WIDTH}, calc(100vw - 56px));
          border-left: 1px solid #e2e8f0;
          box-shadow: -10px 0 30px rgba(0,0,0,0.15);
        }
        .header {
          padding: 14px 18px;
        }
        .body-content {
          padding: 18px;
          gap: 20px;
        }
        .footer {
          padding: 14px 18px;
        }
        .header-banner {
          padding: 13px 18px;
          font-size: 12px;
          margin: -18px -18px 0;
        }
        .open-tab {
          right: 8px;
          width: 48px;
          min-height: 420px;
          border-radius: 14px;
        }
        .open-tab-alert {
          right: 8px;
          top: calc(50% - 252px);
        }
        .open-tab:hover {
          width: 56px;
        }
      }

      @media (max-width: 560px) {
        .header-main {
          flex-direction: column;
          align-items: stretch;
        }
        .connection-card {
          max-width: none;
          width: 100%;
          justify-content: center;
        }
        .header-actions {
          justify-content: flex-end;
        }
        .date-container,
        .button-grid,
        .format-grid {
          grid-template-columns: 1fr;
        }
        .header > div:first-child {
          align-items: flex-start !important;
          gap: 10px;
        }
        .status-badge {
          white-space: normal;
          line-height: 1.4;
        }
        .main-btn {
          font-size: 14px;
          padding: 16px;
          letter-spacing: 0.07em;
        }
      }

      @media (max-height: 680px) {
        .header {
          display: none;
        }
        .body-content {
          padding-top: 12px;
        }
        .header-banner {
          margin-top: -12px;
        }
        .open-tab {
          min-height: 0;
          height: calc(100vh - 48px);
          top: 24px;
          transform: none;
          padding: 18px 0;
        }
        .open-tab-alert {
          top: 8px;
          right: 8px;
        }
      }
    `;
    shadowRoot.appendChild(style);

    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
      <div class="header">
        <div class="header-main">
          <div class="connection-card">
            <div id="conn-badge" class="status-badge checking">Đang kiểm tra...</div>
            <div id="conn-mst" class="conn-mst"><span class="conn-mst-label">MST</span><span id="conn-mst-value" class="conn-mst-value"></span></div>
          </div>
          <div class="header-actions">
            <button id="btn-login-smart" class="login-header-btn">ĐĂNG NHẬP</button>
            <button class="pin-btn" id="pin-panel" type="button" title="Ghim panel để không tự thu khi bấm ra ngoài"></button>
          </div>
        </div>
        <div id="login-hint" class="status-message-hint">⚠️ Vui lòng đăng nhập vào hoadondientu.gdt.gov.vn để sử dụng.</div>
      </div>
      <div class="body-content">
      <div class="header-banner">
        CÔNG CỤ TẢI HÓA ĐƠN ĐIỆN TỬ
      </div>
        <div class="section">
          <div class="section-title"><span class="step-num">1</span> Khoảng thời gian</div>
          <div class="date-container">
            <div class="form-group">
              <label>Từ ngày</label>
              <div class="date-input-wrapper" id="wrapper-from">
                <div class="segments-container" id="segments-from">
                  <input type="text" class="seg-dd" placeholder="DD" maxlength="2">
                  <span class="seg-sep">/</span>
                  <input type="text" class="seg-mm" placeholder="MM" maxlength="2">
                  <span class="seg-sep">/</span>
                  <input type="text" class="seg-yyyy" placeholder="YYYY" maxlength="4">
                </div>
                <div class="date-icon-btn">
                  <input type="date" id="date-from" class="date-picker">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="#64748b">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                </div>
                <div class="toast-msg">Đã chuẩn hóa ngày</div>
              </div>
            </div>
            <div class="form-group">
              <label>Đến ngày</label>
              <div class="date-input-wrapper" id="wrapper-to">
                <div class="segments-container" id="segments-to">
                  <input type="text" class="seg-dd" placeholder="DD" maxlength="2">
                  <span class="seg-sep">/</span>
                  <input type="text" class="seg-mm" placeholder="MM" maxlength="2">
                  <span class="seg-sep">/</span>
                  <input type="text" class="seg-yyyy" placeholder="YYYY" maxlength="4">
                </div>
                <div class="date-icon-btn">
                  <input type="date" id="date-to" class="date-picker">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="#64748b">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                </div>
                <div class="toast-msg">Đã chuẩn hóa ngày</div>
              </div>
            </div>
          </div>
          <div class="button-grid">
            <button class="mini-btn" id="btn-today">Hôm nay</button>
            <button class="mini-btn" id="btn-last-7-days">Hôm trước</button>
            <button class="mini-btn" id="btn-this-month">Tháng này</button>
            <button class="mini-btn" id="btn-prev-month">Tháng trước</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title"><span class="step-num">2</span> Loại hoá đơn & Lọc</div>
          <div class="filter-group-combined">
            <div class="radio-group-inner">
              <label class="radio-item"><input type="checkbox" class="inv-type-chk" value="purchase" checked> Mua vào</label>
              <label class="radio-item"><input type="checkbox" class="inv-type-chk" value="sold" checked> Bán ra</label>
            </div>
            
            <div class="adjustment-box-inner">
              <label class="radio-item" style="color: #b91c1c;">
                <input type="checkbox" id="chk-adjustment"> HĐ thay thế/điều chỉnh/hủy
              </label>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title format-title">
            <div class="section-title-main"><span class="step-num">3</span> Định dạng tải về (chọn nhiều)</div>
            <button type="button" class="clear-formats-btn" id="btn-clear-formats">Bỏ chọn</button>
          </div>
          <div class="format-grid">
            <label class="radio-item"><input type="checkbox" class="format-chk" value="xml" checked> XML</label>
            <label class="radio-item"><input type="checkbox" class="format-chk" value="excel" checked> EXCEL</label>
            <label class="radio-item"><input type="checkbox" class="format-chk" value="pdf"> PDF</label>
            <label class="radio-item"><input type="checkbox" class="format-chk" value="html"> HTML</label>
          </div>
        </div>
      </div>

      <div class="footer">
        <div class="resume-card" id="resume-card">
          <div class="resume-title">Có phiên tải chưa hoàn tất</div>
          <div id="resume-text">Bạn có thể tiếp tục tải phần còn lại.</div>
          <div class="resume-actions">
            <button type="button" class="resume-btn primary" id="btn-resume-download">Tiếp tục</button>
          </div>
        </div>
        <button class="main-btn" id="btn-download">BẮT ĐẦU TẢI DỮ LIỆU</button>

        <div class="progress-container" id="prog-container">
          <div class="progress-bar" id="prog-bar"></div>
        </div>

        <div class="status-log" id="status-log">Hệ thống sẵn sàng.</div>
      </div>
    `;
    shadowRoot.appendChild(sidebar);

    const openTab = document.createElement('div');
    openTab.className = 'open-tab';
    openTab.id = 'open-tab';
    openTab.innerHTML = `
      <div class="open-tab-logo" title="Invoice Tool">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="8" width="58" height="70" rx="8" fill="#ffffff" stroke="#cbd5e1" stroke-width="4"/>
          <rect x="20" y="29" width="36" height="5" rx="2.5" fill="#64748b" opacity="0.28"/>
          <rect x="20" y="41" width="36" height="5" rx="2.5" fill="#64748b" opacity="0.28"/>
          <rect x="20" y="53" width="27" height="5" rx="2.5" fill="#64748b" opacity="0.28"/>
          <rect x="51" y="51" width="42" height="42" rx="13" fill="var(--hd-accent)" stroke="#f8fafc" stroke-width="4"/>
          <rect x="68" y="58" width="8" height="14" rx="2" fill="white"/>
          <polygon points="60,70 84,70 72,84" fill="white"/>
          <rect x="60" y="82" width="24" height="5" rx="2" fill="white"/>
        </svg>
      </div>
      <div class="open-tab-text">MỞ CÔNG CỤ TẢI HÓA ĐƠN</div>
      <div class="open-tab-status">
        <div id="quick-login-side" class="quick-login-btn" style="display:none;" title="Đăng nhập ngay">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
        </div>
        <div id="side-status-dot" class="status-dot offline"></div>
      </div>
    `;
    shadowRoot.appendChild(openTab);

    const loginAlert = document.createElement('div');
    loginAlert.id = 'side-login-alert';
    loginAlert.className = 'open-tab-alert';
    loginAlert.innerHTML = 'CH&#431;A &#272;&#258;NG NH&#7852;P';
    shadowRoot.appendChild(loginAlert);

    shadowRoot.getElementById('pin-panel').onclick = togglePanelPinned;
    shadowRoot.getElementById('open-tab').onclick = showPanel;
    shadowRoot.getElementById('quick-login-side').onclick = (e) => {
      e.stopPropagation();
      performSmartLogin();
    };
    shadowRoot.getElementById('side-login-alert').onclick = (e) => {
      e.stopPropagation();
      performSmartLogin();
    };

    shadowRoot.getElementById('btn-today').onclick = setToday;
    shadowRoot.getElementById('btn-last-7-days').onclick = setYesterday;
    shadowRoot.getElementById('btn-this-month').onclick = setThisMonth;
    shadowRoot.getElementById('btn-prev-month').onclick = setPrevMonth;
    shadowRoot.getElementById('btn-download').onclick = () => {
      if (isProcessing) stopWork();
      else startWork('invoices');
    };
    shadowRoot.getElementById('btn-login-smart').onclick = performSmartLogin;
    shadowRoot.getElementById('btn-clear-formats').onclick = clearFormats;
    shadowRoot.getElementById('btn-resume-download').onclick = resumeWork;
    shadowRoot.querySelectorAll('.format-chk').forEach((checkbox) => {
      checkbox.addEventListener('change', updateClearFormatsButton);
    });
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    updateClearFormatsButton();
    
    const initDateSegments = (wrapperId, dateInputId) => {
      const wrapper = shadowRoot.getElementById(wrapperId);
      const dd = wrapper.querySelector('.seg-dd');
      const mm = wrapper.querySelector('.seg-mm');
      const yyyy = wrapper.querySelector('.seg-yyyy');
      const dateInput = shadowRoot.getElementById(dateInputId);
      const toast = wrapper.querySelector('.toast-msg');

      const currentYear = new Date().getFullYear();
      const getDaysInMonth = (m, y) => new Date(y, m, 0).getDate();
      const inputs = [dd, mm, yyyy];
      let yearBoundaryBlocked = false;
      
      const checkError = () => {
        let err = false;
        if (dd.value && parseInt(dd.value) > 31) err = true;
        if (mm.value && parseInt(mm.value) > 12) err = true;
        if (err) wrapper.classList.add('error');
        else wrapper.classList.remove('error');
      };

      const syncToDateInput = (d, m, y) => {
        const iso = `${y}-${m}-${d}`;
        if (dateInput.value !== iso) {
          dateInput.value = iso;
          dateInput.dispatchEvent(new Event('change'));
        }
      };

      inputs.forEach((input, index) => {
        input.addEventListener('focus', () => {
          input.select();
        });

        input.addEventListener('input', (e) => {
          let val = e.target.value.replace(/\D/g, '');
          e.target.value = val;
          if (input === dd && val.length === 2 && parseInt(val) > 0) mm.focus();
          if (input === mm && val.length === 2 && parseInt(val) > 0) yyyy.focus();
          checkError();
        });

        input.addEventListener('keyup', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') yearBoundaryBlocked = false;
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (e.repeat && yearBoundaryBlocked) return;
            const isUp = e.key === 'ArrowUp';
            const prevY = parseInt(yyyy.value) || new Date().getFullYear();
            const prevM = parseInt(mm.value) || 1;
            let d = parseInt(dd.value) || 1;
            let m = prevM;
            let y = prevY;
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const minDate = new Date(2020, 0, 1);

            if (input === dd) {
              if (isUp) {
                d += 1;
                if (d > getDaysInMonth(m, y)) { d = 1; m += 1; }
                if (m > 12) { m = 1; y += 1; }
              } else {
                d -= 1;
                if (d < 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } d = getDaysInMonth(m, y); }
              }
            } else if (input === mm) {
              if (isUp) {
                m += 1;
                if (m > 12) { m = 1; y += 1; }
              } else {
                m -= 1;
                if (m < 1) { m = 12; y -= 1; }
              }
              const maxD = getDaysInMonth(m, y);
              if (d > maxD) d = maxD;
            } else {
              y += isUp ? 1 : -1;
            }

            if (e.repeat && (y !== prevY || (input === dd && m !== prevM))) {
              yearBoundaryBlocked = true;
              return;
            }

            const proposed = new Date(y, m - 1, d); proposed.setHours(0, 0, 0, 0);
            if (proposed < minDate || proposed > today) return;

            dd.value = d.toString().padStart(2, '0');
            mm.value = m.toString().padStart(2, '0');
            yyyy.value = y.toString();
            checkError();
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            const allSelected = e.target.selectionStart === 0 && e.target.selectionEnd === e.target.value.length;
            if (allSelected) {
              if (index < 2) inputs[index + 1].focus();
              else {
                if (wrapperId === 'wrapper-from') shadowRoot.getElementById('wrapper-to').querySelector('.seg-dd').focus();
              }
            } else {
              e.target.select();
            }
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const allSelected = e.target.selectionStart === 0 && e.target.selectionEnd === e.target.value.length;
            if (allSelected) {
              if (index > 0) inputs[index - 1].focus();
              else {
                if (wrapperId === 'wrapper-to') shadowRoot.getElementById('wrapper-from').querySelector('.seg-yyyy').focus();
              }
            } else {
              e.target.select();
            }
          } else if (e.key === 'Tab' && !e.shiftKey && index === 2) {
             if (wrapperId === 'wrapper-from') { e.preventDefault(); shadowRoot.getElementById('wrapper-to').querySelector('.seg-dd').focus(); }
          } else if (e.key === 'Tab' && e.shiftKey && index === 0) {
             if (wrapperId === 'wrapper-to') { e.preventDefault(); shadowRoot.getElementById('wrapper-from').querySelector('.seg-yyyy').focus(); }
          }
        });

        input.addEventListener('blur', () => {
          setTimeout(() => {
            const active = shadowRoot.activeElement || document.activeElement;
            if (inputs.includes(active)) return;
            
            let d = parseInt(dd.value) || 1;
            let m = parseInt(mm.value) || new Date().getMonth() + 1;
            let y = parseInt(yyyy.value) || new Date().getFullYear();
            let fixed = false;

            if (y < 2020) { y = 2020; fixed = true; }
            if (y > currentYear) { y = currentYear; fixed = true; }
            if (m < 1) { m = 1; fixed = true; }
            if (m > 12) { m = 12; fixed = true; }
            const maxD = getDaysInMonth(m, y);
            if (d < 1) { d = 1; fixed = true; }
            if (d > maxD) { d = maxD; fixed = true; }

            const strD = d.toString().padStart(2, '0');
            const strM = m.toString().padStart(2, '0');
            const strY = y.toString();

            if (dd.value !== strD || mm.value !== strM || yyyy.value !== strY) fixed = true;

            dd.value = strD;
            mm.value = strM;
            yyyy.value = strY;
            wrapper.classList.remove('error');

            if (fixed) {
              toast.classList.add('show');
              setTimeout(() => toast.classList.remove('show'), 2000);
            }

            syncToDateInput(strD, strM, strY);
          }, 0);
        });
      });

      dateInput.addEventListener('change', (e) => {
        if (!e.target.value) return;
        const [y, m, d] = e.target.value.split('-');
        dd.value = d;
        mm.value = m;
        yyyy.value = y;
        checkError();
        
        let otherId = dateInputId === 'date-from' ? 'date-to' : 'date-from';
        let otherVal = shadowRoot.getElementById(otherId).value;

        if (otherVal) {
          let shouldFix = false;
          if (dateInputId === 'date-from' && e.target.value > otherVal) shouldFix = true;
          if (dateInputId === 'date-to' && e.target.value < otherVal) shouldFix = true;

          if (shouldFix) {
            const otherDateInput = shadowRoot.getElementById(otherId);
            otherDateInput.value = e.target.value;
            otherDateInput.dispatchEvent(new Event('change'));
            if (!isApplyingFormState) {
              const otherWrapper = shadowRoot.getElementById(`wrapper-${otherId.split('-')[1]}`);
              const otherToast = otherWrapper.querySelector('.toast-msg');
              otherToast.textContent = "Đã đồng bộ ngày";
              otherToast.classList.add('show');
              setTimeout(() => {
                otherToast.classList.remove('show');
                setTimeout(() => otherToast.textContent = "Đã chuẩn hóa ngày", 300);
              }, 2000);
            }
          }
        }
      });
    };

    initDateSegments('wrapper-from', 'date-from');
    initDateSegments('wrapper-to', 'date-to');

    setToday();
  }

  function setExtState(key, val) {
    // optional stub for extension state
  }

  function shortcutButtonIds() {
    return ['btn-today', 'btn-last-7-days', 'btn-this-month', 'btn-prev-month'];
  }

  function getActiveShortcut() {
    const active = shortcutButtonIds().find((id) => shadowRoot.getElementById(id)?.classList.contains('active'));
    return active || '';
  }

  function setActiveShortcut(shortcutId) {
    shortcutButtonIds().forEach((id) => {
      const button = shadowRoot.getElementById(id);
      if (button) button.classList.toggle('active', id === shortcutId);
    });
  }

  function getSelectedFormats() {
    return Array.from(shadowRoot.querySelectorAll('.format-chk:checked')).map(cb => cb.value);
  }

  function captureFormState() {
    return {
      fromDate: shadowRoot.getElementById('date-from')?.value || '',
      toDate: shadowRoot.getElementById('date-to')?.value || '',
      invoiceTypes: Array.from(shadowRoot.querySelectorAll('.inv-type-chk:checked')).map(cb => cb.value),
      isAdjustment: !!shadowRoot.getElementById('chk-adjustment')?.checked,
      formats: getSelectedFormats(),
      activeShortcut: getActiveShortcut()
    };
  }

  function applyFormState(state) {
    if (!state || typeof state !== 'object' || isProcessing) return;
    isApplyingFormState = true;
    try {
      const fromEl = shadowRoot.getElementById('date-from');
      const toEl = shadowRoot.getElementById('date-to');
      const nextFromDate = state.fromDate || '';
      const nextToDate = state.toDate || '';
      if (fromEl && nextFromDate && fromEl.value !== nextFromDate) {
        fromEl.value = nextFromDate;
      }
      if (toEl && nextToDate && toEl.value !== nextToDate) {
        toEl.value = nextToDate;
      }
      if (fromEl && nextFromDate) {
        fromEl.value = state.fromDate;
        fromEl.dispatchEvent(new Event('change'));
      }
      if (toEl && nextToDate) {
        toEl.value = state.toDate;
        toEl.dispatchEvent(new Event('change'));
      }

      const savedTypes = new Set(
        Array.isArray(state.invoiceTypes) ? state.invoiceTypes
          : [state.invoiceType || 'purchase']
      );
      shadowRoot.querySelectorAll('.inv-type-chk').forEach(cb => { cb.checked = savedTypes.has(cb.value); });

      const adjustment = shadowRoot.getElementById('chk-adjustment');
      if (adjustment) adjustment.checked = !!state.isAdjustment;

      const formats = new Set(Array.isArray(state.formats) ? state.formats : []);
      shadowRoot.querySelectorAll('.format-chk').forEach((checkbox) => {
        checkbox.checked = formats.has(checkbox.value);
      });
      updateClearFormatsButton();
      setActiveShortcut(state.activeShortcut || '');
    } finally {
      isApplyingFormState = false;
    }
  }

  function publishFormStateSoon() {
    if (!formSyncReady || isApplyingFormState || isProcessing || !isContextValid()) return;
    if (formSyncTimer) clearTimeout(formSyncTimer);
    formSyncTimer = setTimeout(() => {
      formSyncTimer = null;
      if (!formSyncReady || isApplyingFormState || isProcessing || !isContextValid()) return;
      try {
        chrome.runtime.sendMessage({
          type: 'SYNC_FORM_STATE',
          sourceClientId: formClientId,
          state: captureFormState()
        });
      } catch (_) {}
    }, 80);
  }

  function requestFormState() {
    if (!isContextValid()) {
      formSyncReady = true;
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'GET_FORM_STATE' }, (response) => {
        if (!chrome.runtime.lastError && response?.ok && response.state) {
          applyFormState(response.state);
        }
        formSyncReady = true;
      });
    } catch (_) {
      formSyncReady = true;
    }
  }

  function setupFormStateSync() {
    const selectors = [
      '#date-from',
      '#date-to',
      '.inv-type-chk',
      '#chk-adjustment',
      '.format-chk'
    ];
    selectors.forEach((selector) => {
      shadowRoot.querySelectorAll(selector).forEach((el) => {
        el.addEventListener('change', publishFormStateSoon);
      });
    });
    ['btn-today', 'btn-last-7-days', 'btn-this-month', 'btn-prev-month', 'btn-clear-formats'].forEach((id) => {
      const button = shadowRoot.getElementById(id);
      if (button) button.addEventListener('click', () => setTimeout(publishFormStateSoon, 0));
    });
  }

  function debugLogin(message, data) {
    try {
      if (data === undefined) {
        console.info(LOGIN_DEBUG_PREFIX, message);
      } else {
        console.info(LOGIN_DEBUG_PREFIX, message, data);
      }
    } catch (_) {}
  }

  function setSessionPendingAutoLogin(value) {
    try {
      if (value) {
        sessionStorage.setItem(PENDING_AUTO_LOGIN_KEY, '1');
      } else {
        sessionStorage.removeItem(PENDING_AUTO_LOGIN_KEY);
      }
    } catch (_) {}
  }

  function hasSessionPendingAutoLogin() {
    try {
      return sessionStorage.getItem(PENDING_AUTO_LOGIN_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function saveLoginState(update, callback) {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      callback();
    };

    if (!isContextValid()) {
      debugLogin('chrome context invalid, continuing without storage save');
      finish();
      return;
    }

    try {
      chrome.storage.local.set(update, () => {
        if (chrome.runtime.lastError) {
          debugLogin('storage save failed', chrome.runtime.lastError.message);
        } else {
          debugLogin('storage save ok', update);
        }
        finish();
      });
      setTimeout(finish, 200);
    } catch (e) {
      debugLogin('storage save threw', e?.message || e);
      finish();
    }
  }

  function readPendingAutoLogin(callback) {
    const sessionPending = hasSessionPendingAutoLogin();

    if (!isContextValid()) {
      callback(sessionPending);
      return;
    }

    try {
      chrome.storage.local.get([PENDING_AUTO_LOGIN_KEY], (res) => {
        if (chrome.runtime.lastError) {
          debugLogin('storage read failed', chrome.runtime.lastError.message);
          callback(sessionPending);
          return;
        }
        callback(sessionPending || !!res[PENDING_AUTO_LOGIN_KEY]);
      });
    } catch (e) {
      debugLogin('storage read threw', e?.message || e);
      callback(sessionPending);
    }
  }

  function clearPendingAutoLogin() {
    setSessionPendingAutoLogin(false);
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ [PENDING_AUTO_LOGIN_KEY]: false }, () => {
        if (chrome.runtime.lastError) {
          debugLogin('clear pending failed', chrome.runtime.lastError.message);
        } else {
          debugLogin('pending auto-login cleared');
        }
      });
    } catch (e) {
      debugLogin('clear pending threw', e?.message || e);
    }
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisibleElement(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const text = normalizeSearchText(el.textContent);
    const href = normalizeSearchText(el.href || el.getAttribute?.('href') || '');
    const className = normalizeSearchText(el.className || '');
    const role = el.getAttribute?.('role') || '';
    const tagName = el.tagName?.toLowerCase() || '';
    const style = window.getComputedStyle(el);

    return {
      rect,
      text,
      href,
      className,
      role,
      tagName,
      cursor: style.cursor
    };
  }

  function hasLoginSignal(info) {
    return info.text === 'dang nhap'
      || (info.text.includes('dang nhap') && info.text.length <= 120)
      || info.href.includes('dang-nhap')
      || info.href.includes('login')
      || info.className.includes('dang-nhap')
      || info.className.includes('login');
  }

  function isReasonableLoginTarget(el, sourceEl = el) {
    if (!isVisibleElement(el)) return false;

    const info = getElementInfo(el);
    const sourceInfo = getElementInfo(sourceEl);
    const hasLinkSignal = info.href.includes('dang-nhap')
      || info.href.includes('login')
      || info.className.includes('dang-nhap')
      || info.className.includes('login');
    const isHugeContainer = info.rect.width > 360
      || info.rect.height > 120
      || (info.text.length > 160 && !hasLinkSignal && sourceInfo.text.length > 120);

    return !isHugeContainer && (hasLoginSignal(info) || hasLoginSignal(sourceInfo));
  }

  function isClickableElement(el) {
    const info = getElementInfo(el);
    return info.tagName === 'button'
      || info.tagName === 'a'
      || info.role === 'button'
      || el.hasAttribute?.('onclick')
      || el.classList?.contains('ant-btn')
      || el.classList?.contains('btn')
      || info.cursor === 'pointer';
  }

  function scoreLoginCandidate(el, sourceEl = el) {
    if (!isReasonableLoginTarget(el, sourceEl)) return -Infinity;

    const info = getElementInfo(el);
    const sourceInfo = getElementInfo(sourceEl);
    let score = 0;

    if (info.text === 'dang nhap' || sourceInfo.text === 'dang nhap') score += 100;
    else if (info.text.includes('dang nhap') || sourceInfo.text.includes('dang nhap')) score += 60;
    if (info.href.includes('dang-nhap') || info.href.includes('login')) score += 60;
    if (info.className.includes('dang-nhap') || info.className.includes('login')) score += 35;
    if (info.tagName === 'button' || info.tagName === 'a') score += 30;
    if (info.role === 'button') score += 20;
    if (el.hasAttribute?.('onclick') || info.cursor === 'pointer') score += 12;
    score += Math.max(0, 20 - Math.round((info.rect.width * info.rect.height) / 1200));

    return score;
  }

  function isHomePage() {
    return location.origin === 'https://hoadondientu.gdt.gov.vn'
      && (location.pathname === '/' || location.pathname === '');
  }

  function isSessionErrorPage() {
    const text = normalizeSearchText(document.body?.innerText || '');
    const hasStatus = /\b(403|404)\b/.test(text);
    const hasErrorMessage = text.includes('khong co quyen truy cap')
      || text.includes('khong co quyen')
      || text.includes('khong tim thay')
      || text.includes('rat tiec')
      || text.includes('truy cap trang nay');
    return hasStatus && hasErrorMessage;
  }

  function redirectHomeWithOptionalLogin(autoLogin) {
    debugLogin('redirect requested', {
      autoLogin,
      from: location.href,
      isHomePage: isHomePage(),
      isSessionErrorPage: isSessionErrorPage()
    });
    setSessionPendingAutoLogin(!!autoLogin);

    const goHome = () => {
      if (!isHomePage()) {
        updateStatus(autoLogin ? 'Dang mo trang chu de dang nhap...' : 'Dang dua ve trang chu...', 'info');
        debugLogin('navigating to home', HOME_URL);
        try {
          window.location.assign(HOME_URL);
        } catch (e) {
          debugLogin('location.assign failed, using href fallback', e?.message || e);
          window.location.href = HOME_URL;
        }
      } else if (autoLogin) {
        debugLogin('already on home, starting pending auto-login');
        setTimeout(handlePendingAutoLogin, 0);
      }
    };

    const update = { [PENDING_AUTO_LOGIN_KEY]: !!autoLogin };
    if (!autoLogin) update[SESSION_RECOVERY_KEY] = Date.now();
    saveLoginState(update, goHome);
  }

  function recoverSessionErrorPage(autoLogin) {
    if (!isSessionErrorPage() || isHomePage()) return false;

    if (!autoLogin) {
      const last = Number(sessionStorage.getItem(SESSION_RECOVERY_KEY) || 0);
      const now = Date.now();
      if (now - last < 30000) return false;
      sessionStorage.setItem(SESSION_RECOVERY_KEY, String(now));
    }

    redirectHomeWithOptionalLogin(autoLogin);
    return true;
  }

  function findNativeLoginButton() {
    const loginSelectors = [
      'a[href*="/login"]',
      'a[href*="login"]',
      'a[href*="/dang-nhap"]',
      'a[href*="dang-nhap"]',
      'button[class*="login"]',
      'a[class*="login"]',
      '[class*="login"]',
      '[class*="dang-nhap"]',
      '.btn-login',
      '#login-btn'
    ];

    const candidates = [];

    for (const selector of loginSelectors) {
      try {
        document.querySelectorAll(selector).forEach(el => candidates.push({ el, source: el }));
      } catch (_) {}
    }

    const allElements = document.querySelectorAll('a, button, [role="button"], [onclick], .ant-btn, .btn, span, li, div');
    for (const el of allElements) {
      if (!isVisibleElement(el)) continue;
      const text = normalizeSearchText(el.textContent);
      if ((text === 'dang nhap' || text.includes('dang nhap')) && text.length <= 120) {
        candidates.push({ el, source: el });
      }
    }

    let best = null;
    let bestScore = -Infinity;
    const seen = new Set();

    for (const item of candidates) {
      const clickable = closestClickableElement(item.el) || item.el;
      if (seen.has(clickable)) continue;
      seen.add(clickable);

      const score = scoreLoginCandidate(clickable, item.source);
      if (score > bestScore) {
        best = clickable;
        bestScore = score;
      }
    }

    if (best) {
      debugLogin('native login candidate selected', {
        score: bestScore,
        tagName: best.tagName,
        text: normalizeSearchText(best.textContent).slice(0, 80),
        href: best.href || best.getAttribute?.('href') || ''
      });
    }

    return bestScore > 0 ? best : null;
  }

  function closestClickableElement(el) {
    let current = el;
    let depth = 0;

    while (current && current !== document.body && depth < 6) {
      if (isClickableElement(current) && isReasonableLoginTarget(current, el)) return current;
      current = current.parentElement;
      depth++;
    }

    return null;
  }

  function clickNativeLoginButton() {
    const loginBtn = findNativeLoginButton();
    if (!loginBtn) return false;

    const clickable = closestClickableElement(loginBtn) || loginBtn;
    debugLogin('clicking native login button', {
      tagName: clickable.tagName,
      text: normalizeSearchText(clickable.textContent).slice(0, 80),
      href: clickable.href || clickable.getAttribute?.('href') || ''
    });
    clickable.click();
    return true;
  }

  function handlePendingAutoLogin() {
    if (!isContextValid()) return;

    readPendingAutoLogin((pending) => {
      if (!isContextValid() || !pending) return;

      debugLogin('pending auto-login detected', location.href);

      if (recoverSessionErrorPage(true)) return;

      const startedAt = Date.now();
      let attempt = 0;
      const tryClick = () => {
        if (!isContextValid()) return;
        attempt++;

        if (clickNativeLoginButton()) {
          updateStatus('Da bam nut Dang nhap tren website.', 'info');
          clearPendingAutoLogin();
          return;
        }

        if (Date.now() - startedAt < 10000) {
          if (attempt === 1 || attempt % 5 === 0) {
            debugLogin('waiting for native login button', { attempt, href: location.href });
          }
          setTimeout(tryClick, 500);
          return;
        }

        clearPendingAutoLogin();
        debugLogin('native login button timeout', location.href);
        updateStatus('Khong tim thay nut dang nhap tren trang chu. Vui long bam dang nhap thu cong.', 'error');
      };

      setTimeout(tryClick, 400);
    });
  }

  function handleDatePick(e) {
    const textInput = shadowRoot.getElementById(e.target.id + '-text');
    if (textInput && e.target.value) {
      textInput.value = formatDateVn(e.target.value);
    }
    setExtState(e.target.id, e.target.value);
  }

  function performSmartLogin() {
    debugLogin('extension login clicked', {
      href: location.href,
      isHomePage: isHomePage(),
      isSessionErrorPage: isSessionErrorPage()
    });
    updateStatus('Dang xu ly dang nhap...', 'info');
    hidePanel();

    if (!isHomePage()) {
      redirectHomeWithOptionalLogin(true);
      return;
    }

    if (clickNativeLoginButton()) return;

    redirectHomeWithOptionalLogin(true);
  }

  function setThisMonth() {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const fromEl = shadowRoot.getElementById('date-from');
    const toEl   = shadowRoot.getElementById('date-to');
    fromEl.value = formatDateIso(first);
    toEl.value   = formatDateIso(d);
    fromEl.dispatchEvent(new Event('change'));
    toEl.dispatchEvent(new Event('change'));
    shadowRoot.getElementById('btn-this-month').classList.add('active');
    shadowRoot.getElementById('btn-prev-month').classList.remove('active');
    shadowRoot.getElementById('btn-today').classList.remove('active');
    shadowRoot.getElementById('btn-last-7-days').classList.remove('active');
  }

  function setPrevMonth() {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last  = new Date(d.getFullYear(), d.getMonth(), 0);
    const fromEl = shadowRoot.getElementById('date-from');
    const toEl   = shadowRoot.getElementById('date-to');
    fromEl.value = formatDateIso(first);
    toEl.value   = formatDateIso(last);
    fromEl.dispatchEvent(new Event('change'));
    toEl.dispatchEvent(new Event('change'));
    shadowRoot.getElementById('btn-prev-month').classList.add('active');
    shadowRoot.getElementById('btn-this-month').classList.remove('active');
    shadowRoot.getElementById('btn-today').classList.remove('active');
    shadowRoot.getElementById('btn-last-7-days').classList.remove('active');
  }

  function setToday() {
    const d = new Date();
    const fromEl = shadowRoot.getElementById('date-from');
    const toEl   = shadowRoot.getElementById('date-to');
    fromEl.value = formatDateIso(d);
    toEl.value   = formatDateIso(d);
    fromEl.dispatchEvent(new Event('change'));
    toEl.dispatchEvent(new Event('change'));
    shadowRoot.getElementById('btn-today').classList.add('active');
    shadowRoot.getElementById('btn-this-month').classList.remove('active');
    shadowRoot.getElementById('btn-prev-month').classList.remove('active');
    shadowRoot.getElementById('btn-last-7-days').classList.remove('active');
  }

  function setYesterday() {
    const d = new Date();
    const yesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    const fromEl = shadowRoot.getElementById('date-from');
    const toEl   = shadowRoot.getElementById('date-to');
    fromEl.value = formatDateIso(yesterday);
    toEl.value   = formatDateIso(yesterday);
    fromEl.dispatchEvent(new Event('change'));
    toEl.dispatchEvent(new Event('change'));
    shadowRoot.getElementById('btn-last-7-days').classList.add('active');
    shadowRoot.getElementById('btn-this-month').classList.remove('active');
    shadowRoot.getElementById('btn-prev-month').classList.remove('active');
    shadowRoot.getElementById('btn-today').classList.remove('active');
  }

  function formatDateIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatDateVn(isoStr) {
    if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return "";
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function isContextValid() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  function checkConnection() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_TOKEN' }, (response) => {
        if (chrome.runtime.lastError) {
           // Extension context might be invalidated here too
           if (!isContextValid()) return;
           const badge = shadowRoot.getElementById('conn-badge');
            if (badge) {
              badge.className = 'status-badge error';
              badge.title = '';
              badge.innerText = 'Lỗi kết nối';
            }
            const connMst = shadowRoot.getElementById('conn-mst');
            if (connMst) connMst.style.display = 'none';
            return;
         }
        if (response) {
           handleTokenStatus(response);
        }
      });
    } catch (e) {
      // Silent catch for invalidated context
      if (e.message && e.message.includes('context invalidated')) return;
      console.error('[HoaDon] Send message failed:', e);
    }
  }

  function showPanel() {
    shadowRoot.querySelector('.sidebar').classList.remove('hidden');
    shadowRoot.getElementById('open-tab').style.display = 'none';
    const sideLoginAlert = shadowRoot.getElementById('side-login-alert');
    if (sideLoginAlert) sideLoginAlert.style.display = 'none';
    if (isContextValid()) {
      chrome.storage.local.set({ panelVisible: true });
    }
  }

  function hidePanel() {
    shadowRoot.querySelector('.sidebar').classList.add('hidden');
    shadowRoot.getElementById('open-tab').style.display = 'flex';
    const sideLoginAlert = shadowRoot.getElementById('side-login-alert');
    if (sideLoginAlert) sideLoginAlert.style.display = '';
    if (isContextValid()) {
      chrome.storage.local.set({ panelVisible: false });
    }
  }

  function isPanelVisible() {
    return !shadowRoot?.querySelector('.sidebar')?.classList.contains('hidden');
  }

  function updatePinButton() {
    const button = shadowRoot?.getElementById('pin-panel');
    if (!button) return;
    button.classList.toggle('pinned', isPanelPinned);
    button.setAttribute('aria-pressed', isPanelPinned ? 'true' : 'false');
    button.title = isPanelPinned
      ? 'Bỏ ghim và thu nhỏ panel'
      : 'Ghim panel để không tự thu khi bấm ra ngoài';
  }

  function setPanelPinned(value) {
    isPanelPinned = !!value;
    updatePinButton();
    if (isContextValid()) {
      chrome.storage.local.set({ panelPinned: isPanelPinned });
    }
  }

  function togglePanelPinned() {
    if (isPanelPinned) {
      setPanelPinned(false);
      hidePanel();
      return;
    }
    setPanelPinned(true);
  }

  function handleOutsidePointerDown(event) {
    if (!shadowRoot || isPanelPinned || !isPanelVisible()) return;
    if (panelContainer && event.composedPath?.().includes(panelContainer)) return;
    if (panelContainer && panelContainer.contains(event.target)) return;
    hidePanel();
  }

  function restoreState() {
    if (!isContextValid()) return;
    chrome.storage.local.get(['panelVisible', 'panelPinned'], (res) => {
      if (chrome.runtime.lastError || !isContextValid()) return;
      isPanelPinned = !!res.panelPinned;
      updatePinButton();
      if (isPanelPinned) showPanel();
      else if (res.panelVisible === false) hidePanel();
      else showPanel();
    });
  }

  function updateStatus(text, type = 'info') {
    const log = shadowRoot.getElementById('status-log');
    if (!log) return;
    currentStatusText = String(text || '');
    
    // Safety: use textContent instead of innerHTML to prevent XSS
    const div = document.createElement('div');
    div.textContent = text;
    let safeText = div.innerHTML;

    let dotColor = '#1a73e8';
    let extraLine = '';
    let pulseClass = '';
    
    if (type === 'error') {
       dotColor = '#ef4444';
    } else if (text.includes('Hoàn thành') || text.includes('sẵn sàng')) {
       dotColor = '#22c55e';
    } else {
       pulseClass = 'animation: pulse 2s infinite;';
    }

    if (text.includes('%')) {
       extraLine = `<div style="display:flex;align-items:center;gap:8px;opacity:0.6;font-style:italic;font-size:11px;margin-top:2px;">
                      <div style="width:6px;height:6px;background:#22c55e;border-radius:50%;"></div>
                      <span>Hệ thống đang trích xuất dữ liệu.</span>
                    </div>`;
    }

    safeText = safeText.replace(/(\[\d+%\])/g, '<b>$1</b>');

    log.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:500;color:#334155;">
        <div style="width:6px;height:6px;background:${dotColor};border-radius:50%;box-shadow:0 0 5px ${dotColor}80;flex-shrink:0;${pulseClass}"></div>
        <span>${safeText}</span>
      </div>
      ${extraLine}
    `;
    
    // Clear any previous inline color set by older versions
    log.style.color = '';
  }

  function isLoginStatusText(text) {
    const normalized = String(text || '').toLowerCase();
    return normalized.includes('đăng nhập')
      || normalized.includes('dang nhap')
      || normalized.includes('chờ đăng nhập')
      || normalized.includes('cho dang nhap')
      || normalized.includes('chưa kết nối')
      || normalized.includes('chua ket noi')
      || normalized.includes('lỗi kết nối')
      || normalized.includes('loi ket noi');
  }

  function updateClearFormatsButton() {
    const button = shadowRoot.getElementById('btn-clear-formats');
    if (!button) return;
    const hasSelected = shadowRoot.querySelectorAll('.format-chk:checked').length > 0;
    button.style.display = hasSelected ? 'inline-flex' : 'none';
  }

  function clearFormats() {
    shadowRoot.querySelectorAll('.format-chk').forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateClearFormatsButton();
  }

  function setDownloadButtonState() {
    const button = shadowRoot.getElementById('btn-download');
    if (!button) return;
    button.disabled = isStopping;
    button.classList.toggle('stop', isProcessing && !isStopping);
    button.textContent = isStopping
      ? 'ĐANG TẠM DỪNG...'
      : isProcessing
        ? 'TẠM DỪNG'
        : 'BẮT ĐẦU TẢI DỮ LIỆU';
  }

  function resetProcessingState(message, type = 'info') {
    isProcessing = false;
    isStopping = false;
    isAttachedWorkflow = false;
    toggleInputs(true);
    setResumeButtonsDisabled(false);
    setDownloadButtonState();
    if (message) updateStatus(message, type);
  }

  function stopWork() {
    if (!isProcessing || isStopping) return;
    isStopping = true;
    setDownloadButtonState();
    updateStatus('Đang tạm dừng tải...');
    try {
      chrome.runtime.sendMessage({ type: 'STOP_DOWNLOAD' });
    } catch (e) {
      resetProcessingState('Đã tạm dừng tải.', 'error');
      shadowRoot.getElementById('prog-container').style.display = 'none';
    }
  }

  function updateResumeCard(session) {
    if (session?.accountKey && currentAccountKey !== null && session.accountKey !== currentAccountKey) {
      session = null;
    }
    resumeSession = session || null;
    const card = shadowRoot.getElementById('resume-card');
    const text = shadowRoot.getElementById('resume-text');
    if (!card || !text) return;
    if (!resumeSession || resumeSession.pending <= 0 || isProcessing) {
      card.classList.remove('visible');
      return;
    }
    const params = resumeSession.params || {};
    const fromDate = params.fromDate || '';
    const toDate = params.toDate || '';
    const range = fromDate && toDate ? ` (${formatDateVn(fromDate)} - ${formatDateVn(toDate)})` : '';
    text.textContent = `Đã tải ${resumeSession.completed}/${resumeSession.total} hóa đơn${range}. Còn ${resumeSession.pending} hóa đơn.`;
    if (resumeSession.phase === 'list') {
      const loadedText = resumeSession.loadedInvoices ? `, \u0111\u00e3 th\u1ea5y ${resumeSession.loadedInvoices} h\u00f3a \u0111\u01a1n` : '';
      text.textContent = `\u0110\u00e3 qu\u00e9t ${resumeSession.completed}/${resumeSession.total} th\u00e1ng${range}${loadedText}. B\u1ea5m Ti\u1ebfp t\u1ee5c \u0111\u1ec3 qu\u00e9t ti\u1ebfp.`;
    }
    card.classList.add('visible');
  }

  function requestResumeSession() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'GET_RESUME_SESSION' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) return;
        const responseAccountKey = response.accountKey || response.session?.accountKey || '';
        if (responseAccountKey && currentAccountKey !== null && responseAccountKey !== currentAccountKey) return;
        updateResumeCard(response.session);
      });
    } catch (_) {}
  }

  function applyActiveDownloadState(active) {
    if (!active?.message) return;
    isProcessing = true;
    isStopping = false;
    isAttachedWorkflow = !active.isOwner;
    hasStickyStatus = false;
    toggleInputs(false);
    setResumeButtonsDisabled(true);
    setDownloadButtonState();
    updateResumeCard(null);
    const progressContainer = shadowRoot.getElementById('prog-container');
    if (progressContainer) progressContainer.style.display = 'block';
    handleBackgroundMessage(active.message);
  }

  function requestActiveDownloadState() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_DOWNLOAD_STATE' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok || !response.active) return;
        applyActiveDownloadState(response.active);
      });
    } catch (_) {}
  }

  function setResumeButtonsDisabled(disabled) {
    ['btn-resume-download'].forEach((id) => {
      const button = shadowRoot.getElementById(id);
      if (button) button.disabled = !!disabled;
    });
  }

  function resumeWork() {
    if (isProcessing || !resumeSession) return;
    if (!isContextValid()) {
      updateStatus('Extension đã được cập nhật. Vui lòng tải lại trang (F5).', 'error');
      return;
    }

    isProcessing = true;
    isStopping = false;
    isAttachedWorkflow = false;
    hasStickyStatus = false;
    toggleInputs(false);
    setResumeButtonsDisabled(true);
    setDownloadButtonState();
    updateStatus('Đang tiếp tục phiên tải...');
    shadowRoot.getElementById('prog-container').style.display = 'block';
    updateResumeCard(null);

    try {
      chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOAD' });
    } catch (e) {
      resetProcessingState();
      shadowRoot.getElementById('prog-container').style.display = 'none';
      updateStatus('Extension đã được cập nhật. Vui lòng tải lại trang (F5).', 'error');
    }
  }

  function startWork(mode) {
    if (isProcessing) return;

    const fromDate = shadowRoot.getElementById('date-from').value;
    const toDate = shadowRoot.getElementById('date-to').value;
    
    if (!fromDate || !toDate) {
      updateStatus('Vui lòng chọn ngày!', 'error');
      return;
    }

    const formats = Array.from(shadowRoot.querySelectorAll('.format-chk:checked')).map(cb => cb.value);

    if (formats.length === 0) {
      updateStatus('Vui lòng chọn ít nhất một định dạng!', 'error');
      return;
    }

    const selectedTypes = Array.from(shadowRoot.querySelectorAll('.inv-type-chk:checked')).map(cb => cb.value);
    if (selectedTypes.length === 0) {
      updateStatus('Vui lòng chọn ít nhất một loại hoá đơn!', 'error');
      return;
    }

    pendingInvoiceTypes = [];
    currentInvoiceType = selectedTypes[0];
    const params = {
      mode: mode,
      invoiceType: selectedTypes[0],
      invoiceTypes: selectedTypes,
      formats: formats,
      isAdjustment: shadowRoot.getElementById('chk-adjustment').checked,
      fromDate: fromDate,
      toDate: toDate
    };
    startParams = params;

    if (!isContextValid()) {
      updateStatus('Extension đã được cập nhật. Vui lòng tải lại trang (F5).', 'error');
      return;
    }

    isProcessing = true;
    isStopping = false;
    isAttachedWorkflow = false;
    hasStickyStatus = false;
    toggleInputs(false);
    setDownloadButtonState();
    updateResumeCard(null);
    updateStatus('Đang khởi động...');

    shadowRoot.getElementById('prog-container').style.display = 'block';

    try {
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', params: params });
    } catch (e) {
      startParams = null;
      resetProcessingState();
      shadowRoot.getElementById('prog-container').style.display = 'none';
      updateStatus('Extension đã được cập nhật. Vui lòng tải lại trang (F5).', 'error');
    }
  }

  function toggleInputs(enabled) {
    const selectors = [
      '.segments-container input',
      '.date-picker',
      '.mini-btn',
      '.inv-type-chk',
      '#chk-adjustment',
      '.format-chk',
      '#btn-clear-formats'
    ];
    selectors.forEach(selector => {
      shadowRoot.querySelectorAll(selector).forEach(control => {
        control.disabled = !enabled;
      });
    });
    updateClearFormatsButton();
    setDownloadButtonState();
  }

  function renderConnectedBadge(badge, msg) {
    if (!badge) return;
    const mst = String(msg.mst || '').trim();
    const companyName = String(msg.companyName || '').replace(/\s+/g, ' ').trim();
    const mainText = mst || 'ĐÃ KẾT NỐI';
    badge.textContent = '';
    badge.title = companyName && mst
      ? `${companyName} - MST ${mst}`
      : (companyName || mainText);

    const textWrap = document.createElement('span');
    textWrap.className = 'status-badge-text';

    const mstEl = document.createElement('span');
    mstEl.className = 'status-badge-mst';
    mstEl.textContent = mainText;
    textWrap.appendChild(mstEl);

    if (companyName) {
      const companyEl = document.createElement('span');
      companyEl.className = 'status-badge-company';
      companyEl.textContent = companyName;
      textWrap.appendChild(companyEl);
    }

    badge.appendChild(textWrap);
  }

  // Messenger logic
  function handleTokenStatus(msg) {
      const badge = shadowRoot.getElementById('conn-badge');
      const connMst = shadowRoot.getElementById('conn-mst');
      const connMstValue = shadowRoot.getElementById('conn-mst-value');
      const sideDot = shadowRoot.getElementById('side-status-dot');
      const quickLoginSide = shadowRoot.getElementById('quick-login-side');
      const sideLoginAlert = shadowRoot.getElementById('side-login-alert');
      const appLayout = shadowRoot.getElementById('app-layout');
      const loginBtn = shadowRoot.getElementById('btn-login-smart');
      const loginHint = shadowRoot.getElementById('login-hint');
      const previousAccountKey = currentAccountKey;
      const nextAccountKey = msg.ok ? (msg.accountKey || '') : '';
      const accountStateKnown = previousAccountKey !== null;
      const accountChanged = accountStateKnown && previousAccountKey !== nextAccountKey;
      currentAccountKey = nextAccountKey;

      const connCard = shadowRoot.querySelector('.connection-card');
      if (msg.ok) {
        if (accountChanged) updateResumeCard(null);
        if (badge) {
          badge.className = 'status-badge connected';
          renderConnectedBadge(badge, msg);
        }
        if (connCard) connCard.classList.add('connected');
        if (connMst) connMst.style.display = 'none';
        if (connMstValue) connMstValue.textContent = '';
        if (sideDot) {
          sideDot.className = 'status-dot online';
        }
        if (quickLoginSide) quickLoginSide.style.display = 'none';
        if (sideLoginAlert) sideLoginAlert.classList.remove('visible');
        if (loginBtn) loginBtn.style.display = 'none';
        if (loginHint) loginHint.style.display = 'none';
        if (appLayout) {
          appLayout.style.opacity = '1';
          appLayout.style.pointerEvents = 'auto';
        }
        if (loginRetryTimer) { clearTimeout(loginRetryTimer); loginRetryTimer = null; }
        if (!isProcessing && (!hasStickyStatus || isLoginStatusText(currentStatusText))) {
          if (isLoginStatusText(currentStatusText)) hasStickyStatus = false;
          updateStatus('Hệ thống sẵn sàng.');
        }
        if (!isProcessing && (!accountStateKnown || accountChanged)) {
          requestResumeSession();
        }
      } else {
        if (accountChanged || resumeSession) updateResumeCard(null);
        if (recoverSessionErrorPage(false)) return;
        if (badge) {
          badge.className = 'status-badge error';
          badge.title = '';
          badge.innerText = 'CHƯA KẾT NỐI';
        }
        if (connCard) connCard.classList.remove('connected');
        if (sideDot) {
          sideDot.className = 'status-dot offline';
        }
        if (quickLoginSide) quickLoginSide.style.display = 'flex';
        if (sideLoginAlert) sideLoginAlert.classList.add('visible');
        if (loginBtn) loginBtn.style.display = 'block';
        if (loginHint) loginHint.style.display = 'block';
        if (connMst) connMst.style.display = 'none';
        if (connMstValue) connMstValue.textContent = '';
        if (appLayout) {
          appLayout.style.opacity = '0.5';
          appLayout.style.pointerEvents = 'none';
        }
        if (isProcessing) stopWork();
        updateStatus('Chờ đăng nhập...', 'error');
        if (!loginRetryTimer) {
          loginRetryTimer = setTimeout(() => { loginRetryTimer = null; checkConnection(); }, 1200);
        }
      }
    }

    function handleBackgroundMessage(msg) {
      if (msg.type === 'TOKEN_STATUS') {
        handleTokenStatus(msg);
      }

      if (msg.type === 'FORM_STATE_SYNC') {
        if (msg.state?.sourceClientId !== formClientId) {
          applyFormState(msg.state);
        }
      }

      if (msg.type === 'ACTIVE_DOWNLOAD_STATE') {
        applyActiveDownloadState(msg.active);
      }

      if (msg.type === 'PROGRESS') {
        if (isStopping) return;
        if (!isProcessing) {
          isProcessing = true;
          isAttachedWorkflow = true;
          hasStickyStatus = false;
          toggleInputs(false);
          setResumeButtonsDisabled(true);
          setDownloadButtonState();
          updateResumeCard(null);
          const progressContainer = shadowRoot.getElementById('prog-container');
          if (progressContainer) progressContainer.style.display = 'block';
        }
        const bar = shadowRoot.getElementById('prog-bar');
        const roundedPercent = Math.round(msg.percent);
        if (bar) bar.style.width = roundedPercent + '%';
        updateStatus(`[${roundedPercent}%] ${msg.message}`);
      }

      if (msg.type === 'RESUME_SESSION') {
        const messageAccountKey = msg.accountKey || msg.session?.accountKey || '';
        if (messageAccountKey && currentAccountKey !== null && messageAccountKey !== currentAccountKey) return;
        updateResumeCard(msg.session);
      }

      if (msg.type === 'DONE') {
        const nextType = pendingInvoiceTypes.shift();
        if (nextType) {
          updateStatus(`Xong loại trước. Đang bắt đầu tải ${nextType === 'sold' ? 'bán ra' : 'mua vào'}...`);
          currentInvoiceType = nextType;
          const bar = shadowRoot.getElementById('prog-bar');
          if (bar) bar.style.width = '0%';
          const params = { ...startParams, invoiceType: nextType };
          try {
            chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', params });
          } catch (e) {
            startParams = null;
            resetProcessingState('Extension lỗi. Vui lòng tải lại trang.', 'error');
          }
          return;
        }
        resetProcessingState();
        startParams = null;
        hasStickyStatus = true;
        updateResumeCard(null);
        const bar = shadowRoot.getElementById('prog-bar');
        if (bar) bar.style.width = '100%';
        updateStatus(`Hoàn thành! Đã tải ${msg.count} hoá đơn thành công.`);
        setTimeout(() => {
          if (!isProcessing) {
            shadowRoot.getElementById('prog-container').style.display = 'none';
          }
        }, 2000);
      }

      if (msg.type === 'NOTIFY') {
        const nextType = pendingInvoiceTypes.shift();
        if (nextType) {
          const prevLabel = currentInvoiceType === 'sold' ? 'bán ra' : 'mua vào';
          const nextLabel = nextType === 'sold' ? 'bán ra' : 'mua vào';
          updateStatus(`Không có hóa đơn ${prevLabel} trong thời gian này. Đang bắt đầu tải ${nextLabel}...`);
          currentInvoiceType = nextType;
          const bar = shadowRoot.getElementById('prog-bar');
          if (bar) bar.style.width = '0%';
          const params = { ...startParams, invoiceType: nextType };
          try {
            chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', params });
          } catch (e) {
            startParams = null;
            resetProcessingState('Extension lỗi. Vui lòng tải lại trang.', 'error');
          }
          return;
        }
        resetProcessingState();
        startParams = null;
        hasStickyStatus = true;
        updateResumeCard(null);
        updateStatus(msg.message);
        setTimeout(() => {
          if (!isProcessing) {
            shadowRoot.getElementById('prog-container').style.display = 'none';
          }
        }, 2000);
      }

      if (msg.type === 'ERROR') {
        pendingInvoiceTypes = [];
        currentInvoiceType = '';
        resetProcessingState();
        startParams = null;
        hasStickyStatus = true;
        updateStatus('Lỗi: ' + msg.message, 'error');
        shadowRoot.getElementById('prog-container').style.display = 'none';
        setTimeout(requestResumeSession, 100);
      }

      if (msg.type === 'STOPPED') {
        pendingInvoiceTypes = [];
        currentInvoiceType = '';
        startParams = null;
        resetProcessingState('Đã tạm dừng tải. Bấm nút tiếp tục để tải tiếp.');
        hasStickyStatus = true;
        shadowRoot.getElementById('prog-container').style.display = 'none';
        setTimeout(requestResumeSession, 100);
      }
    }

    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  init();
})();
