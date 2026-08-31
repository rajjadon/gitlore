import * as vscode from 'vscode';
import { renderChatHtml } from './render';
import { resolveRepoContextPath } from '../CommitGraph/CommitGraphViewProvider';
import { waitForWebviewView } from '../waitForWebviewView';
import type { ChatService } from '../../ai/ChatService';
import { describeNoModelReason } from '../../core/ai/modelAvailability';
import { MEDIA, VIEWS } from '../../constants';

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/** Docks the chat in the bottom panel, alongside every other GitLore view. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private subjectLabel: string | undefined;
  private chatAbortController: AbortController | undefined;
  private chatMessagesForTest: unknown[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatService: ChatService,
  ) {}

  getCurrentHtmlForTest(): string | undefined {
    return this.view?.webview.html;
  }

  getChatMessagesForTest(): unknown[] {
    return this.chatMessagesForTest;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    this.render();
  }

  /** Called by "Open GitLore Chat" and every "Ask about..." context action — reveals the panel, optionally seeding a subject label shown above the input. */
  async show(subjectLabel?: string): Promise<void> {
    this.chatAbortController?.abort();
    this.chatMessagesForTest = [];
    this.subjectLabel = subjectLabel;
    await vscode.commands.executeCommand(`${VIEWS.chat}.focus`);
    await waitForWebviewView(() => this.view);
    this.render();
  }

  private mediaUri(name: string): string {
    return this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.chat)];
    this.view.webview.html = renderChatHtml(
      { subjectLabel: this.subjectLabel },
      { nonce: createNonce(), cspSource: this.view.webview.cspSource, styleUris },
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { type, text } = message as { type?: unknown; text?: unknown };
    if (type === 'send' && typeof text === 'string') {
      await this.send(text);
      return;
    }
    if (type === 'newChat') {
      this.chatService.newChat();
      this.subjectLabel = undefined;
      this.chatMessagesForTest = [];
      this.render();
    }
  }

  async send(text: string): Promise<void> {
    const filePath = resolveRepoContextPath();
    if (!filePath) {
      this.postChatMessage({ type: 'chatError', message: "open a folder or file in a git repo to use the chat." });
      return;
    }
    this.chatAbortController?.abort();
    const controller = new AbortController();
    this.chatAbortController = controller;

    for await (const event of this.chatService.send(filePath, text, controller.signal)) {
      if (controller.signal.aborted) {
        return;
      }
      switch (event.type) {
        case 'disabled':
          void vscode.window.showInformationMessage('GitLore: AI features are disabled.', 'Open Settings').then((choice) => {
            if (choice) {
              void vscode.commands.executeCommand('workbench.action.openSettings', 'gitLore.ai.enabled');
            }
          });
          this.postChatMessage({ type: 'chatReset' });
          break;
        case 'noModel':
          this.postChatMessage({ type: 'chatNoModel', message: describeNoModelReason(vscode.env.appName) });
          break;
        case 'toolCall':
          this.postChatMessage({ type: 'chatToolCall', name: event.name });
          break;
        case 'toolResult':
          this.postChatMessage({ type: 'chatToolResult', name: event.name });
          break;
        case 'chunk':
          this.postChatMessage({ type: 'chatChunk', text: event.text });
          break;
        case 'done':
          this.postChatMessage({ type: 'chatDone' });
          break;
        case 'error':
          this.postChatMessage({ type: 'chatError', message: event.message });
          break;
      }
    }
  }

  /** Test-only introspection seam — a webview text input can't be driven from an integration test. */
  async sendForTest(text: string): Promise<void> {
    await this.send(text);
  }

  private postChatMessage(message: { type: string; text?: string; name?: string; message?: string }): void {
    this.chatMessagesForTest.push(message);
    void this.view?.webview.postMessage(message);
  }
}
