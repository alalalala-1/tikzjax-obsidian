import { Plugin, MarkdownPostProcessorContext, MarkdownView, EditorPosition, Notice, normalizePath, TFile, Modal } from 'obsidian';
import { TikzJaxSettings, DEFAULT_SETTINGS, TikzCodeBlockInfo, TikzRenderInput } from './types';
import { CacheManager } from './cache-manager';
import { createHash, createCacheKey } from './utils/hash';
import { parseTikzBlock } from './utils/parse';
import { TikzWorkerRenderer } from './tikz-renderer';
import { TikzJaxSettingTab } from './settings';

export default class TikzJaxPlugin extends Plugin {
	settings: TikzJaxSettings = DEFAULT_SETTINGS;
	cacheManager!: CacheManager;
	renderer!: TikzWorkerRenderer;
	private fontsStylesheetEl: HTMLStyleElement | null = null;
	private static readonly REQUIRED_LOCAL_FONTS = [
		'cmr10.woff2',
		'cmmi10.woff2',
		'cmsy10.woff2',
		'cmex10.woff2',
		'cmr7.woff2',
		'cmmi7.woff2',
		'cmsy7.woff2',
		'cmex7.woff2',
		'msbm10.woff2',
		'eufm10.woff2',
	];

	async onload() {
		await this.loadSettings();
		this.applyDynamicStyles();
		await this.ensureFontsStylesheet();
		this.cacheManager = new CacheManager(this.app, this.settings);

		if (this.settings.enableCache) {
			await this.cacheManager.ensureCacheDir();
		}
		if (this.settings.autoCleanCache) {
			const removed = await this.cacheManager.cleanInvalidEntries();
			if (removed > 0) {
				new Notice(`TikzJax: 已清理 ${removed} 个无效缓存文件`);
			}
		}

		this.renderer = new TikzWorkerRenderer(this, () => this.settings);
		try {
			await this.renderer.initialize();
		} catch (error) {
			console.error('TikzJax renderer init failed:', error);
			new Notice('TikzJax 初始化失败，渲染时将重试。');
		}

		this.registerTikzProcessors();

		this.addSettingTab(new TikzJaxSettingTab(this.app, this));

		this.register(() => {
			this.renderer?.destroy();
			this.fontsStylesheetEl?.remove();
			this.fontsStylesheetEl = null;
		});

		console.log('TikzJax plugin loaded');
	}

	private async ensureFontsStylesheet() {
		const existing = document.getElementById('tikzjax-fonts-stylesheet') as HTMLStyleElement | null;
		existing?.remove();

		const fontsCssPath = normalizePath(`${this.manifest.dir}/resources/fonts.css`);
		const requiredFontPaths = TikzJaxPlugin.REQUIRED_LOCAL_FONTS.map((font) =>
			normalizePath(`${this.manifest.dir}/resources/fonts/${font}`)
		);

		try {
			const hasFontsCss = await this.app.vault.adapter.exists(fontsCssPath);
			const requiredFontChecks = await Promise.all(requiredFontPaths.map((path) => this.app.vault.adapter.exists(path)));
			const hasAllRequiredFonts = requiredFontChecks.every(Boolean);

			if (!hasFontsCss || !hasAllRequiredFonts) {
				console.warn('TikzJax: local font assets are incomplete, fallback to CDN fonts.css', {
					hasFontsCss,
					hasAllRequiredFonts,
					requiredFonts: TikzJaxPlugin.REQUIRED_LOCAL_FONTS,
					missingFontPaths: requiredFontPaths.filter((_, idx) => !requiredFontChecks[idx]),
					fontsCssPath,
				});
				new Notice('TikzJax: 本地字体文件不完整，请重新部署插件 release 包。');
				return;
			}

			const rawCss = await this.app.vault.adapter.read(fontsCssPath);
			const inlinedCss = rawCss.replace(/url\((['"]?)(fonts\/[^'")]+)\1\)/g, (_match, _quote, relativeFontPath) => {
				const fontPath = normalizePath(`${this.manifest.dir}/resources/${relativeFontPath}`);
				const fontUrl = this.app.vault.adapter.getResourcePath(fontPath);
				return `url('${fontUrl}')`;
			});

			const style = document.createElement('style');
			style.id = 'tikzjax-fonts-stylesheet';
			style.textContent = inlinedCss;
			document.head.appendChild(style);
			this.fontsStylesheetEl = style;
		} catch (error) {
			console.error('TikzJax: failed to inject TeX fonts CSS.', error);
			new Notice('TikzJax: 字体样式注入失败，请检查控制台日志。');
		}
	}

	private async renderTikzBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		const parsed = parseTikzBlock(source);
		if (!parsed.code) {
			el.createDiv({ cls: 'tikzjax-inline-error', text: 'TikZ code block is empty.' });
			return;
		}

		const cacheKeyStr = createCacheKey(parsed.code, parsed.libraries, parsed.packages, parsed.preamble);
		const hash = await createHash(cacheKeyStr);
		const info: TikzCodeBlockInfo = {
			source: parsed.code,
			libraries: parsed.libraries,
			packages: parsed.packages,
			preamble: parsed.preamble,
			hash,
		};

		const container = el.createDiv({ cls: 'tikzjax-container' });
		const frame = container.createDiv({ cls: 'tikzjax-frame' });
		const timeLabel = frame.createDiv({ cls: 'tikzjax-time-label', text: '⏱ --' });
		const statusLabel = frame.createDiv({ cls: 'tikzjax-status-label' });
		const content = frame.createDiv({ cls: 'tikzjax-content' });
		const toolbar = frame.createDiv({ cls: 'tikzjax-toolbar' });

		let scale = 1;
		let renderNow: (forceRebuild?: boolean) => Promise<void>;

		const applyScale = () => {
			const svg = content.querySelector('svg') as SVGElement | null;
			if (!svg) return;
			svg.style.transformOrigin = 'top center';
			svg.style.transform = `scale(${scale})`;
		};

		const addToolbarButton = (text: string, onClick: () => void, ariaLabel?: string, extraCls?: string) => {
			const button = toolbar.createEl('button', { text, cls: 'tikzjax-toolbar-btn' });
			if (extraCls) {
				button.addClass(extraCls);
			}
			if (ariaLabel) {
				button.setAttr('aria-label', ariaLabel);
			}
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			});
		};

