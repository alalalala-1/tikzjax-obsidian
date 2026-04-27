import {
	Plugin,
	MarkdownPostProcessorContext,
	MarkdownView,
	EditorPosition,
	Notice,
	normalizePath,
	TFile,
	Modal,
	Platform,
	type MarkdownSectionInformation,
} from 'obsidian';
import { TikzJaxSettings, DEFAULT_SETTINGS, TikzCodeBlockInfo, TikzRenderInput } from './types';
import { CacheManager } from './cache-manager';
import { createHash, createCacheKey } from './utils/hash';
import { parseTikzBlock } from './utils/parse';
import { TikzWorkerRenderer, type RenderTelemetryEvent } from './tikz-renderer';
import { TikzJaxSettingTab } from './settings';

interface RenderPerfStats {
	cacheHits: number;
	cacheMisses: number;
	workerRenders: number;
	workerFailures: number;
	workerTimeouts: number;
	queueWaitTotalMs: number;
	workerDurationTotalMs: number;
	maxQueueWaitMs: number;
	maxWorkerDurationMs: number;
	maxQueuedAhead: number;
	lastErrors: string[];
}

interface CodeFocusTarget {
	sourcePath?: string;
	sectionLineStart?: number;
	sectionLineEnd?: number;
}

export default class TikzJaxPlugin extends Plugin {
	settings: TikzJaxSettings = DEFAULT_SETTINGS;
	cacheManager!: CacheManager;
	renderer!: TikzWorkerRenderer;
	private fontsStylesheetEl: HTMLStyleElement | null = null;
	private static readonly MAX_QUEUE_WAIT_FOR_SLOT_MS = 2500;
	private static readonly QUEUE_WAIT_SLICE_MS = 60;
	private static readonly NORMAL_RENDER_QUEUE_LIMIT = 3;
	private static readonly FORCED_RENDER_QUEUE_LIMIT = 6;
	private renderPerfStats: RenderPerfStats = this.createEmptyPerfStats();
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

		this.renderer = new TikzWorkerRenderer(this, () => this.settings, (event) => this.recordRendererTelemetry(event));
		try {
			await this.renderer.initialize();
		} catch (error) {
			console.error('TikzJax renderer init failed:', error);
			new Notice('TikzJax 初始化失败，渲染时将重试。');
		}

		this.registerTikzProcessors();
		this.registerPerformanceCommands();

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
		const isMobileRuntime = Platform.isMobile;
		const minScale = 0.5;
		const maxScale = 2.5;
		let lastReservedMinWidth = '';
		let lastReservedMinHeight = '';
		let lastAppliedScaleSignature = '';

		const clampScale = (value: number) => {
			if (!Number.isFinite(value)) return 1;
			return Math.min(maxScale, Math.max(minScale, value));
		};

		const normalizeScale = (value: number) => Math.round(clampScale(value) * 100) / 100;

		if (isMobileRuntime) {
			timeLabel.style.fontSize = '9px';
			timeLabel.style.padding = '2.5px 6px';
			statusLabel.style.fontSize = '9px';
			statusLabel.style.padding = '2.5px 6px';
		}

		let scale = normalizeScale(this.settings.scaleByHash[info.hash] ?? 1);
		let renderNow: (forceRebuild?: boolean, options?: { keepToolbarVisible?: boolean }) => Promise<void>;
		let isRendering = false;
		let suppressHideUntil = 0;

		const persistScale = () => {
			scale = normalizeScale(scale);
			const currentScaleByHash = this.settings.scaleByHash ?? {};
			const currentValue = currentScaleByHash[info.hash];

			if (scale === 1 && currentValue === undefined) {
				return;
			}
			if (currentValue !== undefined && Math.abs(currentValue - scale) < 0.0001) {
				return;
			}

			const nextScaleByHash = { ...currentScaleByHash };
			if (scale === 1) {
				delete nextScaleByHash[info.hash];
			} else {
				nextScaleByHash[info.hash] = scale;
			}

			void this.updateSettings({ scaleByHash: nextScaleByHash });
		};

		const keepToolbarVisible = (suppressMs = 0) => {
			toolbar.addClass('is-visible');
			if (suppressMs > 0) {
				suppressHideUntil = Math.max(suppressHideUntil, Date.now() + suppressMs);
			}
		};

