/* =========================================================================
   EchoCipher - dashboard page
   KPIs, activity chart and the recent list are all derived from the stored
   analyses, so the page reflects real work done in this browser.
   ========================================================================= */

document.addEventListener('echocipher:ready', (e) => {
    if (e.detail.page !== 'dashboard') return;

    const EC = window.EchoCipher;
    const Store = EC.Store;
    const $ = (id) => document.getElementById(id);

    let chart = null;

    /* ------------------------------------------------------------------ */
    /* KPI cards                                                           */
    /* ------------------------------------------------------------------ */

    function renderKpis() {
        const s = Store.stats();
        const hasData = s.total > 0;
        const trendText = (s.trend >= 0 ? '+' : '') + s.trend + '%';

        const cards = [
            {
                tone: 'blue', icon: EC.ICONS.activity,
                value: s.total, label: 'Total Analyses',
                trend: trendText, positive: s.trend >= 0
            },
            {
                tone: 'red', icon: EC.ICONS.shield,
                value: s.ai, label: 'AI-Generated Detected',
                trend: hasData ? s.aiRate.toFixed(0) + '%' : '0%', positive: false
            },
            {
                tone: 'green', icon: EC.ICONS.checkCircle,
                value: s.real, label: 'Real Voices',
                trend: hasData ? (100 - s.aiRate).toFixed(0) + '%' : '0%', positive: true
            },
            {
                tone: 'purple', icon: EC.ICONS.check,
                value: s.avgConfidence.toFixed(1) + '%', label: 'Average Confidence',
                trend: hasData ? 'live' : 'n/a', positive: s.avgConfidence >= 85
            }
        ];

        $('kpiGrid').innerHTML = cards.map(c => `
            <div class="kpi-card">
                <div class="kpi-icon ${c.tone}">${c.icon}</div>
                <div class="kpi-details">
                    <h3>${c.value}</h3>
                    <p>${c.label}</p>
                    ${hasData ? '' : '<span class="mock-tag">No data yet</span>'}
                </div>
                <div class="kpi-trend ${c.positive ? 'positive' : 'negative'}">
                    ${c.trend}<span class="trend-duration">Last 30 days</span>
                </div>
            </div>`).join('');
    }

    /* ------------------------------------------------------------------ */
    /* Activity chart                                                      */
    /* ------------------------------------------------------------------ */

    function renderChart() {
        const canvas = $('volumeChart');
        if (!canvas || typeof Chart === 'undefined') return;

        const series = Store.dailySeries(7);
        const config = {
            labels: series.map(d => d.label),
            real: series.map(d => d.real),
            ai: series.map(d => d.ai)
        };

        if (chart) {
            chart.data.labels = config.labels;
            chart.data.datasets[0].data = config.real;
            chart.data.datasets[1].data = config.ai;
            chart.update();
            return;
        }

        chart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: config.labels,
                datasets: [
                    {
                        label: 'Real Voice',
                        data: config.real,
                        backgroundColor: '#00A78E',
                        borderRadius: 4,
                        barPercentage: 0.6,
                        categoryPercentage: 0.8
                    },
                    {
                        label: 'AI-Generated',
                        data: config.ai,
                        backgroundColor: '#E11D48',
                        borderRadius: 4,
                        barPercentage: 0.6,
                        categoryPercentage: 0.8
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'end',
                        labels: {
                            usePointStyle: true,
                            boxWidth: 8,
                            font: { family: "'Inter', sans-serif", size: 12 }
                        }
                    }
                },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: { precision: 0 },
                        border: { display: false },
                        grid: { color: '#E2E8F0' }
                    }
                }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Recent list + status                                                */
    /* ------------------------------------------------------------------ */

    function renderRecent() {
        const all = Store.getAnalyses();
        const list = $('recentList');

        if (!all.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <p>No recent analyses found.</p>
                    <button class="btn-primary" id="emptyUploadBtn" type="button">Analyze your first file</button>
                </div>`;
            const btn = $('emptyUploadBtn');
            if (btn) btn.addEventListener('click', focusUpload);
            return;
        }

        list.innerHTML = all.slice(0, 5).map(r => `
            <div class="recent-item">
                <div class="recent-info">
                    <h4 title="${EC.Fmt.escape(r.filename)}">${EC.Fmt.escape(r.filename)}</h4>
                    <p>${EC.Fmt.relative(r.createdAt)} &bull; ${r.confidence.toFixed(1)}% confidence</p>
                </div>
                <span class="status-badge ${r.verdict === 'ai' ? 'block' : 'pass'}">
                    ${r.verdict === 'ai' ? 'AI' : 'REAL'}
                </span>
            </div>`).join('');
    }

    function renderStatus() {
        const settings = Store.getSettings();
        $('statusModel').textContent = settings.modelId;
        $('statusThreshold').textContent = Number(settings.threshold).toFixed(2);

        // There is no backend yet — report honestly instead of faking "Connected".
        const api = $('apiStatus');
        api.className = 'status-val offline';
        api.innerHTML = '<span class="dot"></span> Local mode';
        api.title = 'Running against the in-browser mock detector.';
    }

    function refresh() {
        renderKpis();
        renderChart();
        renderRecent();
        renderStatus();
    }

    /* ------------------------------------------------------------------ */
    /* Upload widget                                                       */
    /* ------------------------------------------------------------------ */

    const analyzer = EC.mountAnalyzer({
        root: document,
        onComplete: refresh
    });

    function focusUpload() {
        const card = $('analyzeCard');
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('highlight');
        setTimeout(() => card.classList.remove('highlight'), 1200);
        const dropZone = $('dropZone');
        if (dropZone && !dropZone.hidden) $('fileInput').click();
    }

    // The hero CTA is the only upload entry point at the top of the page —
    // it scrolls down to the analyze card rather than opening a separate flow.
    const heroAnalyzeBtn = $('heroAnalyzeBtn');
    if (heroAnalyzeBtn) heroAnalyzeBtn.addEventListener('click', focusUpload);

    refresh();
});
