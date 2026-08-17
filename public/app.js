document.addEventListener('DOMContentLoaded', () => {
  // Global state
  let activeTenantId = 1;
  let auditPage = 1;
  let chartInstance = null;
  let confirmCallback = null;

  // DOM Elements
  const tenantSelect = document.getElementById('tenantSelect');
  const keysTableBody = document.getElementById('keysTableBody');
  const auditLogsTableBody = document.getElementById('auditLogsTableBody');
  
  // Stat elements
  const statActiveKeys = document.getElementById('statActiveKeys');
  const statTotalRequests = document.getElementById('statTotalRequests');
  const statRateLimited = document.getElementById('statRateLimited');

  // Tester elements
  const testerApiKeyInput = document.getElementById('testerApiKeyInput');
  const sendSingleRequestBtn = document.getElementById('sendSingleRequestBtn');
  const sendBurstRequestsBtn = document.getElementById('sendBurstRequestsBtn');
  const testerOutputBox = document.getElementById('testerOutputBox');

  // Modals
  const issueKeyModal = document.getElementById('issueKeyModal');
  const revealKeyModal = document.getElementById('revealKeyModal');
  const confirmModal = document.getElementById('confirmModal');

  const openIssueModalBtn = document.getElementById('openIssueModalBtn');
  const closeIssueModalBtn = document.getElementById('closeIssueModalBtn');
  const cancelIssueBtn = document.getElementById('cancelIssueBtn');
  const confirmIssueBtn = document.getElementById('confirmIssueBtn');
  const newKeyRateLimit = document.getElementById('newKeyRateLimit');

  const plaintextKeyDisplay = document.getElementById('plaintextKeyDisplay');
  const closeRevealModalBtn = document.getElementById('closeRevealModalBtn');
  const dismissRevealBtn = document.getElementById('dismissRevealBtn');
  const copyKeyBtn = document.getElementById('copyKeyBtn');

  const confirmModalTitle = document.getElementById('confirmModalTitle');
  const confirmModalMessage = document.getElementById('confirmModalMessage');
  const closeConfirmModalBtn = document.getElementById('closeConfirmModalBtn');
  const cancelConfirmBtn = document.getElementById('cancelConfirmBtn');
  const executeConfirmBtn = document.getElementById('executeConfirmBtn');

  const refreshAuditLogsBtn = document.getElementById('refreshAuditLogsBtn');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  const paginationInfo = document.getElementById('paginationInfo');

  // Initialize App
  init();

  async function init() {
    setupChart();
    await loadTenants();
    await refreshDashboard();
    setupEventListeners();
  }

  function setupEventListeners() {
    tenantSelect.addEventListener('change', async (e) => {
      activeTenantId = parseInt(e.target.value, 10);
      auditPage = 1;
      await refreshDashboard();
    });

    openIssueModalBtn.addEventListener('click', () => openModal(issueKeyModal));
    closeIssueModalBtn.addEventListener('click', () => closeModal(issueKeyModal));
    cancelIssueBtn.addEventListener('click', () => closeModal(issueKeyModal));

    confirmIssueBtn.addEventListener('click', handleIssueKey);

    closeRevealModalBtn.addEventListener('click', () => closeModal(revealKeyModal));
    dismissRevealBtn.addEventListener('click', () => closeModal(revealKeyModal));
    copyKeyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(plaintextKeyDisplay.textContent);
      copyKeyBtn.textContent = 'Copied!';
      setTimeout(() => { copyKeyBtn.textContent = 'Copy'; }, 2000);
    });

    closeConfirmModalBtn.addEventListener('click', () => closeModal(confirmModal));
    cancelConfirmBtn.addEventListener('click', () => closeModal(confirmModal));
    executeConfirmBtn.addEventListener('click', () => {
      if (confirmCallback) confirmCallback();
      closeModal(confirmModal);
    });

    sendSingleRequestBtn.addEventListener('click', () => testProtectedEndpoint(1));
    sendBurstRequestsBtn.addEventListener('click', () => testProtectedEndpoint(6));

    refreshAuditLogsBtn.addEventListener('click', () => loadAuditLogs());
    prevPageBtn.addEventListener('click', () => { if (auditPage > 1) { auditPage--; loadAuditLogs(); } });
    nextPageBtn.addEventListener('click', () => { auditPage++; loadAuditLogs(); });
  }

  // Load Tenants list
  async function loadTenants() {
    try {
      const res = await fetch('/api/tenants');
      if (res.ok) {
        const tenants = await res.json();
        if (tenants.length > 0) {
          tenantSelect.innerHTML = tenants
            .map(t => `<option value="${t.id}">${t.name} (Tenant ID: ${t.id})</option>`)
            .join('');
          activeTenantId = tenants[0].id;
        }
      }
    } catch (err) {
      console.error('Failed to load tenants:', err);
    }
  }

  async function refreshDashboard() {
    await Promise.all([loadApiKeys(), loadAuditLogs()]);
  }

  // Load API Keys
  async function loadApiKeys() {
    try {
      const res = await fetch(`/api/tenants/${activeTenantId}/keys`);
      if (!res.ok) throw new Error('Failed to load keys');
      const keys = await res.json();

      let activeCount = 0;
      if (keys.length === 0) {
        keysTableBody.innerHTML = `<tr><td colspan="7" class="text-center">No API keys found. Issue one to get started!</td></tr>`;
      } else {
        keysTableBody.innerHTML = keys.map(k => {
          if (k.isActive) activeCount++;
          const statusBadge = k.isActive 
            ? `<span class="badge badge-active">Active</span>` 
            : `<span class="badge badge-inactive">Inactive / Revoked</span>`;
          
          const createdAt = new Date(k.createdAt).toLocaleString();
          const expiresAt = k.expiresAt ? new Date(k.expiresAt).toLocaleTimeString() : 'Never';

          return `
            <tr>
              <td>#${k.id}</td>
              <td><code>${k.maskedKey}</code></td>
              <td>${k.rateLimitPerMinute} req/min</td>
              <td>${statusBadge}</td>
              <td>${createdAt}</td>
              <td>${expiresAt}</td>
              <td>
                ${k.isActive ? `
                  <button class="btn btn-sm btn-secondary rotate-key-btn" data-id="${k.id}">Rotate</button>
                  <button class="btn btn-sm btn-danger revoke-key-btn" data-id="${k.id}">Revoke</button>
                ` : '<span class="text-muted">-</span>'}
              </td>
            </tr>
          `;
        }).join('');

        // Attach action handlers
        document.querySelectorAll('.rotate-key-btn').forEach(btn => {
          btn.addEventListener('click', () => promptRotateKey(btn.dataset.id));
        });

        document.querySelectorAll('.revoke-key-btn').forEach(btn => {
          btn.addEventListener('click', () => promptRevokeKey(btn.dataset.id));
        });
      }

      statActiveKeys.textContent = activeCount;
    } catch (err) {
      console.error('Error loading API keys:', err);
      keysTableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error loading API keys</td></tr>`;
    }
  }

  // Issue Key Handler
  async function handleIssueKey() {
    const rateLimit = parseInt(newKeyRateLimit.value || '100', 10);
    try {
      const res = await fetch(`/api/tenants/${activeTenantId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateLimitPerMinute: rateLimit }),
      });

      if (!res.ok) throw new Error('Failed to issue key');
      const data = await res.json();

      closeModal(issueKeyModal);
      plaintextKeyDisplay.textContent = data.apiKey;
      testerApiKeyInput.value = data.apiKey; // auto populate tester input
      openModal(revealKeyModal);

      await refreshDashboard();
    } catch (err) {
      alert('Error issuing API key: ' + err.message);
    }
  }

  // Prompt Rotate Key
  function promptRotateKey(keyId) {
    confirmModalTitle.textContent = 'Rotate API Key';
    confirmModalMessage.textContent = `Are you sure you want to rotate Key #${keyId}? A new key will be generated immediately, and the current key will expire after a 1-minute grace period.`;
    confirmCallback = async () => {
      try {
        const res = await fetch(`/api/keys/${keyId}/rotate`, { method: 'POST' });
        if (!res.ok) throw new Error('Rotation failed');
        const data = await res.json();
        
        plaintextKeyDisplay.textContent = data.newApiKey;
        testerApiKeyInput.value = data.newApiKey;
        openModal(revealKeyModal);
        
        await refreshDashboard();
      } catch (err) {
        alert('Error rotating key: ' + err.message);
      }
    };
    openModal(confirmModal);
  }

  // Prompt Revoke Key
  function promptRevokeKey(keyId) {
    confirmModalTitle.textContent = 'Revoke API Key';
    confirmModalMessage.textContent = `Are you sure you want to revoke Key #${keyId}? It will be invalidated immediately.`;
    confirmCallback = async () => {
      try {
        const res = await fetch(`/api/keys/${keyId}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) throw new Error('Revocation failed');
        await refreshDashboard();
      } catch (err) {
        alert('Error revoking key: ' + err.message);
      }
    };
    openModal(confirmModal);
  }

  // Load Audit Logs & Update Chart
  async function loadAuditLogs() {
    try {
      const res = await fetch(`/api/tenants/${activeTenantId}/audit-logs?page=${auditPage}&limit=10`);
      if (!res.ok) throw new Error('Failed to fetch audit logs');
      const data = await res.json();

      const logs = data.logs || [];
      const pagination = data.pagination || { totalLogs: 0, totalPages: 1 };

      statTotalRequests.textContent = pagination.totalLogs;

      if (logs.length === 0) {
        auditLogsTableBody.innerHTML = `<tr><td colspan="6" class="text-center">No request logs recorded yet.</td></tr>`;
      } else {
        auditLogsTableBody.innerHTML = logs.map(l => {
          let statusBadge = `<span class="badge badge-${l.statusCode}">${l.statusCode}</span>`;
          return `
            <tr>
              <td>#${l.id}</td>
              <td>#${l.apiKeyId}</td>
              <td><code>${l.maskedKey}</code></td>
              <td><code>${l.endpoint}</code></td>
              <td>${statusBadge}</td>
              <td>${new Date(l.timestamp).toLocaleTimeString()}</td>
            </tr>
          `;
        }).join('');
      }

      // Update Pagination UI
      paginationInfo.textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
      prevPageBtn.disabled = pagination.page <= 1;
      nextPageBtn.disabled = pagination.page >= pagination.totalPages;

      // Update Rate limited stat & chart
      const stats = data.hourlyStats || [];
      let rateLimitedSum = 0;
      stats.forEach(s => { rateLimitedSum += parseInt(s.rate_limited_count || '0', 10); });
      statRateLimited.textContent = rateLimitedSum;

      updateChart(stats);
    } catch (err) {
      console.error('Error loading audit logs:', err);
      auditLogsTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Failed to load audit logs</td></tr>`;
    }
  }

  // Interactive Tester
  async function testProtectedEndpoint(burstCount = 1) {
    const key = testerApiKeyInput.value.trim();
    if (!key) {
      alert('Please enter an API key to test!');
      return;
    }

    if (testerOutputBox.querySelector('.output-placeholder')) {
      testerOutputBox.innerHTML = '';
    }

    for (let i = 0; i < burstCount; i++) {
      try {
        const startTime = Date.now();
        const res = await fetch('/api/protected', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        const duration = Date.now() - startTime;
        const retryAfter = res.headers.get('Retry-After');
        const data = await res.json();

        const timestamp = new Date().toLocaleTimeString();
        let logClass = 'success';
        let detailText = `200 OK (${duration}ms)`;

        if (res.status === 429) {
          logClass = 'rate-limited';
          detailText = `429 Too Many Requests | Retry-After: ${retryAfter || data.retryAfter}s`;
        } else if (res.status === 401) {
          logClass = 'error';
          detailText = `401 Unauthorized (${data.error || 'Invalid Key'})`;
        }

        const logElem = document.createElement('div');
        logElem.className = `output-line ${logClass}`;
        logElem.innerHTML = `[${timestamp}] Request #${i + 1}: ${detailText}`;
        testerOutputBox.prepend(logElem);

      } catch (err) {
        const logElem = document.createElement('div');
        logElem.className = 'output-line error';
        logElem.innerHTML = `[${new Date().toLocaleTimeString()}] Request #${i + 1} Failed: ${err.message}`;
        testerOutputBox.prepend(logElem);
      }
    }

    // Refresh logs after testing
    setTimeout(refreshDashboard, 500);
  }

  // Chart setup
  function setupChart() {
    const ctx = document.getElementById('usageChart').getContext('2d');
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Total Requests',
            data: [],
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.15)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Rate Limited (429)',
            data: [],
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            fill: true,
            tension: 0.3,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#9ca3af' } }
        },
        scales: {
          x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
        }
      }
    });
  }

  function updateChart(stats) {
    if (!chartInstance) return;
    chartInstance.data.labels = stats.map(s => s.time_label);
    chartInstance.data.datasets[0].data = stats.map(s => parseInt(s.request_count, 10));
    chartInstance.data.datasets[1].data = stats.map(s => parseInt(s.rate_limited_count || '0', 10));
    chartInstance.update();
  }

  // Helper Modal functions
  function openModal(modal) {
    modal.classList.add('active');
  }

  function closeModal(modal) {
    modal.classList.remove('active');
  }
});
