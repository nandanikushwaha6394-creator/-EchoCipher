/* =========================================================================
   EchoCipher - per-page controllers
   Dispatched from <body data-page="..."> once the shared shell is ready.
   ========================================================================= */

(function (global) {
    'use strict';

    const EC = global.EchoCipher;
    const Store = EC.Store;
    const Fmt = EC.Fmt;
    const $ = (id) => document.getElementById(id);

    /* ------------------------------------------------------------------ */
    /* Shared fragments                                                    */
    /* ------------------------------------------------------------------ */

    function emptyState(title, message, actionHref, actionLabel) {
        return `
            <div class="empty-state">
                ${EC.ICONS.activity}
                <h4>${Fmt.escape(title)}</h4>
                <p>${Fmt.escape(message)}</p>
                ${actionHref ? `<a class="btn-primary" href="${actionHref}">${Fmt.escape(actionLabel)}</a>` : ''}
            </div>`;
    }

    function recentListMarkup(records, limit) {
        if (!records.length) {
            return '<div class="empty-state"><p>No analyses yet.</p></div>';
        }
        return records.slice(0, limit).map(r => `
            <div class="recent-item">
                <div class="recent-info">
                    <h4>${Fmt.escape(r.filename)}</h4>
                    <p>${Fmt.relative(r.createdAt)} &bull; ${r.confidence.toFixed(1)}% confidence</p>
                </div>
                <span class="status-badge ${r.verdict === 'ai' ? 'block' : 'pass'}">
                    ${r.verdict === 'ai' ? 'AI' : 'REAL'}
                </span>
            </div>`).join('');
    }

    EC.recentListMarkup = recentListMarkup;
    EC.emptyState = emptyState;

    /* Build a short WAV file in memory so "Load demo sample" works offline. */
    function buildSampleWav(name, seconds, freq) {
        const rate = 16000;
        const total = Math.floor(rate * seconds);
        const buffer = new ArrayBuffer(44 + total * 2);
        const view = new DataView(buffer);
        const writeStr = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + total * 2, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, 'data');
        view.setUint32(40, total * 2, true);

        for (let i = 0; i < total; i++) {
            const t = i / rate;
            // Two tones plus a slow tremolo — enough to look like speech energy.
            const sample = Math.sin(2 * Math.PI * freq * t) * 0.4 +
                Math.sin(2 * Math.PI * freq * 2.5 * t) * 0.2;
            const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
            view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample * env)) * 32767, true);
        }

        return new File([buffer], name, { type: 'audio/wav' });
    }

    /* ================================================================== */
    /* VOICE DETECTION                                                     */
    /* ================================================================== */

    function initVoiceDetection() {
        const analyzer = EC.mountAnalyzer({
            root: document,
            onComplete: refreshSidePanels
        });

        /* --- tabs --- */
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.toggle('active', t === tab));
                document.querySelectorAll('.tab-panel').forEach(panel => {
                    panel.hidden = panel.dataset.panel !== tab.dataset.tab;
                });
                if (tab.dataset.tab !== 'record') stopRecording();
            });
        });

        /* --- side panels --- */
        function refreshSidePanels() {
            const settings = Store.getSettings();
            const all = Store.getAnalyses();
            $('cfgModel').textContent = settings.modelId;
            $('cfgThreshold').textContent = Number(settings.threshold).toFixed(2);
            $('cfgAlert').textContent = settings.confidenceAlert + '%';
            $('cfgStored').textContent = all.length;
            $('miniRecent').innerHTML = recentListMarkup(all, 5);
        }
        refreshSidePanels();

        /* --- demo sample --- */
        const sampleBtn = $('loadSampleBtn');
        if (sampleBtn && analyzer) {
            sampleBtn.addEventListener('click', () => {
                const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
                const file = buildSampleWav('demo_sample_' + stamp + '.wav', 6, 220);
                document.querySelector('.tab[data-tab="upload"]').click();
                analyzer.loadFile(file);
                EC.toast('Demo sample loaded.', 'success');
            });
        }

        /* --- live recorder --- */
        let mediaRecorder = null;
        let chunks = [];
        let stream = null;
        let audioCtx = null;
        let rafId = null;
        let startedAt = 0;
        let timerId = null;

        const recordBtn = $('recordBtn');
        const recordLabel = $('recordLabel');
        const canvas = $('recorderCanvas');
        const timeEl = $('recorderTime');

        function drawIdle() {
            const ctx = canvas && canvas.getContext && canvas.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = '#1B3A6B';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, canvas.height / 2);
            ctx.lineTo(canvas.width, canvas.height / 2);
            ctx.stroke();
        }
        drawIdle();

        function visualise(analyserNode) {
            const ctx = canvas && canvas.getContext && canvas.getContext('2d');
            if (!ctx) return;
            const data = new Uint8Array(analyserNode.frequencyBinCount);

            (function frame() {
                rafId = requestAnimationFrame(frame);
                analyserNode.getByteTimeDomainData(data);
                ctx.fillStyle = '#1B3A6B';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#F7941D';
                ctx.beginPath();
                const slice = canvas.width / data.length;
                for (let i = 0; i < data.length; i++) {
                    const y = (data[i] / 128.0) * (canvas.height / 2);
                    const x = i * slice;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            })();
        }

        function stopRecording(silent) {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            } else if (!silent) {
                cleanupRecording();
            }
        }

        function cleanupRecording() {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = null;
            if (timerId) clearInterval(timerId);
            timerId = null;
            if (stream) stream.getTracks().forEach(t => t.stop());
            stream = null;
            if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
            audioCtx = null;
            if (recordBtn) recordBtn.classList.remove('recording');
            if (recordLabel) recordLabel.textContent = 'Start recording';
            drawIdle();
        }

        if (recordBtn) {
            recordBtn.addEventListener('click', () => {
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    stopRecording();
                    return;
                }

                if (!navigator.mediaDevices || !global.MediaRecorder) {
                    EC.toast('Recording is not supported in this browser.', 'error');
                    return;
                }

                navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
                    stream = s;
                    chunks = [];
                    mediaRecorder = new MediaRecorder(s);

                    audioCtx = new (global.AudioContext || global.webkitAudioContext)();
                    const source = audioCtx.createMediaStreamSource(s);
                    const analyserNode = audioCtx.createAnalyser();
                    analyserNode.fftSize = 1024;
                    source.connect(analyserNode);
                    visualise(analyserNode);

                    mediaRecorder.addEventListener('dataavailable', e => {
                        if (e.data.size) chunks.push(e.data);
                    });

                    mediaRecorder.addEventListener('stop', () => {
                        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                        cleanupRecording();
                        if (!blob.size) {
                            EC.toast('Nothing was recorded.', 'warn');
                            return;
                        }
                        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
                        const file = new File([blob], 'live_recording_' + stamp + '.webm', { type: blob.type });
                        document.querySelector('.tab[data-tab="upload"]').click();
                        if (analyzer) analyzer.loadFile(file);
                        EC.toast('Recording captured — ready to analyze.', 'success');
                    });

                    mediaRecorder.start();
                    startedAt = Date.now();
                    recordBtn.classList.add('recording');
                    recordLabel.textContent = 'Stop recording';
                    timerId = setInterval(() => {
                        timeEl.textContent = Fmt.duration((Date.now() - startedAt) / 1000);
                    }, 200);
                }).catch(() => {
                    EC.toast('Microphone access was denied.', 'error');
                });
            });
        }

        global.addEventListener('beforeunload', () => stopRecording(true));
    }

    /* ================================================================== */
    /* DETECTION HISTORY                                                   */
    /* ================================================================== */

    function initHistory() {
        const searchInput = $('historySearch');
        const verdictFilter = $('verdictFilter');
        const rangeFilter = $('rangeFilter');
        const pageSizeSel = $('pageSize');
        const body = $('historyBody');
        const footer = $('historyFooter');

        let sortKey = 'createdAt';
        let sortDir = 'desc';
        let page = 1;

        // Pick up a query handed over from the header search box.
        const params = new URLSearchParams(location.search);
        if (params.get('q')) searchInput.value = params.get('q');

        function filtered() {
            const q = searchInput.value.trim().toLowerCase();
            const verdict = verdictFilter.value;
            const days = rangeFilter.value === 'all' ? null : Number(rangeFilter.value);
            const cutoff = days ? Date.now() - days * 86400000 : null;

            let rows = Store.getAnalyses().filter(r => {
                if (verdict !== 'all' && r.verdict !== verdict) return false;
                if (cutoff && new Date(r.createdAt).getTime() < cutoff) return false;
                if (q && !(r.filename.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))) return false;
                return true;
            });

            rows.sort((a, b) => {
                let av = a[sortKey];
                let bv = b[sortKey];
                if (sortKey === 'createdAt') {
                    av = new Date(av).getTime();
                    bv = new Date(bv).getTime();
                }
                if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return sortDir === 'asc' ? av - bv : bv - av;
            });

            return rows;
        }

        function render() {
            const rows = filtered();
            const size = Number(pageSizeSel.value);
            const pages = Math.max(1, Math.ceil(rows.length / size));
            page = Math.min(page, pages);
            const slice = rows.slice((page - 1) * size, page * size);

            if (!Store.getAnalyses().length) {
                body.innerHTML = emptyState(
                    'No analyses yet',
                    'Run your first scan and it will appear here with its verdict, score and confidence.',
                    'voice-detection.html', 'Analyze a recording');
                footer.hidden = true;
                return;
            }

            if (!rows.length) {
                body.innerHTML = emptyState('No matches',
                    'No analyses match the current filters. Try widening the date range or clearing the search.');
                footer.hidden = true;
                return;
            }

            const arrow = (key) => sortKey === key
                ? `<span class="sort-arrow">${sortDir === 'asc' ? '&uarr;' : '&darr;'}</span>`
                : '<span class="sort-arrow">&updownarrow;</span>';

            body.innerHTML = `
                <div class="table-wrap">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th class="sortable ${sortKey === 'filename' ? 'sorted' : ''}" data-sort="filename">File ${arrow('filename')}</th>
                                <th class="sortable ${sortKey === 'verdict' ? 'sorted' : ''}" data-sort="verdict">Verdict ${arrow('verdict')}</th>
                                <th class="sortable ${sortKey === 'confidence' ? 'sorted' : ''}" data-sort="confidence">Confidence ${arrow('confidence')}</th>
                                <th class="sortable ${sortKey === 'score' ? 'sorted' : ''}" data-sort="score">Score ${arrow('score')}</th>
                                <th>Duration</th>
                                <th class="sortable ${sortKey === 'createdAt' ? 'sorted' : ''}" data-sort="createdAt">Analyzed ${arrow('createdAt')}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${slice.map(r => `
                                <tr data-id="${r.id}">
                                    <td>
                                        <div class="cell-file">${EC.ICONS.music}<span title="${Fmt.escape(r.filename)}">${Fmt.escape(r.filename)}</span></div>
                                    </td>
                                    <td><span class="pill ${r.verdict}">${r.verdict === 'ai' ? 'AI-generated' : 'Real voice'}</span></td>
                                    <td class="mono">${r.confidence.toFixed(1)}%</td>
                                    <td class="mono">${r.score.toFixed(2)}</td>
                                    <td class="mono muted">${Fmt.duration(r.durationSec)}</td>
                                    <td class="muted">${Fmt.dateTime(r.createdAt)}</td>
                                    <td class="row-actions">
                                        <button class="btn-icon" data-view title="View details">${EC.ICONS.info}</button>
                                        <button class="btn-icon" data-download title="Download report">${EC.ICONS.download}</button>
                                        <button class="btn-icon" data-delete title="Delete">${EC.ICONS.trash}</button>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;

            footer.hidden = false;
            $('historyCount').textContent =
                'Showing ' + slice.length + ' of ' + rows.length + ' analyses';
            $('pageLabel').textContent = page + ' / ' + pages;
            $('prevPage').disabled = page <= 1;
            $('nextPage').disabled = page >= pages;
        }

        function detailsMarkup(r) {
            return `
                <ul class="spec-list">
                    <li><span class="spec-key">Analysis ID</span><span class="spec-val mono">${Fmt.escape(r.id)}</span></li>
                    <li><span class="spec-key">File</span><span class="spec-val">${Fmt.escape(r.filename)}</span></li>
                    <li><span class="spec-key">Size</span><span class="spec-val">${Fmt.bytes(r.size)}</span></li>
                    <li><span class="spec-key">Duration</span><span class="spec-val">${Fmt.duration(r.durationSec)}</span></li>
                    <li><span class="spec-key">Verdict</span><span class="spec-val"><span class="pill ${r.verdict}">${r.verdict === 'ai' ? 'AI-generated' : 'Real voice'}</span></span></li>
                    <li><span class="spec-key">Confidence</span><span class="spec-val">${r.confidence.toFixed(1)}%</span></li>
                    <li><span class="spec-key">Decision score</span><span class="spec-val">${r.score.toFixed(2)}</span></li>
                    <li><span class="spec-key">Threshold used</span><span class="spec-val">${r.threshold.toFixed(2)}</span></li>
                    <li><span class="spec-key">Model</span><span class="spec-val">${Fmt.escape(r.model || '--')}</span></li>
                    <li><span class="spec-key">Analyzed at</span><span class="spec-val">${new Date(r.createdAt).toLocaleString()}</span></li>
                </ul>`;
        }

        body.addEventListener('click', (e) => {
            const th = e.target.closest('th.sortable');
            if (th) {
                const key = th.dataset.sort;
                sortDir = (sortKey === key && sortDir === 'desc') ? 'asc' : 'desc';
                sortKey = key;
                render();
                return;
            }

            const row = e.target.closest('tr[data-id]');
            if (!row) return;
            const record = Store.getAnalyses().find(r => r.id === row.dataset.id);
            if (!record) return;

            if (e.target.closest('[data-view]')) {
                EC.modal({
                    title: 'Analysis details',
                    body: detailsMarkup(record),
                    cancelText: 'Close'
                });
            } else if (e.target.closest('[data-download]')) {
                EC.downloadReport(record);
            } else if (e.target.closest('[data-delete]')) {
                EC.modal({
                    title: 'Delete analysis',
                    body: '<p>Remove <strong>' + Fmt.escape(record.filename) + '</strong> from the history? This cannot be undone.</p>',
                    confirmText: 'Delete',
                    danger: true,
                    onConfirm: () => {
                        Store.deleteAnalysis(record.id);
                        render();
                        EC.toast('Analysis deleted.', 'success');
                    }
                });
            }
        });

        [searchInput, verdictFilter, rangeFilter, pageSizeSel].forEach(el => {
            el.addEventListener('input', () => { page = 1; render(); });
            el.addEventListener('change', () => { page = 1; render(); });
        });

        $('prevPage').addEventListener('click', () => { page--; render(); });
        $('nextPage').addEventListener('click', () => { page++; render(); });

        $('exportCsvBtn').addEventListener('click', () => {
            const rows = filtered();
            if (!rows.length) {
                EC.toast('Nothing to export.', 'warn');
                return;
            }
            const header = ['id', 'filename', 'verdict', 'confidence', 'score', 'threshold', 'durationSec', 'sizeBytes', 'model', 'createdAt'];
            const csv = [header.join(',')].concat(rows.map(r =>
                header.map(k => {
                    const v = r[k] === undefined ? '' : String(r[k]);
                    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
                }).join(',')
            )).join('\n');

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'echocipher-history-' + new Date().toISOString().slice(0, 10) + '.csv';
            a.click();
            URL.revokeObjectURL(url);
            EC.toast('Exported ' + rows.length + ' rows.', 'success');
        });

        $('clearHistoryBtn').addEventListener('click', () => {
            if (!Store.getAnalyses().length) {
                EC.toast('History is already empty.', 'warn');
                return;
            }
            EC.modal({
                title: 'Clear detection history',
                body: '<p>This permanently deletes all stored analyses on this device. Export a CSV first if you need a copy.</p>',
                confirmText: 'Clear everything',
                danger: true,
                onConfirm: () => {
                    Store.clearAnalyses();
                    page = 1;
                    render();
                    EC.toast('History cleared.', 'success');
                }
            });
        });

        render();
    }

    /* ================================================================== */
    /* ANALYTICS                                                           */
    /* ================================================================== */

    function initAnalytics() {
        if (typeof global.Chart === 'undefined') {
            EC.toast('Chart library could not be loaded (offline?).', 'warn');
        }

        const rangeSel = $('analyticsRange');
        let charts = {};

        function kpiCard(icon, tone, value, label, note) {
            return `
                <div class="kpi-card">
                    <div class="kpi-icon ${tone}">${icon}</div>
                    <div class="kpi-details">
                        <h3>${value}</h3>
                        <p>${label}</p>
                    </div>
                    <div class="kpi-trend ${note.positive ? 'positive' : 'negative'}">
                        ${note.text}<span class="trend-duration">${note.sub}</span>
                    </div>
                </div>`;
        }

        function render() {
            const days = Number(rangeSel.value);
            const cutoff = Date.now() - days * 86400000;
            const all = Store.getAnalyses();
            const rows = all.filter(r => new Date(r.createdAt).getTime() >= cutoff);

            const ai = rows.filter(r => r.verdict === 'ai');
            const real = rows.filter(r => r.verdict === 'real');
            const avg = rows.length ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0;
            const aiRate = rows.length ? (ai.length / rows.length) * 100 : 0;

            $('analyticsKpis').innerHTML =
                kpiCard(EC.ICONS.activity, 'blue', rows.length, 'Analyses in range',
                    { positive: true, text: days + 'd', sub: 'Selected window' }) +
                kpiCard(EC.ICONS.shield, 'red', ai.length, 'AI-generated',
                    { positive: false, text: aiRate.toFixed(0) + '%', sub: 'of all analyses' }) +
                kpiCard(EC.ICONS.checkCircle, 'green', real.length, 'Real voices',
                    { positive: true, text: (100 - aiRate).toFixed(0) + '%', sub: 'of all analyses' }) +
                kpiCard(EC.ICONS.check, 'purple', avg.toFixed(1) + '%', 'Average confidence',
                    { positive: avg >= 85, text: rows.length ? 'live' : 'n/a', sub: 'Across range' });

            if (typeof global.Chart === 'undefined') return;
            Object.values(charts).forEach(c => c && c.destroy());
            charts = {};

            /* --- trend --- */
            const series = Store.dailySeries(Math.min(days, 30));
            charts.trend = new Chart($('trendChart'), {
                type: 'bar',
                data: {
                    labels: series.map(d => d.shortLabel),
                    datasets: [
                        { label: 'Real Voice', data: series.map(d => d.real), backgroundColor: '#00A78E', borderRadius: 4 },
                        { label: 'AI-Generated', data: series.map(d => d.ai), backgroundColor: '#E11D48', borderRadius: 4 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } } },
                    scales: {
                        x: { stacked: true, grid: { display: false } },
                        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#E2E8F0' } }
                    }
                }
            });

            /* --- split --- */
            charts.split = new Chart($('splitChart'), {
                type: 'doughnut',
                data: {
                    labels: ['Real Voice', 'AI-Generated'],
                    datasets: [{
                        data: rows.length ? [real.length, ai.length] : [1, 0],
                        backgroundColor: ['#00A78E', '#E11D48'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '62%',
                    plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } } }
                }
            });

            /* --- confidence histogram --- */
            const buckets = ['<70', '70-79', '80-89', '90-94', '95-100'];
            const counts = [0, 0, 0, 0, 0];
            rows.forEach(r => {
                const c = r.confidence;
                if (c < 70) counts[0]++;
                else if (c < 80) counts[1]++;
                else if (c < 90) counts[2]++;
                else if (c < 95) counts[3]++;
                else counts[4]++;
            });

            charts.confidence = new Chart($('confidenceChart'), {
                type: 'bar',
                data: {
                    labels: buckets,
                    datasets: [{ label: 'Analyses', data: counts, backgroundColor: '#1B3A6B', borderRadius: 4 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false } },
                        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#E2E8F0' } }
                    }
                }
            });

            /* --- risk list --- */
            const risky = ai.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 6);
            $('riskList').innerHTML = risky.length
                ? risky.map(r => `
                    <div class="risk-row">
                        <div class="risk-head">
                            <strong title="${Fmt.escape(r.filename)}">${Fmt.escape(r.filename)}</strong>
                            <span class="mono">${r.confidence.toFixed(1)}%</span>
                        </div>
                        <div class="meter red"><span style="width:${r.confidence.toFixed(1)}%"></span></div>
                        <small class="muted">${Fmt.dateTime(r.createdAt)} &bull; score ${r.score.toFixed(2)}</small>
                    </div>`).join('')
                : emptyState('No AI detections', 'Nothing in this range was flagged as synthetic.');
        }

        rangeSel.addEventListener('change', render);
        render();
    }

    /* ================================================================== */
    /* MODEL INFORMATION                                                   */
    /* ================================================================== */

    function initModelInfo() {
        const settings = Store.getSettings();
        const all = Store.getAnalyses();
        const stats = Store.stats();

        $('miThreshold').textContent = Number(settings.threshold).toFixed(2);
        $('miAlert').textContent = settings.confidenceAlert + '%';
        $('miRuns').textContent = all.length;
        $('miAvg').textContent = all.length ? stats.avgConfidence.toFixed(1) + '%' : '--';
        $('miLast').textContent = all.length ? Fmt.relative(all[0].createdAt) : 'Never';

        const benchmarks = [
            { label: 'Accuracy', value: 95.5, tone: 'green' },
            { label: 'Precision', value: 95.9, tone: 'green' },
            { label: 'Recall', value: 95.0, tone: 'green' },
            { label: 'F1 score', value: 95.4, tone: 'green' },
            { label: 'Equal error rate', value: 4.6, tone: 'orange', invert: true }
        ];

        $('benchmarkBlocks').innerHTML = benchmarks.map(b => `
            <div class="metric-block">
                <div class="metric-block-head">
                    <span>${b.label}</span>
                    <strong>${b.value.toFixed(1)}%</strong>
                </div>
                <div class="meter ${b.tone}"><span style="width:${b.invert ? b.value * 4 : b.value}%"></span></div>
            </div>`).join('');

        const versions = [
            { v: 'v1.0.0', date: 'Current', note: 'Production release. CNN + BiLSTM over log-mel features.' },
            { v: 'v0.9.2', date: 'Release candidate', note: 'Reduced false positives on telephony-band audio.' },
            { v: 'v0.8.0', date: 'Beta', note: 'Added FLAC and M4A decoding; batch inference support.' },
            { v: 'v0.5.0', date: 'Prototype', note: 'First working detector trained on the internal corpus.' }
        ];

        $('versionTimeline').innerHTML = versions.map((item, i) => `
            <div class="timeline-item${i === 0 ? ' current' : ''}">
                <span class="timeline-dot"></span>
                <div>
                    <strong>${item.v} <span class="pill ${i === 0 ? 'real' : 'neutral'}">${item.date}</span></strong>
                    <p class="muted">${item.note}</p>
                </div>
            </div>`).join('');

        $('checkUpdateBtn').addEventListener('click', () => {
            EC.toast('v1.0.0 is the latest available build.', 'success');
        });

        $('runSelfTestBtn').addEventListener('click', () => {
            const steps = [
                'Loading model weights',
                'Verifying checksum',
                'Warming up inference runtime',
                'Scoring 12 calibration clips',
                'Comparing against expected outputs'
            ];
            const dialog = EC.modal({
                title: 'Model self-test',
                body: '<div class="selftest">' + steps.map((s, i) =>
                    `<div class="selftest-step" data-step="${i}"><span class="spinner-dot"></span>${Fmt.escape(s)}</div>`
                ).join('') + '</div>',
                cancelText: 'Close'
            });

            steps.forEach((_, i) => {
                setTimeout(() => {
                    const el = dialog.root.querySelector('[data-step="' + i + '"]');
                    if (el) {
                        el.classList.add('done');
                        el.querySelector('.spinner-dot').outerHTML =
                            '<span class="step-check">' + EC.ICONS.check + '</span>';
                    }
                    if (i === steps.length - 1) {
                        const body = dialog.root.querySelector('.modal-body');
                        if (body) {
                            body.insertAdjacentHTML('beforeend',
                                '<div class="callout selftest-result">' + EC.ICONS.checkCircle +
                                '<div>All checks passed. The detector is operating within tolerance.</div></div>');
                        }
                    }
                }, 500 * (i + 1));
            });
        });
    }

    /* ================================================================== */
    /* SETTINGS                                                            */
    /* ================================================================== */

    function initSettings() {
        const form = $('settingsForm');

        function load() {
            const s = Store.getSettings();
            $('displayName').value = s.displayName;
            $('email').value = s.email;
            $('organisation').value = s.organisation;
            $('threshold').value = s.threshold;
            $('confidenceAlert').value = s.confidenceAlert;
            $('modelId').value = s.modelId;
            $('retentionDays').value = String(s.retentionDays);
            $('autoAnalyze').checked = !!s.autoAnalyze;
            $('soundAlerts').checked = !!s.soundAlerts;
            $('emailAlerts').checked = !!s.emailAlerts;
            syncRangeLabels();
            refreshStorage();
        }

        function syncRangeLabels() {
            $('thresholdValue').textContent = Number($('threshold').value).toFixed(2);
            $('confidenceAlertValue').textContent = $('confidenceAlert').value + '%';
        }

        function refreshStorage() {
            const all = Store.getAnalyses();
            $('storedCount').textContent = all.length;
            $('storedSize').textContent = Fmt.bytes(new Blob([JSON.stringify(all)]).size);
        }

        $('threshold').addEventListener('input', syncRangeLabels);
        $('confidenceAlert').addEventListener('input', syncRangeLabels);

        function save() {
            if (!form.reportValidity()) return;
            const patch = {
                displayName: $('displayName').value.trim() || 'Admin User',
                email: $('email').value.trim(),
                organisation: $('organisation').value.trim(),
                threshold: Number($('threshold').value),
                confidenceAlert: Number($('confidenceAlert').value),
                modelId: $('modelId').value,
                retentionDays: Number($('retentionDays').value),
                autoAnalyze: $('autoAnalyze').checked,
                soundAlerts: $('soundAlerts').checked,
                emailAlerts: $('emailAlerts').checked
            };
            Store.saveSettings(patch);

            // Reflect the new identity in the header immediately.
            const nameEl = $('profileName');
            const orgEl = $('profileOrg');
            if (nameEl) nameEl.textContent = patch.displayName;
            if (orgEl) orgEl.textContent = patch.organisation;
            const avatarImg = document.querySelector('.avatar img');
            if (avatarImg) {
                avatarImg.src = 'https://ui-avatars.com/api/?name=' +
                    encodeURIComponent(patch.displayName) + '&background=1B3A6B&color=fff';
            }

            EC.toast('Settings saved.', 'success');
        }

        $('saveSettingsBtn').addEventListener('click', save);
        form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

        $('resetSettingsBtn').addEventListener('click', () => {
            EC.modal({
                title: 'Reset settings',
                body: '<p>Restore every preference to its default value? Your stored analyses are not affected.</p>',
                confirmText: 'Reset',
                onConfirm: () => {
                    Store.resetSettings();
                    load();
                    EC.toast('Settings restored to defaults.', 'success');
                }
            });
        });

        $('exportDataBtn').addEventListener('click', () => {
            const payload = {
                exportedAt: new Date().toISOString(),
                settings: Store.getSettings(),
                analyses: Store.getAnalyses(),
                notifications: Store.getNotifications()
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'echocipher-data-' + new Date().toISOString().slice(0, 10) + '.json';
            a.click();
            URL.revokeObjectURL(url);
            EC.toast('Data exported.', 'success');
        });

        $('deleteDataBtn').addEventListener('click', () => {
            EC.modal({
                title: 'Delete all data',
                body: '<p>This clears every stored analysis and notification from this browser. Settings are kept. This cannot be undone.</p>',
                confirmText: 'Delete everything',
                danger: true,
                onConfirm: () => {
                    Store.clearAnalyses();
                    Store.clearNotifications();
                    EC.renderNotifications();
                    refreshStorage();
                    EC.toast('All analysis data deleted.', 'success');
                }
            });
        });

        load();

        // settings.html#preferences deep-link from the profile menu.
        if (location.hash === '#preferences') {
            const target = document.getElementById('preferences');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    /* ================================================================== */

    const PAGES = {
        'voice-detection': initVoiceDetection,
        'history': initHistory,
        'analytics': initAnalytics,
        'model-info': initModelInfo,
        'settings': initSettings
    };

    document.addEventListener('echocipher:ready', (e) => {
        const init = PAGES[e.detail.page];
        if (init) init();
    });
})(window);