		addToolbarButton('code', () => {
			void this.revealCodeBlock(ctx, el, source);
		}, '显示源码', 'is-code-btn');
		addToolbarButton('Rerender', () => void renderNow(true));
		addToolbarButton('-5%', () => {
			scale = Math.max(0.5, scale - 0.05);
			applyScale();
		});
		addToolbarButton('+5%', () => {
			scale = Math.min(2.5, scale + 0.05);
			applyScale();
		});

		frame.addEventListener('click', (event) => {
			event.stopPropagation();
			toolbar.addClass('is-visible');
		});

		const onDocClick = (event: MouseEvent) => {
			if (!frame.contains(event.target as Node)) {
				toolbar.removeClass('is-visible');
			}
		};
		document.addEventListener('click', onDocClick, true);
		this.register(() => document.removeEventListener('click', onDocClick, true));

		renderNow = async (forceRebuild = false) => {
			const startTime = Date.now();
			statusLabel.empty();
			content.empty();
			content.removeClass('is-error');
			content.addClass('is-loading');

			const spinner = content.createDiv({ cls: 'tikzjax-loading' });
			spinner.createDiv({ cls: 'tikzjax-spinner' });
			spinner.createDiv({ cls: 'tikzjax-loading-text', text: 'Rendering TikZ...' });

			const updateTimer = () => {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				timeLabel.setText(`⏱ ${elapsed}s`);
			};
			updateTimer();
			const timer = window.setInterval(updateTimer, 100);

			try {
				if (!forceRebuild && this.settings.autoLoadCache) {
					const cached = await this.cacheManager.get(info.hash);
					if (cached) {
						this.mountRenderedOutput(content, cached);
						statusLabel.setText('cached');
						statusLabel.setAttr('data-kind', 'cached');
						applyScale();
						return;
					}
				}

				const input: TikzRenderInput = {
					source: info.source,
					libraries: info.libraries,
					packages: info.packages,
					preamble: info.preamble,
					showConsole: this.settings.showTexConsole,
				};

				const html = await this.renderer.render(input, this.settings.renderTimeoutMs);
				this.mountRenderedOutput(content, html);
				statusLabel.setText('rendered');
				statusLabel.setAttr('data-kind', 'rendered');
				applyScale();

				if (this.settings.enableCache) {
					await this.cacheManager.set(info.hash, html);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				content.empty();
				content.removeClass('is-loading');
				content.addClass('is-error');
				content.createDiv({ cls: 'tikzjax-error-logo', text: '⚠' });
				content.createDiv({ cls: 'tikzjax-error-title', text: 'TikZ 渲染失败' });
				content.createDiv({ cls: 'tikzjax-error-message', text: message });
				statusLabel.setText('failed');
				statusLabel.setAttr('data-kind', 'failed');
			} finally {
				window.clearInterval(timer);
				const duration = ((Date.now() - startTime) / 1000).toFixed(1);
				timeLabel.setText(`⏱ ${duration}s`);
			}
		};

		if (this.settings.lazyRender && typeof IntersectionObserver !== 'undefined') {
			content.createDiv({ cls: 'tikzjax-lazy-tip', text: 'Scroll into view to render TikZ' });
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							observer.disconnect();
							void renderNow(false);
							break;
						}
					}
				},
				{ rootMargin: '300px 0px 300px 0px' }
			);
			observer.observe(frame);
			this.register(() => observer.disconnect());
		} else {
			void renderNow(false);
		}
	}

	private mountRenderedOutput(content: HTMLElement, html: string) {
		content.empty();
		content.removeClass('is-loading');

		const wrapper = document.createElement('div');
		wrapper.innerHTML = html;
		const svg = wrapper.querySelector('svg');

		if (svg) {
			content.appendChild(svg.cloneNode(true));
			return;
		}

		if (html.includes('<svg')) {
			const parser = new DOMParser();
			const svgDoc = parser.parseFromString(html, 'image/svg+xml');
			if (!svgDoc.querySelector('parsererror') && svgDoc.documentElement.tagName.toLowerCase() === 'svg') {
				content.appendChild(svgDoc.documentElement);
				return;
			}
		}

		throw new Error('TeX 引擎未返回有效 SVG 输出。');
	}

	private async revealCodeBlock(ctx: MarkdownPostProcessorContext, blockEl: HTMLElement, source: string) {
		const focused = await this.focusCodeBlock(ctx, blockEl, source);
		if (focused) return;

		this.openSourceModal(source);
		new Notice('未能定位到编辑器，已弹出源码并自动全选。');
	}

	private async focusCodeBlock(ctx: MarkdownPostProcessorContext, blockEl: HTMLElement, source: string): Promise<boolean> {
		try {
			const section = ctx.getSectionInfo?.(blockEl);
			const sourcePath = ctx.sourcePath;

			let view = await this.getTargetMarkdownView(sourcePath);
			if (!view) {
				return false;
			}

			const switched = await this.ensureSourceMode(view, sourcePath);
			if (!switched) {
				return false;
			}

			view = (await this.getTargetMarkdownView(sourcePath)) ?? view;

			const editor = await this.waitForEditor(view, sourcePath);
			if (!editor) {
				return false;
			}

			let range = section ? this.resolveCodeFenceRange(editor, section.lineStart, section.lineEnd) : null;
			if (!range) {
				range = this.findCodeFenceRangeBySource(editor, source);
			}

			if (!range) {
				return false;
			}

			const from: EditorPosition = { line: range.fromLine, ch: 0 };
			const to: EditorPosition = { line: range.toLine, ch: range.toCh };
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
			editor.focus?.();
			return true;
		} catch (error) {
			console.error('TikzJax: focusCodeBlock failed.', error);
			return false;
		}
	}

	private openSourceModal(source: string) {
		const fenced = this.buildFencedSource(source);
		const pluginApp = this.app;

		class TikzSourceModal extends Modal {
			constructor(private readonly text: string) {
				super(pluginApp);
			}

			onOpen() {
				this.setTitle('TikZ 源代码');
				this.contentEl.createDiv({
					cls: 'tikzjax-source-modal-hint',
					text: '已自动全选，你可以直接复制或编辑后替换。',
				});
				const textarea = this.contentEl.createEl('textarea', {
					cls: 'tikzjax-source-modal',
					text: this.text,
				});
				textarea.readOnly = false;
				window.setTimeout(() => {
					textarea.focus();
					textarea.select();
				}, 0);
			}
		}
		new TikzSourceModal(fenced).open();
	}

	private buildFencedSource(source: string): string {
		const normalized = source.replace(/\r\n/g, '\n').trim();
		return `\`\`\`tikz\n${normalized}\n\`\`\``;
	}

	private async getTargetMarkdownView(sourcePath?: string): Promise<MarkdownView | null> {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!sourcePath) {
			return view;
		}

		if (view?.file?.path === sourcePath) {
			return view;
		}

		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const leafView = leaf.view;
			if (leafView instanceof MarkdownView && leafView.file?.path === sourcePath) {
				this.app.workspace.setActiveLeaf(leaf, true, true);
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? leafView;
				if (view.file?.path === sourcePath) {
					return view;
				}
			}
		}

		const targetFile = this.app.vault.getAbstractFileByPath(sourcePath);
		if (targetFile instanceof TFile) {
			const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(false);
			await leaf.openFile(targetFile, { active: true });
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file?.path === sourcePath) {
				return view;
			}
		}

		return view;
	}

	private async waitForEditor(view: MarkdownView, sourcePath?: string): Promise<MarkdownView['editor'] | null> {
		let currentView = view;
		for (let i = 0; i < 20; i++) {
			if (currentView.editor) {
				return currentView.editor;
			}

			await new Promise<void>((resolve) => window.setTimeout(resolve, 25));

			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && (!sourcePath || activeView.file?.path === sourcePath)) {
				currentView = activeView;
			}
		}

		return currentView.editor ?? null;
	}

	private async ensureSourceMode(view: MarkdownView, sourcePath?: string): Promise<boolean> {
		if (view.getMode() === 'source') {
			return true;
		}

		try {
			const leaf = (view as unknown as { leaf?: { setViewState?: (state: unknown, pushHistory?: boolean) => Promise<void> } }).leaf;
			const activeFilePath = sourcePath ?? view.file?.path ?? this.app.workspace.getActiveFile()?.path;
			if (leaf?.setViewState && activeFilePath) {
				await leaf.setViewState(
					{
						type: 'markdown',
						state: {
							file: activeFilePath,
							mode: 'source',
						},
						active: true,
					},
					true
				);
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				if (view.getMode() === 'source') {
					return true;
				}
			}
		} catch (error) {
			console.warn('TikzJax: setViewState source-mode switch failed.', error);
		}

		try {
			const setMode = (view as unknown as { setMode?: (mode: string) => Promise<void> | void }).setMode;
			if (typeof setMode === 'function') {
				await Promise.resolve(setMode.call(view, 'source'));
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				if (view.getMode() === 'source') {
					return true;
				}
			}
		} catch (error) {
			console.warn('TikzJax: setMode source-mode switch failed.', error);
		}

		const commands = (this.app as unknown as {
			commands?: {
				executeCommandById?: (id: string) => boolean;
				commands?: Record<string, unknown>;
			};
		}).commands as {
			executeCommandById?: (id: string) => boolean;
			commands?: Record<string, unknown>;
		};
		const candidateCommands = ['markdown:toggle-source', 'markdown:open-source-view'];
		for (const commandId of candidateCommands) {
			if (!commands.commands?.[commandId]) continue;
			commands.executeCommandById?.(commandId);
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView?.getMode() === 'source' && (!sourcePath || activeView.file?.path === sourcePath)) {
				return true;
			}
			if (view.getMode() === 'source') {
				return true;
			}
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.getMode() === 'source' || view.getMode() === 'source';
	}

	private resolveCodeFenceRange(editor: MarkdownView['editor'], sectionLineStart: number, sectionLineEnd: number) {
		const lineCount = editor.lineCount();
		const safeStart = Math.max(0, Math.min(sectionLineStart, lineCount - 1));
		const safeEnd = Math.max(safeStart, Math.min(sectionLineEnd, lineCount - 1));

		const searchStart = Math.max(0, safeStart - 3);
		const searchEnd = Math.min(lineCount - 1, safeEnd + 8);

		let fenceStart = -1;
		for (let line = searchStart; line <= searchEnd; line++) {
			const text = editor.getLine(line)?.trim() ?? '';
			if (/^```(?:tikz|tikzjax)\b/i.test(text)) {
				fenceStart = line;
				break;
			}
		}

		if (fenceStart === -1) {
			for (let line = searchStart; line <= searchEnd; line++) {
				const text = editor.getLine(line)?.trim() ?? '';
				if (/^```/.test(text)) {
					fenceStart = line;
					break;
				}
			}
		}

		if (fenceStart === -1) {
			fenceStart = safeStart;
		}

		let fenceEnd = -1;
		const fenceEndSearchMax = Math.min(lineCount - 1, fenceStart + 600);
		for (let line = fenceStart + 1; line <= fenceEndSearchMax; line++) {
			const text = editor.getLine(line)?.trim() ?? '';
			if (/^```\s*$/.test(text)) {
				fenceEnd = line;
				break;
			}
		}

		if (fenceEnd === -1) {
			fenceEnd = safeEnd;
		}

		const toCh = (editor.getLine(fenceEnd) ?? '').length;
		return {
			fromLine: fenceStart,
			toLine: fenceEnd,
			toCh,
		};
	}

	private findCodeFenceRangeBySource(editor: MarkdownView['editor'], source: string) {
		const normalizedSource = this.normalizeSourceForMatch(source);
		if (!normalizedSource) return null;

		const lineCount = editor.lineCount();

		const tryMatchByFence = (fenceRegex: RegExp) => {
			for (let line = 0; line < lineCount; line++) {
				const fenceLine = editor.getLine(line)?.trim() ?? '';
				if (!fenceRegex.test(fenceLine)) continue;

				const fenceEnd = this.findClosingFenceLine(editor, line + 1, Math.min(lineCount - 1, line + 1200));
				if (fenceEnd === -1) continue;

				const bodyLines: string[] = [];
				for (let i = line + 1; i < fenceEnd; i++) {
					bodyLines.push(editor.getLine(i) ?? '');
				}

				const normalizedBody = this.normalizeSourceForMatch(bodyLines.join('\n'));
				if (normalizedBody === normalizedSource) {
					return {
						fromLine: line,
						toLine: fenceEnd,
						toCh: (editor.getLine(fenceEnd) ?? '').length,
					};
				}

				line = fenceEnd;
			}

			return null;
		};

		const exactFenceMatch = tryMatchByFence(/^```(?:tikz|tikzjax)\b/i);
		if (exactFenceMatch) return exactFenceMatch;

		const genericFenceMatch = tryMatchByFence(/^```/);
		if (genericFenceMatch) return genericFenceMatch;

		const sourceLines = normalizedSource.split('\n').map((line) => line.trim());
		if (sourceLines.length === 0) return null;

		const firstLine = sourceLines[0];
		const maxStart = Math.max(0, lineCount - sourceLines.length);

		for (let start = 0; start <= maxStart; start++) {
			const lineText = (editor.getLine(start) ?? '').trim();
			if (lineText !== firstLine) continue;

			let matched = true;
			for (let offset = 1; offset < sourceLines.length; offset++) {
				const candidate = (editor.getLine(start + offset) ?? '').trim();
				if (candidate !== sourceLines[offset]) {
					matched = false;
					break;
				}
			}

			if (matched) {
				return this.resolveCodeFenceRange(editor, start, start + sourceLines.length - 1);
			}
		}

		const fullText = editor.getValue?.();
		if (typeof fullText === 'string') {
			const idx = fullText.indexOf(normalizedSource);
			if (idx >= 0) {
				const before = fullText.slice(0, idx);
				const fromLine = before.split('\n').length - 1;
				const toLine = Math.min(lineCount - 1, fromLine + sourceLines.length - 1);
				return this.resolveCodeFenceRange(editor, fromLine, toLine);
			}
		}

		return null;
	}

	private normalizeSourceForMatch(source: string): string {
		return source
			.replace(/\r\n/g, '\n')
			.split('\n')
			.map((line) => line.replace(/\s+$/g, ''))
			.join('\n')
			.trim();
	}

	private findClosingFenceLine(editor: MarkdownView['editor'], startLine: number, maxLine: number): number {
		for (let line = startLine; line <= maxLine; line++) {
			const text = editor.getLine(line)?.trim() ?? '';
			if (/^```\s*$/.test(text)) {
				return line;
			}
		}

		return -1;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyDynamicStyles();
		this.cacheManager?.updateSettings(this.settings);
		if (this.settings.enableCache) {
			await this.cacheManager.ensureCacheDir();
		}
	}

	async updateSettings(partial: Partial<TikzJaxSettings>) {
		this.settings = { ...this.settings, ...partial };
		await this.saveSettings();
	}

	private applyDynamicStyles() {
		document.documentElement.style.setProperty(
			'--tikzjax-cache-label-color',
			this.settings.cacheStatusLabelColor || '#c62828'
		);
	}

	onunload() {
		this.renderer?.destroy();
		this.fontsStylesheetEl?.remove();
		this.fontsStylesheetEl = null;
	}

	private registerTikzProcessors() {
		const render = async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			await this.renderTikzBlock(source, el, ctx);
		};

		// Always provide a conflict-free language for this plugin.
		this.registerMarkdownCodeBlockProcessor('tikzjax', render);

		// Try to hook `tikz` too. If another plugin already owns it, keep running without failing.
		try {
			this.registerMarkdownCodeBlockProcessor('tikz', render);
		} catch (error) {
			console.warn('TikzJax: `tikz` code block is already handled by another plugin. Use ```tikzjax for this plugin.', error);
			new Notice('TikzJax: 检测到已有 tikz 代码块处理器，请使用 ```tikzjax。');
		}
	}
}
