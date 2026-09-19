/* =========================================================================
   EchoCipher - shared "upload & analyze" widget
   Used by dashboard.html and voice-detection.html. Handles file selection,
   validation, real audio playback, the analysis call and the result panel.
   ========================================================================= */

(function (global) {
    'use strict';

    const EC = global.EchoCipher;
    const MAX_BYTES = 25 * 1024 * 1024;
    const ALLOWED = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm'];

    function extension(name) {
        const parts = String(name).toLowerCase().split('.');
        return parts.length > 1 ? parts.pop() : '';
    }

    function validate(file) {
        if (!file) return 'No file selected.';
        if (file.size > MAX_BYTES) {
            return 'That file is ' + EC.Fmt.bytes(file.size) + '. The limit is 25 MB.';
        }
        if (file.size === 0) return 'That file is empty.';
        const ext = extension(file.name);
        const looksAudio = file.type.startsWith('audio/') || ALLOWED.indexOf(ext) !== -1;
        if (!looksAudio) {
            return 'Unsupported format ".' + ext + '". Use WAV, MP3, FLAC, M4A or OGG.';
        }
        return null;
    }

    function resultMarkup(record) {
        const isAI = record.verdict === 'ai';
        return `
            <div class="result-header">
                <h4>Analysis Complete</h4>
                <span class="badge-status ${isAI ? 'ai-generated' : 'real-voice'}">
                    ${isAI ? 'AI-GENERATED' : 'REAL VOICE'}
                </span>
            </div>
            <div class="meter ${isAI ? 'red' : 'green'}" title="Confidence">
                <span style="width:${record.confidence.toFixed(1)}%"></span>
            </div>
            <div class="result-metrics">
                <div class="metric">
                    <span class="label">Confidence</span>
                    <span class="value">${record.confidence.toFixed(1)}%</span>
                </div>
                <div class="metric">
                    <span class="label">Decision Score</span>
                    <span class="value" style="color:${isAI ? 'var(--accent-red)' : 'var(--accent-green)'}">
                        ${record.score.toFixed(2)}
                    </span>
                </div>
                <div class="metric">
                    <span class="label">Threshold</span>
                    <span class="value">${record.threshold.toFixed(2)}</span>
                </div>
                <div class="metric">
                    <span class="label">Duration</span>
                    <span class="value">${EC.Fmt.duration(record.durationSec)}</span>
                </div>
                <div class="metric">
                    <span class="label">Analysis ID</span>
                    <span class="value mono">${EC.Fmt.escape(record.id)}</span>
                </div>
            </div>
            <div class="result-actions">
                <button class="btn-secondary" type="button" data-report>Download report</button>
                <button class="btn-primary" type="button" data-reset>Analyze another file</button>
            </div>`;
    }

    function downloadReport(record) {
        const lines = [
            'EchoCipher — Voice Analysis Report',
            '===================================',
            'Analysis ID : ' + record.id,
            'File        : ' + record.filename,
            'Size        : ' + EC.Fmt.bytes(record.size),
            'Duration    : ' + EC.Fmt.duration(record.durationSec),
            'Analyzed at : ' + new Date(record.createdAt).toLocaleString(),
            'Model       : ' + record.model,
            '',
            'Verdict     : ' + (record.verdict === 'ai' ? 'AI-GENERATED' : 'REAL VOICE'),
            'Confidence  : ' + record.confidence.toFixed(1) + '%',
            'Score       : ' + record.score.toFixed(2),
            'Threshold   : ' + record.threshold.toFixed(2)
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'echocipher-report-' + record.id + '.txt';
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Wires an analyzer block.
     * @param {object} opts
     *   root        - container element holding the widget
     *   onComplete  - called with the committed record
     */
    function mountAnalyzer(opts) {
        const root = opts.root || document;
        const $ = (id) => root.querySelector('#' + id);

        const dropZone = $('dropZone');
        const fileInput = $('fileInput');
        const browseBtn = $('browseBtn');
        const scanPreview = $('scanPreview');
        const scanResults = $('scanResults');
        const analyzeBtn = $('analyzeVoiceBtn');
        const removeBtn = $('removeFileBtn');
        const audioEl = $('audioEl');
        const playBtn = $('playBtn');
        const seekBar = $('seekBar');
        const playTime = $('playTime');

        if (!dropZone || !fileInput) return null;

        let currentFile = null;
        let objectUrl = null;
        let lastRecord = null;

        function show(el, visible) {
            if (el) el.hidden = !visible;
        }

        function setStage(stage) {
            show(dropZone, stage === 'idle');
            show(scanPreview, stage === 'preview');
            show(scanResults, stage === 'results');
        }

        function releaseUrl() {
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
            }
        }

        function reset() {
            if (audioEl) {
                audioEl.pause();
                audioEl.removeAttribute('src');
            }
            releaseUrl();
            currentFile = null;
            fileInput.value = '';
            if (playBtn) playBtn.innerHTML = EC.ICONS.play;
            if (seekBar) seekBar.style.setProperty('--progress', '0%');
            if (playTime) playTime.textContent = '00:00';
            setStage('idle');
        }

        function loadFile(file) {
            const error = validate(file);
            if (error) {
                EC.toast(error, 'error');
                fileInput.value = '';
                return;
            }

            currentFile = file;
            releaseUrl();
            objectUrl = URL.createObjectURL(file);
            if (playBtn) playBtn.disabled = false;   // a previous file may have failed to decode

            const nameEl = $('previewFilename');
            const sizeEl = $('previewSize');
            const durEl = $('previewDuration');
            if (nameEl) nameEl.textContent = file.name;
            if (sizeEl) sizeEl.textContent = EC.Fmt.bytes(file.size);
            if (durEl) durEl.textContent = '--:--';

            if (audioEl) {
                audioEl.src = objectUrl;
                audioEl.load();
            }

            setStage('preview');

            if (EC.Store.getSettings().autoAnalyze) {
                // Give the metadata a moment to land so the record has a duration.
                setTimeout(runAnalysis, 350);
            }
        }

        function runAnalysis() {
            if (!currentFile || analyzeBtn.disabled) return;

            const original = analyzeBtn.innerHTML;
            analyzeBtn.innerHTML = 'Analyzing<span class="dots"></span>';
            analyzeBtn.disabled = true;
            if (scanPreview) scanPreview.classList.add('busy');

            const durationSec = audioEl && isFinite(audioEl.duration) ? audioEl.duration : 0;

            EC.Detector.analyzeFile(currentFile, { durationSec: durationSec })
                .then(record => {
                    EC.Detector.commit(record);
                    lastRecord = record;

                    analyzeBtn.innerHTML = original;
                    analyzeBtn.disabled = false;
                    if (scanPreview) scanPreview.classList.remove('busy');
                    if (audioEl) audioEl.pause();

                    if (scanResults) scanResults.innerHTML = resultMarkup(record);
                    setStage('results');

                    EC.renderNotifications();
                    EC.toast(
                        record.verdict === 'ai'
                            ? 'AI-generated voice detected (' + record.confidence.toFixed(1) + '%)'
                            : 'Real voice confirmed (' + record.confidence.toFixed(1) + '%)',
                        record.verdict === 'ai' ? 'error' : 'success'
                    );

                    if (opts.onComplete) opts.onComplete(record);
                })
                .catch(err => {
                    console.error(err);
                    analyzeBtn.innerHTML = original;
                    analyzeBtn.disabled = false;
                    if (scanPreview) scanPreview.classList.remove('busy');
                    EC.toast('Analysis failed. Please try again.', 'error');
                });
        }

        /* --- file pickers --- */
        dropZone.addEventListener('click', (e) => {
            if (!e.target.closest('button')) fileInput.click();
        });
        if (browseBtn) {
            browseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                fileInput.click();
            });
        }
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) loadFile(e.target.files[0]);
        });

        /* --- drag & drop --- */
        ['dragenter', 'dragover'].forEach(evt =>
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.add('dragging');
            }));
        ['dragleave', 'drop'].forEach(evt =>
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragging');
            }));
        dropZone.addEventListener('drop', (e) => {
            if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
        });

        /* --- preview controls --- */
        if (removeBtn) removeBtn.addEventListener('click', reset);
        if (analyzeBtn) analyzeBtn.addEventListener('click', runAnalysis);

        if (scanResults) {
            scanResults.addEventListener('click', (e) => {
                if (e.target.closest('[data-reset]')) reset();
                if (e.target.closest('[data-report]') && lastRecord) downloadReport(lastRecord);
            });
        }

        /* --- audio playback --- */
        if (audioEl) {
            audioEl.addEventListener('loadedmetadata', () => {
                const durEl = $('previewDuration');
                if (durEl) durEl.textContent = EC.Fmt.duration(audioEl.duration);
            });
            audioEl.addEventListener('timeupdate', () => {
                if (playTime) playTime.textContent = EC.Fmt.duration(audioEl.currentTime);
                if (seekBar && audioEl.duration) {
                    seekBar.style.setProperty('--progress',
                        (audioEl.currentTime / audioEl.duration * 100).toFixed(1) + '%');
                }
            });
            audioEl.addEventListener('ended', () => {
                if (playBtn) playBtn.innerHTML = EC.ICONS.play;
            });
            audioEl.addEventListener('error', () => {
                if (playBtn) playBtn.disabled = true;
                EC.toast('This browser cannot play that audio format, but it can still be analyzed.', 'warn');
            });
        }

        if (playBtn) {
            playBtn.innerHTML = EC.ICONS.play;
            playBtn.addEventListener('click', () => {
                if (!audioEl || !audioEl.src) return;
                if (audioEl.paused) {
                    audioEl.play().then(() => {
                        playBtn.innerHTML = EC.ICONS.pause;
                    }).catch(() => EC.toast('Playback was blocked by the browser.', 'warn'));
                } else {
                    audioEl.pause();
                    playBtn.innerHTML = EC.ICONS.play;
                }
            });
        }

        if (seekBar) {
            seekBar.addEventListener('click', (e) => {
                if (!audioEl || !audioEl.duration) return;
                const rect = seekBar.getBoundingClientRect();
                audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
            });
        }

        setStage('idle');

        return {
            loadFile: loadFile,
            reset: reset,
            analyze: runAnalysis
        };
    }

    EC.mountAnalyzer = mountAnalyzer;
    EC.validateAudio = validate;
    EC.downloadReport = downloadReport;
})(window);
