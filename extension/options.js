const DEFAULT = 'http://127.0.0.1:41417';
const input = document.getElementById('bridgeUrl');
const status = document.getElementById('status');

chrome.storage.sync.get({ bridgeUrl: DEFAULT }, ({ bridgeUrl }) => { input.value = bridgeUrl; check(bridgeUrl); });

document.getElementById('save').addEventListener('click', () => {
  const url = (input.value.trim() || DEFAULT).replace(/\/$/, '');
  chrome.storage.sync.set({ bridgeUrl: url }, () => { input.value = url; check(url); });
});

async function check(url) {
  status.textContent = 'Checking bridge…';
  try {
    const s = await fetch(`${url}/status`).then((r) => r.json());
    status.textContent = '';
    const ul = document.createElement('ul');
    for (const a of s.agents) {
      const li = document.createElement('li');
      li.textContent = a.connected
        ? `Agent ${a.name}: connected (${a.connected})`
        : `Agent ${a.name}: not connected — in Claude Code run /ide and pick "${a.ideName}"`;
      ul.appendChild(li);
    }
    status.appendChild(ul);
  } catch {
    status.textContent = 'Bridge not reachable. Start it with: mdclaude';
  }
}
