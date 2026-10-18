'use strict';
/**
 * public/app.js – Vanilla JS frontend controller for Patchwork Load Tester.
 * No external dependencies or CDN libraries required.
 */

(function () {
  // ── State ──────────────────────────────────────────────────────────────────
  let activeRunId       = null;
  let pollTimer         = null;
  let elapsedTimer      = null;
  let selectedRunId     = null;
  let activeRunStartedAt= null;

  // ── DOM Elements ───────────────────────────────────────────────────────────
  const healthStatusDot   = document.querySelector('#healthStatus .status-dot');
  const healthStatusLabel = document.querySelector('#healthStatus .status-label');

  const runForm              = document.getElementById('runForm');
  const targetUrlInput       = document.getElementById('targetUrl');
  const payloadEditor        = document.getElementById('payloadEditor');
  const payloadError         = document.getElementById('payloadError');
  const concurrencyInput     = document.getElementById('concurrency');
  const graceSecondsInput    = document.getElementById('graceSeconds');
  const callbackBaseUrlInput = document.getElementById('callbackBaseUrl');
  const runLabelInput        = document.getElementById('runLabel');
  const expectedExitCodeSel  = document.getElementById('expectedExitCode');
  const executionModeInput   = document.getElementById('executionMode');
  const startBtn             = document.getElementById('startBtn');
  const formError            = document.getElementById('formError');

  const activeRunSection = document.getElementById('activeRunSection');
  const runStateBadge    = document.getElementById('runStateBadge');
  const runIdDisplay     = document.getElementById('runIdDisplay');
  const runLabelDisplay  = document.getElementById('runLabelDisplay');
  const warningBanner    = document.getElementById('warningBanner');

  // Progress counters
  const mSubmitted   = document.getElementById('mSubmitted');
  const mWebhooks    = document.getElementById('mWebhooks');
  const mRequested   = document.getElementById('mRequested');
  const mElapsed     = document.getElementById('mElapsed');
  const mFailed      = document.getElementById('mFailed');
  const mFailedWrap  = document.getElementById('mFailedWrap');
  const mMissing     = document.getElementById('mMissing');
  const mMissingWrap = document.getElementById('mMissingWrap');

  // Stat cards
  const statsSection = document.getElementById('statsSection');
  const sMedianE2e   = document.getElementById('sMedianE2e');
  const sMeanE2e     = document.getElementById('sMeanE2e');
  const sMinE2e      = document.getElementById('sMinE2e');
  const sMaxE2e      = document.getElementById('sMaxE2e');
  const sP95E2e      = document.getElementById('sP95E2e');
  const sP99E2e      = document.getElementById('sP99E2e');
  const sMeanPost    = document.getElementById('sMeanPost');
  const sThroughput  = document.getElementById('sThroughput');
  const sCorrect     = document.getElementById('sCorrect');

  // History / job detail
  const refreshHistoryBtn     = document.getElementById('refreshHistoryBtn');
  const historyTableWrap      = document.getElementById('historyTable');
  const jobDetailSection      = document.getElementById('jobDetailSection');
  const jobTableWrap          = document.getElementById('jobTable');
  const exportCsvBtn          = document.getElementById('exportCsvBtn');
  const exportJsonBtn         = document.getElementById('exportJsonBtn');
  const closeJobDetailBtn     = document.getElementById('closeJobDetailBtn');
  const historyStatsSummary   = document.getElementById('historyStatsSummary');
  const hsMedian              = document.getElementById('hsMedian');
  const hsP95                 = document.getElementById('hsP95');
  const hsP99                 = document.getElementById('hsP99');
  const hsMin                 = document.getElementById('hsMin');
  const hsMax                 = document.getElementById('hsMax');

  // ── Initialization ────────────────────────────────────────────────────────
  init();

  function init() {
    setupJsonValidation();
    setupEventListeners();
    checkHealth();
    setInterval(checkHealth, 5000);
    loadHistory();
  }

  // ── Event Listeners ───────────────────────────────────────────────────────
  function setupEventListeners() {
    runForm.addEventListener('submit', handleFormSubmit);
    refreshHistoryBtn.addEventListener('click', loadHistory);

    closeJobDetailBtn.addEventListener('click', () => {
      jobDetailSection.classList.add('hidden');
      selectedRunId = null;
    });

    exportCsvBtn.addEventListener('click', () => {
      if (!selectedRunId) return;
      window.location.href = `/api/runs/${selectedRunId}/jobs?format=csv`;
    });

    exportJsonBtn.addEventListener('click', () => {
      if (!selectedRunId) return;
      window.location.href = `/api/runs/${selectedRunId}/export`;
    });
  }

  // ── JSON Validation ───────────────────────────────────────────────────────
  function setupJsonValidation() {
    function validate() {
      const val = payloadEditor.value.trim();
      if (!val) { payloadError.textContent = 'Payload cannot be empty.'; return false; }
      try {
        const parsed = JSON.parse(val);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          payloadError.textContent = 'Payload must be a JSON object (e.g. { … }).';
          return false;
        }
        payloadError.textContent = '';
        return true;
      } catch (err) {
        payloadError.textContent = 'Invalid JSON: ' + err.message;
        return false;
      }
    }
    payloadEditor.addEventListener('input', validate);
    payloadEditor.addEventListener('blur', validate);
  }

  function validatePayload() {
    const val = payloadEditor.value.trim();
    if (!val) { payloadError.textContent = 'Payload cannot be empty.'; return null; }
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        payloadError.textContent = 'Payload must be a JSON object.';
        return null;
      }
      payloadError.textContent = '';
      return parsed;
    } catch (err) {
      payloadError.textContent = 'Invalid JSON: ' + err.message;
      return null;
    }
  }

  // ── Health Check ──────────────────────────────────────────────────────────
  async function checkHealth() {
    try {
      const res = await fetch('/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.active_run_id) {
        healthStatusDot.className = 'status-dot active';
        healthStatusLabel.textContent = `Running (${data.active_run_id.slice(0, 8)})`;
        if (activeRunId !== data.active_run_id) trackRun(data.active_run_id);
      } else {
        healthStatusDot.className = 'status-dot ok';
        healthStatusLabel.textContent = 'Ready';
        if (activeRunId && !pollTimer) setFormDisabled(false);
      }
    } catch {
      healthStatusDot.className = 'status-dot error';
      healthStatusLabel.textContent = 'Offline';
    }
  }

  // ── Form Submit ───────────────────────────────────────────────────────────
  async function handleFormSubmit(e) {
    e.preventDefault();
    formError.textContent = '';

    const payloadObj = validatePayload();
    if (!payloadObj) return;

    const targetUrl      = targetUrlInput.value.trim();
    const concurrency    = parseInt(concurrencyInput.value, 10);
    const graceSeconds   = parseInt(graceSecondsInput.value, 10);
    const callbackBaseUrl= callbackBaseUrlInput.value.trim();
    const label          = runLabelInput.value.trim() || undefined;
    const executionMode  = executionModeInput.value.trim() || undefined;

    let expectedExitCode = null;
    if (expectedExitCodeSel.value !== '') {
      expectedExitCode = parseInt(expectedExitCodeSel.value, 10);
    }

    const reqBody = {
      target_url: targetUrl,
      payload: payloadObj,
      concurrency,
      grace_seconds: graceSeconds,
      callback_base_url: callbackBaseUrl,
      label,
      expected_exit_code: expectedExitCode,
      execution_mode: executionMode,
    };

    setFormDisabled(true);
    startBtn.innerHTML = '<span class="btn-icon">⏳</span> Starting…';

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = await res.json();

      if (!res.ok) {
        setFormDisabled(false);
        startBtn.innerHTML = '<span class="btn-icon">▶</span> Start Test';
        if (res.status === 409) {
          formError.textContent = `A test is already running (${data.active_run_id || 'in progress'}).`;
          if (data.active_run_id) trackRun(data.active_run_id);
        } else if (data.details && Array.isArray(data.details)) {
          formError.textContent = data.details.join(', ');
        } else {
          formError.textContent = data.error || data.detail || 'Failed to start test.';
        }
        return;
      }

      trackRun(data.run_id);
      loadHistory();
    } catch (err) {
      setFormDisabled(false);
      startBtn.innerHTML = '<span class="btn-icon">▶</span> Start Test';
      formError.textContent = 'Network error: ' + err.message;
    }
  }

  function setFormDisabled(disabled) {
    startBtn.disabled = disabled;
    if (!disabled) startBtn.innerHTML = '<span class="btn-icon">▶</span> Start Test';
  }

  // ── Run Tracking & Polling ────────────────────────────────────────────────
  function trackRun(runId) {
    activeRunId = runId;
    setFormDisabled(true);

    activeRunSection.classList.remove('hidden');
    statsSection.classList.add('hidden');
    warningBanner.classList.add('hidden');

    runIdDisplay.textContent  = `ID: ${runId.slice(0, 8)}`;
    runLabelDisplay.textContent = '';
    updateRunBadge('starting');

    // Reset counters
    mSubmitted.textContent = '0';
    mWebhooks.textContent  = '0';
    mRequested.textContent = '—';
    mElapsed.textContent   = '0.0s';
    mFailed.textContent    = '0';
    mMissing.textContent   = '0';
    mFailedWrap.classList.add('hidden');
    mMissingWrap.classList.add('hidden');

    activeRunStartedAt = Date.now();
    startElapsedTimer();

    if (pollTimer) clearInterval(pollTimer);
    pollActiveRun();
    pollTimer = setInterval(pollActiveRun, 1000);
  }

  function startElapsedTimer() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (activeRunStartedAt) {
        const sec = ((Date.now() - activeRunStartedAt) / 1000).toFixed(1);
        mElapsed.textContent = `${sec}s`;
      }
    }, 200);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  async function pollActiveRun() {
    if (!activeRunId) return;
    try {
      const res = await fetch(`/api/runs/${activeRunId}`);
      if (!res.ok) {
        if (res.status === 404) stopTrackingActiveRun();
        return;
      }
      const data = await res.json();
      renderActiveRun(data);

      const state = data.run.state;
      if (state === 'done' || state === 'aborted') {
        stopTrackingActiveRun();
        renderStats(data.stats, data.run);
        loadHistory();
        loadJobDetails(activeRunId, data.stats);
      }
    } catch (err) {
      console.warn('[app] Poll error:', err);
    }
  }

  function stopTrackingActiveRun() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    stopElapsedTimer();
    setFormDisabled(false);
  }

  function renderActiveRun(data) {
    const { run, stats, job_counts } = data;

    updateRunBadge(run.state);
    if (run.label) runLabelDisplay.textContent = run.label;

    if (run.started_at_ms) {
      activeRunStartedAt = run.started_at_ms;
      const endMs = run.finished_at_ms || Date.now();
      mElapsed.textContent = `${((endMs - run.started_at_ms) / 1000).toFixed(1)}s`;
    }

    const jc = job_counts || {};
    mRequested.textContent = run.concurrency != null ? run.concurrency : '—';
    mSubmitted.textContent = jc.submitted != null ? jc.submitted : '0';
    mWebhooks.textContent  = jc.webhooks_received != null ? jc.webhooks_received : '0';

    const failedTotal = (stats && stats.failed != null ? stats.failed : (jc.failed || 0))
                      + (jc.post_failed || 0);
    const missing = jc.missing != null ? jc.missing : 0;

    if (failedTotal > 0) {
      mFailed.textContent = failedTotal;
      mFailedWrap.classList.remove('hidden');
    } else {
      mFailedWrap.classList.add('hidden');
    }

    if (missing > 0) {
      mMissing.textContent = missing;
      mMissingWrap.classList.remove('hidden');
    } else {
      mMissingWrap.classList.add('hidden');
    }

    // Warning: submitted count differs from requested
    const submitted = jc.submitted != null ? jc.submitted : null;
    const requested = run.concurrency;
    if (submitted !== null && requested != null && submitted !== requested) {
      warningBanner.textContent =
        `⚠ Warning: ${submitted} of ${requested} requests were sent. ` +
        `Some requests may have been dropped before submission.`;
      warningBanner.classList.remove('hidden');
    } else {
      warningBanner.classList.add('hidden');
    }
  }

  function updateRunBadge(state) {
    runStateBadge.className = `run-state-badge ${state || 'starting'}`;
    runStateBadge.textContent = state || 'starting';
  }

  function renderStats(stats, run) {
    if (!stats) return;
    statsSection.classList.remove('hidden');

    const fmt = ms => ms != null ? `${ms} ms` : '—';

    sMedianE2e.textContent = fmt(stats.e2e_median_ms);
    sMeanE2e.textContent   = fmt(stats.e2e_mean_ms);
    sMinE2e.textContent    = fmt(stats.e2e_min_ms);
    sMaxE2e.textContent    = fmt(stats.e2e_max_ms);
    sP95E2e.textContent    = fmt(stats.e2e_p95_ms);
    sP99E2e.textContent    = fmt(stats.e2e_p99_ms);
    sMeanPost.textContent  = fmt(stats.post_mean_ms);
    sThroughput.textContent= stats.throughput_jobs_per_sec != null
      ? `${stats.throughput_jobs_per_sec} req/s` : '—';

    if (run && run.expected_exit_code !== null && run.expected_exit_code !== undefined) {
      sCorrect.textContent = stats.correct != null ? `${stats.correct}` : '—';
    } else {
      sCorrect.textContent = 'N/A';
    }
  }

  // ── Run History ───────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch('/api/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderHistoryTable(data.runs || []);
    } catch (err) {
      historyTableWrap.innerHTML =
        `<p class="empty-state" style="color:var(--danger)">Failed to load history: ${err.message}</p>`;
    }
  }

  function renderHistoryTable(runs) {
    if (!runs || runs.length === 0) {
      historyTableWrap.innerHTML = '<p class="empty-state">No runs yet. Start a test to see results here.</p>';
      return;
    }

    let html = `
      <table class="history-table">
        <thead>
          <tr>
            <th>Name / ID</th>
            <th>Status</th>
            <th>Requests</th>
            <th>Completed</th>
            <th>Median</th>
            <th>P95</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const r of runs) {
      const stats    = r.stats || {};
      const shortId  = r.run_id.slice(0, 8);
      const name     = r.label ? escapeHtml(r.label) : `<code style="color:var(--text-muted)">${escapeHtml(shortId)}</code>`;
      const median   = stats.e2e_median_ms != null ? `${stats.e2e_median_ms} ms` : '—';
      const p95      = stats.e2e_p95_ms    != null ? `${stats.e2e_p95_ms} ms` : '—';
      const webhooks = stats.webhooks_received != null ? stats.webhooks_received : '—';
      const timeStr  = r.created_at_ms ? formatTimestamp(r.created_at_ms) : '—';

      html += `
        <tr data-run-id="${escapeHtml(r.run_id)}">
          <td>${name}</td>
          <td><span class="state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span></td>
          <td>${r.concurrency != null ? r.concurrency : '—'}</td>
          <td>${webhooks}</td>
          <td>${median}</td>
          <td><strong>${p95}</strong></td>
          <td>${timeStr}</td>
        </tr>
      `;
    }

    html += '</tbody></table>';
    historyTableWrap.innerHTML = html;

    historyTableWrap.querySelectorAll('tbody tr').forEach(row => {
      row.addEventListener('click', () => {
        const rid = row.getAttribute('data-run-id');
        if (rid) loadJobDetails(rid, null, rid);
      });
    });
  }

  // ── Job Details ───────────────────────────────────────────────────────────
  async function loadJobDetails(runId, statsArg, historyRunId) {
    selectedRunId = runId;
    jobDetailSection.classList.remove('hidden');
    jobTableWrap.innerHTML = '<p class="empty-state">Loading request details…</p>';
    historyStatsSummary.classList.add('hidden');

    try {
      // Fetch run detail to get stats if not provided
      let stats = statsArg;
      if (!stats && historyRunId) {
        try {
          const rr = await fetch(`/api/runs/${runId}`);
          if (rr.ok) {
            const rd = await rr.json();
            stats = rd.stats;
          }
        } catch { /* ignore */ }
      }

      if (stats) {
        const fmtMs = ms => ms != null ? `${ms} ms` : '—';
        hsMedian.textContent = fmtMs(stats.e2e_median_ms);
        hsP95.textContent    = fmtMs(stats.e2e_p95_ms);
        hsP99.textContent    = fmtMs(stats.e2e_p99_ms);
        hsMin.textContent    = fmtMs(stats.e2e_min_ms);
        hsMax.textContent    = fmtMs(stats.e2e_max_ms);
        historyStatsSummary.classList.remove('hidden');
      }

      const res = await fetch(`/api/runs/${runId}/jobs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderJobTable(data.jobs || []);
    } catch (err) {
      jobTableWrap.innerHTML =
        `<p class="empty-state" style="color:var(--danger)">Failed to load details: ${err.message}</p>`;
    }
  }

  function renderJobTable(jobs) {
    if (!jobs || jobs.length === 0) {
      jobTableWrap.innerHTML = '<p class="empty-state">No requests recorded for this run.</p>';
      return;
    }

    let html = `
      <table class="job-table" id="jobTableEl">
        <thead>
          <tr>
            <th>#</th>
            <th>Submission ID</th>
            <th>Submission time</th>
            <th>Completion time</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
    `;

    jobs.forEach((j, idx) => {
      const num      = idx + 1;
      const subId    = j.submission_id ? j.submission_id.slice(0, 12) : '—';
      const subIdFull= j.submission_id || '';
      const postMs   = j.post_ms  != null ? `${j.post_ms} ms` : '—';
      const e2eMs    = j.e2e_ms   != null ? `${j.e2e_ms} ms` : '—';
      const rowId    = `jrow-${idx}`;
      const detailId = `jdetail-${idx}`;

      // Determine result badge
      const isInfraFail = (j.stderr && j.stderr.includes('Failed to acquire container'))
                        || (j.status === 'failed' && j.exit_code === null && !j.e2e_ms);
      const isFailed    = j.status === 'failed' || j.status === 'error';
      const isSuccess   = j.status === 'completed' || j.status === 'done' || j.status === 'success';
      const isMissing   = j.completion_source === 'missing';

      let resultBadge;
      if (isMissing) {
        resultBadge = `<span class="badge badge-missing">No response</span>`;
      } else if (isInfraFail) {
        resultBadge = `<span class="badge badge-infra-fail" title="Patchwork could not acquire an execution container">⚠ Container unavailable</span>`;
      } else if (isFailed) {
        const code = j.exit_code != null ? ` (exit ${j.exit_code})` : '';
        resultBadge = `<span class="badge badge-fail">Failed${code}</span>`;
      } else if (isSuccess) {
        const code = j.exit_code != null ? ` (exit ${j.exit_code})` : '';
        resultBadge = `<span class="badge badge-success">Completed${code}</span>`;
      } else {
        resultBadge = `<span class="badge-muted">${escapeHtml(j.status || '—')}</span>`;
      }

      // Show a "Technical details" toggle if there's stderr/stdout
      const hasDetails = isInfraFail || (j.stderr && j.stderr.length > 0);
      const detailToggle = hasDetails
        ? `<button class="job-detail-toggle" onclick="document.getElementById('${detailId}').classList.toggle('hidden')">Technical details</button>`
        : '';

      html += `
        <tr id="${rowId}">
          <td>${num}</td>
          <td class="col-subid" title="${escapeHtml(subIdFull)}">${escapeHtml(subId)}</td>
          <td class="col-time">${postMs}</td>
          <td class="col-time">${e2eMs}</td>
          <td>${resultBadge}${hasDetails ? ' ' + detailToggle : ''}</td>
        </tr>
      `;

      if (hasDetails) {
        let detailContent = '';
        if (isInfraFail) {
          detailContent = 'Patchwork could not acquire an available execution container.\n\n';
        }
        detailContent += j.stderr || '';

        html += `
          <tr class="job-error-row hidden" id="${detailId}">
            <td colspan="5">
              <div class="job-error-box">${escapeHtml(detailContent.trim())}</div>
            </td>
          </tr>
        `;
      }
    });

    html += '</tbody></table>';
    jobTableWrap.innerHTML = html;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTimestamp(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
})();