		const reserveLoadingSpace = () => {
			const existingSvg = content.querySelector('svg') as SVGElement | null;
			const rect = existingSvg?.getBoundingClientRect() ?? content.getBoundingClientRect();
			let width = Math.max(0, Math.ceil(rect.width));
			let height = Math.max(0, Math.ceil(rect.height));

			if (!existingSvg) {
				const containerWidth = Math.max(0, Math.ceil(container.getBoundingClientRect().width));
				const fallbackWidth = Math.max(360, Math.min(760, Math.round(containerWidth * 0.72)));
				const fallbackHeight = Math.max(220, Math.round(fallbackWidth * 0.62));
				width = Math.max(width, fallbackWidth);
				height = Math.max(height, fallbackHeight);
			}

			const nextMinWidth = width > 0 ? `${Math.max(320, width)}px` : '';
			const nextMinHeight = height > 0 ? `${Math.max(210, height)}px` : '';

			if (nextMinWidth && nextMinWidth !== lastReservedMinWidth) {
				content.style.minWidth = nextMinWidth;
				lastReservedMinWidth = nextMinWidth;
			}
			if (nextMinHeight && nextMinHeight !== lastReservedMinHeight) {
				content.style.minHeight = nextMinHeight;
				lastReservedMinHeight = nextMinHeight;
			}
		};

		const clearLoadingSpace = () => {
			if (lastReservedMinWidth) {
				content.style.removeProperty('min-width');
				lastReservedMinWidth = '';
			}
			if (lastReservedMinHeight) {
				content.style.removeProperty('min-height');
				lastReservedMinHeight = '';
			}
		};

		const applyScale = () => {
			const svg = content.querySelector('svg') as SVGElement | null;
			if (!svg) return;

			let baseWidth = Number(svg.dataset.tikzBaseWidth || 0);
			let baseHeight = Number(svg.dataset.tikzBaseHeight || 0);

			if (!(baseWidth > 0 && baseHeight > 0)) {
				const vb = svg.viewBox?.baseVal;
				if (vb && vb.width > 0 && vb.height > 0) {
					baseWidth = vb.width;
					baseHeight = vb.height;
				} else {
					const parsedW = Number.parseFloat(svg.getAttribute('width') || '');
					const parsedH = Number.parseFloat(svg.getAttribute('height') || '');
					if (Number.isFinite(parsedW) && parsedW > 0 && Number.isFinite(parsedH) && parsedH > 0) {
						baseWidth = parsedW;
						baseHeight = parsedH;
					}
				}

				if (!(baseWidth > 0 && baseHeight > 0)) {
					const rect = svg.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						baseWidth = rect.width;
						baseHeight = rect.height;
					}
				}

				if (!(baseWidth > 0 && baseHeight > 0)) {
					return;
				}

				svg.dataset.tikzBaseWidth = String(baseWidth);
				svg.dataset.tikzBaseHeight = String(baseHeight);
			}

			const scaledWidth = Math.max(1, baseWidth * scale);
			const scaledHeight = Math.max(1, baseHeight * scale);
			const outerPadding = 20;
			const signature = `${scaledWidth}|${scaledHeight}|${outerPadding}`;
			if (signature === lastAppliedScaleSignature) {
				return;
			}
			lastAppliedScaleSignature = signature;

			svg.style.transform = 'none';
			svg.style.width = `${scaledWidth}px`;
			svg.style.height = `${scaledHeight}px`;
			svg.style.maxWidth = 'none';
			svg.style.maxHeight = 'none';

