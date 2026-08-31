import { escapeHtml } from '../escapeHtml';
import { AI_ICON } from '../icons';
import { renderTooltipScript } from '../tooltipScript';

export interface RenderChatOptions {
  nonce: string;
  cspSource: string;
  styleUris: string[];
}

export interface ChatData {
  subjectLabel?: string;
}

/** Builds the chat webview's full HTML document. Pure — nonce/cspSource/styleUris come from the caller, so this is unit-testable without a real webview host. */
export function renderChatHtml(data: ChatData, opts: RenderChatOptions): string {
  const styles = opts.styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n');
  const subject = data.subjectLabel
    ? `<div class="chat-subject">${AI_ICON}<span>Asking about: ${escapeHtml(data.subjectLabel)}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; img-src https: ${opts.cspSource}; script-src 'nonce-${opts.nonce}';" />
${styles}
<title>GitLore Chat</title>
</head>
<body>
<div class="chat-head">
<span class="chat-title">GitLore Chat</span>
<button class="icon-btn" id="new-chat" type="button" data-tooltip="New chat" aria-label="Start a new chat">${AI_ICON}</button>
</div>
${subject}
<div class="chat-messages" id="chat-messages" role="log" aria-live="polite"></div>
<p class="chat-hint" id="chat-hint" role="status" hidden></p>
<div class="chat-tool-status" id="chat-tool-status" role="status" hidden></div>
<form class="chat-input" id="chat-form">
<textarea id="chat-text" placeholder="Ask about this repo's history…" aria-label="Ask GitLore" rows="1"></textarea>
<button class="btn btn-accent" id="chat-send" type="submit">${AI_ICON}Ask</button>
</form>
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('chat-messages');
const hintEl = document.getElementById('chat-hint');
const toolStatusEl = document.getElementById('chat-tool-status');
const form = document.getElementById('chat-form');
const textEl = document.getElementById('chat-text');
const sendBtn = document.getElementById('chat-send');
let currentAssistantBubble = null;

function addBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-' + role;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function autoGrow() {
  textEl.style.height = 'auto';
  textEl.style.height = Math.min(textEl.scrollHeight, 120) + 'px';
}

textEl.addEventListener('input', autoGrow);

textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textEl.value.trim();
  if (!text) {
    return;
  }
  addBubble('user', text);
  textEl.value = '';
  autoGrow();
  sendBtn.disabled = true;
  hintEl.hidden = true;
  currentAssistantBubble = null;
  vscode.postMessage({ type: 'send', text });
});

document.getElementById('new-chat').addEventListener('click', () => {
  messagesEl.innerHTML = '';
  hintEl.hidden = true;
  toolStatusEl.hidden = true;
  sendBtn.disabled = false;
  vscode.postMessage({ type: 'newChat' });
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'chatChunk') {
    if (!currentAssistantBubble) {
      currentAssistantBubble = addBubble('assistant', '');
    }
    currentAssistantBubble.textContent += msg.text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else if (msg.type === 'chatToolCall') {
    toolStatusEl.hidden = false;
    toolStatusEl.textContent = 'Searching commit history (' + msg.name + ')…';
  } else if (msg.type === 'chatToolResult') {
    toolStatusEl.hidden = true;
  } else if (msg.type === 'chatDone') {
    toolStatusEl.hidden = true;
    sendBtn.disabled = false;
  } else if (msg.type === 'chatNoModel') {
    toolStatusEl.hidden = true;
    hintEl.hidden = false;
    hintEl.textContent = msg.message;
    sendBtn.disabled = false;
  } else if (msg.type === 'chatReset') {
    toolStatusEl.hidden = true;
    sendBtn.disabled = false;
  } else if (msg.type === 'chatError') {
    toolStatusEl.hidden = true;
    hintEl.hidden = false;
    hintEl.textContent = 'GitLore: ' + msg.message;
    sendBtn.disabled = false;
  }
});
${renderTooltipScript()}
</script>
</body>
</html>`;
}
