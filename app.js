/* =========================================================================
   EchoCipher - shared application layer
   Handles: session/auth guard, persisted data store, sidebar + header shell,
   dropdowns, global search, toasts, modals and the mock detection engine.
   ========================================================================= */

(function (global) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* Storage helpers                                                     */
    /* ------------------------------------------------------------------ */

    const KEYS = {
        session: 'echocipher.session',
        analyses: 'echocipher.analyses',
        settings: 'echocipher.settings',
        notifications: 'echocipher.notifications'
    };

    function read(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            console.warn('[EchoCipher] could not read', key, err);
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            console.warn('[EchoCipher] could not write', key, err);
        }
    }

    const DEFAULT_SETTINGS = {
        displayName: 'Admin User',
        email: 'admin@echocipher.io',
        organisation: 'Team Vision VI',
        threshold: 0.83,
        confidenceAlert: 90,
        autoAnalyze: true,
        soundAlerts: false,
        emailAlerts: true,
        retentionDays: 30,
        modelId: 'voice-clone-detector-v1'
    };

    /* ------------------------------------------------------------------ */
    /* Store                                                               */
    /* ------------------------------------------------------------------ */

    const Store = {
        /* --- session --- */
        getSession() {
            return read(KEYS.session, null);
        },
        setSession(session) {
            write(KEYS.session, session);
        },
        clearSession() {
            localStorage.removeItem(KEYS.session);
        },

        /* --- settings --- */
        getSettings() {
            return Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {}));
        },
        saveSettings(patch) {
            const next = Object.assign(this.getSettings(), patch);
            write(KEYS.settings, next);
            return next;
        },
        resetSettings() {
            localStorage.removeItem(KEYS.settings);
            return this.getSettings();
        },

        /* --- analyses --- */
        getAnalyses() {
            const list = read(KEYS.analyses, []);
            return Array.isArray(list) ? list : [];
        },
        addAnalysis(record) {
            const list = this.getAnalyses();
            list.unshift(record);
            write(KEYS.analyses, list.slice(0, 500));
            return record;
        },
        deleteAnalysis(id) {
            write(KEYS.analyses, this.getAnalyses().filter(a => a.id !== id));
        },
        clearAnalyses() {
            write(KEYS.analyses, []);
        },
        /** Drops records older than the configured retention window. */
        pruneExpired() {
            const days = Number(this.getSettings().retentionDays);
            if (!days) return 0;                       // 0 == keep forever
            const cutoff = Date.now() - days * 86400000;
            const all = this.getAnalyses();
            const kept = all.filter(a => new Date(a.createdAt).getTime() >= cutoff);
            if (kept.length !== all.length) write(KEYS.analyses, kept);
            return all.length - kept.length;
        },

        /* --- notifications --- */
        getNotifications() {
            return read(KEYS.notifications, []);
        },
        addNotification(note) {
            const list = this.getNotifications();
            list.unshift(Object.assign({
                id: 'n_' + Date.now().toString(36),
                createdAt: new Date().toISOString(),
                read: false
            }, note));
            write(KEYS.notifications, list.slice(0, 50));
        },
        markNotificationsRead() {
            write(KEYS.notifications, this.getNotifications().map(n =>
                Object.assign({}, n, { read: true })));
        },
        clearNotifications() {
            write(KEYS.notifications, []);
        },
        unreadCount() {
            return this.getNotifications().filter(n => !n.read).length;
        },

        /* --- derived stats --- */
        stats() {
            const all = this.getAnalyses();
            const ai = all.filter(a => a.verdict === 'ai');
            const real = all.filter(a => a.verdict === 'real');
            const avgConfidence = all.length
                ? all.reduce((sum, a) => sum + a.confidence, 0) / all.length
                : 0;

            // Compare the most recent 30 days against the 30 before that.
            const now = Date.now();
            const day = 86400000;
            const inWindow = (a, from, to) => {
                const t = new Date(a.createdAt).getTime();
                return t > now - to * day && t <= now - from * day;
            };
            const current = all.filter(a => inWindow(a, 0, 30)).length;
            const previous = all.filter(a => inWindow(a, 30, 60)).length;
            const trend = previous === 0
                ? (current > 0 ? 100 : 0)
                : Math.round(((current - previous) / previous) * 100);

            return {
                total: all.length,
                ai: ai.length,
                real: real.length,
                avgConfidence,
                aiRate: all.length ? (ai.length / all.length) * 100 : 0,
                trend
            };
        },

        /* Counts per day for the last `days` days, oldest first. */
        dailySeries(days) {
            const all = this.getAnalyses();
            const out = [];
            for (let i = days - 1; i >= 0; i--) {
                const start = new Date();
                start.setHours(0, 0, 0, 0);
                start.setDate(start.getDate() - i);
                const end = new Date(start);
                end.setDate(end.getDate() + 1);

                const slice = all.filter(a => {
                    const t = new Date(a.createdAt).getTime();
                    return t >= start.getTime() && t < end.getTime();
                });

                out.push({
                    date: start,
                    label: start.toLocaleDateString(undefined, { weekday: 'short' }),
                    shortLabel: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    real: slice.filter(a => a.verdict === 'real').length,
                    ai: slice.filter(a => a.verdict === 'ai').length
                });
            }
            return out;
        }
    };

    /* ------------------------------------------------------------------ */
    /* Mock detection engine                                               */
    /* ------------------------------------------------------------------ */
    /* Derives a stable pseudo-score from the file's name + size so the same
       file always produces the same verdict. Swap `analyzeFile` for a real
       fetch() to the backend when the API is ready — nothing else changes. */

    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967295;
    }

    const Detector = {
        /** @returns {Promise<object>} analysis record (not yet persisted) */
        analyzeFile(file, meta) {
            const settings = Store.getSettings();
            const threshold = settings.threshold;
            const seed = hashString(file.name + ':' + file.size);
            const score = +(seed * 1.9).toFixed(2);
            const verdict = score >= threshold ? 'ai' : 'real';

            // Confidence grows with distance from the decision threshold.
            const distance = Math.min(Math.abs(score - threshold) / threshold, 1);
            const confidence = +(72 + distance * 27).toFixed(1);

            const record = {
                id: 'a_' + Date.now().toString(36) + Math.floor(seed * 1000),
                filename: file.name,
                size: file.size,
                durationSec: (meta && meta.durationSec) || 0,
                verdict: verdict,
                confidence: confidence,
                score: score,
                threshold: threshold,
                model: settings.modelId,
                createdAt: new Date().toISOString()
            };

            // Simulated inference latency; replace with the real API call.
            return new Promise(resolve => setTimeout(() => resolve(record), 1400));
        },

        /** Persist a record and raise a notification when it warrants one. */
        commit(record) {
            Store.addAnalysis(record);
            const settings = Store.getSettings();
            if (record.verdict === 'ai' && record.confidence >= settings.confidenceAlert) {
                Store.addNotification({
                    type: 'alert',
                    title: 'AI-generated voice detected',
                    body: record.filename + ' — ' + record.confidence.toFixed(1) + '% confidence'
                });
            }
            return record;
        }
    };

    /* ------------------------------------------------------------------ */
    /* Formatting helpers                                                  */
    /* ------------------------------------------------------------------ */

    const Fmt = {
        bytes(n) {
            if (!n) return '0 KB';
            if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
            return (n / (1024 * 1024)).toFixed(2) + ' MB';
        },
        duration(sec) {
            if (!sec || !isFinite(sec)) return '--:--';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        },
        dateTime(iso) {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
                ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        },
        relative(iso) {
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.round(diff / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return mins + ' min ago';
            const hours = Math.round(mins / 60);
            if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
            const days = Math.round(hours / 24);
            if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
            return new Date(iso).toLocaleDateString();
        },
        escape(str) {
            return String(str).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
        }
    };

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    const stroke = 'viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" ' +
        'stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"';

    const ICONS = {
        dashboard: `<svg ${stroke}><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
        mic: `<svg ${stroke}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
        activity: `<svg ${stroke}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
        chart: `<svg ${stroke}><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`,
        info: `<svg ${stroke}><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
        settings: `<svg ${stroke}><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
        bell: `<svg ${stroke}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`,
        search: `<svg ${stroke} width="18" height="18"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
        upload: `<svg ${stroke} width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
        logout: `<svg ${stroke} width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`,
        user: `<svg ${stroke} width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
        menu: `<svg ${stroke}><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`,
        close: `<svg ${stroke} width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        trash: `<svg ${stroke} width="16" height="16"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
        download: `<svg ${stroke} width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
        shield: `<svg ${stroke}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
        check: `<svg ${stroke}><polyline points="20 6 9 17 4 12"></polyline></svg>`,
        checkCircle: `<svg ${stroke}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`,
        play: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
        pause: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
        music: `<svg ${stroke} width="24" height="24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`
    };

    /* ------------------------------------------------------------------ */
    /* Navigation definition                                               */
    /* ------------------------------------------------------------------ */

    const NAV = [
        { id: 'dashboard', label: 'Dashboard', href: 'dashboard.html', icon: ICONS.dashboard },
        { id: 'voice-detection', label: 'Voice Detection', href: 'voice-detection.html', icon: ICONS.mic },
        { id: 'history', label: 'Detection History', href: 'history.html', icon: ICONS.activity },
        { id: 'analytics', label: 'Analytics', href: 'analytics.html', icon: ICONS.chart },
        { id: 'model-info', label: 'Model Information', href: 'model-info.html', icon: ICONS.info },
        { id: 'settings', label: 'Settings', href: 'settings.html', icon: ICONS.settings }
    ];

    /* ------------------------------------------------------------------ */
    /* Toasts                                                              */
    /* ------------------------------------------------------------------ */

    function toast(message, type) {
        let host = document.querySelector('.toast-host');
        if (!host) {
            host = document.createElement('div');
            host.className = 'toast-host';
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => {
            el.classList.add('leaving');
            setTimeout(() => el.remove(), 250);
        }, 2800);
    }

    /* ------------------------------------------------------------------ */
    /* Modal                                                               */
    /* ------------------------------------------------------------------ */

    function modal(opts) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-label="${Fmt.escape(opts.title)}">
                <div class="modal-header">
                    <h3>${Fmt.escape(opts.title)}</h3>
                    <button class="btn-icon" data-close aria-label="Close">${ICONS.close}</button>
                </div>
                <div class="modal-body">${opts.body || ''}</div>
                <div class="modal-footer">
                    ${opts.cancelText === null ? '' :
                      `<button class="btn-secondary" data-close>${Fmt.escape(opts.cancelText || 'Cancel')}</button>`}
                    ${opts.confirmText ?
                      `<button class="btn-primary ${opts.danger ? 'danger' : ''}" data-confirm>${Fmt.escape(opts.confirmText)}</button>` : ''}
                </div>
            </div>`;

        function close() {
            overlay.classList.remove('open');
            setTimeout(() => overlay.remove(), 180);
            document.removeEventListener('keydown', onKey);
        }
        function onKey(e) { if (e.key === 'Escape') close(); }

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) close();
            if (e.target.closest('[data-confirm]')) {
                if (!opts.onConfirm || opts.onConfirm(overlay) !== false) close();
            }
        });
        document.addEventListener('keydown', onKey);

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('open'));

        const focusable = overlay.querySelector('input, textarea, select, [data-confirm]');
        if (focusable) focusable.focus();
        return { close: close, root: overlay };
    }

    /* ------------------------------------------------------------------ */
    /* Shell rendering                                                     */
    /* ------------------------------------------------------------------ */

    function sidebarMarkup(activeId) {
        const items = NAV.map(item => `
            <a href="${item.href}" class="nav-item${item.id === activeId ? ' active' : ''}"
               ${item.id === activeId ? 'aria-current="page"' : ''}>
                ${item.icon}${item.label}
            </a>`).join('');

        return `
            <div class="sidebar-header">
                <svg class="logo-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="16" r="15" fill="#F8FAFC" stroke="#D3E1F8" stroke-width="1"/>
                    <path d="M 3 16 A 13 13 0 0 1 29 16 Z" fill="#1C2852"/>
                    <path d="M 3 16 A 13 13 0 0 0 29 16 Z" fill="#00A78E"/>
                    <g stroke="white" stroke-width="2.2" stroke-linecap="round">
                        <line x1="8.5" y1="13.5" x2="8.5" y2="18.5"/><line x1="11" y1="11" x2="11" y2="21"/>
                        <line x1="13.5" y1="9" x2="13.5" y2="23"/><line x1="16" y1="7" x2="16" y2="25"/>
                        <line x1="18.5" y1="9" x2="18.5" y2="23"/><line x1="21" y1="11" x2="21" y2="21"/>
                        <line x1="23.5" y1="13.5" x2="23.5" y2="18.5"/>
                    </g>
                </svg>
                <span class="brand-name">EchoCipher</span>
                <button class="sidebar-close btn-icon" id="sidebarClose" aria-label="Close menu">${ICONS.close}</button>
            </div>
            <nav class="sidebar-nav">${items}</nav>
            <div class="team-badge">
                <div class="dev-icon">
                    <svg viewBox="0 0 24 24" width="24" height="24" stroke="#F7941D" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>
                    </svg>
                </div>
                <div class="team-info">
                    <span class="team-name">Team Vision VI</span>
                    <span class="team-event">SIH 2026</span>
                </div>
            </div>`;
    }

    function headerMarkup() {
        const settings = Store.getSettings();
        const avatar = 'https://ui-avatars.com/api/?name=' +
            encodeURIComponent(settings.displayName) + '&background=1B3A6B&color=fff';

        return `
            <button class="btn-icon menu-toggle" id="menuToggle" aria-label="Open menu">${ICONS.menu}</button>
            <form class="search-bar" id="globalSearchForm" role="search">
                ${ICONS.search}
                <input type="text" id="globalSearch" name="q" autocomplete="off"
                       placeholder="Search callers, IDs, or timestamps...">
            </form>
            <div class="user-profile">
                <div class="dropdown" id="notificationDropdown">
                    <button class="btn-notification" id="notificationBtn" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
                        ${ICONS.bell}
                        <span class="badge" id="notificationBadge" hidden>0</span>
                    </button>
                    <div class="dropdown-menu dropdown-menu-wide" id="notificationMenu" role="menu">
                        <div class="dropdown-header">
                            <span>Notifications</span>
                            <button class="link-btn" id="clearNotifications">Clear all</button>
                        </div>
                        <div class="dropdown-list" id="notificationList"></div>
                    </div>
                </div>
                <div class="dropdown" id="profileDropdown">
                    <button class="avatar-btn" id="profileBtn" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">
                        <span class="avatar"><img src="${avatar}" alt=""></span>
                        <span class="avatar-name">
                            <strong id="profileName">${Fmt.escape(settings.displayName)}</strong>
                            <small id="profileOrg">${Fmt.escape(settings.organisation)}</small>
                        </span>
                    </button>
                    <div class="dropdown-menu" id="profileMenu" role="menu">
                        <a class="dropdown-item" href="settings.html">${ICONS.user} Profile &amp; account</a>
                        <a class="dropdown-item" href="settings.html#preferences">${ICONS.settings} Preferences</a>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item danger" id="logoutBtn">${ICONS.logout} Log out</button>
                    </div>
                </div>
            </div>`;
    }

    function renderNotifications() {
        const list = document.getElementById('notificationList');
        const badge = document.getElementById('notificationBadge');
        if (!list) return;

        const notes = Store.getNotifications();
        const unread = Store.unreadCount();

        if (badge) {
            badge.hidden = unread === 0;
            badge.textContent = unread > 9 ? '9+' : String(unread);
        }

        if (!notes.length) {
            list.innerHTML = '<div class="dropdown-empty">You are all caught up.</div>';
            return;
        }

        list.innerHTML = notes.map(n => `
            <div class="dropdown-note${n.read ? '' : ' unread'}">
                <span class="note-dot ${n.type === 'alert' ? 'red' : 'green'}"></span>
                <div>
                    <strong>${Fmt.escape(n.title)}</strong>
                    <p>${Fmt.escape(n.body || '')}</p>
                    <small>${Fmt.relative(n.createdAt)}</small>
                </div>
            </div>`).join('');
    }

    function wireShell() {
        /* --- dropdowns --- */
        function closeAllDropdowns(except) {
            document.querySelectorAll('.dropdown.open').forEach(d => {
                if (d !== except) {
                    d.classList.remove('open');
                    const trigger = d.querySelector('[aria-haspopup]');
                    if (trigger) trigger.setAttribute('aria-expanded', 'false');
                }
            });
        }

        document.querySelectorAll('.dropdown').forEach(drop => {
            const trigger = drop.querySelector('[aria-haspopup]');
            if (!trigger) return;
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const willOpen = !drop.classList.contains('open');
                closeAllDropdowns(drop);
                drop.classList.toggle('open', willOpen);
                trigger.setAttribute('aria-expanded', String(willOpen));
                if (willOpen && drop.id === 'notificationDropdown') {
                    Store.markNotificationsRead();
                    renderNotifications();
                }
            });
        });

        document.addEventListener('click', () => closeAllDropdowns(null));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllDropdowns(null);
            // "/" focuses global search, like most dashboards.
            const active = document.activeElement;
            if (e.key === '/' && !(active && /^(INPUT|TEXTAREA)$/.test(active.tagName))) {
                e.preventDefault();
                const search = document.getElementById('globalSearch');
                if (search) search.focus();
            }
        });

        // Scrolling or clicking inside the notification list should not dismiss it.
        const noteList = document.getElementById('notificationList');
        if (noteList) noteList.addEventListener('click', (e) => e.stopPropagation());

        const clearBtn = document.getElementById('clearNotifications');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                Store.clearNotifications();
                renderNotifications();
            });
        }

        /* --- global search: sends the query to the history page --- */
        const searchForm = document.getElementById('globalSearchForm');
        if (searchForm) {
            searchForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = document.getElementById('globalSearch').value.trim();
                if (!q) return;
                window.location.href = 'history.html?q=' + encodeURIComponent(q);
            });
        }

        /* --- logout --- */
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                modal({
                    title: 'Log out',
                    body: '<p>You will need to sign in again to reach the dashboard. Your saved analyses stay on this device.</p>',
                    confirmText: 'Log out',
                    danger: true,
                    onConfirm: () => {
                        Store.clearSession();
                        window.location.href = 'index.html';
                    }
                });
            });
        }

        /* --- mobile sidebar --- */
        const menuToggle = document.getElementById('menuToggle');
        const sidebar = document.querySelector('.sidebar');
        const scrim = document.getElementById('sidebarScrim');
        const openSidebar = (open) => {
            if (sidebar) sidebar.classList.toggle('open', open);
            if (scrim) scrim.classList.toggle('visible', open);
        };
        if (menuToggle) menuToggle.addEventListener('click', () => openSidebar(true));
        const sidebarClose = document.getElementById('sidebarClose');
        if (sidebarClose) sidebarClose.addEventListener('click', () => openSidebar(false));
        if (scrim) scrim.addEventListener('click', () => openSidebar(false));

        renderNotifications();
    }

    /* ------------------------------------------------------------------ */
    /* Boot                                                                */
    /* ------------------------------------------------------------------ */

    function boot() {
        const body = document.body;
        const pageId = body.dataset.page;
        if (!pageId) return;                      // not an app page (login)

        // Auth guard — every app page requires a session.
        if (!Store.getSession()) {
            window.location.replace('index.html?next=' + encodeURIComponent(location.pathname.split('/').pop()));
            return;
        }

        Store.pruneExpired();

        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.innerHTML = sidebarMarkup(pageId);

        const header = document.querySelector('.top-header');
        if (header) header.innerHTML = headerMarkup();

        if (!document.getElementById('sidebarScrim')) {
            const scrim = document.createElement('div');
            scrim.id = 'sidebarScrim';
            scrim.className = 'sidebar-scrim';
            body.appendChild(scrim);
        }

        wireShell();
        document.dispatchEvent(new CustomEvent('echocipher:ready', { detail: { page: pageId } }));
    }

    /* ------------------------------------------------------------------ */

    global.EchoCipher = {
        Store: Store,
        Detector: Detector,
        Fmt: Fmt,
        ICONS: ICONS,
        NAV: NAV,
        toast: toast,
        modal: modal,
        renderNotifications: renderNotifications
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
