document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleEnabled = document.getElementById('toggle-enabled');
  const btnApiKey = document.getElementById('btn-api-key');
  const secApiKey = document.getElementById('sec-api-key');
  const inputApiKey = document.getElementById('input-api-key');
  const saveApiKey = document.getElementById('save-api-key');
  const apiStatus = document.getElementById('api-status');

  const btnLogs = document.getElementById('btn-logs');
  const secLogs = document.getElementById('sec-logs');
  const logsContainer = document.getElementById('logs-container');
  const clearLogsBtn = document.getElementById('clear-logs');
  const logCount = document.getElementById('log-count');

  const lockSlider = document.getElementById('lock-duration-slider');
  const lockDisplay = document.getElementById('lock-duration-display');

  // Load state from storage
  const storage = await chrome.storage.local.get({
    enabled: true,
    apiKey: '',
    logs: [],
    lockDuration: 30
  });

  // Init UI
  toggleEnabled.checked = storage.enabled;

  // Init lock duration slider
  lockSlider.value = storage.lockDuration;
  lockDisplay.textContent = formatDuration(storage.lockDuration);

  if (storage.apiKey && !storage.apiKey.startsWith('PASTE_')) {
    inputApiKey.value = storage.apiKey;
    apiStatus.textContent = 'Configured';
    apiStatus.style.color = '#4dabf7';
  }

  renderLogs(storage.logs);

  // Toggle sections
  btnApiKey.addEventListener('click', () => {
    secApiKey.classList.toggle('active');
    if (secApiKey.classList.contains('active')) inputApiKey.focus();
  });

  btnLogs.addEventListener('click', () => {
    secLogs.classList.toggle('active');
  });

  // Event Listeners
  toggleEnabled.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ enabled: e.target.checked });
  });

  saveApiKey.addEventListener('click', async () => {
    const key = inputApiKey.value.trim();
    await chrome.storage.local.set({ apiKey: key });
    apiStatus.textContent = key ? 'Configured' : 'Not Set';
    apiStatus.style.color = key ? '#4dabf7' : 'inherit';
    secApiKey.classList.remove('active');
  });

  clearLogsBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ logs: [] });
    renderLogs([]);
  });

  // Lock Duration Slider
  lockSlider.addEventListener('input', () => {
    lockDisplay.textContent = formatDuration(parseInt(lockSlider.value));
  });
  lockSlider.addEventListener('change', async () => {
    await chrome.storage.local.set({ lockDuration: parseInt(lockSlider.value) });
  });

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  function renderLogs(logs) {
    logCount.textContent = logs.length > 0 ? `${logs.length} NEW` : '0';
    if (logs.length === 0) {
      logsContainer.innerHTML = '<div class="log-entry">No logs yet.</div>';
      return;
    }

    logsContainer.innerHTML = logs.reverse().map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="log-entry"><span class="log-time">[${time}]</span> ${log.message}</div>`;
    }).join('');
  }
});