			content.style.padding = `${outerPadding}px`;
			const scaledMinWidth = `${Math.ceil(scaledWidth + outerPadding * 2)}px`;
			const scaledMinHeight = `${Math.ceil(scaledHeight + outerPadding * 2)}px`;
			if (scaledMinWidth !== lastReservedMinWidth) {
				content.style.minWidth = scaledMinWidth;
				lastReservedMinWidth = scaledMinWidth;
			}
			if (scaledMinHeight !== lastReservedMinHeight) {
				content.style.minHeight = scaledMinHeight;
				lastReservedMinHeight = scaledMinHeight;
			}
		};

		const addToolbarButton = (
			text: string,
			onClick: () => void,
			ariaLabel?: string,
			extraCls?: string,
			showToolbarAfterClick = true,
		) => {
			const button = toolbar.createEl('button', { text, cls: 'tikzjax-toolbar-btn' });
			if (isMobileRuntime) {
				button.style.setProperty('font-size', '13px', 'important');
				button.style.setProperty('font-weight', '400', 'important');
				button.style.setProperty('line-height', '1', 'important');
				button.style.setProperty('padding', '2.5px 6px', 'important');
				button.style.setProperty('border-radius', '6px', 'important');
				button.style.setProperty('box-shadow', 'none', 'important');
				button.style.setProperty('min-width', '0', 'important');
				button.style.setProperty('min-height', '0', 'important');
				button.style.setProperty('width', 'auto', 'important');
				button.style.setProperty('height', 'auto', 'important');
				button.style.setProperty('display', 'inline-flex', 'important');
				button.style.setProperty('align-items', 'center', 'important');
				button.style.setProperty('justify-content', 'center', 'important');
				button.style.setProperty('white-space', 'nowrap', 'important');
			}
			if (extraCls) {
				button.addClass(extraCls);
			}
			if (ariaLabel) {
				button.setAttr('aria-label', ariaLabel);
			}
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (showToolbarAfterClick) {
					keepToolbarVisible(600);
				}
				onClick();
			});
		};

		addToolbarButton('Code', () => {
			const traceId = this.createTraceId('code');
			const focusTarget = this.captureCodeFocusTarget(ctx, el);
			this.logTexDebug('code-button click captured', {
				traceId,
				focusTarget,
			});
			window.setTimeout(() => {
				void this.revealCodeBlock(source, focusTarget, traceId);
			}, 0);
		}, '显示源码', 'is-code-btn');
		addToolbarButton('Rerender', () => void renderNow(true, { keepToolbarVisible: false }), undefined, undefined, false);
		addToolbarButton('-5%', () => {
			scale = normalizeScale(scale - 0.05);
			applyScale();
			persistScale();
		});
		addToolbarButton('+5%', () => {
			scale = normalizeScale(scale + 0.05);
			applyScale();
			persistScale();
		});
		addToolbarButton('Reset', () => {
			scale = 1;
			applyScale();
			persistScale();
		});

		frame.addEventListener('click', (event) => {
			event.stopPropagation();
			keepToolbarVisible();
		});

		const onDocClick = (event: MouseEvent) => {
			if (isRendering || Date.now() < suppressHideUntil) {
				return;
			}

			const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
			const clickedInsideFrame = path.length > 0 ? path.includes(frame) : frame.contains(event.target as Node);
			if (!clickedInsideFrame) {
				toolbar.removeClass('is-visible');
			}
		};
		document.addEventListener('click', onDocClick, true);
		this.register(() => document.removeEventListener('click', onDocClick, true));

		renderNow = async (forceRebuild = false, options) => {
			const keepToolbarDuringRender = options?.keepToolbarVisible ?? false;
			const startTime = Date.now();
			const hashLabel = info.hash.slice(0, 12);
			let keepReservedSpaceForError = false;
			let keepScaledLayout = false;
			isRendering = true;
			if (keepToolbarDuringRender) {
				keepToolbarVisible(800);
			} else {
				toolbar.removeClass('is-visible');
			}
			reserveLoadingSpace();
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
					this.logTexDebug('cache lookup', {
						hash: hashLabel,
						queueDepth: this.renderer.getQueueDepth(),
					});
					const cached = await this.cacheManager.get(info.hash);
					if (cached) {
						this.renderPerfStats.cacheHits += 1;
						this.logTexDebug('cache hit', {
							hash: hashLabel,
							htmlLength: cached.length,
						});
						this.mountRenderedOutput(content, cached);
						statusLabel.setText('cached');
						statusLabel.setAttr('data-kind', 'cached');
						applyScale();
						keepScaledLayout = true;
						return;
					}
					this.renderPerfStats.cacheMisses += 1;
					this.logTexDebug('cache miss', { hash: hashLabel });
				}

				const queueDepthBeforeSlotWait = this.renderer.getQueueDepth();
				this.logTexDebug('render start', {
					hash: hashLabel,
					forceRebuild,
					timeoutMs: this.settings.renderTimeoutMs,
					queueDepth: queueDepthBeforeSlotWait,
				});
				await this.waitForRenderSlot(forceRebuild);

				const input: TikzRenderInput = {
					source: info.source,
					libraries: info.libraries,
					packages: info.packages,
					preamble: info.preamble,
					showConsole: this.settings.showTexConsole,
				};

				const baseTimeoutMs = Math.max(1000, Math.round(this.settings.renderTimeoutMs));
				const retryTimeoutMs = this.getExtendedTimeoutForRetry(baseTimeoutMs);
				let retriedAfterTimeout = false;
				let html: string;

				try {
					html = await this.renderer.render(input, baseTimeoutMs);
				} catch (error) {
					if (retryTimeoutMs && this.isRenderTimeoutError(error)) {
						retriedAfterTimeout = true;
						statusLabel.setText(`retry ${Math.round(retryTimeoutMs / 1000)}s`);
						statusLabel.setAttr('data-kind', 'retry');
						this.logTexDebug('render timeout, retrying once with extended timeout', {
							hash: hashLabel,
							baseTimeoutMs,
							retryTimeoutMs,
						});
						html = await this.renderer.render(input, retryTimeoutMs);
					} else {
						throw error;
					}
				}

				this.mountRenderedOutput(content, html);
				statusLabel.setText('rendered');
				statusLabel.setAttr('data-kind', 'rendered');
				applyScale();
				keepScaledLayout = true;
				this.logTexDebug('render success', {
					hash: hashLabel,
					durationMs: Date.now() - startTime,
					htmlLength: html.length,
					queueDepth: this.renderer.getQueueDepth(),
					retriedAfterTimeout,
					baseTimeoutMs,
					retryTimeoutMs: retriedAfterTimeout ? retryTimeoutMs : undefined,
				});

				if (this.settings.enableCache) {
					await this.cacheManager.set(info.hash, html);
					this.logTexDebug('cache store success', {
						hash: hashLabel,
						htmlLength: html.length,
					});
				}
			} catch (error) {
				const rawMessage = error instanceof Error ? error.message : String(error);
				const message = this.isRenderTimeoutError(error)
					? `${rawMessage}（可在设置中提高 Render timeout，当前 ${this.settings.renderTimeoutMs}ms）`
					: rawMessage;
				keepReservedSpaceForError = true;
				this.logTexDebug('render failed', {
					hash: hashLabel,
					forceRebuild,
					timeoutMs: this.settings.renderTimeoutMs,
					queueDepth: this.renderer.getQueueDepth(),
					durationMs: Date.now() - startTime,
					message,
				});
				content.empty();
				content.removeClass('is-loading');
				content.addClass('is-error');
				content.createDiv({ cls: 'tikzjax-error-logo', text: '⚠' });
				content.createDiv({ cls: 'tikzjax-error-title', text: 'TikZ 渲染失败' });
				content.createDiv({ cls: 'tikzjax-error-message', text: message });
				statusLabel.setText('failed');
				statusLabel.setAttr('data-kind', 'failed');
			} finally {
				isRendering = false;
				if (keepToolbarDuringRender) {
					keepToolbarVisible(180);
				}
				if (!keepReservedSpaceForError && !keepScaledLayout) {
					clearLoadingSpace();
				}
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
							const staggerMs = Math.min(500, Math.max(0, this.renderer.getQueueDepth()) * 50);
							window.setTimeout(() => {
								void renderNow(false);
							}, staggerMs);
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

	private async waitForRenderSlot(forceRebuild: boolean): Promise<void> {
		const queueLimit = forceRebuild ? TikzJaxPlugin.FORCED_RENDER_QUEUE_LIMIT : TikzJaxPlugin.NORMAL_RENDER_QUEUE_LIMIT;
		if (queueLimit <= 0) return;

		const started = performance.now();
		while (this.renderer.getQueueDepth() >= queueLimit) {
			if (performance.now() - started >= TikzJaxPlugin.MAX_QUEUE_WAIT_FOR_SLOT_MS) {
				return;
			}

			await new Promise<void>((resolve) => window.setTimeout(resolve, TikzJaxPlugin.QUEUE_WAIT_SLICE_MS));
		}
	}

	private createEmptyPerfStats(): RenderPerfStats {
		return {
			cacheHits: 0,
			cacheMisses: 0,
			workerRenders: 0,
			workerFailures: 0,
			workerTimeouts: 0,
			queueWaitTotalMs: 0,
			workerDurationTotalMs: 0,
			maxQueueWaitMs: 0,
			maxWorkerDurationMs: 0,
			maxQueuedAhead: 0,
			lastErrors: [],
		};
	}

	private recordRendererTelemetry(event: RenderTelemetryEvent) {
		this.renderPerfStats.queueWaitTotalMs += event.queueWaitMs;
		this.renderPerfStats.workerDurationTotalMs += event.workerDurationMs;
		this.renderPerfStats.maxQueueWaitMs = Math.max(this.renderPerfStats.maxQueueWaitMs, event.queueWaitMs);
		this.renderPerfStats.maxWorkerDurationMs = Math.max(this.renderPerfStats.maxWorkerDurationMs, event.workerDurationMs);
		this.renderPerfStats.maxQueuedAhead = Math.max(this.renderPerfStats.maxQueuedAhead, event.queuedAhead);

		if (event.success) {
			this.renderPerfStats.workerRenders += 1;
		} else {
			this.renderPerfStats.workerFailures += 1;
			if (event.timeout) {
				this.renderPerfStats.workerTimeouts += 1;
			}

			if (event.errorMessage) {
				this.renderPerfStats.lastErrors.push(event.errorMessage);
				if (this.renderPerfStats.lastErrors.length > 5) {
					this.renderPerfStats.lastErrors.splice(0, this.renderPerfStats.lastErrors.length - 5);
				}
			}
		}
	}

	private registerPerformanceCommands() {
		this.addCommand({
			id: 'tikzjax-show-performance-stats',
			name: 'TikzJax: Show render performance stats',
			callback: () => this.showPerformanceStats(),
		});

		this.addCommand({
			id: 'tikzjax-reset-performance-stats',
			name: 'TikzJax: Reset render performance stats',
			callback: () => {
				this.renderPerfStats = this.createEmptyPerfStats();
				new Notice('TikzJax: 性能统计已重置。');
			},
		});
	}

	private showPerformanceStats() {
		const stats = this.renderPerfStats;
		const workerRuns = stats.workerRenders + stats.workerFailures;
		const cacheChecks = stats.cacheHits + stats.cacheMisses;
		const avgQueueWait = workerRuns > 0 ? stats.queueWaitTotalMs / workerRuns : 0;
		const avgWorkerDuration = workerRuns > 0 ? stats.workerDurationTotalMs / workerRuns : 0;
		const cacheHitRate = cacheChecks > 0 ? (stats.cacheHits / cacheChecks) * 100 : 0;

		const summary = {
			cacheHits: stats.cacheHits,
			cacheMisses: stats.cacheMisses,
			cacheHitRate: `${cacheHitRate.toFixed(1)}%`,
			workerSuccess: stats.workerRenders,
			workerFailures: stats.workerFailures,
			timeouts: stats.workerTimeouts,
			avgQueueWaitMs: Number(avgQueueWait.toFixed(1)),
			maxQueueWaitMs: Number(stats.maxQueueWaitMs.toFixed(1)),
			avgWorkerMs: Number(avgWorkerDuration.toFixed(1)),
			maxWorkerMs: Number(stats.maxWorkerDurationMs.toFixed(1)),
			maxQueuedAhead: stats.maxQueuedAhead,
			currentQueueDepth: this.renderer.getQueueDepth(),
		};

		console.table(summary);
		if (stats.lastErrors.length > 0) {
			console.log('TikzJax recent render errors:', stats.lastErrors);
		}

		new Notice(
			`TikzJax性能: 命中${summary.cacheHits}/${cacheChecks} (${summary.cacheHitRate}), ` +
				`平均排队${summary.avgQueueWaitMs}ms, 平均渲染${summary.avgWorkerMs}ms, 失败${summary.workerFailures}`,
			8000,
		);
	}

	private logTexDebug(message: string, data?: unknown) {
		if (!this.settings.showTexConsole) return;
		if (data === undefined) {
			console.log(`[TikzJax] ${message}`);
			return;
		}
		console.log(`[TikzJax] ${message}`, data);
	}

	private isRenderTimeoutError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return /render timeout/i.test(message);
	}

	private getExtendedTimeoutForRetry(baseTimeoutMs: number): number | null {
		const normalized = Number.isFinite(baseTimeoutMs) ? Math.max(1000, Math.round(baseTimeoutMs)) : 8000;
		const maxRetryTimeoutMs = 120000;
		if (normalized >= maxRetryTimeoutMs) {
			return null;
		}

		const candidate = Math.max(60000, normalized + 15000, Math.round(normalized * 4));
		const nextTimeout = Math.min(maxRetryTimeoutMs, candidate);
		if (nextTimeout <= normalized) {
			return null;
		}

		return nextTimeout;
	}

	private createTraceId(prefix: string): string {
		return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

	private captureCodeFocusTarget(ctx: MarkdownPostProcessorContext, blockEl: HTMLElement): CodeFocusTarget {
		const section = ctx.getSectionInfo?.(blockEl) ?? null;
		return {
			sourcePath: ctx.sourcePath,
			sectionLineStart: this.toNonNegativeInteger(section?.lineStart),
			sectionLineEnd: this.toNonNegativeInteger(section?.lineEnd),
		};
	}

	private toNonNegativeInteger(value: unknown): number | undefined {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
			return undefined;
		}

		return value;
	}

	private async revealCodeBlock(source: string, target: CodeFocusTarget, traceId?: string) {
		this.logTexDebug('code-focus reveal start', {
			traceId,
			target,
			sourceLength: source.length,
		});
		const focused = await this.focusCodeBlock(source, target, traceId);
		if (focused) return;

		this.logTexDebug('code-focus fallback to modal', {
			traceId,
			reason: 'editor-focus-failed',
		});
		this.openSourceModal(source);
		new Notice('未能定位到编辑器，已弹出源码并自动全选。');
	}

	private async focusCodeBlock(source: string, target: CodeFocusTarget, traceId?: string): Promise<boolean> {
		try {
			const sourcePath = target.sourcePath;

			let view = await this.getTargetMarkdownView(sourcePath);
			if (!view) {
				this.logTexDebug('code-focus no markdown view', { traceId, sourcePath });
				return false;
			}

			const switched = await this.ensureSourceMode(view, sourcePath);
			if (!switched) {
				this.logTexDebug('code-focus source-mode switch failed', {
					traceId,
					sourcePath,
					viewMode: view.getMode(),
				});
				return false;
			}

			view = (await this.getTargetMarkdownView(sourcePath)) ?? view;

			const editor = await this.waitForEditor(view, sourcePath);
			if (!editor) {
				this.logTexDebug('code-focus editor unavailable', {
					traceId,
					sourcePath,
					viewMode: view.getMode(),
				});
				return false;
			}

			const hasSectionRange =
				typeof target.sectionLineStart === 'number' && typeof target.sectionLineEnd === 'number';
			let range = hasSectionRange
				? this.resolveCodeFenceRange(editor, target.sectionLineStart, target.sectionLineEnd)
				: null;
			if (!range) {
				range = this.findCodeFenceRangeBySource(editor, source);
			}

			if (!range) {
				this.logTexDebug('code-focus unable to resolve code fence range', {
					traceId,
					target,
					sourcePreview: source.slice(0, 120),
				});
				return false;
			}

			const from: EditorPosition = { line: range.fromLine, ch: 0 };
			const to: EditorPosition = { line: range.toLine, ch: range.toCh };
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
			editor.focus?.();
			this.logTexDebug('code-focus success', {
				traceId,
				sourcePath,
				from,
				to,
			});
			return true;
		} catch (error) {
			this.logTexDebug('code-focus exception', {
				traceId,
				error: error instanceof Error ? error.message : String(error),
			});
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
		for (let i = 0; i < 48; i++) {
			if (currentView.getMode() === 'source' && currentView.editor) {
				return currentView.editor;
			}

			await this.waitForUiTick(25);

			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && (!sourcePath || activeView.file?.path === sourcePath)) {
				currentView = activeView;
			}
		}

		if (currentView.getMode() === 'source' && currentView.editor) {
			return currentView.editor;
		}

		return null;
	}

	private async waitForUiTick(ms: number): Promise<void> {
		await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
	}

	private async waitForSourceMode(sourcePath?: string, preferredView?: MarkdownView, retries = 48, delayMs = 25): Promise<MarkdownView | null> {
		let fallbackView = preferredView ?? this.app.workspace.getActiveViewOfType(MarkdownView) ?? null;

		for (let i = 0; i < retries; i++) {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const candidate =
				activeView && (!sourcePath || activeView.file?.path === sourcePath)
					? activeView
					: fallbackView;

			if (candidate?.getMode() === 'source' && (!sourcePath || candidate.file?.path === sourcePath)) {
				return candidate;
			}

			if (candidate) {
				fallbackView = candidate;
			}

			await this.waitForUiTick(delayMs);
		}

		if (fallbackView?.getMode() === 'source' && (!sourcePath || fallbackView.file?.path === sourcePath)) {
			return fallbackView;
		}

		return null;
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
				if (await this.waitForSourceMode(sourcePath, view, 36, 20)) {
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
				if (await this.waitForSourceMode(sourcePath, view, 30, 20)) {
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
			if (await this.waitForSourceMode(sourcePath, view, 24, 25)) {
				return true;
			}
		}

		return Boolean(await this.waitForSourceMode(sourcePath, view, 12, 25));
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
